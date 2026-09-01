use codex_protocol::DEFAULT_FUNCTION_NAMESPACE;
use codex_protocol::models::FunctionCallOutputPayload;
use codex_protocol::models::ResponseItem;
use codex_tools::ResponsesApiNamespaceTool;
use codex_tools::ToolSpec;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use std::collections::HashSet;

const MAX_DISCOVERED_TOOL_BYTES: usize = 128 * 1024;

pub(crate) fn tools_for_request(
    visible_tools: &[ToolSpec],
    input: &[ResponseItem],
) -> Result<Vec<Value>, serde_json::Error> {
    let mut tools = Vec::new();
    let mut seen = HashSet::new();

    for tool in visible_tools {
        let values = match tool {
            ToolSpec::ToolSearch {
                description,
                parameters,
                ..
            } => vec![json!({
                "type": "function",
                "name": "tool_search",
                "description": description,
                "strict": false,
                "parameters": parameters,
            })],
            ToolSpec::Namespace(namespace) => namespace
                .tools
                .iter()
                .map(|tool| flatten_namespace_tool(&namespace.name, tool))
                .collect::<Result<Vec<_>, _>>()?,
            _ => vec![serde_json::to_value(tool)?],
        };
        append_unique_tools(&mut tools, &mut seen, values);
    }

    let mut discovered = Vec::new();
    let mut discovered_bytes = 0usize;
    for item in input.iter().rev() {
        let ResponseItem::ToolSearchOutput {
            execution, tools, ..
        } = item
        else {
            continue;
        };
        if execution != "client" {
            continue;
        }

        for tool in tools.iter().rev() {
            let mut flattened = flatten_serialized_tool(tool);
            flattened.reverse();
            for tool in flattened {
                let Some(key) = tool_key(&tool) else {
                    continue;
                };
                if seen.contains(&key) {
                    continue;
                }
                let tool_bytes = serde_json::to_vec(&tool)?.len();
                if tool_bytes > MAX_DISCOVERED_TOOL_BYTES.saturating_sub(discovered_bytes) {
                    continue;
                }
                discovered_bytes = discovered_bytes.saturating_add(tool_bytes);
                seen.insert(key);
                discovered.push(tool);
            }
        }
    }
    discovered.reverse();
    tools.extend(discovered);
    Ok(tools)
}

pub(crate) fn adapt_input_for_request(input: &mut [ResponseItem]) -> Result<(), serde_json::Error> {
    for item in input {
        match item {
            ResponseItem::ToolSearchCall {
                id,
                call_id: Some(call_id),
                execution,
                arguments,
                internal_chat_message_metadata_passthrough,
                ..
            } if execution == "client" => {
                *item = ResponseItem::FunctionCall {
                    id: id.clone(),
                    name: "tool_search".to_string(),
                    namespace: None,
                    arguments: serde_json::to_string(arguments)?,
                    encrypted_function_args: None,
                    call_id: call_id.clone(),
                    internal_chat_message_metadata_passthrough:
                        internal_chat_message_metadata_passthrough.clone(),
                };
            }
            ResponseItem::FunctionCall {
                id,
                name,
                namespace: Some(namespace),
                arguments,
                encrypted_function_args,
                call_id,
                internal_chat_message_metadata_passthrough,
            } if namespace != DEFAULT_FUNCTION_NAMESPACE && !namespace.is_empty() => {
                *item = ResponseItem::FunctionCall {
                    id: id.clone(),
                    name: format!("{namespace}{name}"),
                    namespace: None,
                    arguments: arguments.clone(),
                    encrypted_function_args: encrypted_function_args.clone(),
                    call_id: call_id.clone(),
                    internal_chat_message_metadata_passthrough:
                        internal_chat_message_metadata_passthrough.clone(),
                };
            }
            ResponseItem::CustomToolCall {
                id,
                status,
                call_id,
                name,
                namespace: Some(namespace),
                input,
                internal_chat_message_metadata_passthrough,
            } if namespace != DEFAULT_FUNCTION_NAMESPACE && !namespace.is_empty() => {
                *item = ResponseItem::CustomToolCall {
                    id: id.clone(),
                    status: status.clone(),
                    call_id: call_id.clone(),
                    name: format!("{namespace}{name}"),
                    namespace: None,
                    input: input.clone(),
                    internal_chat_message_metadata_passthrough:
                        internal_chat_message_metadata_passthrough.clone(),
                };
            }
            ResponseItem::ToolSearchOutput {
                id,
                call_id,
                execution,
                tools,
                internal_chat_message_metadata_passthrough,
                ..
            } if execution == "client" => {
                let output = serde_json::to_string(&json!({ "tools": tools }))?;
                *item = ResponseItem::FunctionCallOutput {
                    id: id.clone(),
                    call_id: call_id.clone(),
                    name: None,
                    namespace: None,
                    output: FunctionCallOutputPayload::from_text(output),
                    internal_chat_message_metadata_passthrough:
                        internal_chat_message_metadata_passthrough.clone(),
                };
            }
            _ => {}
        }
    }
    Ok(())
}

fn append_unique_tools(
    destination: &mut Vec<Value>,
    seen: &mut HashSet<(String, String)>,
    tools: Vec<Value>,
) {
    for tool in tools {
        if tool_key(&tool).is_none_or(|key| seen.insert(key)) {
            destination.push(tool);
        }
    }
}

fn tool_key(tool: &Value) -> Option<(String, String)> {
    let object = tool.as_object()?;
    Some((
        object.get("type")?.as_str()?.to_string(),
        object.get("name")?.as_str()?.to_string(),
    ))
}

fn flatten_serialized_tool(tool: &Value) -> Vec<Value> {
    let Some(object) = tool.as_object() else {
        return Vec::new();
    };
    match object.get("type").and_then(Value::as_str) {
        Some("namespace") => {
            let namespace = object
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            object
                .get("tools")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|tool| flatten_serialized_namespace_tool(namespace, tool))
                .collect()
        }
        Some("function" | "custom") => sanitize_flat_tool(object.clone(), None)
            .into_iter()
            .collect(),
        _ => Vec::new(),
    }
}

fn flatten_namespace_tool(
    namespace: &str,
    tool: &ResponsesApiNamespaceTool,
) -> Result<Value, serde_json::Error> {
    let value = serde_json::to_value(tool)?;
    Ok(flatten_serialized_namespace_tool(namespace, &value).unwrap_or(value))
}

fn flatten_serialized_namespace_tool(namespace: &str, tool: &Value) -> Option<Value> {
    let object = tool.as_object()?.clone();
    sanitize_flat_tool(object, Some(namespace))
}

fn sanitize_flat_tool(mut object: Map<String, Value>, namespace: Option<&str>) -> Option<Value> {
    let name = object.get("name")?.as_str()?;
    if let Some(namespace) = namespace
        && !namespace.is_empty()
        && namespace != DEFAULT_FUNCTION_NAMESPACE
    {
        object.insert(
            "name".to_string(),
            Value::String(format!("{namespace}{name}")),
        );
    }
    object.remove("defer_loading");
    Some(Value::Object(object))
}

#[cfg(test)]
#[path = "openrouter_compat_tests.rs"]
mod tests;
