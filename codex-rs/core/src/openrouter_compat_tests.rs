use super::*;
use codex_protocol::models::FunctionCallOutputBody;
use codex_protocol::models::SearchToolCallParams;
use codex_tools::JsonSchema;
use codex_tools::ResponsesApiNamespace;
use codex_tools::ResponsesApiTool;
use pretty_assertions::assert_eq;
use serde_json::json;

fn search_spec() -> ToolSpec {
    ToolSpec::ToolSearch {
        execution: "client".to_string(),
        description: "Find deferred tools.".to_string(),
        parameters: JsonSchema::object(Default::default(), None, Some(false.into())),
    }
}

fn discovered_namespace() -> Value {
    serde_json::to_value(codex_tools::LoadableToolSpec::Namespace(
        ResponsesApiNamespace {
            name: "mcp__rzmcp__".to_string(),
            description: "RzMCP tools".to_string(),
            tools: vec![ResponsesApiNamespaceTool::Function(ResponsesApiTool {
                name: "search_project_index".to_string(),
                description: "Search the project index.".to_string(),
                strict: false,
                defer_loading: Some(true),
                parameters: JsonSchema::object(Default::default(), None, Some(false.into())),
                output_schema: None,
            })],
        },
    ))
    .expect("serialize discovered namespace")
}

#[test]
fn tools_use_client_functions_and_flatten_discovered_namespaces() -> anyhow::Result<()> {
    let input = vec![ResponseItem::ToolSearchOutput {
        id: None,
        call_id: Some("call-search".to_string()),
        status: "completed".to_string(),
        execution: "client".to_string(),
        tools: vec![discovered_namespace()],
        internal_chat_message_metadata_passthrough: None,
    }];

    let tools = tools_for_request(&[search_spec()], &input)?;

    assert_eq!(
        tools,
        vec![
            json!({
                "type": "function",
                "name": "tool_search",
                "description": "Find deferred tools.",
                "strict": false,
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false,
                },
            }),
            json!({
                "type": "function",
                "name": "mcp__rzmcp__search_project_index",
                "description": "Search the project index.",
                "strict": false,
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false,
                },
            }),
        ]
    );
    Ok(())
}

#[test]
fn input_uses_function_call_pairs_on_openrouter_wire() -> anyhow::Result<()> {
    let arguments = SearchToolCallParams {
        query: "project index".to_string(),
        limit: Some(3),
    };
    let mut input = vec![
        ResponseItem::ToolSearchCall {
            id: None,
            call_id: Some("call-search".to_string()),
            status: Some("completed".to_string()),
            execution: "client".to_string(),
            arguments: serde_json::to_value(&arguments)?,
            internal_chat_message_metadata_passthrough: None,
        },
        ResponseItem::ToolSearchOutput {
            id: None,
            call_id: Some("call-search".to_string()),
            status: "completed".to_string(),
            execution: "client".to_string(),
            tools: vec![discovered_namespace()],
            internal_chat_message_metadata_passthrough: None,
        },
    ];

    adapt_input_for_request(&mut input)?;

    let ResponseItem::FunctionCall {
        name,
        arguments: actual_arguments,
        call_id,
        ..
    } = &input[0]
    else {
        panic!("expected function call")
    };
    assert_eq!(name, "tool_search");
    assert_eq!(call_id, "call-search");
    assert_eq!(
        serde_json::from_str::<Value>(actual_arguments)?,
        json!(arguments)
    );

    let ResponseItem::FunctionCallOutput { output, .. } = &input[1] else {
        panic!("expected function output")
    };
    let FunctionCallOutputBody::Text(output) = &output.body else {
        panic!("expected text output")
    };
    assert_eq!(
        serde_json::from_str::<Value>(output)?,
        json!({ "tools": [discovered_namespace()] })
    );
    Ok(())
}

#[test]
fn input_flattens_namespaced_calls_for_openrouter_wire() -> anyhow::Result<()> {
    let mut input = vec![ResponseItem::FunctionCall {
        id: None,
        name: "search_project_index".to_string(),
        namespace: Some("mcp__rzmcp__".to_string()),
        arguments: "{}".to_string(),
        encrypted_function_args: None,
        call_id: "call-index".to_string(),
        internal_chat_message_metadata_passthrough: None,
    }];

    adapt_input_for_request(&mut input)?;

    let ResponseItem::FunctionCall {
        name, namespace, ..
    } = &input[0]
    else {
        panic!("expected function call")
    };
    assert_eq!(name, "mcp__rzmcp__search_project_index");
    assert_eq!(namespace, &None);
    Ok(())
}
