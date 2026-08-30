#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
import {
  ActiveTaskRoutePins,
  fallbackForwardBody,
  runProviderFallbackChain,
  runResponsesBridge,
  validateOAuthFallbackCompletion,
} from "./native-subagent-provider-router.mjs";

const PROVIDER_ID = "devin";
const MODEL_ALIAS = "@preset/codex-subagents";
const DEVIN_FREE_MODEL_ALIAS = "@preset/codex-subagents-devin-free";
const REQUIRED_EFFORT = "high";
const LEGACY_REQUEST_EFFORTS = new Set(["max"]);
const DEFAULT_PORT = 54548;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_PROMPT_CHARS = 100_000;
const MAX_ACTIVE_TASK_CHARS = 40_000;
const OUTPUT_LIMIT = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
const SSE_HEARTBEAT_MS = 15 * 1000;
const NATIVE_PROGRESS_POLL_MS = 1 * 1000;
const MAX_PROGRESS_EVENTS = 256;
const FREE_ROUTE_CONCURRENCY = 2;
const RESOURCE_BACKOFF_BASE_MS = 5 * 1000;
const RESOURCE_BACKOFF_MAX_MS = 2 * 60 * 1000;
const QUOTA_RECOVERY_PROBE_MS = 30 * 60 * 1000;
const FALLBACK_BRIDGE_ENDPOINT = "http://127.0.0.1:54549/v1/responses";
const FALLBACK_REQUIRED_AUTH_SOURCE = "Antigravity cached OAuth session";
const FALLBACK_REQUIRED_EFFORT = "high";
const FALLBACK_CONTEXT_WINDOW = 131_072;
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const CENTRAL_CONFIG = join(homedir(), ".codex", "subagent-models.json");
const USER_DEVIN_CONFIG = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "devin", "config.json");
const DEVIN_HOME = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "RzCodex", "devin-subagents");
const ISOLATED_CONFIG = join(DEVIN_HOME, "config.json");
const REQUEST_DIRECTORY = join(DEVIN_HOME, "requests");
const QUOTA_STATE_FILE = join(DEVIN_HOME, "quota-state.json");
const DEVIN_EXE = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "devin", "cli", "bin", "devin.exe");
const DEVIN_DB = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "devin", "cli", "sessions.db");
const QUOTA_FAILURE = /(?:daily|weekly|included|usage)[\s\S]{0,100}quota[\s\S]{0,100}(?:exhaust|exceed|reach|limit)|quota[\s\S]{0,100}(?:exhaust|exceed|reach|limit)/i;
const RESOURCE_EXHAUSTED = /cognition\.ai\/errorKind[\s\S]{0,100}resource_exhausted|resource_exhausted[\s\S]{0,100}cognition\.ai\/retryable[\s\S]{0,20}true/i;
const QUOTA_STATE_VERSION = 2;

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

function quotaKindFromFailure(cliResult) {
  const output = `${cliResult?.stdout || ""}\n${cliResult?.stderr || ""}`;
  if (!QUOTA_FAILURE.test(output)) return null;
  if (/\bweekly\b/i.test(output)) return "weekly";
  if (/\bdaily\b/i.test(output)) return "daily";
  return "calendar";
}

