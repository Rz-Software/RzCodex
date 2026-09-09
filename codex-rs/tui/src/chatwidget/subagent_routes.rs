use super::*;
use codex_config::SubagentRoute;
use codex_config::SubagentRouteCatalog;
use codex_config::load_subagent_route_catalog;
use codex_config::persist_active_subagent_route;
use codex_config::probe_subagent_route;
use codex_config::resolve_active_subagent_route;
use codex_config::resolve_subagent_route;
use std::collections::HashMap;

const MAIN_AGENT_ROUTE_VIEW_ID: &str = "main-agent-route-picker";
const SUBAGENT_ROUTE_VIEW_ID: &str = "subagent-route-picker";

type RouteHealthResults = HashMap<String, Result<String, String>>;

#[derive(Clone, Copy)]
enum RouteHealthDestination {
    MainAgent,
    Subagent,
}

impl ChatWidget {
    pub(crate) fn open_main_agent_route_picker(&mut self) {
        let codex_home = self.config.codex_home.as_ref();
        let catalog = match load_subagent_route_catalog(codex_home) {
            Ok(catalog) => catalog,
            Err(err) => {
                self.add_error_message(format!("Failed to load central provider routes: {err:#}"));
                return;
            }
        };
        let request_id = uuid::Uuid::new_v4();
        self.main_route_health_request_id = Some(request_id);
        self.bottom_pane
            .show_selection_view(self.main_agent_route_picker_params(
                &catalog, /*health*/ None, /*selected*/ None,
            ));
        self.queue_route_health_checks(request_id, &catalog, RouteHealthDestination::MainAgent);
    }

    pub(crate) fn open_subagent_route_picker(&mut self) {
        let codex_home = self.config.codex_home.as_ref();
        let catalog = match load_subagent_route_catalog(codex_home) {
            Ok(catalog) => catalog,
            Err(err) => {
                self.add_error_message(format!("Failed to load central subagent routes: {err:#}"));
                return;
            }
        };
        let active_id = match resolve_active_subagent_route(codex_home) {
            Ok(active) => active.map(|resolved| resolved.id),
            Err(err) => {
                self.add_error_message(format!(
                    "Failed to resolve the active subagent route: {err:#}"
                ));
                return;
            }
        };
        let request_id = uuid::Uuid::new_v4();
        self.subagent_route_health_request_id = Some(request_id);
        self.bottom_pane
            .show_selection_view(self.subagent_route_picker_params(
                &catalog,
                active_id.as_deref(),
                /*health*/ None,
                /*selected*/ None,
            ));
        self.queue_route_health_checks(request_id, &catalog, RouteHealthDestination::Subagent);
    }

    pub(crate) async fn activate_subagent_route(&mut self, route_id: &str) {
        let codex_home = self.config.codex_home.as_ref();
        let selected = match resolve_subagent_route(codex_home, route_id) {
            Ok(selected) => selected,
            Err(err) => {
                self.add_error_message(format!("Subagent route was not changed: {err:#}"));
                return;
            }
        };
        if !self
            .config
            .model_providers
            .contains_key(&selected.route.model_provider)
        {
            self.add_error_message(format!(
                "Subagent route was not changed: provider `{}` is not configured.",
                selected.route.model_provider
            ));
            return;
        }
        let probe_home = codex_home.to_path_buf();
        let probe_route = selected.route.clone();
        let probe =
            tokio::task::spawn_blocking(move || probe_subagent_route(&probe_home, &probe_route))
                .await;
        let probe = match probe {
            Ok(probe) => probe,
            Err(err) => Err(anyhow::anyhow!("health check task failed: {err}")),
        };
        if let Err(err) = probe {
            self.add_error_message(format!(
                "Subagent route `{}` is unavailable; the previous selection was preserved: {err:#}",
                selected.id
            ));
            return;
        }
        if let Err(err) = persist_active_subagent_route(codex_home, &selected.id) {
            self.add_error_message(format!(
                "Failed to save subagent route `{}`; the previous selection was preserved: {err:#}",
                selected.id
            ));
            return;
        }
        self.add_info_message(
            format!(
                "Subagent route changed to `{}` ({} / {} / {}). New children use this route; existing and resumable children keep their original route.",
                selected.id,
                selected.route.model_provider,
                selected.route.model,
                selected.route.reasoning_effort
            ),
            /*hint*/ None,
        );
    }

    pub(crate) fn apply_main_agent_route_health(
        &mut self,
        request_id: uuid::Uuid,
        health: RouteHealthResults,
    ) {
        if self.main_route_health_request_id != Some(request_id) {
            return;
        }
        self.main_route_health_request_id = None;
        let Ok(catalog) = load_subagent_route_catalog(self.config.codex_home.as_ref()) else {
            return;
        };
        let selected = self
            .bottom_pane
            .selected_index_for_active_view(MAIN_AGENT_ROUTE_VIEW_ID);
        let params = self.main_agent_route_picker_params(&catalog, Some(&health), selected);
        let _ = self
            .bottom_pane
            .replace_selection_view_if_active(MAIN_AGENT_ROUTE_VIEW_ID, params);
    }

