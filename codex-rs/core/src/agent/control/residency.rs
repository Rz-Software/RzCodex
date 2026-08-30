use super::AgentControl;
use crate::agent::AgentStatus;
use crate::codex_thread::CodexThread;
use crate::config::Config;
use crate::thread_manager::ThreadManagerState;
use codex_protocol::ThreadId;
use codex_protocol::error::CodexErr;
use codex_protocol::error::CodexErrorDetails;
use codex_protocol::error::Result as CodexResult;
use codex_protocol::protocol::MultiAgentVersion;
use codex_protocol::protocol::SessionSource;
use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use tokio::sync::Notify;

#[derive(Default)]
pub(super) struct V2Residency {
    state: Mutex<V2ResidencyState>,
}

#[derive(Default)]
struct V2ResidencyState {
    residents: VecDeque<ThreadId>,
    pending_slots: usize,
    evicting: HashSet<ThreadId>,
    transitions: HashMap<ThreadId, Arc<Notify>>,
}

pub(super) struct V2ResidencySlot {
    residency: Arc<V2Residency>,
    active: bool,
}

pub(super) struct V2ThreadTransition {
    residency: Arc<V2Residency>,
    thread_id: ThreadId,
    token: Arc<Notify>,
}

struct V2EvictionAttempt {
    residency: Arc<V2Residency>,
    thread_id: ThreadId,
    transition: Option<V2ThreadTransition>,
}

enum V2TransitionStart {
    Acquired(V2ThreadTransition),
    Wait(std::pin::Pin<Box<tokio::sync::futures::OwnedNotified>>),
}

impl V2ResidencySlot {
    pub(super) fn commit(mut self, thread_id: ThreadId) {
        self.residency.commit_slot(thread_id);
        self.active = false;
    }
}

impl Drop for V2ResidencySlot {
    fn drop(&mut self) {
        if self.active {
            self.residency.release_pending_slot();
        }
    }
}

impl Drop for V2ThreadTransition {
    fn drop(&mut self) {
        self.residency
            .finish_transition(self.thread_id, &self.token);
    }
}

impl V2EvictionAttempt {
    fn thread_id(&self) -> ThreadId {
        self.thread_id
    }

    fn into_pending_slot(mut self) -> V2ResidencySlot {
        self.residency
            .finish_eviction_with_pending_slot(self.thread_id);
        drop(self.transition.take());
        V2ResidencySlot {
            residency: Arc::clone(&self.residency),
            active: true,
        }
    }
}

impl Drop for V2EvictionAttempt {
    fn drop(&mut self) {
        if let Some(transition) = self.transition.take() {
            transition.residency.cancel_eviction(transition.thread_id);
            drop(transition);
        }
    }
}

impl AgentControl {
    pub(super) async fn reserve_v2_residency_slot(
        &self,
        state: &Arc<ThreadManagerState>,
        config: &Config,
        protected_thread_id: Option<ThreadId>,
    ) -> CodexResult<V2ResidencySlot> {
        let capacity = config
            .effective_agent_max_threads(MultiAgentVersion::V2)
            .unwrap_or(usize::MAX);
        Arc::clone(&self.v2_residency)
            .reserve_slot(state, capacity, protected_thread_id)
            .await
    }

    pub(super) async fn lock_v2_thread_transition(
        &self,
        thread_id: ThreadId,
    ) -> V2ThreadTransition {
        loop {
            match Arc::clone(&self.v2_residency).begin_transition(thread_id) {
                V2TransitionStart::Acquired(transition) => return transition,
                V2TransitionStart::Wait(wait) => wait.await,
            }
        }
    }

    pub(super) async fn touch_loaded_v2_residency(
        &self,
        state: &Arc<ThreadManagerState>,
        thread_id: ThreadId,
    ) {
        if let Ok(thread) = state.get_thread(thread_id).await
            && is_resident_candidate(thread.as_ref())
        {
            self.v2_residency.touch(thread_id);
        }
    }

