import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  ActiveTaskProviderPins,
  ActiveTaskRoutePins,
  completedResponseFromRecoverableStream,
  fallbackForwardBody,
  completedResponseFromSse,
  parseResponsesSse,
  runOrderedProviderChain,
  runResponsesBridge,
  validateOAuthFallbackCompletion,
} from "./native-subagent-provider-router.mjs";

const MODEL_ALIAS = "@preset/codex-subagents";
const EXPECTED = {
  provider: "antigravity",
  models: ["claude-opus-4-6-thinking", "gemini-3.8-flash-high"],
  authSource: "Antigravity cached OAuth session",
};

function sse(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function completion(overrides = {}) {
  return {
    id: "resp-inner",
    object: "response",
    status: "completed",
    model: MODEL_ALIAS,
    output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "exec_command", arguments: "{}" }],
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 10 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 120,
    },
    metadata: {
      actual_provider: EXPECTED.provider,
      actual_model: EXPECTED.models[0],
      auth_source: EXPECTED.authSource,
      codex_tool_schema_bytes_forwarded: 0,
      lazy_rzmcp_proxy_tools: 2,
      complete_active_task_delivered: true,
    },
    ...overrides,
  };
}

async function withServer(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  try {
    return await callback(`http://127.0.0.1:${port}/v1/responses`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("fallback forwarding preserves the request and changes only provider effort", () => {
  const input = [{ type: "message", role: "user", content: "task" }];
  const forwarded = fallbackForwardBody({
    model: MODEL_ALIAS,
    stream: true,
    reasoning: { effort: "high", summary: "none" },
    input,
    client_metadata: { thread_id: "thread-a", cwd: "stale-cwd" },
  }, MODEL_ALIAS, "max", "G:\\QANGA");
  assert.deepEqual(forwarded, {
    model: MODEL_ALIAS,
    stream: true,
    reasoning: { effort: "max", summary: "none" },
    input,
    client_metadata: { thread_id: "thread-a", cwd: "G:\\QANGA" },
  });
});

test("quota routing stays pinned only for the same active task and releases on its final response", () => {
  const pins = new ActiveTaskRoutePins();
  assert.equal(pins.pin(null, "task-a"), false);
  assert.equal(pins.pin("thread-a", null), false);
  assert.equal(pins.pin("thread-a", "task-a"), true);
  assert.equal(pins.size, 1);
  assert.equal(pins.has("thread-a", "task-a"), true);
  assert.equal(pins.has("thread-a", "task-b"), false);
  assert.equal(pins.releaseAfterFinalResponse("thread-a", "task-a", 1), false);
  assert.equal(pins.has("thread-a", "task-a"), true);
  assert.equal(pins.releaseAfterFinalResponse("thread-a", "task-a", 0), true);
  assert.equal(pins.size, 0);
});

test("provider routing stays on the tool-owning provider until the active task reaches a final response", () => {
  const pins = new ActiveTaskProviderPins();
  assert.equal(pins.pin(null, "task-a", "codebuddy"), false);
  assert.equal(pins.pin("thread-a", "task-a", null), false);
  assert.equal(pins.pin("thread-a", "task-a", "codebuddy"), true);
  assert.equal(pins.pin("thread-a", "task-a", "codebuddy"), false);
  assert.equal(pins.get("thread-a", "task-a"), "codebuddy");
  assert.equal(pins.releaseAfterFinalResponse("thread-a", "task-a", 1), false);
  assert.equal(pins.get("thread-a", "task-a"), "codebuddy");
  assert.equal(pins.get("thread-a", "task-b"), null);
  assert.equal(pins.size, 0);
  assert.equal(pins.pin("thread-a", "task-b", "devin-free"), true);
  assert.equal(pins.release("thread-a", "task-b"), true);
  assert.equal(pins.release("thread-a", "task-b"), false);
});

test("SSE parsing preserves completed tool-call output after heartbeats", () => {
  const completed = completion();
  const raw = [
    sse("response.created", { response: { status: "in_progress" } }),
    sse("response.in_progress", { response: { status: "in_progress" } }),
    sse("response.output_item.done", { output_index: 0, item: completed.output[0] }),
    sse("response.completed", { response: completed }),
  ].join("");
  assert.equal(parseResponsesSse(raw).length, 4);
  assert.deepEqual(completedResponseFromSse(raw), completed);
});

test("the loopback Responses client accepts a chunked fallback completion", async () => {
  const progress = sse("response.in_progress", { response: { status: "in_progress" } });
  const completed = sse("response.completed", { response: completion() });
  let serverEnded = false;
  await withServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, undefined);
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    response.write(progress);
    setTimeout(() => {
      serverEnded = true;
      response.end(completed);
    }, 25);
  }, async (endpoint) => {
    let progressArrivedBeforeCompletion = false;
    const result = await runResponsesBridge({
      endpoint,
      body: { stream: true },
      onEvent: async (event) => {
        if (event.type === "response.in_progress") progressArrivedBeforeCompletion = !serverEnded;
      },
    });
    assert.deepEqual(result, completion());
    assert.equal(progressArrivedBeforeCompletion, true);
  });
});