function nextCalendarQuotaProbeAt(kind, nowMs) {
  const next = new Date(nowMs);
  next.setHours(0, 0, 0, 0);
  if (kind === "weekly") {
    const daysUntilMonday = ((8 - next.getDay()) % 7) || 7;
    next.setDate(next.getDate() + daysUntilMonday);
  } else {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

class CalendarQuotaState {
  constructor(statePath, now = () => Date.now()) {
    this.statePath = statePath;
    this.now = now;
    this.state = null;
    this.load();
  }

  load() {
    if (!this.statePath || !existsSync(this.statePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8"));
      if (
        ![1, QUOTA_STATE_VERSION].includes(parsed.version)
        || !["daily", "weekly", "calendar"].includes(parsed.kind)
        || !Number.isFinite(parsed.confirmedAt)
        || !Number.isFinite(parsed.retryAt)
        || parsed.retryAt <= parsed.confirmedAt
      ) {
        throw new Error("invalid schema");
      }
      const nextProbeAt = Number.isFinite(parsed.nextProbeAt)
        ? parsed.nextProbeAt
        : Math.min(parsed.retryAt, parsed.confirmedAt + QUOTA_RECOVERY_PROBE_MS);
      if (nextProbeAt <= parsed.confirmedAt || nextProbeAt > parsed.retryAt) {
        throw new Error("invalid recovery probe boundary");
      }
      this.state = {
        kind: parsed.kind,
        confirmedAt: parsed.confirmedAt,
        retryAt: parsed.retryAt,
        nextProbeAt,
      };
      this.isActive();
      if (this.state && parsed.version !== QUOTA_STATE_VERSION) this.persist();
    } catch (error) {
      throw new BridgeError(`Cannot read persisted Devin quota state: ${error.message}`, 500);
    }
  }

  isActive(nowMs = this.now()) {
    if (!this.state) return false;
    if (this.state.retryAt > nowMs) return true;
    this.clear();
    return false;
  }

  record(cliResult, nowMs = this.now()) {
    const kind = quotaKindFromFailure(cliResult);
    if (!kind) return false;
    const candidateRetryAt = nextCalendarQuotaProbeAt(kind, nowMs);
    const retryAt = Math.max(this.state?.retryAt || 0, candidateRetryAt);
    this.state = {
      kind: this.state?.retryAt > candidateRetryAt ? this.state.kind : kind,
      confirmedAt: nowMs,
      retryAt,
      nextProbeAt: Math.min(retryAt, nowMs + QUOTA_RECOVERY_PROBE_MS),
    };
    this.persist();
    return true;
  }

  claimRecoveryProbe(nowMs = this.now()) {
    if (!this.isActive(nowMs) || this.state.nextProbeAt > nowMs) return false;
    this.state.nextProbeAt = Math.min(this.state.retryAt, nowMs + QUOTA_RECOVERY_PROBE_MS);
    this.persist();
    return true;
  }

  clear() {
    const changed = this.state !== null || Boolean(this.statePath && existsSync(this.statePath));
    this.state = null;
    if (!this.statePath) return changed;
    try {
      unlinkSync(this.statePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw new BridgeError(`Cannot clear persisted Devin quota state: ${error.message}`, 500);
    }
    return changed;
  }

  persist() {
    if (!this.statePath) return;
    const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
    try {
      writeFileSync(temporaryPath, `${json({ version: QUOTA_STATE_VERSION, ...this.state })}\n`, "utf8");
      renameSync(temporaryPath, this.statePath);
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") {
          throw new BridgeError(`Cannot persist Devin quota state and clean its temporary file: ${cleanupError.message}`, 500);
        }
      }
      throw new BridgeError(`Cannot persist Devin quota state: ${error.message}`, 500);
    }
  }

  snapshot(nowMs = this.now()) {
    const active = this.isActive(nowMs);
    return active
      ? {
        active,
        kind: this.state.kind,
        confirmedAt: this.state.confirmedAt,
        retryAt: this.state.retryAt,
        nextProbeAt: this.state.nextProbeAt,
      }
      : { active, kind: null, confirmedAt: null, retryAt: null, nextProbeAt: null };
  }
}

function sanitizedEnvironment(source = process.env) {
  const env = { ...source, NO_COLOR: "1" };
  for (const key of [
    "DEVIN_API_KEY", "DEVIN_ORG_ID", "COGNITION_API_KEY", "OPENAI_API_KEY",
    "OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "CODEX_API_KEY", "OPENROUTER_API_KEY",
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
  const quotaFallbackProvider = requireString(route.quotaFallbackProvider, "quotaFallbackProvider");
  if (quotaFallbackProvider !== "antigravity") {
    throw new BridgeError(`Devin quota fallback provider must be antigravity, got ${json(quotaFallbackProvider)}`, 500);
  }
  const fallbackRoute = assertObject(parsed[quotaFallbackProvider], `central route ${quotaFallbackProvider}`);
  const inputModalities = route.inputModalities;
  if (!Array.isArray(inputModalities) || inputModalities.length !== 1 || inputModalities[0] !== "text") {
    throw new BridgeError("Devin managed route must declare exactly the text modality", 500);
  }
  return {
    primaryModel: requireString(route.primaryModel, "primaryModel"),
    quotaFallbackProvider,
    fallbackModels: [
      requireString(fallbackRoute.primaryModel, "antigravity.primaryModel"),
      requireString(fallbackRoute.quotaFallbackModel, "antigravity.quotaFallbackModel"),
    ],
    terminalFallbackModel: requireString(route.terminalFallbackModel, "terminalFallbackModel"),
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
const calendarQuotaState = new CalendarQuotaState(QUOTA_STATE_FILE);
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
  primary: catalogModel(route.primaryModel, "GPT-5.6 Sol High Thinking", false),
  terminal: catalogModel(route.terminalFallbackModel, "GLM-5.2 High", true),
};

const runtime = {
  incomingRequests: 0, requests: 0, completed: 0, failed: 0, rejected: 0,
  activeRequests: 0, activeFreeRequests: 0, queuedFreeRequests: 0,
  supersededTurns: 0,
  resourceRetries: 0, activeResourceBackoffs: 0,
  lastResourceModel: null, lastResourceRetryAttempt: 0,
  lastResourceBackoffMs: 0, lastResourceRetryAt: null,
  lastRejectedError: null, lastConfiguredRoute: null, lastActualModel: null,
  lastActualProvider: null, lastModelLabel: null, lastQuotaFallback: false,
  lastTerminalFallback: false, lastFallbackReason: null,
  fallbackAttempts: 0, fallbackCompleted: 0, fallbackFailed: 0, terminalFallbacks: 0,
  fallbackStreamCommits: 0, lastFallbackStreamCommitted: false,
  lastFallbackStreamedMessageCount: 0,
  quotaProbeSkips: 0, quotaRecoveryProbes: 0, quotaPinsReleased: 0,
  calendarQuotaSkips: 0, calendarQuotaActivations: 0, calendarQuotaClears: 0,
  lastQuotaProbeSkipped: false, lastQuotaSkipScope: null, lastQuotaPinCreated: false,
  lastFallbackError: null, lastFallbackAuthSource: null,
  lastCreditCost: null, lastAcuCost: null,
  lastInputTokens: null, lastCachedInputTokens: null, lastOutputTokens: null,
  lastPeakTurnContextTokens: null, lastOutputTokensPerSecond: null,
  lastNativeToolCalls: 0, lastNativeToolNames: [], lastRzMcpTools: [],
  lastWorkingDirectory: null, lastTaskId: null, lastTaskName: null, lastTaskHash: null,
  lastTaskIntent: null, lastTaskDeliveryMode: null, lastTaskPartTypes: [],
  lastTaskPartLengths: [], lastCompleteTaskDelivered: false,
  actualByConfiguredRoute: { auto: null, "devin-free": null },
};

const terminalCapacity = { active: 0, waiters: [] };
const activeThreadTurns = new Map();
const quotaTaskPins = new ActiveTaskRoutePins();

function syncFreeCapacityRuntime() {
  runtime.activeFreeRequests = terminalCapacity.active;
  runtime.queuedFreeRequests = terminalCapacity.waiters.length;
}

function registerThreadTurn(threadId, registration) {
  if (!threadId) return;
  const previous = activeThreadTurns.get(threadId);
  if (previous && previous !== registration) {
    runtime.supersededTurns += 1;
    previous.abort();
  }
  activeThreadTurns.set(threadId, registration);
}

function unregisterThreadTurn(threadId, registration) {
  if (threadId && activeThreadTurns.get(threadId) === registration) {
    activeThreadTurns.delete(threadId);
  }
}

function abortError() {
  return new BridgeError("Client disconnected while managed subagent work was active", 499);
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
  if (terminalCapacity.active < FREE_ROUTE_CONCURRENCY) {
    terminalCapacity.active += 1;
    syncFreeCapacityRuntime();
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal, onAbort: null };
    waiter.onAbort = () => {
      const index = terminalCapacity.waiters.indexOf(waiter);
      if (index !== -1) terminalCapacity.waiters.splice(index, 1);
      syncFreeCapacityRuntime();
      reject(abortError());
    };
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    terminalCapacity.waiters.push(waiter);
    syncFreeCapacityRuntime();
  });
}

function releaseFreeCapacity() {
  terminalCapacity.active = Math.max(0, terminalCapacity.active - 1);
  while (terminalCapacity.waiters.length > 0) {
    const waiter = terminalCapacity.waiters.shift();
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    if (waiter.signal?.aborted) continue;
    terminalCapacity.active += 1;
    waiter.resolve();
    break;
  }
  syncFreeCapacityRuntime();
}

async function withRouteCapacity(selected, signal, callback) {
  if (selected.key !== "terminal") return callback();
  await acquireFreeCapacity(signal);
  try {
    return await callback();
  } finally {
    releaseFreeCapacity();
  }
}

function environmentWorkingDirectoryFrom(input) {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!item || item.type !== "message") continue;
    const text = contentText(item.content, `input[${index}].content`);
    const matches = [...text.matchAll(/<environment_context>[\s\S]*?<cwd>\s*([^<\r\n]+?)\s*<\/cwd>[\s\S]*?<\/environment_context>/gi)];
    const cwd = matches.at(-1)?.[1]?.trim();
    if (cwd && isAbsolute(cwd) && existsSync(cwd)) return cwd;
  }
  return null;
}

function workingDirectoryFrom(body, input) {
  const cwd = body.client_metadata?.cwd;
  if (typeof cwd === "string" && isAbsolute(cwd) && existsSync(cwd)) return cwd;
  const environmentCwd = environmentWorkingDirectoryFrom(input);
  if (environmentCwd) return environmentCwd;
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
  const modelAlias = requireString(body.model, "model");
  const requestedRoute = modelAlias === MODEL_ALIAS
    ? "auto"
    : modelAlias === DEVIN_FREE_MODEL_ALIAS
      ? "devin-free"
      : null;
  if (!requestedRoute) throw new BridgeError(`Unknown managed model alias ${json(modelAlias)}`);
  const effort = body.reasoning?.effort;
  if (effort !== undefined && effort !== REQUIRED_EFFORT && !LEGACY_REQUEST_EFFORTS.has(effort)) {
    throw new BridgeError(`Devin subagents require centrally configured effort ${REQUIRED_EFFORT}`);
  }
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
  const workingDirectory = workingDirectoryFrom(body, input);
  const threadId = typeof body.client_metadata?.thread_id === "string"
    ? body.client_metadata.thread_id
    : null;
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
      if (!["system", "developer"].includes(item.role)) history.push({ index, checkpoint: false, text: `[${item.role}]\n${contentText(item.content, `input[${index}].content`)}` });
    } else if (item.type === "agent_message") {
      const message = agentMessages.get(index) ?? {
        ...normalizeAgentMessageContent(item.content, `input[${index}].content`),
        author: item.author || "Codex", recipient: item.recipient || "managed worker", newTask: false, checkpoint: false,
      };
      if (message.newTask && !message.checkpoint) continue;
      history.push({ index, checkpoint: message.checkpoint, text: `[Inter-agent message ${message.author} -> ${message.recipient}]\n${message.text}` });
    } else if (["function_call", "custom_tool_call", "tool_search_call"].includes(item.type)) {
      history.push({ index, checkpoint: false, text: `[Prior Codex tool request ${item.name || "tool_search"}; call_id=${item.call_id}]` });
    } else if (["function_call_output", "custom_tool_call_output"].includes(item.type)) {
      history.push({ index, checkpoint: false, text: `[Prior Codex tool result; call_id=${item.call_id}]\n${outputText(item.output)}` });
    } else if (item.type === "tool_search_output") {
      history.push({ index, checkpoint: false, text: `[Prior Codex tool search result; call_id=${item.call_id}]` });
    } else if (item.type === "reasoning") {
      const summary = Array.isArray(item.summary) ? item.summary.map((part) => part?.text || "").join("") : "";
      if (summary) history.push({ index, checkpoint: false, text: `[Prior reasoning summary]\n${summary}` });
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
    const checkpoints = retained.filter((item) => item.checkpoint);
    const ordinaryHistory = retained.filter((item) => !item.checkpoint);
    sections.push(...ordinaryHistory.filter((item) => item.index < activeTaskIndex).map((item) => item.text));
    sections.push(activeTask);
    sections.push(...ordinaryHistory.filter((item) => item.index > activeTaskIndex).map((item) => item.text));
    sections.push(...checkpoints.map((item) => item.text));
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
  return {
    requestId,
    prompt,
    workingDirectory,
    threadId,
    taskState,
    taskDiagnostics,
    toolSchemaBytes,
    modelAlias,
    requestedRoute,
  };
}

function fallbackSelection(reason) {
  return {
    key: "fallback",
    provider: route.quotaFallbackProvider,
    model: { model_uid: MODEL_ALIAS, label: "Antigravity managed chain" },
    reason,
  };
}

function chooseRoute(context, quotaState = calendarQuotaState, taskPins = quotaTaskPins) {
  runtime.lastQuotaPinCreated = false;
  if (context.requestedRoute === "devin-free") {
    runtime.lastQuotaProbeSkipped = true;
    runtime.lastQuotaSkipScope = "explicit_devin_free_route";
    return {
      key: "terminal",
      provider: "devin",
      model: models.terminal,
      reason: "explicit_devin_free_route",
    };
  }
  runtime.lastQuotaProbeSkipped = taskPins.has(
    context.threadId,
    context.taskDiagnostics.taskHash,
  );
  runtime.lastQuotaSkipScope = runtime.lastQuotaProbeSkipped ? "active_task" : null;
  if (runtime.lastQuotaProbeSkipped) {
    runtime.quotaProbeSkips += 1;
    return fallbackSelection("active_task_confirmed_devin_quota_failure");
  }
  if (quotaState.isActive()) {
    if (quotaState.claimRecoveryProbe()) {
      runtime.quotaRecoveryProbes += 1;
      runtime.lastQuotaProbeSkipped = false;
      runtime.lastQuotaSkipScope = "calendar_recovery_probe";
      return {
        key: "primary",
        provider: "devin",
        model: models.primary,
        reason: "calendar_quota_recovery_probe",
      };
    }
    runtime.lastQuotaProbeSkipped = true;
    runtime.lastQuotaSkipScope = "calendar_quota";
    runtime.quotaProbeSkips += 1;
    runtime.calendarQuotaSkips += 1;
    return fallbackSelection("persisted_calendar_devin_quota_failure");
  }
  return { key: "primary", provider: "devin", model: models.primary, reason: "all_tasks_primary" };
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

function runCli(context, selectedModel, onSpawn, onProgress, timeoutMs = REQUEST_TIMEOUT_MS) {
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
    const seenToolCalls = new Set();
    const reportProgress = () => {
      let session;
      try {
        session = inspectSession(context.requestId);
      } catch {
        return;
      }
      for (const [index, call] of (session?.toolCalls || []).entries()) {
        if (!call?.name) continue;
        const key = typeof call.id === "string" && call.id ? call.id : `${call.name}:${index}`;
        if (seenToolCalls.has(key)) continue;
        seenToolCalls.add(key);
        onProgress?.({ kind: "tool", index: seenToolCalls.size, name: call.name });
      }
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(progressTimer);
      reportProgress();
      try { unlinkSync(promptPath); } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT" && !error) error = cleanupError;
      }
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new BridgeError(`Devin exceeded ${timeoutMs}ms`, 504));
    }, timeoutMs);
    const progressTimer = setInterval(reportProgress, NATIVE_PROGRESS_POLL_MS);
    progressTimer.unref();
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

