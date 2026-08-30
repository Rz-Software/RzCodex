use crate::StartThreadOptions;
use crate::ThreadManager;
use crate::agent::AgentControl;
use crate::agent::registry::AgentMetadata;
use crate::codex_thread::CodexThread;
use crate::config::Config;
use crate::config::test_config;
use crate::thread_manager::ThreadManagerState;
use codex_features::Feature;
use codex_login::CodexAuth;
use codex_protocol::AgentPath;
use codex_protocol::ThreadId;
use codex_protocol::error::CodexErrorDetails;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::InterAgentCommunication;
use codex_protocol::protocol::Op;
use codex_protocol::protocol::SessionSource;
use codex_protocol::protocol::SubAgentSource;
use codex_protocol::protocol::ThreadSource;
use codex_protocol::protocol::TurnAbortReason;
use codex_protocol::protocol::TurnAbortedEvent;
use codex_protocol::protocol::TurnCompleteEvent;
use codex_protocol::turn_input::TurnStartOptions;
use pretty_assertions::assert_eq;
use std::sync::Arc;
use tokio::time::Duration;
use tokio::time::timeout;

#[tokio::test]
async fn residency_slot_reservation_unloads_oldest_idle_v2_agent() {
    let mut config = test_config().await;
    let _ = config.features.enable(Feature::MultiAgentV2);
    config.multi_agent_v2.max_concurrent_threads_per_session = 2;
    let temp_home = tempfile::tempdir().expect("create temp home");
    config.codex_home = temp_home.path().to_path_buf().try_into().unwrap();
    config.cwd = temp_home.path().to_path_buf().try_into().unwrap();
    let manager = ThreadManager::with_models_provider_and_home_for_tests(
        CodexAuth::from_api_key("dummy"),
        config.model_provider.clone(),
        config.codex_home.to_path_buf(),
        Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
    );
    let root = manager
        .start_thread(StartThreadOptions::new(config.clone()))
        .await
        .expect("start root thread");
    let control = manager.agent_control();
    let state = control.upgrade().expect("thread manager should be live");

    let first_slot = control
        .reserve_v2_residency_slot(&state, &config, /*protected_thread_id*/ None)
        .await
        .expect("first resident slot");
    let first =
        spawn_v2_subagent(&control, &state, config.clone(), root.thread_id, "worker_1").await;
    first_slot.commit(first.thread_id);
    mark_thread_completed(first.thread.as_ref()).await;

    let second_slot = control
        .reserve_v2_residency_slot(&state, &config, /*protected_thread_id*/ None)
        .await
        .expect("second resident slot should evict the first idle agent");
    match manager.get_thread(first.thread_id).await {
        Err(err) => match err.details() {
            CodexErrorDetails::ThreadNotFound(thread_id) => assert_eq!(*thread_id, first.thread_id),
            _ => panic!("expected evicted thread to be missing, got {err:?}"),
        },
        Ok(_) => panic!("expected evicted thread to be missing"),
    }
    let late_mail = make_mail(
        AgentPath::root(),
        AgentPath::try_from("/root/worker_1").expect("agent path"),
        "late passive update",
        /*trigger_turn*/ false,
    );
    let late_submit = first
        .thread
        .submit(Op::InterAgentCommunication {
            communication: late_mail,
            start_options: TurnStartOptions::default(),
        })
        .await
        .expect_err("an evicted runtime must reject submissions after its channel closes");
    assert!(matches!(
        late_submit.details(),
        CodexErrorDetails::InternalAgentDied
    ));
    let second = spawn_v2_subagent(&control, &state, config, root.thread_id, "worker_2").await;
    second_slot.commit(second.thread_id);

    assert!(manager.get_thread(root.thread_id).await.is_ok());
    assert!(manager.get_thread(second.thread_id).await.is_ok());
}

