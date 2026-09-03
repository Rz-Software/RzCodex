use anyhow::Context;
use anyhow::Result;
use anyhow::bail;
use codex_model_provider_info::OPENAI_PROVIDER_ID;
use codex_protocol::openai_models::InputModality;
use codex_protocol::openai_models::ReasoningEffort;
use codex_utils_path::write_atomically;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::Read;
use std::io::Write;
use std::net::TcpStream;
use std::net::ToSocketAddrs;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

pub const SUBAGENT_ROUTE_CATALOG_FILE: &str = "subagent-models.json";
pub const SUBAGENT_ROUTE_STATE_FILE: &str = "subagent-route.json";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRoute {
    pub label: String,
    pub model_provider: String,
    pub model: String,
    /// Optional provider model alias used when this route drives the root conversation.
    /// The delegated model remains `model`, so bridge contracts can keep the two roles distinct.
    #[serde(default)]
    pub main_model: Option<String>,
    pub reasoning_effort: ReasoningEffort,
    #[serde(default)]
    pub input_modalities: Option<Vec<InputModality>>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub health_url: Option<String>,
    #[serde(default)]
    pub native_fallback_route: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct SubagentRouteCatalog {
    pub routes: BTreeMap<String, SubagentRoute>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedSubagentRoute {
    pub id: String,
    pub route: SubagentRoute,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubagentRouteProbe {
    pub summary: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SubagentRouteState {
    version: u32,
    active_route: String,
}

pub fn subagent_route_catalog_path(codex_home: &Path) -> PathBuf {
    codex_home.join(SUBAGENT_ROUTE_CATALOG_FILE)
}

pub fn subagent_route_state_path(codex_home: &Path) -> PathBuf {
    codex_home.join(SUBAGENT_ROUTE_STATE_FILE)
}

pub fn load_subagent_route_catalog(codex_home: &Path) -> Result<SubagentRouteCatalog> {
    let path = subagent_route_catalog_path(codex_home);
    let contents = std::fs::read_to_string(&path)
        .with_context(|| format!("failed to read subagent route catalog {}", path.display()))?;
    let catalog: SubagentRouteCatalog = serde_json::from_str(&contents)
        .with_context(|| format!("failed to parse subagent route catalog {}", path.display()))?;
    if catalog.routes.is_empty() {
        bail!("subagent route catalog {} has no routes", path.display());
    }
    for (id, route) in &catalog.routes {
        validate_route(id, route)?;
    }
    for (id, route) in &catalog.routes {
        let Some(fallback_id) = route.native_fallback_route.as_deref() else {
            continue;
        };
        if fallback_id == id {
            bail!("subagent route `{id}` cannot fall back to itself");
        }
        let fallback = catalog.routes.get(fallback_id).with_context(|| {
            format!(
                "subagent route `{id}` references missing native fallback route `{fallback_id}`"
            )
        })?;
        if fallback.model_provider != OPENAI_PROVIDER_ID {
            bail!(
                "subagent route `{id}` native fallback `{fallback_id}` must use provider `{OPENAI_PROVIDER_ID}`"
            );
        }
    }
    Ok(catalog)
}

/// Returns `None` when managed subagent routing has never been enabled.
pub fn resolve_active_subagent_route(codex_home: &Path) -> Result<Option<ResolvedSubagentRoute>> {
    let state_path = subagent_route_state_path(codex_home);
    let contents = match std::fs::read_to_string(&state_path) {
        Ok(contents) => contents,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(err).with_context(|| {
                format!(
                    "failed to read subagent route state {}",
                    state_path.display()
                )
            });
        }
    };
    let state: SubagentRouteState = serde_json::from_str(&contents).with_context(|| {
        format!(
            "failed to parse subagent route state {}",
            state_path.display()
        )
    })?;
    if state.version != 1 {
        bail!(
            "unsupported subagent route state version {} in {}",
            state.version,
            state_path.display()
        );
    }
    resolve_subagent_route(codex_home, &state.active_route).map(Some)
}

pub fn resolve_subagent_route(codex_home: &Path, route_id: &str) -> Result<ResolvedSubagentRoute> {
    let catalog = load_subagent_route_catalog(codex_home)?;
    let route = catalog.routes.get(route_id).cloned().with_context(|| {
        format!(
            "unknown subagent route `{route_id}` in {}",
            subagent_route_catalog_path(codex_home).display()
        )
    })?;
    Ok(ResolvedSubagentRoute {
        id: route_id.to_string(),
        route,
    })
}

pub fn persist_active_subagent_route(codex_home: &Path, route_id: &str) -> Result<()> {
    resolve_subagent_route(codex_home, route_id)?;
    let path = subagent_route_state_path(codex_home);
    let contents = serde_json::to_string_pretty(&SubagentRouteState {
        version: 1,
        active_route: route_id.to_string(),
    })? + "\n";
    write_atomically(&path, &contents)
        .with_context(|| format!("failed to write subagent route state {}", path.display()))
}

pub fn probe_subagent_route(route: &SubagentRoute) -> Result<SubagentRouteProbe> {
    let Some(url) = route.health_url.as_deref() else {
        return Ok(SubagentRouteProbe {
            summary: "configured; no health endpoint".to_string(),
        });
    };
    let response = http_get_json(url)?;
    if response.get("ok").and_then(Value::as_bool) == Some(false) {
        let reason = first_string(&response, &["error", "message"])
            .unwrap_or_else(|| "bridge reported failure".to_string());
        bail!("health endpoint reported `{reason}`");
    }
    let status =
        first_string(&response, &["status", "state"]).unwrap_or_else(|| "healthy".to_string());
    if matches!(
        status.to_ascii_lowercase().as_str(),
        "error" | "failed" | "unhealthy"
    ) {
        bail!("health endpoint reported `{status}`");
    }

    let mut details = vec![status];
    if let Some(quota) = active_quota_summary(&response) {
        details.push(quota);
    }
    if let Some(provider) = first_string(
        &response,
        &[
            "lastActualProvider",
            "actualProvider",
            "lastConfiguredRoute",
            "activeProvider",
            "provider",
            "providerId",
        ],
    ) {
        details.push(provider);
    }
    if let Some(model) = first_string(
        &response,
        &[
            "lastActualModel",
            "actualModel",
            "configuredModel",
            "activeModel",
            "modelAlias",
            "model",
            "modelId",
        ],
    ) {
        details.push(model);
    }
    details.dedup();
    Ok(SubagentRouteProbe {
        summary: details.join(" · "),
    })
}

fn validate_route(id: &str, route: &SubagentRoute) -> Result<()> {
    if id.trim().is_empty() {
        bail!("subagent route id must not be empty");
    }
    for (field, value) in [
        ("label", route.label.as_str()),
        ("modelProvider", route.model_provider.as_str()),
        ("model", route.model.as_str()),
    ] {
        if value.trim().is_empty() {
            bail!("subagent route `{id}` has an empty `{field}`");
        }
    }
    if route
        .main_model
        .as_deref()
        .is_some_and(|main_model| main_model.trim().is_empty())
    {
        bail!("subagent route `{id}` has an empty `mainModel`");
    }
    Ok(())
}

fn active_quota_summary(value: &Value) -> Option<String> {
    let quota = find_object(value, "calendarQuotaState")?;
    quota
        .get("active")
        .and_then(Value::as_bool)
        .filter(|active| *active)?;
    let kind = quota
        .get("kind")
        .or_else(|| quota.get("period"))
        .and_then(Value::as_str)
        .unwrap_or("quota");
    Some(format!("{kind} quota reached"))
}

fn first_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| find_value(value, key).and_then(Value::as_str))
        .map(str::to_string)
}

fn find_object<'a>(value: &'a Value, key: &str) -> Option<&'a serde_json::Map<String, Value>> {
    find_value(value, key)?.as_object()
}