    pub(super) fn forget_v2_residency(&self, thread_id: ThreadId) {
        self.v2_residency.remove(thread_id);
    }
}

impl V2Residency {
    async fn reserve_slot(
        self: Arc<Self>,
        manager: &Arc<ThreadManagerState>,
        capacity: usize,
        protected_thread_id: Option<ThreadId>,
    ) -> CodexResult<V2ResidencySlot> {
        if self.try_reserve_pending_slot(capacity) {
            return Ok(V2ResidencySlot {
                residency: self,
                active: true,
            });
        }
        if let Some(slot) = self
            .try_unload_one_resident(manager, protected_thread_id)
            .await
        {
            return Ok(slot);
        }
        Err(CodexErr::new(CodexErrorDetails::AgentLimitReached {
            max_threads: capacity,
        }))
    }

    fn try_reserve_pending_slot(&self, capacity: usize) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state
            .residents
            .len()
            .saturating_add(state.pending_slots)
            .saturating_add(state.evicting.len())
            >= capacity
        {
            return false;
        }
        state.pending_slots += 1;
        true
    }

    async fn try_unload_one_resident(
        self: &Arc<Self>,
        manager: &Arc<ThreadManagerState>,
        protected_thread_id: Option<ThreadId>,
    ) -> Option<V2ResidencySlot> {
        let candidates_to_scan = self.resident_count();
        for _ in 0..candidates_to_scan {
            let eviction = self.begin_lru_eviction(protected_thread_id)?;
            let candidate_thread_id = eviction.thread_id();
            let Some(candidate_thread) = manager
                .get_thread(candidate_thread_id)
                .await
                .ok()
                .filter(|thread| is_resident_candidate(thread))
            else {
                return Some(eviction.into_pending_slot());
            };
            if !wait_until_unloadable(candidate_thread.as_ref()).await {
                drop(eviction);
                continue;
            }
            candidate_thread.ensure_rollout_materialized().await;
            let Some(candidate_thread) = manager
                .remove_thread_if_matches(&candidate_thread_id, &candidate_thread)
                .await
            else {
                drop(eviction);
                continue;
            };
            candidate_thread.close_submission_channel_and_wait().await;
            // Closing the submission channel makes a racing message atomic with eviction: it
            // was either accepted and processed before teardown, or rejected by its sender.
            let mailbox = candidate_thread
                .session
                .input_queue
                .drain_pending_mailbox_communications()
                .await;
            let environments = candidate_thread.environment_selections().await;
            candidate_thread
                .session
                .services
                .agent_control
                .state
                .save_evicted_environments(candidate_thread_id, environments);
            if !mailbox.is_empty() {
                candidate_thread
                    .session
                    .services
                    .agent_control
                    .state
                    .save_evicted_mailbox(candidate_thread_id, mailbox);
            }
            return Some(eviction.into_pending_slot());
        }
        None
    }

    fn resident_count(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .residents
            .len()
    }

    fn begin_lru_eviction(
        self: &Arc<Self>,
        protected_thread_id: Option<ThreadId>,
    ) -> Option<V2EvictionAttempt> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let candidates_to_scan = state.residents.len();
        for _ in 0..candidates_to_scan {
            let candidate_thread_id = state.residents.pop_front()?;
            if Some(candidate_thread_id) == protected_thread_id
                || state.transitions.contains_key(&candidate_thread_id)
            {
                state.residents.push_back(candidate_thread_id);
                continue;
            }
            let token = Arc::new(Notify::new());
            state
                .transitions
                .insert(candidate_thread_id, Arc::clone(&token));
            state.evicting.insert(candidate_thread_id);
            return Some(V2EvictionAttempt {
                residency: Arc::clone(self),
                thread_id: candidate_thread_id,
                transition: Some(V2ThreadTransition {
                    residency: Arc::clone(self),
                    thread_id: candidate_thread_id,
                    token,
                }),
            });
        }
        None
    }

    fn begin_transition(self: Arc<Self>, thread_id: ThreadId) -> V2TransitionStart {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(existing) = state.transitions.get(&thread_id) {
            let mut wait = Box::pin(Arc::clone(existing).notified_owned());
            wait.as_mut().enable();
            return V2TransitionStart::Wait(wait);
        }
        let token = Arc::new(Notify::new());
        state.transitions.insert(thread_id, Arc::clone(&token));
        V2TransitionStart::Acquired(V2ThreadTransition {
            residency: Arc::clone(&self),
            thread_id,
            token,
        })
    }

    fn finish_transition(&self, thread_id: ThreadId, token: &Arc<Notify>) {
        let removed = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state
                .transitions
                .get(&thread_id)
                .is_some_and(|current| Arc::ptr_eq(current, token))
            {
                state.transitions.remove(&thread_id)
            } else {
                None
            }
        };
        if let Some(notify) = removed {
            notify.notify_waiters();
        }
    }

    fn cancel_eviction(&self, thread_id: ThreadId) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.evicting.remove(&thread_id);
        touch_resident(&mut state.residents, thread_id);
    }

    fn finish_eviction_with_pending_slot(&self, thread_id: ThreadId) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.evicting.remove(&thread_id);
        state.pending_slots = state.pending_slots.saturating_add(1);
    }

    fn touch(&self, thread_id: ThreadId) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        touch_resident(&mut state.residents, thread_id);
    }

    fn remove(&self, thread_id: ThreadId) {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .residents
            .retain(|resident_thread_id| *resident_thread_id != thread_id);
    }

    fn commit_slot(&self, thread_id: ThreadId) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.pending_slots = state.pending_slots.saturating_sub(1);
        touch_resident(&mut state.residents, thread_id);
    }

    fn release_pending_slot(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.pending_slots = state.pending_slots.saturating_sub(1);
    }
}

