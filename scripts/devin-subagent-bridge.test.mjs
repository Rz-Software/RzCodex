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
  devinPostToolQuotaFailure,
  executionPolicyFromTaskState,
  finalizeDevinResult,
  reconcileProviderPinAfterAbort,
  runCliWithProviderRecovery,
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
    context: { executionPolicy: { permissionMode: "dangerous", rzMcpMode: "disabled" } },
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

test("Devin delegated policy resolves the RzMCP mode without restricting native tools", () => {
  const ordinaryDelegatedPolicy = executionPolicyFromTaskState({
    activeTask: { text: "Fix the bounded source defect." },
  });
  assert.deepEqual(ordinaryDelegatedPolicy, {
    rzMcpMode: "full",
    permissionMode: "dangerous",
  });
  const rzMcpBanPolicy = executionPolicyFromTaskState({
    activeTask: { text: "Review the bounded diff. Do not use or invoke RzDirectMCP." },
  });
  assert.equal(rzMcpBanPolicy.rzMcpMode, "disabled");
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

test("finalizeDevinResult rejects a mismatched model while preserving committed ownership", () => {
  const fixture = devinFixture();
  fixture.session.model = "swe-1-7-medium";
  fixture.selected.model = { model_uid: "glm-5-3-flash-max", label: "GLM-5.3 Flash Max" };
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
      error.status === 502
      && /unexpected model/.test(error.message)
      && error.retainedProviderSession === fixture.session
      && error.routeCommitted === true
      && error.toolCalls === 1
    ),
  );
  assert.equal(removeCalls, 0);
});

test("runCliWithProviderRecovery refuses an already-wrong-model resume session without deleting it", async () => {
  const context = { requestId: "stale-resume-test", executionPolicy: { permissionMode: "dangerous" } };
  const selectedModel = { model_uid: "glm-5-3-flash-max" };
  const resumedSession = { id: "stale-session", model: "swe-1-7-medium", terminalText: "stale", toolCalls: [{ name: "write" }] };
  let removeCalls = 0;
  let runCalls = 0;
  await assert.rejects(
    () => runCliWithProviderRecovery(
      context,
      selectedModel,
      () => {},
      () => {},
      null,
      Date.now() + 5000,
      {
        runCli: () => {
          runCalls += 1;
          return Promise.resolve({ code: 0, stdout: "fresh result", stderr: "" });
        },
        waitForSession: () => resumedSession,
        waitForTerminalSession: () => resumedSession,
        removeSession: () => { removeCalls += 1; },
        initialResumeSession: resumedSession,
        delay: () => Promise.resolve(),
        now: Date.now,
      },
    ),
    (error) => (
      error.status === 502
      && /already bound to unexpected model/.test(error.message)
      && error.retainedProviderSession === resumedSession
      && error.routeCommitted === true
    ),
  );
  assert.equal(removeCalls, 0);
  assert.equal(runCalls, 0);
});

test("runCliWithProviderRecovery resumes a blank-DB session because the per-model config default binds it", async () => {
  const context = { requestId: "blank-resume-test", executionPolicy: { permissionMode: "dangerous" } };
  const selectedModel = { model_uid: "glm-5-3-flash-max", label: "GLM-5.3 Flash Max" };
  const resumedSession = { id: "blank-session", model: "", terminalText: null };
  const finalSession = { id: "blank-session", model: "glm-5-3-flash-max", terminalText: "resumed result" };
  let runCalls = 0;
  let lastResumeSessionId = null;
  const result = await runCliWithProviderRecovery(
    context,
    selectedModel,
    () => {},
    () => {},
    null,
    Date.now() + 5000,
    {
      runCli: (ctx, model, onSpawn, onProgress, timeout, options = {}) => {
        runCalls += 1;
        lastResumeSessionId = options?.resumeSessionId || null;
        return Promise.resolve({ code: 0, stdout: "resumed result", stderr: "" });
      },
      waitForSession: () => finalSession,
      waitForTerminalSession: () => finalSession,
      initialResumeSession: resumedSession,
      delay: () => Promise.resolve(),
      now: Date.now,
    },
  );
  assert.equal(runCalls, 1);
  assert.equal(lastResumeSessionId, "blank-session");
  assert.equal(result.cliResult.code, 0);
});