#[tokio::test]
async fn interrupted_v2_agent_is_lost_after_residency_eviction() {
    let mut config = test_config().await;
    let _ = config.features.enable(Feature::MultiAgentV2);
    config.multi_agent_v2.max_concurrent_threads_per_session = 2;
    let temp_home = tempfile::tempdir().expect("create temp home");
    config.codex_home = temp_home.path().to_path_buf().try_into().unwrap();
    config.cwd = temp_home.path().to_path_buf().try_into().unwrap();
    let manager = ThreadManager::with_models_provider_and_home_for_tests(
        CodexAuth::from_api_key("dummy"),
        config.model_provider.clone(),
        config.codex_home.to_path_buf(),
        Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
    );
    let root = manager
        .start_thread(StartThreadOptions::new(config.clone()))
        .await
        .expect("start root thread");
    let control = manager.agent_control();
    let state = control.upgrade().expect("thread manager should be live");

    let first_slot = control
        .reserve_v2_residency_slot(&state, &config, /*protected_thread_id*/ None)
        .await
        .expect("first resident slot");
    let first =
        spawn_v2_subagent(&control, &state, config.clone(), root.thread_id, "worker_1").await;
    first_slot.commit(first.thread_id);
    mark_thread_interrupted(first.thread.as_ref()).await;

    let second_slot = control
        .reserve_v2_residency_slot(&state, &config, /*protected_thread_id*/ None)
        .await
        .expect("second resident slot should evict the first interrupted idle agent");
    match manager.get_thread(first.thread_id).await {
        Err(err) => match err.details() {
            CodexErrorDetails::ThreadNotFound(thread_id) => assert_eq!(*thread_id, first.thread_id),
            _ => panic!("expected evicted thread to be missing, got {err:?}"),
        },
        Ok(_) => panic!("expected evicted thread to be missing"),
    }
    let second =
        spawn_v2_subagent(&control, &state, config.clone(), root.thread_id, "worker_2").await;
    second_slot.commit(second.thread_id);
    mark_thread_completed(second.thread.as_ref()).await;

    let err = control
        .ensure_v2_agent_loaded(config, first.thread_id, /*parent*/ None)
        .await
        .expect_err("evicted interrupted agent should stay lost");
    match err.details() {
        CodexErrorDetails::ThreadNotFound(thread_id) => assert_eq!(*thread_id, first.thread_id),
        _ => panic!("expected ThreadNotFound, got {err:?}"),
    }

    assert!(manager.get_thread(root.thread_id).await.is_ok());
    assert!(manager.get_thread(second.thread_id).await.is_ok());
    match manager.get_thread(first.thread_id).await {
        Err(err) => match err.details() {
            CodexErrorDetails::ThreadNotFound(thread_id) => assert_eq!(*thread_id, first.thread_id),
            _ => panic!("expected evicted thread to be missing, got {err:?}"),
        },
        Ok(_) => panic!("expected evicted thread to be missing"),
    }
}

#[tokio::test]
async fn residency_reservation_waits_for_terminal_turn_teardown() {
    let mut config = test_config().await;
    let _ = config.features.enable(Feature::MultiAgentV2);
    // The configured session limit includes the root; two permits one resident child.
    config.multi_agent_v2.max_concurrent_threads_per_session = 2;
    let temp_home = tempfile::tempdir().expect("create temp home");
    config.codex_home = temp_home.path().to_path_buf().try_into().unwrap();
    config.cwd = temp_home.path().to_path_buf().try_into().unwrap();
    let manager = ThreadManager::with_models_provider_and_home_for_tests(
        CodexAuth::from_api_key("dummy"),
        config.model_provider.clone(),
        config.codex_home.to_path_buf(),
        Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
    );
    let root = manager
        .start_thread(StartThreadOptions::new(config.clone()))
        .await
        .expect("start root thread");
    let control = manager.agent_control();
    let state = control.upgrade().expect("thread manager should be live");

    let first_slot = control
        .reserve_v2_residency_slot(&state, &config, /*protected_thread_id*/ None)
        .await
        .expect("first resident slot");
    let first =
        spawn_v2_subagent(&control, &state, config.clone(), root.thread_id, "worker_1").await;
    first_slot.commit(first.thread_id);
    mark_thread_completed_without_clearing(first.thread.as_ref()).await;

    let reserve = tokio::spawn({
        let control = control.clone();
        let state = Arc::clone(&state);
        let config = config.clone();
        async move {
            control
                .reserve_v2_residency_slot(&state, &config, /*protected_thread_id*/ None)
                .await
        }
    });
    tokio::task::yield_now().await;
    assert!(
        !reserve.is_finished(),
        "reservation should synchronize with terminal teardown instead of failing"
    );

    clear_active_turn(first.thread.as_ref()).await;
    let second_slot = timeout(Duration::from_secs(5), reserve)
        .await
        .expect("reservation should finish after terminal teardown")
        .expect("reservation task should not panic")
        .expect("terminal resident should be evicted");
    drop(second_slot);
    assert!(manager.get_thread(first.thread_id).await.is_err());
}