test("completed output items survive a stream that closes before response.completed", async () => {
  const tool = completion().output[0];
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      sse("response.created", { response: { id: "resp-cut", model: MODEL_ALIAS, status: "in_progress" } }),
      sse("response.output_item.done", { output_index: 0, item: tool }),
    ].join(""));
  }, async (endpoint) => {
    let failure;
    try {
      await runResponsesBridge({ endpoint, body: {} });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.incompleteStream, true);
    assert.equal(failure?.recoverableStreamFailure, true);
    assert.equal(failure?.observedEventCount, 2);
    assert.deepEqual(completedResponseFromRecoverableStream(failure)?.output, [tool]);
  });
});

test("an incomplete terminal response recovers only completed output items", async () => {
  const completedTool = { ...completion().output[0], status: "completed" };
  const incompleteMessage = {
    type: "message",
    id: "msg-partial",
    role: "assistant",
    status: "incomplete",
    content: [{ type: "output_text", text: "partial" }],
  };
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sse("response.incomplete", {
      response: {
        id: "resp-incomplete",
        model: MODEL_ALIAS,
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [completedTool, incompleteMessage],
      },
    }));
  }, async (endpoint) => {
    let failure;
    try {
      await runResponsesBridge({ endpoint, body: {} });
    } catch (error) {
      failure = error;
    }
    assert.match(failure?.message || "", /max_output_tokens/);
    assert.deepEqual(completedResponseFromRecoverableStream(failure)?.output, [completedTool]);
  });
});

test("consumer callback failures are explicit protocol errors, not resumable stream failures", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sse("response.in_progress", { response: { status: "in_progress" } }));
  }, async (endpoint) => {
    await assert.rejects(
      runResponsesBridge({
        endpoint,
        body: {},
        onEvent: async () => { throw new Error("fixture callback rejected"); },
      }),
      (error) => error.recoverableStreamFailure !== true && /event handler failed/.test(error.message),
    );
  });
});

test("transport heartbeats do not hide provider silence while explicit provider activity extends it", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(sse("response.created", { response: { id: "resp-silent", status: "in_progress" } }));
  }, async (endpoint) => {
    await assert.rejects(
      runResponsesBridge({ endpoint, body: {}, inactivityTimeoutMs: 30 }),
      (error) => error.recoverableStreamFailure === true && /silent for 30ms/.test(error.message),
    );
  });

  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    let heartbeats = 0;
    const timer = setInterval(() => {
      heartbeats += 1;
      response.write(sse("response.in_progress", { response: { status: "in_progress" } }));
      if (heartbeats === 7) {
        clearInterval(timer);
        response.end(sse("response.completed", { response: completion() }));
      }
    }, 20);
  }, async (endpoint) => {
    await assert.rejects(
      runResponsesBridge({ endpoint, body: {}, inactivityTimeoutMs: 60 }),
      (error) => error.recoverableStreamFailure === true && /silent for 60ms/.test(error.message),
    );
  });

  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    let activities = 0;
    const timer = setInterval(() => {
      activities += 1;
      response.write(sse("response.in_progress", {
        response: { status: "in_progress", metadata: { provider_activity: `tool-${activities}` } },
      }));
      if (activities === 4) {
        clearInterval(timer);
        response.end(sse("response.completed", { response: completion() }));
      }
    }, 20);
  }, async (endpoint) => {
    assert.deepEqual(await runResponsesBridge({
      endpoint,
      body: {},
      inactivityTimeoutMs: 50,
    }), completion());
  });
});

test("the loopback Responses client rejects provider, HTTP, content, and size failures", async () => {
  await assert.rejects(
    runResponsesBridge({ endpoint: "http://127.0.0.1:1/v1/responses", body: {} }),
    /request failed/,
  );
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sse("response.failed", { response: { error: { message: "model removed" } } }));
  }, async (endpoint) => {
    await assert.rejects(runResponsesBridge({ endpoint, body: {} }), /model removed/);
  });
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sse("response.failed", {
      response: { error: { code: "provider_state_changed", message: "turn failed after an edit" } },
    }));
  }, async (endpoint) => {
    await assert.rejects(
      runResponsesBridge({ endpoint, body: {} }),
      (error) => error.routeCommitted === true && /after an edit/.test(error.message),
    );
  });
  await withServer((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end('{"error":"offline"}');
  }, async (endpoint) => {
    await assert.rejects(runResponsesBridge({ endpoint, body: {} }), /HTTP 503/);
  });
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  }, async (endpoint) => {
    await assert.rejects(runResponsesBridge({ endpoint, body: {} }), /unexpected content type/);
  });
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end("x".repeat(128));
  }, async (endpoint) => {
    await assert.rejects(runResponsesBridge({ endpoint, body: {}, maxResponseBytes: 64 }), /exceeded 64 bytes/);
  });
});