test("runCliWithProviderRecovery resumes an output-truncated turn once with the same session", async () => {
  const context = { requestId: "output-limit-test", taskDiagnostics: { taskHash: "output-limit-task" }, executionPolicy: { permissionMode: "dangerous" } };
  const selectedModel = { model_uid: "swe-1-7-medium" };
  const session = { id: "limit-session", model: "swe-1-7-medium", terminalText: null, toolCalls: [{ name: "read" }] };
  let runCalls = 0;
  const result = await runCliWithProviderRecovery(
    context,
    selectedModel,
    () => {},
    () => {},
    null,
    Date.now() + 5000,
    {
      runCli: () => {
        runCalls += 1;
        return Promise.resolve({
          code: runCalls === 1 ? 1 : 0,
          stdout: runCalls === 1
            ? "Response truncated: model hit max output token limit. The output above is incomplete."
            : "concise result",
          stderr: "",
        });
      },
      waitForSession: () => session,
      waitForTerminalSession: () => ({ ...session, terminalText: "concise result" }),
      delay: () => Promise.resolve(),
      now: Date.now,
    },
  );
  assert.equal(runCalls, 2);
  assert.equal(result.cliResult.code, 0);
  assert.equal(result.session.terminalText, "concise result");
});

test("repeated output truncation fails explicitly and retains the committed session", async () => {
  const context = { requestId: "output-limit-failed", taskDiagnostics: { taskHash: "output-limit-task" }, executionPolicy: { permissionMode: "dangerous" } };
  const selectedModel = { model_uid: "glm-5-3-flash-max" };
  const session = { id: "committed-limit-session", model: selectedModel.model_uid, terminalText: null, toolCalls: [{ id: "write-once", name: "write" }] };
  const calls = [];
  await assert.rejects(
    runCliWithProviderRecovery(context, selectedModel, () => {}, () => {}, null, 100_000, {
      runCli: async (_context, _model, _spawn, _progress, _timeout, options) => {
        calls.push(options?.resumeSessionId ?? null);
        return { code: 1, stdout: "", stderr: "Response truncated: model hit max output token limit. The output above is incomplete." };
      },
      waitForSession: async () => session,
      removeSession: () => { assert.fail("committed session must not be deleted"); },
      delay: async () => {},
      now: () => 1_000,
    }),
    (error) => {
      assert.equal(error.status, 502);
      assert.equal(error.routeCommitted, true);
      assert.equal(error.retainedProviderSession, session);
      assert.equal(error.mutationToolCalls, 1);
      assert.match(error.message, /output token limit/);
      return true;
    },
  );
  assert.deepEqual(calls, [null, session.id]);
  assert.equal(session.terminalText, null);
});

test("cancellation during recovery backoff preserves committed conversation ownership", async () => {
  const context = { requestId: "backoff-abort", taskDiagnostics: { taskHash: "backoff-task" }, executionPolicy: { permissionMode: "dangerous" } };
  const selectedModel = { model_uid: "glm-5-3-flash-max" };
  const session = { id: "backoff-session", model: selectedModel.model_uid, terminalText: null, toolCalls: [{ name: "edit" }] };
  const aborted = Object.assign(new Error("parent cancelled during backoff"), { status: 499 });
  await assert.rejects(
    runCliWithProviderRecovery(context, selectedModel, () => {}, () => {}, null, 100_000, {
      runCli: async () => ({ code: 1, stdout: "", stderr: "stream interrupted" }),
      waitForSession: async () => session,
      removeSession: () => { assert.fail("committed session must not be deleted"); },
      delay: async () => { throw aborted; },
      now: () => 1_000,
    }),
    (error) => {
      assert.equal(error, aborted);
      assert.equal(error.routeCommitted, true);
      assert.equal(error.retainedProviderSession, session);
      return true;
    },
  );
});

test("runCliWithProviderRecovery gives a same-session continuation the overall remaining deadline, not the 45s recovery budget", async () => {
  const context = { requestId: "continuation-deadline", taskDiagnostics: { taskHash: "continuation-deadline-task" }, executionPolicy: { permissionMode: "dangerous" } };
  const selectedModel = { model_uid: "glm-5-3-flash-max" };
  const session = { id: "long-turn-session", model: selectedModel.model_uid, toolCalls: [], compactionNodeId: 0, terminalText: null };
  const recoveryBudgetMs = 45_000;
  const deadline = 300_000;
  let now = 1_000;
  let sessionReads = 0;
  const timeouts = [];
  const resumeIds = [];
  const result = await runCliWithProviderRecovery(
    context,
    selectedModel,
    () => {},
    () => {},
    null,
    deadline,
    {
      now: () => now,
      delay: async (milliseconds) => { now += milliseconds; },
      waitForSession: async () => {
        sessionReads += 1;
        return sessionReads === 1 ? session : { ...session, terminalText: "continued result" };
      },
      waitForTerminalSession: async (_requestId, leased) => leased,
      removeSession: () => { assert.fail("retained session must not be deleted"); },
      runCli: async (_context, _model, _onSpawn, _onProgress, timeoutMs, options) => {
        timeouts.push(timeoutMs);
        resumeIds.push(options?.resumeSessionId ?? null);
        if (timeouts.length === 1) {
          now += 40_000;
          return { code: 1, stdout: "", stderr: "stream interrupted" };
        }
        now += 200_000;
        return { code: 0, stdout: "continued result", stderr: "" };
      },
    },
  );
  assert.deepEqual(timeouts, [299_000, 258_000]);
  assert.ok(timeouts[1] > recoveryBudgetMs);
  assert.deepEqual(resumeIds, [null, session.id]);
  assert.equal(result.cliResult.code, 0);
  assert.equal(result.session.terminalText, "continued result");
});

