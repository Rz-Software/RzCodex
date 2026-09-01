use std::borrow::Cow;

use super::CodexHarnessMetadata;
use super::CompactedItem;
use super::EventMsg;
use super::InterAgentCommunication;
use super::McpResourceOriginCheckpoint;
use super::RealtimeItem;
use super::ResponseItem;
use super::ResponseItemEnvelope;
use super::RolloutItem;
use super::SecurityRiskScore;
use super::SessionMetaLine;
use super::TokenUsageRecord;
use super::TurnContextItem;
use super::WorldStateItem;
use codex_protocol::models::ContentItem;
use codex_protocol::models::FunctionCallOutputBody;
use codex_protocol::models::FunctionCallOutputContentItem;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;

const PRUNED_INLINE_IMAGE_TEXT: &str =
    "[inline base64 image payload pruned after repeated context compaction]";

/// Persisted rollout item used by core history and rollout storage.
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum RolloutItemWire<'a> {
    SessionMeta {
        payload: Cow<'a, SessionMetaLine>,
    },
    ResponseItem {
        payload: Cow<'a, ResponseItem>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        metadata: Option<Cow<'a, CodexHarnessMetadata>>,
    },
    InterAgentCommunication {
        payload: Cow<'a, InterAgentCommunication>,
    },
    InterAgentCommunicationMetadata {
        payload: InterAgentCommunicationMetadataPayload,
    },
    Compacted {
        payload: Cow<'a, CompactedItem>,
    },
    TurnContext {
        payload: Cow<'a, TurnContextItem>,
    },
    TokenUsageRecord {
        payload: Cow<'a, TokenUsageRecord>,
    },
    WorldState {
        payload: Cow<'a, WorldStateItem>,
    },
    SecurityRiskScore {
        payload: Cow<'a, SecurityRiskScore>,
    },
    EventMsg {
        payload: Cow<'a, EventMsg>,
    },
    RealtimeItem {
        payload: Cow<'a, RealtimeItem>,
    },
}

impl<'a> From<&'a RolloutItem> for RolloutItemWire<'a> {
    fn from(item: &'a RolloutItem) -> Self {
        match item {
            RolloutItem::SessionMeta(payload) => Self::SessionMeta {
                payload: Cow::Borrowed(payload),
            },
            RolloutItem::ResponseItem(envelope) => Self::ResponseItem {
                payload: Cow::Borrowed(&envelope.item),
                metadata: envelope.metadata.as_ref().map(Cow::Borrowed),
            },
            RolloutItem::InterAgentCommunication(payload) => Self::InterAgentCommunication {
                payload: Cow::Borrowed(payload),
            },
            RolloutItem::InterAgentCommunicationMetadata { trigger_turn } => {
                Self::InterAgentCommunicationMetadata {
                    payload: InterAgentCommunicationMetadataPayload {
                        trigger_turn: *trigger_turn,
                    },
                }
            }
            RolloutItem::Compacted(payload) => Self::Compacted {
                payload: Cow::Borrowed(payload),
            },
            RolloutItem::TurnContext(payload) => Self::TurnContext {
                payload: Cow::Borrowed(payload),
            },
            RolloutItem::TokenUsageRecord(payload) => Self::TokenUsageRecord {
                payload: Cow::Borrowed(payload),
            },
            RolloutItem::WorldState(payload) => Self::WorldState {
                payload: Cow::Borrowed(payload),
            },
            RolloutItem::SecurityRiskScore(payload) => Self::SecurityRiskScore {
                payload: Cow::Borrowed(payload),
            },
            RolloutItem::EventMsg(payload) => Self::EventMsg {
                payload: Cow::Borrowed(payload),
            },
            RolloutItem::RealtimeItem(payload) => Self::RealtimeItem {
                payload: Cow::Borrowed(payload),
            },
        }
    }
}