#[tokio::test]
async fn terminal_resident_with_pending_mailbox_is_evictable() {
    let mut config = test_config().await;
    let _ = config.features.enable(Feature::MultiAgentV2);
    config.multi_agent_v2.max_concurrent_threads_per_session = 2;
    let temp_home = tempfile::tempdir().expect("create temp home");
    config.codex_home = temp_home.path().to_path_buf().try_into().unwrap();
    config.cwd = temp_home.path().to_path_buf().try_into().unwrap();
    let manager = ThreadManager::with_models_provider_and_home_for_tests(
        CodexAuth::from_api_key("dummy"),
        config.model_provider.clone(),
        config.codex_home.to_path_buf(),
        Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
    );
    let root = manager
        .start_thread(StartThreadOptions::new(config.clone()))
        .await
        .expect("start root thread");
    let control = manager.agent_control();
    let state = control.upgrade().expect("thread manager should be live");

    let first_slot = control
        .reserve_v2_residency_slot(&state, &config, /*protected_thread_id*/ None)
        .await
        .expect("first resident slot");
    let first =
        spawn_v2_subagent(&control, &state, config.clone(), root.thread_id, "worker_1").await;
    register_test_agent(&control, first.thread_id, "worker_1");
    first_slot.commit(first.thread_id);

    let trigger_mail = make_mail(
        AgentPath::root(),
        AgentPath::try_from("/root/worker_1").expect("agent path"),
        "continue working",
        /*trigger_turn*/ true,
    );
    first
        .thread
        .session
        .input_queue
        .enqueue_mailbox_communication(trigger_mail.clone(), TurnStartOptions::default())
        .await;
    mark_thread_completed(first.thread.as_ref()).await;

    let trigger_result = control
        .reserve_v2_residency_slot(&state, &config, /*protected_thread_id*/ None)
        .await;
    let trigger_error = match trigger_result {
        Ok(_) => panic!("trigger-turn mail must keep the resident loaded"),
        Err(err) => err,
    };
    assert!(matches!(
        trigger_error.details(),
        CodexErrorDetails::AgentLimitReached { .. }
    ));
    let queued_trigger = first
        .thread
        .session
        .input_queue
        .drain_pending_mailbox_communications()
        .await;
    assert_eq!(queued_trigger.len(), 1);
    assert_eq!(queued_trigger[0].0, trigger_mail);

    // Passive mail does not make a terminal agent runnable. It used to pin the residency slot
    // forever even though it can safely survive in the registry until the agent is reloaded.
    let passive_mail = make_mail(
        AgentPath::root(),
        AgentPath::try_from("/root/worker_1").expect("agent path"),
        "passive checkpoint",
        /*trigger_turn*/ false,
    );
    first
        .thread
        .session
        .input_queue
        .enqueue_mailbox_communication(passive_mail.clone(), TurnStartOptions::default())
        .await;
    assert!(
        first
            .thread
            .session
            .input_queue
            .has_pending_mailbox_items()
            .await
    );

    // The second slot reservation must evict the terminal resident despite pending mail.
    let second_slot = control
        .reserve_v2_residency_slot(&state, &config, /*protected_thread_id*/ None)
        .await
        .expect("second resident slot should evict terminal agent with pending mail");
    match manager.get_thread(first.thread_id).await {
        Err(err) => match err.details() {
            CodexErrorDetails::ThreadNotFound(thread_id) => assert_eq!(*thread_id, first.thread_id),
            _ => panic!("expected evicted thread to be missing, got {err:?}"),
        },
        Ok(_) => panic!("expected evicted thread to be missing"),
    }

    // The mail must be preserved in the registry for reload.
    let saved_mailbox = control
        .state
        .take_evicted_mailbox(first.thread_id)
        .expect("evicted mailbox should be saved in registry");
    assert_eq!(saved_mailbox.len(), 1);
    assert_eq!(saved_mailbox[0].0, passive_mail);

    let second = spawn_v2_subagent(&control, &state, config, root.thread_id, "worker_2").await;
    second_slot.commit(second.thread_id);
    assert!(manager.get_thread(root.thread_id).await.is_ok());
    assert!(manager.get_thread(second.thread_id).await.is_ok());
}

