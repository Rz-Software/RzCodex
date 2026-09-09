import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BridgePolicyError,
  assertToolCallAllowed,
  bridgeAuthorizationHeaders,
  bridgeBearerTokenPath,
  codexHome,
  createAuthenticatedBridgeServer,
  executionPolicy,
  loadBridgeBearerToken,
  sanitizeChildEnvironment,
  setupBridgeBearerToken,
  toolEffects,
  toolVisibleUnderPolicy,
  validateBridgeRequest,
} from "./bridge-security.mjs";

const TOKEN = "a".repeat(43);

function requestFixture({
  address = "127.0.0.1",
  method = "POST",
  authorization = `Bearer ${TOKEN}`,
  contentType = "application/json",
  origin,
  extraRawHeaders = [],
} = {}) {
  const headers = { authorization, "content-type": contentType };
  if (origin !== undefined) headers.origin = origin;
  const rawHeaders = ["authorization", authorization, "content-type", contentType];
  if (origin !== undefined) rawHeaders.push("origin", origin);
  rawHeaders.push(...extraRawHeaders);
  return { method, headers, rawHeaders, socket: { remoteAddress: address } };
}

function tool(name, metadata) {
  return { name, _meta: { "rzcodex/execution": { version: 1, ...metadata } } };
}

test("token setup is explicit, stable, and honors CODEX_HOME", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rzcodex-bridge-security-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { CODEX_HOME: join(root, "custom") };
  const expectedPath = join(root, "custom", "bridge-security", "bearer-token");
  assert.equal(codexHome(env, join(root, "ignored")), join(root, "custom"));
  assert.equal(bridgeBearerTokenPath({ env }), expectedPath);
  const first = setupBridgeBearerToken({ env });
  const second = setupBridgeBearerToken({ env });
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(second, first);
  assert.equal(loadBridgeBearerToken({ env }), first);
  assert.equal(readFileSync(expectedPath, "utf8"), `${first}\n`);
});

test("authorization headers replace caller credentials without exposing a second value", () => {
  assert.deepEqual(
    bridgeAuthorizationHeaders(TOKEN, { Authorization: "Bearer old", accept: "application/json" }),
    { accept: "application/json", authorization: `Bearer ${TOKEN}` },
  );
});

test("request validation enforces loopback JSON bearer transport", () => {
  assert.deepEqual(validateBridgeRequest(requestFixture(), { token: TOKEN }), {
    ok: true,
    statusCode: 200,
    message: "ok",
  });
  assert.equal(validateBridgeRequest(requestFixture({ address: "192.0.2.1" }), { token: TOKEN }).statusCode, 403);
  assert.equal(validateBridgeRequest(requestFixture({ origin: "https://hostile.example" }), { token: TOKEN }).statusCode, 403);
  assert.equal(validateBridgeRequest(requestFixture({ contentType: "text/plain" }), { token: TOKEN }).statusCode, 415);
  assert.equal(validateBridgeRequest(requestFixture({ authorization: "Bearer wrong" }), { token: TOKEN }).statusCode, 401);
  assert.equal(
    validateBridgeRequest(requestFixture({ extraRawHeaders: ["Authorization", `Bearer ${TOKEN}`] }), { token: TOKEN }).statusCode,
    401,
  );
  assert.equal(
    validateBridgeRequest(requestFixture({ extraRawHeaders: ["x-large", "x".repeat(17 * 1024)] }), { token: TOKEN }).statusCode,
    431,
  );
});

function sendRequest(port, { authorization = `Bearer ${TOKEN}`, contentType = "application/json", origin } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { authorization, "content-type": contentType };
    if (origin !== undefined) headers.origin = origin;
    const request = httpRequest({ host: "127.0.0.1", port, path: "/v1/responses", method: "POST", headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ statusCode: response.statusCode, body }));
    });
    request.once("error", reject);
    request.end("{}\n");
  });
}