test("a failed same-session continuation reports the actual run error instead of the generic stream failure", async () => {
  const context = { requestId: "run-error-reason", taskDiagnostics: { taskHash: "run-error-reason-task" }, executionPolicy: { permissionMode: "dangerous" } };
  const selectedModel = { model_uid: "glm-5-3-flash-max" };
  const session = { id: "run-error-session", model: selectedModel.model_uid, toolCalls: [{ id: "edit-1", name: "edit" }], compactionNodeId: 0, terminalText: null };
  const runError = new Error("provider run timed out after 180000 ms");
  const progress = [];
  let runCalls = 0;
  const failure = await runCliWithProviderRecovery(
    context,
    selectedModel,
    () => {},
    (item) => progress.push(item),
    null,
    100_000,
    {
      now: () => 1_000,
      delay: async () => {},
      waitForSession: async () => session,
      waitForTerminalSession: async (_requestId, leased) => leased,
      removeSession: () => { assert.fail("committed session must not be deleted"); },
      runCli: async () => {
        runCalls += 1;
        throw runError;
      },
    },
  ).catch((error) => error);
  assert.equal(runCalls, 2);
  assert.equal(failure.status, 502);
  assert.equal(failure.routeCommitted, true);
  assert.equal(failure.retainedProviderSession, session);
  assert.match(failure.message, /the provider run failed: provider run timed out after 180000 ms/);
  assert.doesNotMatch(failure.message, /stream ended before a terminal response/);
  assert.match(failure.message, /One bounded same-session continuation/);
  assert.equal(progress.length, 1);
  assert.equal(progress[0]?.kind, "recovery");
  assert.match(progress[0]?.reason, /the provider run failed: provider run timed out after 180000 ms/);
  assert.doesNotMatch(progress[0]?.reason, /stream ended before a terminal response/);
});

test("compaction continuation preserves the active task and allows further tools before the terminal result", async () => {
  const context = {
    requestId: "compaction-continuation-test",
    taskDiagnostics: { taskHash: "compaction-continuation-task" },
    taskState: { activeTask: { id: "compaction-task", name: "/root/compaction_continuation_fixture", hash: "compaction-continuation-task", text: "Finish the bounded fixture without restarting the investigation." } },
    executionPolicy: { permissionMode: "dangerous" },
  };
  const selectedModel = { model_uid: "glm-5-3-flash-max" };
  const session = { id: "compaction-continuation-session", model: selectedModel.model_uid, toolCalls: [{ id: "exec-before-compaction", name: "exec" }], compactionNodeId: 0, terminalText: null };
  const continuedSession = {
    ...session,
    toolCalls: [...session.toolCalls, { id: "edit-after-compaction", name: "edit" }],
    terminalText: "Finished after compaction continuation.",
  };
  const calls = [];
  let sessionReads = 0;
  const result = await runCliWithProviderRecovery(
    context,
    selectedModel,
    () => {},
    () => {},
    null,
    100_000,
    {
      now: () => 1_000,
      delay: async () => {},
      waitForSession: async () => {
        sessionReads += 1;
        return sessionReads === 1 ? session : continuedSession;
      },
      waitForTerminalSession: async (_requestId, leased) => leased,
      removeSession: () => { assert.fail("compaction continuation must retain the session"); },
      runCli: async (_context, _model, _onSpawn, _onProgress, _timeoutMs, options) => {
        calls.push(options);
        return calls.length === 1
          ? { code: 1, stdout: "", stderr: "Devin provider context compacted at node 12" }
          : { code: 0, stdout: continuedSession.terminalText, stderr: "" };
      },
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0], undefined);
  assert.equal(calls[1]?.resumeSessionId, session.id);
  assert.match(calls[1]?.prompt, /Native Devin compaction recovery/);
  assert.ok(calls[1]?.prompt.includes(context.taskState.activeTask.text));
  assert.equal(calls[1]?.compactionBaseline, 0);
  assert.deepEqual(calls[1]?.toolCallBaseline, [{ id: "exec-before-compaction", name: "exec" }]);
  assert.equal(result.cliResult.code, 0);
  assert.equal(result.session, continuedSession);
  assert.deepEqual(result.session.toolCalls.at(-1), { id: "edit-after-compaction", name: "edit" });
  assert.equal(result.session.terminalText, "Finished after compaction continuation.");
});