impl From<RolloutItemWire<'_>> for RolloutItem {
    fn from(item: RolloutItemWire<'_>) -> Self {
        match item {
            RolloutItemWire::SessionMeta { payload } => Self::SessionMeta(payload.into_owned()),
            RolloutItemWire::ResponseItem { payload, metadata } => {
                Self::ResponseItem(ResponseItemEnvelope {
                    item: payload.into_owned(),
                    metadata: metadata.map(Cow::into_owned),
                })
            }
            RolloutItemWire::InterAgentCommunication { payload } => {
                Self::InterAgentCommunication(payload.into_owned())
            }
            RolloutItemWire::InterAgentCommunicationMetadata { payload } => {
                Self::InterAgentCommunicationMetadata {
                    trigger_turn: payload.trigger_turn,
                }
            }
            RolloutItemWire::Compacted { payload } => Self::Compacted(payload.into_owned()),
            RolloutItemWire::TurnContext { payload } => Self::TurnContext(payload.into_owned()),
            RolloutItemWire::TokenUsageRecord { payload } => {
                Self::TokenUsageRecord(payload.into_owned())
            }
            RolloutItemWire::WorldState { payload } => Self::WorldState(payload.into_owned()),
            RolloutItemWire::SecurityRiskScore { payload } => {
                Self::SecurityRiskScore(payload.into_owned())
            }
            RolloutItemWire::EventMsg { payload } => Self::EventMsg(payload.into_owned()),
            RolloutItemWire::RealtimeItem { payload } => Self::RealtimeItem(payload.into_owned()),
        }
    }
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub(super) struct InterAgentCommunicationMetadataPayload {
    trigger_turn: bool,
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub(super) struct CompactedItemWire<'a> {
    message: Cow<'a, str>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    replacement_history: Option<Vec<Cow<'a, ResponseItem>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    replacement_history_metadata: Option<Vec<Cow<'a, CodexHarnessMetadata>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    guardian_history: Option<Cow<'a, crate::GuardianHistoryCheckpoint>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mcp_resource_origins: Option<Cow<'a, McpResourceOriginCheckpoint>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    window_number: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    first_window_id: Option<Cow<'a, str>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous_window_id: Option<Cow<'a, str>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Option<String>")]
    window_id: Option<WindowIdWire<'a>>,
    #[serde(default)]
    compaction_response_id: Option<Cow<'a, str>>,
    #[serde(default)]
    latest_token_usage_record: Option<Cow<'a, TokenUsageRecord>>,
}

impl<'a> From<&'a CompactedItem> for CompactedItemWire<'a> {
    fn from(item: &'a CompactedItem) -> Self {
        let prune_repeated_inline_images = item.window_number.is_some_and(|number| number > 1);
        let replacement_history_metadata = item
            .replacement_history
            .as_ref()
            .filter(|items| items.iter().any(|envelope| envelope.metadata.is_some()))
            .map(|items| {
                items
                    .iter()
                    .map(|envelope| match envelope.metadata.as_ref() {
                        Some(metadata) => Cow::Borrowed(metadata),
                        None => Cow::Owned(CodexHarnessMetadata::default()),
                    })
                    .collect()
            });

        Self {
            message: Cow::Borrowed(&item.message),
            replacement_history: item.replacement_history.as_ref().map(|items| {
                items
                    .iter()
                    .map(|envelope| {
                        persisted_response_item(&envelope.item, prune_repeated_inline_images)
                    })
                    .collect()
            }),
            replacement_history_metadata,
            guardian_history: item.guardian_history.as_ref().map(Cow::Borrowed),
            mcp_resource_origins: item.mcp_resource_origins.as_ref().map(Cow::Borrowed),
            window_number: item.window_number,
            first_window_id: item.first_window_id.as_deref().map(Cow::Borrowed),
            previous_window_id: item.previous_window_id.as_deref().map(Cow::Borrowed),
            window_id: item
                .window_id
                .as_deref()
                .map(|window_id| WindowIdWire::Id(Cow::Borrowed(window_id))),
            compaction_response_id: item.compaction_response_id.as_deref().map(Cow::Borrowed),
            latest_token_usage_record: item.latest_token_usage_record.as_ref().map(Cow::Borrowed),
        }
    }
}

fn persisted_response_item(
    item: &ResponseItem,
    prune_inline_images: bool,
) -> Cow<'_, ResponseItem> {
    if !prune_inline_images {
        return Cow::Borrowed(item);
    }
    let mut persisted = item.clone();
    if prune_inline_base64_images(&mut persisted) {
        Cow::Owned(persisted)
    } else {
        Cow::Borrowed(item)
    }
}