test("authenticated HTTP server rejects invalid transport before invoking its listener", async (t) => {
  let listenerCalls = 0;
  const server = createAuthenticatedBridgeServer((_request, response) => {
    listenerCalls += 1;
    response.writeHead(204);
    response.end();
  }, { token: TOKEN });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;

  assert.deepEqual(await sendRequest(port, { authorization: "Bearer wrong" }), {
    statusCode: 401,
    body: "{\"error\":\"Bridge authentication failed\"}\n",
  });
  assert.equal(listenerCalls, 0);
  assert.equal((await sendRequest(port, { origin: "https://hostile.example" })).statusCode, 403);
  assert.equal(listenerCalls, 0);
  assert.equal((await sendRequest(port, { contentType: "text/plain" })).statusCode, 415);
  assert.equal(listenerCalls, 0);
  assert.equal((await sendRequest(port)).statusCode, 204);
  assert.equal(listenerCalls, 1);
});

test("authenticated HTTP server sanitizes synchronous listener failures", async (t) => {
  const server = createAuthenticatedBridgeServer(() => {
    throw new Error("sensitive fixture detail");
  }, { token: TOKEN });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const response = await sendRequest(server.address().port);
  assert.deepEqual(response, {
    statusCode: 500,
    body: "{\"error\":\"Bridge request failed\"}\n",
  });
  assert.doesNotMatch(response.body, /sensitive fixture detail/);
});

test("child environments retain only the selected provider credentials and never bridge secrets", () => {
  const source = {
    PATH: "fixture-path",
    OPENAI_API_KEY: "openai-secret",
    DEVIN_API_KEY: "devin-secret",
    TENCENTCLOUD_SECRET_KEY: "codebuddy-secret",
    RZCODEX_BRIDGE_BEARER_TOKEN: "bridge-secret",
    AUTHORIZATION: "Bearer bridge-secret",
    openai_api_key: "mixed-case-openai-secret",
    rzCodex_bridge_token: "mixed-case-bridge-secret",
    CURSOR_API_KEY: "cursor-secret",
    GITHUB_TOKEN: "unrelated-token",
    AZURE_CLIENT_SECRET: "unrelated-secret",
  };
  assert.deepEqual(sanitizeChildEnvironment(source, { credentialScope: "devin" }), {
    PATH: "fixture-path",
    DEVIN_API_KEY: "devin-secret",
    NO_COLOR: "1",
  });
  assert.deepEqual(sanitizeChildEnvironment(source), { PATH: "fixture-path", NO_COLOR: "1" });
  assert.deepEqual(sanitizeChildEnvironment(source, { credentialScope: "cursor" }), {
    PATH: "fixture-path",
    CURSOR_API_KEY: "cursor-secret",
    NO_COLOR: "1",
  });
});

test("execution policy resolves RzMCP modes without task-level permission gates", () => {
  assert.deepEqual(executionPolicy(), { rzMcpMode: "full" });
  assert.deepEqual(executionPolicy({ rzMcpMode: "no-validation" }), { rzMcpMode: "no-validation" });
  assert.throws(
    () => executionPolicy({ rzMcpMode: "fixture" }),
    (error) => error instanceof BridgePolicyError && /Unknown RzMCP mode/.test(error.message),
  );
});