fn find_value<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(object) => object
            .get(key)
            .or_else(|| object.values().find_map(|child| find_value(child, key))),
        Value::Array(values) => values.iter().find_map(|child| find_value(child, key)),
        _ => None,
    }
}

fn http_get_json(url: &str) -> Result<Value> {
    let target = HttpTarget::parse(url)?;
    let address = (target.host.as_str(), target.port)
        .to_socket_addrs()
        .with_context(|| format!("failed to resolve health endpoint `{url}`"))?
        .next()
        .with_context(|| format!("health endpoint `{url}` resolved no addresses"))?;
    let timeout = Duration::from_millis(750);
    let mut stream = TcpStream::connect_timeout(&address, timeout)
        .with_context(|| format!("health endpoint `{url}` is unavailable"))?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    write!(
        stream,
        "GET {} HTTP/1.1\r\nHost: {}:{}\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
        target.path, target.host, target.port
    )?;
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    while bytes.len() < 64 * 1024 {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                bytes.extend_from_slice(&buffer[..read]);
                if http_response_is_complete(&bytes) {
                    break;
                }
            }
            Err(err)
                if matches!(
                    err.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) && !bytes.is_empty() =>
            {
                break;
            }
            Err(err) => return Err(err.into()),
        }
    }
    let response = String::from_utf8(bytes).context("health endpoint returned non-UTF-8 data")?;
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .context("health endpoint returned a malformed HTTP response")?;
    let status_line = headers.lines().next().unwrap_or_default();
    if !status_line.contains(" 200 ") {
        bail!("health endpoint returned `{status_line}`");
    }
    serde_json::from_str(body).context("health endpoint returned malformed JSON")
}

fn http_response_is_complete(bytes: &[u8]) -> bool {
    let Ok(response) = std::str::from_utf8(bytes) else {
        return false;
    };
    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    let content_length = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())
            .flatten()
    });
    content_length.is_some_and(|content_length| body.len() >= content_length)
}

struct HttpTarget {
    host: String,
    port: u16,
    path: String,
}