fn touch_resident(residents: &mut VecDeque<ThreadId>, thread_id: ThreadId) {
    residents.retain(|resident_thread_id| *resident_thread_id != thread_id);
    residents.push_back(thread_id);
}

fn is_resident_candidate(thread: &CodexThread) -> bool {
    thread.multi_agent_version() == Some(MultiAgentVersion::V2)
        && is_v2_resident_session_source(&thread.session_source)
}

pub(super) fn is_v2_resident_session_source(session_source: &SessionSource) -> bool {
    matches!(session_source, SessionSource::SubAgent(_))
}

async fn wait_until_unloadable(thread: &CodexThread) -> bool {
    loop {
        // Passive mail does not make a terminal resident active and is preserved by the caller.
        // Trigger-turn mail does: it must run instead of being converted into evicted mailbox state.
        if !matches!(
            thread.agent_status().await,
            AgentStatus::Completed(_) | AgentStatus::Errored(_) | AgentStatus::Interrupted
        ) || thread
            .session
            .input_queue
            .has_trigger_turn_mailbox_items()
            .await
        {
            return false;
        }

        let mut wait_for_clear = {
            let active_turn = thread.session.active_turn.lock().await;
            let Some(active_turn) = active_turn.as_ref() else {
                return true;
            };
            if active_turn.task.is_some() {
                // A resumed turn won the race after the terminal snapshot. It is genuinely live
                // and must not be evicted or make this spawn wait for an unbounded work turn.
                return false;
            }
            let mut wait_for_clear = Box::pin(Arc::clone(&active_turn.cleared).notified_owned());
            // notify_waiters does not retain a permit. Register before releasing active_turn so
            // its Drop notification cannot land between constructing and polling this future.
            wait_for_clear.as_mut().enable();
            wait_for_clear
        };

        // TurnComplete is deliberately emitted before ActiveTurn is removed so parent delivery
        // and persistence retain their ordering. A concurrent spawn must wait for that teardown
        // boundary instead of reporting a stale agent-limit failure.
        wait_for_clear.as_mut().await;
    }
}

#[cfg(test)]
#[path = "residency_tests.rs"]
mod tests;