#[tokio::test]
async fn evicted_mailbox_survives_reload_exactly_once() {
    let mut config = test_config().await;
    let _ = config.features.enable(Feature::MultiAgentV2);
    config.multi_agent_v2.max_concurrent_threads_per_session = 2;
    let temp_home = tempfile::tempdir().expect("create temp home");
    config.codex_home = temp_home.path().to_path_buf().try_into().unwrap();
    config.cwd = temp_home.path().to_path_buf().try_into().unwrap();
    let manager = ThreadManager::with_models_provider_and_home_for_tests(
        CodexAuth::from_api_key("dummy"),
        config.model_provider.clone(),
        config.codex_home.to_path_buf(),
        Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
    );
    let root = manager
        .start_thread(StartThreadOptions::new(config.clone()))
        .await
        .expect("start root thread");
    let control = manager.agent_control();
    let state = control.upgrade().expect("thread manager should be live");

    let first_slot = control
        .reserve_v2_residency_slot(&state, &config, /*protected_thread_id*/ None)
        .await
        .expect("first resident slot");
    let first =
        spawn_v2_subagent(&control, &state, config.clone(), root.thread_id, "worker_1").await;
    register_test_agent(&control, first.thread_id, "worker_1");
    first_slot.commit(first.thread_id);

    // Enqueue two passive messages to verify order and start options survive.
    let passive_mail = make_mail(
        AgentPath::root(),
        AgentPath::try_from("/root/worker_1").expect("agent path"),
        "passive update",
        /*trigger_turn*/ false,
    );
    let second_passive_mail = make_mail(
        AgentPath::root(),
        AgentPath::try_from("/root/worker_1").expect("agent path"),
        "second passive update",
        /*trigger_turn*/ false,
    );
    let second_start_options = TurnStartOptions {
        parent_turn_id: Some("parent-turn-1".to_string()),
        root_turn_id: Some("root-turn-1".to_string()),
        ..Default::default()
    };
    first
        .thread
        .session
        .input_queue
        .enqueue_mailbox_communication(passive_mail.clone(), TurnStartOptions::default())
        .await;
    first
        .thread
        .session
        .input_queue
        .enqueue_mailbox_communication(second_passive_mail.clone(), second_start_options.clone())
        .await;

    mark_thread_interrupted(first.thread.as_ref()).await;

    // Evict the interrupted resident.
    let second_slot = control
        .reserve_v2_residency_slot(&state, &config, /*protected_thread_id*/ None)
        .await
        .expect("second resident slot should evict interrupted agent with pending mail");
    let second =
        spawn_v2_subagent(&control, &state, config.clone(), root.thread_id, "worker_2").await;
    second_slot.commit(second.thread_id);
    mark_thread_completed(second.thread.as_ref()).await;

    // Registry must still have the agent metadata (addressable after eviction).
    assert!(
        control
            .state
            .agent_metadata_for_thread(first.thread_id)
            .is_some(),
        "evicted agent metadata must remain registered and addressable"
    );

    // Reload the evicted agent. The mailbox must be restored exactly once.
    let reload_one =
        control.ensure_v2_agent_loaded(config.clone(), first.thread_id, /*parent*/ None);
    let reload_two = control.ensure_v2_agent_loaded(config, first.thread_id, /*parent*/ None);
    let (reload_one, reload_two) = tokio::join!(reload_one, reload_two);
    reload_one.expect("first concurrent reload should succeed");
    reload_two.expect("second concurrent reload should reuse the loaded runtime");

    let reloaded = manager
        .get_thread(first.thread_id)
        .await
        .expect("reloaded thread should be live");

    // The mailbox must be restored in the reloaded thread.
    assert!(
        reloaded
            .session
            .input_queue
            .has_pending_mailbox_items()
            .await,
        "reloaded thread should have restored mailbox items"
    );

    // Drain and verify the exact communications and order.
    let restored = reloaded
        .session
        .input_queue
        .drain_pending_mailbox_communications()
        .await;
    assert_eq!(restored.len(), 2);
    assert_eq!(restored[0].0, passive_mail);
    assert_eq!(restored[1].0, second_passive_mail);
    // TurnStartOptions does not implement PartialEq; verify the propagated turn IDs.
    assert_eq!(
        restored[1].1.parent_turn_id,
        second_start_options.parent_turn_id
    );
    assert_eq!(
        restored[1].1.root_turn_id,
        second_start_options.root_turn_id
    );

    // The registry must no longer hold the evicted mailbox (taken exactly once).
    assert!(
        control
            .state
            .take_evicted_mailbox(first.thread_id)
            .is_none(),
        "evicted mailbox must be consumed exactly once"
    );
}

