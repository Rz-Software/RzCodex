#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  TaskStateError,
  activeTaskPromptSection,
  isExplicitReadOnlyTask,
  isBridgeProgressReasoning,
  normalizeAgentMessageContent,
  referencedPriorTaskPromptSection,
  rzMcpModeForTask,
  taskControlPromptSections,
  taskDeliveryDiagnostics,
  taskOwnershipHash,
  taskStateFromInput,
} from "./codebuddy-subagent-task-state.mjs";
import { projectInstructionsPromptSection } from "./native-project-instructions.mjs";
import {
  ActiveTaskProviderPins,
  ActiveTaskRoutePins,
  fallbackForwardBody,
  runOrderedProviderChain,
  runResponsesBridge,
  validateOAuthFallbackCompletion,
} from "./native-subagent-provider-router.mjs";
import {
  NativeCliAgentError,
  nativeCliAgentRunnerSelfTest,
  nativeCliAgentContext,
  runOpenCodeNativeAgent,
} from "./native-cli-agent-runner.mjs";

const PROVIDER_ID = "devin";
const MODEL_ALIAS = "@preset/codex-subagents";
const DEVIN_FREE_MODEL_ALIAS = "@preset/codex-subagents-devin-free";
const OLLAMA_MODEL_ALIAS = "@preset/codex-subagents-ollama";
const REQUIRED_EFFORT = "high";
const OLLAMA_REQUIRED_EFFORT = "max";
const LEGACY_REQUEST_EFFORTS = new Set(["max"]);
const DEFAULT_PORT = 54548;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
// Keep enough task-local tool history for complex implementation work without approaching the
// providers' very large context windows. About 120k characters is roughly the requested 30k-token
// working context; trivial turns remain much smaller because this is only a cap.
const MAX_PROMPT_CHARS = 120_000;
const MAX_ACTIVE_TASK_CHARS = 40_000;
const OUTPUT_LIMIT = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
const STALE_REQUEST_FILE_AGE_MS = REQUEST_TIMEOUT_MS + 5 * 60 * 1000;
const SSE_HEARTBEAT_MS = 15 * 1000;
const PROVIDER_RECOVERY_BUDGET_MS = 45 * 1000;
const PROVIDER_RECOVERY_BACKOFF_MS = 1 * 1000;
const ROUTE_CAPACITY_WAIT_MS = PROVIDER_RECOVERY_BUDGET_MS;
const NATIVE_PROGRESS_POLL_MS = 1 * 1000;
const NATIVE_PROVIDER_INACTIVITY_MS = 55 * 1000;
const FREE_ROUTE_CONCURRENCY = 2;
const OLLAMA_CLOUD_CONCURRENCY = 3;
const RESOURCE_BACKOFF_BASE_MS = 5 * 1000;
const RESOURCE_BACKOFF_MAX_MS = 10 * 1000;
const QUOTA_RECOVERY_PROBE_MS = 30 * 60 * 1000;
const ANTIGRAVITY_BRIDGE_ENDPOINT = "http://127.0.0.1:54549/v1/responses";
const ANTIGRAVITY_REQUIRED_AUTH_SOURCE = "Antigravity cached OAuth session";
const ANTIGRAVITY_REQUIRED_EFFORT = "high";
const ANTIGRAVITY_CONTEXT_WINDOW = 131_072;
const OLLAMA_AUTH_SOURCE = "Ollama local signed-in session";
const OLLAMA_CONTEXT_WINDOW = 1_048_576;
const CODEBUDDY_BRIDGE_ENDPOINT = "http://127.0.0.1:54547/v1/responses";
const CODEBUDDY_REQUIRED_AUTH_SOURCE = "www.codebuddy.ai";
const CODEBUDDY_REQUIRED_EFFORT = "max";
const REQUIRED_AUTO_PROVIDER_ORDER = ["antigravity", "devin", "ollama", "devin-free", "codebuddy"];
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
const INTERRUPTED_STREAM = /stream (?:was )?interrupted|stream disconnected|connection (?:closed|reset)|unexpected end of (?:file|stream)|please continue the task you were working on/i;
const PROVIDER_COMPACTION = /provider context compacted/i;
const READ_ONLY_RZMCP_TOOL_NAME = /^(?:analyze|check|count|describe|discover|does|enumerate|find|get|has|inspect|is|list|locate|query|read|resolve|search|validate)_/i;
const PERMISSION_REJECTION = /rejected a tool call that requires confirmation|permission (?:was )?denied|requires (?:user )?confirmation/i;
const VALIDATION_RESTRICTED_TASK = /\b(?:do not|must not|never)[^.\n]{0,160}\b(?:build|compile|run\s+(?:the\s+)?tests?|test|control\s+(?:the\s+)?editor|use\s+(?:the\s+)?editor|pie|sie)\b|\bno\s+(?:build|compile|tests?|editor|pie|sie)\b|\b(?:aucun(?:e)?|sans|interdiction\s+d['’](?:ex[eé]cuter|utiliser))[^.\n]{0,160}\b(?:build|compil(?:e|er|ation)|tests?|editor|[eé]diteur|pie|sie)\b/i;
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
    "OLLAMA_API_KEY",
  ]) delete env[key];
  return env;
}

function executionPolicyFromTaskState(taskState) {
  const taskText = taskState?.activeTask?.text || "";
  const readOnly = taskState?.activeTask?.intent === "analysis" || isExplicitReadOnlyTask(taskText);
  const validationRestricted = VALIDATION_RESTRICTED_TASK.test(taskText);
  return {
    // Devin's non-interactive auto and accept-edits modes still reject ordinary shell commands.
    // Native subagents need the same file/shell surface as the other managed providers; task scope
    // and RzMCP access remain constrained independently below and in the pinned task prompt.
    permissionMode: "dangerous",
    rzMcpMode: rzMcpModeForTask(taskText, readOnly),
    readOnly,
    validationRestricted,
  };
}

function providerEnvironment(executionPolicy) {
  return {
    ...sanitizedEnvironment(),
    RZCODEX_SUBAGENT_RZMCP_MODE: executionPolicy.rzMcpMode,
  };
}

function centralRoute() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(CENTRAL_CONFIG, "utf8"));
  } catch (error) {
    throw new BridgeError(`Cannot read central subagent configuration: ${error.message}`, 500);
  }
  const configuredOrder = parsed.autoProviderOrder;
  if (
    !Array.isArray(configuredOrder)
    || configuredOrder.length !== REQUIRED_AUTO_PROVIDER_ORDER.length
    || configuredOrder.some((provider, index) => provider !== REQUIRED_AUTO_PROVIDER_ORDER[index])
  ) {
    throw new BridgeError(
      `autoProviderOrder must be ${json(REQUIRED_AUTO_PROVIDER_ORDER)}, got ${json(configuredOrder)}`,
      500,
    );
  }
  const route = assertObject(parsed[PROVIDER_ID], `central route ${PROVIDER_ID}`);
  const antigravityRoute = assertObject(parsed.antigravity, "central route antigravity");
  const ollamaRoute = assertObject(parsed.ollama, "central route ollama");
  const codeBuddyRoute = assertObject(parsed.codebuddy, "central route codebuddy");
  const autoRoute = assertObject(parsed.routes?.auto, "central managed route auto");
  const inputModalities = route.inputModalities;
  if (!Array.isArray(inputModalities) || inputModalities.length !== 1 || inputModalities[0] !== "text") {
    throw new BridgeError("Devin managed route must declare exactly the text modality", 500);
  }
  const ollamaInputModalities = ollamaRoute.inputModalities;
  if (!Array.isArray(ollamaInputModalities) || ollamaInputModalities.length !== 1 || ollamaInputModalities[0] !== "text") {
    throw new BridgeError("Ollama managed route must declare exactly the text modality", 500);
  }
  const ollamaEffort = requireString(ollamaRoute.reasoningEffort, "ollama.reasoningEffort");
  if (ollamaEffort !== OLLAMA_REQUIRED_EFFORT) {
    throw new BridgeError(`Ollama managed route must use ${OLLAMA_REQUIRED_EFFORT} reasoning`, 500);
  }
  if (!Array.isArray(ollamaRoute.responseModels) || ollamaRoute.responseModels.length === 0) {
    throw new BridgeError("ollama.responseModels must contain at least one accepted response model", 500);
  }
  if (ollamaRoute.maxConcurrency !== OLLAMA_CLOUD_CONCURRENCY) {
    throw new BridgeError(
      `ollama.maxConcurrency must match the Ollama Pro cloud limit ${OLLAMA_CLOUD_CONCURRENCY}`,
      500,
    );
  }
  const nativeFallbackRoute = requireString(autoRoute.nativeFallbackRoute, "routes.auto.nativeFallbackRoute");
  const nativeRoute = assertObject(parsed.routes?.[nativeFallbackRoute], `central managed route ${nativeFallbackRoute}`);
  if (nativeFallbackRoute === "auto" || nativeRoute.modelProvider !== "openai") {
    throw new BridgeError("routes.auto.nativeFallbackRoute must reference a distinct native OpenAI route", 500);
  }
  return {
    autoProviderOrder: [...configuredOrder],
    primaryModel: requireString(route.primaryModel, "primaryModel"),
    antigravityProvider: "antigravity",
    antigravityModels: [
      requireString(antigravityRoute.primaryModel, "antigravity.primaryModel"),
      requireString(antigravityRoute.quotaFallbackModel, "antigravity.quotaFallbackModel"),
    ],
    codeBuddyModel: requireString(codeBuddyRoute.model, "codebuddy.model"),
    nativeFallbackRoute,
    ollamaModel: requireString(ollamaRoute.model, "ollama.model"),
    ollamaLabel: requireString(ollamaRoute.label, "ollama.label"),
    ollamaResponseModels: ollamaRoute.responseModels.map((model, index) =>
      requireString(model, `ollama.responseModels[${index}]`)),
    ollamaEffort,
    ollamaInputModalities,
    ollamaMaxConcurrency: ollamaRoute.maxConcurrency,
    terminalFallbackModel: requireString(route.terminalFallbackModel, "terminalFallbackModel"),
    inputModalities,
  };
}

function modelCatalog() {
  const result = spawnSync(DEVIN_EXE, ["models", "list", "--format", "json"], {
    env: sanitizedEnvironment(), windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
    timeout: 15_000,
  });
  if (result.status !== 0) throw new BridgeError(`Cannot query Devin models: ${result.stderr || result.stdout}`, 500);
  const parsed = JSON.parse(result.stdout);
  return (parsed.families || []).flatMap((family) => family.variants || []);
}

