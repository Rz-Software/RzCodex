use codex_protocol::protocol::AgentStatus;
use codex_protocol::protocol::EventMsg;

/// Derive the next agent status from a single emitted event.
/// Returns `None` when the event does not affect status tracking.
pub(crate) fn agent_status_from_event(msg: &EventMsg) -> Option<AgentStatus> {
    match msg {
        EventMsg::TurnStarted(_) => Some(AgentStatus::Running),
        EventMsg::TurnComplete(ev) => Some(match &ev.error {
            Some(error) => AgentStatus::Errored(error.message.clone()),
            None => AgentStatus::Completed(ev.last_agent_message.clone()),
        }),
        EventMsg::TurnAborted(ev) => match ev.reason {
            codex_protocol::protocol::TurnAbortReason::Interrupted
            | codex_protocol::protocol::TurnAbortReason::BudgetLimited => {
                Some(AgentStatus::Interrupted)
            }
            _ => Some(AgentStatus::Errored(format!("{:?}", ev.reason))),
        },
        EventMsg::Error(ev) => Some(AgentStatus::Errored(ev.message.clone())),
        EventMsg::ShutdownComplete => Some(AgentStatus::Shutdown),
        _ => None,
    }
}

/// Derive a terminal status for a spawned agent without allowing an empty regular turn to masquerade
/// as successful work. Non-agent task kinds such as manual compaction legitimately complete without
/// an assistant message, so this stricter boundary is applied only when notifying a spawned agent's
/// parent.
pub(crate) fn spawned_agent_terminal_status_from_event(msg: &EventMsg) -> Option<AgentStatus> {
    match agent_status_from_event(msg)? {
        AgentStatus::Completed(None) => Some(AgentStatus::Errored(
            "subagent turn completed without a terminal assistant response".to_string(),
        )),
        status => Some(status),
    }
}

pub(crate) fn is_final(status: &AgentStatus) -> bool {
    !matches!(
        status,
        AgentStatus::PendingInit | AgentStatus::Running | AgentStatus::Interrupted
    )
}
