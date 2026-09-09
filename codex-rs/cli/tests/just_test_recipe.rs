use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;

use anyhow::Context;
use anyhow::Result;
use pretty_assertions::assert_eq;
use tempfile::TempDir;

/// Session/role variables the `just test` recipes must remove so a test run
/// can never reach the developer's real `.codex` state.
const SCRUBBED_ENV_VARS: &[&str] = &[
    "CODEX_SQLITE_HOME",
    "CODEX_SESSION_ID",
    "CODEX_THREAD_ID",
    "RZCODEX_MANAGED_LAUNCH",
    "RZCODEX_SEPARATE_AGENT_ROLES",
];

const STUB_RECORD_ENV: &str = "RZCODEX_JUST_TEST_STUB_RECORD";
const STUB_EXIT_ENV: &str = "RZCODEX_JUST_TEST_STUB_EXIT";
const STUB_EXIT_CODE: i32 = 42;

/// Fake `cargo` that records the arguments and environment the recipe hands
/// down, writes a marker file inside the recipe-provided `CODEX_HOME` so the
/// cleanup assertion exercises a non-empty recursive delete, and models the
/// host pre-build as successful while returning a distinctive status from
/// nextest so exit-code forwarding is observable.
#[cfg(not(windows))]
const CARGO_STUB_NAME: &str = "cargo";

#[cfg(windows)]
const CARGO_STUB_NAME: &str = "cargo.cmd";

#[cfg(not(windows))]
const CARGO_STUB: &str = r#"#!/bin/sh
{
    printf 'invocation=%s\n' "$*"
    printf 'args=%s\n' "$*"
    printf 'codex_home=%s\n' "${CODEX_HOME-}"
    if [ -d "${CODEX_HOME-}" ]; then
        printf 'codex_home_exists=1\n'
    else
        printf 'codex_home_exists=0\n'
    fi
    if [ "${CODEX_SQLITE_HOME+x}" = x ]; then printf 'CODEX_SQLITE_HOME=present\n'; else printf 'CODEX_SQLITE_HOME=unset\n'; fi
    if [ "${CODEX_SESSION_ID+x}" = x ]; then printf 'CODEX_SESSION_ID=present\n'; else printf 'CODEX_SESSION_ID=unset\n'; fi
    if [ "${CODEX_THREAD_ID+x}" = x ]; then printf 'CODEX_THREAD_ID=present\n'; else printf 'CODEX_THREAD_ID=unset\n'; fi
    if [ "${RZCODEX_MANAGED_LAUNCH+x}" = x ]; then printf 'RZCODEX_MANAGED_LAUNCH=present\n'; else printf 'RZCODEX_MANAGED_LAUNCH=unset\n'; fi
    if [ "${RZCODEX_SEPARATE_AGENT_ROLES+x}" = x ]; then printf 'RZCODEX_SEPARATE_AGENT_ROLES=present\n'; else printf 'RZCODEX_SEPARATE_AGENT_ROLES=unset\n'; fi
} >> "$RZCODEX_JUST_TEST_STUB_RECORD"
if [ -n "${CODEX_HOME-}" ] && printf 'marker\n' > "${CODEX_HOME}/stub-marker"; then
    printf 'stub_marker=1\n' >> "$RZCODEX_JUST_TEST_STUB_RECORD"
else
    printf 'stub_marker=0\n' >> "$RZCODEX_JUST_TEST_STUB_RECORD"
fi
if [ "$1" = "build" ]; then
    exit 0
fi
exit "${RZCODEX_JUST_TEST_STUB_EXIT:-0}"
"#;

#[cfg(windows)]
const CARGO_STUB: &str = r#"@echo off
set "record=%RZCODEX_JUST_TEST_STUB_RECORD%"
>> "%record%" echo invocation=%*
>> "%record%" echo args=%*
>> "%record%" echo codex_home=%CODEX_HOME%
if exist "%CODEX_HOME%" (>> "%record%" echo codex_home_exists=1) else (>> "%record%" echo codex_home_exists=0)
if defined CODEX_SQLITE_HOME (>> "%record%" echo CODEX_SQLITE_HOME=present) else (>> "%record%" echo CODEX_SQLITE_HOME=unset)
if defined CODEX_SESSION_ID (>> "%record%" echo CODEX_SESSION_ID=present) else (>> "%record%" echo CODEX_SESSION_ID=unset)
if defined CODEX_THREAD_ID (>> "%record%" echo CODEX_THREAD_ID=present) else (>> "%record%" echo CODEX_THREAD_ID=unset)
if defined RZCODEX_MANAGED_LAUNCH (>> "%record%" echo RZCODEX_MANAGED_LAUNCH=present) else (>> "%record%" echo RZCODEX_MANAGED_LAUNCH=unset)
if defined RZCODEX_SEPARATE_AGENT_ROLES (>> "%record%" echo RZCODEX_SEPARATE_AGENT_ROLES=present) else (>> "%record%" echo RZCODEX_SEPARATE_AGENT_ROLES=unset)
if defined CODEX_HOME (
    >> "%CODEX_HOME%\stub-marker" echo marker
    if exist "%CODEX_HOME%\stub-marker" (>> "%record%" echo stub_marker=1) else (>> "%record%" echo stub_marker=0)
) else (>> "%record%" echo stub_marker=0)
if /I "%1"=="build" exit /b 0
exit /b %RZCODEX_JUST_TEST_STUB_EXIT%
"#;

#[cfg(not(windows))]
fn write_cargo_stub(stub_dir: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let cargo = stub_dir.join(CARGO_STUB_NAME);
    std::fs::write(&cargo, CARGO_STUB)?;
    std::fs::set_permissions(&cargo, std::fs::Permissions::from_mode(0o755))?;
    Ok(())
}

