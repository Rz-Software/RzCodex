use anyhow::Context;
use clap::Args;
use clap::Subcommand;
use codex_config::load_subagent_route_catalog;
use codex_config::persist_active_subagent_route;
use codex_config::probe_subagent_route;
use codex_config::resolve_active_subagent_route;
use codex_config::resolve_subagent_route;
use codex_core::config::ConfigBuilder;
use codex_core::config::find_codex_home;
use codex_utils_cli::CliConfigOverrides;

#[derive(Debug, Args)]
pub(crate) struct SubagentsCommand {
    #[command(subcommand)]
    command: SubagentsSubcommand,
}

#[derive(Debug, Subcommand)]
enum SubagentsSubcommand {
    /// Show the route used by newly spawned native subagents.
    Status,
    /// List all centrally configured routes and their health.
    List,
    /// Select the route used by all newly spawned native subagents.
    Use {
        /// Route id from subagent-models.json (for example: auto, native, or codebuddy).
        route: String,
    },
}

pub(crate) async fn run(
    command: SubagentsCommand,
    root_config_overrides: &CliConfigOverrides,
) -> anyhow::Result<()> {
    let codex_home = find_codex_home()?;
    let config = ConfigBuilder::default()
        .codex_home(codex_home.to_path_buf())
        .cli_overrides(
            root_config_overrides
                .parse_overrides()
                .map_err(anyhow::Error::msg)?,
        )
        .build()
        .await
        .context("failed to load Codex model providers")?;

    match command.command {
        SubagentsSubcommand::Status => {
            let Some(active) = resolve_active_subagent_route(&codex_home)? else {
                println!(
                    "Managed subagent routing is disabled (stock role/default routing applies)."
                );
                return Ok(());
            };
            ensure_provider_exists(&config, &active.id, &active.route.model_provider)?;
            print_route(&active.id, &active.route, /*active*/ true);
        }
        SubagentsSubcommand::List => {
            let catalog = load_subagent_route_catalog(&codex_home)?;
            let active_id = resolve_active_subagent_route(&codex_home)?.map(|resolved| resolved.id);
            for (id, route) in catalog.routes {
                let active = active_id.as_deref() == Some(id.as_str());
                print_route_with_provider_state(
                    &id,
                    &route,
                    active,
                    config.model_providers.contains_key(&route.model_provider),
                );
            }
        }
        SubagentsSubcommand::Use { route } => {
            let route_id = route.trim().to_ascii_lowercase();
            let selected = resolve_subagent_route(&codex_home, &route_id)?;
            ensure_provider_exists(&config, &selected.id, &selected.route.model_provider)?;
            let probe = probe_subagent_route(&selected.route).with_context(|| {
                format!(
                    "subagent route `{}` is unavailable; previous selection was preserved",
                    selected.id
                )
            })?;
            persist_active_subagent_route(&codex_home, &selected.id)?;
            println!("New native subagents will use:");
            print_route_metadata(&selected.id, &selected.route, /*active*/ true);
            println!("    health={}", probe.summary);
            print_route_description(&selected.route);
            println!("Existing and resumable subagents keep their original route.");
        }
    }
    Ok(())
}

fn ensure_provider_exists(
    config: &codex_core::config::Config,
    route_id: &str,
    provider_id: &str,
) -> anyhow::Result<()> {
    if config.model_providers.contains_key(provider_id) {
        return Ok(());
    }
    anyhow::bail!(
        "subagent route `{route_id}` references missing model provider `{provider_id}`; previous selection was preserved"
    )
}

fn print_route(id: &str, route: &codex_config::SubagentRoute, active: bool) {
    print_route_with_provider_state(id, route, active, /*provider_exists*/ true);
}

fn print_route_with_provider_state(
    id: &str,
    route: &codex_config::SubagentRoute,
    active: bool,
    provider_exists: bool,
) {
    print_route_metadata(id, route, active);
    if !provider_exists {
        println!("    health=invalid: provider is not configured");
        return;
    }
    match probe_subagent_route(route) {
        Ok(probe) => println!("    health={}", probe.summary),
        Err(err) => println!("    health=unavailable: {err:#}"),
    }
    print_route_description(route);
}

fn print_route_metadata(id: &str, route: &codex_config::SubagentRoute, active: bool) {
    let marker = if active { "*" } else { " " };
    println!("{marker} {id}: {}", route.label);
    println!(
        "    provider={} model={} reasoning={}",
        route.model_provider, route.model, route.reasoning_effort
    );
}

fn print_route_description(route: &codex_config::SubagentRoute) {
    if let Some(description) = route.description.as_deref() {
        println!("    {description}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[derive(Parser)]
    struct TestCli {
        #[command(subcommand)]
        command: TestCommand,
    }

    #[derive(Subcommand)]
    enum TestCommand {
        Subagents(SubagentsCommand),
    }

    #[test]
    fn parses_route_selection() {
        let cli = TestCli::try_parse_from(["test", "subagents", "use", "native"]).unwrap();
        let TestCommand::Subagents(command) = cli.command;
        assert!(matches!(
            command.command,
            SubagentsSubcommand::Use { route } if route == "native"
        ));
    }
}
