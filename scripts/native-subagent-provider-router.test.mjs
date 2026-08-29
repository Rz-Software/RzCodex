import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  codeBuddyForwardBody,
  completedResponseFromSse,
  parseResponsesSse,
  runQuotaFallbackChain,
  runResponsesBridge,
  validateCodeBuddyCompletion,
} from "./native-subagent-provider-router.mjs";

const MODEL_ALIAS = "@preset/codex-subagents";
const EXPECTED = { model: "hy4-preview", authSource: "www.codebuddy.ai" };

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
      codebuddy_initialized_model: EXPECTED.model,
      codebuddy_auth_source: EXPECTED.authSource,
      codebuddy_total_cost_usd: 0,
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

test("CodeBuddy forwarding preserves the request and upgrades only provider effort", () => {
  const input = [{ type: "message", role: "user", content: "task" }];
  const forwarded = codeBuddyForwardBody({
    model: MODEL_ALIAS,
    stream: true,
    reasoning: { effort: "high", summary: "none" },
    input,
  }, MODEL_ALIAS, "max");
  assert.deepEqual(forwarded, {
    model: MODEL_ALIAS,
    stream: true,
    reasoning: { effort: "max", summary: "none" },
    input,
  });
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

test("the loopback Responses client accepts chunked CodeBuddy completion", async () => {
  const raw = sse("response.completed", { response: completion() });
  await withServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, undefined);
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    response.write(raw.slice(0, 37));
    setImmediate(() => response.end(raw.slice(37)));
  }, async (endpoint) => {
    const result = await runResponsesBridge({ endpoint, body: { stream: true } });
    assert.deepEqual(result, completion());
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

test("CodeBuddy completion validation rejects model, auth, cost, and empty-output fallback", () => {
  assert.deepEqual(validateCodeBuddyCompletion(completion(), EXPECTED), completion());
  assert.throws(() => validateCodeBuddyCompletion(completion({
    metadata: { ...completion().metadata, codebuddy_initialized_model: "removed-model" },
  }), EXPECTED), /unexpected model/);
  assert.throws(() => validateCodeBuddyCompletion(completion({
    metadata: { ...completion().metadata, codebuddy_auth_source: "api-key" },
  }), EXPECTED), /unexpected auth source/);
  assert.throws(() => validateCodeBuddyCompletion(completion({
    metadata: { ...completion().metadata, codebuddy_total_cost_usd: 0.01 },
  }), EXPECTED), /non-zero or unknown explicit cost/);
  assert.throws(() => validateCodeBuddyCompletion(completion({ output: [] }), EXPECTED), /without output items/);
});

test("quota fallback prefers CodeBuddy and does not touch the terminal Devin route", async () => {
  let terminalCalls = 0;
  const result = await runQuotaFallbackChain({
    runCodeBuddy: async () => "hy4",
    runTerminal: async () => { terminalCalls += 1; return "glm"; },
  });
  assert.deepEqual(result, { stage: "codebuddy", value: "hy4", codeBuddyError: null });
  assert.equal(terminalCalls, 0);
});

test("any CodeBuddy availability failure reaches terminal Devin exactly once", async () => {
  const failure = new Error("unreachable");
  const observed = [];
  let terminalCalls = 0;
  const result = await runQuotaFallbackChain({
    runCodeBuddy: async () => { throw failure; },
    runTerminal: async (error) => { terminalCalls += 1; assert.equal(error, failure); return "glm"; },
    onCodeBuddyFailure: (error) => observed.push(error),
  });
  assert.equal(result.stage, "terminal");
  assert.equal(result.value, "glm");
  assert.equal(result.codeBuddyError, failure);
  assert.deepEqual(observed, [failure]);
  assert.equal(terminalCalls, 1);
});

test("client abort never starts terminal fallback", async () => {
  const controller = new AbortController();
  let terminalCalls = 0;
  await assert.rejects(runQuotaFallbackChain({
    signal: controller.signal,
    runCodeBuddy: async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    },
    runTerminal: async () => { terminalCalls += 1; },
  }), /aborted/);
  assert.equal(terminalCalls, 0);
});
