use anyhow::Result;
use codex_core::StartThreadOptions;
use codex_core::TurnInputRequest;
use codex_model_provider_info::ModelProviderInfo;
use codex_models_manager::bundled_models_response;
use codex_protocol::openai_models::ReasoningEffort;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::SessionSource;
use codex_protocol::protocol::SubAgentSource;
use codex_protocol::user_input::UserInput;
use core_test_support::responses::ev_assistant_message;
use core_test_support::responses::ev_completed;
use core_test_support::responses::ev_response_created;
use core_test_support::responses::sse;
use core_test_support::skip_if_no_network;
use core_test_support::test_codex::test_codex;
use core_test_support::wait_for_event;
use serde_json::Value;
use serde_json::json;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::method;
use wiremock::matchers::path;

const CHILD_PROMPT: &str = "preserve this exact native fallback task";
const BRIDGE_MODEL: &str = "test-external-subagent";
const NATIVE_MODEL: &str = "gpt-5.6-luna";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn spawned_subagent_continues_same_turn_on_native_route_before_external_commit() -> Result<()>
{
    skip_if_no_network!(Ok(()));

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/bridge/v1/responses"))
        .respond_with(ResponseTemplate::new(200).insert_header("content-type", "text/event-stream").set_body_raw(
            sse(vec![
                ev_response_created("external-response"),
                json!({
                    "type": "response.output_item.added",
                    "output_index": 0,
                    "item": {
                        "type": "reasoning",
                        "id": "progress_external-provider-fixture",
                        "status": "in_progress",
                        "summary": []
                    }
                }),
                json!({
                    "type": "response.reasoning_summary_text.delta",
                    "item_id": "progress_external-provider-fixture",
                    "output_index": 0,
                    "summary_index": 0,
                    "delta": "External provider selection was attempted."
                }),
                json!({
                    "type": "response.reasoning_summary_text.done",
                    "item_id": "progress_external-provider-fixture",
                    "output_index": 0,
                    "summary_index": 0,
                    "text": "External provider selection was attempted."
                }),
                json!({
                    "type": "response.output_item.done",
                    "output_index": 0,
                    "item": {
                        "type": "reasoning",
                        "id": "progress_external-provider-fixture",
                        "status": "completed",
                        "summary": [{
                            "type": "summary_text",
                            "text": "External provider selection was attempted."
                        }]
                    }
                }),
                json!({
                    "type": "response.failed",
                    "response": {
                        "id": "external-response",
                        "error": {
                            "code": "native_subagent_fallback",
                            "message": "External providers were unavailable before committed work.",
                            "fallback_route": "native"
                        }
                    }
                }),
            ]),
            "text/event-stream",
        ))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/native/v1/responses"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(
                    sse(vec![
                        ev_response_created("native-response"),
                        ev_assistant_message("native-message", "native fallback completed"),
                        ev_completed("native-response"),
                    ]),
                    "text/event-stream",
                ),
        )
        .expect(1)
        .mount(&server)
        .await;

    let bridge_base_url = format!("{}/bridge/v1", server.uri());
    let native_base_url = format!("{}/native/v1", server.uri());
    let test = test_codex()
        .with_config(move |config| {
            let mut bridge_provider: ModelProviderInfo = config.model_provider.clone();
            bridge_provider.name = "test external subagent bridge".to_string();
            bridge_provider.base_url = Some(bridge_base_url.clone());
            bridge_provider.requires_openai_auth = false;
            bridge_provider.supports_websockets = false;
            bridge_provider.request_max_retries = Some(0);
            bridge_provider.stream_max_retries = Some(0);
            config
                .model_providers
                .insert("bridge".to_string(), bridge_provider);

            let mut native_provider = config.model_provider.clone();
            // Preserve the built-in provider identity: request normalization is intentionally
            // OpenAI-specific and must run on the real native fallback path.
            native_provider.name = "OpenAI".to_string();
            native_provider.base_url = Some(native_base_url);
            native_provider.supports_websockets = false;
            native_provider.request_max_retries = Some(0);
            native_provider.stream_max_retries = Some(0);
            config
                .model_providers
                .insert("openai".to_string(), native_provider);

            let mut model_catalog =
                bundled_models_response().expect("bundled models.json should parse");
            let mut bridge_model = model_catalog
                .models
                .iter()
                .find(|model| model.slug == "gpt-5.4")
                .cloned()
                .expect("bundled model gpt-5.4");
            bridge_model.slug = BRIDGE_MODEL.to_string();
            bridge_model.display_name = BRIDGE_MODEL.to_string();
            model_catalog.models.push(bridge_model);
            assert!(
                model_catalog
                    .models
                    .iter()
                    .any(|model| model.slug == NATIVE_MODEL
                        && model
                            .supported_reasoning_levels
                            .iter()
                            .any(|preset| preset.effort == ReasoningEffort::Max)),
                "bundled Luna metadata must advertise max reasoning"
            );
            config.model_catalog = Some(model_catalog);

            std::fs::write(
                config.codex_home.join("subagent-models.json"),
                serde_json::to_vec_pretty(&json!({
                    "routes": {
                        "auto": {
                            "label": "Test external route",
                            "modelProvider": "bridge",
                            "model": BRIDGE_MODEL,
                            "reasoningEffort": "high",
                            "inputModalities": ["text"],
                            "nativeFallbackRoute": "native"
                        },
                        "native": {
                            "label": "Native OpenAI Luna Max",
                            "modelProvider": "openai",
                            "model": NATIVE_MODEL,
                            "reasoningEffort": "max",
                            "inputModalities": ["text", "image"]
                        }
                    }
                }))
                .expect("serialize route catalog"),
            )
            .expect("write route catalog");
            std::fs::write(
                config.codex_home.join("subagent-route.json"),
                br#"{"version":1,"activeRoute":"auto"}"#,
            )
            .expect("write active route");
        })
        .build(&server)
        .await?;

    let mut child_config = test.config.clone();
    child_config.model_provider_id = "bridge".to_string();
    child_config.model_provider = child_config.model_providers["bridge"].clone();
    child_config.model = Some(BRIDGE_MODEL.to_string());
    child_config.model_reasoning_effort = Some(ReasoningEffort::High);
    let child = test
        .thread_manager
        .start_thread(StartThreadOptions {
            session_source: Some(SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
                parent_thread_id: test.session_configured.thread_id,
                depth: 1,
                agent_path: None,
                agent_nickname: None,
                agent_role: None,
            })),
            ..StartThreadOptions::new(child_config)
        })
        .await?;
    child
        .thread
        .start_or_steer_turn(TurnInputRequest::user_input(vec![UserInput::Text {
            text: CHILD_PROMPT.to_string(),
            text_elements: Vec::new(),
        }]))
        .await?;

    let mut warning = None;
    let completion = loop {
        match wait_for_event(&child.thread, |_| true).await {
            EventMsg::Warning(event) => warning = Some(event.message),
            EventMsg::TurnComplete(event) => break event,
            _ => {}
        }
    };
    assert_eq!(completion.error, None);
    assert!(
        warning
            .as_deref()
            .is_some_and(|message| message.contains("native route `native`")),
        "the child should report its native route switch"
    );

    let requests = server.received_requests().await.expect("recorded requests");
    let bridge_request = requests
        .iter()
        .find(|request| request.url.path() == "/bridge/v1/responses")
        .expect("external bridge request")
        .body_json::<Value>()
        .expect("external bridge request JSON");
    let native_request = requests
        .iter()
        .find(|request| request.url.path() == "/native/v1/responses")
        .expect("native OpenAI request")
        .body_json::<Value>()
        .expect("native OpenAI request JSON");

    assert_eq!(bridge_request["model"], BRIDGE_MODEL);
    assert_eq!(native_request["model"], NATIVE_MODEL);
    assert_eq!(native_request["reasoning"]["effort"], "max");
    let native_input = serde_json::to_string(&native_request["input"])?;
    assert_eq!(native_input.matches(CHILD_PROMPT).count(), 1);
    assert!(!native_input.contains("progress_external-provider-fixture"));

    child.thread.shutdown_and_wait().await?;
    test.thread_manager
        .remove_thread(&child.thread_id)
        .await
        .expect("remove completed child thread");
    Ok(())
}
