import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AUTHENTICATED_HEALTH_ROUTES,
  BRIDGE_PROVIDER_IDS,
  migrateProviderAuthToml,
  migrateRouteHealthAuth,
} from "./rzcodex-config-migrate.mjs";
import { exitWhenParentStops } from "./bridge-lifecycle.mjs";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptsRoot);
const modulePath = join(scriptsRoot, "rzcodex-deployment.psm1");
const bridgeSupervisorPath = join(scriptsRoot, "rzcodex-bridge-supervisor.ps1");
const setupPath = join(scriptsRoot, "rzcodex-setup.ps1");
const updaterPath = join(scriptsRoot, "rzcodex-update.ps1");
const manifest = JSON.parse(readFileSync(join(scriptsRoot, "rzcodex-setup.manifest.json"), "utf8"));
const defaultRoutes = JSON.parse(readFileSync(join(scriptsRoot, manifest.routing.defaultFile), "utf8"));

function runPowerShell(source, arguments_ = []) {
  const result = invokePowerShellFile(source, arguments_);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function runPowerShellFailure(source, arguments_, expectedMessage) {
  const result = invokePowerShellFile(source, arguments_);
  assert.notEqual(result.status, 0, "PowerShell fixture unexpectedly succeeded");
  assert.match(`${result.stderr}\n${result.stdout}`, new RegExp(expectedMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  return result;
}

function invokePowerShellFile(source, arguments_ = []) {
  const harnessRoot = mkdtempSync(join(tmpdir(), "rzcodex-pwsh-harness-"));
  const harnessPath = join(harnessRoot, "fixture.ps1");
  try {
    writeFileSync(harnessPath, [
      "Set-StrictMode -Version Latest",
      '$ErrorActionPreference = "Stop"',
      source,
      "",
    ].join("\n"), "utf8");
    return spawnSync("pwsh", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      harnessPath,
      ...arguments_,
    ], {
      encoding: "utf8",
      windowsHide: true,
    });
  } finally {
    rmSync(harnessRoot, { recursive: true, force: true });
  }
}

function parseToml(contents) {
  const result = spawnSync("python", ["-c", [
    "import json, sys, tomllib",
    "print(json.dumps(tomllib.loads(sys.stdin.read()), sort_keys=True))",
  ].join("; ")], { input: contents, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function configFixture(newline) {
  const lines = [
    'model = "native"',
    "[projects.'C:\\Work\\Quoted Project']",
    'trust_level = "trusted"',
    '[plugins."browser@example"] # quoted plugin table',
    "enabled = true",
    "[[hooks.Stop]]",
    'name = "stop"',
    "[[hooks.Stop.hooks]]",
    'type = "command"',
    'command_windows = "Write-Output stopped"',
  ];
  for (const provider of BRIDGE_PROVIDER_IDS) {
    lines.push(
      `[model_providers.${provider}] # managed base`,
      `name = "${provider}"`,
      `base_url = "http://127.0.0.1/${provider}"`,
      `env_key = "${provider.toUpperCase()}_TOKEN"`,
      `[model_providers.${provider}.auth] # replaced exactly`,
      'command = "legacy-reader"',
      'args = ["legacy"]',
    );
  }
  lines.push("[model_providers.openai]", 'env_key = "OPENAI_API_KEY"', "");
  return lines.join(newline);
}

function withoutManagedAuth(config) {
  const copy = structuredClone(config);
  for (const provider of BRIDGE_PROVIDER_IDS) {
    delete copy.model_providers[provider].env_key;
    delete copy.model_providers[provider].experimental_bearer_token;
    delete copy.model_providers[provider].auth;
  }
  return copy;
}

test("manifest file references are complete and remain inside scripts", () => {
  for (const fileName of manifest.stableLauncherFiles) {
    assert.equal(fileName.includes("/") || fileName.includes("\\"), false);
    assert.equal(existsSync(join(scriptsRoot, fileName)), true, `missing stable launcher file ${fileName}`);
  }
  for (const relativePath of manifest.deploymentFiles) {
    assert.match(relativePath, /^scripts\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
    assert.equal(existsSync(join(repoRoot, relativePath)), true, `missing deployment file ${relativePath}`);
  }
});

test("bridge tasks use a compiled winexe bootstrap that spawns PowerShell without a visible console", () => {
  const setupSource = readFileSync(setupPath, "utf8");
  const taskRegistrationStart = setupSource.indexOf("$currentUser =");
  const taskRegistrationEnd = setupSource.indexOf("$deploymentState =", taskRegistrationStart);
  assert.equal(taskRegistrationStart >= 0 && taskRegistrationEnd > taskRegistrationStart, true);
  assert.doesNotMatch(
    setupSource.slice(taskRegistrationStart, taskRegistrationEnd),
    /wscript|\.vbs/i,
    "new scheduled-task actions must not restore the legacy VBS launch path",
  );
  assert.doesNotMatch(
    setupSource,
    /-WindowStyle Hidden/,
    "scheduled tasks must no longer rely on post-start window hiding",
  );
  assert.doesNotMatch(
    setupSource.slice(taskRegistrationStart, taskRegistrationEnd),
    /New-ScheduledTaskAction[\s\S]{0,300}-Execute \$taskPowerShellPath/,
    "scheduled tasks must not launch pwsh directly",
  );
  assert.match(
    setupSource,
    /\$taskPowerShellPath\s*=\s*\(Get-Command pwsh\b/,
    "scheduled actions must still resolve the pwsh path for the bootstrap",
  );
  assert.match(
    setupSource,
    /\$bridgeLauncherPath\s*=\s*Join-Path\s+\$launcherRoot\s+"codex-bridge-launcher\.exe"/,
    "setup must resolve the compiled bridge launcher path",
  );
  assert.match(
    setupSource,
    /New-ScheduledTaskAction[\s\S]{0,300}-Execute \$bridgeLauncherPath/,
    "bridge and updater tasks must execute the compiled bridge launcher",
  );
  assert.match(
    setupSource,
    /\/target:winexe/,
    "setup must compile the bridge launcher as a Windows-subsystem (winexe) executable",
  );

  assert.equal(
    manifest.stableLauncherFiles.includes("rzcodex-bridge-launcher.cs"),
    true,
    "bridge launcher source must be versioned in the stable launcher",
  );
  assert.equal(
    manifest.deploymentFiles.includes("scripts/rzcodex-bridge-launcher.cs"),
    true,
    "bridge launcher source must be versioned in the deployment manifest",
  );

  const manifestFiles = [...manifest.stableLauncherFiles, ...manifest.deploymentFiles];
  assert.equal(
    manifestFiles.some((fileName) => /\.vbs$/i.test(fileName)),
    false,
    "the removed VBS wrappers must not be installed or retained",
  );
  for (const [bridgeName, bridge] of Object.entries(manifest.bridges)) {
    assert.deepEqual(
      bridge.arguments,
      ["--exit-with-parent"],
      `${bridgeName} must terminate when its task-owned PowerShell parent stops`,
    );
  }
});

test("bridge launcher compiles and forwards child exit codes", { skip: process.platform !== "win32" }, () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "rzcodex-bridge-launcher-"));
  try {
    const cscPath = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
    const sourcePath = join(scriptsRoot, "rzcodex-bridge-launcher.cs");
    const exePath = join(fixtureRoot, "codex-bridge-launcher.exe");
    const csc = spawnSync(cscPath, ["/nologo", "/target:winexe", `/out:${exePath}`, sourcePath], { encoding: "utf8", windowsHide: true });
    assert.equal(csc.status, 0, csc.stderr || csc.stdout);

    const noArgs = spawnSync(exePath, [], { windowsHide: true });
    assert.equal(noArgs.status, 3, "no arguments must exit 3");

    const cmdPath = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
    const child = spawnSync(exePath, [cmdPath, "/c", "exit 23"], { windowsHide: true });
    assert.equal(child.status, 23, "child exit code must be forwarded");

    const missing = spawnSync(exePath, ["C:\\No\\Such\\Executable.exe"], { windowsHide: true });
    assert.equal(missing.status, 5, "missing child executable must exit 5");
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("bridge parent binding arms only on request and exits after the captured parent stops", () => {
  const originalArguments = [...process.argv];
  const originalKill = process.kill;
  const originalExit = process.exit;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let poll = null;
  let intervalMilliseconds = null;
  let timerUnrefCount = 0;
  let clearedTimer = null;
  let killChecks = 0;
  const exits = [];
  const fixtureTimer = { unref: () => { timerUnrefCount += 1; } };
  try {
    globalThis.setInterval = (callback, milliseconds) => {
      poll = callback;
      intervalMilliseconds = milliseconds;
      return fixtureTimer;
    };
    globalThis.clearInterval = (timer) => { clearedTimer = timer; };
    process.kill = (processId, signal) => {
      assert.equal(processId, process.ppid);
      assert.equal(signal, 0);
      killChecks += 1;
      if (killChecks > 1) throw new Error("fixture parent exited");
      return true;
    };
    process.exit = (exitCode) => { exits.push(exitCode); };

    process.argv = process.argv.filter((argument) => argument !== "--exit-with-parent");
    exitWhenParentStops();
    assert.equal(poll, null, "bridge lifecycle armed without --exit-with-parent");

    process.argv.push("--exit-with-parent");
    exitWhenParentStops();
    assert.equal(typeof poll, "function", "bridge lifecycle did not arm its parent poll");
    assert.equal(intervalMilliseconds, 250);
    assert.equal(timerUnrefCount, 1, "the parent poll must not keep an otherwise finished bridge alive");
    poll();
    assert.deepEqual(exits, [], "the bridge exited while its captured parent was still alive");
    poll();
    assert.equal(clearedTimer, fixtureTimer, "the stopped-parent poll was not cleared");
    assert.deepEqual(exits, [0], "the bridge did not exit successfully after its parent stopped");
  } finally {
    process.argv = originalArguments;
    process.kill = originalKill;
    process.exit = originalExit;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("deployment manifest satisfies its PowerShell JSON schema", () => {
  runPowerShell([
    "$json = Get-Content -LiteralPath $args[0] -Raw",
    "if (-not ($json | Test-Json -SchemaFile $args[1])) { throw 'manifest schema validation failed' }",
  ].join("; "), [
    join(scriptsRoot, "rzcodex-setup.manifest.json"),
    join(scriptsRoot, "rzcodex-setup.schema.json"),
  ]);
});

test("bridge bearer token ACL is sandbox-protected and idempotent", { skip: process.platform !== "win32" }, () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "rzcodex-bridge-token-acl-"));
  try {
    const tokenPath = join(fixtureRoot, "bearer-token");
    writeFileSync(tokenPath, "fixture-token\n", "utf8");
    runPowerShell([
      "Import-Module $args[0] -Force",
      "$acl = Get-Acl -LiteralPath $args[1]",
      "$everyoneSid = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')",
      "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyoneSid, [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.AccessControlType]::Allow))",
      "Set-Acl -LiteralPath $args[1] -AclObject $acl",
      "Protect-RzCodexBridgeBearerToken -Path $args[1]",
      "$firstSddl = (Get-Acl -LiteralPath $args[1]).Sddl",
      "Protect-RzCodexBridgeBearerToken -Path $args[1]",
      "$acl = Get-Acl -LiteralPath $args[1]",
      "if (-not $acl.AreAccessRulesProtected) { throw 'bridge bearer token ACL still inherits from CODEX_HOME' }",
      "if ($firstSddl -ne $acl.Sddl) { throw 'repeated bridge bearer token ACL protection is not idempotent' }",
      "$expectedSids = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, ([Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::LocalSystemSid, $null)).Value, ([Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)).Value) | Sort-Object",
      "$actualSids = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object)",
      "if (($actualSids -join ',') -ne ($expectedSids -join ',')) { throw \"bridge bearer token ACL principals were not reduced to current user/SYSTEM/Administrators: $($actualSids -join ',')\" }",
      "foreach ($rule in @($acl.Access)) { if ($rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or [int]$rule.FileSystemRights -ne [int][Security.AccessControl.FileSystemRights]::FullControl) { throw 'bridge bearer token ACL contains a noncanonical rule' } }",
      "if ([IO.File]::ReadAllText($args[1]) -ne ('fixture-token' + [char]10)) { throw 'bridge bearer token content changed' }",
    ].join("\n"), [modulePath, tokenPath]);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("setup hardens the bridge token before committing configuration", () => {
  const setupSource = readFileSync(setupPath, "utf8");
  const tokenSetupIndex = setupSource.indexOf("& $node.Source $tokenSetupPath");
  const tokenProtectionIndex = setupSource.indexOf("Protect-RzCodexBridgeBearerToken -Path $bridgeTokenPath");
  const configActivationIndex = setupSource.indexOf("Copy-AtomicFile -Source $temporaryConfigPath -Destination $configPath");
  assert.equal(tokenSetupIndex >= 0 && tokenSetupIndex < tokenProtectionIndex, true);
  assert.equal(tokenProtectionIndex < configActivationIndex, true);
  assert.match(setupSource, /failed setup must[\s\S]{0,120}never restore an inherited ACL/);
});

test("route migration preserves every value except managed healthAuth", () => {
  const before = structuredClone(defaultRoutes);
  const after = JSON.parse(migrateRouteHealthAuth(JSON.stringify(before)));
  for (const routeName of AUTHENTICATED_HEALTH_ROUTES) assert.equal(after.routes[routeName].healthAuth, "bridgeBearer");
  assert.equal(after.routes.ollama.healthAuth, "none");
  for (const routeName of [...AUTHENTICATED_HEALTH_ROUTES, "ollama"]) {
    delete before.routes[routeName].healthAuth;
    delete after.routes[routeName].healthAuth;
  }
  assert.deepEqual(after, before);
});

for (const newline of ["\n", "\r\n"]) {
  test(`provider migration preserves nonmanaged TOML semantics with ${JSON.stringify(newline)} newlines`, () => {
    const beforeText = configFixture(newline);
    const tokenScript = "C:\\Users\\O'Brien\\RzCodex\\rzcodex-bridge-auth-token.mjs";
    const afterText = migrateProviderAuthToml(beforeText, tokenScript);
    const before = parseToml(beforeText);
    const after = parseToml(afterText);
    assert.deepEqual(withoutManagedAuth(after), withoutManagedAuth(before));
    for (const provider of BRIDGE_PROVIDER_IDS) {
      assert.equal(after.model_providers[provider].auth.command, "node");
      assert.deepEqual(after.model_providers[provider].auth.args, [tokenScript]);
      assert.equal(after.model_providers[provider].auth.cwd, dirname(tokenScript));
      assert.equal("env_key" in after.model_providers[provider], false);
    }
  });
}

test("provider migration rejects duplicate and quoted managed base tables", () => {
  const fixture = configFixture("\n");
  assert.throws(
    () => migrateProviderAuthToml(`${fixture}\n[model_providers.opencode]\nname = "duplicate"\n`, "C:\\token.mjs"),
    /duplicate managed provider section/,
  );
  assert.throws(
    () => migrateProviderAuthToml(fixture.replace("[model_providers.opencode]", '[model_providers."opencode"]'), "C:\\token.mjs"),
    /quoted managed provider section/,
  );
});

test("pointer switch commits success and restores or removes on injected failure", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "rzcodex-pointer-"));
  try {
    const pointerPath = join(fixtureRoot, "current.txt");
    writeFileSync(pointerPath, "old.exe", "utf8");
    runPowerShell([
      "Import-Module $args[0] -Force",
      "$result = Switch-RzCodexCurrentPointer -PointerPath $args[1] -NewBinaryPath 'new.exe' -PostActivationCheck { param($pointer, $expected); if ([IO.File]::ReadAllText($pointer) -ne $expected) { throw 'pointer mismatch' } }",
      "if ($result.PreviousBinaryPath -ne 'old.exe') { throw 'previous pointer was not returned' }",
    ].join("; "), [modulePath, pointerPath]);
    assert.equal(readFileSync(pointerPath, "utf8"), "new.exe");

    runPowerShellFailure([
      "Import-Module $args[0] -Force",
      "Switch-RzCodexCurrentPointer -PointerPath $args[1] -NewBinaryPath 'bad.exe' -PostActivationCheck { throw 'injected smoke failure' }",
    ].join("; "), [modulePath, pointerPath], "injected smoke failure");
    assert.equal(readFileSync(pointerPath, "utf8"), "new.exe");

    rmSync(pointerPath);
    runPowerShellFailure([
      "Import-Module $args[0] -Force",
      "Switch-RzCodexCurrentPointer -PointerPath $args[1] -NewBinaryPath 'bad.exe' -PostActivationCheck { throw 'injected first-install failure' }",
    ].join("; "), [modulePath, pointerPath], "injected first-install failure");
    assert.equal(existsSync(pointerPath), false);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("exclusive deployment lock rejects contention and releases cleanly", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "rzcodex-lock-"));
  try {
    runPowerShell([
      "Import-Module $args[0] -Force",
      "$first = Open-RzCodexDeploymentLock -Path $args[1]",
      "$contended = $false",
      "try { $second = Open-RzCodexDeploymentLock -Path $args[1] } catch { $contended = $true }",
      "if (-not $contended) { throw 'lock contention was accepted' }",
      "$first.Dispose()",
      "$third = Open-RzCodexDeploymentLock -Path $args[1]",
      "$third.Dispose()",
    ].join("; "), [modulePath, join(fixtureRoot, "update.lock")]);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("User PATH migration prepends one launcher entry without collapsing existing entries", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "rzcodex-user-path-"));
  try {
    const launcher = join(fixtureRoot, "launcher");
    const first = join(fixtureRoot, "one");
    const second = join(fixtureRoot, "two");
    const migrated = runPowerShell([
      "Import-Module $args[0] -Force",
      "Get-RzCodexPrependedUserPath -LauncherRoot $args[1] -ExistingPath $args[2]",
    ].join("; "), [modulePath, launcher, `${first};${launcher};${second}`]);
    assert.equal(migrated, `${launcher};${first};${second}`);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("managed build validation detects file corruption and exact-set drift", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "rzcodex-integrity-"));
  try {
    runPowerShell([
      "Import-Module $args[0] -Force",
      "$install = $args[1]",
      "$build = Join-Path $install 'builds\\fixture'",
      "New-Item -ItemType Directory -Path (Join-Path $build 'scripts') -Force | Out-Null",
      "[IO.File]::WriteAllText((Join-Path $build 'codex.exe'), 'binary')",
      "[IO.File]::WriteAllText((Join-Path $build 'scripts\\owned.ps1'), 'script')",
      "$records = @('codex.exe','scripts/owned.ps1') | ForEach-Object { $path = Join-Path $build $_; [pscustomobject][ordered]@{ path = $_; size = (Get-Item $path).Length; sha256 = (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant() } }",
      "$recordJson = ConvertTo-Json -InputObject @($records | Sort-Object path) -Depth 4 -Compress",
      "$aggregate = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($recordJson))).ToLowerInvariant()",
      "$metadata = [ordered]@{ activationState='complete'; sourceId='fixture'; aggregateSha256=$aggregate; files=@($records | Sort-Object path) }",
      "[IO.File]::WriteAllText((Join-Path $build 'rzcodex-build.json'), (($metadata | ConvertTo-Json -Depth 5) + [Environment]::NewLine))",
      "$pointer = Join-Path $install 'current.txt'",
      "[IO.File]::WriteAllText($pointer, (Join-Path $build 'codex.exe'))",
      "$resolved = Resolve-RzCodexManagedBuild -InstallRoot $install -PointerPath $pointer -ExpectedRelativePaths @('codex.exe','scripts/owned.ps1')",
      "if ($resolved.Metadata.sourceId -ne 'fixture') { throw 'valid build did not resolve' }",
      "$setRejected = $false",
      "try { Resolve-RzCodexManagedBuild -InstallRoot $install -PointerPath $pointer -ExpectedRelativePaths @('codex.exe') } catch { $setRejected = $true }",
      "if (-not $setRejected) { throw 'exact-set drift was accepted' }",
      "[IO.File]::AppendAllText((Join-Path $build 'scripts\\owned.ps1'), 'corrupt')",
      "$corruptionRejected = $false",
      "try { Resolve-RzCodexManagedBuild -InstallRoot $install -PointerPath $pointer } catch { $corruptionRejected = $true }",
      "if (-not $corruptionRejected) { throw 'corruption was accepted' }",
    ].join("; "), [modulePath, fixtureRoot]);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("immutable snapshot preserves owned changes, fingerprints mutations, and cleans its worktree", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "rzcodex-snapshot-"));
  let snapshotRoot;
  try {
    snapshotRoot = mkdtempSync(join(tmpdir(), "RzC-"));
    const fixtureRepo = join(fixtureRoot, "repo");
    const stateRoot = join(fixtureRoot, "state");
    mkdirSync(fixtureRepo, { recursive: true });
    mkdirSync(stateRoot, { recursive: true });

    const longRelativePath = [
      "deep",
      ...Array.from({ length: 10 }, (_, index) => `seg-${String(index).padStart(9, "0")}`),
      "owned-long-file.txt",
    ].join("/");
    const longFilePath = join(fixtureRepo, ...longRelativePath.split("/"));
    mkdirSync(dirname(longFilePath), { recursive: true });

    const runGit = (...arguments_) => {
      const result = spawnSync("git", ["-C", fixtureRepo, ...arguments_], {
        encoding: "utf8",
        windowsHide: true,
      });
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      return result.stdout.trim();
    };

    writeFileSync(join(fixtureRepo, "tracked.txt"), "base tracked\n", "utf8");
    writeFileSync(join(fixtureRepo, "deleted.txt"), "base deleted\n", "utf8");
    writeFileSync(longFilePath, "base long\n", "utf8");
    runGit("init", "-q");
    runGit("config", "user.email", "rzcodex-test@example.invalid");
    runGit("config", "user.name", "RzCodex test");
    runGit("add", "--", "tracked.txt", "deleted.txt", longRelativePath);
    runGit("commit", "-qm", "fixture base");
    const baseCommit = runGit("rev-parse", "HEAD");

    writeFileSync(join(fixtureRepo, "tracked.txt"), "local tracked\n", "utf8");
    writeFileSync(longFilePath, "local long\n", "utf8");
    rmSync(join(fixtureRepo, "deleted.txt"));
    mkdirSync(join(fixtureRepo, "local"), { recursive: true });
    writeFileSync(join(fixtureRepo, "local", "new.txt"), "local untracked\n", "utf8");

    const snapshotScript = [
      "$source = Get-Content -LiteralPath $args[0] -Raw",
      "$tokens = $null; $parseErrors = $null",
      "$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)",
      "if (@($parseErrors).Count -ne 0) { throw 'updater parse failed' }",
      "$functionNames = @('Get-StringHash','Invoke-NativeCommand','Get-GitText','New-DetachedSnapshot','Copy-OwnedFilesToSnapshot','Get-SnapshotFingerprint','Remove-DetachedSnapshot')",
      "foreach ($functionName in $functionNames) { $functionAst = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName }, $true); if ($null -eq $functionAst) { throw \"missing updater function: $functionName\" }; . ([scriptblock]::Create($functionAst.Extent.Text)) }",
      "$RepoRoot = $args[1]; $SnapshotRoot = $args[2]; $StateRoot = $args[3]; $baseCommit = $args[4]",
      "$SnapshotPath = New-DetachedSnapshot -Commit $baseCommit",
      "if ($SnapshotPath -isnot [string]) { throw \"New-DetachedSnapshot returned $($SnapshotPath.GetType().FullName), expected one string path\" }",
      "$expectedSnapshotPath = [IO.Path]::GetFullPath((Join-Path $SnapshotRoot 'worktree'))",
      "if ([IO.Path]::GetFullPath($SnapshotPath) -ne $expectedSnapshotPath) { throw \"snapshot path was not the deterministic managed worktree path: $SnapshotPath\" }",
      "$firstSnapshotPath = [IO.Path]::GetFullPath($SnapshotPath)",
      "$removed = $false",
      "try {",
      "  $staleCreationFailed = $false",
      "  try { $null = New-DetachedSnapshot -Commit $baseCommit } catch { $staleCreationFailed = $true; if ($_.Exception.Message -notmatch 'already') { throw } }",
      "  if (-not $staleCreationFailed) { throw 'stale snapshot creation was not rejected while the managed worktree was active' }",
      "  $cleanFingerprint = Get-SnapshotFingerprint -SnapshotPath $SnapshotPath -BaseCommit $baseCommit",
      "  $files = @([pscustomobject]@{ RelativePath='tracked.txt'; AbsolutePath=(Join-Path $RepoRoot 'tracked.txt') }, [pscustomobject]@{ RelativePath='deleted.txt'; AbsolutePath=(Join-Path $RepoRoot 'deleted.txt') }, [pscustomobject]@{ RelativePath='local/new.txt'; AbsolutePath=(Join-Path $RepoRoot 'local/new.txt') }, [pscustomobject]@{ RelativePath=$args[5]; AbsolutePath=(Join-Path $RepoRoot $args[5]) })",
      "  $copyOutput = @(Copy-OwnedFilesToSnapshot -Files $files -SnapshotPath $SnapshotPath)",
      "  if ($copyOutput.Count -ne 0) { throw 'owned file copy leaked command output' }",
      "  if ([IO.File]::ReadAllText((Join-Path $SnapshotPath 'tracked.txt')).Trim() -ne 'local tracked') { throw 'tracked owned content was not copied' }",
      "  $longSnapshotPath = [IO.Path]::GetFullPath((Join-Path $SnapshotPath $args[5]))",
      "  if ($longSnapshotPath.Length -ge 260) { throw \"long owned path exceeded the Windows legacy path budget: $($longSnapshotPath.Length)\" }",
      "  if ([IO.File]::ReadAllText($longSnapshotPath).Trim() -ne 'local long') { throw 'long tracked owned content was not copied' }",
      "  if (Test-Path -LiteralPath (Join-Path $SnapshotPath 'deleted.txt')) { throw 'deleted owned file remained in snapshot' }",
      "  if ([IO.File]::ReadAllText((Join-Path $SnapshotPath 'local/new.txt')).Trim() -ne 'local untracked') { throw 'untracked owned content was not copied' }",
      "  $dirtyFingerprint = Get-SnapshotFingerprint -SnapshotPath $SnapshotPath -BaseCommit $baseCommit",
      "  if ($dirtyFingerprint -eq $cleanFingerprint) { throw 'owned changes did not alter snapshot fingerprint' }",
      "  [IO.File]::AppendAllText((Join-Path $SnapshotPath 'local/new.txt'), \"changed$([char]10)\")",
      "  $changedFingerprint = Get-SnapshotFingerprint -SnapshotPath $SnapshotPath -BaseCommit $baseCommit",
      "  if ($changedFingerprint -eq $dirtyFingerprint) { throw 'untracked mutation did not alter snapshot fingerprint' }",
      "  [IO.File]::WriteAllText((Join-Path $SnapshotPath 'local/new.txt'), \"local untracked$([char]10)\")",
      "  if ((Get-SnapshotFingerprint -SnapshotPath $SnapshotPath -BaseCommit $baseCommit) -ne $dirtyFingerprint) { throw 'fingerprint was not deterministic after restoring content' }",
      "  [IO.File]::AppendAllText((Join-Path $SnapshotPath 'tracked.txt'), \"changed$([char]10)\")",
      "  if ((Get-SnapshotFingerprint -SnapshotPath $SnapshotPath -BaseCommit $baseCommit) -eq $dirtyFingerprint) { throw 'tracked mutation did not alter snapshot fingerprint' }",
      "  $cleanupOutput = @(Remove-DetachedSnapshot -SnapshotPath $SnapshotPath)",
      "  if ($cleanupOutput.Count -ne 0) { throw 'snapshot cleanup leaked command output' }",
      "  $removed = $true",
      "  if (Test-Path -LiteralPath $SnapshotPath) { throw 'snapshot worktree remained after cleanup' }",
      "  $worktreeListing = Get-GitText -WorkingDirectory $RepoRoot -ArgumentList @('worktree', 'list', '--porcelain')",
      "  $registeredPaths = @($worktreeListing -split \"`r?`n\" | Where-Object { $_ -like 'worktree *' } | ForEach-Object { [IO.Path]::GetFullPath($_.Substring(9).Trim()) })",
      "  if (@($registeredPaths | Where-Object { $_ -eq $firstSnapshotPath }).Count -ne 0) { throw 'snapshot cleanup left its Git worktree registration behind' }",
      "  $SnapshotPath = New-DetachedSnapshot -Commit $baseCommit",
      "  $removed = $false",
      "  if ([IO.Path]::GetFullPath($SnapshotPath) -ne $firstSnapshotPath) { throw 'repeated snapshot creation did not reuse the deterministic worktree path' }",
      "  $cleanupOutput = @(Remove-DetachedSnapshot -SnapshotPath $SnapshotPath)",
      "  if ($cleanupOutput.Count -ne 0) { throw 'reused snapshot cleanup leaked command output' }",
      "  $removed = $true",
      "  if (Test-Path -LiteralPath $SnapshotPath) { throw 'reused snapshot worktree remained after cleanup' }",
      "  $worktreeListing = Get-GitText -WorkingDirectory $RepoRoot -ArgumentList @('worktree', 'list', '--porcelain')",
      "  $registeredPaths = @($worktreeListing -split \"`r?`n\" | Where-Object { $_ -like 'worktree *' } | ForEach-Object { [IO.Path]::GetFullPath($_.Substring(9).Trim()) })",
      "  if (@($registeredPaths | Where-Object { $_ -eq $firstSnapshotPath }).Count -ne 0) { throw 'reused snapshot cleanup left its Git worktree registration behind' }",
      "} finally {",
      "  if (-not $removed -and (Test-Path -LiteralPath $SnapshotPath)) { Remove-DetachedSnapshot -SnapshotPath $SnapshotPath }",
      "  $patches = @(Get-ChildItem -LiteralPath $StateRoot -Filter 'snapshot-*.patch' -File -ErrorAction SilentlyContinue)",
      "  if ($patches.Count -ne 0) { throw 'snapshot fingerprint left a patch file behind' }",
      "}",
    ].join("\n");

    runPowerShell(snapshotScript, [updaterPath, fixtureRepo, snapshotRoot, stateRoot, baseCommit, longRelativePath]);
  } finally {
    if (snapshotRoot) {
      rmSync(snapshotRoot, { recursive: true, force: true });
    }
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("validation command failure does not wait on descendant output pipes", () => {
  const childLifetimeMs = 3000;
  const validationCommandSource = [
    "$source = Get-Content -LiteralPath $args[0] -Raw",
    "$tokens = $null; $parseErrors = $null",
    "$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)",
    "if (@($parseErrors).Count -ne 0) { throw 'updater parse failed' }",
    "$functionNames = @('Invoke-NativeCommand','Read-NativeOutputText')",
    "foreach ($functionName in $functionNames) { $functionAst = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName }, $true); if ($null -eq $functionAst) { throw \"missing updater function: $functionName\" }; . ([scriptblock]::Create($functionAst.Extent.Text)) }",
    "$sleepCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes(\"Start-Sleep -Milliseconds $($args[1])\"))",
    "$childCommand = \"Start-Process -FilePath pwsh -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','$sleepCommand') | Out-Null; exit 17\"",
    "$encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childCommand))",
    "$timer = [Diagnostics.Stopwatch]::StartNew()",
    "$failed = $false",
    "try { Invoke-NativeCommand -FilePath 'pwsh' -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$encodedCommand) -WorkingDirectory (Get-Location) -IsolateOutputPipes } catch { $failed = $true; if ($_.Exception.Message -notmatch 'exit code 17') { throw } }",
    "$timer.Stop()",
    "if (-not $failed) { throw 'the failing validation command unexpectedly succeeded' }",
    "if ($timer.ElapsedMilliseconds -ge 2000) { throw \"validation failure waited for a descendant output pipe: $($timer.ElapsedMilliseconds)ms\" }",
  ].join("\n");
  const result = invokePowerShellFile(validationCommandSource, [updaterPath, String(childLifetimeMs)]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
});

test("isolated validation output reads while an inherited descendant survives", () => {
  const childLifetimeMs = 3000;
  const validationCommandSource = [
    "$source = Get-Content -LiteralPath $args[0] -Raw",
    "$tokens = $null; $parseErrors = $null",
    "$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)",
    "if (@($parseErrors).Count -ne 0) { throw 'updater parse failed' }",
    "$functionNames = @('Invoke-NativeCommand','Read-NativeOutputText')",
    "foreach ($functionName in $functionNames) { $functionAst = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName }, $true); if ($null -eq $functionAst) { throw \"missing updater function: $functionName\" }; . ([scriptblock]::Create($functionAst.Extent.Text)) }",
    "$sleepCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes(\"Start-Sleep -Milliseconds $($args[1])\"))",
    "$childCommand = \"`$descendant = Start-Process -FilePath pwsh -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','$sleepCommand') -NoNewWindow -PassThru; Write-Output ('RZCODEX_DESCENDANT_PID=' + `$descendant.Id); exit 0\"",
    "$encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childCommand))",
    "$descendantLifetimeMs = [int]$args[1]",
    "$returnDeadlineMs = $descendantLifetimeMs - 1000",
    "$timer = [Diagnostics.Stopwatch]::StartNew()",
    "$output = [string](Invoke-NativeCommand -FilePath 'pwsh' -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$encodedCommand) -WorkingDirectory (Get-Location) -IsolateOutputPipes)",
    "$timer.Stop()",
    "if ($timer.ElapsedMilliseconds -ge $returnDeadlineMs) { throw \"Invoke-NativeCommand returned after $($timer.ElapsedMilliseconds)ms, at or past the $($returnDeadlineMs)ms deadline inside the $($descendantLifetimeMs)ms descendant lifetime, so the read did not race the inheriting descendant\" }",
    "if ($output -notmatch 'RZCODEX_DESCENDANT_PID=([0-9]+)') { throw \"isolated output lost the direct child descendant pid marker: $output\" }",
    "$descendantId = [int]$Matches[1]",
    "$descendant = Get-Process -Id $descendantId -ErrorAction SilentlyContinue",
    "if ($null -eq $descendant) { throw \"descendant pid $descendantId exited before the isolated read completed, so the read did not race the inheriting descendant holding the redirect files\" }",
  ].join("\n");
  const result = invokePowerShellFile(validationCommandSource, [updaterPath, String(childLifetimeMs)]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
});

test("bridge supervisor accepts an intentionally empty argument list", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "rzcodex-bridge-supervisor-"));
  try {
    const bridgePath = join(fixtureRoot, "bridge.mjs");
    const logPath = join(fixtureRoot, "bridge.log");
    writeFileSync(bridgePath, "process.exit(0);\n", "utf8");
    const invocationSource = [
      "$source = Get-Content -LiteralPath $args[0] -Raw",
      "$tokens = $null; $parseErrors = $null",
      "$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)",
      "if (@($parseErrors).Count -ne 0) { throw 'bridge supervisor parse failed' }",
      "$functionAst = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-BridgeProcess' }, $true)",
      "if ($null -eq $functionAst) { throw 'missing bridge supervisor process function' }",
      ". ([scriptblock]::Create($functionAst.Extent.Text))",
      "$exitCode = Invoke-BridgeProcess -NodePath $args[1] -BridgePath $args[2] -Arguments @() -WorkingDirectory $args[3] -LogPath $args[4] -MaximumLogBytes 1048576 -RetainedLogs 1",
      "if ($exitCode -ne 0) { throw \"empty-argument bridge exited with code $exitCode\" }",
    ].join("\n");
    const result = invokePowerShellFile(invocationSource, [
      bridgeSupervisorPath,
      process.execPath,
      bridgePath,
      fixtureRoot,
      logPath,
    ]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("setup waits for a running bridge task before disabling its launcher", () => {
  const invocationSource = [
    "$source = Get-Content -LiteralPath $args[0] -Raw",
    "$tokens = $null; $parseErrors = $null",
    "$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)",
    "if (@($parseErrors).Count -ne 0) { throw 'setup parse failed' }",
    "$functionNames = @('Test-RzCodexScheduledTaskRunning','Stop-RzCodexScheduledTaskInstance','Suspend-RzCodexScheduledTasks')",
    "foreach ($functionName in $functionNames) { $functionAst = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName }, $true); if ($null -eq $functionAst) { throw \"missing setup function: $functionName\" }; . ([scriptblock]::Create($functionAst.Extent.Text)) }",
    "$script:ScheduledTaskStopTimeout = [TimeSpan]::FromSeconds(1)",
    "$script:ScheduledTaskStopPollMilliseconds = 1",
    "$script:taskReads = 0",
    "$script:trace = [Collections.Generic.List[string]]::new()",
    "function Stop-ScheduledTask { param([string]$TaskName) $script:trace.Add(\"stop:$TaskName\") }",
    "function Get-ScheduledTask { param([string]$TaskName, $ErrorAction) $script:taskReads++; $script:trace.Add(\"get:$TaskName\"); if ($script:taskReads -eq 1) { return [pscustomobject]@{ State = 'Running' } }; return [pscustomobject]@{ State = 'Ready' } }",
    "function Start-Sleep { param([int]$Milliseconds) $script:trace.Add(\"sleep:$Milliseconds\") }",
    "function Disable-ScheduledTask { param([string]$TaskName) $script:trace.Add(\"disable:$TaskName\") }",
    "$backup = [pscustomobject]@{ Name = 'fixture bridge'; Existed = $true; WasDisabled = $false; WasRunning = $true }",
    "Suspend-RzCodexScheduledTasks -TaskBackups @($backup)",
    "$expected = 'stop:fixture bridge,get:fixture bridge,sleep:1,get:fixture bridge,disable:fixture bridge'",
    "$actual = $script:trace -join ','",
    "if ($actual -ne $expected) { throw \"unexpected scheduled-task suspension order: $actual\" }",
  ].join("\n");
  const result = invokePowerShellFile(invocationSource, [setupPath]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
});

test("setup stops only exact legacy bridge launcher processes", () => {
  const invocationSource = [
    "$source = Get-Content -LiteralPath $args[0] -Raw",
    "$tokens = $null; $parseErrors = $null",
    "$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)",
    "if (@($parseErrors).Count -ne 0) { throw 'setup parse failed' }",
    "$functionAst = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Stop-RzCodexLegacyBridgeLaunchers' }, $true)",
    "if ($null -eq $functionAst) { throw 'missing legacy bridge launcher cleanup function' }",
    ". ([scriptblock]::Create($functionAst.Extent.Text))",
    "$script:ScheduledTaskStopTimeout = [TimeSpan]::FromSeconds(1)",
    "$script:ScheduledTaskStopPollMilliseconds = 1",
    "$launcherRoot = [IO.Path]::GetFullPath($args[1])",
    "$launcherScript = Join-Path $launcherRoot 'rzcodex-launch.ps1'",
    "$legacyVbs = Join-Path $launcherRoot 'run-antigravity-subagent-bridge-hidden.vbs'",
    "$quote = [char]34",
    "$script:alive = @{ 101 = $true; 102 = $true; 103 = $true; 104 = $true; 105 = $true; 106 = $true; 107 = $true; 108 = $true; 109 = $true }",
    "$script:stopped = [Collections.Generic.List[int]]::new()",
    "$script:treeKillFlags = [Collections.Generic.List[bool]]::new()",
    "function Get-CimInstance { param([string]$ClassName) return @(",
    "  [pscustomobject]@{ Name='pwsh.exe'; ProcessId=101; CommandLine=\"pwsh -NoProfile -File $quote$launcherScript$quote -Bridge commandcode\" },",
    "  [pscustomobject]@{ Name='powershell.exe'; ProcessId=101; CommandLine=\"powershell -File $launcherScript -Bridge codebuddy\" },",
    "  [pscustomobject]@{ Name='node.exe'; ProcessId=102; CommandLine=\"node -File ```\"$launcherScript```\" -Bridge commandcode\" },",
    "  [pscustomobject]@{ Name='pwsh.exe'; ProcessId=103; CommandLine=\"pwsh -File ```\"$launcherScript.bak```\" -Bridge commandcode\" },",
    "  [pscustomobject]@{ Name='pwsh.exe'; ProcessId=104; CommandLine=\"pwsh -File ```\"$launcherScript```\" -Update\" },",
    "  [pscustomobject]@{ Name='pwsh.exe'; ProcessId=105; CommandLine=\"pwsh -File ```\"$launcherScript```\" -BridgeWorker commandcode\" },",
    "  [pscustomobject]@{ Name='pwsh.exe'; ProcessId=106; CommandLine=$null }",
    "  [pscustomobject]@{ Name='wscript.exe'; ProcessId=107; CommandLine=\"wscript //B //Nologo $quote$legacyVbs$quote\" },",
    "  [pscustomobject]@{ Name='wscript.exe'; ProcessId=108; CommandLine=\"wscript //B //Nologo $quote$legacyVbs.bak$quote\" },",
    "  [pscustomobject]@{ Name='node.exe'; ProcessId=109; CommandLine=\"node $quote$legacyVbs$quote\" }",
    ") }",
    "function Get-Process { param([int]$Id, $ErrorAction) if ($script:alive[$Id]) { $process = [pscustomobject]@{ Id=$Id }; $process | Add-Member -MemberType ScriptMethod -Name Kill -Value { param([bool]$EntireProcessTree) $script:stopped.Add([int]$this.Id); $script:treeKillFlags.Add($EntireProcessTree); $script:alive[[int]$this.Id] = $false }; return $process } }",
    "function Start-Sleep { param([int]$Milliseconds) throw 'legacy launcher cleanup unexpectedly waited after stopping its exact target' }",
    "Stop-RzCodexLegacyBridgeLaunchers -LauncherRoot $launcherRoot",
    "$actual = @($script:stopped | Sort-Object -Unique)",
    "if ($actual.Count -ne 2 -or $actual[0] -ne 101 -or $actual[1] -ne 107) { throw \"legacy cleanup selected the wrong process ids: $($actual -join ',')\" }",
    "if ($script:treeKillFlags.Count -ne 2 -or @($script:treeKillFlags | Where-Object { -not $_ }).Count -ne 0) { throw 'legacy cleanup did not terminate the complete managed process trees' }",
    "foreach ($untouchedId in 102,103,104,105,106,108,109) { if (-not $script:alive[$untouchedId]) { throw \"legacy cleanup stopped unrelated process $untouchedId\" } }",
  ].join("\n");
  const fixtureLauncherRoot = join(tmpdir(), "RzCodex Legacy Launcher Fixture");
  const result = invokePowerShellFile(invocationSource, [setupPath, fixtureLauncherRoot]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
});

test("setup task lifecycle brackets stable launcher replacement", () => {
  const source = readFileSync(setupPath, "utf8");
  const suspendIndex = source.indexOf("Suspend-RzCodexScheduledTasks -TaskBackups $taskBackups");
  const legacyCleanupIndex = source.indexOf("Stop-RzCodexLegacyBridgeLaunchers -LauncherRoot $launcherRoot");
  const activateIndex = source.indexOf("Move-Item -LiteralPath $launcherRoot -Destination $previousLauncherRoot");
  const commitIndex = source.indexOf("Write-AtomicText -Path $deploymentStatePath");
  const successRestartIndex = source.indexOf("Start-ScheduledTask -TaskName $taskBackup.Name", commitIndex);
  const rollbackStopIndex = source.lastIndexOf("Stop-RzCodexScheduledTaskInstance -TaskName $taskBackup.Name");
  const rollbackLauncherIndex = source.lastIndexOf("Remove-Item -LiteralPath $launcherRoot -Recurse -Force");
  const rollbackRestoreIndex = source.lastIndexOf("Copy-Item -LiteralPath (Join-Path $backupRoot \"launcher\") -Destination $launcherRoot -Recurse");
  const rollbackRestartIndex = source.lastIndexOf("Start-ScheduledTask -TaskName $taskBackup.Name");
  assert.equal(
    suspendIndex >= 0 && suspendIndex < activateIndex,
    true,
    "running tasks must be suspended before replacing their launcher directory",
  );
  assert.equal(
    suspendIndex < legacyCleanupIndex && legacyCleanupIndex < activateIndex,
    true,
    "legacy child launchers must stop after task suspension and before launcher replacement",
  );
  assert.equal(
    commitIndex >= 0 && commitIndex < successRestartIndex,
    true,
    "bridge tasks must restart only after the new deployment state commits",
  );
  assert.equal(
    rollbackStopIndex >= 0 && rollbackStopIndex < rollbackLauncherIndex,
    true,
    "rollback must stop new task instances before removing their launcher",
  );
  assert.equal(
    rollbackRestoreIndex >= 0 && rollbackRestoreIndex < rollbackRestartIndex,
    true,
    "rollback must restore the old launcher before restarting old task instances",
  );
});

test("stable launcher forwards piped stdin, arguments, and exit codes to the managed binary", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "rzcodex-launcher-stdin-"));
  try {
    const stateRoot = join(fixtureRoot, "state");
    const stateScripts = join(stateRoot, "scripts");
    const installRoot = join(fixtureRoot, "install");
    const buildRoot = join(installRoot, "builds", "fixture");
    mkdirSync(stateScripts, { recursive: true });
    mkdirSync(join(buildRoot, "scripts"), { recursive: true });

    const managedPaths = [...manifest.binaries, ...manifest.deploymentFiles];
    for (const relativePath of managedPaths) {
      const target = join(buildRoot, ...relativePath.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      if (relativePath === "codex.exe") {
        copyFileSync(process.execPath, target);
      } else if (relativePath.endsWith(".exe")) {
        writeFileSync(target, "fixture binary placeholder");
      } else {
        copyFileSync(join(repoRoot, relativePath), target);
      }
    }
    copyFileSync(join(scriptsRoot, "rzcodex.ps1"), join(stateScripts, "rzcodex.ps1"));
    copyFileSync(join(scriptsRoot, "rzcodex-launch.ps1"), join(stateScripts, "rzcodex-launch.ps1"));
    writeFileSync(join(stateRoot, "deployment.json"), JSON.stringify({
      repoRoot: fixtureRoot,
      codexHome: join(fixtureRoot, "codex-home"),
      installRoot,
    }));
    runPowerShell([
      "$build = $args[0]",
      "$paths = $args[2] | ConvertFrom-Json",
      "$records = @($paths | ForEach-Object { $path = Join-Path $build $_; [pscustomobject][ordered]@{ path = $_; size = (Get-Item $path).Length; sha256 = (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant() } })",
      "$recordJson = ConvertTo-Json -InputObject @($records | Sort-Object path) -Depth 4 -Compress",
      "$aggregate = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($recordJson))).ToLowerInvariant()",
      "$metadata = [ordered]@{ activationState='complete'; sourceId='fixture'; aggregateSha256=$aggregate; files=@($records | Sort-Object path) }",
      "[IO.File]::WriteAllText((Join-Path $build 'rzcodex-build.json'), (($metadata | ConvertTo-Json -Depth 5) + [Environment]::NewLine))",
      "[IO.File]::WriteAllText((Join-Path $args[1] 'current.txt'), (Join-Path $build 'codex.exe'))",
    ].join("; "), [buildRoot, installRoot, JSON.stringify(managedPaths)]);

    const stableShim = join(stateScripts, "rzcodex.ps1");
    const stableLauncher = join(stateScripts, "rzcodex-launch.ps1");
    const runFixture = (command) => spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$PSNativeCommandUseErrorActionPreference = $true; ${command}; exit $LASTEXITCODE`], {
      encoding: "utf8",
      windowsHide: true,
    });
    const runFixtureSuccess = (command) => {
      const result = runFixture(command);
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      return result.stdout;
    };

    assert.match(
      runFixtureSuccess(`'RZCODEX_PIPED_STDIN_MARKER' | & '${stableShim}' -e 'process.stdin.pipe(process.stdout)'`),
      /RZCODEX_PIPED_STDIN_MARKER/,
    );
    assert.match(
      runFixtureSuccess(`& '${stableLauncher}' -PipelineInput 'RZCODEX_LAUNCHER_STDIN_MARKER' -CommandArguments @('-e','process.stdin.pipe(process.stdout)')`),
      /RZCODEX_LAUNCHER_STDIN_MARKER/,
    );
    assert.match(
      runFixtureSuccess(`'RZCODEX_ARG_MARKER' | & '${stableShim}' -e 'process.stdout.write(process.argv[1])' RZCODEX_ARG_MARKER`),
      /RZCODEX_ARG_MARKER/,
    );
    const emptyStdinResult = runFixture(`'' | & '${stableShim}' -e 'process.stdin.resume()'`);
    assert.equal(emptyStdinResult.status, 0, `${emptyStdinResult.stderr}\n${emptyStdinResult.stdout}`);
    const exitCodeResult = runFixture(`& '${stableShim}' -e 'process.exit(7)'`);
    assert.equal(exitCodeResult.status, 7, `${exitCodeResult.stderr}\n${exitCodeResult.stdout}`);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