    pub(crate) fn apply_subagent_route_health(
        &mut self,
        request_id: uuid::Uuid,
        health: RouteHealthResults,
    ) {
        if self.subagent_route_health_request_id != Some(request_id) {
            return;
        }
        self.subagent_route_health_request_id = None;
        let codex_home = self.config.codex_home.as_ref();
        let Ok(catalog) = load_subagent_route_catalog(codex_home) else {
            return;
        };
        let active_id = resolve_active_subagent_route(codex_home)
            .ok()
            .flatten()
            .map(|resolved| resolved.id);
        let selected = self
            .bottom_pane
            .selected_index_for_active_view(SUBAGENT_ROUTE_VIEW_ID);
        let params = self.subagent_route_picker_params(
            &catalog,
            active_id.as_deref(),
            Some(&health),
            selected,
        );
        let _ = self
            .bottom_pane
            .replace_selection_view_if_active(SUBAGENT_ROUTE_VIEW_ID, params);
    }

    fn main_agent_route_picker_params(
        &self,
        catalog: &SubagentRouteCatalog,
        health: Option<&RouteHealthResults>,
        selected: Option<usize>,
    ) -> SelectionViewParams {
        let current_provider = self.config.model_provider_id.as_str();
        let current_model = self.current_model();
        let mut current_index = None;
        let items = catalog
            .routes
            .iter()
            .enumerate()
            .map(|(index, (id, route))| {
                let main_model = route.main_model.as_deref().unwrap_or(&route.model);
                let is_current =
                    route.model_provider == current_provider && main_model == current_model;
                if is_current {
                    current_index = Some(index);
                }
                let (health_summary, disabled_reason) = self.route_health(id, route, health);
                let description = format_main_route_description(route, main_model, health_summary);
                let route_id = id.clone();
                SelectionItem {
                    name: format!("{} ({id})", route.label),
                    description: Some(description),
                    is_current,
                    is_disabled: disabled_reason.is_some(),
                    disabled_reason,
                    actions: vec![Box::new(move |tx| {
                        tx.send(AppEvent::SetMainAgentRoute {
                            route_id: route_id.clone(),
                        });
                    })],
                    dismiss_on_select: true,
                    ..Default::default()
                }
            })
            .collect();
        let mut header = ColumnRenderable::new();
        header.push(Line::from("Select Main-Agent Provider".bold()));
        header.push(Line::from(
            "Switches this conversation and saves the provider, model, effort, and input capabilities as defaults."
                .dim(),
        ));
        SelectionViewParams {
            view_id: Some(MAIN_AGENT_ROUTE_VIEW_ID),
            header: Box::new(header),
            footer_hint: Some(standard_popup_hint_line()),
            items,
            initial_selected_idx: selected.or(current_index),
            ..Default::default()
        }
    }

    fn subagent_route_picker_params(
        &self,
        catalog: &SubagentRouteCatalog,
        active_id: Option<&str>,
        health: Option<&RouteHealthResults>,
        selected: Option<usize>,
    ) -> SelectionViewParams {
        let mut current_index = None;
        let items = catalog
            .routes
            .iter()
            .enumerate()
            .map(|(index, (id, route))| {
                let is_current = active_id == Some(id.as_str());
                if is_current {
                    current_index = Some(index);
                }
                let (health_summary, disabled_reason) = self.route_health(id, route, health);
                let description = format_route_description(route, health_summary);
                let route_id = id.clone();
                SelectionItem {
                    name: format!("{} ({id})", route.label),
                    description: Some(description),
                    is_current,
                    is_disabled: disabled_reason.is_some(),
                    disabled_reason,
                    actions: vec![Box::new(move |tx| {
                        tx.send(AppEvent::SetSubagentRoute {
                            route_id: route_id.clone(),
                        });
                    })],
                    dismiss_on_select: true,
                    ..Default::default()
                }
            })
            .collect();
        let mut header = ColumnRenderable::new();
        header.push(Line::from("Select Native Subagent Route".bold()));
        header.push(Line::from(
            "Applies to new children only; the main session and existing children stay unchanged."
                .dim(),
        ));
        SelectionViewParams {
            view_id: Some(SUBAGENT_ROUTE_VIEW_ID),
            header: Box::new(header),
            footer_hint: Some(standard_popup_hint_line()),
            items,
            initial_selected_idx: selected.or(current_index),
            ..Default::default()
        }
    }

