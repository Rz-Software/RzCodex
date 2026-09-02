mod agent_role_config;
mod discovery;
mod loader;

pub use agent_role_config::AgentRoleConfig;
pub use agent_role_config::ResolvedAgentRoleFile;
pub use agent_role_config::parse_agent_role_file_contents;
pub use loader::agent_roles_directory_for_config_folder;
pub use loader::load_agent_roles;