impl HttpTarget {
    fn parse(url: &str) -> Result<Self> {
        let remainder = url.strip_prefix("http://").with_context(|| {
            format!("health URL must use plain HTTP on a local bridge: `{url}`")
        })?;
        let (authority, raw_path) = remainder.split_once('/').unwrap_or((remainder, ""));
        let path = format!("/{raw_path}");
        let (host, port) =
            authority
                .rsplit_once(':')
                .map_or(Ok((authority, 80)), |(host, port)| {
                    port.parse::<u16>()
                        .map(|port| (host, port))
                        .context("health URL has an invalid port")
                })?;
        if host.is_empty() {
            bail!("health URL has no host: `{url}`");
        }
        if !matches!(host, "127.0.0.1" | "localhost" | "[::1]") {
            bail!("health URL must target a loopback bridge: `{url}`");
        }
        Ok(Self {
            host: host.to_string(),
            port,
            path,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    fn write_catalog(home: &Path) {
        std::fs::write(
            home.join(SUBAGENT_ROUTE_CATALOG_FILE),
            r#"{
              "legacyProvider": "preserved",
              "routes": {
                "native": {
                  "label": "Native OpenAI",
                  "modelProvider": "openai",
                  "model": "test-model",
                  "mainModel": "@preset/rzcodex-main",
                  "reasoningEffort": "max"
                }
              }
            }"#,
        )
        .unwrap();
    }

    fn write_fallback_catalog(home: &Path, fallback_route: &str, fallback_provider: &str) {
        std::fs::write(
            home.join(SUBAGENT_ROUTE_CATALOG_FILE),
            format!(
                r#"{{
                  "routes": {{
                    "auto": {{
                      "label": "Automatic route",
                      "modelProvider": "bridge",
                      "model": "bridge-model",
                      "reasoningEffort": "high",
                      "nativeFallbackRoute": "{fallback_route}"
                    }},
                    "native": {{
                      "label": "Native route",
                      "modelProvider": "{fallback_provider}",
                      "model": "native-model",
                      "reasoningEffort": "max"
                    }}
                  }}
                }}"#
            ),
        )
        .unwrap();
    }

    #[test]
    fn managed_route_is_opt_in_and_state_is_atomic() {
        let home = TempDir::new().unwrap();
        write_catalog(home.path());
        assert_eq!(resolve_active_subagent_route(home.path()).unwrap(), None);

        persist_active_subagent_route(home.path(), "native").unwrap();
        let resolved = resolve_active_subagent_route(home.path()).unwrap().unwrap();
        assert_eq!(resolved.id, "native");
        assert_eq!(resolved.route.model_provider, "openai");
        assert_eq!(
            resolved.route.main_model.as_deref(),
            Some("@preset/rzcodex-main")
        );
        assert_eq!(resolved.route.reasoning_effort, ReasoningEffort::Max);
    }

    #[test]
    fn unknown_route_does_not_replace_current_selection() {
        let home = TempDir::new().unwrap();
        write_catalog(home.path());
        persist_active_subagent_route(home.path(), "native").unwrap();
        let before = std::fs::read_to_string(subagent_route_state_path(home.path())).unwrap();

        assert!(persist_active_subagent_route(home.path(), "missing").is_err());

        let after = std::fs::read_to_string(subagent_route_state_path(home.path())).unwrap();
        assert_eq!(after, before);
    }

    #[test]
    fn parses_local_health_url() {
        assert_eq!(
            HttpTarget::parse("http://127.0.0.1:54548/health")
                .unwrap()
                .path,
            "/health"
        );
        assert!(HttpTarget::parse("http://example.com/health").is_err());
    }

    #[test]
    fn validates_native_fallback_route() {
        let home = TempDir::new().unwrap();
        write_fallback_catalog(home.path(), "native", OPENAI_PROVIDER_ID);

        let auto = resolve_subagent_route(home.path(), "auto").unwrap();
        assert_eq!(auto.route.native_fallback_route.as_deref(), Some("native"));

        write_fallback_catalog(home.path(), "missing", OPENAI_PROVIDER_ID);
        assert!(load_subagent_route_catalog(home.path()).is_err());

        write_fallback_catalog(home.path(), "auto", OPENAI_PROVIDER_ID);
        assert!(load_subagent_route_catalog(home.path()).is_err());

        write_fallback_catalog(home.path(), "native", "bridge");
        assert!(load_subagent_route_catalog(home.path()).is_err());
    }

    #[test]
    fn rejects_empty_main_model_alias() {
        let home = TempDir::new().unwrap();
        std::fs::write(
            home.path().join(SUBAGENT_ROUTE_CATALOG_FILE),
            r#"{
              "routes": {
                "bridge": {
                  "label": "Bridge",
                  "modelProvider": "bridge",
                  "model": "subagent-model",
                  "mainModel": "   ",
                  "reasoningEffort": "high"
                }
              }
            }"#,
        )
        .unwrap();

        assert!(load_subagent_route_catalog(home.path()).is_err());
    }
}
