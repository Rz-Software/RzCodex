#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  TaskStateError,
  activeTaskPromptSection,
  normalizeAgentMessageContent,
  taskDeliveryDiagnostics,
  taskStateFromInput,
} from "./codebuddy-subagent-task-state.mjs";

const PROVIDER_ID = "devin";
const MODEL_ALIAS = "@preset/codex-subagents";
const REQUIRED_EFFORT = "max";
const DEFAULT_PORT = 54548;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_PROMPT_CHARS = 100_000;
const MAX_ACTIVE_TASK_CHARS = 40_000;
const OUTPUT_LIMIT = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
const SSE_HEARTBEAT_MS = 15 * 1000;
const FREE_ROUTE_CONCURRENCY = 2;
const RESOURCE_BACKOFF_BASE_MS = 5 * 1000;
const RESOURCE_BACKOFF_MAX_MS = 2 * 60 * 1000;
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const CENTRAL_CONFIG = join(homedir(), ".codex", "subagent-models.json");
const USER_DEVIN_CONFIG = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "devin", "config.json");
const DEVIN_HOME = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "RzCodex", "devin-subagents");
const ISOLATED_CONFIG = join(DEVIN_HOME, "config.json");
const REQUEST_DIRECTORY = join(DEVIN_HOME, "requests");
const ROUTE_STATE_PATH = join(DEVIN_HOME, "route-state.json");
const DEVIN_EXE = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "devin", "cli", "bin", "devin.exe");
const DEVIN_DB = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "devin", "cli", "sessions.db");
const COMPLEX_SIGNALS = [
  /\bcomplex\b/i,
  /\broot[- ]cause\b/i,
  /\b(?:crash|deadlock|race condition|memory corruption|heisenbug)\b/i,
  /\b(?:concurrency|lifetime|replication|distributed)\b/i,
  /\b(?:architecture|protocol|transport)\b/i,
  /\b(?:trace|profil(?:e|ing)|performance regression)\b/i,
  /\b(?:security audit|vulnerability chain)\b/i,
];
const QUOTA_FAILURE = /(?:daily|weekly|included|usage)[\s\S]{0,100}quota[\s\S]{0,100}(?:exhaust|exceed|reach|limit)|quota[\s\S]{0,100}(?:exhaust|exceed|reach|limit)/i;
const RESOURCE_EXHAUSTED = /cognition\.ai\/errorKind[\s\S]{0,100}resource_exhausted|resource_exhausted[\s\S]{0,100}cognition\.ai\/retryable[\s\S]{0,20}true/i;

class BridgeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
  }
}

function json(value) {
  return JSON.stringify(value);
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BridgeError(`${label} must be an object`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new BridgeError(`${label} must be a non-empty string`);
  return value;
}

function sanitizedEnvironment() {
  const env = { ...process.env, NO_COLOR: "1" };
  for (const key of [
    "DEVIN_API_KEY", "DEVIN_ORG_ID", "COGNITION_API_KEY", "OPENROUTER_API_KEY",
    "TENCENT_API_KEY", "TENCENTCLOUD_SECRET_ID", "TENCENTCLOUD_SECRET_KEY",
    "CODEBUDDY_API_KEY", "OPENCODE_API_KEY", "COMMAND_CODE_API_KEY",
  ]) delete env[key];
  return env;
}

function centralRoute() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(CENTRAL_CONFIG, "utf8"));
  } catch (error) {
    throw new BridgeError(`Cannot read central subagent configuration: ${error.message}`, 500);
  }
  const route = assertObject(parsed[PROVIDER_ID], `central route ${PROVIDER_ID}`);
  const inputModalities = route.inputModalities;
  if (!Array.isArray(inputModalities) || inputModalities.length !== 1 || inputModalities[0] !== "text") {
    throw new BridgeError("Devin managed route must declare exactly the text modality", 500);
  }
  return {
    primaryModel: requireString(route.primaryModel, "primaryModel"),
    quotaFallbackModel: requireString(route.quotaFallbackModel, "quotaFallbackModel"),
    complexModel: requireString(route.complexModel, "complexModel"),
    inputModalities,
  };
}