fn prune_inline_base64_images(item: &mut ResponseItem) -> bool {
    match item {
        ResponseItem::Message { content, .. } => {
            let mut pruned = false;
            for content_item in content {
                if matches!(
                    content_item,
                    ContentItem::InputImage { image_url, .. }
                        if is_inline_base64_image_url(image_url)
                ) {
                    *content_item = ContentItem::InputText {
                        text: PRUNED_INLINE_IMAGE_TEXT.to_string(),
                    };
                    pruned = true;
                }
            }
            pruned
        }
        ResponseItem::FunctionCallOutput { output, .. }
        | ResponseItem::CustomToolCallOutput { output, .. } => {
            let FunctionCallOutputBody::ContentItems(content) = &mut output.body else {
                return false;
            };
            let mut pruned = false;
            for content_item in content {
                if matches!(
                    content_item,
                    FunctionCallOutputContentItem::InputImage { image_url, .. }
                        if is_inline_base64_image_url(image_url)
                ) {
                    *content_item = FunctionCallOutputContentItem::InputText {
                        text: PRUNED_INLINE_IMAGE_TEXT.to_string(),
                    };
                    pruned = true;
                }
            }
            pruned
        }
        _ => false,
    }
}

fn is_inline_base64_image_url(url: &str) -> bool {
    if !url
        .get(.."data:".len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:"))
    {
        return false;
    }
    let Some((metadata, _)) = url.split_once(',') else {
        return false;
    };
    let Some(metadata) = metadata.get("data:".len()..) else {
        return false;
    };
    let mut parts = metadata.split(';');
    let mime_type = parts.next().unwrap_or_default();
    mime_type
        .get(.."image/".len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("image/"))
        && parts.any(|part| part.eq_ignore_ascii_case("base64"))
}

impl TryFrom<CompactedItemWire<'_>> for CompactedItem {
    type Error = String;

    fn try_from(item: CompactedItemWire<'_>) -> Result<Self, Self::Error> {
        let replacement_history = match (
            item.replacement_history,
            item.replacement_history_metadata,
        ) {
            (Some(items), Some(metadata)) => {
                let history_len = items.len();
                let metadata_len = metadata.len();
                if history_len != metadata_len {
                    return Err(format!(
                        "replacement_history_metadata has {metadata_len} entries for {history_len} history items"
                    ));
                }
                Some(
                    items
                        .into_iter()
                        .zip(metadata)
                        .map(|(item, metadata)| ResponseItemEnvelope {
                            item: item.into_owned(),
                            metadata: Some(metadata.into_owned()),
                        })
                        .collect(),
                )
            }
            (Some(items), None) => Some(
                items
                    .into_iter()
                    .map(|item| ResponseItemEnvelope::new(item.into_owned()))
                    .collect(),
            ),
            (None, Some(_)) => {
                return Err("replacement_history_metadata requires replacement_history".to_string());
            }
            (None, None) => None,
        };

        let mut window_number = item.window_number;
        let window_id = match item.window_id {
            Some(WindowIdWire::Id(window_id)) => Some(window_id.into_owned()),
            Some(WindowIdWire::LegacyWindowNumber(legacy_window_number)) => {
                window_number.get_or_insert(legacy_window_number);
                None
            }
            None => None,
        };

        Ok(Self {
            message: item.message.into_owned(),
            replacement_history,
            guardian_history: item.guardian_history.map(Cow::into_owned),
            mcp_resource_origins: item.mcp_resource_origins.map(Cow::into_owned),
            window_number,
            first_window_id: item.first_window_id.map(Cow::into_owned),
            previous_window_id: item.previous_window_id.map(Cow::into_owned),
            window_id,
            compaction_response_id: item.compaction_response_id.map(Cow::into_owned),
            latest_token_usage_record: item.latest_token_usage_record.map(Cow::into_owned),
        })
    }
}

// Older rollouts stored the numeric window number in `window_id`.
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum WindowIdWire<'a> {
    Id(Cow<'a, str>),
    LegacyWindowNumber(u64),
}