function authStatus() {
  const result = spawnSync(DEVIN_EXE, ["auth", "status"], {
    env: sanitizedEnvironment(), windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024,
    timeout: 15_000,
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
  for (const name of readdirSync(REQUEST_DIRECTORY)) {
    if (!/^[0-9a-f-]{36}(?:-[0-9a-f-]{36})?\.txt$/i.test(name)) continue;
    const path = join(REQUEST_DIRECTORY, name);
    try {
      if (Date.now() - statSync(path).mtimeMs >= STALE_REQUEST_FILE_AGE_MS) unlinkSync(path);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        process.stderr.write(`[RzCodex] Deferred stale Devin prompt cleanup for ${name}: ${error?.code || error?.name || "unknown_error"}\n`);
      }
    }
  }
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
  primary: catalogModel(route.primaryModel, "GLM-5.3 Flash Max", false),
  terminal: catalogModel(route.terminalFallbackModel, "GLM-5.2 High", true),
};

const runtime = {
  incomingRequests: 0, requests: 0, completed: 0, failed: 0, rejected: 0,
  activeRequests: 0,
  activeFreeRequests: 0, queuedFreeRequests: 0,
  activeOllamaRequests: 0, queuedOllamaRequests: 0,
  supersededTurns: 0,
  resourceRetries: 0, providerContinuations: 0, nativeTerminalContinuations: 0,
  streamContinuations: 0, compactionCheckpoints: 0,
  providerCheckpoints: 0,
  permissionCheckpoints: 0, activeResourceBackoffs: 0,
  lastResourceModel: null, lastResourceRetryAttempt: 0,
  lastResourceBackoffMs: 0, lastResourceRetryAt: null,
  lastStreamContinuationAt: null, lastStreamContinuationSessionHash: null,
  lastRejectedError: null, lastConfiguredRoute: null, lastActualModel: null,
  lastActualProvider: null, lastModelLabel: null, lastQuotaFallback: false,
  lastTerminalFallback: false, lastFallbackReason: null,
  fallbackAttempts: 0, fallbackCompleted: 0, fallbackFailed: 0, terminalFallbacks: 0,
  providerAttempts: { antigravity: 0, devin: 0, ollama: 0, devinFree: 0, codebuddy: 0 },
  providerFailures: { antigravity: 0, devin: 0, ollama: 0, "devin-free": 0, codebuddy: 0 },
  recentProviderFailures: [],
  lastProviderSequence: [],
  fallbackStreamCommits: 0, lastFallbackStreamCommitted: false,
  lastFallbackProviderOutputObserved: false,
  lastFallbackStreamedMessageCount: 0,
  quotaProbeSkips: 0, quotaRecoveryProbes: 0, quotaPinsReleased: 0,
  calendarQuotaSkips: 0, calendarQuotaActivations: 0, calendarQuotaClears: 0,
  lastQuotaProbeSkipped: false, lastQuotaSkipScope: null, lastQuotaPinCreated: false,
  providerTaskPinsCreated: 0, providerTaskPinsReleased: 0,
  providerTaskPinsReleasedOnFailure: 0, lastPinnedProviderStage: null,
  lastFallbackError: null, lastFallbackAuthSource: null,
  lastCreditCost: null, lastAcuCost: null,
  lastInputTokens: null, lastCachedInputTokens: null, lastOutputTokens: null,
  lastPeakTurnContextTokens: null, lastOutputTokensPerSecond: null,
  lastNativeToolCalls: 0, lastNativeToolNames: [], lastRzMcpTools: [],
  lastToolSchemaBytesIgnored: 0, lastToolSchemaBytesForwarded: 0,
  lastWorkingDirectory: null, lastTaskId: null, lastTaskName: null, lastTaskHash: null,
  lastTaskIntent: null, lastTaskDeliveryMode: null, lastTaskPartTypes: [],
  lastTaskPartLengths: [], lastCompleteTaskDelivered: false,
  lastPermissionMode: null, lastRzMcpMode: null,
  actualByConfiguredRoute: { auto: null, ollama: null, "devin-free": null },
};

const terminalCapacity = { active: 0, waiters: [] };
const ollamaCapacity = { active: 0, waiters: [] };
const activeThreadTurns = new Map();
const quotaTaskPins = new ActiveTaskRoutePins();
const providerTaskPins = new ActiveTaskProviderPins();
const retainedDevinSessions = new Map();

function ownershipTaskHash(context) {
  return taskOwnershipHash(context.taskState) ?? context.taskDiagnostics?.taskHash ?? null;
}

function pinProviderTask(context, stage) {
  if (context.requestedRoute !== "auto") return false;
  const changed = providerTaskPins.pin(context.threadId, ownershipTaskHash(context), stage);
  if (changed) runtime.providerTaskPinsCreated += 1;
  runtime.lastPinnedProviderStage = stage;
  return changed;
}

function preserveProviderPinForAbortedTurn(context, error, signal) {
  if (!signal?.aborted) return null;
  const stage = providerTaskPins.get(context.threadId, ownershipTaskHash(context));
  if (stage === null) return null;
  runtime.lastPinnedProviderStage = stage;
  error.providerTaskPinPreserved = true;
  error.routeCommitted = true;
  return stage;
}

function retainedDevinSessionKey(context, selectedModel) {
  const taskHash = ownershipTaskHash(context);
  if (!context.threadId || !taskHash || !selectedModel?.model_uid) return null;
  return `${context.threadId}:${taskHash}:${selectedModel.model_uid}`;
}

function syncRouteCapacityRuntime() {
  runtime.activeFreeRequests = terminalCapacity.active;
  runtime.queuedFreeRequests = terminalCapacity.waiters.length;
  runtime.activeOllamaRequests = ollamaCapacity.active;
  runtime.queuedOllamaRequests = ollamaCapacity.waiters.length;
}

async function registerThreadTurn(threadId, registration) {
  if (!threadId) return;
  const previous = activeThreadTurns.get(threadId);
  if (previous && previous !== registration) {
    runtime.supersededTurns += 1;
    previous.abort();
    if (previous.done) {
      let timer;
      try {
        await Promise.race([
          previous.done,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new BridgeError("Superseded provider turn did not release within 5 seconds", 409)),
              5_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
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

function capacityUnavailableError(routeKey, waitedMs = 0) {
  const detail = waitedMs > 0 ? ` after waiting ${waitedMs}ms` : "";
  return new BridgeError(`Managed ${routeKey} capacity is unavailable${detail}`, 503);
}

function rejectCapacityWaiter(capacity, waiter, error) {
  if (waiter.settled) return;
  waiter.settled = true;
  const index = capacity.waiters.indexOf(waiter);
  if (index !== -1) capacity.waiters.splice(index, 1);
  clearTimeout(waiter.timer);
  waiter.signal?.removeEventListener("abort", waiter.onAbort);
  syncRouteCapacityRuntime();
  waiter.reject(error);
}

function acquireCapacity(capacity, limit, signal, routeKey, maxWaitMs) {
  throwIfAborted(signal);
  if (capacity.active < limit) {
    capacity.active += 1;
    syncRouteCapacityRuntime();
    return Promise.resolve();
  }
  if (maxWaitMs <= 0) return Promise.reject(capacityUnavailableError(routeKey));
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal, onAbort: null, timer: null, settled: false };
    waiter.onAbort = () => rejectCapacityWaiter(capacity, waiter, abortError());
    waiter.timer = setTimeout(
      () => rejectCapacityWaiter(capacity, waiter, capacityUnavailableError(routeKey, maxWaitMs)),
      maxWaitMs,
    );
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    capacity.waiters.push(waiter);
    syncRouteCapacityRuntime();
  });
}

function releaseCapacity(capacity) {
  capacity.active = Math.max(0, capacity.active - 1);
  while (capacity.waiters.length > 0) {
    const waiter = capacity.waiters.shift();
    if (waiter.settled) continue;
    waiter.settled = true;
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    if (waiter.signal?.aborted) {
      waiter.reject(abortError());
      continue;
    }
    capacity.active += 1;
    waiter.resolve();
    break;
  }
  syncRouteCapacityRuntime();
}

async function withRouteCapacity(
  selected,
  signal,
  callback,
  { skipIfBusy = false, maxWaitMs = ROUTE_CAPACITY_WAIT_MS } = {},
) {
  const capacity = selected.key === "terminal"
    ? { state: terminalCapacity, limit: FREE_ROUTE_CONCURRENCY }
    : selected.key === "ollama"
      ? { state: ollamaCapacity, limit: route.ollamaMaxConcurrency }
      : null;
  if (!capacity) return callback();
  try {
    await acquireCapacity(
      capacity.state,
      capacity.limit,
      signal,
      selected.key,
      skipIfBusy ? 0 : maxWaitMs,
    );
  } catch (error) {
    if (skipIfBusy && error?.status === 503) error.routeSkipped = true;
    throw error;
  }
  try {
    return await callback();
  } finally {
    releaseCapacity(capacity.state);
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
  throw new BridgeError("managed subagent request has no valid authoritative working directory");
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
      : modelAlias === OLLAMA_MODEL_ALIAS
        ? "ollama"
        : null;
  if (!requestedRoute) throw new BridgeError(`Unknown managed model alias ${json(modelAlias)}`);
  const effort = body.reasoning?.effort;
  const effortAccepted = requestedRoute === "ollama"
    ? effort === undefined || effort === OLLAMA_REQUIRED_EFFORT
    : effort === undefined || effort === REQUIRED_EFFORT || LEGACY_REQUEST_EFFORTS.has(effort);
  if (!effortAccepted) {
    const requiredEffort = requestedRoute === "ollama" ? OLLAMA_REQUIRED_EFFORT : REQUIRED_EFFORT;
    throw new BridgeError(`Managed subagents require centrally configured effort ${requiredEffort}`);
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
  const executionPolicy = executionPolicyFromTaskState(taskState);
  const threadId = typeof body.client_metadata?.thread_id === "string"
    ? body.client_metadata.thread_id
    : null;
  const sections = [
    `[Native delegated coding contract]\nRzCodex request ID: ${requestId}\nWork directly in the supplied workspace as the bounded native sub-agent. Use the file and command tools available in this turn. Do not spawn provider-side subagents. Honor project AGENTS.md ownership boundaries exactly; when builds, tests, editor control, PIE, runtime validation, or RzMCP execution are reserved to the parent, do not invoke them and instead report the exact checks the parent should run. For Unreal/RzMCP work that is within your assigned ownership, use only the lazy RzMCP proxy surface: search with an exact or focused query, then call only a discovered tool. Never use or request the full RzMCP catalog. On Windows, use PowerShell-native commands, single-quote ripgrep patterns containing |, and never assume Unix-only commands such as head are installed. Return concise evidence as soon as the bounded task is complete or genuinely blocked.\nAuthoritative workspace: ${workingDirectory}`,
    `[Enforced provider permissions]\nNon-interactive native file and shell tools are enabled with Devin permission mode ${executionPolicy.permissionMode}. This permission mode does not expand the active task. RzMCP mode: ${executionPolicy.rzMcpMode}. The active task's scope and restrictions remain hard boundaries, not suggestions.`,
    projectInstructionsPromptSection(workingDirectory),
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
      if (message.newTask) continue;
      if (message.index === taskState.referencedPriorControl?.index) continue;
      history.push({ index, checkpoint: message.checkpoint, text: `[Inter-agent message ${message.author} -> ${message.recipient}]\n${message.text}` });
    } else if (["function_call", "custom_tool_call", "tool_search_call"].includes(item.type)) {
      const requestInput = item.arguments ?? item.input ?? item.query ?? null;
      const requestText = requestInput === null ? "" : `\n${outputText(requestInput)}`;
      history.push({
        index,
        checkpoint: false,
        text: `[Prior Codex tool request ${item.name || "tool_search"}; call_id=${item.call_id}]${requestText}`,
      });
    } else if (["function_call_output", "custom_tool_call_output"].includes(item.type)) {
      history.push({ index, checkpoint: false, text: `[Prior Codex tool result; call_id=${item.call_id}]\n${outputText(item.output)}` });
    } else if (item.type === "tool_search_output") {
      const searchTools = item.tools ?? item.output ?? [];
      history.push({
        index,
        checkpoint: false,
        text: `[Prior Codex tool search result; call_id=${item.call_id}]\n${outputText(searchTools)}`,
      });
    } else if (item.type === "reasoning") {
      if (isBridgeProgressReasoning(item)) continue;
      const summary = Array.isArray(item.summary) ? item.summary.map((part) => part?.text || "").join("") : "";
      if (summary) history.push({ index, checkpoint: false, text: `[Prior reasoning summary]\n${summary}` });
    } else if (!["compaction", "context_compaction", "compaction_trigger"].includes(item.type)) {
      throw new BridgeError(`input[${index}] has unsupported type ${json(item.type)}`);
    }
  }
  const activeTask = activeTaskPromptSection(taskState);
  const referencedPriorTask = referencedPriorTaskPromptSection(taskState);
  const taskControlSections = taskControlPromptSections(taskState);
  const mandatorySections = [
    ...sections,
    referencedPriorTask,
    activeTask,
    ...taskControlSections,
  ].filter(Boolean);
  const mandatoryChars = mandatorySections.reduce((sum, section) => sum + section.length, 0)
    + Math.max(0, mandatorySections.length - 1) * 2;
  if (mandatoryChars > MAX_PROMPT_CHARS) {
    throw new BridgeError("Managed subagent mandatory task context exceeded its hard prompt limit", 400);
  }
  const historyBudget = MAX_PROMPT_CHARS - mandatoryChars;
  let retainedChars = 0;
  const retained = [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const { text } = history[index];
    const separatorChars = 2;
    if (retainedChars + separatorChars + text.length > historyBudget) {
      const remainingTextChars = historyBudget - retainedChars - separatorChars;
      if (retained.length === 0 && remainingTextChars > 0) {
        retained.unshift({ ...history[index], text: text.slice(-remainingTextChars) });
      }
      break;
    }
    retained.unshift(history[index]);
    retainedChars += separatorChars + text.length;
  }
  if (activeTask) {
    const activeTaskIndex = taskState.activeTask.index;
    const checkpoints = retained.filter((item) => item.checkpoint);
    const ordinaryHistory = retained.filter((item) => !item.checkpoint);
    sections.push(...ordinaryHistory.filter((item) => item.index < activeTaskIndex).map((item) => item.text));
    if (referencedPriorTask) sections.push(referencedPriorTask);
    sections.push(activeTask);
    sections.push(...ordinaryHistory.filter((item) => item.index > activeTaskIndex).map((item) => item.text));
    sections.push(...checkpoints.map((item) => item.text));
  } else {
    sections.push(...retained.map((item) => item.text));
  }
  sections.push(...taskControlSections);
  const prompt = sections.join("\n\n");
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new BridgeError("Managed subagent normalized prompt exceeded its hard limit", 500);
  }
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
    executionPolicy,
    toolSchemaBytes,
    modelAlias,
    requestedRoute,
  };
}

function antigravitySelection(reason) {
  return {
    key: "antigravity",
    provider: route.antigravityProvider,
    model: { model_uid: MODEL_ALIAS, label: "Antigravity managed chain" },
    reason,
  };
}

function ollamaSelection(reason) {
  return {
    key: "ollama",
    provider: "ollama",
    model: { model_uid: route.ollamaModel, label: route.ollamaLabel },
    reason,
  };
}

function terminalSelection(reason) {
  return {
    key: "terminal",
    provider: "devin",
    model: models.terminal,
    reason,
  };
}

function codeBuddySelection(reason) {
  return {
    key: "codebuddy",
    provider: "codebuddy",
    model: { model_uid: route.codeBuddyModel, label: route.codeBuddyModel },
    reason,
  };
}

function selectionForFailedStage(stage) {
  if (stage === "antigravity") return antigravitySelection("provider_checkpoint");
  if (stage === "ollama") return ollamaSelection("provider_checkpoint");
  if (stage === "devin-free") return terminalSelection("provider_checkpoint");
  if (stage === "codebuddy") return codeBuddySelection("provider_checkpoint");
  if (stage === "devin") {
    return { key: "primary", provider: "devin", model: models.primary, reason: "provider_checkpoint" };
  }
  return { key: stage || "external", provider: stage || "external", model: { model_uid: "unknown", label: "unknown" }, reason: "provider_checkpoint" };
}

function committedProviderResult(context, error) {
  const selected = selectionForFailedStage(error?.failedStage);
  const toolNames = [...new Set([
    ...(Array.isArray(error?.nativeToolNames) ? error.nativeToolNames : []),
    ...(Array.isArray(error?.toolNames) ? error.toolNames : []),
  ].filter((name) => typeof name === "string" && name))];
  const mutationCount = Math.max(
    Number(error?.providerMutationCount || 0),
    Number(error?.mutationToolCalls || 0),
  );
  const pinnedContinuationFailure = error?.providerTaskPinPreserved === true;
  const text = [
    "[Authoritative native-provider checkpoint]",
    `Task hash: ${context.taskDiagnostics.taskHash}`,
    `Provider: ${selected.provider}`,
    `Provider tool calls completed: ${Number(error?.toolCalls || toolNames.length)}`,
    `Provider mutation calls observed: ${mutationCount}`,
    `Tool names: ${toolNames.join(", ") || "not reported"}`,
    `Last completed tool: ${toolNames.at(-1) || "not reported"}`,
    pinnedContinuationFailure
      ? "Concrete blocker: the provider continuation stopped before completing the already-owned active task."
      : "Concrete blocker: the provider stopped after beginning tool work and did not return a terminal response.",
    pinnedContinuationFailure
      ? "The active task remains pinned to the same provider. No later provider was started and no committed context was replayed across providers; the parent can resume this same subagent."
      : "The provider turn was not replayed and no later provider was started. The delegated task may be incomplete; the parent should inspect the preserved work and decide whether to resume or reassign it.",
  ].join("\n");
  return {
    text,
    selected,
    providerMetadata: { provider_checkpoint: true },
    quotaFallback: false,
    terminalFallback: selected.key === "terminal",
    fallbackReason: null,
    fallbackFailure: null,
    creditCost: 0,
    acuCost: 0,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    peakTurnContextTokens: Number(error?.peakContextTokens || 0),
    outputTokensPerSecond: null,
    toolCalls: [],
    nativeToolNames: toolNames,
    rzMcpTools: Array.isArray(error?.rzMcpTools) ? error.rzMcpTools : [],
    toolSchemaBytesIgnored: context.toolSchemaBytes,
    toolSchemaBytesForwarded: 0,
    autoStage: error?.failedStage || null,
    preserveProviderPin: pinnedContinuationFailure,
  };
}

function initialSelection(context) {
  if (context.requestedRoute === "devin-free") return terminalSelection("explicit_devin_free_route");
  if (context.requestedRoute === "ollama") return ollamaSelection("explicit_ollama_route");
  return antigravitySelection("auto_primary_antigravity");
}

function chooseDevinStage(context, quotaState = calendarQuotaState, taskPins = quotaTaskPins) {
  runtime.lastQuotaPinCreated = false;
  runtime.lastQuotaProbeSkipped = taskPins.has(
    context.threadId,
    ownershipTaskHash(context),
  );
  runtime.lastQuotaSkipScope = runtime.lastQuotaProbeSkipped ? "active_task" : null;
  if (runtime.lastQuotaProbeSkipped) {
    runtime.quotaProbeSkips += 1;
    return ollamaSelection("active_task_confirmed_devin_quota_failure");
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
    return ollamaSelection("persisted_calendar_devin_quota_failure");
  }
  return { key: "primary", provider: "devin", model: models.primary, reason: "devin_quota_available" };
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

function completedToolCalls(toolCalls, conversationRows) {
  const completedIds = new Set();
  for (const row of conversationRows) {
    const message = typeof row.chat_message === "string" ? JSON.parse(row.chat_message) : row.chat_message;
    if (message.role !== "tool") continue;
    const toolCallId = message.tool_call_id ?? message.toolCallId;
    if (typeof toolCallId === "string" && toolCallId) completedIds.add(toolCallId);
  }
  return toolCalls.filter((call) => typeof call?.id === "string" && completedIds.has(call.id));
}

function providerToolCallKey(call, index) {
  return typeof call?.id === "string" && call.id
    ? call.id
    : `${String(call?.name || "unknown")}:${index}`;
}

function unseenProviderToolProgress(toolCalls, seenToolCalls) {
  const progress = [];
  for (const [index, call] of (toolCalls || []).entries()) {
    if (!call?.name) continue;
    const key = providerToolCallKey(call, index);
    if (seenToolCalls.has(key)) continue;
    seenToolCalls.add(key);
    progress.push({ kind: "tool", index: index + 1, name: call.name });
  }
  return progress;
}

function observeDevinProviderProgress(session, progressState) {
  // Compaction is live provider work. Let Devin finish its own summarization instead of killing the
  // process at the compaction-request node and trapping every resume in the same half-finished step.
  if (session?.compactionNodeId > progressState.lastCompactionNodeId) {
    progressState.lastCompactionNodeId = session.compactionNodeId;
    progressState.providerWorkObserved = true;
  }
  if (session?.toolCalls?.length > 0) progressState.providerWorkObserved = true;
  return unseenProviderToolProgress(session?.completedToolCalls, progressState.seenToolCalls);
}

function ollamaWireToolName(namespace, name) {
  const fullName = namespace
    ? (namespace.endsWith("_") || name.startsWith("_") ? `${namespace}${name}` : `${namespace}__${name}`)
    : name;
  if (fullName.length <= 64) return fullName;
  const suffix = `__${createHash("sha256").update(fullName).digest("hex").slice(0, 12)}`;
  return `${fullName.slice(0, 64 - suffix.length)}${suffix}`;
}

function ollamaFunctionDefinition(tool, namespace, label, kind) {
  const originalName = requireString(tool.name, `${label}.name`);
  const providerName = ollamaWireToolName(namespace, originalName);
  const parameters = kind === "custom"
    ? {
      type: "object",
      properties: { input: { type: "string", description: "The complete free-form input for this tool." } },
      required: ["input"],
      additionalProperties: false,
    }
    : assertObject(tool.parameters ?? tool.input_schema, `${label}.parameters`);
  return {
    definition: {
      type: "function",
      name: providerName,
      description: typeof tool.description === "string" ? tool.description : "",
      parameters,
      ...(tool.strict === undefined ? {} : { strict: tool.strict }),
    },
    entry: { namespace, originalName, providerName, kind },
  };
}

function addOllamaTool(normalized, responseTools, tool, namespace, label) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
    throw new BridgeError(`${label} must be an object`);
  }
  if (!["function", "custom"].includes(tool.type)) {
    throw new BridgeError(`${label} has unsupported Ollama tool type ${json(tool.type)}`);
  }
  const converted = ollamaFunctionDefinition(
    tool,
    namespace,
    label,
    tool.type === "custom" ? "custom" : "function",
  );
  const previous = responseTools.get(converted.entry.providerName);
  if (previous) {
    throw new BridgeError(
      `${label} collides with ${json(`${previous.namespace ?? "<top-level>"}.${previous.originalName}`)} ` +
      `on Ollama wire name ${json(converted.entry.providerName)}`,
    );
  }
  normalized.push(converted.definition);
  responseTools.set(converted.entry.providerName, converted.entry);
}

function normalizeOllamaTools(value) {
  if (value === undefined) {
    return { tools: [], responseTools: new Map(), forwardedBytes: 0, hostedWebSearchReplaced: false };
  }
  if (!Array.isArray(value)) throw new BridgeError("tools must be an array");
  const tools = [];
  const responseTools = new Map();
  let hostedWebSearchReplaced = false;
  for (let index = 0; index < value.length; index += 1) {
    const tool = assertObject(value[index], `tools[${index}]`);
    if (tool.type === "web_search") {
      hostedWebSearchReplaced = true;
      continue;
    }
    if (tool.type === "tool_search") {
      const converted = ollamaFunctionDefinition(
        {
          name: "tool_search",
          description: tool.description,
          parameters: tool.parameters,
          strict: false,
        },
        null,
        `tools[${index}]`,
        "tool_search",
      );
      if (responseTools.has(converted.entry.providerName)) {
        throw new BridgeError(`tools[${index}] collides on Ollama wire name ${json(converted.entry.providerName)}`);
      }
      tools.push(converted.definition);
      responseTools.set(converted.entry.providerName, converted.entry);
      continue;
    }
    if (tool.type !== "namespace") {
      addOllamaTool(tools, responseTools, tool, null, `tools[${index}]`);
      continue;
    }
    const namespace = requireString(tool.name, `tools[${index}].name`);
    if (!Array.isArray(tool.tools)) throw new BridgeError(`tools[${index}].tools must be an array`);
    for (let nestedIndex = 0; nestedIndex < tool.tools.length; nestedIndex += 1) {
      addOllamaTool(
        tools,
        responseTools,
        tool.tools[nestedIndex],
        namespace,
        `tools[${index}].tools[${nestedIndex}]`,
      );
    }
  }
  if (
    hostedWebSearchReplaced
    && ![...responseTools.values()].some((entry) => entry.kind === "tool_search")
  ) {
    throw new BridgeError("Ollama cannot replace hosted web_search because Codex deferred tool_search is absent");
  }
  return {
    tools,
    responseTools,
    forwardedBytes: Buffer.byteLength(json(tools)),
    hostedWebSearchReplaced,
  };
}

function normalizeOllamaToolChoice(value, responseTools) {
  if (value === undefined || value === null || typeof value === "string") return value;
  const choice = structuredClone(assertObject(value, "tool_choice"));
  if (choice.type === "custom") choice.type = "function";
  if (choice.type !== "function") return choice;
  const target = choice.function === undefined ? choice : assertObject(choice.function, "tool_choice.function");
  const namespace = target.namespace ?? choice.namespace;
  if (namespace === undefined) return choice;
  const originalName = requireString(target.name, "tool_choice.function.name");
  const providerName = ollamaWireToolName(requireString(namespace, "tool_choice.namespace"), originalName);
  if (!responseTools.has(providerName)) {
    throw new BridgeError(`tool_choice references unknown namespaced tool ${json(`${namespace}.${originalName}`)}`);
  }
  target.name = providerName;
  delete target.namespace;
  if (target !== choice) delete choice.namespace;
  return choice;
}

function ollamaRequest(requestBody, context) {
  const normalized = normalizeOllamaTools(requestBody.tools);
  const toolCompatibility = normalized.hostedWebSearchReplaced
    ? "\n\n[Ollama tool compatibility]\nThe provider-hosted web_search tool is represented by Codex deferred tool_search. For web access, call tool_search with a focused query for the required web capability, then call only the discovered tool."
    : "";
  const body = {
    model: route.ollamaModel,
    stream: true,
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `${context.prompt}${toolCompatibility}` }],
    }],
    reasoning: { effort: route.ollamaEffort },
  };
  if (typeof requestBody.instructions === "string" && requestBody.instructions) {
    body.instructions = requestBody.instructions;
  }
  if (normalized.tools.length > 0) body.tools = normalized.tools;
  const toolChoice = normalizeOllamaToolChoice(requestBody.tool_choice, normalized.responseTools);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  if (typeof requestBody.parallel_tool_calls === "boolean") {
    body.parallel_tool_calls = requestBody.parallel_tool_calls;
  }
  if (Number.isInteger(requestBody.max_output_tokens) && requestBody.max_output_tokens > 0) {
    body.max_output_tokens = requestBody.max_output_tokens;
  }
  return {
    body,
    responseTools: normalized.responseTools,
    forwardedBytes: normalized.forwardedBytes,
    hostedWebSearchReplaced: normalized.hostedWebSearchReplaced,
  };
}

