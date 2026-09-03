use super::*;
use codex_config::SubagentRoute;
use codex_config::load_subagent_route_catalog;
use codex_config::persist_active_subagent_route;
use codex_config::probe_subagent_route;
use codex_config::resolve_active_subagent_route;
use codex_config::resolve_subagent_route;
use std::collections::HashMap;

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
        let current_provider = self.config.model_provider_id.as_str();
        let current_model = self.current_model();
        let items = catalog
            .routes
            .into_iter()
            .map(|(id, route)| {
                let main_model = route.main_model.as_deref().unwrap_or(&route.model);
                let provider_exists = self
                    .config
                    .model_providers
                    .contains_key(&route.model_provider);
                let disabled_reason = (!provider_exists)
                    .then(|| format!("provider `{}` is not configured", route.model_provider));
                let description = format_main_route_description(&route, main_model);
                let route_id = id.clone();
                SelectionItem {
                    name: format!("{} ({id})", route.label),
                    description: Some(description),
                    is_current: route.model_provider == current_provider
                        && main_model == current_model,
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
            "Switches this conversation and saves the provider, model, and effort as defaults."
                .dim(),
        ));
        self.bottom_pane.show_selection_view(SelectionViewParams {
            header: Box::new(header),
            footer_hint: Some(standard_popup_hint_line()),
            items,
            ..Default::default()
        });
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
        let mut health_cache: HashMap<String, Result<String, String>> = HashMap::new();
        let mut initial_selected_idx = None;
        let items = catalog
            .routes
            .into_iter()
            .enumerate()
            .map(|(index, (id, route))| {
                let is_current = active_id.as_deref() == Some(id.as_str());
                if is_current {
                    initial_selected_idx = Some(index);
                }
                let provider_exists = self
                    .config
                    .model_providers
                    .contains_key(&route.model_provider);
                let health = if !provider_exists {
                    Err(format!(
                        "provider `{}` is not configured",
                        route.model_provider
                    ))
                } else if let Some(url) = route.health_url.as_deref() {
                    health_cache
                        .entry(url.to_string())
                        .or_insert_with(|| {
                            probe_subagent_route(&route)
                                .map(|probe| probe.summary)
                                .map_err(|err| format!("{err:#}"))
                        })
                        .clone()
                } else {
                    Ok("configured; no health endpoint".to_string())
                };
                let disabled_reason = health.as_ref().err().cloned();
                let health_summary = health.as_deref().unwrap_or("unavailable");
                let description = format_route_description(&route, health_summary);
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
        self.bottom_pane.show_selection_view(SelectionViewParams {
            header: Box::new(header),
            footer_hint: Some(standard_popup_hint_line()),
            items,
            initial_selected_idx,
            ..Default::default()
        });
    }

    pub(crate) fn activate_subagent_route(&mut self, route_id: &str) {
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
        if let Err(err) = probe_subagent_route(&selected.route) {
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

fn format_main_route_description(route: &SubagentRoute, main_model: &str) -> String {
    let mut description = format!(
        "{} · {} · {}",
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
            native_fallback_route: None,
        };
        insta::assert_snapshot!(
            format_main_route_description(&route, "@preset/rzcodex-main"),
            @"codebuddy · @preset/rzcodex-main · max · Locally authenticated CodeBuddy CLI"
        );
    }
}