#[tokio::test]
async fn active_nonterminal_resident_is_not_evictable() {
    let mut config = test_config().await;
    let _ = config.features.enable(Feature::MultiAgentV2);
    config.multi_agent_v2.max_concurrent_threads_per_session = 2;
    let temp_home = tempfile::tempdir().expect("create temp home");
    config.codex_home = temp_home.path().to_path_buf().try_into().unwrap();
    config.cwd = temp_home.path().to_path_buf().try_into().unwrap();
    let manager = ThreadManager::with_models_provider_and_home_for_tests(
        CodexAuth::from_api_key("dummy"),
        config.model_provider.clone(),
        config.codex_home.to_path_buf(),
        Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
    );
    let root = manager
        .start_thread(StartThreadOptions::new(config.clone()))
        .await
        .expect("start root thread");
    let control = manager.agent_control();
    let state = control.upgrade().expect("thread manager should be live");

    let first_slot = control
        .reserve_v2_residency_slot(&state, &config, /*protected_thread_id*/ None)
        .await
        .expect("first resident slot");
    let first =
        spawn_v2_subagent(&control, &state, config.clone(), root.thread_id, "worker_1").await;
    first_slot.commit(first.thread_id);
    // Do NOT mark the thread terminal — it is still active/running.
    let result = control
        .reserve_v2_residency_slot(&state, &config, /*protected_thread_id*/ None)
        .await;
    let err = match result {
        Ok(_) => panic!("active resident should not be evictable"),
        Err(err) => err,
    };
    match err.details() {
        CodexErrorDetails::AgentLimitReached { .. } => {}
        _ => panic!("expected AgentLimitReached for active resident, got {err:?}"),
    }

    // The active thread must still be live.
    assert!(manager.get_thread(first.thread_id).await.is_ok());
    assert!(manager.get_thread(root.thread_id).await.is_ok());
}

fn make_mail(
    author: AgentPath,
    recipient: AgentPath,
    content: &str,
    trigger_turn: bool,
) -> InterAgentCommunication {
    InterAgentCommunication::new(
        author,
        recipient,
        Vec::new(),
        content.to_string(),
        trigger_turn,
    )
}

async fn spawn_v2_subagent(
    control: &AgentControl,
    state: &Arc<ThreadManagerState>,
    config: Config,
    parent_thread_id: ThreadId,
    label: &str,
) -> crate::thread_manager::NewThread {
    state
        .spawn_new_thread_with_source(
            config,
            control.clone(),
            SessionSource::SubAgent(SubAgentSource::Other(label.to_string())),
            /*history_mode*/ None,
            Some(parent_thread_id),
            /*forked_from_thread_id*/ None,
            Some(ThreadSource::Subagent),
            /*metrics_service_name*/ None,
            /*inherited_environments*/ None,
            /*inherited_exec_policy*/ None,
            /*environments*/ None,
        )
        .await
        .expect("spawn v2 subagent")
}

fn register_test_agent(control: &AgentControl, thread_id: ThreadId, label: &str) {
    let agent_path = AgentPath::try_from(format!("/root/{label}")).expect("valid agent path");
    let mut reservation = control
        .state
        .reserve_spawn_slot(/*max_threads*/ None)
        .expect("reserve agent registry slot");
    reservation
        .reserve_agent_path(&agent_path)
        .expect("reserve agent path");
    reservation.commit(AgentMetadata {
        agent_id: Some(thread_id),
        agent_path: Some(agent_path),
        ..Default::default()
    });
    control.state.mark_reloadable_v2(thread_id);
}

async fn mark_thread_completed(thread: &CodexThread) {
    mark_thread_completed_without_clearing(thread).await;
    clear_active_turn(thread).await;
}

async fn mark_thread_completed_without_clearing(thread: &CodexThread) {
    let turn = thread.session.new_default_turn().await;
    thread
        .session
        .send_event(
            turn.as_ref(),
            EventMsg::TurnComplete(TurnCompleteEvent {
                turn_id: turn.sub_id.clone(),
                started_at: None,
                last_agent_message: Some("done".to_string()),
                error: None,
                completed_at: None,
                duration_ms: None,
                time_to_first_token_ms: None,
            }),
        )
        .await;
}

async fn mark_thread_interrupted(thread: &CodexThread) {
    let turn = thread.session.new_default_turn().await;
    thread
        .session
        .send_event(
            turn.as_ref(),
            EventMsg::TurnAborted(TurnAbortedEvent {
                turn_id: Some(turn.sub_id.clone()),
                started_at: None,
                reason: TurnAbortReason::Interrupted,
                completed_at: None,
                duration_ms: None,
            }),
        )
        .await;
    clear_active_turn(thread).await;
}

async fn clear_active_turn(thread: &CodexThread) {
    // The fixture has no task runner to clear the turn after the terminal event.
    *thread.session.active_turn.lock().await = None;
}