    fn route_health<'a>(
        &self,
        id: &str,
        route: &SubagentRoute,
        health: Option<&'a RouteHealthResults>,
    ) -> (&'a str, Option<String>) {
        if !self
            .config
            .model_providers
            .contains_key(&route.model_provider)
        {
            return (
                "unhealthy",
                Some(format!(
                    "provider `{}` is not configured",
                    route.model_provider
                )),
            );
        }
        if route.health_url.is_none() {
            return ("configured; no health endpoint", None);
        }
        match health.and_then(|health| health.get(id)) {
            Some(Ok(summary)) => (summary, None),
            Some(Err(error)) => ("unhealthy", Some(error.clone())),
            None => (
                "checking health...",
                Some("health check is still pending".to_string()),
            ),
        }
    }

    fn queue_route_health_checks(
        &self,
        request_id: uuid::Uuid,
        catalog: &SubagentRouteCatalog,
        destination: RouteHealthDestination,
    ) {
        let codex_home = self.config.codex_home.to_path_buf();
        let app_event_tx = self.app_event_tx.clone();
        let configured_providers = self
            .config
            .model_providers
            .keys()
            .cloned()
            .collect::<HashSet<_>>();
        let mut checks_by_url: HashMap<String, (SubagentRoute, Vec<String>)> = HashMap::new();
        for (id, route) in &catalog.routes {
            if !configured_providers.contains(&route.model_provider) {
                continue;
            }
            let Some(url) = route.health_url.as_ref() else {
                continue;
            };
            checks_by_url
                .entry(url.clone())
                .and_modify(|(_, ids)| ids.push(id.clone()))
                .or_insert_with(|| (route.clone(), vec![id.clone()]));
        }
        std::mem::drop(tokio::spawn(async move {
            let mut tasks = Vec::with_capacity(checks_by_url.len());
            for (_, (route, ids)) in checks_by_url {
                let codex_home = codex_home.clone();
                tasks.push((
                    ids,
                    tokio::task::spawn_blocking(move || {
                        probe_subagent_route(&codex_home, &route)
                            .map(|probe| probe.summary)
                            .map_err(|err| format!("{err:#}"))
                    }),
                ));
            }
            let mut health = HashMap::new();
            for (ids, task) in tasks {
                let result = match task.await {
                    Ok(result) => result,
                    Err(err) => Err(format!("health check task failed: {err}")),
                };
                for id in ids {
                    health.insert(id, result.clone());
                }
            }
            match destination {
                RouteHealthDestination::MainAgent => {
                    app_event_tx.send(AppEvent::MainAgentRouteHealthLoaded { request_id, health });
                }
                RouteHealthDestination::Subagent => {
                    app_event_tx.send(AppEvent::SubagentRouteHealthLoaded { request_id, health });
                }
            }
        }));
    }
}

fn format_route_description(route: &SubagentRoute, health: &str) -> String {
    let mut description = format!(
        "{} · {} · {} · {health}",
        route.model_provider, route.model, route.reasoning_effort
    );
    if let Some(detail) = route.description.as_deref() {
        description.push_str(" · ");
        description.push_str(detail);
    }
    description
}

fn format_main_route_description(route: &SubagentRoute, main_model: &str, health: &str) -> String {
    let mut description = format!(
        "{} · {} · {} · {health}",
        route.model_provider, main_model, route.reasoning_effort
    );
    if let Some(detail) = route.description.as_deref() {
        description.push_str(" · ");
        description.push_str(detail);
    }
    description
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::openai_models::ReasoningEffort;

    #[test]
    fn route_picker_description_snapshot() {
        let route = SubagentRoute {
            label: "Automatic provider chain".to_string(),
            model_provider: "devin".to_string(),
            model: "@preset/codex-subagents".to_string(),
            main_model: None,
            reasoning_effort: ReasoningEffort::High,
            input_modalities: None,
            description: Some("Devin, then CodeBuddy, then free Devin".to_string()),
            health_url: None,
            health_auth: codex_config::RouteHealthAuth::None,
            native_fallback_route: None,
        };
        insta::assert_snapshot!(
            format_route_description(
                &route,
                "ok · weekly quota reached · codebuddy · hy4-preview"
            ),
            @"devin · @preset/codex-subagents · high · ok · weekly quota reached · codebuddy · hy4-preview · Devin, then CodeBuddy, then free Devin"
        );
    }

    #[test]
    fn main_route_picker_description_snapshot() {
        let route = SubagentRoute {
            label: "Tencent CodeBuddy".to_string(),
            model_provider: "codebuddy".to_string(),
            model: "@preset/codex-subagents".to_string(),
            main_model: Some("@preset/rzcodex-main".to_string()),
            reasoning_effort: ReasoningEffort::Max,
            input_modalities: None,
            description: Some("Locally authenticated CodeBuddy CLI".to_string()),
            health_url: Some("http://127.0.0.1:54547/health".to_string()),
            health_auth: codex_config::RouteHealthAuth::BridgeBearer,
            native_fallback_route: None,
        };
        insta::assert_snapshot!(
            format_main_route_description(
                &route,
                "@preset/rzcodex-main",
                "checking health..."
            ),
            @"codebuddy · @preset/rzcodex-main · max · checking health... · Locally authenticated CodeBuddy CLI"
        );
    }
}