test("OAuth fallback validation rejects provider, model, auth, eager tools, and empty output", () => {
  assert.deepEqual(validateOAuthFallbackCompletion(completion(), EXPECTED), completion());
  const geminiCompletion = completion({
    metadata: { ...completion().metadata, actual_model: EXPECTED.models[1] },
  });
  assert.deepEqual(validateOAuthFallbackCompletion(geminiCompletion, EXPECTED), geminiCompletion);
  const rzMcpDisabledCompletion = completion({
    metadata: { ...completion().metadata, lazy_rzmcp_proxy_tools: 0 },
  });
  assert.deepEqual(
    validateOAuthFallbackCompletion(rzMcpDisabledCompletion, { ...EXPECTED, lazyRzMcpProxyTools: 0 }),
    rzMcpDisabledCompletion,
  );
  assert.throws(() => validateOAuthFallbackCompletion(completion({
    metadata: { ...completion().metadata, actual_provider: "codebuddy" },
  }), EXPECTED), /unexpected provider/);
  assert.throws(() => validateOAuthFallbackCompletion(completion({
    metadata: { ...completion().metadata, actual_model: "removed-model" },
  }), EXPECTED), /unexpected model/);
  assert.throws(() => validateOAuthFallbackCompletion(completion({
    metadata: { ...completion().metadata, auth_source: "api-key" },
  }), EXPECTED), /unexpected auth source/);
  assert.throws(() => validateOAuthFallbackCompletion(completion({
    metadata: { ...completion().metadata, codex_tool_schema_bytes_forwarded: 1 },
  }), EXPECTED), /lazy RzMCP/);
  assert.throws(() => validateOAuthFallbackCompletion(completion({ output: [] }), EXPECTED), /without output items/);
});

test("ordered routing stops after the first successful provider", async () => {
  const calls = [];
  const result = await runOrderedProviderChain({
    stages: [
      { name: "antigravity", run: async () => { calls.push("antigravity"); return "gemini"; } },
      { name: "devin", run: async () => { calls.push("devin"); return "glm"; } },
    ],
  });
  assert.deepEqual(result, { stage: "antigravity", value: "gemini", failures: [] });
  assert.deepEqual(calls, ["antigravity"]);
});

test("ordered routing reaches each later provider exactly once after uncommitted failures", async () => {
  const antigravityFailure = new Error("antigravity quota");
  const devinFailure = new Error("devin quota");
  const observed = [];
  const calls = [];
  const result = await runOrderedProviderChain({
    stages: [
      { name: "antigravity", run: async () => { calls.push("antigravity"); throw antigravityFailure; } },
      { name: "devin", run: async ({ failures }) => {
        calls.push("devin");
        assert.deepEqual(failures, [{ stage: "antigravity", error: antigravityFailure }]);
        throw devinFailure;
      } },
      { name: "ollama", run: async ({ failures }) => {
        calls.push("ollama");
        assert.deepEqual(failures, [
          { stage: "antigravity", error: antigravityFailure },
          { stage: "devin", error: devinFailure },
        ]);
        return "glm-5.3-flash";
      } },
      { name: "devin-free", run: async () => { calls.push("devin-free"); return "glm-5.2"; } },
    ],
    onStageFailure: (stage, error) => observed.push({ stage, error }),
  });
  assert.equal(result.stage, "ollama");
  assert.equal(result.value, "glm-5.3-flash");
  assert.deepEqual(result.failures, [
    { stage: "antigravity", error: antigravityFailure },
    { stage: "devin", error: devinFailure },
  ]);
  assert.deepEqual(calls, ["antigravity", "devin", "ollama"]);
  assert.deepEqual(observed, [
    { stage: "antigravity", error: antigravityFailure },
    { stage: "devin", error: devinFailure },
  ]);
});

test("client abort never starts the next ordered provider", async () => {
  const controller = new AbortController();
  let laterCalls = 0;
  await assert.rejects(runOrderedProviderChain({
    signal: controller.signal,
    stages: [
      { name: "antigravity", run: async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      } },
      { name: "devin", run: async () => { laterCalls += 1; } },
    ],
  }), /aborted/);
  assert.equal(laterCalls, 0);
});

test("a committed provider stream fails explicitly instead of mixing later output", async () => {
  const failure = Object.assign(new Error("stream failed after output"), { routeCommitted: true });
  const observed = [];
  let laterCalls = 0;
  await assert.rejects(runOrderedProviderChain({
    stages: [
      { name: "ollama", run: async () => { throw failure; } },
      { name: "devin-free", run: async () => { laterCalls += 1; } },
    ],
    onStageFailure: (stage, error) => observed.push({ stage, error }),
  }), /stream failed after output/);
  assert.equal(laterCalls, 0);
  assert.equal(failure.failedStage, "ollama");
  assert.deepEqual(observed, [{ stage: "ollama", error: failure }]);
});

test("the final provider failure is returned instead of being swallowed", async () => {
  const terminalFailure = new Error("free provider unavailable");
  await assert.rejects(runOrderedProviderChain({
    stages: [
      { name: "ollama", run: async () => { throw new Error("offline"); } },
      { name: "devin-free", run: async () => { throw terminalFailure; } },
    ],
  }), (error) => error === terminalFailure);
});
