/// The upstream Codex release containing this RzCodex build.
pub use codex_build_info::CLI_VERSION as CODEX_CLI_VERSION;

/// Whether this process was built by the managed RzCodex updater.
#[cfg(not(debug_assertions))]
pub use codex_build_info::IS_MANAGED_RZCODEX_BUILD;

/// Product name shown in user-facing RzCodex surfaces.
pub use codex_build_info::PRODUCT_NAME;