test("direct and nested tool effects are resolved only from authoritative metadata", () => {
  const inspect = tool("inspect_graph", { defaultEffects: ["read"] });
  const manage = tool("manage_asset", {
    defaultEffects: ["write", "validation", "editor-control"],
    argumentRules: [
      { path: ["action"], values: ["get", "list"], effects: ["read"] },
      { path: ["action"], values: ["set"], effects: ["write"] },
      { path: ["action"], values: ["compile"], effects: ["validation"] },
    ],
  });
  const batch = tool("batch_graph", {
    defaultEffects: ["write", "validation", "editor-control"],
    argumentRules: [
      { path: ["operations", "*", "action"], values: ["inspect"], effects: ["read"] },
      { path: ["operations", "*", "action"], values: ["delete"], effects: ["write"] },
    ],
  });
  assert.deepEqual(toolEffects(inspect), ["read"]);
  assert.deepEqual(toolEffects(manage, { action: "set" }), ["write"]);
  assert.deepEqual(toolEffects(batch, { operations: [{ action: "inspect" }, { action: "delete" }] }), ["read", "write"]);
  assert.throws(
    () => toolEffects(batch, { operations: [{ action: "inspect" }, {}] }),
    /requires exactly one execution selector/,
  );
  assert.throws(() => toolEffects(manage, { action: "unknown" }), /unknown or ambiguous/);
  assert.throws(() => toolEffects(manage, {}), /requires (?:exactly one|an) execution selector/);
  const aliases = tool("aliased_action", {
    defaultEffects: ["write", "validation", "editor-control"],
    argumentRules: [
      { selector: "action", path: ["action"], values: ["get"], effects: ["read"] },
      { selector: "action", path: ["params", "action"], values: ["get"], effects: ["read"] },
    ],
  });
  assert.deepEqual(toolEffects(aliases, { params: { action: "get" } }), ["read"]);
  assert.throws(
    () => toolEffects(aliases, { action: "get", params: { action: "get" } }),
    /exactly one execution selector/,
  );
  const conflicting = tool("conflicting_rules", {
    defaultEffects: ["write", "validation", "editor-control"],
    argumentRules: [
      { path: ["action"], values: ["inspect"], effects: ["read"] },
      { path: ["action"], values: ["inspect"], effects: ["write"] },
    ],
  });
  assert.throws(() => toolEffects(conflicting, { action: "inspect" }), /unknown or ambiguous/);
});

test("restricted tool policy gates actual nested calls while full mode remains unchanged", () => {
  const readOnly = executionPolicy({ rzMcpMode: "read-only" });
  const noValidation = executionPolicy({ rzMcpMode: "no-validation" });
  const full = executionPolicy();
  const manage = tool("manage_asset", {
    defaultEffects: ["write", "validation", "editor-control"],
    argumentRules: [
      { path: ["params", "action"], values: ["get"], effects: ["read"] },
      { path: ["params", "action"], values: ["set"], effects: ["write"] },
      { path: ["params", "action"], values: ["compile"], effects: ["validation"] },
    ],
  });
  assert.equal(toolVisibleUnderPolicy(readOnly, manage), true);
  assert.deepEqual(assertToolCallAllowed(readOnly, manage, { params: { action: "get" } }), ["read"]);
  assert.throws(() => assertToolCallAllowed(readOnly, manage, { params: { action: "set" } }), /not allowed/);
  assert.deepEqual(assertToolCallAllowed(noValidation, manage, { params: { action: "set" } }), ["write"]);
  assert.throws(() => assertToolCallAllowed(noValidation, manage, { params: { action: "compile" } }), /not allowed/);
  assert.deepEqual(assertToolCallAllowed(full, { name: "legacy-without-metadata" }, {}), []);
  assert.throws(() => assertToolCallAllowed(readOnly, { name: "missing-metadata" }, {}), /no authoritative/);

  const executeCode = tool("execute_python", {
    defaultEffects: ["write", "validation", "editor-control"],
  });
  assert.throws(() => assertToolCallAllowed(readOnly, executeCode, { code: "pass" }), /not allowed/);
  assert.throws(() => assertToolCallAllowed(noValidation, executeCode, { code: "pass" }), /not allowed/);
  assert.deepEqual(assertToolCallAllowed(full, executeCode, { code: "pass" }), []);
});

test("RzMCP mode alone cannot weaken its declared tool boundary", () => {
  const inspect = tool("inspect", { defaultEffects: ["read"] });
  const write = tool("write", { defaultEffects: ["write"] });
  const validate = tool("validate", { defaultEffects: ["validation"] });
  const modeOnlyRead = executionPolicy({ rzMcpMode: "read-only" });
  const modeOnlyNoValidation = executionPolicy({ rzMcpMode: "no-validation" });

  assert.deepEqual(assertToolCallAllowed(modeOnlyRead, inspect), ["read"]);
  assert.throws(() => assertToolCallAllowed(modeOnlyRead, write), /not allowed/);
  assert.deepEqual(assertToolCallAllowed(modeOnlyNoValidation, write), ["write"]);
  assert.throws(() => assertToolCallAllowed(modeOnlyNoValidation, validate), /not allowed/);
});
