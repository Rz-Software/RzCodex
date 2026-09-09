import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ActiveTaskProviderPins } from "./native-subagent-provider-router.mjs";
import {
  RetainedProviderSessions,
  assertDevinTaskBoundary,
  devinPostToolQuotaFailure,
  executionPolicyFromTaskState,
  finalizeDevinResult,
  reconcileProviderPinAfterAbort,
  withRecoveryProbeAfterCapacity,
  withRetainedProviderSession,
} from "./devin-subagent-bridge.mjs";

function devinFixture() {
  const session = {
    id: "session-fixture",
    model: "fixture-model",
    terminalText: "Implemented the bounded patch.",
    metadata: {},
    metrics: [],
    toolCalls: [{ name: "apply_patch", args: {}, result: "Done" }],
  };
  return {
    context: { executionPolicy: { rzMcpMode: "disabled" } },
    selected: { key: "primary", model: { model_uid: "fixture-model" } },
    routeResult: { cliResult: { code: 0, stdout: session.terminalText, stderr: "" }, session },
    fallbackState: {
      quotaFallback: false,
      terminalFallback: false,
      fallbackReason: null,
      fallbackFailure: null,
      toolSchemaBytesIgnored: 0,
    },
    session,
  };
}

test("cleanup failure after a completed mutation preserves the successful result", () => {
  const fixture = devinFixture();
  const result = finalizeDevinResult(
    fixture.context,
    fixture.selected,
    fixture.routeResult,
    fixture.fallbackState,
    false,
    { remove: () => { throw new Error("fixture cleanup failed"); } },
  );
  assert.equal(result.text, fixture.session.terminalText);
  assert.equal(result.preserveProviderSession, true);
  assert.match(result.sessionCleanupError, /fixture cleanup failed/);
  assert.deepEqual(result.nativeToolNames, ["apply_patch"]);
});

test("a failed post-mutation finalization never deletes or makes the work replayable", () => {
  const fixture = devinFixture();
  fixture.session.terminalText = null;
  let removeCalls = 0;
  assert.throws(
    () => finalizeDevinResult(
      fixture.context,
      fixture.selected,
      fixture.routeResult,
      fixture.fallbackState,
      false,
      { remove: () => { removeCalls += 1; } },
    ),
    (error) => (
      error.routeCommitted === true
      && error.retainedProviderSession === fixture.session
      && /without a terminal assistant message/.test(error.message)
    ),
  );
  assert.equal(removeCalls, 0);
});

test("quota exhaustion after provider tools retains the owning conversation", () => {
  const fixture = devinFixture();
  const error = devinPostToolQuotaFailure(fixture.session, fixture.context.executionPolicy);
  assert.equal(error.routeCommitted, true);
  assert.equal(error.toolCalls, 1);
  assert.deepEqual(error.toolNames, ["apply_patch"]);
  assert.equal(error.retainedProviderSession, fixture.session);
  assert.match(error.message, /was not replayed/);
});

test("retained session lease survives cancellation before provider transfer", async () => {
  const registry = new RetainedProviderSessions();
  const session = { id: "retained-session" };
  registry.retain("thread-model-owner", "task-a", session);
  await assert.rejects(
    withRetainedProviderSession(registry, "thread-model-owner", "task-a", async (leased) => {
      assert.equal(leased, session);
      const error = new Error("cancelled before provider spawn");
      error.status = 499;
      throw error;
    }),
    /cancelled before provider spawn/,
  );
  assert.equal(registry.has("thread-model-owner", "task-a"), true);
  assert.equal(registry.take("thread-model-owner", "task-a"), session);
});

test("expired retained ownership blocks replay until a different task takes the owner slot", () => {
  let now = 10;
  const registry = new RetainedProviderSessions({ maxAgeMs: 5, now: () => now });
  const session = { id: "provider-session-still-on-disk" };
  registry.retain("thread-model-owner", "task-a", session);
  now += 5;
  assert.throws(
    () => registry.take("thread-model-owner", "task-a"),
    (error) => error.routeCommitted === true && error.providerTaskPinPreserved === true,
  );
  assert.equal(registry.has("thread-model-owner", "task-a"), true);
  assert.equal(registry.take("thread-model-owner", "task-b"), null);
  assert.equal(registry.size, 0);
  assert.deepEqual(session, { id: "provider-session-still-on-disk" });
});

test("a zero-work provisional provider pin is released on parent abort", () => {
  const pins = new ActiveTaskProviderPins();
  pins.pin("thread-a", "task-a", "devin");
  const controller = new AbortController();
  controller.abort();
  const error = new Error("parent abort");
  assert.equal(reconcileProviderPinAfterAbort(
    pins,
    "thread-a",
    "task-a",
    error,
    controller.signal,
    null,
  ), null);
  assert.equal(pins.get("thread-a", "task-a"), null);
  assert.equal(error.routeCommitted, undefined);
});

test("Devin is rejected before work when its CLI cannot enforce delegated restrictions", () => {
  const ordinaryDelegatedPolicy = executionPolicyFromTaskState({
    activeTask: { text: "Fix the bounded source defect." },
  });
  assert.equal(ordinaryDelegatedPolicy.readOnly, false);
  assert.equal(ordinaryDelegatedPolicy.validationRestricted, true);
  assert.equal(ordinaryDelegatedPolicy.rzMcpMode, "no-validation");
  assert.throws(
    () => assertDevinTaskBoundary({ readOnly: true, validationRestricted: false, rzMcpMode: "read-only" }),
    /fileWrites must be disabled/,
  );
  assert.throws(
    () => assertDevinTaskBoundary({ readOnly: false, validationRestricted: true, rzMcpMode: "no-validation" }),
    /shell must be disabled/,
  );
  assert.throws(
    () => assertDevinTaskBoundary(ordinaryDelegatedPolicy),
    /shell must be disabled/,
  );
  assert.doesNotThrow(
    () => assertDevinTaskBoundary({ readOnly: false, validationRestricted: false, rzMcpMode: "full" }),
  );
});

test("a saturated route does not consume its recovery probe", async () => {
  let claims = 0;
  let providerRuns = 0;
  const recoveryState = {
    isActive: () => true,
    claimRecoveryProbe: () => { claims += 1; return true; },
  };
  await assert.rejects(
    withRecoveryProbeAfterCapacity({
      selected: { key: "ollama" },
      recoveryState,
      run: async () => { providerRuns += 1; },
      withCapacity: async () => {
        const error = new Error("capacity unavailable");
        error.status = 503;
        error.routeSkipped = true;
        throw error;
      },
    }),
    /capacity unavailable/,
  );
  assert.equal(claims, 0);
  assert.equal(providerRuns, 0);
});

test("importing the bridge has no configuration, pruning, auth, or server side effects", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "rzcodex-devin-import-"));
  const codexHome = join(fixtureRoot, "codex-home");
  const appData = join(fixtureRoot, "app-data");
  const localAppData = join(fixtureRoot, "local-app-data");
  try {
    const moduleUrl = pathToFileURL(join(
      dirname(fileURLToPath(import.meta.url)),
      "devin-subagent-bridge.mjs",
    )).href;
    const imported = spawnSync(process.execPath, [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(moduleUrl)});`,
    ], {
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        APPDATA: appData,
        LOCALAPPDATA: localAppData,
      },
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    assert.equal(imported.status, 0, imported.stderr || imported.stdout);
    assert.equal(imported.stdout, "");
    assert.equal(imported.stderr, "");
    assert.equal(existsSync(codexHome), false);
    assert.equal(existsSync(appData), false);
    assert.equal(existsSync(localAppData), false);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