function restoreOllamaFunctionItem(item, responseTools) {
  if (!item || item.type !== "function_call") return item;
  const entry = responseTools.get(item.name);
  if (!entry) return item;
  const restored = { ...item, name: entry.originalName };
  if (entry.namespace) restored.namespace = entry.namespace;
  else delete restored.namespace;
  if (entry.kind === "tool_search") {
    let argumentsObject;
    try {
      argumentsObject = typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments;
    } catch (error) {
      throw new BridgeError(`Ollama returned invalid tool_search arguments: ${error.message}`, 502);
    }
    if (!argumentsObject || typeof argumentsObject !== "object" || Array.isArray(argumentsObject)) {
      throw new BridgeError("Ollama returned tool_search without object arguments", 502);
    }
    restored.type = "tool_search_call";
    restored.execution = "client";
    restored.arguments = argumentsObject;
    delete restored.name;
    return restored;
  }
  if (entry.kind !== "custom") return restored;
  let argumentsObject;
  try {
    argumentsObject = typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments;
  } catch (error) {
    throw new BridgeError(`Ollama returned invalid JSON for custom tool ${json(entry.originalName)}: ${error.message}`, 502);
  }
  if (!argumentsObject || typeof argumentsObject !== "object" || Array.isArray(argumentsObject) || typeof argumentsObject.input !== "string") {
    throw new BridgeError(`Ollama returned custom tool ${json(entry.originalName)} without a string input`, 502);
  }
  restored.type = "custom_tool_call";
  restored.input = argumentsObject.input;
  delete restored.arguments;
  return restored;
}

function validateOllamaCompletion(completion, responseTools) {
  assertObject(completion, "Ollama completed response");
  if (completion.status !== "completed") {
    throw new BridgeError(`Ollama returned response status ${json(completion.status)}`, 502);
  }
  if (!route.ollamaResponseModels.includes(completion.model)) {
    throw new BridgeError(`Ollama initialized unexpected model ${json(completion.model)}`, 502);
  }
  if (completion.reasoning?.effort !== undefined && completion.reasoning.effort !== route.ollamaEffort) {
    throw new BridgeError(`Ollama returned reasoning effort ${json(completion.reasoning.effort)}`, 502);
  }
  if (!Array.isArray(completion.output) || completion.output.length === 0) {
    throw new BridgeError("Ollama completed without output items", 502);
  }
  return { ...completion, output: completion.output.map((item) => restoreOllamaFunctionItem(item, responseTools)) };
}

function terminalAssistantFromRows(conversationRows) {
  let lastToolNodeId = -1;
  let terminalNodeId = -1;
  let terminalText = null;
  let awaitingCompactionSummary = false;
  for (const row of conversationRows) {
    const message = typeof row.chat_message === "string" ? JSON.parse(row.chat_message) : row.chat_message;
    if (message.role === "user") {
      const content = typeof message.content === "string" ? message.content.trimStart() : "";
      awaitingCompactionSummary = content.startsWith("Conversation to summarize:")
        || content.startsWith("Now summarize the conversation above");
      continue;
    }
    if (message.role === "tool") {
      lastToolNodeId = Math.max(lastToolNodeId, Number(row.node_id));
      continue;
    }
    const content = typeof message.content === "string" ? message.content.trim() : "";
    const assistantToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (awaitingCompactionSummary && content && assistantToolCalls.length === 0) {
      awaitingCompactionSummary = false;
      continue;
    }
    awaitingCompactionSummary = false;
    if (content && assistantToolCalls.length === 0 && Number(row.node_id) > lastToolNodeId) {
      terminalNodeId = Number(row.node_id);
      terminalText = content;
    }
  }
  if (terminalNodeId < lastToolNodeId) terminalText = null;
  return { terminalText, terminalNodeId, lastToolNodeId };
}