#[cfg(windows)]
fn write_cargo_stub(stub_dir: &Path) -> Result<()> {
    std::fs::write(
        stub_dir.join(CARGO_STUB_NAME),
        CARGO_STUB.replace('\n', "\r\n"),
    )?;
    Ok(())
}

/// The `just test` recipe must build the CodeMode host and MCP stdio helper
/// before running nextest and isolate `CODEX_HOME` so running tests can never
/// mutate the developer's real `.codex` home (an ambient `CODEX_SQLITE_HOME`
/// previously sent `debug clear-memories` to the live memories DB). A stubbed
/// `cargo` on `PATH` proves the recipe's command order, argument forwarding,
/// exit code, and cleanup without compiling the workspace.
#[test]
fn just_test_recipe_isolates_codex_home_and_forwards_args_and_exit() -> Result<()> {
    // This test drives the real justfile, so it only applies to a Cargo
    // checkout with `just` installed; skip under Bazel runfiles or minimal envs.
    let Some(manifest_dir) = std::env::var_os("CARGO_MANIFEST_DIR").map(PathBuf::from) else {
        eprintln!("skipping: CARGO_MANIFEST_DIR not set");
        return Ok(());
    };
    let Some(repo_root) = manifest_dir
        .ancestors()
        .nth(2)
        .map(Path::to_path_buf)
        .filter(|root| root.join("justfile").is_file())
    else {
        eprintln!("skipping: no justfile found above CARGO_MANIFEST_DIR");
        return Ok(());
    };
    let Ok(just) = which::which("just") else {
        eprintln!("skipping: `just` binary not found on PATH");
        return Ok(());
    };

    // `tmp_root` becomes the child process' temp directory so the recipe's
    // fresh CODEX_HOME is provably contained inside it. `ambient` stands in
    // for the developer's real home and must remain untouched.
    let tmp_root = TempDir::new()?;
    let ambient = TempDir::new()?;
    let ambient_home = ambient.path().join("codex-home");
    std::fs::create_dir(&ambient_home)?;
    let ambient_marker = ambient_home.join("memories.db");
    std::fs::write(&ambient_marker, "ambient memories must survive")?;

    let stub_dir = tmp_root.path().join("stub-bin");
    std::fs::create_dir(&stub_dir)?;
    write_cargo_stub(&stub_dir)?;
    let record = tmp_root.path().join("cargo-stub-record.txt");

    let probe_args = ["probe-arg-one", "probe-arg-two"];
    let mut path_entries = vec![stub_dir];
    if let Some(existing) = std::env::var_os("PATH") {
        path_entries.extend(std::env::split_paths(&existing));
    }

    let mut cmd = assert_cmd::Command::new(just);
    cmd.current_dir(&repo_root)
        .arg("test")
        .args(probe_args)
        .env("PATH", std::env::join_paths(path_entries)?)
        .env("CODEX_HOME", &ambient_home)
        .env("TMP", tmp_root.path())
        .env("TEMP", tmp_root.path())
        .env("TMPDIR", tmp_root.path())
        .env(STUB_RECORD_ENV, &record)
        .env(STUB_EXIT_ENV, STUB_EXIT_CODE.to_string());
    for (index, var) in SCRUBBED_ENV_VARS.iter().enumerate() {
        cmd.env(var, format!("ambient-sentinel-{index}"));
    }
    cmd.assert().code(STUB_EXIT_CODE);

    let recorded = std::fs::read_to_string(&record)
        .context("the `just test` recipe never invoked the stubbed `cargo`")?;
    let invocations: Vec<&str> = recorded
        .lines()
        .filter_map(|line| line.strip_prefix("invocation="))
        .collect();
    let mut expected_invocations = vec![
        "build -p codex-code-mode-host -p codex-rmcp-client --bin codex-code-mode-host --bin test_stdio_server".to_string(),
    ];
    expected_invocations.push(format!(
        "nextest run --no-fail-fast {} {}",
        probe_args[0], probe_args[1]
    ));
    assert_eq!(invocations, expected_invocations);

    let fields: BTreeMap<&str, &str> = recorded
        .lines()
        .filter_map(|line| line.split_once('='))
        .collect();

    let forwarded: Vec<&str> = fields
        .get("args")
        .copied()
        .unwrap_or_default()
        .split_whitespace()
        .collect();
    let mut expected: Vec<&str> = vec!["nextest", "run", "--no-fail-fast"];
    expected.extend(probe_args);
    assert_eq!(forwarded, expected);

    let codex_home = PathBuf::from(fields.get("codex_home").copied().unwrap_or_default());
    assert!(
        codex_home.starts_with(tmp_root.path()),
        "CODEX_HOME {codex_home:?} must be a fresh directory inside the test temp root"
    );
    assert!(
        codex_home
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with("codex-tests-")),
        "CODEX_HOME {codex_home:?} must use the recipe's codex-tests-* temp directory"
    );
    assert_ne!(codex_home, ambient_home);
    assert_eq!(fields.get("codex_home_exists").copied(), Some("1"));
    assert_eq!(fields.get("stub_marker").copied(), Some("1"));
    for var in SCRUBBED_ENV_VARS {
        assert_eq!(
            fields.get(var).copied(),
            Some("unset"),
            "{var} leaked into `just test`"
        );
    }

    // The recipe deletes its isolated home (non-empty recursive delete) even
    // though the run failed, and the ambient home is byte-for-byte intact.
    assert!(
        !codex_home.exists(),
        "recipe left its temporary CODEX_HOME behind: {codex_home:?}"
    );
    assert_eq!(
        std::fs::read_to_string(&ambient_marker)?,
        "ambient memories must survive"
    );

    Ok(())
}
