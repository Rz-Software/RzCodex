//! Best-effort age retention for local rollout-backed threads.

use std::collections::HashMap;
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::Path;
use std::time::Duration;
use std::time::SystemTime;

use codex_protocol::RolloutId;
use codex_protocol::ThreadId;
use codex_rollout::RolloutReferenceIndex;
use tracing::info;

use super::LocalThreadStore;
use crate::DeleteThreadsParams;
use crate::ThreadStoreError;
use crate::ThreadStoreResult;

const RETENTION_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const RUN_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const RUN_MARKER: &str = "rollout-retention.last-run";

#[derive(Debug, Default, PartialEq, Eq)]
struct RetentionStats {
    deleted_threads: usize,
    skipped_referenced_threads: usize,
}

struct IndexedRollout {
    rollout_id: RolloutId,
    thread_id: ThreadId,
    history_base: Option<RolloutId>,
    modified: Option<SystemTime>,
}

pub(super) async fn prune_expired_rollouts(store: &LocalThreadStore) -> ThreadStoreResult<()> {
    let Some(_maintenance_guard) =
        codex_rollout::try_acquire_rollout_maintenance_lock(&store.config.codex_home)
            .map_err(internal_error("acquire rollout maintenance lock"))?
    else {
        return Ok(());
    };
    if retention_ran_recently(&store.config.codex_home, SystemTime::now())
        .map_err(internal_error("inspect rollout retention marker"))?
    {
        return Ok(());
    }

    let stats = prune_expired_rollouts_at(store, SystemTime::now()).await?;
    persist_run_marker(&store.config.codex_home)
        .map_err(internal_error("persist rollout retention marker"))?;
    info!(
        "rollout retention finished: deleted_threads={}, skipped_referenced_threads={}",
        stats.deleted_threads, stats.skipped_referenced_threads
    );
    Ok(())
}

async fn prune_expired_rollouts_at(
    store: &LocalThreadStore,
    now: SystemTime,
) -> ThreadStoreResult<RetentionStats> {
    let reference_index = RolloutReferenceIndex::scan(&store.config.codex_home)
        .await
        .map_err(internal_error("scan rollout references for retention"))?;
    let indexed_rollouts = reference_index
        .rollouts()
        .map(|(rollout_id, thread_id, path, history_base)| {
            logical_rollout_modified(path)
                .map(|modified| IndexedRollout {
                    rollout_id,
                    thread_id,
                    history_base: history_base.map(|position| position.thread_id),
                    modified,
                })
                .map_err(internal_error("inspect rollout age"))
        })
        .collect::<ThreadStoreResult<Vec<_>>>()?;

    let mut thread_expiration = HashMap::<ThreadId, bool>::new();
    for rollout in &indexed_rollouts {
        let expired = rollout
            .modified
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= RETENTION_AGE);
        thread_expiration
            .entry(rollout.thread_id)
            .and_modify(|all_expired| *all_expired &= expired)
            .or_insert(expired);
    }
    let mut candidates = thread_expiration
        .into_iter()
        .filter_map(|(thread_id, expired)| expired.then_some(thread_id))
        .collect::<HashSet<_>>();
    let initial_candidate_count = candidates.len();
    remove_threads_with_retained_references(&mut candidates, &indexed_rollouts, &reference_index);

    let mut thread_ids = candidates.into_iter().collect::<Vec<_>>();
    thread_ids.sort_unstable_by_key(ToString::to_string);
    if !thread_ids.is_empty() {
        super::delete_thread::delete_threads(
            store,
            DeleteThreadsParams {
                thread_ids: thread_ids.clone(),
            },
        )
        .await?;
    }
    Ok(RetentionStats {
        deleted_threads: thread_ids.len(),
        skipped_referenced_threads: initial_candidate_count.saturating_sub(thread_ids.len()),
    })
}

fn remove_threads_with_retained_references(
    candidates: &mut HashSet<ThreadId>,
    rollouts: &[IndexedRollout],
    reference_index: &RolloutReferenceIndex,
) {
    loop {
        let candidate_rollout_ids = rollouts
            .iter()
            .filter(|rollout| candidates.contains(&rollout.thread_id))
            .map(|rollout| rollout.rollout_id)
            .collect::<HashSet<_>>();
        let mut internal_references = HashMap::<RolloutId, usize>::new();
        for rollout in rollouts {
            if !candidates.contains(&rollout.thread_id) {
                continue;
            }
            if let Some(history_base) = rollout.history_base
                && history_base != rollout.rollout_id
                && candidate_rollout_ids.contains(&history_base)
            {
                *internal_references.entry(history_base).or_default() += 1;
            }
        }

        let retained = rollouts
            .iter()
            .filter(|rollout| candidates.contains(&rollout.thread_id))
            .filter(|rollout| {
                reference_index.reference_count(rollout.rollout_id)
                    > internal_references
                        .get(&rollout.rollout_id)
                        .copied()
                        .unwrap_or_default()
            })
            .map(|rollout| rollout.thread_id)
            .collect::<HashSet<_>>();
        if retained.is_empty() {
            return;
        }
        candidates.retain(|thread_id| !retained.contains(thread_id));
    }
}

fn logical_rollout_modified(path: &Path) -> io::Result<Option<SystemTime>> {
    let plain_path = codex_rollout::plain_rollout_path(path);
    let compressed_path = plain_path.with_extension("jsonl.zst");
    let mut newest = None;
    for candidate in [plain_path.as_path(), compressed_path.as_path()] {
        match fs::metadata(candidate) {
            Ok(metadata) if metadata.is_file() => {
                let modified = metadata.modified()?;
                newest = Some(newest.map_or(modified, |current: SystemTime| current.max(modified)));
            }
            Ok(_) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err),
        }
    }
    Ok(newest)
}

fn retention_ran_recently(codex_home: &Path, now: SystemTime) -> io::Result<bool> {
    let marker = codex_home.join(".tmp").join(RUN_MARKER);
    let modified = match fs::metadata(marker) {
        Ok(metadata) => metadata.modified()?,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(err),
    };
    Ok(now
        .duration_since(modified)
        .is_ok_and(|age| age < RUN_INTERVAL))
}

fn persist_run_marker(codex_home: &Path) -> io::Result<()> {
    let marker_dir = codex_home.join(".tmp");
    fs::create_dir_all(&marker_dir)?;
    fs::write(marker_dir.join(RUN_MARKER), b"completed\n")
}

fn internal_error(operation: &'static str) -> impl FnOnce(io::Error) -> ThreadStoreError + Copy {
    move |err| ThreadStoreError::Internal {
        message: format!("failed to {operation}: {err}"),
    }
}

#[cfg(test)]
#[path = "retention_tests.rs"]
mod tests;
