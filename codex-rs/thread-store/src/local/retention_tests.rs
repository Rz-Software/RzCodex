use std::fs::File;
use std::time::Duration;
use std::time::SystemTime;

use codex_protocol::ThreadId;
use codex_protocol::protocol::HistoryPosition;
use codex_protocol::protocol::ThreadHistoryMode;
use tempfile::TempDir;
use uuid::Uuid;

use super::RETENTION_AGE;
use super::prune_expired_rollouts_at;
use crate::ThreadStoreError;
use crate::local::LocalThreadStore;
use crate::local::test_support::test_config;
use crate::local::test_support::write_archived_session_file;
use crate::local::test_support::write_session_file;
use crate::local::test_support::write_session_file_with_history_mode;

#[tokio::test]
async fn retention_deletes_expired_active_and_archived_threads() {
    let home = TempDir::new().expect("temp dir");
    let store = test_store(&home).await;
    let now = SystemTime::now();
    let old_active = write_session_file(home.path(), "2025-01-03T12-00-00", Uuid::from_u128(401))
        .expect("old active rollout");
    let compressed_sibling = old_active.with_extension("jsonl.zst");
    std::fs::write(&compressed_sibling, b"compressed sibling").expect("compressed sibling");
    let old_archived =
        write_archived_session_file(home.path(), "2025-01-03T12-00-01", Uuid::from_u128(402))
            .expect("old archived rollout");
    let fresh = write_session_file(home.path(), "2025-01-03T12-00-02", Uuid::from_u128(403))
        .expect("fresh rollout");
    set_age(&old_active, now, RETENTION_AGE + Duration::from_secs(1));
    set_age(
        &compressed_sibling,
        now,
        RETENTION_AGE + Duration::from_secs(1),
    );
    set_age(&old_archived, now, RETENTION_AGE + Duration::from_secs(1));

    let stats = prune_expired_rollouts_at(&store, now)
        .await
        .expect("prune expired rollouts");

    assert_eq!(stats.deleted_threads, 2);
    assert_eq!(stats.skipped_referenced_threads, 0);
    assert!(!old_active.exists());
    assert!(!compressed_sibling.exists());
    assert!(!old_archived.exists());
    assert!(fresh.exists());
}

#[tokio::test]
async fn retention_keeps_expired_ancestor_referenced_by_fresh_thread() {
    let home = TempDir::new().expect("temp dir");
    let store = test_store(&home).await;
    let now = SystemTime::now();
    let source_uuid = Uuid::from_u128(404);
    let source_thread_id = thread_id(source_uuid);
    let source = write_session_file_with_history_mode(
        home.path(),
        "2025-01-03T12-00-00",
        source_uuid,
        ThreadHistoryMode::Paginated,
    )
    .expect("source rollout");
    let child = write_session_file_with_history_mode(
        home.path(),
        "2025-01-03T12-00-01",
        Uuid::from_u128(405),
        ThreadHistoryMode::Paginated,
    )
    .expect("child rollout");
    set_history_base(
        &child,
        HistoryPosition {
            thread_id: source_thread_id,
            end_ordinal_exclusive: 1,
            end_byte_offset: std::fs::metadata(&source).expect("source metadata").len(),
        },
    );
    set_age(&source, now, RETENTION_AGE + Duration::from_secs(1));

    let stats = prune_expired_rollouts_at(&store, now)
        .await
        .expect("prune expired rollouts");

    assert_eq!(stats.deleted_threads, 0);
    assert_eq!(stats.skipped_referenced_threads, 1);
    assert!(source.exists());
    assert!(child.exists());
}

#[tokio::test]
async fn retention_does_not_race_an_active_writer() {
    let home = TempDir::new().expect("temp dir");
    let store = test_store(&home).await;
    let owner = test_store(&home).await;
    let now = SystemTime::now();
    let uuid = Uuid::from_u128(406);
    let thread_id = thread_id(uuid);
    let rollout =
        write_session_file(home.path(), "2025-01-03T12-00-00", uuid).expect("old rollout");
    set_age(&rollout, now, RETENTION_AGE + Duration::from_secs(1));
    let _writer = owner
        .writer_lock_coordinator
        .acquire(thread_id)
        .expect("active writer lock");

    let error = prune_expired_rollouts_at(&store, now)
        .await
        .expect_err("active writer must block retention");

    assert!(matches!(error, ThreadStoreError::Conflict { .. }));
    assert!(rollout.exists());
}

async fn test_store(home: &TempDir) -> LocalThreadStore {
    let config = test_config(home.path());
    let state_db = codex_state::StateRuntime::init(
        config.sqlite.clone(),
        config.default_model_provider_id.clone(),
    )
    .await
    .expect("state database");
    LocalThreadStore::new(config, Some(state_db))
}

fn thread_id(uuid: Uuid) -> ThreadId {
    ThreadId::from_string(&uuid.to_string()).expect("thread id")
}

fn set_age(path: &std::path::Path, now: SystemTime, age: Duration) {
    File::options()
        .write(true)
        .open(path)
        .expect("open rollout")
        .set_times(std::fs::FileTimes::new().set_modified(now - age))
        .expect("set rollout age");
}

fn set_history_base(path: &std::path::Path, history_base: HistoryPosition) {
    let mut session_meta: serde_json::Value = serde_json::from_str(
        std::fs::read_to_string(path)
            .expect("read session file")
            .lines()
            .next()
            .expect("session metadata"),
    )
    .expect("parse session metadata");
    session_meta["payload"]["history_base"] =
        serde_json::to_value(history_base).expect("serialize history base");
    std::fs::write(path, format!("{session_meta}\n")).expect("write session file");
}