function cliFailed(cliResult) {
  return cliResult.code !== 0 || !cliResult.stdout;
}

function isQuotaFailure(cliResult) {
  return cliFailed(cliResult) && QUOTA_FAILURE.test(`${cliResult.stdout}\n${cliResult.stderr}`);
}

function isRetryableResourceFailure(cliResult) {
  const combined = `${cliResult.stdout}\n${cliResult.stderr}`;
  return cliFailed(cliResult) && !QUOTA_FAILURE.test(combined) && RESOURCE_EXHAUSTED.test(combined);
}

function sanitizedProviderFailure(error) {
  return String(error?.message || error)
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(sk|or)-[a-z0-9_-]{12,}\b/gi, "[REDACTED]")
    .slice(0, 2_000);
}

function preserveProviderCommit(error, session) {
  const toolCalls = Array.isArray(session?.toolCalls)
    ? session.toolCalls.filter((call) => call?.name)
    : [];
  if (toolCalls.length > 0) {
    error.routeCommitted = true;
    error.toolCalls = toolCalls.length;
    error.toolNames = [...new Set(toolCalls.map((call) => call.name))];
  }
  return error;
}

async function runCliWithResourceRetries(context, selectedModel, onSpawn, onProgress, signal, deadline) {
  let attempt = 0;
  while (true) {
    throwIfAborted(signal);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new BridgeError("Devin resource retry deadline exceeded", 504);
    const cliResult = await runCli(context, selectedModel, onSpawn, onProgress, remainingMs);
    const session = await waitForSession(context.requestId);
    if (!isRetryableResourceFailure(cliResult)) return { cliResult, session };
    if (session?.toolCalls?.some((call) => call?.name)) {
      const error = preserveProviderCommit(
        new BridgeError("Devin became resource exhausted after executing native tools; the turn was not replayed", 502),
        session,
      );
      removeSession(session.id);
      throw error;
    }
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

function fallbackResult(completion, reason) {
  const usage = completion.usage || {};
  const inputTokens = Number(usage.input_tokens || 0);
  const cachedTokens = Number(usage.input_tokens_details?.cached_tokens || 0);
  const outputTokens = Number(usage.output_tokens || 0);
  const providerMetadata = completion.metadata || {};
  const providerOutput = completion.output.filter((item) => item?.type !== "reasoning");
  const toolCalls = providerOutput
    .filter((item) => ["function_call", "custom_tool_call", "tool_search_call"].includes(item?.type))
    .map((item) => ({
      id: item.call_id || item.id,
      name: item.name || "tool_search",
      arguments: item.arguments || item.input || null,
    }));
  const nativeToolNames = Array.isArray(providerMetadata.native_tool_names)
    ? providerMetadata.native_tool_names.filter((name) => typeof name === "string")
    : toolCalls.map((call) => call.name);
  return {
    output: providerOutput,
    providerMetadata,
    selected: {
      ...fallbackSelection(reason),
      model: {
        model_uid: providerMetadata.actual_model,
        label: providerMetadata.actual_model_label || providerMetadata.actual_model,
      },
    },
    quotaFallback: true,
    terminalFallback: false,
    fallbackReason: "confirmed_devin_quota_failure",
    fallbackFailure: null,
    creditCost: 0,
    acuCost: 0,
    inputTokens,
    cachedTokens,
    outputTokens,
    peakTurnContextTokens: Number(providerMetadata.peak_turn_context_tokens || 0),
    outputTokensPerSecond: Number(providerMetadata.output_tokens_per_second || 0) || null,
    toolCalls, nativeToolNames,
    rzMcpTools: Array.isArray(providerMetadata.rzmcp_tools_called)
      ? providerMetadata.rzmcp_tools_called.filter((name) => typeof name === "string")
      : [],
  };
}

function finalizeDevinResult(selected, routeResult, fallbackState) {
  const { cliResult, session } = routeResult;
  if (!session) {
    if (cliResult.code !== 0 || !cliResult.stdout) {
      throw new BridgeError(`Devin failed: ${cliResult.stderr || cliResult.stdout || `exit ${cliResult.code}`}`, 502);
    }
    throw new BridgeError("Devin completed without a traceable ephemeral session", 502);
  }
  try {
    if (cliResult.code !== 0 || !cliResult.stdout) {
      throw new BridgeError(`Devin failed: ${cliResult.stderr || cliResult.stdout || `exit ${cliResult.code}`}`, 502);
    }
    if (session.model !== selected.model.model_uid) {
      throw new BridgeError(`Devin used unexpected model ${json(session.model)}`, 502);
    }
    const metadata = session.metadata;
    const creditCost = Number(metadata.total_credit_cost || 0);
    const acuCost = Number(metadata.total_acu_cost || 0);
    if (selected.key === "terminal" && (creditCost !== 0 || acuCost !== 0)) {
      throw new BridgeError(`Free Devin route reported non-zero usage charge: credit=${creditCost}, acu=${acuCost}`, 502);
    }
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
      text: cliResult.stdout, selected, providerMetadata: {},
      quotaFallback: fallbackState.quotaFallback,
      terminalFallback: fallbackState.terminalFallback,
      fallbackReason: fallbackState.fallbackReason,
      fallbackFailure: fallbackState.fallbackFailure,
      creditCost, acuCost,
      inputTokens, cachedTokens, outputTokens, peakTurnContextTokens, outputTokensPerSecond,
      toolCalls, nativeToolNames: toolCalls.map((call) => call.name), rzMcpTools,
    };
  } catch (error) {
    throw preserveProviderCommit(error, session);
  } finally {
    removeSession(session.id);
  }
}

async function executeProviderFallback(
  context,
  requestBody,
  initialRoute,
  onSpawn,
  onProgress,
  signal,
  fallbackRelay,
) {
  let selected = initialRoute;
  let routeResult;
  runtime.fallbackAttempts += 1;
  const fallback = await runProviderFallbackChain({
    signal,
    runFallback: async () => {
      try {
        const forwardedBody = fallbackForwardBody(requestBody, MODEL_ALIAS, FALLBACK_REQUIRED_EFFORT);
        const completion = await runResponsesBridge({
          endpoint: FALLBACK_BRIDGE_ENDPOINT,
          body: forwardedBody,
          signal,
          onEvent: fallbackRelay.accept,
        });
        validateOAuthFallbackCompletion(completion, {
          provider: route.quotaFallbackProvider,
          models: route.fallbackModels,
          authSource: FALLBACK_REQUIRED_AUTH_SOURCE,
        });
        return fallbackResult(completion, selected.reason);
      } catch (error) {
        if (fallbackRelay.committed) error.routeCommitted = true;
        throw error;
      }
    },
    runTerminal: async (fallbackError) => {
      runtime.terminalFallbacks += 1;
      selected = {
        key: "terminal",
        provider: "devin",
        model: models.terminal,
        reason: "antigravity_unavailable_after_devin_quota",
      };
      onProgress?.(`Antigravity became unavailable; switched to Devin ${selected.model.label}.\n`);
      routeResult = await withRouteCapacity(selected, signal, () =>
        runCliWithResourceRetries(
          context,
          selected.model,
          onSpawn,
          ({ index, name }) => onProgress?.(`Devin native tool ${index}: ${progressToolName(name)}.\n`),
          signal,
          Date.now() + REQUEST_TIMEOUT_MS,
        ));
      return finalizeDevinResult(selected, routeResult, {
        quotaFallback: true,
        terminalFallback: true,
        fallbackReason: "antigravity_unavailable_after_confirmed_devin_quota_failure",
        fallbackFailure: sanitizedProviderFailure(fallbackError),
      });
    },
    onFallbackFailure: (error) => {
      runtime.fallbackFailed += 1;
      runtime.lastFallbackError = sanitizedProviderFailure(error);
    },
  });
  if (fallback.stage === "fallback") {
    runtime.fallbackCompleted += 1;
    runtime.lastFallbackError = null;
    return fallback.value;
  }
  return fallback.value;
}

async function execute(context, requestBody, initialRoute, onSpawn, onProgress, signal, fallbackRelay) {
  if (initialRoute.key === "fallback") {
    onProgress?.("Native route selected Antigravity because the Devin quota is currently unavailable.\n");
    return executeProviderFallback(
      context,
      requestBody,
      initialRoute,
      onSpawn,
      onProgress,
      signal,
      fallbackRelay,
    );
  }

  onProgress?.(`Devin native worker started with ${initialRoute.model.label}.\n`);
  const routeResult = await withRouteCapacity(initialRoute, signal, () =>
    runCliWithResourceRetries(
      context,
      initialRoute.model,
      onSpawn,
      ({ index, name }) => onProgress?.(`Devin native tool ${index}: ${progressToolName(name)}.\n`),
      signal,
      Date.now() + REQUEST_TIMEOUT_MS,
    ));
  if (initialRoute.key === "terminal") {
    return finalizeDevinResult(initialRoute, routeResult, {
      quotaFallback: false,
      terminalFallback: false,
      fallbackReason: null,
      fallbackFailure: null,
    });
  }
  if (!isQuotaFailure(routeResult.cliResult)) {
    if (!cliFailed(routeResult.cliResult) && calendarQuotaState.clear()) {
      runtime.calendarQuotaClears += 1;
    }
    return finalizeDevinResult(initialRoute, routeResult, {
      quotaFallback: false,
      terminalFallback: false,
      fallbackReason: null,
      fallbackFailure: null,
    });
  }

  if (routeResult.session?.toolCalls?.some((call) => call?.name)) {
    const error = preserveProviderCommit(
      new BridgeError("Devin quota ended after executing native tools; provider fallback was not started", 502),
      routeResult.session,
    );
    removeSession(routeResult.session.id);
    throw error;
  }
  if (routeResult.session) removeSession(routeResult.session.id);
  if (calendarQuotaState.record(routeResult.cliResult)) runtime.calendarQuotaActivations += 1;
  runtime.lastQuotaPinCreated = quotaTaskPins.pin(
    context.threadId,
    context.taskDiagnostics.taskHash,
  );
  onProgress?.("Devin quota reached before native work; switched to Antigravity.\n");
  return executeProviderFallback(
    context,
    requestBody,
    fallbackSelection("devin_quota_antigravity_available"),
    onSpawn,
    onProgress,
    signal,
    fallbackRelay,
  );
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

function emitOutputItems(response, result, streamedMessageIds = new Set(), prefixOutput = []) {
  const output = result.output || [responseMessageItem(`msg_${randomUUID()}`, result.text, "completed")];
  output.forEach((item, itemIndex) => {
    const outputIndex = prefixOutput.length + itemIndex;
    if (item.type !== "message") {
      writeSse(response, "response.output_item.done", { output_index: outputIndex, item });
      return;
    }
    const itemId = item.id || `msg_${randomUUID()}`;
    const text = (item.content || [])
      .filter((part) => part?.type === "output_text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    if (!streamedMessageIds.has(itemId)) {
      writeSse(response, "response.output_item.added", {
        output_index: outputIndex,
        item: responseMessageItem(itemId, ""),
      });
      writeSse(response, "response.content_part.added", {
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      writeSse(response, "response.output_text.delta", {
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        delta: text,
      });
    }
    writeSse(response, "response.output_text.done", {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      text,
    });
    writeSse(response, "response.content_part.done", {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] },
    });
    writeSse(response, "response.output_item.done", {
      output_index: outputIndex,
      item: { ...item, id: itemId, status: "completed" },
    });
  });
  return [...prefixOutput, ...output];
}

function writeSse(response, type, payload) {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: ${type}\ndata: ${json({ type, ...payload })}\n\n`);
}

function providerResponseErrorCode(error) {
  return error?.routeCommitted === true ? "provider_state_changed" : "external_provider_error";
}

function writeSseHeartbeat(response, responseId, modelAlias = MODEL_ALIAS) {
  writeSse(response, "response.in_progress", {
    response: { id: responseId, object: "response", model: modelAlias, status: "in_progress" },
  });
}

function progressToolName(value) {
  return String(value || "unknown_tool")
    .replace(/[^A-Za-z0-9_.:-]+/g, "_")
    .slice(0, 80) || "unknown_tool";
}

function createProgressEmitter(response) {
  const itemId = `progress_${randomUUID()}`;
  let added = false;
  let completed = null;
  let text = "";
  let events = 0;
  const emit = (delta) => {
    if (completed || events >= MAX_PROGRESS_EVENTS || typeof delta !== "string" || !delta) return;
    if (!added) {
      added = true;
      writeSse(response, "response.output_item.added", {
        output_index: 0,
        item: { type: "reasoning", id: itemId, status: "in_progress", summary: [] },
      });
    }
    events += 1;
    text += delta;
    writeSse(response, "response.reasoning_summary_text.delta", {
      item_id: itemId,
      output_index: 0,
      summary_index: 0,
      delta,
    });
  };
  const finish = () => {
    if (completed || !added) return completed;
    completed = {
      type: "reasoning",
      id: itemId,
      status: "completed",
      summary: text ? [{ type: "summary_text", text }] : [],
    };
    writeSse(response, "response.reasoning_summary_text.done", {
      item_id: itemId,
      output_index: 0,
      summary_index: 0,
      text,
    });
    writeSse(response, "response.output_item.done", { output_index: 0, item: completed });
    return completed;
  };
  return { emit, finish, get added() { return added; } };
}

function createFallbackStreamRelay(response, responseId, modelAlias = MODEL_ALIAS, progress = null) {
  const pendingMessages = new Map();
  const streamedMessageIds = new Set();
  const providerProgressIds = new Set();
  let committed = false;
  const accept = async (event) => {
    const payload = event.payload || {};
    if (event.type === "response.in_progress") {
      writeSseHeartbeat(response, responseId, modelAlias);
      return;
    }
    if (
      event.type === "response.output_item.added"
      && payload.item?.type === "reasoning"
      && typeof payload.item.id === "string"
      && payload.item.id.startsWith("progress_")
    ) {
      providerProgressIds.add(payload.item.id);
      return;
    }
    if (
      event.type === "response.reasoning_summary_text.delta"
      && providerProgressIds.has(payload.item_id)
      && typeof payload.delta === "string"
      && payload.delta
    ) {
      progress?.emit(payload.delta);
      return;
    }
    if (event.type === "response.output_item.added" && payload.item?.type === "message") {
      const itemId = requireString(payload.item.id, "fallback streamed message id");
      pendingMessages.set(itemId, { added: payload, part: null });
      return;
    }
    if (event.type === "response.content_part.added") {
      const pending = pendingMessages.get(payload.item_id);
      if (pending) pending.part = payload;
      return;
    }
    if (event.type !== "response.output_text.delta" || typeof payload.delta !== "string" || !payload.delta) return;
    const pending = pendingMessages.get(payload.item_id);
    if (!pending?.part) throw new BridgeError("Fallback provider streamed text before its message lifecycle", 502);
    committed = true;
  };
  return {
    accept,
    streamedMessageIds,
    get committed() { return committed; },
  };
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
  const requestBody = await readJsonRequest(request);
  const context = promptFrom(requestBody);
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
  runtime.lastFallbackStreamCommitted = false;
  runtime.lastFallbackStreamedMessageCount = 0;
  let child = null;
  const abortController = new AbortController();
  const abort = () => {
    abortController.abort();
    if (child && !child.killed) child.kill();
  };
  const threadTurn = { requestId: context.requestId, abort };
  registerThreadTurn(context.threadId, threadTurn);
  request.once("aborted", abort);
  response.once("close", () => { if (!response.writableEnded) abort(); });
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  const responseId = `resp_${randomUUID()}`;
  writeSse(response, "response.created", { response: { id: responseId, object: "response", model: context.modelAlias, status: "in_progress" } });
  const progress = createProgressEmitter(response);
  const fallbackRelay = createFallbackStreamRelay(response, responseId, context.modelAlias, progress);
  const heartbeat = setInterval(() => writeSseHeartbeat(response, responseId, context.modelAlias), SSE_HEARTBEAT_MS);
  heartbeat.unref();
  try {
    const result = await execute(
      context,
      requestBody,
      selected,
      (spawned) => { child = spawned; },
      progress.emit,
      abortController.signal,
      fallbackRelay,
    );
    if (quotaTaskPins.releaseAfterFinalResponse(
      context.threadId,
      context.taskDiagnostics.taskHash,
      result.toolCalls.length,
    )) runtime.quotaPinsReleased += 1;
    runtime.lastFallbackStreamCommitted = fallbackRelay.committed;
    runtime.lastFallbackStreamedMessageCount = fallbackRelay.streamedMessageIds.size;
    if (fallbackRelay.committed) runtime.fallbackStreamCommits += 1;
    runtime.completed += 1;
    runtime.lastActualProvider = result.selected.provider;
    runtime.lastActualModel = result.selected.model.model_uid;
    runtime.lastModelLabel = result.selected.model.label;
    runtime.actualByConfiguredRoute[context.requestedRoute] = {
      provider: result.selected.provider,
      model: result.selected.model.model_uid,
      label: result.selected.model.label,
    };
    runtime.lastQuotaFallback = result.quotaFallback;
    runtime.lastTerminalFallback = result.terminalFallback;
    runtime.lastFallbackReason = result.fallbackReason;
    runtime.lastFallbackError = result.fallbackFailure;
    runtime.lastFallbackAuthSource = result.providerMetadata.auth_source || null;
    runtime.lastCreditCost = result.creditCost;
    runtime.lastAcuCost = result.acuCost;
    runtime.lastInputTokens = result.inputTokens;
    runtime.lastCachedInputTokens = result.cachedTokens;
    runtime.lastOutputTokens = result.outputTokens;
    runtime.lastPeakTurnContextTokens = result.peakTurnContextTokens;
    runtime.lastOutputTokensPerSecond = result.outputTokensPerSecond;
    runtime.lastNativeToolCalls = result.nativeToolNames.length;
    runtime.lastNativeToolNames = [...new Set(result.nativeToolNames)];
    runtime.lastRzMcpTools = [...new Set(result.rzMcpTools)];
    const progressItem = progress.finish();
    const output = emitOutputItems(
      response,
      result,
      fallbackRelay.streamedMessageIds,
      progressItem ? [progressItem] : [],
    );
    writeSse(response, "response.completed", { response: {
      id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed",
      model: context.modelAlias, output, usage: usageFrom(result), error: null, incomplete_details: null,
      metadata: {
        ...result.providerMetadata,
        provider: PROVIDER_ID, route: result.selected.key, route_reason: result.selected.reason,
        actual_provider: result.selected.provider,
        actual_model: result.selected.model.model_uid, actual_model_label: result.selected.model.label,
        quota_fallback: result.quotaFallback, terminal_fallback: result.terminalFallback,
        fallback_reason: result.fallbackReason, fallback_failure: result.fallbackFailure,
        total_credit_cost: result.creditCost, total_acu_cost: result.acuCost,
        peak_turn_context_tokens: result.peakTurnContextTokens, output_tokens_per_second: result.outputTokensPerSecond,
        native_tool_calls: result.nativeToolNames.length, native_tool_names: runtime.lastNativeToolNames,
        rzmcp_tools_called: runtime.lastRzMcpTools,
        codex_tool_schema_bytes_ignored: context.toolSchemaBytes,
        codex_tool_schema_bytes_forwarded: 0,
        active_task_id: context.taskDiagnostics.taskId, active_task_hash: context.taskDiagnostics.taskHash,
        active_task_delivery_mode: context.taskDiagnostics.taskDeliveryMode,
        complete_active_task_delivered: context.taskDiagnostics.completeTaskDelivered,
      },
    } });
    response.end();
  } catch (error) {
    runtime.failed += 1;
    progress.finish();
    writeSse(response, "response.failed", { response: { id: responseId, object: "response", model: context.modelAlias, status: "failed", error: { code: providerResponseErrorCode(error), message: error.message } } });
    response.end();
  } finally {
    clearInterval(heartbeat);
    unregisterThreadTurn(context.threadId, threadTurn);
    runtime.activeRequests = Math.max(0, runtime.activeRequests - 1);
  }
}

function managedModelsResponse() {
  const managedContextWindow = Math.min(
    models.primary.max_context_tokens,
    models.terminal.max_context_tokens,
    FALLBACK_CONTEXT_WINDOW,
  );
  const modelDefinition = (slug, displayName, description, contextWindow) => ({
    slug, display_name: displayName, description,
    base_instructions: "You are a bounded delegated coding sub-agent. Use local tools and return concise evidence.",
    default_reasoning_level: REQUIRED_EFFORT, supported_reasoning_levels: [{ effort: REQUIRED_EFFORT, description: "Maximum" }],
    shell_type: "unified_exec", visibility: "none", supported_in_api: true, priority: 0, availability_nux: null,
    upgrade: null, include_skills_usage_instructions: false, include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false, supports_reasoning_summary_parameter: false, default_reasoning_summary: "none",
    support_verbosity: false, default_verbosity: null, apply_patch_tool_type: "freeform", web_search_tool_type: "text",
    truncation_policy: { mode: "tokens", limit: 10_000 }, supports_image_detail_original: false,
    context_window: contextWindow, max_context_window: contextWindow,
    experimental_supported_tools: [], input_modalities: route.inputModalities, supports_search_tool: true,
    use_responses_lite: false, node_repl_auto_review_required: false, node_repl_disabled: false,
    tool_mode: "direct", multi_agent_version: "v2",
  });
  return { models: [
    modelDefinition(
      MODEL_ALIAS,
      "Managed native subagent",
      "Centrally routed native subagent",
      managedContextWindow,
    ),
    modelDefinition(
      DEVIN_FREE_MODEL_ALIAS,
      "Devin free native subagent",
      `Direct ${models.terminal.label} native subagent`,
      models.terminal.max_context_tokens,
    ),
  ] };
}

function health(requestedRoute = "auto") {
  const defaultActual = requestedRoute === "devin-free"
    ? { provider: "devin", model: models.terminal.model_uid, label: models.terminal.label }
    : calendarQuotaState.isActive()
      ? { provider: route.quotaFallbackProvider, model: route.fallbackModels[0], label: route.fallbackModels[0] }
      : { provider: "devin", model: models.primary.model_uid, label: models.primary.label };
  const routeActual = runtime.actualByConfiguredRoute[requestedRoute] || defaultActual;
  return {
    ok: true, provider: PROVIDER_ID, port, modelAlias: MODEL_ALIAS,
    modelAliases: { auto: MODEL_ALIAS, devinFree: DEVIN_FREE_MODEL_ALIAS }, effort: REQUIRED_EFFORT,
    lastActualProvider: routeActual.provider,
    lastActualModel: routeActual.model,
    lastActualModelLabel: routeActual.label,
    auth, inputModalities: route.inputModalities,
    routing: {
      primary: { uid: models.primary.model_uid, label: models.primary.label, cost: models.primary.cost_summary || models.primary.cost_tier },
      quotaFallback: {
        provider: route.quotaFallbackProvider,
        uids: route.fallbackModels,
        effort: FALLBACK_REQUIRED_EFFORT,
        authSource: FALLBACK_REQUIRED_AUTH_SOURCE,
        explicitCostRequiredUsd: 0,
        endpoint: FALLBACK_BRIDGE_ENDPOINT,
      },
      terminalFallback: {
        provider: "devin",
        uid: models.terminal.model_uid,
        label: models.terminal.label,
        cost: models.terminal.cost_summary || models.terminal.cost_tier,
      },
      orderedPolicy: "devin_primary_then_antigravity_on_quota_then_devin_free_on_antigravity_failure",
      quotaDetection: "explicit_daily_or_weekly_quota_failure_with_single_bounded_recovery_probe_every_30_minutes",
    },
    apiKeysStripped: true, isolatedConfigImports: ["agents_standard"], lazyRzMcpProxyTools: 2,
    rawPromptFilesRetained: false, ephemeralSessionsRemoved: true,
    activeThreadTurns: activeThreadTurns.size, pinnedQuotaTasks: quotaTaskPins.size,
    calendarQuotaState: calendarQuotaState.snapshot(), runtime,
  };
}

function jsonResponse(response, status, value) {
  const body = json(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

async function selfTest() {
  const fixedQuotaNow = new Date(2026, 7, 28, 12, 0, 0, 0).getTime();
  const selfTestQuotaState = new CalendarQuotaState(null, () => fixedQuotaNow);
  const selfTestTaskPins = new ActiveTaskRoutePins();
  const selfTestRouteContext = { threadId: "thread-calendar", taskDiagnostics: { taskHash: "task-calendar" } };
  if (chooseRoute(selfTestRouteContext, selfTestQuotaState, selfTestTaskPins).key !== "primary") {
    throw new Error("unified primary route failed");
  }
  const dailyQuotaFailure = { code: 1, stdout: "", stderr: "Daily usage quota reached" };
  const weeklyQuotaFailure = { code: 1, stdout: "", stderr: "Weekly usage quota exhausted" };
  if (
    !selfTestQuotaState.record(dailyQuotaFailure)
    || selfTestQuotaState.snapshot().kind !== "daily"
    || chooseRoute(selfTestRouteContext, selfTestQuotaState, selfTestTaskPins).key !== "fallback"
    || runtime.lastQuotaSkipScope !== "calendar_quota"
  ) {
    throw new Error("daily calendar quota routing failed");
  }
  let recoveryProbeNow = fixedQuotaNow;
  const recoveryProbeState = new CalendarQuotaState(null, () => recoveryProbeNow);
  recoveryProbeState.record(dailyQuotaFailure);
  recoveryProbeNow += QUOTA_RECOVERY_PROBE_MS;
  const recoveryProbeRoute = chooseRoute(selfTestRouteContext, recoveryProbeState, selfTestTaskPins);
  if (
    recoveryProbeRoute.key !== "primary"
    || recoveryProbeRoute.reason !== "calendar_quota_recovery_probe"
    || chooseRoute(selfTestRouteContext, recoveryProbeState, selfTestTaskPins).key !== "fallback"
  ) {
    throw new Error("bounded calendar quota recovery probe routing failed");
  }
  const dailyRetryAt = selfTestQuotaState.snapshot().retryAt;
  if (!selfTestQuotaState.record(weeklyQuotaFailure) || selfTestQuotaState.snapshot().retryAt <= dailyRetryAt) {
    throw new Error("weekly quota did not extend the calendar route pin");
  }
  const weeklyRetryAt = selfTestQuotaState.snapshot().retryAt;
  if (selfTestQuotaState.isActive(weeklyRetryAt) || selfTestQuotaState.snapshot(weeklyRetryAt).active) {
    throw new Error("calendar quota route did not reopen at its refresh boundary");
  }
  const quotaFixturePath = join(REQUEST_DIRECTORY, `quota-state-self-test-${process.pid}.json`);
  try {
    const persistentQuota = new CalendarQuotaState(quotaFixturePath, () => fixedQuotaNow);
    persistentQuota.record(dailyQuotaFailure);
    persistentQuota.record(weeklyQuotaFailure);
    const reloadedQuota = new CalendarQuotaState(quotaFixturePath, () => fixedQuotaNow);
    if (
      reloadedQuota.snapshot().kind !== "weekly"
      || !Number.isFinite(reloadedQuota.snapshot().nextProbeAt)
    ) {
      throw new Error("persisted quota state did not reload");
    }
  } finally {
    try { unlinkSync(quotaFixturePath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    try { unlinkSync(`${quotaFixturePath}.${process.pid}.tmp`); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  if (
    route.quotaFallbackProvider !== "antigravity"
    || route.fallbackModels.length !== 2
    || !models.terminal.model_uid
  ) {
    throw new Error("ordered provider configuration failed");
  }
  if (!LEGACY_REQUEST_EFFORTS.has("max") || LEGACY_REQUEST_EFFORTS.has("xhigh")) throw new Error("legacy effort compatibility failed");
  const isolatedEnvironment = sanitizedEnvironment({
    OPENAI_API_KEY: "must-not-survive",
    OPENAI_ORG_ID: "must-not-survive",
    OPENAI_PROJECT_ID: "must-not-survive",
    CODEX_API_KEY: "must-not-survive",
    RETAINED_TEST_VALUE: "retained",
  });
  if (["OPENAI_API_KEY", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "CODEX_API_KEY"].some((key) => key in isolatedEnvironment)) {
    throw new Error("OpenAI credential isolation failed");
  }
  if (isolatedEnvironment.RETAINED_TEST_VALUE !== "retained") throw new Error("environment isolation removed unrelated values");
  if (!QUOTA_FAILURE.test("Daily usage quota reached")) throw new Error("quota detection failed");
  if (!RESOURCE_EXHAUSTED.test('{"cognition.ai/errorKind":"resource_exhausted","cognition.ai/retryable":true}')) throw new Error("resource exhaustion detection failed");
  const wrappedQuotaFailure = {
    code: 1,
    stdout: "",
    stderr: 'Your weekly usage quota has been exhausted. {"cognition.ai/errorKind":"resource_exhausted","cognition.ai/retryable":true}',
  };
  if (!isQuotaFailure(wrappedQuotaFailure)) throw new Error("wrapped quota failure detection failed");
  if (isRetryableResourceFailure(wrappedQuotaFailure)) throw new Error("quota failure incorrectly classified as retryable capacity");
  const transientResourceFailure = {
    code: 1,
    stdout: "",
    stderr: '{"cognition.ai/errorKind":"resource_exhausted","cognition.ai/retryable":true}',
  };
  if (!isRetryableResourceFailure(transientResourceFailure)) throw new Error("transient capacity classification failed");
  if (resourceBackoffMs(1) !== 5_000 || resourceBackoffMs(6) !== 120_000 || resourceBackoffMs(20) !== 120_000) throw new Error("resource backoff schedule failed");
  const environmentWorkspace = promptFrom({
    stream: true,
    model: MODEL_ALIAS,
    reasoning: { effort: REQUIRED_EFFORT },
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `<environment_context><cwd>${process.cwd()}</cwd></environment_context>` }],
    }],
  }).workingDirectory;
  if (environmentWorkspace !== process.cwd()) throw new Error("environment workspace detection failed");
  const directFreeContext = promptFrom({
    stream: true,
    model: DEVIN_FREE_MODEL_ALIAS,
    reasoning: { effort: REQUIRED_EFFORT },
    input: [{ type: "message", role: "user", content: "Use the direct free route." }],
  });
  if (
    directFreeContext.requestedRoute !== "devin-free"
    || chooseRoute(directFreeContext, selfTestQuotaState, selfTestTaskPins).key !== "terminal"
  ) {
    throw new Error("direct Devin free route failed");
  }
  const advertisedModels = managedModelsResponse().models;
  if (
    advertisedModels.length !== 2
    || !advertisedModels.some((model) => model.slug === MODEL_ALIAS)
    || !advertisedModels.some((model) => model.slug === DEVIN_FREE_MODEL_ALIAS)
  ) {
    throw new Error("managed route aliases were not both advertised");
  }
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
  const reversedPrompt = promptFrom({
    stream: true,
    model: MODEL_ALIAS,
    reasoning: { effort: REQUIRED_EFFORT },
    input: [
      { type: "agent_message", id: "self-test-checkpoint-first", author: "Codex", recipient: "/root/self_test", content: [{ type: "input_text", text: checkpoint }] },
      { type: "agent_message", id: "self-test-task-last", author: "Codex", recipient: "/root/self_test", content: [{ type: "input_text", text: task }] },
    ],
  }).prompt;
  const reversedTaskIndex = reversedPrompt.indexOf(task);
  const reversedCheckpointIndex = reversedPrompt.indexOf(checkpoint);
  if (!(reversedTaskIndex >= 0 && reversedTaskIndex < reversedCheckpointIndex)) throw new Error("checkpoint precedence failed");
  let supersededAbortCalls = 0;
  const firstTurn = { requestId: "first", abort: () => { supersededAbortCalls += 1; } };
  const secondTurn = { requestId: "second", abort: () => {} };
  registerThreadTurn("thread-self-test", firstTurn);
  registerThreadTurn("thread-self-test", secondTurn);
  unregisterThreadTurn("thread-self-test", firstTurn);
  if (supersededAbortCalls !== 1 || activeThreadTurns.get("thread-self-test") !== secondTurn) throw new Error("thread turn replacement failed");
  unregisterThreadTurn("thread-self-test", secondTurn);
  if (activeThreadTurns.has("thread-self-test")) throw new Error("thread turn cleanup failed");
  const heartbeatWrites = [];
  writeSseHeartbeat({ destroyed: false, writableEnded: false, write: (value) => heartbeatWrites.push(value) }, "resp-self-test");
  const heartbeat = heartbeatWrites.join("");
  if (!heartbeat.includes("event: response.in_progress") || !heartbeat.includes('"id":"resp-self-test"')) throw new Error("SSE heartbeat failed");
  const relayWrites = [];
  const relayResponse = {
    destroyed: false,
    writableEnded: false,
    write: (value) => relayWrites.push(value),
  };
  const relayProgress = createProgressEmitter(relayResponse);
  const relay = createFallbackStreamRelay(relayResponse, "resp-relay", MODEL_ALIAS, relayProgress);
  await relay.accept({
    type: "response.output_item.added",
    payload: {
      output_index: 0,
      item: { type: "reasoning", id: "progress_provider", status: "in_progress", summary: [] },
    },
  });
  await relay.accept({
    type: "response.reasoning_summary_text.delta",
    payload: { item_id: "progress_provider", output_index: 0, summary_index: 0, delta: "safe native progress\n" },
  });
  await relay.accept({
    type: "response.output_item.added",
    payload: { output_index: 1, item: { type: "reasoning", id: "rs-hidden", status: "in_progress", summary: [] } },
  });
  await relay.accept({
    type: "response.reasoning_summary_text.delta",
    payload: { item_id: "rs-hidden", output_index: 1, summary_index: 0, delta: "hidden provider reasoning" },
  });
  if (
    !relayProgress.added
    || relay.committed
    || !relayWrites.join("").includes("safe native progress")
    || relayWrites.join("").includes("hidden provider reasoning")
  ) {
    throw new Error("fallback progress relay boundary failed");
  }
  await relay.accept({
    type: "response.output_item.added",
    payload: { output_index: 1, item: responseMessageItem("msg-relay", "") },
  });
  await relay.accept({
    type: "response.content_part.added",
    payload: {
      item_id: "msg-relay",
      output_index: 1,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
  });
  if (relay.committed) throw new Error("fallback relay committed before visible output");
  await relay.accept({
    type: "response.output_text.delta",
    payload: { item_id: "msg-relay", output_index: 1, content_index: 0, delta: "streamed" },
  });
  if (!relay.committed || relay.streamedMessageIds.size !== 0) throw new Error("fallback relay did not retain provider output for ordered completion");
  const streamedFixture = {
    output: [responseMessageItem("msg-relay", "streamed", "completed")],
  };
  const relayProgressItem = relayProgress.finish();
  emitOutputItems(relayResponse, streamedFixture, relay.streamedMessageIds, [relayProgressItem]);
  const relayOutput = relayWrites.join("");
  if (
    relayOutput.split("event: response.output_item.added").length - 1 !== 2
    || !relayOutput.includes('"output_index":1')
    || !relayOutput.includes("event: response.output_text.done")
    || !relayOutput.includes("event: response.output_item.done")
  ) {
    throw new Error("fallback streamed output lifecycle replay failed");
  }
  const fallbackFixture = fallbackResult({
    status: "completed",
    output: [
      {
        type: "reasoning",
        id: "progress-fallback",
        status: "completed",
        summary: [{ type: "summary_text", text: "provider progress" }],
      },
      responseMessageItem("msg-fallback", "done", "completed"),
    ],
    usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 10 }, output_tokens: 20 },
    metadata: {
      actual_provider: route.quotaFallbackProvider,
      actual_model: route.fallbackModels[0],
      actual_model_label: "Claude Opus 4.6 (Thinking)",
      auth_source: FALLBACK_REQUIRED_AUTH_SOURCE,
      peak_turn_context_tokens: 110,
      output_tokens_per_second: 250,
      native_tool_names: ["exec_command"],
      rzmcp_tools_called: ["find_blueprint_nodes"],
      codex_tool_schema_bytes_forwarded: 0,
      lazy_rzmcp_proxy_tools: 2,
    },
  });
  if (
    fallbackFixture.selected.key !== "fallback"
    || fallbackFixture.selected.provider !== "antigravity"
    || fallbackFixture.output.length !== 1
    || fallbackFixture.output[0]?.id !== "msg-fallback"
    || fallbackFixture.nativeToolNames[0] !== "exec_command"
    || fallbackFixture.rzMcpTools[0] !== "find_blueprint_nodes"
    || fallbackFixture.peakTurnContextTokens !== 110
    || fallbackFixture.outputTokensPerSecond !== 250
  ) {
    throw new Error("Antigravity result normalization failed");
  }
  const replayWrites = [];
  const replayOutput = emitOutputItems({
    destroyed: false,
    writableEnded: false,
    write: (value) => replayWrites.push(value),
  }, fallbackFixture);
  if (
    replayOutput[0]?.id !== "msg-fallback"
    || !replayWrites.join("").includes('"type":"message"')
  ) {
    throw new Error("Antigravity completion replay failed");
  }
  if (!sanitizedProviderFailure(new Error("authorization: Bearer secret-value")).includes("[REDACTED]")) {
    throw new Error("provider failure redaction failed");
  }
  if (
    providerResponseErrorCode({ routeCommitted: true }) !== "provider_state_changed"
    || providerResponseErrorCode(new Error("transient")) !== "external_provider_error"
  ) {
    throw new Error("committed fallback failure classification failed");
  }
  const committedError = preserveProviderCommit(new Error("fixture"), {
    toolCalls: [{ name: "apply_patch" }, { name: "apply_patch" }, { name: "view_file" }],
  });
  if (
    committedError.routeCommitted !== true
    || committedError.toolCalls !== 3
    || committedError.toolNames.join(",") !== "apply_patch,view_file"
  ) {
    throw new Error("Devin native-tool commitment classification failed");
  }
  let concurrentFreeCalls = 0;
  let peakConcurrentFreeCalls = 0;
  const freeRoute = { key: "terminal" };
  await Promise.all(Array.from({ length: 4 }, () => withRouteCapacity(freeRoute, undefined, async () => {
    concurrentFreeCalls += 1;
    peakConcurrentFreeCalls = Math.max(peakConcurrentFreeCalls, concurrentFreeCalls);
    await delayWithAbort(5);
    concurrentFreeCalls -= 1;
  })));
  if (
    peakConcurrentFreeCalls !== FREE_ROUTE_CONCURRENCY
    || terminalCapacity.active !== 0
    || terminalCapacity.waiters.length !== 0
  ) {
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
    if (request.method === "GET" && url.pathname === "/health") {
      const requestedRoute = url.searchParams.get("route") || "auto";
      if (!["auto", "devin-free"].includes(requestedRoute)) {
        return jsonResponse(response, 400, { error: { message: `Unknown health route ${json(requestedRoute)}` } });
      }
      return jsonResponse(response, 200, health(requestedRoute));
    }
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