function modelCatalog() {
  const result = spawnSync(DEVIN_EXE, ["models", "list", "--format", "json"], {
    env: sanitizedEnvironment(), windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new BridgeError(`Cannot query Devin models: ${result.stderr || result.stdout}`, 500);
  const parsed = JSON.parse(result.stdout);
  return (parsed.families || []).flatMap((family) => family.variants || []);
}

function authStatus() {
  const result = spawnSync(DEVIN_EXE, ["auth", "status"], {
    env: sanitizedEnvironment(), windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024,
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0 || !output.includes("Logged in (via Devin).")) {
    throw new BridgeError("Devin CLI is not authenticated through its existing Devin session", 500);
  }
  return {
    source: "Devin authenticated session",
    tier: /^\s*Tier:\s*(.+)$/m.exec(output)?.[1]?.trim() || null,
    plan: /^\s*Plan:\s*(.+)$/m.exec(output)?.[1]?.trim() || null,
  };
}

function ensureRuntimeConfig() {
  const source = JSON.parse(readFileSync(USER_DEVIN_CONFIG, "utf8"));
  const orgId = requireString(source.devin?.org_id, "Devin org_id");
  mkdirSync(DEVIN_HOME, { recursive: true });
  mkdirSync(REQUEST_DIRECTORY, { recursive: true });
  writeFileSync(ISOLATED_CONFIG, `${json({
    version: 1,
    devin: { org_id: orgId },
    shell: { setup_complete: true },
    theme_mode: "nocolor",
    subagents_enabled: false,
    attribution: false,
    read_config_from: {
      agents_standard: true,
      cursor: false,
      windsurf: false,
      claude: false,
      copilot: false,
      opencode: false,
      zed: false,
    },
  })}\n`, "utf8");
}

if (!existsSync(DEVIN_EXE)) throw new BridgeError(`Devin CLI is missing at ${DEVIN_EXE}`, 500);
if (!existsSync(DEVIN_DB)) throw new BridgeError(`Devin session database is missing at ${DEVIN_DB}`, 500);
ensureRuntimeConfig();
const route = centralRoute();
const catalog = modelCatalog();
const auth = authStatus();

function catalogModel(uid, expectedLabel, mustBeFree) {
  const model = catalog.find((entry) => entry.model_uid === uid);
  if (!model) throw new BridgeError(`Configured Devin model ${json(uid)} is unavailable`, 500);
  if (expectedLabel && model.label !== expectedLabel) {
    throw new BridgeError(`Configured Devin model ${json(uid)} resolved to ${json(model.label)}`, 500);
  }
  if (mustBeFree && model.cost_tier !== "Free") {
    throw new BridgeError(`Configured Devin fallback ${json(uid)} is not free: ${json(model.cost_summary || model.cost_tier)}`, 500);
  }
  return model;
}

const models = {
  primary: catalogModel(route.primaryModel, "SWE-1.7 Lightning Max", false),
  fallback: catalogModel(route.quotaFallbackModel, "SWE-1.7 Max", true),
  complex: catalogModel(route.complexModel, "SWE-1.7 Max", true),
};

function loadRouteState() {
  try {
    const parsed = JSON.parse(readFileSync(ROUTE_STATE_PATH, "utf8"));
    return { lightningFallbackUntil: Number(parsed.lightningFallbackUntil) || 0 };
  } catch {
    return { lightningFallbackUntil: 0 };
  }
}

function saveRouteState(state) {
  writeFileSync(ROUTE_STATE_PATH, `${json(state)}\n`, "utf8");
}

let routeState = loadRouteState();

const runtime = {
  incomingRequests: 0, requests: 0, completed: 0, failed: 0, rejected: 0,
  activeRequests: 0, activeFreeRequests: 0, queuedFreeRequests: 0,
  resourceRetries: 0, activeResourceBackoffs: 0,
  lastResourceModel: null, lastResourceRetryAttempt: 0,
  lastResourceBackoffMs: 0, lastResourceRetryAt: null,
  lastRejectedError: null, lastConfiguredRoute: null, lastActualModel: null,
  lastModelLabel: null, lastQuotaFallback: false, lastCreditCost: null, lastAcuCost: null,
  lastInputTokens: null, lastCachedInputTokens: null, lastOutputTokens: null,
  lastPeakTurnContextTokens: null, lastOutputTokensPerSecond: null,
  lastNativeToolCalls: 0, lastNativeToolNames: [], lastRzMcpTools: [],
  lastWorkingDirectory: null, lastTaskId: null, lastTaskName: null, lastTaskHash: null,
  lastTaskIntent: null, lastTaskDeliveryMode: null, lastTaskPartTypes: [],
  lastTaskPartLengths: [], lastCompleteTaskDelivered: false,
};

const freeCapacity = { active: 0, waiters: [] };

function syncFreeCapacityRuntime() {
  runtime.activeFreeRequests = freeCapacity.active;
  runtime.queuedFreeRequests = freeCapacity.waiters.length;
}

function abortError() {
  return new BridgeError("Client disconnected while Devin work was active", 499);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function delayWithAbort(milliseconds, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => finish(abortError());
    function finish(error) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function acquireFreeCapacity(signal) {
  throwIfAborted(signal);
  if (freeCapacity.active < FREE_ROUTE_CONCURRENCY) {
    freeCapacity.active += 1;
    syncFreeCapacityRuntime();
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal, onAbort: null };
    waiter.onAbort = () => {
      const index = freeCapacity.waiters.indexOf(waiter);
      if (index !== -1) freeCapacity.waiters.splice(index, 1);
      syncFreeCapacityRuntime();
      reject(abortError());
    };
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    freeCapacity.waiters.push(waiter);
    syncFreeCapacityRuntime();
  });
}

function releaseFreeCapacity() {
  freeCapacity.active = Math.max(0, freeCapacity.active - 1);
  while (freeCapacity.waiters.length > 0) {
    const waiter = freeCapacity.waiters.shift();
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    if (waiter.signal?.aborted) continue;
    freeCapacity.active += 1;
    waiter.resolve();
    break;
  }
  syncFreeCapacityRuntime();
}

async function withRouteCapacity(selected, signal, callback) {
  if (selected.key === "primary") return callback();
  await acquireFreeCapacity(signal);
  try {
    return await callback();
  } finally {
    releaseFreeCapacity();
  }
}

function workingDirectoryFrom(body) {
  const cwd = body.client_metadata?.cwd;
  if (typeof cwd === "string" && isAbsolute(cwd) && existsSync(cwd)) return cwd;
  return process.cwd();
}

function contentText(value, label) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw new BridgeError(`${label} must be a string or array`);
  return value.map((entry, index) => {
    const item = assertObject(entry, `${label}[${index}]`);
    if (!["input_text", "output_text", "text"].includes(item.type)) return "";
    return requireString(item.text, `${label}[${index}].text`);
  }).join("");
}

function outputText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return json(value);
  return value.map((entry) => typeof entry === "string" ? entry : (entry?.text || json(entry))).join("");
}

function roleInstructionsFrom(value) {
  if (typeof value !== "string") return "";
  const matches = [...value.matchAll(/<external_cli_route_instructions>([\s\S]*?)<\/external_cli_route_instructions>/gi)];
  return matches.at(-1)?.[1]?.trim() || "";
}

function promptFrom(body) {
  assertObject(body, "request body");
  if (body.stream !== true) throw new BridgeError("The Devin bridge requires stream=true");
  if (requireString(body.model, "model") !== MODEL_ALIAS) throw new BridgeError(`Unknown managed model alias ${json(body.model)}`);
  const effort = body.reasoning?.effort;
  if (effort !== undefined && effort !== REQUIRED_EFFORT) throw new BridgeError(`Devin subagents require effort ${REQUIRED_EFFORT}`);
  const input = typeof body.input === "string" ? [{ type: "message", role: "user", content: body.input }] : body.input;
  if (!Array.isArray(input)) throw new BridgeError("input must be a string or array");
  let taskState;
  try {
    taskState = taskStateFromInput(input, MAX_ACTIVE_TASK_CHARS);
  } catch (error) {
    if (error instanceof TaskStateError) throw new BridgeError(error.message);
    throw error;
  }
  const requestId = randomUUID();
  const workingDirectory = workingDirectoryFrom(body);
  const sections = [
    `[Native Devin delegation contract]\nRzCodex request ID: ${requestId}\nWork directly in the supplied workspace as the bounded native sub-agent. Use local Devin tools for files and commands. Do not spawn Devin subagents. For Unreal/RzMCP work, use only MCP server rzcodex-lazy: list that server's two proxy tools, call search_rzmcp_tools with an exact or focused query, then call only a discovered tool through call_rzmcp_tool. Never use or request the full RzMCP catalog. Return concise evidence as soon as the bounded task is complete or genuinely blocked.\nAuthoritative workspace: ${workingDirectory}`,
  ];
  const roleInstructions = roleInstructionsFrom(body.instructions);
  if (roleInstructions) sections.push(`[Role instructions]\n${roleInstructions}`);
  const agentMessages = new Map(taskState.messages.map((message) => [message.index, message]));
  const history = [];
  for (let index = 0; index < input.length; index += 1) {
    const item = assertObject(input[index], `input[${index}]`);
    if (item.type === "message") {
      if (!["system", "developer"].includes(item.role)) history.push({ index, text: `[${item.role}]\n${contentText(item.content, `input[${index}].content`)}` });
    } else if (item.type === "agent_message") {
      const message = agentMessages.get(index) ?? {
        ...normalizeAgentMessageContent(item.content, `input[${index}].content`),
        author: item.author || "Codex", recipient: item.recipient || "managed worker", newTask: false, checkpoint: false,
      };
      if (message.newTask && !message.checkpoint) continue;
      history.push({ index, text: `[Inter-agent message ${message.author} -> ${message.recipient}]\n${message.text}` });
    } else if (["function_call", "custom_tool_call", "tool_search_call"].includes(item.type)) {
      history.push({ index, text: `[Prior Codex tool request ${item.name || "tool_search"}; call_id=${item.call_id}]` });
    } else if (["function_call_output", "custom_tool_call_output"].includes(item.type)) {
      history.push({ index, text: `[Prior Codex tool result; call_id=${item.call_id}]\n${outputText(item.output)}` });
    } else if (item.type === "tool_search_output") {
      history.push({ index, text: `[Prior Codex tool search result; call_id=${item.call_id}]` });
    } else if (item.type === "reasoning") {
      const summary = Array.isArray(item.summary) ? item.summary.map((part) => part?.text || "").join("") : "";
      if (summary) history.push({ index, text: `[Prior reasoning summary]\n${summary}` });
    } else if (!["compaction", "context_compaction", "compaction_trigger"].includes(item.type)) {
      throw new BridgeError(`input[${index}] has unsupported type ${json(item.type)}`);
    }
  }
  let retainedChars = 0;
  const retained = [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const { text } = history[index];
    if (retainedChars + text.length > MAX_PROMPT_CHARS && retained.length > 0) break;
    retained.unshift({ ...history[index], text: text.slice(-MAX_PROMPT_CHARS) });
    retainedChars += text.length;
  }
  const activeTask = activeTaskPromptSection(taskState);
  if (activeTask) {
    const activeTaskIndex = taskState.activeTask.index;
    sections.push(...retained.filter((item) => item.index < activeTaskIndex).map((item) => item.text));
    sections.push(activeTask);
    sections.push(...retained.filter((item) => item.index > activeTaskIndex).map((item) => item.text));
  } else {
    sections.push(...retained.map((item) => item.text));
  }
  const prompt = sections.join("\n\n");
  let taskDiagnostics;
  try {
    taskDiagnostics = taskDeliveryDiagnostics(taskState, prompt);
  } catch (error) {
    if (error instanceof TaskStateError) throw new BridgeError(error.message);
    throw error;
  }
  const toolSchemaBytes = Buffer.byteLength(json(body.tools || []));
  return { requestId, prompt, workingDirectory, taskState, taskDiagnostics, toolSchemaBytes };
}

function chooseRoute(context) {
  const payload = context.taskState.activeTask?.text || context.prompt;
  const complexScore = COMPLEX_SIGNALS.filter((pattern) => pattern.test(payload)).length;
  if (complexScore >= 2 || COMPLEX_SIGNALS[0].test(payload)) {
    return { key: "complex", model: models.complex, reason: `complex_score_${complexScore}` };
  }
  if (Date.now() < routeState.lightningFallbackUntil) {
    return { key: "fallback", model: models.fallback, reason: "quota_latch" };
  }
  return { key: "primary", model: models.primary, reason: "default" };
}

function dimension(metadata, uid) {
  const entry = metadata.response_dimensions?.find((item) => item.uid === uid);
  const kind = entry?.kind || {};
  return kind.CumulativeMetric?.value ?? kind.Metric?.value ?? null;
}

function uniqueToolCalls(toolRows) {
  const toolCalls = [];
  const seenToolCallIds = new Set();
  for (const row of toolRows) {
    for (const call of JSON.parse(row.tool_calls || "[]")) {
      const callId = typeof call?.id === "string" ? call.id : null;
      if (callId && seenToolCallIds.has(callId)) continue;
      if (callId) seenToolCallIds.add(callId);
      toolCalls.push(call);
    }
  }
  return toolCalls;
}

function inspectSession(requestId) {
  const db = new DatabaseSync(DEVIN_DB, { readOnly: true });
  try {
    const session = db.prepare(`
      SELECT s.id, s.model, s.metadata
      FROM sessions s
      JOIN message_nodes m ON m.session_id = s.id
      WHERE instr(m.chat_message, ?) > 0
      ORDER BY s.last_activity_at DESC
      LIMIT 1
    `).get(requestId);
    if (!session) return null;
    const metrics = db.prepare(`
      SELECT DISTINCT json_extract(chat_message, '$.metadata.metrics') AS metrics
      FROM message_nodes
      WHERE session_id = ? AND json_extract(chat_message, '$.metadata.metrics') IS NOT NULL
    `).all(session.id).map((row) => JSON.parse(row.metrics));
    const toolRows = db.prepare(`
      SELECT DISTINCT json_extract(chat_message, '$.tool_calls') AS tool_calls
      FROM message_nodes
      WHERE session_id = ? AND json_type(chat_message, '$.tool_calls') = 'array'
    `).all(session.id);
    const toolCalls = uniqueToolCalls(toolRows);
    return { id: session.id, model: session.model, metadata: JSON.parse(session.metadata || "{}"), metrics, toolCalls };
  } finally {
    db.close();
  }
}

async function waitForSession(requestId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const session = inspectSession(requestId);
    if (session) return session;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

function removeSession(sessionId) {
  if (!sessionId) return;
  const result = spawnSync(DEVIN_EXE, ["--config", ISOLATED_CONFIG, "rm", "--force", sessionId], {
    env: sanitizedEnvironment(), windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw new BridgeError(`Failed to remove ephemeral Devin session ${sessionId}`, 502);
}

function runCli(context, selectedModel, onSpawn, timeoutMs = REQUEST_TIMEOUT_MS) {
  const promptPath = join(REQUEST_DIRECTORY, `${context.requestId}.txt`);
  writeFileSync(promptPath, context.prompt, { encoding: "utf8", flag: "wx" });
  const args = [
    "--config", ISOLATED_CONFIG, "--model", selectedModel.model_uid,
    "--permission-mode", "dangerous", "--respect-workspace-trust", "false",
    "-p", "--prompt-file", promptPath,
  ];
  const child = spawn(DEVIN_EXE, args, {
    cwd: context.workingDirectory, env: sanitizedEnvironment(), windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  onSpawn(child);
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { unlinkSync(promptPath); } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT" && !error) error = cleanupError;
      }
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new BridgeError(`Devin exceeded ${timeoutMs}ms`, 504));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-OUTPUT_LIMIT); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-OUTPUT_LIMIT); });
    child.once("error", (error) => finish(new BridgeError(`Devin failed to start: ${error.message}`, 502)));
    child.once("close", (code) => finish(undefined, { code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

function resourceBackoffMs(attempt) {
  return Math.min(RESOURCE_BACKOFF_BASE_MS * (2 ** Math.max(0, attempt - 1)), RESOURCE_BACKOFF_MAX_MS);
}

async function runCliWithResourceRetries(context, selectedModel, onSpawn, signal, deadline) {
  let attempt = 0;
  while (true) {
    throwIfAborted(signal);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new BridgeError("Devin resource retry deadline exceeded", 504);
    const cliResult = await runCli(context, selectedModel, onSpawn, remainingMs);
    const session = await waitForSession(context.requestId);
    const combined = `${cliResult.stdout}\n${cliResult.stderr}`;
    const retryableResourceFailure = (cliResult.code !== 0 || !cliResult.stdout)
      && RESOURCE_EXHAUSTED.test(combined);
    if (!retryableResourceFailure) return { cliResult, session };
    if (session) removeSession(session.id);
    attempt += 1;
    const backoffMs = resourceBackoffMs(attempt);
    if (Date.now() + backoffMs >= deadline) {
      throw new BridgeError("Devin remained resource exhausted until the request deadline", 504);
    }
    runtime.resourceRetries += 1;
    runtime.lastResourceModel = selectedModel.model_uid;
    runtime.lastResourceRetryAttempt = attempt;
    runtime.lastResourceBackoffMs = backoffMs;
    runtime.lastResourceRetryAt = Date.now() + backoffMs;
    runtime.activeResourceBackoffs += 1;
    try {
      await delayWithAbort(backoffMs, signal);
    } finally {
      runtime.activeResourceBackoffs = Math.max(0, runtime.activeResourceBackoffs - 1);
    }
  }
}

function quotaLatch() {
  const until = new Date();
  until.setDate(until.getDate() + 1);
  until.setHours(0, 5, 0, 0);
  routeState = { lightningFallbackUntil: until.getTime() };
  saveRouteState(routeState);
}

async function execute(context, initialRoute, onSpawn, signal) {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  let selected = initialRoute;
  let routeResult = await withRouteCapacity(selected, signal, () =>
    runCliWithResourceRetries(context, selected.model, onSpawn, signal, deadline));
  let { cliResult, session } = routeResult;
  let combined = `${cliResult.stdout}\n${cliResult.stderr}`;
  let quotaFallback = false;
  if (selected.key === "primary" && (cliResult.code !== 0 || !cliResult.stdout) && QUOTA_FAILURE.test(combined)) {
    if (session) removeSession(session.id);
    quotaLatch();
    selected = { key: "fallback", model: models.fallback, reason: "confirmed_quota_failure" };
    quotaFallback = true;
    routeResult = await withRouteCapacity(selected, signal, () =>
      runCliWithResourceRetries(context, selected.model, onSpawn, signal, deadline));
    ({ cliResult, session } = routeResult);
    combined = `${cliResult.stdout}\n${cliResult.stderr}`;
  }
  if (cliResult.code !== 0 || !cliResult.stdout) {
    if (session) removeSession(session.id);
    throw new BridgeError(`Devin failed: ${cliResult.stderr || cliResult.stdout || `exit ${cliResult.code}`}`, 502);
  }
  if (!session) throw new BridgeError("Devin completed without a traceable ephemeral session", 502);
  try {
    if (session.model !== selected.model.model_uid) {
      throw new BridgeError(`Devin used unexpected model ${json(session.model)}`, 502);
    }
    const metadata = session.metadata;
    const creditCost = Number(metadata.total_credit_cost || 0);
    const acuCost = Number(metadata.total_acu_cost || 0);
    if (selected.key !== "primary" && (creditCost !== 0 || acuCost !== 0)) {
      throw new BridgeError(`Free Devin route reported non-zero usage charge: credit=${creditCost}, acu=${acuCost}`, 502);
    }
    if (selected.key === "primary" && creditCost > 0) quotaLatch();
    const inputTokens = Number(dimension(metadata, "input_tokens") || 0);
    const cachedTokens = Number(dimension(metadata, "cached_input_tokens") || 0);
    const outputTokens = Number(dimension(metadata, "output_tokens") || 0);
    const peakTurnContextTokens = Math.max(0, ...session.metrics.map((metric) =>
      Number(metric.input_tokens || 0) + Number(metric.cache_read_tokens || 0) + Number(metric.cache_creation_tokens || 0)));
    const generationSeconds = session.metrics.reduce((sum, metric) =>
      sum + Math.max(0, Number(metric.total_time_ms || 0) - Number(metric.ttft_ms || 0)), 0) / 1000;
    const measuredOutputTokens = session.metrics.reduce((sum, metric) => sum + Number(metric.output_tokens || 0), 0);
    const outputTokensPerSecond = generationSeconds > 0 ? measuredOutputTokens / generationSeconds : null;
    const toolCalls = session.toolCalls.filter((call) => call?.name);
    const rzMcpTools = toolCalls
      .filter((call) => call.name === "mcp_call_tool" && call.arguments?.tool_name === "call_rzmcp_tool")
      .map((call) => call.arguments?.arguments?.name).filter((name) => typeof name === "string");
    return {
      text: cliResult.stdout, selected, quotaFallback, creditCost, acuCost,
      inputTokens, cachedTokens, outputTokens, peakTurnContextTokens, outputTokensPerSecond,
      toolCalls, rzMcpTools,
    };
  } finally {
    removeSession(session.id);
  }
}

function usageFrom(result) {
  return {
    input_tokens: result.inputTokens,
    input_tokens_details: { cached_tokens: result.cachedTokens },
    output_tokens: result.outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: result.inputTokens + result.outputTokens,
  };
}

function responseMessageItem(id, text, status = "in_progress") {
  return { type: "message", id, status, role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
}

function writeSse(response, type, payload) {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: ${type}\ndata: ${json({ type, ...payload })}\n\n`);
}

function writeSseHeartbeat(response, responseId) {
  writeSse(response, "response.in_progress", {
    response: { id: responseId, object: "response", model: MODEL_ALIAS, status: "in_progress" },
  });
}

async function readJsonRequest(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new BridgeError("Request body is too large", 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch (error) { throw new BridgeError(`Request body is not valid JSON: ${error.message}`); }
}

async function handleResponses(request, response) {
  const context = promptFrom(await readJsonRequest(request));
  runtime.requests += 1;
  runtime.activeRequests += 1;
  runtime.lastWorkingDirectory = context.workingDirectory;
  runtime.lastTaskId = context.taskDiagnostics.taskId;
  runtime.lastTaskName = context.taskDiagnostics.taskName;
  runtime.lastTaskHash = context.taskDiagnostics.taskHash;
  runtime.lastTaskIntent = context.taskDiagnostics.taskIntent;
  runtime.lastTaskDeliveryMode = context.taskDiagnostics.taskDeliveryMode;
  runtime.lastTaskPartTypes = context.taskDiagnostics.taskPartTypes;
  runtime.lastTaskPartLengths = context.taskDiagnostics.taskPartLengths;
  runtime.lastCompleteTaskDelivered = context.taskDiagnostics.completeTaskDelivered;
  const selected = chooseRoute(context);
  runtime.lastConfiguredRoute = selected.key;
  let child = null;
  const abortController = new AbortController();
  const abort = () => {
    abortController.abort();
    if (child && !child.killed) child.kill();
  };
  request.once("aborted", abort);
  response.once("close", () => { if (!response.writableEnded) abort(); });
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  const responseId = `resp_${randomUUID()}`;
  writeSse(response, "response.created", { response: { id: responseId, object: "response", model: MODEL_ALIAS, status: "in_progress" } });
  const heartbeat = setInterval(() => writeSseHeartbeat(response, responseId), SSE_HEARTBEAT_MS);
  heartbeat.unref();
  try {
    const result = await execute(context, selected, (spawned) => { child = spawned; }, abortController.signal);
    runtime.completed += 1;
    runtime.lastActualModel = result.selected.model.model_uid;
    runtime.lastModelLabel = result.selected.model.label;
    runtime.lastQuotaFallback = result.quotaFallback;
    runtime.lastCreditCost = result.creditCost;
    runtime.lastAcuCost = result.acuCost;
    runtime.lastInputTokens = result.inputTokens;
    runtime.lastCachedInputTokens = result.cachedTokens;
    runtime.lastOutputTokens = result.outputTokens;
    runtime.lastPeakTurnContextTokens = result.peakTurnContextTokens;
    runtime.lastOutputTokensPerSecond = result.outputTokensPerSecond;
    runtime.lastNativeToolCalls = result.toolCalls.length;
    runtime.lastNativeToolNames = [...new Set(result.toolCalls.map((call) => call.name))];
    runtime.lastRzMcpTools = [...new Set(result.rzMcpTools)];
    const itemId = `msg_${randomUUID()}`;
    writeSse(response, "response.output_item.added", { output_index: 0, item: responseMessageItem(itemId, "") });
    writeSse(response, "response.content_part.added", { item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    writeSse(response, "response.output_text.delta", { item_id: itemId, output_index: 0, content_index: 0, delta: result.text });
    writeSse(response, "response.output_text.done", { item_id: itemId, output_index: 0, content_index: 0, text: result.text });
    writeSse(response, "response.content_part.done", { item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text: result.text, annotations: [] } });
    const item = responseMessageItem(itemId, result.text, "completed");
    writeSse(response, "response.output_item.done", { output_index: 0, item });
    writeSse(response, "response.completed", { response: {
      id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed",
      model: MODEL_ALIAS, output: [item], usage: usageFrom(result), error: null, incomplete_details: null,
      metadata: {
        provider: PROVIDER_ID, route: result.selected.key, route_reason: result.selected.reason,
        actual_model: result.selected.model.model_uid, actual_model_label: result.selected.model.label,
        quota_fallback: result.quotaFallback, total_credit_cost: result.creditCost, total_acu_cost: result.acuCost,
        peak_turn_context_tokens: result.peakTurnContextTokens, output_tokens_per_second: result.outputTokensPerSecond,
        native_tool_calls: result.toolCalls.length, native_tool_names: runtime.lastNativeToolNames,
        rzmcp_tools_called: runtime.lastRzMcpTools, codex_tool_schema_bytes_ignored: context.toolSchemaBytes,
        active_task_id: context.taskDiagnostics.taskId, active_task_hash: context.taskDiagnostics.taskHash,
        active_task_delivery_mode: context.taskDiagnostics.taskDeliveryMode,
        complete_active_task_delivered: context.taskDiagnostics.completeTaskDelivered,
      },
    } });
    response.end();
  } catch (error) {
    runtime.failed += 1;
    writeSse(response, "response.failed", { response: { id: responseId, object: "response", model: MODEL_ALIAS, status: "failed", error: { code: "external_provider_error", message: error.message } } });
    response.end();
  } finally {
    clearInterval(heartbeat);
    runtime.activeRequests = Math.max(0, runtime.activeRequests - 1);
  }
}

function managedModelsResponse() {
  return { models: [{
    slug: MODEL_ALIAS, display_name: "Managed native subagent", description: "Centrally routed Devin native subagent",
    base_instructions: "You are a bounded delegated coding sub-agent. Use local tools and return concise evidence.",
    default_reasoning_level: REQUIRED_EFFORT, supported_reasoning_levels: [{ effort: REQUIRED_EFFORT, description: "Maximum" }],
    shell_type: "unified_exec", visibility: "none", supported_in_api: true, priority: 0, availability_nux: null,
    upgrade: null, include_skills_usage_instructions: false, include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false, supports_reasoning_summary_parameter: false, default_reasoning_summary: "none",
    support_verbosity: false, default_verbosity: null, apply_patch_tool_type: "freeform", web_search_tool_type: "text",
    truncation_policy: { mode: "tokens", limit: 10_000 }, supports_image_detail_original: false,
    context_window: models.primary.max_context_tokens, max_context_window: models.primary.max_context_tokens,
    experimental_supported_tools: [], input_modalities: route.inputModalities, supports_search_tool: true,
    use_responses_lite: false, node_repl_auto_review_required: false, node_repl_disabled: false,
    tool_mode: "direct", multi_agent_version: "v2",
  }] };
}

function health() {
  return {
    ok: true, provider: PROVIDER_ID, port, modelAlias: MODEL_ALIAS, effort: REQUIRED_EFFORT,
    auth, inputModalities: route.inputModalities,
    routing: {
      primary: { uid: models.primary.model_uid, label: models.primary.label, cost: models.primary.cost_summary || models.primary.cost_tier },
      quotaFallback: { uid: models.fallback.model_uid, label: models.fallback.label, cost: models.fallback.cost_summary || models.fallback.cost_tier },
      complex: { uid: models.complex.model_uid, label: models.complex.label, cost: models.complex.cost_summary || models.complex.cost_tier },
      lightningFallbackUntil: routeState.lightningFallbackUntil || null,
    },
    apiKeysStripped: true, isolatedConfigImports: ["agents_standard"], lazyRzMcpProxyTools: 2,
    rawPromptFilesRetained: false, ephemeralSessionsRemoved: true, runtime,
  };
}

function jsonResponse(response, status, value) {
  const body = json(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

async function selfTest() {
  const simple = { taskState: { activeTask: { text: "Create a small fixture." } }, prompt: "" };
  const complex = { taskState: { activeTask: { text: "Debug the root cause of a crash race condition." } }, prompt: "" };
  if (chooseRoute(simple).key !== "primary" && chooseRoute(simple).key !== "fallback") throw new Error("default route failed");
  if (chooseRoute(complex).key !== "complex") throw new Error("complex route failed");
  if (!QUOTA_FAILURE.test("Daily usage quota reached")) throw new Error("quota detection failed");
  if (!RESOURCE_EXHAUSTED.test('{"cognition.ai/errorKind":"resource_exhausted","cognition.ai/retryable":true}')) throw new Error("resource exhaustion detection failed");
  if (resourceBackoffMs(1) !== 5_000 || resourceBackoffMs(6) !== 120_000 || resourceBackoffMs(20) !== 120_000) throw new Error("resource backoff schedule failed");
  const uniqueCalls = uniqueToolCalls([
    { tool_calls: '[{"id":"call-1","name":"read"},{"id":"call-2","name":"edit"}]' },
    { tool_calls: '[{"id":"call-1","name":"read"},{"id":"call-2","name":"edit"}]' },
  ]);
  if (uniqueCalls.length !== 2 || uniqueCalls[0].id !== "call-1" || uniqueCalls[1].id !== "call-2") throw new Error("tool call deduplication failed");
  const task = "Message Type: NEW_TASK\nTask name: /root/self_test\nPayload:\nImplement the bounded fixture now.";
  const checkpoint = "Message Type: MESSAGE\nTask name: /root/self_test\nPayload:\nReturn a checkpoint report immediately.";
  const prompt = promptFrom({
    stream: true,
    model: MODEL_ALIAS,
    reasoning: { effort: REQUIRED_EFFORT },
    input: [
      { type: "message", role: "user", content: "Stale inherited instruction: only restate the task." },
      { type: "agent_message", id: "self-test-task", author: "Codex", recipient: "/root/self_test", content: [{ type: "input_text", text: task }] },
      { type: "agent_message", id: "self-test-checkpoint", author: "Codex", recipient: "/root/self_test", content: [{ type: "input_text", text: checkpoint }] },
    ],
  }).prompt;
  const staleIndex = prompt.indexOf("Stale inherited instruction");
  const taskIndex = prompt.indexOf(task);
  const checkpointIndex = prompt.indexOf(checkpoint);
  if (!(staleIndex >= 0 && staleIndex < taskIndex && taskIndex < checkpointIndex)) throw new Error("active task precedence failed");
  if (prompt.indexOf(task, taskIndex + task.length) !== -1) throw new Error("active task duplication failed");
  const heartbeatWrites = [];
  writeSseHeartbeat({ destroyed: false, writableEnded: false, write: (value) => heartbeatWrites.push(value) }, "resp-self-test");
  const heartbeat = heartbeatWrites.join("");
  if (!heartbeat.includes("event: response.in_progress") || !heartbeat.includes('"id":"resp-self-test"')) throw new Error("SSE heartbeat failed");
  let concurrentFreeCalls = 0;
  let peakConcurrentFreeCalls = 0;
  const freeRoute = { key: "fallback" };
  await Promise.all(Array.from({ length: 4 }, () => withRouteCapacity(freeRoute, undefined, async () => {
    concurrentFreeCalls += 1;
    peakConcurrentFreeCalls = Math.max(peakConcurrentFreeCalls, concurrentFreeCalls);
    await delayWithAbort(5);
    concurrentFreeCalls -= 1;
  })));
  if (peakConcurrentFreeCalls !== FREE_ROUTE_CONCURRENCY || freeCapacity.active !== 0 || freeCapacity.waiters.length !== 0) {
    throw new Error("free route capacity failed");
  }
  process.stdout.write("devin-subagent-bridge self-test: ok\n");
}

if (process.argv.includes("--self-test")) {
  await selfTest();
  process.exit(0);
}

const portValue = Number.parseInt(process.env.RZCODEX_DEVIN_BRIDGE_PORT || `${DEFAULT_PORT}`, 10);
if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) throw new BridgeError("Invalid bridge port", 500);
const port = portValue;
const server = createServer(async (request, response) => {
  runtime.incomingRequests += 1;
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (request.method === "GET" && url.pathname === "/health") return jsonResponse(response, 200, health());
    if (request.method === "GET" && ["/models", "/v1/models"].includes(url.pathname)) return jsonResponse(response, 200, managedModelsResponse());
    if (request.method === "POST" && url.pathname === "/v1/responses") return await handleResponses(request, response);
    runtime.rejected += 1;
    runtime.lastRejectedError = `No route for ${request.method} ${url.pathname}`;
    return jsonResponse(response, 404, { error: { message: runtime.lastRejectedError } });
  } catch (error) {
    runtime.rejected += 1;
    runtime.lastRejectedError = error.message;
    if (!response.headersSent) jsonResponse(response, error.status || 500, { error: { message: error.message } });
    else if (!response.writableEnded) response.end();
  }
});

server.listen(port, "127.0.0.1");