function inspectSession(requestId) {
  const db = new DatabaseSync(DEVIN_DB, { readOnly: true });
  try {
    const session = db.prepare(`
      SELECT s.id, s.model, s.metadata, s.last_activity_at
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
    const compaction = db.prepare(`
      SELECT COALESCE(MAX(node_id), 0) AS node_id
      FROM message_nodes
      WHERE session_id = ?
        AND json_extract(chat_message, '$.role') = 'user'
        AND (
          ltrim(CAST(json_extract(chat_message, '$.content') AS TEXT)) LIKE 'Conversation to summarize:%'
          OR ltrim(CAST(json_extract(chat_message, '$.content') AS TEXT)) LIKE 'Now summarize the conversation above%'
        )
    `).get(session.id);
    const conversationRows = db.prepare(`
      SELECT node_id, chat_message
      FROM message_nodes
      WHERE session_id = ?
        AND json_extract(chat_message, '$.role') IN ('assistant', 'tool', 'user')
      ORDER BY node_id
    `).all(session.id);
    const terminal = terminalAssistantFromRows(conversationRows);
    const toolCalls = uniqueToolCalls(toolRows);
    return {
      id: session.id,
      model: session.model,
      metadata: JSON.parse(session.metadata || "{}"),
      metrics,
      toolCalls,
      completedToolCalls: completedToolCalls(toolCalls, conversationRows),
      lastActivityAt: Number(session.last_activity_at || 0) * 1000,
      compactionNodeId: Number(compaction?.node_id || 0),
      ...terminal,
    };
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

async function waitForTerminalSession(requestId, existingSession = null) {
  let session = existingSession;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    session = inspectSession(requestId) || session;
    if (session?.terminalText) return session;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return session;
}

function removeSession(sessionId) {
  if (!sessionId) return;
  const result = spawnSync(DEVIN_EXE, ["--config", ISOLATED_CONFIG, "rm", "--force", sessionId], {
    env: sanitizedEnvironment(), windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw new BridgeError(`Failed to remove ephemeral Devin session ${sessionId}`, 502);
}

function runCli(
  context,
  selectedModel,
  onSpawn,
  onProgress,
  timeoutMs = REQUEST_TIMEOUT_MS,
  {
    resumeSessionId = null,
    prompt = context.prompt,
    compactionBaseline = 0,
    toolCallBaseline = [],
  } = {},
) {
  const promptPath = join(REQUEST_DIRECTORY, `${context.requestId}-${randomUUID()}.txt`);
  writeFileSync(promptPath, prompt, { encoding: "utf8", flag: "wx" });
  const args = [
    "--config", ISOLATED_CONFIG, "--model", selectedModel.model_uid,
    "--permission-mode", context.executionPolicy.permissionMode,
    "--respect-workspace-trust", "false",
    ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
    "-p", "--prompt-file", promptPath,
  ];
  const child = spawn(DEVIN_EXE, args, {
    cwd: context.workingDirectory,
    env: providerEnvironment(context.executionPolicy),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  onSpawn(child);
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const routeOwnershipDeadline = Date.now() + NATIVE_PROVIDER_INACTIVITY_MS;
    const providerProgress = {
      lastCompactionNodeId: Number(compactionBaseline || 0),
      seenToolCalls: new Set(
        toolCallBaseline
          .map((call, index) => call?.name ? providerToolCallKey(call, index) : null)
          .filter(Boolean),
      ),
      providerWorkObserved: toolCallBaseline.length > 0,
    };
    const reportProgress = () => {
      let session;
      try {
        session = inspectSession(context.requestId);
      } catch {
        return;
      }
      for (const progress of observeDevinProviderProgress(session, providerProgress)) {
        onProgress?.(progress);
      }
      if (providerProgress.providerWorkObserved) return;
      if (Date.now() < routeOwnershipDeadline) return;
      child.kill();
      finish(undefined, {
        code: 1,
        stdout: stdout.trim(),
        stderr: `Devin did not begin provider tool work within ${NATIVE_PROVIDER_INACTIVITY_MS}ms`,
      });
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
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-OUTPUT_LIMIT);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-OUTPUT_LIMIT);
    });
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

function isInterruptedStreamFailure(cliResult) {
  return cliFailed(cliResult) && INTERRUPTED_STREAM.test(`${cliResult.stdout}\n${cliResult.stderr}`);
}

function isProviderCompactionFailure(cliResult) {
  return cliFailed(cliResult) && PROVIDER_COMPACTION.test(`${cliResult.stdout}\n${cliResult.stderr}`);
}

function isPermissionRejection(cliResult) {
  return cliFailed(cliResult) && PERMISSION_REJECTION.test(`${cliResult.stdout}\n${cliResult.stderr}`);
}

function devinStreamContinuationPrompt(context) {
  return `[Native Devin stream recovery]\nContinue the same retained conversation and active task after the interrupted provider stream. Task hash: ${context.taskDiagnostics.taskHash}. Do not restart the investigation or repeat completed tool calls or file edits. Return the next required tool call or the concise final result.`;
}

function devinIncompleteTurnPrompt(context) {
  return `[Native Devin terminal-message recovery]\nThe retained provider conversation ended after native tool execution without a terminal assistant message. Continue the same active task and return its actual completion report or concrete blocker now. Task hash: ${context.taskDiagnostics.taskHash}. Do not restart the investigation or repeat completed tool calls or file edits.`;
}

function devinCompactionCheckpointPrompt(context) {
  return `[Native Devin compaction checkpoint]\nYour provider context compacted during the bounded delegated task. Do not call tools, edit files, build, test, control the editor, or invoke RzMCP. Re-anchor on the complete active task below, then immediately return a concise checkpoint containing only: work actually completed, mutations actually made and their paths, the current concrete blocker or uncertainty, and the exact next step the parent should assign. Do not continue implementation in this turn.\n\n${activeTaskPromptSection(context.taskState)}`;
}

function devinPermissionCheckpointPrompt(context) {
  return `[Native Devin permission checkpoint]\nA provider tool call was rejected by the enforced bounded-task permissions. Do not retry it, request broader permissions, or call another tool. Re-anchor on the complete active task below and immediately report the rejected capability as a concrete blocker, plus work already completed and the smallest safe next step for the parent.\n\n${activeTaskPromptSection(context.taskState)}`;
}

function sanitizedProviderFailure(error) {
  return String(error?.message || error)
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(sk|or)-[a-z0-9_-]{12,}\b/gi, "[REDACTED]")
    .slice(0, 2_000);
}

function providerToolCalls(session) {
  return Array.isArray(session?.toolCalls)
    ? session.toolCalls.filter((call) => call?.name)
    : [];
}

function providerCompletedToolCalls(session) {
  return Array.isArray(session?.completedToolCalls)
    ? session.completedToolCalls.filter((call) => call?.name)
    : providerToolCalls(session);
}

function parsedToolArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function calledRzMcpToolName(call) {
  if (String(call?.name || "").toLowerCase() !== "mcp_call_tool") return null;
  const outer = parsedToolArguments(call.arguments);
  if (outer?.tool_name !== "call_rzmcp_tool") return null;
  const inner = parsedToolArguments(outer.arguments);
  return typeof inner?.name === "string" && inner.name ? inner.name : null;
}

function mutationToolCalls(toolCalls, executionPolicy) {
  return toolCalls.filter((call) => {
    const name = String(call.name || "").toLowerCase();
    if ([
      "apply_patch",
      "edit",
      "edit_file",
      "write_file",
      "create_file",
      "delete_file",
      "move_file",
    ].includes(name)) return true;
    if (name !== "mcp_call_tool") return false;
    if (executionPolicy?.rzMcpMode === "read-only") return false;
    const rzMcpToolName = calledRzMcpToolName(call);
    return rzMcpToolName === null || !READ_ONLY_RZMCP_TOOL_NAME.test(rzMcpToolName);
  });
}

function providerMutationToolCalls(session, executionPolicy) {
  return mutationToolCalls(providerToolCalls(session), executionPolicy);
}

function providerCompletedMutationToolCalls(session, executionPolicy) {
  return mutationToolCalls(providerCompletedToolCalls(session), executionPolicy);
}

function preserveProviderCommit(error, session, executionPolicy) {
  const toolCalls = providerToolCalls(session);
  const mutationToolCalls = providerMutationToolCalls(session, executionPolicy);
  if (toolCalls.length > 0) {
    error.routeCommitted = true;
    error.toolCalls = toolCalls.length;
    error.toolNames = [...new Set(toolCalls.map((call) => call.name))];
    error.mutationToolCalls = mutationToolCalls.length;
  }
  return error;
}

function preserveProviderSession(error, session, executionPolicy) {
  preserveProviderCommit(error, session, executionPolicy);
  if (providerToolCalls(session).length > 0) {
    Object.defineProperty(error, "retainedProviderSession", {
      value: session,
      configurable: true,
    });
  }
  return error;
}

function providerCheckpointReason({ resourceFailure, streamFailure, compactionFailure, permissionFailure, incompleteTurn }) {
  if (resourceFailure) return "the provider reported a transient resource failure";
  if (streamFailure) return "the provider stream ended before a terminal response";
  if (compactionFailure) return "the provider compacted its context before a terminal response";
  if (permissionFailure) return "an enforced provider permission rejected a required operation";
  if (incompleteTurn) return "the provider process ended without a terminal assistant response";
  return "the provider stopped before a terminal response";
}

function completedProviderCheckpoint(context, session, failureState) {
  const toolCalls = providerCompletedToolCalls(session);
  const toolNames = [...new Set(toolCalls.map((call) => String(call.name)))];
  const mutations = providerCompletedMutationToolCalls(session, context.executionPolicy).length;
  const text = [
    "[Authoritative native-provider checkpoint]",
    `Task hash: ${context.taskDiagnostics.taskHash}`,
    `Provider tool calls completed: ${toolCalls.length}`,
    `Provider mutation calls observed: ${mutations}`,
    `Tool names: ${toolNames.join(", ") || "none"}`,
    `Last completed tool: ${toolNames.at(-1) || "none"}`,
    `Concrete blocker: ${providerCheckpointReason(failureState)}.`,
    failureState.continuationAttempted
      ? "One bounded same-session continuation was attempted without replaying the task, and no later provider was started. The delegated task may be incomplete; the parent should inspect the preserved work and decide whether to resume or reassign it."
      : "No later provider was started after committed work. The delegated task may be incomplete; the parent should inspect the preserved work and decide whether to resume or reassign it.",
  ].join("\n");
  runtime.providerCheckpoints += 1;
  return {
    cliResult: { code: 0, stdout: text, stderr: "" },
    session: { ...session, terminalText: text },
  };
}

async function runCliWithProviderRecovery(
  context,
  selectedModel,
  onSpawn,
  onProgress,
  signal,
  deadline,
  options = {},
) {
  const run = options.runCli || runCli;
  const findSession = options.waitForSession || waitForSession;
  const findTerminalSession = options.waitForTerminalSession || waitForTerminalSession;
  const remove = options.removeSession || removeSession;
  const now = options.now || Date.now;
  const delay = options.delay || delayWithAbort;
  let attempt = 0;
  let recoveryDeadline = null;
  let resumeSession = options.initialResumeSession || null;
  let recoveryKind = resumeSession ? "parent_control" : null;
  let providerContinuationUsed = false;
  while (true) {
    throwIfAborted(signal);
    const activeDeadline = recoveryDeadline || deadline;
    const remainingMs = activeDeadline - now();
    if (remainingMs <= 0) throw new BridgeError("Devin provider recovery deadline exceeded", 504);
    const iterationCompactionBaseline = Number(resumeSession?.compactionNodeId || 0);
    let cliResult;
    let sessionFromRunError = null;
    let runError = null;
    try {
      cliResult = await run(
        context,
        selectedModel,
        onSpawn,
        onProgress,
        remainingMs,
        resumeSession
          ? {
              resumeSessionId: resumeSession.id,
              prompt: recoveryKind === "parent_control"
                ? context.prompt
                : recoveryKind === "compaction"
                ? devinCompactionCheckpointPrompt(context)
                : recoveryKind === "permission"
                  ? devinPermissionCheckpointPrompt(context)
                  : recoveryKind === "incomplete"
                    ? devinIncompleteTurnPrompt(context)
                    : devinStreamContinuationPrompt(context),
              compactionBaseline: iterationCompactionBaseline,
              toolCallBaseline: providerCompletedToolCalls(resumeSession),
            }
          : undefined,
      );
    } catch (error) {
      const session = await findSession(context.requestId) || resumeSession;
      if (!signal?.aborted && error?.status !== 499 && session) {
        runError = error;
        sessionFromRunError = session;
        cliResult = {
          code: 1,
          stdout: "",
          stderr: sanitizedProviderFailure(error),
        };
      } else {
        const preserved = preserveProviderSession(error, session, context.executionPolicy);
        if (session && !preserved.retainedProviderSession) remove(session.id);
        throw preserved;
      }
    }
    let session = sessionFromRunError || await findSession(context.requestId) || resumeSession;
    if (runError && session?.terminalText) {
      cliResult = { code: 0, stdout: session.terminalText, stderr: "" };
      runError = null;
    }
    if (cliResult.code === 0 && cliResult.stdout && session && !session.terminalText) {
      session = await findTerminalSession(context.requestId, session) || session;
    }
    const resourceFailure = isRetryableResourceFailure(cliResult);
    const streamFailure = Boolean(runError) || isInterruptedStreamFailure(cliResult);
    const compactionAdvanced = Number(session?.compactionNodeId || 0) > iterationCompactionBaseline;
    const compactionFailure = isProviderCompactionFailure(cliResult)
      || (compactionAdvanced && !session?.terminalText);
    const permissionFailure = isPermissionRejection(cliResult);
    const incompleteTurn = cliResult.code === 0 && Boolean(session) && !session.terminalText;
    if (!resourceFailure && !streamFailure && !compactionFailure && !permissionFailure && !incompleteTurn) {
      return { cliResult, session };
    }
    if ((streamFailure || compactionFailure || permissionFailure || incompleteTurn) && !session) {
      const error = new BridgeError("Devin provider turn stopped but its conversation could not be recovered", 502);
      error.routeCommitted = true;
      throw error;
    }
    const failureState = {
      resourceFailure,
      streamFailure,
      compactionFailure,
      permissionFailure,
      incompleteTurn,
    };
    if (providerContinuationUsed && session) {
      if (providerToolCalls(session).length > 0) {
        return completedProviderCheckpoint(context, session, {
          ...failureState,
          continuationAttempted: true,
        });
      }
      const error = preserveProviderCommit(
        new BridgeError("Devin provider conversation remained non-terminal after one same-session continuation", 502),
        session,
        context.executionPolicy,
      );
      if (session) remove(session.id);
      throw error;
    }
    if (recoveryDeadline === null) {
      recoveryDeadline = Math.min(deadline, now() + PROVIDER_RECOVERY_BUDGET_MS);
    }
    attempt += 1;
    const backoffMs = resourceFailure ? resourceBackoffMs(attempt) : PROVIDER_RECOVERY_BACKOFF_MS;
    if (now() + backoffMs >= recoveryDeadline) {
      if (providerToolCalls(session).length > 0) {
        return completedProviderCheckpoint(context, session, {
          ...failureState,
          continuationAttempted: providerContinuationUsed,
        });
      }
      const error = preserveProviderCommit(
        new BridgeError(
          `Devin provider recovery exceeded its ${PROVIDER_RECOVERY_BUDGET_MS / 1000}-second budget`,
          504,
        ),
        session,
        context.executionPolicy,
      );
      if (session) remove(session.id);
      throw error;
    }
    if (resourceFailure) runtime.resourceRetries += 1;
    if (streamFailure) {
      runtime.streamContinuations += 1;
      runtime.lastStreamContinuationAt = new Date(now()).toISOString();
      runtime.lastStreamContinuationSessionHash = createHash("sha256").update(session.id).digest("hex");
    }
    const hasCommittedProviderWork = providerToolCalls(session).length > 0;
    if (
      session
      && (
        streamFailure
        || compactionFailure
        || permissionFailure
        || incompleteTurn
        || (resourceFailure && hasCommittedProviderWork)
      )
    ) {
      providerContinuationUsed = true;
      runtime.providerContinuations += 1;
    }
    if (compactionFailure) runtime.compactionCheckpoints += 1;
    if (permissionFailure) runtime.permissionCheckpoints += 1;
    runtime.lastResourceModel = selectedModel.model_uid;
    runtime.lastResourceRetryAttempt = attempt;
    runtime.lastResourceBackoffMs = backoffMs;
    runtime.lastResourceRetryAt = now() + backoffMs;
    if (providerContinuationUsed) {
      onProgress?.({
        kind: "recovery",
        reason: providerCheckpointReason(failureState),
      });
    }
    runtime.activeResourceBackoffs += 1;
    try {
      await delay(backoffMs, signal);
    } finally {
      runtime.activeResourceBackoffs = Math.max(0, runtime.activeResourceBackoffs - 1);
    }
    resumeSession = session;
    recoveryKind = compactionFailure
      ? "compaction"
      : permissionFailure
        ? "permission"
        : incompleteTurn
          ? "incomplete"
          : "stream";
  }
}

function responsesResult(completion, selected, fallbackState, transport) {
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
    selected,
    quotaFallback: fallbackState.quotaFallback,
    terminalFallback: fallbackState.terminalFallback,
    fallbackReason: fallbackState.fallbackReason,
    fallbackFailure: fallbackState.fallbackFailure,
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
    toolSchemaBytesIgnored: transport.ignoredBytes,
    toolSchemaBytesForwarded: transport.forwardedBytes,
  };
}

function finalizeDevinResult(context, selected, routeResult, fallbackState, preserveSession = false) {
  const { cliResult, session } = routeResult;
  if (!session) {
    if (cliResult.code !== 0 || !cliResult.stdout) {
      throw new BridgeError(`Devin failed: ${cliResult.stderr || cliResult.stdout || `exit ${cliResult.code}`}`, 502);
    }
    throw new BridgeError("Devin completed without a traceable ephemeral session", 502);
  }
  let validated = false;
  try {
    if (cliResult.code !== 0 || !cliResult.stdout) {
      throw new BridgeError(`Devin failed: ${cliResult.stderr || cliResult.stdout || `exit ${cliResult.code}`}`, 502);
    }
    if (session.model !== selected.model.model_uid) {
      throw new BridgeError(`Devin used unexpected model ${json(session.model)}`, 502);
    }
    if (!session.terminalText) {
      throw new BridgeError("Devin completed without a terminal assistant message after its native tools", 502);
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
    const rzMcpTools = toolCalls.map(calledRzMcpToolName).filter(Boolean);
    const result = {
      text: session.terminalText, selected, providerMetadata: {},
      quotaFallback: fallbackState.quotaFallback,
      terminalFallback: fallbackState.terminalFallback,
      fallbackReason: fallbackState.fallbackReason,
      fallbackFailure: fallbackState.fallbackFailure,
      creditCost, acuCost,
      inputTokens, cachedTokens, outputTokens, peakTurnContextTokens, outputTokensPerSecond,
      toolCalls, nativeToolNames: toolCalls.map((call) => call.name), rzMcpTools,
      toolSchemaBytesIgnored: fallbackState.toolSchemaBytesIgnored,
      toolSchemaBytesForwarded: 0,
    };
    validated = true;
    return result;
  } catch (error) {
    throw preserveProviderCommit(error, session, context.executionPolicy);
  } finally {
    if (!preserveSession || !validated) removeSession(session.id);
  }
}

function fallbackState(context, failures, terminalFallback = false) {
  const fallbackReason = failures.length > 0
    ? failures.map((failure) => failure.stage).join("_then_")
    : null;
  const fallbackFailure = failures.length > 0
    ? failures.map((failure) => `${failure.stage}: ${sanitizedProviderFailure(failure.error)}`).join(" | ").slice(0, 2_000)
    : null;
  return {
    quotaFallback: failures.length > 0,
    terminalFallback,
    fallbackReason,
    fallbackFailure,
    toolSchemaBytesIgnored: context.toolSchemaBytes,
  };
}

async function runAntigravityStage(context, requestBody, failures, onProgress, signal, streamRelay) {
  runtime.providerAttempts.antigravity += 1;
  runtime.lastProviderSequence.push("antigravity");
  pinProviderTask(context, "antigravity");
  onProgress?.("Automatic route started Antigravity Claude/Gemini pool selection.\n");
  try {
    const forwardedBody = fallbackForwardBody(
      requestBody,
      MODEL_ALIAS,
      ANTIGRAVITY_REQUIRED_EFFORT,
      context.workingDirectory,
    );
    const completion = await runResponsesBridge({
      endpoint: ANTIGRAVITY_BRIDGE_ENDPOINT,
      body: forwardedBody,
      signal,
        onEvent: streamRelay.accept,
    });
    validateOAuthFallbackCompletion(completion, {
      provider: route.antigravityProvider,
      models: route.antigravityModels,
      authSource: ANTIGRAVITY_REQUIRED_AUTH_SOURCE,
    });
    const providerMetadata = completion.metadata || {};
    const selected = {
      ...antigravitySelection("auto_primary_antigravity"),
      model: {
        model_uid: providerMetadata.actual_model,
        label: providerMetadata.actual_model_label || providerMetadata.actual_model,
      },
    };
    return {
      ...responsesResult(
        completion,
        selected,
        fallbackState(context, failures),
        { ignoredBytes: context.toolSchemaBytes, forwardedBytes: 0 },
      ),
      streamRelay,
    };
  } catch (error) {
    if (streamRelay.providerWorkCommitted) error.routeCommitted = true;
    throw error;
  }
}

async function runCodeBuddyStage(context, requestBody, failures, onProgress, signal, streamRelay) {
  runtime.providerAttempts.codebuddy += 1;
  runtime.lastProviderSequence.push("codebuddy");
  pinProviderTask(context, "codebuddy");
  onProgress?.("Automatic route started one self-contained CodeBuddy native CLI execution.\n");
  try {
    const forwardedBody = fallbackForwardBody(
      requestBody,
      MODEL_ALIAS,
      CODEBUDDY_REQUIRED_EFFORT,
      context.workingDirectory,
    );
    const completion = await runResponsesBridge({
      endpoint: CODEBUDDY_BRIDGE_ENDPOINT,
      body: forwardedBody,
      signal,
        onEvent: streamRelay.accept,
    });
    validateOAuthFallbackCompletion(completion, {
      provider: "codebuddy",
      models: [route.codeBuddyModel],
      authSource: CODEBUDDY_REQUIRED_AUTH_SOURCE,
      lazyRzMcpProxyTools: context.executionPolicy.rzMcpMode === "disabled" ? 0 : 2,
    });
    const providerMetadata = completion.metadata || {};
    const selected = {
      ...codeBuddySelection("auto_codebuddy_after_prior_provider_failure"),
      model: {
        model_uid: providerMetadata.actual_model,
        label: providerMetadata.actual_model_label || providerMetadata.actual_model,
      },
      maxConcurrency: null,
    };
    return {
      ...responsesResult(
        completion,
        selected,
        fallbackState(context, failures),
        { ignoredBytes: context.toolSchemaBytes, forwardedBytes: 0 },
      ),
      streamRelay,
    };
  } catch (error) {
    if (streamRelay.providerWorkCommitted) error.routeCommitted = true;
    throw error;
  }
}

async function runOllamaStage(
  context,
  requestBody,
  failures,
  onProgress,
  signal,
  streamRelay,
  capacityOptions,
) {
  const selected = ollamaSelection(
    failures.length > 0 ? "auto_ollama_after_prior_provider_failure" : "explicit_ollama_route",
  );
  try {
    return await withRouteCapacity(selected, signal, async () => {
      runtime.providerAttempts.ollama += 1;
      runtime.lastProviderSequence.push("ollama");
      pinProviderTask(context, "ollama");
      onProgress?.("Ollama native CLI agent started one self-contained execution.\n");
      let nativeContext;
      try {
        const forwardedBody = fallbackForwardBody(
          requestBody,
          requestBody.model,
          route.ollamaEffort,
          context.workingDirectory,
        );
        nativeContext = nativeCliAgentContext(forwardedBody, {
          provider: "ollama",
          model: route.ollamaModel,
          requiredEffort: route.ollamaEffort,
        });
      } catch (error) {
        if (error instanceof NativeCliAgentError) throw new BridgeError(error.message, error.status);
        throw error;
      }
      const announcedTools = new Set();
      let announcedProviderActivity = false;
      const nativeResult = await runOpenCodeNativeAgent(nativeContext, {
        providerKind: "ollama",
        signal,
        onEvent: (event) => {
          if (
            !announcedProviderActivity
            && (
              ["step_start", "step-start"].includes(event?.type)
              || (event?.type === "reasoning" && typeof event.part?.text === "string" && event.part.text.length > 0)
            )
          ) {
            announcedProviderActivity = true;
            onProgress?.("Ollama native model started reasoning in its retained execution.\n");
          }
          if (event?.type !== "tool_use" || event.part?.state?.status !== "completed") return;
          const key = event.part.callID || event.part.id;
          if (key && announcedTools.has(key)) return;
          if (key) announcedTools.add(key);
          onProgress?.(`Ollama native tool ${announcedTools.size}: ${progressToolName(event.part.tool)}.\n`);
        },
        onRecovery: () => {
          runtime.providerContinuations += 1;
          runtime.nativeTerminalContinuations += 1;
          onProgress?.("Ollama native CLI resumed the same retained session after a missing terminal response.\n");
        },
      });
      const providerMetadata = {
        actual_provider: "ollama",
        actual_model: route.ollamaModel,
        actual_model_label: route.ollamaLabel,
        actual_reasoning_effort: route.ollamaEffort,
        auth_source: OLLAMA_AUTH_SOURCE,
        native_cli_single_execution: nativeResult.executionCount === 1,
        native_cli_execution_count: nativeResult.executionCount,
        native_cli_same_session_continuations: nativeResult.sameSessionContinuations,
        native_tool_names: nativeResult.toolNames,
        provider_mutation_count: nativeResult.mutationCount,
        peak_turn_context_tokens: nativeResult.peakTurnInputTokens,
        codex_tool_schema_bytes_forwarded: 0,
        codex_tool_schema_bytes_ignored: context.toolSchemaBytes,
        lazy_rzmcp_proxy_tools: nativeContext.executionPolicy.rzMcpMode === "disabled" ? 0 : 2,
      };
      return {
        text: nativeResult.finalText,
        selected,
        providerMetadata,
        ...fallbackState(context, failures),
        creditCost: 0,
        acuCost: 0,
        inputTokens: nativeResult.inputTokens,
        cachedTokens: 0,
        outputTokens: nativeResult.outputTokens,
        peakTurnContextTokens: nativeResult.peakTurnInputTokens,
        outputTokensPerSecond: null,
        toolCalls: [],
        nativeToolNames: nativeResult.toolNames,
        rzMcpTools: nativeResult.toolNames.filter((name) => name === "call_rzmcp_tool"),
        toolSchemaBytesIgnored: context.toolSchemaBytes,
        toolSchemaBytesForwarded: 0,
        streamRelay,
      };
    }, capacityOptions);
  } catch (error) {
    if (
      streamRelay.providerWorkCommitted
      || (Array.isArray(error?.nativeToolNames) && error.nativeToolNames.length > 0)
    ) error.routeCommitted = true;
    throw error;
  }
}

async function runDevinStage(
  context,
  selected,
  failures,
  onSpawn,
  onProgress,
  signal,
  terminalFallback,
  capacityOptions,
) {
  const freeModel = selected.key === "terminal";
  const providerKey = freeModel ? "devinFree" : "devin";
  const stage = terminalFallback ? "devin-free" : "devin";
  pinProviderTask(context, stage);
  const retainedSessionKey = retainedDevinSessionKey(context, selected.model);
  const retainedSession = retainedSessionKey
    ? retainedDevinSessions.get(retainedSessionKey) || null
    : null;
  if (retainedSessionKey) retainedDevinSessions.delete(retainedSessionKey);
  runtime.providerAttempts[providerKey] += 1;
  runtime.lastProviderSequence.push(terminalFallback ? "devin-free" : "devin");
  let routeResult;
  try {
    routeResult = await withRouteCapacity(selected, signal, () => {
      onProgress?.(`Devin native worker started with ${selected.model.label}.\n`);
      return runCliWithProviderRecovery(
        context,
        selected.model,
        onSpawn,
        (progress) => {
          if (progress?.kind === "recovery") {
            onProgress?.(`Devin native same-session recovery: ${progress.reason}.\n`);
            return;
          }
          onProgress?.(`Devin native tool ${progress.index}: ${progressToolName(progress.name)}.\n`);
        },
        signal,
        Date.now() + REQUEST_TIMEOUT_MS,
        retainedSession ? { initialResumeSession: retainedSession } : undefined,
      );
    }, capacityOptions);
  } catch (error) {
    if (retainedSessionKey && error?.retainedProviderSession) {
      retainedDevinSessions.set(retainedSessionKey, error.retainedProviderSession);
      pinProviderTask(context, stage);
    }
    error.failedStage ||= terminalFallback ? "devin-free" : "devin";
    throw error;
  }
  if (!freeModel && isQuotaFailure(routeResult.cliResult)) {
    if (providerToolCalls(routeResult.session).length > 0) {
      const error = preserveProviderCommit(
        new BridgeError("Devin quota ended after executing native tools; the turn was not replayed", 502),
        routeResult.session,
        context.executionPolicy,
      );
      removeSession(routeResult.session.id);
      throw error;
    }
    if (routeResult.session) removeSession(routeResult.session.id);
    if (calendarQuotaState.record(routeResult.cliResult)) runtime.calendarQuotaActivations += 1;
    runtime.lastQuotaPinCreated = quotaTaskPins.pin(
      context.threadId,
      ownershipTaskHash(context),
    );
    const error = new BridgeError("Devin paid quota is unavailable before native work", 503);
    error.quotaFailure = true;
    throw error;
  }
  if (!freeModel && !cliFailed(routeResult.cliResult) && calendarQuotaState.clear()) {
    runtime.calendarQuotaClears += 1;
  }
  const preserveSession = context.taskState.checkpointRequested && Boolean(retainedSessionKey);
  const result = finalizeDevinResult(
    context,
    selected,
    routeResult,
    fallbackState(context, failures, terminalFallback),
    preserveSession,
  );
  if (preserveSession) retainedDevinSessions.set(retainedSessionKey, routeResult.session);
  return result;
}

async function executeAuto(context, requestBody, onSpawn, onProgress, signal, createStreamRelay) {
  runtime.lastProviderSequence = [];
  const pinnedStage = providerTaskPins.get(
    context.threadId,
    ownershipTaskHash(context),
  );
  runtime.lastPinnedProviderStage = pinnedStage;
  const stages = [
    {
      name: "antigravity",
      run: ({ failures }) => runAntigravityStage(
        context,
        requestBody,
        failures,
        onProgress,
        signal,
        createStreamRelay(),
      ),
    },
    {
      name: "devin",
      run: async ({ failures }) => {
        const selected = chooseDevinStage(context);
        if (selected.key !== "primary") {
          const error = new BridgeError(`Devin paid route skipped: ${selected.reason}`, 503);
          error.routeSkipped = true;
          throw error;
        }
        return runDevinStage(context, selected, failures, onSpawn, onProgress, signal, false);
      },
    },
    {
      name: "ollama",
      run: ({ failures }) => runOllamaStage(
        context,
        requestBody,
        failures,
        onProgress,
        signal,
        createStreamRelay({ forwardReasoningSummaries: true, providerLabel: "Ollama" }),
        { skipIfBusy: true },
      ),
    },
    {
      name: "devin-free",
      run: ({ failures }) => {
        runtime.terminalFallbacks += 1;
        const selected = terminalSelection("auto_terminal_devin_free");
        return runDevinStage(
          context,
          selected,
          failures,
          onSpawn,
          onProgress,
          signal,
          true,
          { skipIfBusy: true },
        );
      },
    },
    {
      name: "codebuddy",
      run: ({ failures }) => runCodeBuddyStage(
        context,
        requestBody,
        failures,
        onProgress,
        signal,
        createStreamRelay(),
      ),
    },
  ];
  let chain;
  try {
    chain = await runOrderedProviderChain({
      signal,
      stages,
      pinnedStage,
      onStageFailure: (stage, error) => {
        if (error?.providerTaskPinPreserved === true) {
          pinProviderTask(context, stage);
        } else if (
          error?.routeCommitted !== true
          && providerTaskPins.release(context.threadId, ownershipTaskHash(context))
        ) {
          runtime.providerTaskPinsReleasedOnFailure += 1;
        }
        runtime.providerFailures[stage] += 1;
        runtime.fallbackFailed += 1;
        runtime.lastFallbackError = `${stage}: ${sanitizedProviderFailure(error)}`;
        runtime.recentProviderFailures.push({
          at: Date.now(),
          taskHash: context.taskDiagnostics.taskHash,
          stage,
          error: sanitizedProviderFailure(error),
        });
        runtime.recentProviderFailures = runtime.recentProviderFailures.slice(-20);
        if (error?.providerTaskPinPreserved === true) {
          onProgress?.(`${stage} continuation failed; preserving the active task on that provider without rerouting.\n`);
        } else if (!error.routeSkipped && error?.routeCommitted !== true) {
          onProgress?.(`${stage} was unavailable before provider tool work; trying the next configured provider.\n`);
        } else if (error?.routeCommitted === true) {
          onProgress?.(`${stage} stopped after provider tool work; preserving that work without replay or rerouting.\n`);
        }
      },
    });
  } catch (error) {
    const abortedStage = preserveProviderPinForAbortedTurn(context, error, signal);
    if (abortedStage !== null) {
      throw error;
    }
    if (pinnedStage !== null) {
      pinProviderTask(context, pinnedStage);
      error.providerTaskPinPreserved = true;
      error.routeCommitted = true;
    } else if (
      error?.routeCommitted !== true
      && providerTaskPins.release(context.threadId, ownershipTaskHash(context))
    ) {
      runtime.providerTaskPinsReleasedOnFailure += 1;
    }
    if (error?.routeCommitted !== true && !signal?.aborted) {
      error.nativeFallbackRoute = route.nativeFallbackRoute;
    }
    throw error;
  }
  if (chain.stage !== "antigravity") runtime.fallbackCompleted += 1;
  runtime.lastFallbackError = chain.failures.length > 0
    ? chain.failures.map((failure) => `${failure.stage}: ${sanitizedProviderFailure(failure.error)}`).join(" | ").slice(0, 2_000)
    : null;
  return { ...chain.value, autoStage: chain.stage };
}

async function execute(context, requestBody, initialRoute, onSpawn, onProgress, signal, createStreamRelay) {
  runtime.lastProviderSequence = [];
  try {
    if (initialRoute.key === "terminal") {
      return await runDevinStage(context, initialRoute, [], onSpawn, onProgress, signal, false);
    }
    if (initialRoute.key === "ollama") {
      try {
        return await runOllamaStage(
          context,
          requestBody,
          [],
          onProgress,
          signal,
          createStreamRelay({ forwardReasoningSummaries: true, providerLabel: "Ollama" }),
        );
      } catch (error) {
        error.failedStage ||= "ollama";
        throw error;
      }
    }
    runtime.fallbackAttempts += 1;
    return await executeAuto(context, requestBody, onSpawn, onProgress, signal, createStreamRelay);
  } catch (error) {
    if (error?.routeCommitted === true && !signal?.aborted) {
      return committedProviderResult(context, error);
    }
    throw error;
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
  if (typeof error?.nativeFallbackRoute === "string") return "native_subagent_fallback";
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
  const completed = [];
  const emit = (delta) => {
    if (typeof delta !== "string" || !delta) return;
    const itemId = `progress_${randomUUID()}`;
    const outputIndex = completed.length;
    writeSse(response, "response.output_item.added", {
      output_index: outputIndex,
      item: { type: "reasoning", id: itemId, status: "in_progress", summary: [] },
    });
    writeSse(response, "response.reasoning_summary_text.delta", {
      item_id: itemId,
      output_index: outputIndex,
      summary_index: 0,
      delta,
    });
    const item = {
      type: "reasoning",
      id: itemId,
      status: "completed",
      summary: [{ type: "summary_text", text: delta }],
    };
    writeSse(response, "response.reasoning_summary_text.done", {
      item_id: itemId,
      output_index: outputIndex,
      summary_index: 0,
      text: delta,
    });
    writeSse(response, "response.output_item.done", { output_index: outputIndex, item });
    completed.push(item);
  };
  return {
    emit,
    finish: () => [...completed],
    get added() { return completed.length > 0; },
  };
}

function createProviderStreamRelay(
  response,
  responseId,
  modelAlias = MODEL_ALIAS,
  progress = null,
  { forwardReasoningSummaries = false, providerLabel = "Provider" } = {},
) {
  const pendingMessages = new Map();
  const streamedMessageIds = new Set();
  const providerProgressIds = new Set();
  const forwardedReasoningIds = new Set();
  const announcedToolIds = new Set();
  let providerOutputObserved = false;
  let providerWorkCommitted = false;
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
      forwardReasoningSummaries
      && event.type === "response.output_item.added"
      && payload.item?.type === "reasoning"
      && typeof payload.item.id === "string"
    ) {
      forwardedReasoningIds.add(payload.item.id);
      return;
    }
    if (
      event.type === "response.reasoning_summary_text.delta"
      && providerProgressIds.has(payload.item_id)
      && typeof payload.delta === "string"
      && payload.delta
    ) {
      if (/\bnative tool\b/i.test(payload.delta)) providerWorkCommitted = true;
      progress?.emit(payload.delta);
      return;
    }
    if (
      event.type === "response.reasoning_summary_text.delta"
      && forwardedReasoningIds.has(payload.item_id)
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
    if (
      ["response.output_item.added", "response.output_item.done"].includes(event.type)
      && ["function_call", "custom_tool_call", "tool_search_call"].includes(payload.item?.type)
    ) {
      providerOutputObserved = true;
      providerWorkCommitted = true;
      const toolName = payload.item?.type === "tool_search_call"
        ? "tool_search"
        : progressToolName(payload.item?.name);
      const toolId = payload.item?.id || payload.item?.call_id || `${payload.output_index}:${toolName}`;
      if (!announcedToolIds.has(toolId)) {
        announcedToolIds.add(toolId);
        progress?.emit(`${providerLabel} requested native tool ${toolName}.\n`);
      }
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
    providerOutputObserved = true;
  };
  return {
    accept,
    streamedMessageIds,
    get committed() { return false; },
    get providerWorkCommitted() { return providerWorkCommitted; },
    get providerOutputObserved() { return providerOutputObserved; },
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
  runtime.lastPermissionMode = context.executionPolicy.permissionMode;
  runtime.lastRzMcpMode = context.executionPolicy.rzMcpMode;
  const selected = initialSelection(context);
  runtime.lastConfiguredRoute = context.requestedRoute;
  runtime.lastFallbackStreamCommitted = false;
  runtime.lastFallbackProviderOutputObserved = false;
  runtime.lastFallbackStreamedMessageCount = 0;
  let child = null;
  const abortController = new AbortController();
  const abort = () => {
    abortController.abort();
    if (child && !child.killed) child.kill();
  };
  let resolveThreadTurnDone;
  const threadTurn = {
    requestId: context.requestId,
    abort,
    done: new Promise((resolve) => { resolveThreadTurnDone = resolve; }),
  };
  await registerThreadTurn(context.threadId, threadTurn);
  request.once("aborted", abort);
  response.once("close", () => { if (!response.writableEnded) abort(); });
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  const responseId = `resp_${randomUUID()}`;
  writeSse(response, "response.created", { response: { id: responseId, object: "response", model: context.modelAlias, status: "in_progress" } });
  const progress = createProgressEmitter(response);
  const createStreamRelay = (options) =>
    createProviderStreamRelay(response, responseId, context.modelAlias, progress, options);
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
      createStreamRelay,
    );
    const taskHash = ownershipTaskHash(context);
    const completedWorkCount = context.taskState.progress.toolCallsSinceTask
      + (result.toolCalls?.length || 0)
      + (result.nativeToolNames?.length || 0);
    const routeRetentionCount = context.taskState.checkpointRequested
      ? Math.max(1, completedWorkCount)
      : completedWorkCount;
    if (quotaTaskPins.releaseAfterFinalResponse(
      context.threadId,
      taskHash,
      routeRetentionCount,
    )) runtime.quotaPinsReleased += 1;
    if (
      context.requestedRoute === "auto"
      && result.autoStage
      && (routeRetentionCount > 0 || result.preserveProviderPin === true)
    ) {
      pinProviderTask(context, result.autoStage);
    } else if (providerTaskPins.releaseAfterFinalResponse(
      context.threadId,
      taskHash,
      routeRetentionCount,
    )) {
      runtime.providerTaskPinsReleased += 1;
      runtime.lastPinnedProviderStage = null;
    }
    const streamRelay = result.streamRelay || { committed: false, streamedMessageIds: new Set() };
    runtime.lastFallbackStreamCommitted = streamRelay.committed;
    runtime.lastFallbackProviderOutputObserved = streamRelay.providerOutputObserved === true;
    runtime.lastFallbackStreamedMessageCount = streamRelay.streamedMessageIds.size;
    if (streamRelay.committed) runtime.fallbackStreamCommits += 1;
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
    runtime.lastToolSchemaBytesIgnored = result.toolSchemaBytesIgnored;
    runtime.lastToolSchemaBytesForwarded = result.toolSchemaBytesForwarded;
    const progressItems = progress.finish();
    const output = emitOutputItems(
      response,
      result,
      streamRelay.streamedMessageIds,
      progressItems,
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
        codex_tool_schema_bytes_original: context.toolSchemaBytes,
        codex_tool_schema_bytes_ignored: result.toolSchemaBytesIgnored,
        codex_tool_schema_bytes_forwarded: result.toolSchemaBytesForwarded,
        active_task_id: context.taskDiagnostics.taskId, active_task_hash: context.taskDiagnostics.taskHash,
        active_task_delivery_mode: context.taskDiagnostics.taskDeliveryMode,
        complete_active_task_delivered: context.taskDiagnostics.completeTaskDelivered,
      },
    } });
    response.end();
  } catch (error) {
    runtime.failed += 1;
    progress.finish();
    const responseError = { code: providerResponseErrorCode(error), message: error.message };
    if (typeof error?.nativeFallbackRoute === "string") {
      responseError.fallback_route = error.nativeFallbackRoute;
    }
    writeSse(response, "response.failed", { response: { id: responseId, object: "response", model: context.modelAlias, status: "failed", error: responseError } });
    response.end();
  } finally {
    clearInterval(heartbeat);
    unregisterThreadTurn(context.threadId, threadTurn);
    resolveThreadTurnDone();
    runtime.activeRequests = Math.max(0, runtime.activeRequests - 1);
  }
}

function managedModelsResponse() {
  const managedContextWindow = Math.min(
    models.primary.max_context_tokens,
    models.terminal.max_context_tokens,
    ANTIGRAVITY_CONTEXT_WINDOW,
    OLLAMA_CONTEXT_WINDOW,
  );
  const modelDefinition = (slug, displayName, description, contextWindow, effort) => ({
    slug, display_name: displayName, description,
    base_instructions: "You are a bounded delegated coding sub-agent. Use local tools and return concise evidence.",
    default_reasoning_level: effort, supported_reasoning_levels: [{ effort, description: "Maximum configured effort" }],
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
      REQUIRED_EFFORT,
    ),
    modelDefinition(
      DEVIN_FREE_MODEL_ALIAS,
      "Devin free native subagent",
      `Direct ${models.terminal.label} native subagent`,
      models.terminal.max_context_tokens,
      REQUIRED_EFFORT,
    ),
    modelDefinition(
      OLLAMA_MODEL_ALIAS,
      `Ollama ${route.ollamaLabel}`,
      "Direct local Ollama Responses route using the signed-in Ollama session",
      OLLAMA_CONTEXT_WINDOW,
      OLLAMA_REQUIRED_EFFORT,
    ),
  ] };
}

function health(requestedRoute = "auto") {
  const defaultActual = requestedRoute === "devin-free"
    ? { provider: "devin", model: models.terminal.model_uid, label: models.terminal.label }
    : requestedRoute === "ollama"
      ? { provider: "ollama", model: route.ollamaModel, label: route.ollamaLabel }
      : { provider: route.antigravityProvider, model: route.antigravityModels[0], label: route.antigravityModels[0] };
  const routeActual = runtime.actualByConfiguredRoute[requestedRoute] || defaultActual;
  return {
    ok: true, provider: PROVIDER_ID, port, modelAlias: MODEL_ALIAS,
    modelAliases: { auto: MODEL_ALIAS, devinFree: DEVIN_FREE_MODEL_ALIAS, ollama: OLLAMA_MODEL_ALIAS },
    effort: requestedRoute === "ollama" ? OLLAMA_REQUIRED_EFFORT : REQUIRED_EFFORT,
    lastActualProvider: routeActual.provider,
    lastActualModel: routeActual.model,
    lastActualModelLabel: routeActual.label,
    auth: requestedRoute === "ollama"
      ? { source: OLLAMA_AUTH_SOURCE, apiKeyRequired: false }
      : auth,
    providerAuth: {
      antigravity: ANTIGRAVITY_REQUIRED_AUTH_SOURCE,
      devin: auth.source,
      ollama: OLLAMA_AUTH_SOURCE,
      codebuddy: CODEBUDDY_REQUIRED_AUTH_SOURCE,
    },
    inputModalities: route.inputModalities,
    routing: {
      antigravity: {
        provider: route.antigravityProvider,
        uids: route.antigravityModels,
        effort: ANTIGRAVITY_REQUIRED_EFFORT,
        authSource: ANTIGRAVITY_REQUIRED_AUTH_SOURCE,
        explicitCostRequiredUsd: 0,
        endpoint: ANTIGRAVITY_BRIDGE_ENDPOINT,
      },
      devin: {
        provider: "devin",
        uid: models.primary.model_uid,
        label: models.primary.label,
        cost: models.primary.cost_summary || models.primary.cost_tier,
      },
      ollama: {
        provider: "ollama",
        uid: route.ollamaModel,
        label: route.ollamaLabel,
        acceptedResponseModels: route.ollamaResponseModels,
        effort: route.ollamaEffort,
        authSource: OLLAMA_AUTH_SOURCE,
        endpoint: "OpenCode CLI -> authenticated local Ollama service",
        maxConcurrency: route.ollamaMaxConcurrency,
        toolServing: "Provider-native file/shell tools plus two-tool lazy RzMCP proxy in one retained CLI session per Codex turn",
      },
      terminalFallback: {
        provider: "devin",
        uid: models.terminal.model_uid,
        label: models.terminal.label,
        cost: models.terminal.cost_summary || models.terminal.cost_tier,
        maxConcurrency: FREE_ROUTE_CONCURRENCY,
      },
      codebuddy: {
        provider: "codebuddy",
        uid: route.codeBuddyModel,
        effort: CODEBUDDY_REQUIRED_EFFORT,
        authSource: CODEBUDDY_REQUIRED_AUTH_SOURCE,
        endpoint: CODEBUDDY_BRIDGE_ENDPOINT,
        toolServing: "Provider-native file/shell tools plus two-tool lazy RzMCP proxy in one retained CLI session per Codex turn",
      },
      nativeFallback: {
        route: route.nativeFallbackRoute,
        activation: "Codex in-process provider switch after every external stage fails before committed work",
      },
      orderedPolicy: "antigravity_primary_then_antigravity_quota_fallback_then_devin_primary_then_ollama_then_devin_free_then_codebuddy_then_native_openai",
      configuredProviderOrder: route.autoProviderOrder,
      capacityPolicy: {
        autoWhenSaturated: "continue_to_next_provider",
        explicitRouteMaxWaitMs: ROUTE_CAPACITY_WAIT_MS,
      },
      quotaDetection: "explicit_daily_or_weekly_quota_failure_with_single_bounded_recovery_probe_every_30_minutes",
    },
    apiKeysStripped: true, ollamaApiKeyRequired: false,
    isolatedConfigImports: ["agents_standard"], lazyRzMcpProxyTools: 2,
    rawPromptFilesRetained: false, ephemeralSessionsRemoved: true,
    activeThreadTurns: activeThreadTurns.size, pinnedQuotaTasks: quotaTaskPins.size,
    pinnedProviderTasks: providerTaskPins.size,
    calendarQuotaState: calendarQuotaState.snapshot(), runtime,
  };
}

function jsonResponse(response, status, value) {
  const body = json(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

async function selfTest() {
  await nativeCliAgentRunnerSelfTest();
  const fixedQuotaNow = new Date(2026, 7, 28, 12, 0, 0, 0).getTime();
  const selfTestQuotaState = new CalendarQuotaState(null, () => fixedQuotaNow);
  const selfTestTaskPins = new ActiveTaskRoutePins();
  const selfTestRouteContext = { threadId: "thread-calendar", taskDiagnostics: { taskHash: "task-calendar" } };
  if (chooseDevinStage(selfTestRouteContext, selfTestQuotaState, selfTestTaskPins).key !== "primary") {
    throw new Error("unified primary route failed");
  }
  const dailyQuotaFailure = { code: 1, stdout: "", stderr: "Daily usage quota reached" };
  const weeklyQuotaFailure = { code: 1, stdout: "", stderr: "Weekly usage quota exhausted" };
  if (
    !selfTestQuotaState.record(dailyQuotaFailure)
    || selfTestQuotaState.snapshot().kind !== "daily"
    || chooseDevinStage(selfTestRouteContext, selfTestQuotaState, selfTestTaskPins).key !== "ollama"
    || runtime.lastQuotaSkipScope !== "calendar_quota"
  ) {
    throw new Error("daily calendar quota routing failed");
  }
  let recoveryProbeNow = fixedQuotaNow;
  const recoveryProbeState = new CalendarQuotaState(null, () => recoveryProbeNow);
  recoveryProbeState.record(dailyQuotaFailure);
  recoveryProbeNow += QUOTA_RECOVERY_PROBE_MS;
  const recoveryProbeRoute = chooseDevinStage(selfTestRouteContext, recoveryProbeState, selfTestTaskPins);
  if (
    recoveryProbeRoute.key !== "primary"
    || recoveryProbeRoute.reason !== "calendar_quota_recovery_probe"
    || chooseDevinStage(selfTestRouteContext, recoveryProbeState, selfTestTaskPins).key !== "ollama"
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
    route.antigravityProvider !== "antigravity"
    || route.antigravityModels.length !== 2
    || route.autoProviderOrder.join(",") !== REQUIRED_AUTO_PROVIDER_ORDER.join(",")
    || route.ollamaEffort !== OLLAMA_REQUIRED_EFFORT
    || route.ollamaMaxConcurrency !== OLLAMA_CLOUD_CONCURRENCY
    || !route.ollamaResponseModels.includes(route.ollamaModel)
    || route.nativeFallbackRoute !== "native"
    || !models.terminal.model_uid
  ) {
    throw new Error("ordered provider configuration failed");
  }
  const autoEffortFixture = {
    model: MODEL_ALIAS,
    reasoning: { effort: REQUIRED_EFFORT },
    stream: true,
  };
  const forwardedOllamaFixture = fallbackForwardBody(
    autoEffortFixture,
    autoEffortFixture.model,
    route.ollamaEffort,
    process.cwd(),
  );
  if (
    autoEffortFixture.reasoning.effort !== REQUIRED_EFFORT
    || forwardedOllamaFixture.reasoning.effort !== OLLAMA_REQUIRED_EFFORT
    || forwardedOllamaFixture.model !== MODEL_ALIAS
    || forwardedOllamaFixture.client_metadata?.cwd !== process.cwd()
  ) {
    throw new Error("auto route did not translate the Ollama stage to its required effort");
  }
  if (!LEGACY_REQUEST_EFFORTS.has("max") || LEGACY_REQUEST_EFFORTS.has("xhigh")) throw new Error("legacy effort compatibility failed");
  const isolatedEnvironment = sanitizedEnvironment({
    OPENAI_API_KEY: "must-not-survive",
    OPENAI_ORG_ID: "must-not-survive",
    OPENAI_PROJECT_ID: "must-not-survive",
    CODEX_API_KEY: "must-not-survive",
    OLLAMA_API_KEY: "must-not-survive",
    RETAINED_TEST_VALUE: "retained",
  });
  if (["OPENAI_API_KEY", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "CODEX_API_KEY", "OLLAMA_API_KEY"].some((key) => key in isolatedEnvironment)) {
    throw new Error("provider credential isolation failed");
  }
  if (isolatedEnvironment.RETAINED_TEST_VALUE !== "retained") throw new Error("environment isolation removed unrelated values");
  const readOnlyPolicy = executionPolicyFromTaskState({
    activeTask: { text: "Independent read-only review. Do not edit, build, test, or use Editor/PIE." },
  });
  const boundedMutationPolicy = executionPolicyFromTaskState({
    activeTask: { text: "Implement the bounded source fix. Do not build or run tests." },
  });
  const unrestrictedMutationPolicy = executionPolicyFromTaskState({
    activeTask: { text: "Implement and verify the bounded source fix." },
  });
  const scopedMutationPolicy = executionPolicyFromTaskState({
    activeTask: { text: "Implement the fix. Do not edit unrelated files." },
  });
  const shorthandMutationPolicy = executionPolicyFromTaskState({
    activeTask: { text: "Implement the bounded fix. No build/test/Editor/RzMCP/stage/commit." },
  });
  const shorthandReadOnlyPolicy = executionPolicyFromTaskState({
    activeTask: { text: "Review the bounded diff. No edits/build/test/Editor/RzMCP." },
  });
  const frenchBoundedReviewPolicy = executionPolicyFromTaskState({
    activeTask: {
      intent: "mutation",
      text: "Audit statique borne, aucun edit sauf correction chirurgicale, aucun build/test/editor/PIE/stage/commit.",
    },
  });
  const explicitReadOnlyRzMcpPolicy = executionPolicyFromTaskState({
    activeTask: {
      text: "Read-only inspection. No edits/build/tests/editor control/assets saves/staging. Use RzDirectMCP semantic/read-only APIs only (never binary grep).",
    },
  });
  const explicitRzMcpBanPolicy = executionPolicyFromTaskState({
    activeTask: { text: "Read-only inspection. Use repository text tools, but do not use or invoke RzDirectMCP." },
  });
  if (
    readOnlyPolicy.permissionMode !== "dangerous"
    || readOnlyPolicy.rzMcpMode !== "disabled"
    || boundedMutationPolicy.permissionMode !== "dangerous"
    || boundedMutationPolicy.rzMcpMode !== "no-validation"
    || unrestrictedMutationPolicy.permissionMode !== "dangerous"
    || unrestrictedMutationPolicy.rzMcpMode !== "no-validation"
    || scopedMutationPolicy.permissionMode !== "dangerous"
    || scopedMutationPolicy.rzMcpMode !== "no-validation"
    || shorthandMutationPolicy.permissionMode !== "dangerous"
    || shorthandMutationPolicy.rzMcpMode !== "disabled"
    || shorthandReadOnlyPolicy.permissionMode !== "dangerous"
    || shorthandReadOnlyPolicy.rzMcpMode !== "disabled"
    || frenchBoundedReviewPolicy.permissionMode !== "dangerous"
    || frenchBoundedReviewPolicy.rzMcpMode !== "disabled"
    || explicitReadOnlyRzMcpPolicy.permissionMode !== "dangerous"
    || explicitReadOnlyRzMcpPolicy.rzMcpMode !== "read-only"
    || explicitRzMcpBanPolicy.permissionMode !== "dangerous"
    || explicitRzMcpBanPolicy.rzMcpMode !== "disabled"
  ) {
    throw new Error("task execution permission policy failed");
  }
  const readOnlyEnvironment = providerEnvironment(readOnlyPolicy);
  if (
    readOnlyEnvironment.RZCODEX_SUBAGENT_RZMCP_MODE !== "disabled"
    || "OPENAI_API_KEY" in readOnlyEnvironment
  ) {
    throw new Error("task execution environment isolation failed");
  }
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
  const interruptedStreamFailure = {
    code: 1,
    stdout: "",
    stderr: "The stream was interrupted. Please continue the task you were working on.",
  };
  if (!isInterruptedStreamFailure(interruptedStreamFailure)) throw new Error("interrupted Devin stream classification failed");
  const compactedProviderFailure = { code: 1, stdout: "", stderr: "Devin provider context compacted at node 12" };
  const permissionFailure = {
    code: 1,
    stdout: "",
    stderr: "rejected a tool call that requires confirmation. Running in non-interactive mode.",
  };
  if (!isProviderCompactionFailure(compactedProviderFailure)) throw new Error("provider compaction classification failed");
  if (!isPermissionRejection(permissionFailure)) throw new Error("provider permission rejection classification failed");
  if (resourceBackoffMs(1) !== 5_000 || resourceBackoffMs(6) !== 10_000 || resourceBackoffMs(20) !== 10_000) throw new Error("resource backoff schedule failed");
  const incompleteTopology = terminalAssistantFromRows([
    {
      node_id: 1,
      chat_message: { role: "assistant", content: "I'll start by reading the files.", tool_calls: [{ name: "read" }] },
    },
    { node_id: 2, chat_message: { role: "tool", content: "file contents" } },
  ]);
  const completedTopology = terminalAssistantFromRows([
    {
      node_id: 1,
      chat_message: { role: "assistant", content: "I'll start by reading the files.", tool_calls: [{ name: "read" }] },
    },
    { node_id: 2, chat_message: { role: "tool", content: "file contents" } },
    { node_id: 3, chat_message: { role: "assistant", content: "Review complete.", tool_calls: [] } },
  ]);
  const compactedTopology = terminalAssistantFromRows([
    { node_id: 1, chat_message: { role: "assistant", content: "Working.", tool_calls: [{ name: "read" }] } },
    { node_id: 2, chat_message: { role: "tool", content: "file contents" } },
    { node_id: 3, chat_message: { role: "user", content: "Conversation to summarize:\nprior work" } },
    { node_id: 4, chat_message: { role: "assistant", content: "## Request and Intent\nCompaction summary.", tool_calls: [] } },
  ]);
  const completedAfterCompactionTopology = terminalAssistantFromRows([
    { node_id: 1, chat_message: { role: "user", content: "Now summarize the conversation above" } },
    { node_id: 2, chat_message: { role: "assistant", content: "Compaction summary.", tool_calls: [] } },
    { node_id: 3, chat_message: { role: "user", content: "Continue the retained task." } },
    { node_id: 4, chat_message: { role: "assistant", content: "Actual final report.", tool_calls: [] } },
  ]);
  if (
    incompleteTopology.terminalText !== null
    || incompleteTopology.lastToolNodeId !== 2
    || completedTopology.terminalText !== "Review complete."
    || completedTopology.terminalNodeId !== 3
    || compactedTopology.terminalText !== null
    || completedAfterCompactionTopology.terminalText !== "Actual final report."
  ) {
    throw new Error("Devin terminal assistant topology detection failed");
  }
  const priorProgressCalls = [
    { id: "tool-1", name: "read" },
    { id: "tool-2", name: "grep" },
  ];
  const recordedCompletions = completedToolCalls(priorProgressCalls, [
    { node_id: 1, chat_message: { role: "assistant", tool_calls: priorProgressCalls } },
    { node_id: 2, chat_message: { role: "tool", tool_call_id: "tool-1", content: "done" } },
  ]);
  if (recordedCompletions.length !== 1 || recordedCompletions[0].id !== "tool-1") {
    throw new Error("Devin progress announced a provider tool before its result was recorded");
  }
  const seenProgressCalls = new Set(
    priorProgressCalls.map((call, index) => providerToolCallKey(call, index)),
  );
  const resumedProgress = unseenProviderToolProgress(
    [...priorProgressCalls, { id: "tool-3", name: "edit" }],
    seenProgressCalls,
  );
  if (
    resumedProgress.length !== 1
    || resumedProgress[0].index !== 3
    || resumedProgress[0].name !== "edit"
  ) {
    throw new Error("Devin resumed tool progress repeated completed calls");
  }
  const compactionProgressState = {
    lastCompactionNodeId: 0,
    seenToolCalls: new Set(),
    providerWorkObserved: false,
  };
  const compactionProgress = observeDevinProviderProgress({
    compactionNodeId: 12,
    toolCalls: [],
    completedToolCalls: [],
  }, compactionProgressState);
  if (
    compactionProgress.length !== 0
    || compactionProgressState.lastCompactionNodeId !== 12
    || compactionProgressState.providerWorkObserved !== true
  ) {
    throw new Error("Devin provider compaction was not treated as continuing provider work");
  }
  const readOnlyRzMcpCall = {
    name: "mcp_call_tool",
    arguments: {
      server_name: "rzcodex-lazy",
      tool_name: "call_rzmcp_tool",
      arguments: { name: "inspect_graph_by_path", arguments: {} },
    },
  };
  const mutatingRzMcpCall = {
    ...readOnlyRzMcpCall,
    arguments: JSON.stringify({
      server_name: "rzcodex-lazy",
      tool_name: "call_rzmcp_tool",
      arguments: JSON.stringify({ name: "connect_pins_with_details", arguments: {} }),
    }),
  };
  if (
    mutationToolCalls([readOnlyRzMcpCall], { rzMcpMode: "read-only" }).length !== 0
    || mutationToolCalls([readOnlyRzMcpCall], { rzMcpMode: "full" }).length !== 0
    || mutationToolCalls([mutatingRzMcpCall], { rzMcpMode: "full" }).length !== 1
  ) {
    throw new Error("Devin lazy RzMCP mutation accounting is not authoritative");
  }
  const recoveryContext = {
    requestId: "devin-recovery-fixture",
    taskDiagnostics: { taskHash: "devin-recovery-task-hash" },
    taskState: {
      activeTask: {
        id: "devin-recovery-task",
        name: "/root/devin_recovery_fixture",
        hash: "devin-recovery-task-hash",
        text: "Message Type: NEW_TASK\nTask name: /root/devin_recovery_fixture\nPayload:\nInspect the bounded fixture.",
      },
    },
  };
  const recoveryModel = { model_uid: "recovery-model" };
  const preWorkRecoverySession = {
    id: "devin-pre-work-recovery-session",
    toolCalls: [],
    compactionNodeId: 0,
    terminalText: null,
  };
  const refreshedPreWorkRecoverySession = {
    ...preWorkRecoverySession,
    terminalText: "recovered",
  };
  const recoveryCalls = [];
  const recoveryDelays = [];
  let recoverySessionReads = 0;
  let recoveryNow = 1_000;
  const recoveredCli = await runCliWithProviderRecovery(
    recoveryContext,
    recoveryModel,
    () => {},
    () => {},
    undefined,
    100_000,
    {
      now: () => recoveryNow,
      delay: async (milliseconds) => {
        recoveryDelays.push(milliseconds);
        recoveryNow += milliseconds;
      },
      waitForSession: async () => {
        recoverySessionReads += 1;
        return recoverySessionReads === 1 ? preWorkRecoverySession : refreshedPreWorkRecoverySession;
      },
      waitForTerminalSession: async (_requestId, session) => session,
      removeSession: () => { throw new Error("recovered Devin session was removed"); },
      runCli: async (_context, _model, _onSpawn, _onProgress, timeoutMs, options) => {
        recoveryCalls.push({ timeoutMs, options });
        return recoveryCalls.length === 1
          ? interruptedStreamFailure
          : { code: 0, stdout: "recovered", stderr: "" };
      },
    },
  );
  if (
    recoveredCli.session !== refreshedPreWorkRecoverySession
    || recoveryCalls.length !== 2
    || recoveryCalls[0].options !== undefined
    || recoveryCalls[1].options?.resumeSessionId !== preWorkRecoverySession.id
    || !recoveryCalls[1].options?.prompt.includes(recoveryContext.taskDiagnostics.taskHash)
    || recoveryCalls.map(({ timeoutMs }) => timeoutMs).join(",") !== "99000,44000"
    || recoveryDelays.join(",") !== "1000"
  ) {
    throw new Error("same-session Devin stream recovery failed");
  }
  const committedSession = {
    id: "devin-committed-session",
    model: recoveryModel.model_uid,
    toolCalls: [{ id: "committed-read", name: "read" }, { id: "committed-edit", name: "edit" }],
    compactionNodeId: 0,
    terminalText: null,
  };
  const recoveredCommittedSession = {
    ...committedSession,
    terminalText: "Committed work recovered.",
  };
  const committedCalls = [];
  const committedDelays = [];
  const committedProgress = [];
  let committedSessionReads = 0;
  let committedNow = 1_000;
  const recoveredCommitted = await runCliWithProviderRecovery(
    recoveryContext,
    recoveryModel,
    () => {},
    (progress) => committedProgress.push(progress),
    undefined,
    100_000,
    {
      now: () => committedNow,
      delay: async (milliseconds) => {
        committedDelays.push(milliseconds);
        committedNow += milliseconds;
      },
      waitForSession: async () => {
        committedSessionReads += 1;
        return committedSessionReads === 1 ? committedSession : recoveredCommittedSession;
      },
      waitForTerminalSession: async (_requestId, session) => session,
      removeSession: () => { throw new Error("recovered committed session was removed"); },
      runCli: async (_context, _model, _onSpawn, _onProgress, timeoutMs, options) => {
        committedCalls.push({ timeoutMs, options });
        return committedCalls.length === 1
          ? interruptedStreamFailure
          : { code: 0, stdout: "Committed work recovered.", stderr: "" };
      },
    },
  );
  if (
    recoveredCommitted.session !== recoveredCommittedSession
    || committedCalls.length !== 2
    || committedCalls[0].options !== undefined
    || committedCalls[1].options?.resumeSessionId !== committedSession.id
    || committedCalls[1].options?.toolCallBaseline?.length !== 2
    || !committedCalls[1].options?.prompt.includes("Native Devin stream recovery")
    || committedDelays.join(",") !== "1000"
    || committedProgress.length !== 1
    || committedProgress[0]?.kind !== "recovery"
  ) {
    throw new Error("Devin post-tool stream continuation failed");
  }
  const terminalFailureCalls = [];
  const terminalFailureDelays = [];
  let terminalFailureNow = 1_000;
  const committedCheckpoint = await runCliWithProviderRecovery(
    recoveryContext,
    recoveryModel,
    () => {},
    () => {},
    undefined,
    100_000,
    {
      now: () => terminalFailureNow,
      delay: async (milliseconds) => {
        terminalFailureDelays.push(milliseconds);
        terminalFailureNow += milliseconds;
      },
      waitForSession: async () => committedSession,
      waitForTerminalSession: async (_requestId, session) => session,
      removeSession: () => { throw new Error("committed checkpoint session was removed before finalization"); },
      runCli: async (_context, _model, _onSpawn, _onProgress, timeoutMs, options) => {
        terminalFailureCalls.push({ timeoutMs, options });
        return interruptedStreamFailure;
      },
    },
  );
  if (
    terminalFailureCalls.length !== 2
    || terminalFailureDelays.join(",") !== "1000"
    || !committedCheckpoint.session.terminalText.includes("Authoritative native-provider checkpoint")
    || !committedCheckpoint.session.terminalText.includes("Provider tool calls completed: 2")
    || !committedCheckpoint.session.terminalText.includes("Provider mutation calls observed: 1")
    || !committedCheckpoint.session.terminalText.includes("One bounded same-session continuation")
  ) {
    throw new Error("Devin post-tool continuation bound failed");
  }
  const compactionSession = {
    id: "devin-compaction-session",
    model: recoveryModel.model_uid,
    toolCalls: [{ id: "compaction-exec", name: "exec" }],
    compactionNodeId: 12,
    terminalText: null,
  };
  const completedCompactionSession = {
    ...compactionSession,
    terminalText: "Compaction checkpoint returned.",
  };
  const compactionCalls = [];
  const compactionDelays = [];
  let compactionSessionReads = 0;
  let compactionNow = 1_000;
  const recoveredCompaction = await runCliWithProviderRecovery(
    recoveryContext,
    recoveryModel,
    () => {},
    () => {},
    undefined,
    100_000,
    {
      now: () => compactionNow,
      delay: async (milliseconds) => {
        compactionDelays.push(milliseconds);
        compactionNow += milliseconds;
      },
      waitForSession: async () => {
        compactionSessionReads += 1;
        return compactionSessionReads === 1 ? compactionSession : completedCompactionSession;
      },
      waitForTerminalSession: async (_requestId, session) => session,
      removeSession: () => { throw new Error("compaction checkpoint session was removed"); },
      runCli: async (_context, _model, _onSpawn, _onProgress, timeoutMs, options) => {
        compactionCalls.push({ timeoutMs, options });
        return compactionCalls.length === 1
          ? compactedProviderFailure
          : { code: 0, stdout: "Compaction checkpoint returned.", stderr: "" };
      },
    },
  );
  if (
    recoveredCompaction.session !== completedCompactionSession
    || compactionCalls.length !== 2
    || compactionCalls[0].options !== undefined
    || compactionCalls[1].options?.resumeSessionId !== compactionSession.id
    || compactionCalls[1].options?.toolCallBaseline?.length !== 1
    || !compactionCalls[1].options?.prompt.includes("Native Devin compaction checkpoint")
    || !compactionCalls[1].options?.prompt.includes(recoveryContext.taskState.activeTask.text)
    || compactionDelays.join(",") !== "1000"
  ) {
    throw new Error("Devin provider compaction continuation failed");
  }
  const permissionPrompt = devinPermissionCheckpointPrompt(recoveryContext);
  if (
    !permissionPrompt.includes("Native Devin permission checkpoint")
    || !permissionPrompt.includes(recoveryContext.taskState.activeTask.text)
  ) {
    throw new Error("Devin permission checkpoint did not retain the active task");
  }
  const incompleteCalls = [];
  const incompleteDelays = [];
  const completedIncompleteSession = {
    ...committedSession,
    terminalText: "Incomplete turn recovered.",
  };
  let incompleteSessionReads = 0;
  let incompleteNow = 1_000;
  const recoveredIncomplete = await runCliWithProviderRecovery(
    recoveryContext,
    recoveryModel,
    () => {},
    () => {},
    undefined,
    100_000,
    {
      now: () => incompleteNow,
      delay: async (milliseconds) => {
        incompleteDelays.push(milliseconds);
        incompleteNow += milliseconds;
      },
      waitForSession: async () => {
        incompleteSessionReads += 1;
        return incompleteSessionReads === 1 ? committedSession : completedIncompleteSession;
      },
      waitForTerminalSession: async (_requestId, session) => session,
      removeSession: () => { throw new Error("incomplete Devin session was removed"); },
      runCli: async (_context, _model, _onSpawn, _onProgress, _timeoutMs, options) => {
        incompleteCalls.push(options);
        return incompleteCalls.length === 1
          ? { code: 0, stdout: "I'll start by inspecting the fixture.", stderr: "" }
          : { code: 0, stdout: "Incomplete turn recovered.", stderr: "" };
      },
    },
  );
  if (
    recoveredIncomplete.session !== completedIncompleteSession
    || incompleteCalls.length !== 2
    || incompleteCalls[0] !== undefined
    || incompleteCalls[1]?.resumeSessionId !== committedSession.id
    || incompleteCalls[1]?.toolCallBaseline?.length !== 2
    || !incompleteCalls[1]?.prompt.includes("Native Devin terminal-message recovery")
    || incompleteDelays.join(",") !== "1000"
  ) {
    throw new Error("Devin structurally incomplete post-tool continuation failed");
  }
  const emptyRecoverySession = {
    id: "devin-empty-recovery-session",
    toolCalls: [],
    compactionNodeId: 0,
    terminalText: null,
  };
  let exhaustedNow = 1_000;
  let exhaustedRemoved = 0;
  let exhaustedFailure;
  try {
    await runCliWithProviderRecovery(
      recoveryContext,
      recoveryModel,
      () => {},
      () => {},
      undefined,
      100_000,
      {
        now: () => exhaustedNow,
        delay: async (milliseconds) => { exhaustedNow += milliseconds; },
        waitForSession: async () => emptyRecoverySession,
        waitForTerminalSession: async (_requestId, session) => session,
        removeSession: () => { exhaustedRemoved += 1; },
        runCli: async () => interruptedStreamFailure,
      },
    );
  } catch (error) {
    exhaustedFailure = error;
  }
  if (
    exhaustedFailure?.status !== 502
    || exhaustedFailure?.routeCommitted === true
    || !exhaustedFailure?.message.includes("after one same-session continuation")
    || exhaustedNow - 1_000 !== PROVIDER_RECOVERY_BACKOFF_MS
    || exhaustedRemoved !== 1
  ) {
    throw new Error("Devin interrupted-stream single-continuation bound failed");
  }
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
  const metadataWorkspace = promptFrom({
    stream: true,
    model: MODEL_ALIAS,
    reasoning: { effort: REQUIRED_EFFORT },
    client_metadata: { cwd: homedir() },
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `<environment_context><cwd>${process.cwd()}</cwd></environment_context>` }],
    }],
  }).workingDirectory;
  if (metadataWorkspace !== homedir()) throw new Error("authoritative metadata workspace was not preferred");
  const directFreeContext = promptFrom({
    stream: true,
    model: DEVIN_FREE_MODEL_ALIAS,
    reasoning: { effort: REQUIRED_EFFORT },
    input: [{ type: "message", role: "user", content: "Use the direct free route." }],
    client_metadata: { cwd: process.cwd() },
  });
  if (
    directFreeContext.requestedRoute !== "devin-free"
    || initialSelection(directFreeContext).key !== "terminal"
  ) {
    throw new Error("direct Devin free route failed");
  }
  const directOllamaContext = promptFrom({
    stream: true,
    model: OLLAMA_MODEL_ALIAS,
    reasoning: { effort: OLLAMA_REQUIRED_EFFORT },
    input: [{ type: "message", role: "user", content: "Use the direct Ollama route." }],
    client_metadata: { cwd: process.cwd() },
  });
  if (directOllamaContext.requestedRoute !== "ollama" || initialSelection(directOllamaContext).key !== "ollama") {
    throw new Error("direct Ollama route failed");
  }
  const advertisedModels = managedModelsResponse().models;
  if (
    advertisedModels.length !== 3
    || !advertisedModels.some((model) => model.slug === MODEL_ALIAS)
    || !advertisedModels.some((model) => model.slug === DEVIN_FREE_MODEL_ALIAS)
    || !advertisedModels.some((model) => model.slug === OLLAMA_MODEL_ALIAS && model.default_reasoning_level === OLLAMA_REQUIRED_EFFORT)
  ) {
    throw new Error("managed route aliases were not all advertised");
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
    client_metadata: { cwd: process.cwd() },
  }).prompt;
  const staleIndex = prompt.indexOf("Stale inherited instruction");
  const taskIndex = prompt.indexOf(task);
  const checkpointIndex = prompt.indexOf(checkpoint);
  if (!(staleIndex >= 0 && staleIndex < taskIndex && taskIndex < checkpointIndex)) throw new Error("active task precedence failed");
  if (prompt.indexOf(task, taskIndex + task.length) !== -1) throw new Error("active task duplication failed");
  if (
    !prompt.includes("[Authoritative progress since active task]")
    || !prompt.includes("[Project AGENTS instructions - authoritative and complete]")
    || !prompt.includes("[Mutation convergence contract]")
    || !prompt.includes("[On-demand checkpoint requested]")
    || !prompt.includes("[Immediate terminal report required]")
  ) {
    throw new Error("managed convergence state was not delivered to the provider");
  }
  const saturatedPrompt = promptFrom({
    stream: true,
    model: MODEL_ALIAS,
    reasoning: { effort: REQUIRED_EFFORT },
    input: [
      ...Array.from({ length: 20 }, (_, index) => ({
        type: "message",
        role: index % 2 === 0 ? "user" : "assistant",
        content: `saturated-history-${index}\n${"x".repeat(9_000)}`,
      })),
      { type: "agent_message", id: "self-test-saturated-task", author: "Codex", recipient: "/root/self_test", content: [{ type: "input_text", text: task }] },
    ],
    client_metadata: { cwd: process.cwd() },
  }).prompt;
  if (saturatedPrompt.length > MAX_PROMPT_CHARS || saturatedPrompt.split(task).length !== 2) {
    throw new Error("managed saturated prompt lost its hard bound or duplicated the active task");
  }
  const analysisPrompt = promptFrom({
    stream: true,
    model: MODEL_ALIAS,
    reasoning: { effort: REQUIRED_EFFORT },
    input: [{
      type: "agent_message",
      id: "self-test-analysis",
      author: "Codex",
      recipient: "/root/self_test",
      content: [{
        type: "input_text",
        text: "Message Type: NEW_TASK\nTask name: /root/self_test\nPayload:\nInspect the bounded evidence and report only when complete.",
      }],
    }],
    client_metadata: { cwd: process.cwd() },
  });
  if (
    !analysisPrompt.prompt.includes("[Analysis convergence contract]")
    || analysisPrompt.prompt.includes("[Immediate terminal report required]")
  ) {
    throw new Error("analysis convergence control produced a false immediate return");
  }
  const explicitReadOnlyAudit = promptFrom({
    stream: true,
    model: MODEL_ALIAS,
    reasoning: { effort: REQUIRED_EFFORT },
    input: [{
      type: "agent_message",
      id: "self-test-explicit-read-only",
      author: "Codex",
      recipient: "/root/self_test",
      content: [{
        type: "input_text",
        text: "Message Type: NEW_TASK\nTask name: /root/self_test\nPayload:\nREAD-ONLY bounded audit. Audit whether the previous fix is correct. Do not mutate files/assets.",
      }],
    }],
    client_metadata: { cwd: process.cwd() },
  });
  if (
    explicitReadOnlyAudit.taskDiagnostics.taskIntent !== "analysis"
    || explicitReadOnlyAudit.executionPolicy.permissionMode !== "dangerous"
    || !explicitReadOnlyAudit.prompt.includes("[Analysis convergence contract]")
    || explicitReadOnlyAudit.prompt.includes("[Mutation convergence contract]")
  ) {
    throw new Error("explicit read-only audit was misclassified as mutation");
  }
  const priorResumeTaskText = "Message Type: NEW_TASK\nTask name: /root/resume_fixture\nPayload:\nImplement the original bounded diagnostic with the exact supplied ownership constraints.";
  const activeResumeTaskText = "Message Type: NEW_TASK\nTask name: /root/resume_fixture\nPayload:\nBridge repaired. Resume the same bounded implementation from your preserved state; keep the original scope and finish.";
  const resumeThreadId = "devin-retained-checkpoint-fixture";
  const beforeBridgeRestartResume = promptFrom({
    stream: true,
    model: OLLAMA_MODEL_ALIAS,
    reasoning: { effort: OLLAMA_REQUIRED_EFFORT },
    client_metadata: { cwd: process.cwd(), thread_id: resumeThreadId },
    input: [
      { type: "agent_message", id: "prior-resume-task-only", author: "Codex", recipient: "/root/resume_fixture", content: [{ type: "input_text", text: priorResumeTaskText }] },
    ],
  });
  const afterBridgeRestartResume = promptFrom({
    stream: true,
    model: OLLAMA_MODEL_ALIAS,
    reasoning: { effort: OLLAMA_REQUIRED_EFFORT },
    client_metadata: { cwd: process.cwd(), thread_id: resumeThreadId },
    input: [
      { type: "agent_message", id: "prior-resume-task", author: "Codex", recipient: "/root/resume_fixture", content: [{ type: "input_text", text: priorResumeTaskText }] },
      { type: "agent_message", id: "active-resume-task", author: "Codex", recipient: "/root/resume_fixture", content: [{ type: "input_text", text: activeResumeTaskText }] },
    ],
  });
  if (
    afterBridgeRestartResume.prompt.split(priorResumeTaskText).length - 1 !== 1
    || afterBridgeRestartResume.prompt.split(activeResumeTaskText).length - 1 !== 1
    || !afterBridgeRestartResume.prompt.includes("[Referenced prior delegated context]")
    || afterBridgeRestartResume.taskDiagnostics.taskIntent !== "mutation"
    || !afterBridgeRestartResume.prompt.includes("[Mutation convergence contract]")
    || retainedDevinSessionKey(beforeBridgeRestartResume, { model_uid: "fixture-model" })
      !== retainedDevinSessionKey(afterBridgeRestartResume, { model_uid: "fixture-model" })
  ) {
    throw new Error("managed bridge restart lost referenced prior task context");
  }
  const mutationReturnWhenDone = promptFrom({
    stream: true,
    model: MODEL_ALIAS,
    reasoning: { effort: REQUIRED_EFFORT },
    input: [{
      type: "agent_message",
      id: "self-test-mutation-return-when-done",
      author: "Codex",
      recipient: "/root/self_test",
      content: [{
        type: "input_text",
        text: "Message Type: NEW_TASK\nTask name: /root/self_test\nPayload:\nImplement the bounded patch and return immediately when complete.",
      }],
    }],
    client_metadata: { cwd: process.cwd() },
  });
  if (mutationReturnWhenDone.prompt.includes("[Immediate terminal report required]")) {
    throw new Error("mutation completion wording falsely triggered immediate return");
  }
  const reversedPrompt = promptFrom({
    stream: true,
    model: MODEL_ALIAS,
    reasoning: { effort: REQUIRED_EFFORT },
    input: [
      { type: "agent_message", id: "self-test-checkpoint-first", author: "Codex", recipient: "/root/self_test", content: [{ type: "input_text", text: checkpoint }] },
      { type: "agent_message", id: "self-test-task-last", author: "Codex", recipient: "/root/self_test", content: [{ type: "input_text", text: task }] },
    ],
    client_metadata: { cwd: process.cwd() },
  }).prompt;
  const reversedTaskIndex = reversedPrompt.indexOf(task);
  const reversedCheckpointIndex = reversedPrompt.indexOf(checkpoint);
  if (!(reversedTaskIndex >= 0 && reversedTaskIndex < reversedCheckpointIndex)) throw new Error("checkpoint precedence failed");
  const resumedPrompt = promptFrom({
    stream: true,
    model: OLLAMA_MODEL_ALIAS,
    reasoning: { effort: OLLAMA_REQUIRED_EFFORT },
    input: [
      { type: "agent_message", id: "resume-task", author: "Codex", recipient: "/root/self_test", content: [{ type: "input_text", text: task }] },
      {
        type: "reasoning",
        id: "progress_self_test",
        summary: [{ type: "summary_text", text: "BRIDGE_PROGRESS_MUST_NOT_REENTER" }],
      },
      {
        type: "reasoning",
        id: "rs_parent_self_test",
        summary: [{ type: "summary_text", text: "PORTABLE_PARENT_REASONING" }],
      },
      { type: "function_call", call_id: "resume-call", name: "exec_command", arguments: json({ cmd: "rg needle file.cpp" }) },
      { type: "function_call_output", call_id: "resume-call", output: "Exit code: 0\nOutput:\nneedle" },
      { type: "tool_search_call", call_id: "search-call", execution: "client", arguments: { query: "RzMCP graph" } },
      {
        type: "tool_search_output",
        call_id: "search-call",
        status: "completed",
        execution: "client",
        tools: [{ type: "function", name: "rzmcp__inspect_graph", parameters: { type: "object" } }],
      },
    ],
    client_metadata: { cwd: process.cwd() },
  }).prompt;
  if (
    resumedPrompt.includes("BRIDGE_PROGRESS_MUST_NOT_REENTER")
    || !resumedPrompt.includes("PORTABLE_PARENT_REASONING")
    || !resumedPrompt.includes("rg needle file.cpp")
    || !resumedPrompt.includes("Exit code: 0\nOutput:\nneedle")
    || !resumedPrompt.includes("rzmcp__inspect_graph")
  ) {
    throw new Error("stateless provider resume lost tool request or result context");
  }
  let supersededAbortCalls = 0;
  const firstTurn = { requestId: "first", abort: () => { supersededAbortCalls += 1; } };
  const secondTurn = { requestId: "second", abort: () => {} };
  await registerThreadTurn("thread-self-test", firstTurn);
  await registerThreadTurn("thread-self-test", secondTurn);
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
  const relay = createProviderStreamRelay(relayResponse, "resp-relay", MODEL_ALIAS, relayProgress);
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
    || relay.providerOutputObserved
    || !relayWrites.join("").includes("safe native progress")
    || relayWrites.join("").includes("hidden provider reasoning")
  ) {
    throw new Error("fallback progress relay boundary failed");
  }
  const forwardedReasoningWrites = [];
  const forwardedReasoningResponse = {
    destroyed: false,
    writableEnded: false,
    write: (value) => forwardedReasoningWrites.push(value),
  };
  const forwardedReasoningProgress = createProgressEmitter(forwardedReasoningResponse);
  const forwardedReasoningRelay = createProviderStreamRelay(
    forwardedReasoningResponse,
    "resp-reasoning-relay",
    OLLAMA_MODEL_ALIAS,
    forwardedReasoningProgress,
    { forwardReasoningSummaries: true, providerLabel: "Ollama" },
  );
  await forwardedReasoningRelay.accept({
    type: "response.output_item.added",
    payload: { output_index: 0, item: { type: "reasoning", id: "rs-ollama", status: "in_progress", summary: [] } },
  });
  await forwardedReasoningRelay.accept({
    type: "response.reasoning_summary_text.delta",
    payload: { item_id: "rs-ollama", output_index: 0, summary_index: 0, delta: "inspect the target\n" },
  });
  if (!forwardedReasoningProgress.added || !forwardedReasoningWrites.join("").includes("inspect the target")) {
    throw new Error("Ollama reasoning progress relay failed");
  }
  const streamedToolItem = {
    type: "function_call",
    id: "fc-progress-once",
    call_id: "call-progress-once",
    name: "exec_command",
    arguments: "{}",
  };
  await forwardedReasoningRelay.accept({
    type: "response.output_item.added",
    payload: { output_index: 1, item: streamedToolItem },
  });
  await forwardedReasoningRelay.accept({
    type: "response.output_item.done",
    payload: { output_index: 1, item: streamedToolItem },
  });
  const forwardedToolDeltas = forwardedReasoningWrites.filter((value) => (
    value.includes("event: response.reasoning_summary_text.delta")
    && value.includes("Ollama requested native tool exec_command.")
  ));
  if (forwardedToolDeltas.length !== 1) {
    throw new Error("Ollama tool progress was not deduplicated");
  }
  if (!forwardedReasoningRelay.providerWorkCommitted) {
    throw new Error("Ollama native tool progress did not commit the provider route");
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
  if (relay.committed || !relay.providerOutputObserved || relay.streamedMessageIds.size !== 0) {
    throw new Error("fallback relay confused buffered provider output with client commitment");
  }
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
  const toolCommitRelay = createProviderStreamRelay(relayResponse, "resp-tool-relay", MODEL_ALIAS, relayProgress);
  await toolCommitRelay.accept({
    type: "response.output_item.added",
    payload: { output_index: 0, item: { type: "function_call", id: "fc-commit", call_id: "call-commit", name: "exec_command", arguments: "{}" } },
  });
  if (toolCommitRelay.committed || !toolCommitRelay.providerOutputObserved) {
    throw new Error("provider relay committed before the streamed tool call was replayed to Codex");
  }
  const fallbackCompletion = {
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
      actual_provider: route.antigravityProvider,
      actual_model: route.antigravityModels[0],
      actual_model_label: "Claude Opus 4.6 (Thinking)",
      auth_source: ANTIGRAVITY_REQUIRED_AUTH_SOURCE,
      peak_turn_context_tokens: 110,
      output_tokens_per_second: 250,
      native_tool_names: ["exec_command"],
      rzmcp_tools_called: ["find_blueprint_nodes"],
      codex_tool_schema_bytes_forwarded: 0,
      lazy_rzmcp_proxy_tools: 2,
    },
  };
  const fallbackFixture = responsesResult(
    fallbackCompletion,
    {
      ...antigravitySelection("fixture"),
      model: { model_uid: route.antigravityModels[0], label: "Claude Opus 4.6 (Thinking)" },
    },
    {
      quotaFallback: false,
      terminalFallback: false,
      fallbackReason: null,
      fallbackFailure: null,
    },
    { ignoredBytes: 17_000, forwardedBytes: 0 },
  );
  if (
    fallbackFixture.selected.key !== "antigravity"
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
  const ollamaFixtureBody = {
    stream: true,
    model: OLLAMA_MODEL_ALIAS,
    reasoning: { effort: OLLAMA_REQUIRED_EFFORT },
    client_metadata: { cwd: process.cwd() },
    input: [
      {
        type: "agent_message",
        id: "ollama-task",
        author: "/root",
        recipient: "/root/ollama_fixture",
        content: [{ type: "input_text", text: task }],
      },
      { type: "compaction", encrypted_content: "provider-opaque" },
    ],
    tools: [
      { type: "custom", name: "apply_patch", description: "Apply a patch", format: { type: "text" } },
      {
        type: "tool_search",
        execution: "client",
        description: "Search deferred tools",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
      { type: "web_search", external_web_access: true },
      {
        type: "namespace",
        name: "rzcodex_lazy",
        tools: [{
          type: "function",
          name: "search_rzmcp_tools",
          description: "Search lazy tools",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        }],
      },
    ],
  };
  const ollamaFixtureContext = promptFrom(ollamaFixtureBody);
  const translatedOllamaFixture = ollamaRequest(ollamaFixtureBody, ollamaFixtureContext);
  const translatedOllamaJson = json(translatedOllamaFixture.body);
  if (
    translatedOllamaFixture.body.model !== route.ollamaModel
    || translatedOllamaFixture.body.reasoning.effort !== OLLAMA_REQUIRED_EFFORT
    || translatedOllamaJson.includes('"agent_message"')
    || translatedOllamaJson.includes('"compaction"')
    || translatedOllamaFixture.body.input[0].content[0].text.split(task).length - 1 !== 1
    || translatedOllamaFixture.body.tools.some((tool) => tool.type !== "function")
    || translatedOllamaFixture.body.tools.some((tool) => tool.name === "web_search")
    || translatedOllamaFixture.hostedWebSearchReplaced !== true
    || !translatedOllamaFixture.body.input[0].content[0].text.includes("represented by Codex deferred tool_search")
    || !translatedOllamaFixture.responseTools.has("apply_patch")
    || !translatedOllamaFixture.responseTools.has("tool_search")
    || !translatedOllamaFixture.responseTools.has("rzcodex_lazy__search_rzmcp_tools")
    || translatedOllamaFixture.forwardedBytes <= 0
  ) {
    throw new Error("Ollama request normalization failed");
  }
  const restoredOllamaFixture = validateOllamaCompletion({
    status: "completed",
    model: route.ollamaResponseModels.at(-1),
    reasoning: { effort: OLLAMA_REQUIRED_EFFORT },
    output: [{
      type: "function_call",
      id: "fc-ollama",
      call_id: "call-ollama",
      name: "apply_patch",
      arguments: json({ input: "*** Begin Patch\n*** End Patch" }),
    }],
  }, translatedOllamaFixture.responseTools);
  if (
    restoredOllamaFixture.output[0]?.type !== "custom_tool_call"
    || restoredOllamaFixture.output[0]?.input !== "*** Begin Patch\n*** End Patch"
  ) {
    throw new Error("Ollama custom tool restoration failed");
  }
  const restoredToolSearchFixture = validateOllamaCompletion({
    status: "completed",
    model: route.ollamaResponseModels.at(-1),
    output: [{
      type: "function_call",
      id: "fc-search",
      call_id: "call-search",
      name: "tool_search",
      arguments: json({ query: "RzMCP blueprint graph" }),
    }],
  }, translatedOllamaFixture.responseTools);
  if (
    restoredToolSearchFixture.output[0]?.type !== "tool_search_call"
    || restoredToolSearchFixture.output[0]?.execution !== "client"
    || restoredToolSearchFixture.output[0]?.arguments?.query !== "RzMCP blueprint graph"
  ) {
    throw new Error("Ollama deferred tool search restoration failed");
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
    || providerResponseErrorCode({ nativeFallbackRoute: "native" }) !== "native_subagent_fallback"
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
  const readOnlyCommittedError = preserveProviderCommit(new Error("fixture"), {
    toolCalls: [{ name: "read" }],
  });
  readOnlyCommittedError.failedStage = "ollama";
  const committedCheckpointResult = committedProviderResult(
    { taskDiagnostics: recoveryContext.taskDiagnostics, toolSchemaBytes: 123 },
    readOnlyCommittedError,
  );
  if (
    readOnlyCommittedError.routeCommitted !== true
    || committedCheckpointResult.selected.provider !== "ollama"
    || committedCheckpointResult.nativeToolNames.join(",") !== "read"
    || !committedCheckpointResult.text.includes("was not replayed")
    || committedCheckpointResult.toolSchemaBytesIgnored !== 123
  ) {
    throw new Error("read-only provider checkpoint classification failed");
  }
  const pinnedContinuationResult = committedProviderResult(
    { taskDiagnostics: recoveryContext.taskDiagnostics, toolSchemaBytes: 123 },
    Object.assign(new Error("fixture"), {
      failedStage: "ollama",
      providerTaskPinPreserved: true,
    }),
  );
  if (
    pinnedContinuationResult.autoStage !== "ollama"
    || pinnedContinuationResult.preserveProviderPin !== true
    || !pinnedContinuationResult.text.includes("remains pinned to the same provider")
  ) {
    throw new Error("active provider continuation checkpoint lost its provider pin");
  }
  const abortedProviderContext = {
    requestedRoute: "auto",
    threadId: "thread-aborted-provider-owner",
    taskState: { activeTask: { hash: "task-aborted-provider-owner" } },
    taskDiagnostics: { taskHash: "task-aborted-provider-owner" },
  };
  pinProviderTask(abortedProviderContext, "devin-free");
  const abortedProviderController = new AbortController();
  abortedProviderController.abort();
  const abortedProviderError = new Error("superseded by parent checkpoint");
  const abortedProviderStage = preserveProviderPinForAbortedTurn(
    abortedProviderContext,
    abortedProviderError,
    abortedProviderController.signal,
  );
  if (
    abortedProviderStage !== "devin-free"
    || abortedProviderError.providerTaskPinPreserved !== true
    || abortedProviderError.routeCommitted !== true
    || providerTaskPins.get(
      abortedProviderContext.threadId,
      ownershipTaskHash(abortedProviderContext),
    ) !== "devin-free"
  ) {
    throw new Error("parent checkpoint abort released the active provider owner");
  }
  providerTaskPins.release(
    abortedProviderContext.threadId,
    ownershipTaskHash(abortedProviderContext),
  );
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
    || runtime.activeFreeRequests !== 0
    || runtime.queuedFreeRequests !== 0
  ) {
    throw new Error("Devin free route capacity failed");
  }
  let releaseFreeCapacityHolders;
  const freeCapacityGate = new Promise((resolve) => { releaseFreeCapacityHolders = resolve; });
  const freeCapacityHolders = Array.from({ length: FREE_ROUTE_CONCURRENCY }, () =>
    withRouteCapacity(freeRoute, undefined, () => freeCapacityGate));
  await delayWithAbort(1);
  let saturatedAutoError;
  try {
    await withRouteCapacity(
      freeRoute,
      undefined,
      async () => { throw new Error("saturated auto route unexpectedly acquired capacity"); },
      { skipIfBusy: true },
    );
  } catch (error) {
    saturatedAutoError = error;
  }
  if (saturatedAutoError?.status !== 503 || saturatedAutoError?.routeSkipped !== true) {
    throw new Error("saturated auto route did not skip to the next provider");
  }
  const saturatedAutoChain = await runOrderedProviderChain({
    stages: [
      {
        name: "devin-free",
        run: () => withRouteCapacity(
          freeRoute,
          undefined,
          async () => { throw new Error("saturated auto chain unexpectedly acquired capacity"); },
          { skipIfBusy: true },
        ),
      },
      { name: "next-provider", run: async () => "next-provider" },
    ],
  });
  if (saturatedAutoChain.stage !== "next-provider" || saturatedAutoChain.value !== "next-provider") {
    throw new Error("saturated auto chain did not continue to the next provider");
  }
  let boundedCapacityError;
  try {
    await withRouteCapacity(
      freeRoute,
      undefined,
      async () => { throw new Error("bounded route unexpectedly acquired capacity"); },
      { maxWaitMs: 5 },
    );
  } catch (error) {
    boundedCapacityError = error;
  }
  if (boundedCapacityError?.status !== 503 || boundedCapacityError?.routeSkipped === true) {
    throw new Error("explicit route capacity wait was not bounded");
  }
  releaseFreeCapacityHolders();
  await Promise.all(freeCapacityHolders);
  if (
    terminalCapacity.active !== 0
    || terminalCapacity.waiters.length !== 0
    || runtime.activeFreeRequests !== 0
    || runtime.queuedFreeRequests !== 0
  ) {
    throw new Error("bounded route capacity cleanup failed");
  }
  let concurrentOllamaCalls = 0;
  let peakConcurrentOllamaCalls = 0;
  const ollamaRoute = { key: "ollama" };
  await Promise.all(Array.from({ length: 6 }, () => withRouteCapacity(ollamaRoute, undefined, async () => {
    concurrentOllamaCalls += 1;
    peakConcurrentOllamaCalls = Math.max(peakConcurrentOllamaCalls, concurrentOllamaCalls);
    await delayWithAbort(5);
    concurrentOllamaCalls -= 1;
  })));
  if (
    peakConcurrentOllamaCalls !== OLLAMA_CLOUD_CONCURRENCY
    || ollamaCapacity.active !== 0
    || ollamaCapacity.waiters.length !== 0
    || runtime.activeOllamaRequests !== 0
    || runtime.queuedOllamaRequests !== 0
  ) {
    throw new Error("Ollama cloud route capacity failed");
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
      if (!["auto", "devin-free", "ollama"].includes(requestedRoute)) {
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
