#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  TaskStateError,
  activeTaskPromptSection,
  applyPatchSucceeded,
  authoritativeProgressReport,
  changedPathsFromApplyPatch,
  formatNativeToolProgress,
  isBridgeProgressReasoning,
  isExplicitReadOnlyTask,
  normalizeAgentMessageContent,
  referencedPriorTaskPromptSection,
  rzMcpToolNameFromNativeProgress,
  rzMcpModeForTask,
  taskControlPromptSections,
  taskDeliveryDiagnostics,
  taskStateFromInput,
} from "./codebuddy-subagent-task-state.mjs";
import { projectInstructionsPromptSection } from "./native-project-instructions.mjs";
import { providerFailureDiagnostics } from "./native-subagent-provider-router.mjs";

const PROVIDER_ID = "codebuddy";
const MODEL_ALIAS = "@preset/codex-subagents";
const MAIN_MODEL_ALIAS = "@preset/rzcodex-main";
const REQUIRED_AUTH_SOURCE = "www.codebuddy.ai";
const REQUIRED_EFFORT = "max";
const DEFAULT_PORT = 54547;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_PROMPT_CHARS = 120_000;
const MAX_ACTIVE_TASK_CHARS = 40_000;
const STDERR_LIMIT = 16 * 1024;
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
const ROUTE_OWNERSHIP_TIMEOUT_MS = 45_000;
const TEXT_TOOL_NAME = "tool_search";
const WIRE_TEXT_TOOL_NAME = "search_tools";
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const MODEL_ROUTES_FILE = join(CODEX_HOME, "subagent-models.json");
const REQUEST_DIRECTORY = join(CODEX_HOME, "codebuddy-bridge", "requests");
const SESSION_MARKER_DIRECTORY = join(CODEX_HOME, "codebuddy-bridge", "sessions");
const CODEBUDDY_HOME = join(homedir(), ".codebuddy");
const MANAGED_SESSION_PREFIX = "rzcodex-";
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_SCRIPT = join(SCRIPT_DIRECTORY, "devin-rzmcp-lazy-proxy.mjs");
const PROVIDER_MUTATION_TOOL = /^(?:Edit|Write|NotebookEdit)$/i;
const READ_ONLY_RZMCP_TOOL_NAME = /^(?:analyze|check|count|describe|discover|does|enumerate|find|get|has|inspect|is|list|locate|query|read|resolve|search|validate)_/i;
const CODEBUDDY_SCRIPT = join(
  process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
  "npm", "node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy",
);
const MAIN_AGENT_CONTRACT = "[RzCodex main-agent contract]\nAct as the primary coding agent for this conversation. Use CodeBuddy's own Read, Write, Edit, Bash, Glob, and Grep tools directly. Follow the complete RzCodex, project, and user instructions supplied this turn, preserve unrelated work, verify changes in proportion to risk, and return only after the current user request is complete or concretely blocked. RzMCP is exposed lazily as only search_rzmcp_tools and call_rzmcp_tool through the rzmcp MCP server; search first, then call the selected tool.";

class BridgeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
  }
}

function executionPolicy(taskState) {
  const task = taskState.activeTask?.text || "";
  const readOnly = taskState.activeTask?.intent === "analysis" || isExplicitReadOnlyTask(task);
  return {
    readOnly,
    rzMcpMode: rzMcpModeForTask(task, readOnly),
  };
}

function providerToolIsMutation(name, input, policy) {
  if (PROVIDER_MUTATION_TOOL.test(String(name || ""))) return true;
  if (String(name || "").toLowerCase() !== "mcp__rzmcp__call_rzmcp_tool") return false;
  if (policy?.rzMcpMode === "read-only") return false;
  const rzMcpToolName = typeof input?.name === "string" ? input.name : null;
  return rzMcpToolName === null || !READ_ONLY_RZMCP_TOOL_NAME.test(rzMcpToolName);
}

const runtime = {
  incomingRequests: 0,
  requests: 0,
  completed: 0,
  failed: 0,
  lastFailure: null,
  rejected: 0,
  lastRejectedError: null,
  lastModel: null,
  lastAuthSource: null,
  lastCostUsd: null,
  lastInputTokens: null,
  lastOutputTokens: null,
  lastDurationApiMs: null,
  lastMaxTurnInputTokens: null,
  lastIncomingCodexToolCount: null,
  lastCodexToolCount: null,
  lastCodexToolSchemaBytes: null,
  lastRetainedToolSurfaceUsed: false,
  retainedToolSurfaceUses: 0,
  maxObservedTurnInputTokens: 0,
  maxObservedCodexToolCount: 0,
  maxObservedCodexToolSchemaBytes: 0,
  lastWorkingDirectory: null,
  lastTaskId: null,
  lastTaskName: null,
  lastTaskHash: null,
  lastTaskIntent: null,
  lastTaskDeliveryMode: null,
  lastTaskPartTypes: [],
  lastTaskPartLengths: [],
  lastCompleteTaskDelivered: false,
  lastActiveTaskIncludedThisTurn: false,
  lastActiveTaskRetainedInProviderSession: false,
  lastToolCallsSinceTask: 0,
  lastSuccessfulMutationCount: 0,
  lastChangedPaths: [],
  lastCompletedTool: null,
  lastCheckpointRequested: false,
  lastProviderActivity: null,
  lastProviderActivityAt: null,
  lastProviderProgressEvents: 0,
  lastStreamedTextChars: 0,
  providerSilenceTimeouts: 0,
  lastProviderSilenceTimeoutAt: null,
  activeRequests: 0,
  staleRequestArtifactsCleaned: 0,
  activeProviderSessions: 0,
  providerSessionsStarted: 0,
  providerSessionResumes: 0,
  providerSessionsCleaned: 0,
  lastProviderSessionHash: null,
  lastProviderSessionResumed: false,
  lastInputItemCount: 0,
  lastDeltaItemCount: 0,
  lastPromptChars: 0,
  lastDeltaPromptChars: 0,
};

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeError(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new BridgeError(`${label} must be a non-empty string`);
  }
  return value;
}

function jsonString(value) {
  return JSON.stringify(value);
}

function redactSecrets(value) {
  return String(value)
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(sk|or)-[a-z0-9_-]{12,}\b/gi, "[REDACTED]");
}

function configuredPort() {
  const raw = process.env.CODEBUDDY_BRIDGE_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  if (!/^\d+$/.test(raw)) throw new Error(`CODEBUDDY_BRIDGE_PORT is invalid: ${JSON.stringify(raw)}`);
  const port = Number(raw);
  if (port < 1 || port > 65535) throw new Error(`CODEBUDDY_BRIDGE_PORT is out of range: ${port}`);
  return port;
}

function resolveRoute(requested) {
  if (requested !== MODEL_ALIAS && requested !== MAIN_MODEL_ALIAS) {
    throw new BridgeError(`CodeBuddy bridge must use the centrally managed ${MODEL_ALIAS} or ${MAIN_MODEL_ALIAS} alias`);
  }
  let routes;
  try {
    routes = JSON.parse(readFileSync(MODEL_ROUTES_FILE, "utf8"));
  } catch (error) {
    throw new BridgeError(`Subagent model routes are unreadable: ${error.message}`, 500);
  }
  const route = assertObject(routes[PROVIDER_ID], `${PROVIDER_ID} model route`);
  const model = requireString(route.model, `${PROVIDER_ID} model route.model`);
  if (!Array.isArray(route.inputModalities) || route.inputModalities.length === 0) {
    throw new BridgeError(`${PROVIDER_ID} model route.inputModalities must be a non-empty array`, 500);
  }
  const inputModalities = [...new Set(route.inputModalities.map((value, index) => {
    const modality = requireString(value, `${PROVIDER_ID} model route.inputModalities[${index}]`);
    if (!["text", "image"].includes(modality)) {
      throw new BridgeError(`Unsupported ${PROVIDER_ID} input modality ${JSON.stringify(modality)}`, 500);
    }
    return modality;
  }))];
  if (!inputModalities.includes("text")) {
    throw new BridgeError(`${PROVIDER_ID} model route must support text input`, 500);
  }
  return { model, inputModalities };
}

function workingDirectoryFrom(body) {
  const metadataCwd = body.client_metadata?.cwd;
  if (typeof metadataCwd === "string" && isAbsolute(metadataCwd) && existsSync(metadataCwd)) return metadataCwd;
  const candidates = [];
  const visit = (value) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/<cwd>([^<]+)<\/cwd>/gi)) candidates.push(match[1].trim());
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value && typeof value === "object") {
      for (const nested of Object.values(value)) visit(nested);
    }
  };
  visit(body.instructions);
  visit(body.input);
  const taggedCwd = candidates.filter((candidate) => isAbsolute(candidate) && existsSync(candidate)).at(-1);
  if (taggedCwd) return taggedCwd;
  throw new BridgeError("CodeBuddy request has no valid authoritative working directory");
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

function codeBuddyImage(item, label) {
  const value = typeof item.image_url === "string" ? item.image_url : item.image_url?.url;
  const imageUrl = requireString(value, `${label}.image_url`);
  if (/^data:image\/(?:jpeg|png|gif|webp);base64,/i.test(imageUrl)) {
    return { type: "input_image", image: imageUrl };
  }
  if (/^https?:\/\//i.test(imageUrl)) {
    return { type: "image", source: { type: "url", url: imageUrl } };
  }
  throw new BridgeError(`${label}.image_url must be a supported image data URL or HTTP(S) URL`);
}

function contentImages(value, label) {
  if (typeof value === "string") return [];
  if (!Array.isArray(value)) throw new BridgeError(`${label} must be a string or array`);
  const images = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = assertObject(value[index], `${label}[${index}]`);
    if (item.type === "input_image") images.push(codeBuddyImage(item, `${label}[${index}]`));
  }
  return images;
}

function rejectUnsupportedAudio(value, label) {
  if (typeof value === "string") return;
  if (!Array.isArray(value)) throw new BridgeError(`${label} must be a string or array`);
  for (let index = 0; index < value.length; index += 1) {
    const item = assertObject(value[index], `${label}[${index}]`);
    if (item.type === "input_audio") {
      throw new BridgeError("The managed CodeBuddy route does not support audio input", 500);
    }
  }
}

function outputText(value, label) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return jsonString(value);
  return value.map((entry, index) => {
    if (typeof entry === "string") return entry;
    const item = assertObject(entry, `${label}[${index}]`);
    if (["input_image", "input_audio", "encrypted_content"].includes(item.type)) return "";
    return typeof item.text === "string" ? item.text : jsonString(item);
  }).join("");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertManagedSessionId(sessionId) {
  if (
    typeof sessionId !== "string"
    || !sessionId.startsWith(MANAGED_SESSION_PREFIX)
    || !/^[a-z0-9-]+$/.test(sessionId)
  ) {
    throw new Error(`Refusing unmanaged CodeBuddy session cleanup: ${JSON.stringify(sessionId)}`);
  }
}

function removeWithin(root, target) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (!resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Refusing CodeBuddy cleanup outside ${resolvedRoot}: ${resolvedTarget}`);
  }
  if (!existsSync(resolvedTarget)) return false;
  rmSync(resolvedTarget, { recursive: true, force: true });
  return true;
}

function cleanupManagedSessionArtifacts(sessionId) {
  assertManagedSessionId(sessionId);
  let removed = false;
  const projectsRoot = join(CODEBUDDY_HOME, "projects");
  if (existsSync(projectsRoot)) {
    for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const projectRoot = join(projectsRoot, entry.name);
      removed = removeWithin(projectRoot, join(projectRoot, `${sessionId}.jsonl`)) || removed;
      removed = removeWithin(projectRoot, join(projectRoot, sessionId)) || removed;
    }
  }
  const fileHistoryRoot = join(CODEBUDDY_HOME, "file-history");
  removed = removeWithin(fileHistoryRoot, join(fileHistoryRoot, sessionId)) || removed;
  const marker = join(SESSION_MARKER_DIRECTORY, `${sessionId}.json`);
  removed = removeWithin(SESSION_MARKER_DIRECTORY, marker) || removed;
  runtime.providerSessionsCleaned += 1;
  return removed;
}

function cleanupCodeBuddyProcessArtifacts(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  for (const [root, name] of [
    [join(CODEBUDDY_HOME, "sessions"), `${pid}.json`],
    [join(CODEBUDDY_HOME, "traces"), String(pid)],
  ]) {
    try { removeWithin(root, join(root, name)); } catch (error) {
      process.stderr.write(`CodeBuddy process cleanup failed: ${redactSecrets(error.message)}\n`);
    }
  }
}

function writeManagedSessionMarker(sessionId, threadId) {
  assertManagedSessionId(sessionId);
  mkdirSync(SESSION_MARKER_DIRECTORY, { recursive: true });
  const marker = join(SESSION_MARKER_DIRECTORY, `${sessionId}.json`);
  if (existsSync(marker)) return;
  writeFileSync(marker, jsonString({
    sessionId,
    threadHash: sha256(threadId),
    createdAt: new Date().toISOString(),
  }), { encoding: "utf8", flag: "wx" });
}

function cleanupOrphanedManagedSessions() {
  if (!existsSync(SESSION_MARKER_DIRECTORY)) return;
  for (const entry of readdirSync(SESSION_MARKER_DIRECTORY, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const markerPath = join(SESSION_MARKER_DIRECTORY, entry.name);
    try {
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      cleanupManagedSessionArtifacts(marker.sessionId);
    } catch (error) {
      process.stderr.write(`CodeBuddy orphan cleanup failed for ${entry.name}: ${redactSecrets(error.message)}\n`);
    }
  }
}

function itemKeys(input) {
  const occurrences = new Map();
  return input.map((item) => {
    let identity;
    if (item && typeof item === "object" && typeof item.id === "string" && item.id) {
      identity = `${item.type}:id:${item.id}`;
    } else if (item && typeof item === "object" && typeof item.call_id === "string" && item.call_id) {
      identity = `${item.type}:call:${item.call_id}`;
    } else {
      identity = `${item?.type ?? "unknown"}:hash:${sha256(jsonString(item))}`;
    }
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return `${identity}:occurrence:${occurrence}`;
  });
}

function providerSessionId(threadId) {
  return `${MANAGED_SESSION_PREFIX}${sha256(threadId).slice(0, 16)}-${randomUUID().slice(0, 8)}`;
}

function emptyProgress() {
  return {
    toolCallsSinceTask: 0,
    successfulMutationCount: 0,
    changedPaths: [],
    lastCompletedTool: null,
  };
}

function inputShouldReachResumedProvider(item, message) {
  if (!item || typeof item !== "object") return false;
  if (item.type === "agent_message") return !message?.newTask;
  if (item.type === "message") return item.role === "user";
  return ["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(item.type);
}

class ProviderConversationRegistry {
  #states = new Map();

  prepare(threadId, input, incomingTaskState, { mainAgent = false } = {}) {
    if (typeof threadId !== "string" || threadId.length === 0) {
      throw new BridgeError("client_metadata.thread_id must be a non-empty string");
    }
    let state = this.#states.get(threadId);
    if (state?.inFlight) {
      throw new BridgeError(`CodeBuddy thread ${sha256(threadId)} already has an active turn`, 409);
    }
    const incomingTask = incomingTaskState.activeTask;
    if (!state) {
      if (!mainAgent && !incomingTask) {
        throw new BridgeError(
          "CodeBuddy received a subagent turn without an active NEW_TASK and has no retained provider session",
        );
      }
      state = {
        threadId,
        sessionId: providerSessionId(threadId),
        providerStarted: false,
        inFlight: false,
        inFlightDone: Promise.resolve(),
        finishInFlight: null,
        activeTask: null,
        checkpointRequested: false,
        immediateReturnRequested: false,
        progress: emptyProgress(),
        callNames: new Map(),
        countedCalls: new Set(),
        countedOutputs: new Set(),
        seenInputKeys: new Set(),
        toolInfo: null,
      };
      this.#states.set(threadId, state);
    }

    const continuesRetainedTask = Boolean(
      state.activeTask
      && incomingTaskState.referencedPriorTasks?.some((task) => task.hash === state.activeTask.hash),
    );
    const taskChanged = Boolean(
      incomingTask && incomingTask.hash !== state.activeTask?.hash,
    );
    if (!mainAgent && (!state.activeTask || taskChanged)) {
      if (!incomingTask) {
        throw new BridgeError("CodeBuddy provider state has no active task to retain", 500);
      }
      state.activeTask = {
        ...incomingTask,
        partTypes: [...incomingTask.partTypes],
        partLengths: [...incomingTask.partLengths],
      };
      state.checkpointRequested = incomingTaskState.checkpointRequested;
      state.immediateReturnRequested = incomingTaskState.immediateReturnRequested;
      state.progress = continuesRetainedTask
        ? {
            ...incomingTaskState.progress,
            changedPaths: [...incomingTaskState.progress.changedPaths],
          }
        : emptyProgress();
      state.callNames.clear();
      state.countedCalls.clear();
      state.countedOutputs.clear();
    }

    const keys = itemKeys(input);
    const messagesByIndex = new Map(incomingTaskState.messages.map((message) => [message.index, message]));
    const relevantStart = incomingTask && state.activeTask && incomingTask.hash === state.activeTask.hash
      ? incomingTask.index + 1
      : 0;

    for (const message of incomingTaskState.messages) {
      if (message.index < relevantStart || state.seenInputKeys.has(keys[message.index])) continue;
      state.checkpointRequested = message.intent === "analysis" && message.checkpoint;
      state.immediateReturnRequested = message.intent === "analysis" && message.immediateReturn;
    }

    for (let index = relevantStart; index < input.length; index += 1) {
      const item = input[index];
      if (!item || typeof item !== "object") continue;
      if (["function_call", "custom_tool_call", "tool_search_call"].includes(item.type)) {
        const name = item.type === "tool_search_call" ? TEXT_TOOL_NAME : item.name;
        if (typeof item.call_id === "string" && typeof name === "string") {
          state.callNames.set(item.call_id, name);
          if (!state.countedCalls.has(item.call_id)) {
            state.countedCalls.add(item.call_id);
            state.progress.toolCallsSinceTask += 1;
          }
        }
        continue;
      }
      if (!["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(item.type)) {
        continue;
      }
      if (typeof item.call_id !== "string" || state.countedOutputs.has(item.call_id)) continue;
      state.countedOutputs.add(item.call_id);
      const name = state.callNames.get(item.call_id);
      if (name) state.progress.lastCompletedTool = name;
      if (name !== "apply_patch") continue;
      const output = outputText(item.output, `input[${index}].output`);
      if (!applyPatchSucceeded(output)) continue;
      state.progress.successfulMutationCount += 1;
      state.progress.changedPaths = [...new Set([
        ...state.progress.changedPaths,
        ...changedPathsFromApplyPatch(output),
      ])];
    }

    const providerSessionStarted = state.providerStarted;
    const activeTaskIncludedThisTurn = !providerSessionStarted || taskChanged;
    const unseenIndexes = keys.flatMap((key, index) => (
      state.seenInputKeys.has(key) ? [] : [index]
    ));
    const inputIndexes = providerSessionStarted
      ? unseenIndexes.filter((index) => inputShouldReachResumedProvider(
        input[index],
        messagesByIndex.get(index),
      ))
      : input.map((_, index) => index);
    return {
      state,
      threadId,
      providerSessionId: state.sessionId,
      providerSessionStarted,
      activeTaskIncludedThisTurn,
      retainedInProviderSession: providerSessionStarted && !taskChanged,
      inputIndexes,
      inputKeys: keys,
      inputItemCount: input.length,
      deltaItemCount: inputIndexes.length,
      taskState: {
        activeTask: state.activeTask,
        referencedPriorTask: incomingTaskState.referencedPriorTask,
        referencedPriorTasks: incomingTaskState.referencedPriorTasks,
        referencedPriorControl: incomingTaskState.referencedPriorControl,
        checkpointRequested: state.checkpointRequested,
        immediateReturnRequested: state.immediateReturnRequested,
        messages: incomingTaskState.messages,
        progress: {
          ...state.progress,
          changedPaths: [...state.progress.changedPaths],
        },
      },
    };
  }

  begin(context) {
    const { state } = context.conversation;
    if (state.inFlight) throw new BridgeError("CodeBuddy provider session is already active", 409);
    state.inFlight = true;
    state.inFlightDone = new Promise((resolve) => { state.finishInFlight = resolve; });
    writeManagedSessionMarker(state.sessionId, state.threadId);
    runtime.activeProviderSessions = this.#states.size;
  }

  commit(context) {
    const conversation = context.conversation;
    const { state } = conversation;
    for (const key of conversation.inputKeys) state.seenInputKeys.add(key);
    state.providerStarted = true;
    state.inFlight = false;
    state.finishInFlight?.();
    state.finishInFlight = null;
    if (conversation.providerSessionStarted) runtime.providerSessionResumes += 1;
    else runtime.providerSessionsStarted += 1;
    runtime.activeProviderSessions = this.#states.size;
  }

  resetProvider(context) {
    const { state } = context.conversation;
    try { cleanupManagedSessionArtifacts(state.sessionId); } catch (error) {
      process.stderr.write(`CodeBuddy provider reset cleanup failed: ${redactSecrets(error.message)}\n`);
    }
    state.sessionId = providerSessionId(state.threadId);
    state.providerStarted = false;
    state.inFlight = false;
    state.finishInFlight?.();
    state.finishInFlight = null;
    state.seenInputKeys.clear();
    runtime.activeProviderSessions = this.#states.size;
  }

  release(context) {
    const { state } = context.conversation;
    try { cleanupManagedSessionArtifacts(state.sessionId); } catch (error) {
      process.stderr.write(`CodeBuddy terminal session cleanup failed: ${redactSecrets(error.message)}\n`);
    }
    state.inFlight = false;
    state.finishInFlight?.();
    state.finishInFlight = null;
    this.#states.delete(state.threadId);
    runtime.activeProviderSessions = this.#states.size;
  }

  get size() {
    return this.#states.size;
  }

  async waitForIdle(threadId, timeoutMs = 5_000) {
    const state = this.#states.get(threadId);
    if (!state?.inFlight) return;
    let timer;
    try {
      await Promise.race([
        state.inFlightDone,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new BridgeError("Prior CodeBuddy turn did not release its provider session after cancellation", 409)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

const providerConversations = new ProviderConversationRegistry();

function roleInstructionsFrom(value) {
  if (typeof value !== "string") return "";
  const matches = [...value.matchAll(
    /<(?:codebuddy|external_cli|cursor)_route_instructions>([\s\S]*?)<\/(?:codebuddy|external_cli|cursor)_route_instructions>/gi,
  )];
  return matches.at(-1)?.[1]?.trim() || "";
}

function safeWireName(namespace, name) {
  const original = namespace ? `${namespace}__${name}` : name;
  const safe = original.replace(/[^A-Za-z0-9_-]/g, "_");
  if (safe.length <= 64) return safe;
  const suffix = `__${createHash("sha256").update(original).digest("hex").slice(0, 12)}`;
  return `${safe.slice(0, 64 - suffix.length)}${suffix}`;
}

function toolLookupKey(namespace, name) {
  return `${namespace ?? ""}\u0000${name}`;
}

function codexToolsFrom(body, inputModalities) {
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw new BridgeError("tools must be an array");
  const definitions = [];
  const byWire = new Map();
  const byOriginal = new Map();
  const hosted = new Set();
  const add = (namespace, tool, label, toolSearch = false) => {
    const originalName = toolSearch ? TEXT_TOOL_NAME : requireString(tool.name, `${label}.name`);
    if (
      namespace === null
      && originalName === "view_image"
      && !inputModalities.includes("image")
    ) return;
    const wireName = toolSearch ? WIRE_TEXT_TOOL_NAME : safeWireName(namespace, originalName);
    const existing = byWire.get(wireName);
    if (existing) {
      if (existing.namespace === namespace && existing.originalName === originalName) return;
      throw new BridgeError(`Tool-name translation collided at ${JSON.stringify(wireName)}`);
    }
    const custom = tool.type === "custom";
    const inputSchema = custom ? {
      type: "object",
      properties: { input: { type: "string", description: "Complete free-form custom-tool input" } },
      required: ["input"],
      additionalProperties: false,
    } : assertObject(tool.parameters ?? tool.input_schema, `${label}.parameters`);
    const entry = { namespace, originalName, wireName, custom, toolSearch, inputSchema };
    const definition = {
      name: wireName,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema,
    };
    definitions.push(definition);
    byWire.set(wireName, entry);
    byOriginal.set(toolLookupKey(namespace, originalName), entry);
  };
  const visitTools = (tools, labelPrefix) => {
    for (let index = 0; index < tools.length; index += 1) {
      const tool = assertObject(tools[index], `${labelPrefix}[${index}]`);
      const label = `${labelPrefix}[${index}]`;
      if (tool.type === "web_search") {
        hosted.add("web_search");
        continue;
      }
      if (tool.type === "tool_search") {
        if (tool.execution !== undefined && tool.execution !== "client") throw new BridgeError(`${label}.execution must be client`);
        add(null, { ...tool, type: "function" }, label, true);
        continue;
      }
      if (tool.type === "function" || tool.type === "custom") {
        add(null, tool, label);
        continue;
      }
      if (tool.type !== "namespace") throw new BridgeError(`${label} has unsupported type ${JSON.stringify(tool.type)}`);
      const namespace = requireString(tool.name, `${label}.name`);
      if (!Array.isArray(tool.tools) || tool.tools.length === 0) throw new BridgeError(`${label}.tools must be non-empty`);
      for (let nestedIndex = 0; nestedIndex < tool.tools.length; nestedIndex += 1) {
        const nestedLabel = `${label}.tools[${nestedIndex}]`;
        const nested = assertObject(tool.tools[nestedIndex], nestedLabel);
        if (nested.type !== "function" && nested.type !== "custom") {
          throw new BridgeError(`${nestedLabel} has unsupported type ${JSON.stringify(nested.type)}`);
        }
        const description = [tool.description, nested.description]
          .filter((value) => typeof value === "string" && value).join("\n\n");
        add(namespace, { ...nested, ...(description ? { description } : {}) }, nestedLabel);
      }
    }
  };
  visitTools(body.tools ?? [], "tools");
  if (Array.isArray(body.input)) {
    for (let index = 0; index < body.input.length; index += 1) {
      const item = body.input[index];
      if (item?.type === "tool_search_output" && Array.isArray(item.tools)) {
        visitTools(item.tools, `input[${index}].tools`);
      }
    }
  }
  return { definitions, byWire, byOriginal, hosted };
}

function validateManagedToolSurface(toolInfo, inputModalities) {
  const requirements = [
    ["exec_command", (entry) => !entry.custom && !entry.toolSearch],
    ["write_stdin", (entry) => !entry.custom && !entry.toolSearch],
    ["apply_patch", (entry) => entry.custom && !entry.toolSearch],
    [TEXT_TOOL_NAME, (entry) => entry.toolSearch],
  ];
  if (inputModalities.includes("image")) {
    requirements.push(["view_image", (entry) => !entry.custom && !entry.toolSearch]);
  }
  const missing = requirements.filter(([name, matches]) => {
    const entry = toolInfo.byOriginal.get(toolLookupKey(null, name));
    return !entry || !matches(entry);
  }).map(([name]) => name);
  if (missing.length > 0) {
    throw new BridgeError(
      `RzCodex managed preset omitted required native capabilities: ${missing.join(", ")}`,
      500,
    );
  }
  if (
    inputModalities.includes("image")
    && !toolInfo.byOriginal.has(toolLookupKey(null, "view_image"))
  ) {
    throw new BridgeError(
      "RzCodex managed preset omitted required native capability: view_image",
      500,
    );
  }
}

function mergeRetainedToolInfo(retained, incoming) {
  const definitions = retained.definitions.map((definition) => ({ ...definition }));
  const definitionsByName = new Map(definitions.map((definition) => [definition.name, definition]));
  const byWire = new Map(retained.byWire);
  const byOriginal = new Map(retained.byOriginal);
  const hosted = new Set([...retained.hosted, ...incoming.hosted]);
  for (const [wireName, entry] of incoming.byWire) {
    const existing = byWire.get(wireName);
    if (existing) {
      const existingIdentity = jsonString({
        namespace: existing.namespace,
        originalName: existing.originalName,
        custom: existing.custom,
        toolSearch: existing.toolSearch,
        inputSchema: existing.inputSchema,
      });
      const incomingIdentity = jsonString({
        namespace: entry.namespace,
        originalName: entry.originalName,
        custom: entry.custom,
        toolSearch: entry.toolSearch,
        inputSchema: entry.inputSchema,
      });
      if (existingIdentity !== incomingIdentity) {
        throw new BridgeError(`Retained Codex tool ${JSON.stringify(wireName)} changed incompatibly`, 500);
      }
      continue;
    }
    const definition = incoming.definitions.find((candidate) => candidate.name === wireName);
    if (!definition) {
      throw new BridgeError(`Codex tool ${JSON.stringify(wireName)} has no provider definition`, 500);
    }
    if (definitionsByName.has(wireName)) {
      throw new BridgeError(`Codex tool ${JSON.stringify(wireName)} collided with a retained definition`, 500);
    }
    const retainedDefinition = { ...definition };
    definitions.push(retainedDefinition);
    definitionsByName.set(wireName, retainedDefinition);
    byWire.set(wireName, entry);
    byOriginal.set(toolLookupKey(entry.namespace, entry.originalName), entry);
  }
  return { definitions, byWire, byOriginal, hosted };
}

function promptFrom(body, registry = providerConversations) {
  assertObject(body, "request body");
  if (body.stream !== true) throw new BridgeError("The CodeBuddy bridge requires stream=true");
  const requestedModel = requireString(body.model, "model");
  const mainAgent = requestedModel === MAIN_MODEL_ALIAS;
  const route = resolveRoute(requestedModel);
  const requestedEffort = body.reasoning?.effort;
  if (requestedEffort !== undefined && requestedEffort !== REQUIRED_EFFORT) {
    throw new BridgeError(`CodeBuddy bridge requires reasoning effort ${REQUIRED_EFFORT}, got ${requestedEffort}`);
  }
  const input = typeof body.input === "string" ? [{ type: "message", role: "user", content: body.input }] : body.input;
  if (!Array.isArray(input)) throw new BridgeError("input must be a string or array");
  let incomingTaskState;
  try {
    incomingTaskState = taskStateFromInput(input, MAX_ACTIVE_TASK_CHARS);
  } catch (error) {
    if (error instanceof TaskStateError) throw new BridgeError(error.message);
    throw error;
  }
  const threadId = requireString(body.client_metadata?.thread_id, "client_metadata.thread_id");
  const conversation = registry.prepare(threadId, input, incomingTaskState, { mainAgent });
  const taskState = conversation.taskState;
  const incomingToolInfo = codexToolsFrom(body, route.inputModalities);
  const incomingManagedSurface = Array.isArray(body.tools) && body.tools.length > 0;
  const retainedToolSurfaceUsed = !incomingManagedSurface && conversation.state.toolInfo !== null;
  const toolInfo = retainedToolSurfaceUsed
    ? mergeRetainedToolInfo(conversation.state.toolInfo, incomingToolInfo)
    : incomingToolInfo;
  runtime.lastIncomingCodexToolCount = incomingToolInfo.definitions.length;
  runtime.lastRetainedToolSurfaceUsed = retainedToolSurfaceUsed;
  conversation.state.toolInfo = toolInfo;
  if (retainedToolSurfaceUsed) runtime.retainedToolSurfaceUses += 1;
  const workingDirectory = workingDirectoryFrom(body);
  if (!isAbsolute(workingDirectory) || !existsSync(workingDirectory)) {
    throw new BridgeError(`CodeBuddy working directory does not exist: ${JSON.stringify(workingDirectory)}`);
  }
  const sections = [
    mainAgent
      ? (conversation.providerSessionStarted
        ? "[RzCodex main-agent continuation]\nContinue this conversation as the primary coding agent. Use your own local tools directly and return only when the current user request is complete or concretely blocked."
        : MAIN_AGENT_CONTRACT)
      : (conversation.providerSessionStarted
        ? "[Native delegation continuation]\nContinue the same delegated task in this retained CodeBuddy conversation. Use your own local tools directly and return only when the bounded task is complete, the requested checkpoint is ready, or a concrete blocker requires parent input. Never delegate to another agent, teammate, swarm, or background worker."
        : "[Single native-agent execution contract]\nWork as the delegated CodeBuddy sub-agent in the current workspace and complete this bounded task in this one CLI execution. Use CodeBuddy's own Read, Write, Edit, Bash, Glob, and Grep tools directly. Never delegate to another agent, teammate, swarm, or background worker. Do not ask the parent to execute an ordinary file or shell operation. Honor project AGENTS.md ownership boundaries exactly; when builds, tests, editor control, PIE, runtime validation, or RzMCP execution are reserved to the parent, do not invoke them and instead report the exact checks the parent should run. On Windows, use PowerShell-native commands and never assume Unix-only commands such as head are installed. RzMCP is exposed lazily as only search_rzmcp_tools and call_rzmcp_tool through the rzmcp MCP server; search first, then call the selected tool only when the task allows RzMCP."),
  ];
  if (!conversation.providerSessionStarted) {
    sections.push(projectInstructionsPromptSection(workingDirectory));
  }
  if (mainAgent) {
    if (typeof body.instructions === "string" && body.instructions.trim() && !conversation.providerSessionStarted) {
      sections.push(`[RzCodex instructions]\n${body.instructions.trim()}`);
    }
  } else {
    const roleInstructions = roleInstructionsFrom(body.instructions);
    if (roleInstructions && !conversation.providerSessionStarted) {
      sections.push(`[Role instructions]\n${roleInstructions}`);
    }
  }
  const activeTaskSection = !mainAgent && conversation.activeTaskIncludedThisTurn
    ? activeTaskPromptSection(taskState)
    : "";
  const referencedPriorTaskSection = !mainAgent && !conversation.providerSessionStarted
    ? referencedPriorTaskPromptSection(taskState)
    : "";
  if (referencedPriorTaskSection) sections.push(referencedPriorTaskSection);
  if (activeTaskSection) sections.push(activeTaskSection);
  if (!mainAgent) sections.push(...taskControlPromptSections(taskState));
  if (toolInfo.definitions.length > 0) {
    sections.push(
      `[Codex client tool surface intentionally internalized]\n${toolInfo.definitions.length} parent tool schemas were not forwarded. ` +
      "Use CodeBuddy's native tools instead; RzMCP remains available only through its two lazy proxy tools.",
    );
  }
  if (toolInfo.hosted.has("web_search")) {
    sections.push("[Provider-native tools mapped this turn]\nweb_search -> CodeBuddy WebSearch");
  }
  const history = [];
  const agentMessages = new Map(taskState.messages.map((message) => [message.index, message]));
  const pushHistory = (text, images = []) => {
    if (text || images.length > 0) history.push({ text, images });
  };
  for (const index of conversation.inputIndexes) {
    const item = assertObject(input[index], `input[${index}]`);
    const label = `input[${index}]`;
    if (item.type === "message") {
      const role = requireString(item.role, `${label}.role`);
      if (role !== "system" && role !== "developer") {
        rejectUnsupportedAudio(item.content, `${label}.content`);
        const text = contentText(item.content, `${label}.content`);
        const images = contentImages(item.content, `${label}.content`);
        pushHistory(`[${role}]\n${text || "[Image input]"}`, images);
      }
    } else if (item.type === "agent_message") {
      const message = agentMessages.get(index) ?? {
        ...normalizeAgentMessageContent(item.content, `${label}.content`),
        author: typeof item.author === "string" ? item.author : "Codex",
        recipient: typeof item.recipient === "string" ? item.recipient : "CodeBuddy worker",
        newTask: false,
        checkpoint: false,
      };
      if (message.newTask) continue;
      if (referencedPriorTaskSection && message.index === taskState.referencedPriorControl?.index) continue;
      pushHistory(`[Inter-agent message ${message.author} -> ${message.recipient}]\n${message.text}`);
    } else if (item.type === "reasoning") {
      if (isBridgeProgressReasoning(item)) continue;
      const summary = Array.isArray(item.summary)
        ? item.summary.filter((part) => part?.type === "summary_text" && typeof part.text === "string")
          .map((part) => part.text).join("") : "";
      if (summary) pushHistory(`[Prior reasoning summary]\n${summary}`);
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      const namespace = typeof item.namespace === "string" ? `${item.namespace}.` : "";
      const name = requireString(item.name, `${label}.name`);
      const callId = requireString(item.call_id, `${label}.call_id`);
      const inputValue = item.type === "custom_tool_call" ? item.input : item.arguments;
      pushHistory(`[Assistant requested client tool ${namespace}${name}; call_id=${callId}]\n${typeof inputValue === "string" ? inputValue : jsonString(inputValue)}`);
    } else if (item.type === "tool_search_call") {
      const callId = requireString(item.call_id, `${label}.call_id`);
      pushHistory(`[Assistant requested Codex tool search; call_id=${callId}]\n${jsonString(item.arguments ?? {})}`);
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const callId = requireString(item.call_id, `${label}.call_id`);
      rejectUnsupportedAudio(item.output, `${label}.output`);
      const text = outputText(item.output, `${label}.output`);
      const images = contentImages(item.output, `${label}.output`);
      pushHistory(`[Codex client tool result; call_id=${callId}]\n${text || "[Image output]"}`, images);
    } else if (item.type === "tool_search_output") {
      const callId = requireString(item.call_id, `${label}.call_id`);
      const names = [];
      if (Array.isArray(item.tools)) {
        for (const tool of item.tools) {
          if (!tool || typeof tool !== "object" || typeof tool.name !== "string") continue;
          if (tool.type === "namespace" && Array.isArray(tool.tools)) {
            for (const nested of tool.tools) {
              if (nested && typeof nested.name === "string") names.push(`${tool.name}.${nested.name}`);
            }
          } else {
            names.push(tool.name);
          }
        }
      }
      pushHistory(`[Codex tool search result; call_id=${callId}]\n${names.length} tools discovered: ${names.join(", ")}`);
    } else if (["compaction", "context_compaction", "compaction_trigger"].includes(item.type)) {
      // Codex compaction payloads are provider-opaque. The portable history remains authoritative.
    } else {
      throw new BridgeError(`${label} has unsupported input type ${JSON.stringify(item.type)}`);
    }
  }
  const mandatoryChars = sections.reduce((sum, section) => sum + section.length, 0)
    + Math.max(0, sections.length - 1) * 2;
  if (mandatoryChars > MAX_PROMPT_CHARS) {
    throw new BridgeError("CodeBuddy mandatory task context exceeded its hard prompt limit", 400);
  }
  let remainingChars = MAX_PROMPT_CHARS - mandatoryChars;
  const retained = [];
  const images = [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const section = history[index];
    const separatorChars = sections.length > 0 || retained.length > 0 ? 2 : 0;
    const textBudget = remainingChars - separatorChars;
    if (textBudget <= 0) break;
    const retainedText = section.text.length > textBudget
      ? section.text.slice(-textBudget)
      : section.text;
    retained.unshift(retainedText);
    images.unshift(...section.images);
    remainingChars -= retainedText.length + separatorChars;
    if (retainedText.length < section.text.length) break;
  }
  sections.push(...retained);
  const prompt = sections.join("\n\n");
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new BridgeError("CodeBuddy normalized prompt exceeded its hard limit", 500);
  }
  if (
    !mainAgent
    && conversation.providerSessionStarted
    && !conversation.activeTaskIncludedThisTurn
    && conversation.inputIndexes.length === 0
  ) {
    throw new BridgeError(
      `CodeBuddy resumed task ${taskState.activeTask.id} without a new client result or control message`,
    );
  }
  let taskDiagnostics;
  try {
    taskDiagnostics = mainAgent
      ? { taskId: null, taskName: null, taskHash: null, taskIntent: null, taskDeliveryMode: null, taskPartTypes: [], taskPartLengths: [], completeTaskDelivered: true, activeTaskIncludedThisTurn: true, retainedInProviderSession: conversation.providerSessionStarted }
      : taskDeliveryDiagnostics(taskState, prompt, {
          activeTaskIncludedThisTurn: conversation.activeTaskIncludedThisTurn,
          retainedInProviderSession: conversation.retainedInProviderSession,
        });
  } catch (error) {
    if (error instanceof TaskStateError) throw new BridgeError(error.message);
    throw error;
  }
  if (images.length > 0 && !route.inputModalities.includes("image")) {
    throw new BridgeError("The managed CodeBuddy route does not support image input", 500);
  }
  return {
    model: route.model,
    prompt,
    images,
    workingDirectory,
    toolInfo,
    taskState,
    taskDiagnostics,
    conversation,
    threadId,
    mainAgent,
    providerSessionId: conversation.providerSessionId,
    providerSessionStarted: conversation.providerSessionStarted,
    incomingCodexToolCount: incomingToolInfo.definitions.length,
    retainedToolSurfaceUsed,
    executionPolicy: mainAgent
      ? { readOnly: false, rzMcpMode: "full" }
      : executionPolicy(taskState),
  };
}

function requestArtifacts(context) {
  mkdirSync(REQUEST_DIRECTORY, { recursive: true });
  const requestId = randomUUID();
  const configPath = join(REQUEST_DIRECTORY, `${requestId}-mcp.json`);
  const mcpConfig = {
    mcpServers: context.executionPolicy.rzMcpMode === "disabled"
      ? {}
      : { rzmcp: { command: process.execPath, args: [MCP_SERVER_SCRIPT] } },
  };
  writeFileSync(configPath, jsonString(mcpConfig), { encoding: "utf8", flag: "wx" });
  return {
    mcpConfig: configPath,
    cleanup: () => {
      for (const path of [configPath]) {
        try { unlinkSync(path); } catch (error) {
          if (error?.code !== "ENOENT") process.stderr.write(`CodeBuddy request cleanup failed: ${redactSecrets(error.message)}\n`);
        }
      }
    },
  };
}

function cleanupStaleRequestArtifacts() {
  mkdirSync(REQUEST_DIRECTORY, { recursive: true });
  const generatedRequestArtifact = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(?:mcp|tools)\.json$/i;
  let cleaned = 0;
  for (const entry of readdirSync(REQUEST_DIRECTORY, { withFileTypes: true })) {
    if (!entry.isFile() || !generatedRequestArtifact.test(entry.name)) continue;
    unlinkSync(join(REQUEST_DIRECTORY, entry.name));
    cleaned += 1;
  }
  runtime.staleRequestArtifactsCleaned += cleaned;
  return cleaned;
}

function sanitizedEnvironment(context) {
  const env = { ...process.env };
  for (const key of [
    "OPENROUTER_API_KEY", "TENCENT_API_KEY", "TENCENTCLOUD_SECRET_ID",
    "TENCENTCLOUD_SECRET_KEY", "CODEBUDDY_API_KEY",
  ]) delete env[key];
  if (context?.executionPolicy?.rzMcpMode) {
    env.RZCODEX_SUBAGENT_RZMCP_MODE = context.executionPolicy.rzMcpMode;
  }
  return env;
}

function validateInit(context, initEvent) {
  if (!initEvent) throw new BridgeError("CodeBuddy completed without an init event", 502);
  if (initEvent.model !== context.model) throw new BridgeError(`CodeBuddy initialized unexpected model ${JSON.stringify(initEvent.model)}`, 502);
  if (initEvent.apiKeySource !== REQUIRED_AUTH_SOURCE) throw new BridgeError(`CodeBuddy used unexpected auth source ${JSON.stringify(initEvent.apiKeySource)}`, 502);
  const initializedSessionId = initEvent.session_id ?? initEvent.sessionId;
  if (initializedSessionId !== context.providerSessionId) {
    throw new BridgeError(
      `CodeBuddy initialized unexpected session ${JSON.stringify(initializedSessionId)}`,
      502,
    );
  }
}

function validateResult(context, initEvent, resultEvent) {
  validateInit(context, initEvent);
  if (!resultEvent || resultEvent.subtype !== "success" || resultEvent.is_error === true) {
    const errors = Array.isArray(resultEvent?.errors)
      ? resultEvent.errors.map((error) => typeof error === "string" ? error : jsonString(error))
      : [];
    const detail = [resultEvent?.result, ...errors].find((value) => typeof value === "string" && value.trim());
    throw new BridgeError(`CodeBuddy failed: ${detail || "no successful result event"}`, 502);
  }
  if (resultEvent.total_cost_usd !== 0) {
    throw new BridgeError(`CodeBuddy reported a non-zero or unknown explicit cost: ${JSON.stringify(resultEvent.total_cost_usd)}`, 502);
  }
  const usedModels = Object.keys(resultEvent.modelUsage || {});
  if (usedModels.length !== 1 || usedModels[0] !== context.model) {
    throw new BridgeError(`CodeBuddy model usage indicates fallback: ${JSON.stringify(usedModels)}`, 502);
  }
}

function providerCompletionReport(providerText, resultEvent, calls) {
  if (calls.length > 0) {
    throw new BridgeError("CodeBuddy attempted an unavailable Codex parent tool", 502);
  }
  const resultText = typeof resultEvent?.result === "string" && resultEvent.result.trim()
    ? resultEvent.result
    : typeof providerText === "string" ? providerText : "";
  if (!resultText.trim()) throw new BridgeError("CodeBuddy completed without assistant output", 502);
  return resultText.trim();
}

function providerToolCall(part, context) {
  const deferred = part.name === "DeferExecuteTool";
  const providerName = deferred ? part.input?.toolName : part.name;
  const prefix = "mcp__codex__";
  if (typeof providerName !== "string" || !providerName.startsWith(prefix)) return null;
  const wireName = providerName.slice(prefix.length);
  const entry = context.toolInfo.byWire.get(wireName);
  if (!entry) throw new BridgeError(`CodeBuddy called unknown Codex client tool ${JSON.stringify(wireName)}`, 502);
  const rawInput = deferred ? part.input?.params : part.input;
  const args = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput : {};
  return { callId: typeof part.id === "string" ? part.id : `call_${randomUUID()}`, entry, args };
}

function providerToolCallKey(call) {
  return `${toolLookupKey(call.entry.namespace, call.entry.originalName)}\u0000${jsonString(call.args)}`;
}

function codeBuddyArguments(context, mcpConfig) {
  const tools = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "ToolSearch", "DeferExecuteTool"];
  if (context.toolInfo.hosted.has("web_search")) tools.push("WebSearch");
  const sessionArguments = context.providerSessionStarted
    ? ["--resume", context.providerSessionId]
    : ["--session-id", context.providerSessionId];
  return [
    CODEBUDDY_SCRIPT,
    "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages",
    "--dangerously-skip-permissions", "--tools", tools.join(","),
    "--disallowedTools", "Agent", "Task", "TaskCreate", "TaskUpdate", "TaskList", "SendMessage",
    "--model", context.model, "--effort", REQUIRED_EFFORT,
    "--mcp-config", mcpConfig, "--strict-mcp-config", ...sessionArguments,
  ];
}

function codeBuddyInput(prompt, images = []) {
  return `${jsonString({
    type: "user",
    message: { role: "user", content: [{ type: "input_text", text: prompt }, ...images] },
  })}\n`;
}

function providerVisibleTextDelta(event) {
  const providerEvent = event?.type === "stream_event" ? event.event : null;
  if (
    providerEvent?.type !== "content_block_delta"
    || providerEvent.delta?.type !== "text_delta"
    || typeof providerEvent.delta.text !== "string"
  ) return null;
  return providerEvent.delta.text;
}

function providerToolWorkStarted(nativeToolNames) {
  return Array.isArray(nativeToolNames) && nativeToolNames.length > 0;
}

function providerResponseErrorCode(error) {
  return providerToolWorkStarted(error?.nativeToolNames)
    ? "provider_state_changed"
    : "external_provider_error";
}

function runCodeBuddy(context, onSpawn, onProviderEvent = () => {}) {
  if (!existsSync(CODEBUDDY_SCRIPT)) throw new BridgeError(`CodeBuddy CLI is not installed at ${CODEBUDDY_SCRIPT}`, 502);
  if (!existsSync(MCP_SERVER_SCRIPT)) throw new BridgeError(`Codex tool MCP adapter is missing at ${MCP_SERVER_SCRIPT}`, 502);
  const artifacts = requestArtifacts(context);
  const args = codeBuddyArguments(context, artifacts.mcpConfig);
  const child = spawn(process.execPath, args, {
    cwd: context.workingDirectory,
    env: sanitizedEnvironment(context),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  onSpawn(child);
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = "";
    let stderr = "";
    let finalText = "";
    let initEvent = null;
    let resultEvent = null;
    let maxTurnInputTokens = 0;
    const routeOwnershipDeadline = Date.now() + ROUTE_OWNERSHIP_TIMEOUT_MS;
    let requestTimer = null;
    let silenceTimer = null;
    const calls = new Map();
    const nativeToolNames = [];
    const nativeRzMcpTools = [];
    const nativeChangedPaths = [];
    const nativeToolIds = new Set();
    let nativeMutationCount = 0;
    let providerActivityObserved = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(requestTimer);
      clearInterval(silenceTimer);
      artifacts.cleanup();
      if (error) {
        error.nativeToolNames = [...nativeToolNames];
        error.nativeRzMcpTools = [...new Set(nativeRzMcpTools)];
        error.providerMutationCount = nativeMutationCount;
      }
      error ? reject(error) : resolve(value);
    };
    const parseLine = (line) => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch {
        stderr = `${stderr}${line}\n`.slice(-STDERR_LIMIT);
        return;
      }
      if (event.type === "system" && event.subtype === "init") {
        try { validateInit(context, event); } catch (error) { child.kill(); finish(error); return; }
        initEvent = event;
      }
      if ((event.type === "stream_event" || event.type === "assistant") && !initEvent) {
        child.kill();
        finish(new BridgeError("CodeBuddy emitted model output before authenticated initialization", 502));
        return;
      }
      if (event.type === "stream_event" || event.type === "assistant") {
        providerActivityObserved = true;
      }
      try { onProviderEvent(event); } catch (error) { child.kill(); finish(error); return; }
      if (event.type === "assistant" && Array.isArray(event.message?.content)) {
        const turnInput = event.message?.usage?.input_tokens;
        if (Number.isInteger(turnInput)) maxTurnInputTokens = Math.max(maxTurnInputTokens, turnInput);
        const text = event.message.content
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text).join("");
        if (text && !text.includes("DEFERRED_TO_CODEX_CLIENT")) finalText = text;
        for (const part of event.message.content.filter((item) => item?.type === "tool_use")) {
          const nativeToolId = typeof part.id === "string"
            ? part.id
            : `${part.name || "unknown"}:${jsonString(part.input || {})}`;
          if (typeof part.name === "string" && !nativeToolIds.has(nativeToolId)) {
            nativeToolIds.add(nativeToolId);
            nativeToolNames.push(part.name);
            const rzMcpTool = rzMcpToolNameFromNativeProgress(part.name, part.input);
            if (rzMcpTool) nativeRzMcpTools.push(rzMcpTool);
            if (providerToolIsMutation(part.name, part.input, context.executionPolicy)) {
              nativeMutationCount += 1;
              const changedPath = part.input?.file_path ?? part.input?.filePath ?? part.input?.path;
              if (typeof changedPath === "string" && changedPath) nativeChangedPaths.push(changedPath);
            }
          }
          const call = providerToolCall(part, context);
          if (call) {
            const callKey = providerToolCallKey(call);
            if (!calls.has(callKey)) calls.set(callKey, call);
          }
        }
      }
      if (event.type === "result") resultEvent = event;
    };
    requestTimer = setTimeout(() => {
      child.kill();
      finish(new BridgeError(`CodeBuddy exceeded ${REQUEST_TIMEOUT_MS}ms`, 504));
    }, REQUEST_TIMEOUT_MS);
    silenceTimer = setInterval(() => {
      if (providerActivityObserved || providerToolWorkStarted(nativeToolNames)) {
        clearInterval(silenceTimer);
        return;
      }
      if (Date.now() < routeOwnershipDeadline) return;
      runtime.providerSilenceTimeouts += 1;
      runtime.lastProviderSilenceTimeoutAt = Date.now();
      child.kill();
      finish(new BridgeError(
        `CodeBuddy did not begin provider tool work within ${ROUTE_OWNERSHIP_TIMEOUT_MS}ms`,
        504,
      ));
    }, 1_000);
    silenceTimer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        parseLine(stdoutBuffer.slice(0, newline));
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-STDERR_LIMIT);
    });
    child.stdin.on("error", (error) => {
      if (error?.code !== "EPIPE") finish(new BridgeError(`CodeBuddy stdin failed: ${error.message}`, 502));
    });
    child.once("error", (error) => finish(new BridgeError(`CodeBuddy failed to start: ${error.message}`, 502)));
    child.once("close", (code, signal) => {
      cleanupCodeBuddyProcessArtifacts(child.pid);
      parseLine(stdoutBuffer);
      if (code !== 0) {
        const detail = stderr.trim() ? `: ${redactSecrets(stderr.trim())}` : "";
        finish(new BridgeError(`CodeBuddy exited with ${signal ? `signal ${signal}` : `code ${code}`}${detail}`, 502));
        return;
      }
      try { validateResult(context, initEvent, resultEvent); } catch (error) { finish(error); return; }
      if (!finalText && calls.size === 0) {
        finish(new BridgeError("CodeBuddy completed without assistant output or a Codex client tool call", 502));
        return;
      }
      finish(undefined, {
        finalText: calls.size > 0 ? "" : finalText,
        calls: [...calls.values()],
        initEvent,
        resultEvent,
        maxTurnInputTokens,
        nativeToolNames,
        nativeRzMcpTools: [...new Set(nativeRzMcpTools)],
        nativeChangedPaths: [...new Set(nativeChangedPaths)],
        mutationCount: nativeMutationCount,
      });
    });
    child.stdin.end(codeBuddyInput(context.prompt, context.images));
  });
}

function responseMessageItem(id, text, status = "in_progress") {
  return { type: "message", id, status, role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
}

function codexToolServingMetadata(lazyRzMcpProxyTools) {
  return {
    codex_tool_schema_bytes_forwarded: 0,
    codex_client_tool_schema_bytes_forwarded: 0,
    lazy_rzmcp_proxy_tools: lazyRzMcpProxyTools,
  };
}

function usageFrom(result) {
  const usage = result.usage || {};
  const inputTokens = Number.isInteger(usage.input_tokens) ? usage.input_tokens : 0;
  const outputTokens = Number.isInteger(usage.output_tokens) ? usage.output_tokens : 0;
  const cachedTokens = Number.isInteger(usage.cache_read_input_tokens) ? usage.cache_read_input_tokens : 0;
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: cachedTokens },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inputTokens + outputTokens,
  };
}

function callItem(call) {
  const { entry, args, callId } = call;
  if (entry.toolSearch) return { type: "tool_search_call", call_id: callId, execution: "client", arguments: args };
  if (entry.custom) {
    return {
      type: "custom_tool_call", id: `ct_${callId}`, call_id: callId, name: entry.originalName,
      ...(entry.namespace ? { namespace: entry.namespace } : {}),
      input: typeof args.input === "string" ? args.input : jsonString(args),
    };
  }
  return {
    type: "function_call", id: `fc_${callId}`, call_id: callId, name: entry.originalName,
    ...(entry.namespace ? { namespace: entry.namespace } : {}), arguments: jsonString(args),
  };
}

function writeSse(response, type, payload) {
  if (response.destroyed || response.writableEnded) return false;
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  return true;
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

function jsonResponse(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function managedModelsResponse() {
  const route = resolveRoute(MODEL_ALIAS);
  const baseModel = {
    display_name: "Managed native subagent",
    description: "Centrally managed native subagent route",
    base_instructions: "You are a delegated coding sub-agent. Follow the supplied role and task instructions, use the available tools when needed, verify your work, and report concise evidence to the parent agent.",
    default_reasoning_level: REQUIRED_EFFORT,
    supported_reasoning_levels: [{ effort: REQUIRED_EFFORT, description: "Maximum" }],
    shell_type: "unified_exec",
    visibility: "none",
    supported_in_api: true,
    priority: 0,
    availability_nux: null,
    upgrade: null,
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
    supports_reasoning_summary_parameter: false,
    default_reasoning_summary: "none",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text",
    truncation_policy: { mode: "tokens", limit: 10_000 },
    supports_image_detail_original: false,
    context_window: 131_072,
    max_context_window: 131_072,
    experimental_supported_tools: [],
    input_modalities: route.inputModalities,
    supports_search_tool: true,
    use_responses_lite: false,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
    tool_mode: "direct",
    multi_agent_version: "v2",
  };
  return {
    models: [
      { ...baseModel, slug: MODEL_ALIAS },
      {
        ...baseModel,
        slug: MAIN_MODEL_ALIAS,
        display_name: "RzCodex main agent (CodeBuddy)",
        description: "CodeBuddy Hy4 Preview as the primary main-agent provider",
        base_instructions: "You are the primary coding agent. Follow the supplied RzCodex and project instructions, use the available tools, verify your work, and complete the current request.",
        visibility: "visible",
        include_plugin_usage_instructions: true,
        include_apps_usage_instructions: true,
      },
    ],
  };
}

async function handleResponses(request, response) {
  const requestBody = await readJsonRequest(request);
  const threadId = requireString(requestBody.client_metadata?.thread_id, "client_metadata.thread_id");
  await providerConversations.waitForIdle(threadId);
  const context = promptFrom(requestBody);
  providerConversations.begin(context);
  runtime.activeRequests += 1;
  runtime.requests += 1;
  runtime.lastWorkingDirectory = context.workingDirectory;
  runtime.lastCodexToolCount = context.toolInfo.definitions.length;
  runtime.lastCodexToolSchemaBytes = Buffer.byteLength(jsonString(context.toolInfo.definitions));
  runtime.maxObservedCodexToolCount = Math.max(runtime.maxObservedCodexToolCount, runtime.lastCodexToolCount);
  runtime.maxObservedCodexToolSchemaBytes = Math.max(runtime.maxObservedCodexToolSchemaBytes, runtime.lastCodexToolSchemaBytes);
  runtime.lastTaskId = context.taskDiagnostics.taskId;
  runtime.lastTaskName = context.taskDiagnostics.taskName;
  runtime.lastTaskHash = context.taskDiagnostics.taskHash;
  runtime.lastTaskIntent = context.taskDiagnostics.taskIntent;
  runtime.lastTaskDeliveryMode = context.taskDiagnostics.taskDeliveryMode;
  runtime.lastTaskPartTypes = context.taskDiagnostics.taskPartTypes;
  runtime.lastTaskPartLengths = context.taskDiagnostics.taskPartLengths;
  runtime.lastCompleteTaskDelivered = context.taskDiagnostics.completeTaskDelivered;
  runtime.lastActiveTaskIncludedThisTurn = context.taskDiagnostics.activeTaskIncludedThisTurn;
  runtime.lastActiveTaskRetainedInProviderSession = context.taskDiagnostics.retainedInProviderSession;
  runtime.lastToolCallsSinceTask = context.taskState.progress.toolCallsSinceTask;
  runtime.lastSuccessfulMutationCount = context.taskState.progress.successfulMutationCount;
  runtime.lastChangedPaths = context.taskState.progress.changedPaths;
  runtime.lastCompletedTool = context.taskState.progress.lastCompletedTool;
  runtime.lastCheckpointRequested = context.taskState.checkpointRequested;
  runtime.lastProviderActivity = null;
  runtime.lastProviderActivityAt = null;
  runtime.lastProviderProgressEvents = 0;
  runtime.lastStreamedTextChars = 0;
  runtime.lastFailure = null;
  runtime.lastProviderSessionHash = sha256(context.providerSessionId);
  runtime.lastProviderSessionResumed = context.providerSessionStarted;
  runtime.lastInputItemCount = context.conversation.inputItemCount;
  runtime.lastDeltaItemCount = context.conversation.deltaItemCount;
  runtime.lastPromptChars = context.prompt.length;
  runtime.lastDeltaPromptChars = context.providerSessionStarted ? context.prompt.length : 0;
  let child = null;
  let clientGone = false;
  let conversationReleased = false;
  const abort = () => { clientGone = true; if (child && !child.killed) child.kill(); };
  request.once("aborted", abort);
  response.once("close", () => { if (!response.writableEnded) abort(); });
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive",
  });
  const responseId = `resp_${randomUUID()}`;
  writeSse(response, "response.created", { response: { id: responseId, object: "response", model: context.model, status: "in_progress" } });
  const progressItems = [];
  let nativeProgressTools = 0;
  const pendingNativeProgressTools = new Map();
  const completedNativeProgressToolIds = new Set();
  const emitProgress = (delta) => {
    if (!delta || clientGone) return;
    const progressItemId = `progress_${randomUUID()}`;
    const outputIndex = progressItems.length;
    writeSse(response, "response.output_item.added", {
      output_index: outputIndex,
      item: { type: "reasoning", id: progressItemId, status: "in_progress", summary: [] },
    });
    writeSse(response, "response.reasoning_summary_text.delta", {
      item_id: progressItemId,
      output_index: outputIndex,
      summary_index: 0,
      delta,
    });
    const item = {
      type: "reasoning",
      id: progressItemId,
      status: "completed",
      summary: [{ type: "summary_text", text: delta }],
    };
    writeSse(response, "response.reasoning_summary_text.done", {
      item_id: progressItemId,
      output_index: outputIndex,
      summary_index: 0,
      text: delta,
    });
    writeSse(response, "response.output_item.done", { output_index: outputIndex, item });
    progressItems.push(item);
  };
  const finishProgress = () => [...progressItems];
  let streamedMessageId = null;
  let streamedText = "";
  let lastProgressAt = 0;
  const emitText = (text) => {
    if (!text || clientGone) return;
    if (!streamedMessageId) {
      streamedMessageId = `msg_${randomUUID()}`;
      writeSse(response, "response.output_item.added", {
        output_index: 0,
        item: responseMessageItem(streamedMessageId, ""),
      });
      writeSse(response, "response.content_part.added", {
        item_id: streamedMessageId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
    streamedText += text;
    runtime.lastStreamedTextChars = streamedText.length;
    writeSse(response, "response.output_text.delta", {
      item_id: streamedMessageId,
      output_index: 0,
      content_index: 0,
      delta: text,
    });
  };
  const completeNativeProgressTool = (toolId) => {
    if (!toolId || completedNativeProgressToolIds.has(toolId)) return;
    const tool = pendingNativeProgressTools.get(toolId);
    if (!tool) return;
    pendingNativeProgressTools.delete(toolId);
    completedNativeProgressToolIds.add(toolId);
    nativeProgressTools += 1;
    emitProgress(formatNativeToolProgress("CodeBuddy", nativeProgressTools, tool.name, tool.input));
  };
  const onProviderEvent = (event) => {
    if (event?.type === "assistant" && Array.isArray(event.message?.content)) {
      const nativeTools = event.message.content.filter((part) => part?.type === "tool_use" && typeof part.name === "string");
      if (nativeTools.length > 0) {
        const now = Date.now();
        runtime.lastProviderActivity = `native_tool:${nativeTools.at(-1).name}`;
        runtime.lastProviderActivityAt = now;
        runtime.lastProviderProgressEvents += 1;
        for (const tool of nativeTools) {
          const toolId = typeof tool.id === "string"
            ? tool.id
            : `${tool.name}:${jsonString(tool.input || {})}`;
          if (!completedNativeProgressToolIds.has(toolId)) {
            pendingNativeProgressTools.set(toolId, { name: tool.name, input: tool.input });
          }
        }
        writeSse(response, "response.in_progress", {
          response: {
            id: responseId,
            object: "response",
            model: context.model,
            status: "in_progress",
            metadata: { provider_activity: runtime.lastProviderActivity },
          },
        });
      }
      return;
    }
    if (event?.type === "user" && Array.isArray(event.message?.content)) {
      for (const result of event.message.content.filter((part) => part?.type === "tool_result")) {
        completeNativeProgressTool(result.tool_use_id ?? result.toolUseId ?? result.call_id ?? result.callId);
      }
      return;
    }
    if (event?.type === "tool_result") {
      completeNativeProgressTool(event.tool_use_id ?? event.toolUseId ?? event.call_id ?? event.callId);
      return;
    }
    if (event?.type === "result" && event.subtype === "success" && event.is_error !== true) {
      for (const toolId of [...pendingNativeProgressTools.keys()]) completeNativeProgressTool(toolId);
    }
    if (event?.type !== "stream_event" || !event.event) return;
    const providerEvent = event.event;
    let activity = providerEvent.type;
    if (providerEvent.type === "content_block_delta") {
      const visibleText = providerVisibleTextDelta(event);
      if (visibleText !== null) {
        activity = "writing";
      } else if (providerEvent.delta?.type === "thinking_delta") {
        activity = "reasoning";
      } else if (providerEvent.delta?.type === "input_json_delta") {
        activity = "preparing_tool";
      }
    }
    const now = Date.now();
    if (now - lastProgressAt < 1_000) return;
    lastProgressAt = now;
    runtime.lastProviderActivity = activity;
    runtime.lastProviderActivityAt = now;
    runtime.lastProviderProgressEvents += 1;
    writeSse(response, "response.in_progress", {
      response: {
        id: responseId,
        object: "response",
        model: context.model,
        status: "in_progress",
        metadata: { provider_activity: activity },
      },
    });
  };
  try {
    const result = await runCodeBuddy(context, (spawned) => { child = spawned; }, onProviderEvent);
    if (clientGone) return;
    providerConversations.commit(context);
    runtime.lastModel = result.initEvent.model;
    runtime.lastAuthSource = result.initEvent.apiKeySource;
    runtime.lastCostUsd = result.resultEvent.total_cost_usd;
    runtime.lastInputTokens = result.resultEvent.usage?.input_tokens ?? null;
    runtime.lastOutputTokens = result.resultEvent.usage?.output_tokens ?? null;
    runtime.lastDurationApiMs = result.resultEvent.duration_api_ms ?? null;
    runtime.lastMaxTurnInputTokens = result.maxTurnInputTokens;
    runtime.maxObservedTurnInputTokens = Math.max(runtime.maxObservedTurnInputTokens, result.maxTurnInputTokens);
    runtime.lastSuccessfulMutationCount = context.taskState.progress.successfulMutationCount + result.mutationCount;
    runtime.lastChangedPaths = [...new Set([...context.taskState.progress.changedPaths, ...result.nativeChangedPaths])];
    runtime.lastCompletedTool = result.nativeToolNames.at(-1) || context.taskState.progress.lastCompletedTool;
    const providerFinalText = providerCompletionReport(result.finalText, result.resultEvent, result.calls);
    const progressReport = result.mutationCount > 0
      ? `[Authoritative native-provider progress]\nTask ID: ${context.taskDiagnostics.taskId}\nTask hash: ${context.taskDiagnostics.taskHash}\nNative tool calls: ${result.nativeToolNames.length}\nSuccessful native mutations: ${result.mutationCount}\nChanged paths: ${result.nativeChangedPaths.join(", ") || "not reported by provider"}\nLast completed native tool: ${result.nativeToolNames.at(-1) || "none"}`
      : authoritativeProgressReport(context.taskState);
    const finalText = providerFinalText && progressReport
      ? `${providerFinalText}\n\n${progressReport}`
      : providerFinalText;
    runtime.completed += 1;
    const output = [];
    output.push(...finishProgress());
    let outputIndex = output.length;
    if (finalText) {
      const itemId = streamedMessageId || `msg_${randomUUID()}`;
      if (!streamedMessageId) {
        writeSse(response, "response.output_item.added", { output_index: outputIndex, item: responseMessageItem(itemId, "") });
        writeSse(response, "response.content_part.added", { item_id: itemId, output_index: outputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
        writeSse(response, "response.output_text.delta", { item_id: itemId, output_index: outputIndex, content_index: 0, delta: finalText });
      } else {
        if (!finalText.startsWith(streamedText)) {
          throw new BridgeError("CodeBuddy final assistant output diverged after streaming began", 502);
        }
        const remainingText = finalText.slice(streamedText.length);
        if (remainingText) {
          writeSse(response, "response.output_text.delta", { item_id: itemId, output_index: outputIndex, content_index: 0, delta: remainingText });
        }
      }
      writeSse(response, "response.output_text.done", { item_id: itemId, output_index: outputIndex, content_index: 0, text: finalText });
      writeSse(response, "response.content_part.done", { item_id: itemId, output_index: outputIndex, content_index: 0, part: { type: "output_text", text: finalText, annotations: [] } });
      const item = responseMessageItem(itemId, finalText, "completed");
      writeSse(response, "response.output_item.done", { output_index: outputIndex, item });
      output.push(item);
      outputIndex += 1;
    }
    for (const call of result.calls) {
      const item = callItem(call);
      writeSse(response, "response.output_item.done", { output_index: outputIndex, item });
      output.push(item);
      outputIndex += 1;
    }
    writeSse(response, "response.completed", {
      response: {
        id: responseId, object: "response", model: context.model, status: "completed",
        usage: usageFrom(result.resultEvent), output,
        metadata: {
          actual_provider: PROVIDER_ID,
          actual_model: result.initEvent.model,
          actual_model_label: result.initEvent.model,
          actual_reasoning_effort: REQUIRED_EFFORT,
          auth_source: result.initEvent.apiKeySource,
          codebuddy_initialized_model: result.initEvent.model,
          codebuddy_auth_source: result.initEvent.apiKeySource,
          codebuddy_total_cost_usd: result.resultEvent.total_cost_usd,
          codex_client_tool_count: context.toolInfo.definitions.length,
          codex_client_tool_count_incoming: context.incomingCodexToolCount,
          codex_client_tool_surface_retained: context.retainedToolSurfaceUsed,
          codex_client_tool_schema_bytes: Buffer.byteLength(jsonString(context.toolInfo.definitions)),
          codebuddy_max_turn_input_tokens: result.maxTurnInputTokens,
          native_cli_single_execution: true,
          native_tool_names: result.nativeToolNames,
          native_tool_count: result.nativeToolNames.length,
          rzmcp_tools_called: result.nativeRzMcpTools,
          provider_mutation_count: result.mutationCount,
          provider_changed_paths: result.nativeChangedPaths,
          ...codexToolServingMetadata(context.executionPolicy.rzMcpMode === "disabled" ? 0 : 2),
          active_task_id: context.taskDiagnostics.taskId,
          active_task_name: context.taskDiagnostics.taskName,
          active_task_hash: context.taskDiagnostics.taskHash,
          active_task_intent: context.taskDiagnostics.taskIntent,
          active_task_delivery_mode: context.taskDiagnostics.taskDeliveryMode,
          active_task_part_types: context.taskDiagnostics.taskPartTypes,
          active_task_part_lengths: context.taskDiagnostics.taskPartLengths,
          complete_active_task_delivered: context.taskDiagnostics.completeTaskDelivered,
          active_task_included_this_turn: context.taskDiagnostics.activeTaskIncludedThisTurn,
          active_task_retained_in_provider_session: context.taskDiagnostics.retainedInProviderSession,
          tool_calls_since_active_task: context.taskState.progress.toolCallsSinceTask,
          successful_apply_patch_mutations: context.taskState.progress.successfulMutationCount + result.mutationCount,
          changed_paths: [...new Set([...context.taskState.progress.changedPaths, ...result.nativeChangedPaths])],
          last_completed_tool: result.nativeToolNames.at(-1) || context.taskState.progress.lastCompletedTool,
          checkpoint_requested: context.taskState.checkpointRequested,
          provider_session_resumed: context.providerSessionStarted,
          provider_session_hash: sha256(context.providerSessionId),
          normalized_input_items: context.conversation.inputItemCount,
          forwarded_delta_items: context.conversation.deltaItemCount,
          normalized_prompt_chars: context.prompt.length,
        },
      },
    });
    response.end();
    if (result.calls.length === 0 && !context.taskState.checkpointRequested) {
      providerConversations.release(context);
      conversationReleased = true;
    }
  } catch (error) {
    if (clientGone) return;
    providerConversations.resetProvider(context);
    runtime.failed += 1;
    runtime.lastFailure = redactSecrets(error.message);
    writeSse(response, "response.failed", {
      response: {
        id: responseId,
        object: "response",
        status: "failed",
        error: {
          code: providerResponseErrorCode(error),
          type: "bridge_error",
          message: redactSecrets(error.message),
          provider_diagnostics: providerFailureDiagnostics(error),
        },
      },
    });
    response.end();
  } finally {
    if (clientGone && !conversationReleased) {
      if (nativeProgressTools > 0) {
        // A completed progress item is a Codex mailbox/preemption boundary. Preserve the provider
        // conversation so the next request for this thread can deliver the parent's checkpoint or
        // follow-up without discarding the native tool results that preceded that boundary.
        providerConversations.commit(context);
      } else {
        providerConversations.release(context);
      }
      conversationReleased = true;
    }
    runtime.activeRequests = Math.max(0, runtime.activeRequests - 1);
    request.removeListener("aborted", abort);
  }
}

function selfTest() {
  const safeProgress = formatNativeToolProgress("CodeBuddy", 2, "Bash", {
    command: "rg -n 'SetInteractText' G:/QANGA --api-key=or-secretsecretsecret",
  });
  const lazyProgress = formatNativeToolProgress("CodeBuddy", 3, "mcp__rzmcp__call_rzmcp_tool", {
    name: "inspect_graph_by_path",
    arguments: { blueprint: "/Game/Fixture" },
  });
  const deferredLazyProgress = formatNativeToolProgress("CodeBuddy", 4, "DeferExecuteTool", {
    toolName: "mcp__rzmcp__call_rzmcp_tool",
    params: { name: "find_blueprint_nodes", arguments: { search_term: "Fixture" } },
  });
  const pathProgress = formatNativeToolProgress("CodeBuddy", 4, "Bash", {
    command: "rg -n 'AfterCheck' G:/QANGA/Plugins/QSystem/Source/QSystem/Private/Component/QPlayerControllerInteractComponent.cpp",
  });
  const mcpCatalogProgress = formatNativeToolProgress("Devin", 5, "mcp_list_tools", {
    server_name: "rzmcp",
  });
  if (
    !safeProgress.includes("rg -n 'SetInteractText' G:/QANGA")
    || safeProgress.includes("secretsecretsecret")
    || !lazyProgress.includes("RzMCP inspect_graph_by_path")
    || !deferredLazyProgress.includes("mcp__rzmcp__call_rzmcp_tool - RzMCP find_blueprint_nodes")
    || rzMcpToolNameFromNativeProgress("DeferExecuteTool", {
      toolName: "mcp__rzmcp__call_rzmcp_tool",
      params: { name: "find_blueprint_nodes" },
    }) !== "find_blueprint_nodes"
    || !pathProgress.includes("QPlayerControllerInteractComponent.cpp")
    || pathProgress.includes("[REDACTED].cpp")
    || !mcpCatalogProgress.includes("server rzmcp")
  ) {
    throw new Error("self-test failed: native tool progress was not useful and secret-safe");
  }
  if (
    providerToolIsMutation("mcp__rzmcp__call_rzmcp_tool", { name: "inspect_graph_by_path" }, { rzMcpMode: "full" })
    || providerToolIsMutation("mcp__rzmcp__call_rzmcp_tool", { name: "connect_pins_with_details" }, { rzMcpMode: "read-only" })
    || !providerToolIsMutation("mcp__rzmcp__call_rzmcp_tool", { name: "connect_pins_with_details" }, { rzMcpMode: "full" })
    || !providerToolIsMutation("Edit", { file_path: "fixture.cpp" }, { rzMcpMode: "read-only" })
  ) {
    throw new Error("self-test failed: CodeBuddy lazy RzMCP mutation accounting");
  }
  const toolServingMetadata = codexToolServingMetadata(2);
  if (
    toolServingMetadata.codex_tool_schema_bytes_forwarded !== 0
    || toolServingMetadata.codex_client_tool_schema_bytes_forwarded !== 0
    || toolServingMetadata.lazy_rzmcp_proxy_tools !== 2
  ) {
    throw new Error("self-test failed: CodeBuddy completion metadata is incompatible with routed lazy tool validation");
  }
  if (
    providerResponseErrorCode({ nativeToolNames: ["Read"] }) !== "provider_state_changed"
    || providerResponseErrorCode({ nativeToolNames: [] }) !== "external_provider_error"
  ) {
    throw new Error("self-test failed: CodeBuddy read-only provider work was eligible for replay");
  }
  const route = resolveRoute(MODEL_ALIAS);
  const advertisedModels = managedModelsResponse().models;
  const catalogModel = advertisedModels[0];
  if (
    advertisedModels.length !== 2 ||
    catalogModel.slug !== MODEL_ALIAS ||
    !catalogModel.base_instructions.includes("delegated coding sub-agent") ||
    catalogModel.default_reasoning_level !== REQUIRED_EFFORT ||
    catalogModel.apply_patch_tool_type !== "freeform" ||
    catalogModel.input_modalities.join(",") !== route.inputModalities.join(",")
    || !advertisedModels.some((model) => model.slug === MAIN_MODEL_ALIAS && model.visibility === "visible")
  ) {
    throw new Error("self-test failed: managed model catalog disagrees with the route");
  }
  const textDelta = {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "visible" } },
  };
  const thinkingDelta = {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "private" } },
  };
  if (
    providerVisibleTextDelta(textDelta) !== "visible"
    || providerVisibleTextDelta(thinkingDelta) !== null
  ) {
    throw new Error("self-test failed: provider stream exposed non-visible reasoning");
  }
  const providerReport = providerCompletionReport(
    "I'll inspect the files next.",
    { result: "I'll inspect the files next." },
    [],
  );
  if (providerReport !== "I'll inspect the files next.") {
    throw new Error("self-test failed: successful provider output was semantically filtered");
  }
  try {
    providerCompletionReport("tool turn", {}, [{ callId: "call-1" }]);
    throw new Error("self-test failed: unavailable parent tool call was accepted");
  } catch (error) {
    if (!String(error.message).includes("unavailable Codex parent tool")) throw error;
  }
  const selfTestTools = [
    { type: "web_search" },
    { type: "tool_search", execution: "client", description: "Find tools", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    { type: "custom", name: "apply_patch", description: "Apply a patch" },
    { type: "function", name: "exec_command", description: "Run a command", parameters: { type: "object", properties: {} } },
    { type: "function", name: "write_stdin", description: "Continue a command", parameters: { type: "object", properties: {} } },
    { type: "function", name: "view_image", description: "Inspect an image", parameters: { type: "object", properties: {} } },
    { type: "namespace", name: "mcp__rzmcp", tools: [{ type: "function", name: "search_project_index", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }] },
  ];
  const selfTestRegistry = new ProviderConversationRegistry();
  let selfTestThread = 0;
  const normalizeSelfTestRequest = (input, options = {}) => {
    const request = {
      model: MODEL_ALIAS,
      stream: true,
      reasoning: { effort: "max" },
      client_metadata: {
        cwd: options.cwd ?? process.cwd(),
        thread_id: options.threadId ?? `self-test-thread-${selfTestThread += 1}`,
      },
      instructions: "<external_cli_route_instructions>bounded role</external_cli_route_instructions>",
      input,
    };
    if (!options.omitTools) request.tools = options.tools ?? selfTestTools;
    return promptFrom(request, options.registry ?? selfTestRegistry);
  };
  const mainRegistry = new ProviderConversationRegistry();
  const mainRequest = (input) => promptFrom({
    model: MAIN_MODEL_ALIAS,
    stream: true,
    reasoning: { effort: REQUIRED_EFFORT },
    client_metadata: { cwd: homedir(), thread_id: "codebuddy-main-fixture" },
    instructions: "MAIN_AGENT_INSTRUCTIONS",
    input,
    tools: selfTestTools,
  }, mainRegistry);
  const firstMainTurn = mainRequest([
    { type: "message", id: "main-user-1", role: "user", content: "MAIN_AGENT_REQUEST_ONE" },
  ]);
  if (
    !firstMainTurn.mainAgent
    || firstMainTurn.taskState.activeTask !== null
    || !firstMainTurn.prompt.includes(MAIN_AGENT_CONTRACT)
    || !firstMainTurn.prompt.includes("MAIN_AGENT_INSTRUCTIONS")
    || !firstMainTurn.prompt.includes("MAIN_AGENT_REQUEST_ONE")
    || firstMainTurn.executionPolicy.rzMcpMode !== "full"
  ) {
    throw new Error("self-test failed: CodeBuddy main-agent alias rejected ordinary history");
  }
  mainRegistry.begin(firstMainTurn);
  mainRegistry.commit(firstMainTurn);
  const resumedMainTurn = mainRequest([
    { type: "message", id: "main-user-1", role: "user", content: "MAIN_AGENT_REQUEST_ONE" },
    { type: "message", id: "main-assistant-1", role: "assistant", content: "MAIN_AGENT_RESPONSE_ONE" },
    { type: "message", id: "main-user-2", role: "user", content: "MAIN_AGENT_REQUEST_TWO" },
  ]);
  if (
    !resumedMainTurn.providerSessionStarted
    || !resumedMainTurn.prompt.includes("MAIN_AGENT_REQUEST_TWO")
    || resumedMainTurn.prompt.includes("MAIN_AGENT_REQUEST_ONE")
  ) {
    throw new Error("self-test failed: CodeBuddy main-agent continuation did not send only new user input");
  }
  const readOnlyTask = normalizeSelfTestRequest([{
    type: "agent_message",
    id: "self-test-read-only",
    author: "Codex",
    recipient: "/root/read_only",
    content: [{
      type: "input_text",
      text: "Message Type: NEW_TASK\nTask name: /root/read_only\nPayload:\nRead two files. Do not edit files. Never create files.",
    }],
  }], { cwd: homedir() });
  if (readOnlyTask.workingDirectory !== homedir()) {
    throw new Error("self-test failed: CodeBuddy ignored the authoritative request working directory");
  }
  const rzMcpPolicyTask = (id, payload) => normalizeSelfTestRequest([{
    type: "agent_message",
    id,
    author: "Codex",
    recipient: "/root/rzmcp_policy",
    content: [{
      type: "input_text",
      text: `Message Type: NEW_TASK\nTask name: /root/rzmcp_policy\nPayload:\n${payload}`,
    }],
  }]);
  const explicitReadOnlyRzMcp = rzMcpPolicyTask(
    "self-test-rzmcp-required",
    "Read-only inspection. No edits/build/tests/editor control/assets saves/staging. Use RzDirectMCP semantic/read-only APIs only (never binary grep).",
  );
  const explicitRzMcpBan = rzMcpPolicyTask(
    "self-test-rzmcp-forbidden",
    "Read-only inspection. Use repository text tools, but do not use or invoke RzDirectMCP.",
  );
  const explicitLazyProxyRequirement = rzMcpPolicyTask(
    "self-test-rzmcp-lazy-proxy-required",
    "Read-only inspection. Do not control the editor. Use search_rzmcp_tools before call_rzmcp_tool. Never request the full RzMCP catalog.",
  );
  const naturalReadOnlyRzMcp = rzMcpPolicyTask(
    "self-test-rzmcp-natural-required",
    "Make at least twelve useful rg/file-read calls plus exactly two read-only RzMCP calls. Do not use any other RzMCP calls. Never edit, build, test, or start PIE.",
  );
  if (
    explicitReadOnlyRzMcp.executionPolicy.rzMcpMode !== "read-only"
    || explicitLazyProxyRequirement.executionPolicy.rzMcpMode !== "read-only"
    || naturalReadOnlyRzMcp.executionPolicy.rzMcpMode !== "read-only"
    || explicitRzMcpBan.executionPolicy.rzMcpMode !== "disabled"
  ) {
    throw new Error("self-test failed: CodeBuddy RzMCP task capability classification");
  }
  const boundedMutationTask = normalizeSelfTestRequest([{
    type: "agent_message",
    id: "self-test-bounded-mutation",
    author: "Codex",
    recipient: "/root/bounded_mutation",
    content: [{
      type: "input_text",
      text: "Message Type: NEW_TASK\nTask name: /root/bounded_mutation\nPayload:\nFix the router. Do not modify G:\\QANGA.",
    }],
  }]);
  if (
    readOnlyTask.taskState.activeTask.intent !== "analysis"
    || boundedMutationTask.taskState.activeTask.intent !== "mutation"
  ) {
    throw new Error(
      `self-test failed: negated mutation intent classification read_only=${readOnlyTask.taskState.activeTask.intent} bounded_mutation=${boundedMutationTask.taskState.activeTask.intent}`,
    );
  }
  if (
    !readOnlyTask.prompt.includes("[Analysis convergence contract]")
    || readOnlyTask.prompt.includes("[Immediate terminal report required]")
  ) {
    throw new Error("self-test failed: CodeBuddy analysis convergence control");
  }
  const immediateReadOnlyTask = normalizeSelfTestRequest([{
    type: "agent_message",
    id: "self-test-immediate-read-only",
    author: "Codex",
    recipient: "/root/read_only",
    content: [{
      type: "input_text",
      text: "Message Type: NEW_TASK\nTask name: /root/read_only\nPayload:\nReturn your current implementation verdict immediately. Do not investigate further.",
    }],
  }]);
  if (
    !immediateReadOnlyTask.taskState.immediateReturnRequested
    || !immediateReadOnlyTask.prompt.includes("[Immediate terminal report required]")
  ) {
    throw new Error(
      `self-test failed: CodeBuddy immediate terminal report control state=${immediateReadOnlyTask.taskState.immediateReturnRequested} prompt=${immediateReadOnlyTask.prompt.includes("[Immediate terminal report required]")}`,
    );
  }
  const context = normalizeSelfTestRequest([
      {
        type: "agent_message",
        id: "self-test-context-task",
        author: "/root",
        recipient: "/root/test",
        content: [{
          type: "input_text",
          text: "Message Type: NEW_TASK\nTask name: /root/test\nPayload:\nInspect one file.",
        }],
      },
      { type: "compaction", encrypted_content: "provider-opaque-compaction" },
      { type: "agent_message", author: "/root", recipient: "/root/test", content: [{ type: "input_text", text: "inspect one file" }] },
      { type: "tool_search_call", call_id: "search-1", arguments: { query: "project index" } },
      {
        type: "tool_search_output",
        call_id: "search-1",
        tools: [{
          type: "namespace",
          name: "mcp__rzmcp",
          tools: [{ type: "function", name: "scan_project_index", parameters: { type: "object", properties: {} } }],
        }],
      },
    ]);
  if (
    context.model !== route.model
    || !context.prompt.includes("inspect one file")
    || !context.prompt.includes("[Project AGENTS instructions - authoritative and complete]")
    || context.prompt.includes("provider-opaque-compaction")
  ) {
    throw new Error("self-test failed: request normalization");
  }
  const taskHeader = "Message Type: NEW_TASK\nTask name: /root/test\nSender: /root\nPayload:\n";
  const conditionalCheckpointTask = taskStateFromInput([{
    id: "amsg-conditional-checkpoint",
    type: "agent_message",
    author: "/root",
    recipient: "/root/test",
    content: [{
      type: "input_text",
      text: `${taskHeader}Read-only RzCodex checkpoint smoke test. Do not edit files. Inspect the bounded files in order. Return concise evidence when complete or immediately if the parent requests a checkpoint.`,
    }],
  }], MAX_ACTIVE_TASK_CHARS);
  if (
    conditionalCheckpointTask.checkpointRequested
    || conditionalCheckpointTask.immediateReturnRequested
  ) {
    throw new Error("self-test failed: a conditional checkpoint mention became a terminal control request");
  }
  const encryptedPayload = "implement encrypted delivery fixture";
  const encryptedTask = normalizeSelfTestRequest([{
    id: "amsg-encrypted",
    type: "agent_message",
    author: "/root",
    recipient: "/root/test",
    content: [
      { type: "input_text", text: taskHeader },
      { type: "encrypted_content", encrypted_content: encryptedPayload },
    ],
  }]);
  if (
    encryptedTask.taskDiagnostics.taskId !== "amsg-encrypted"
    || encryptedTask.taskDiagnostics.taskDeliveryMode !== "encrypted_v2"
    || encryptedTask.taskDiagnostics.completeTaskOccurrences !== 1
    || encryptedTask.taskDiagnostics.taskPartTypes.join(",") !== "input_text,encrypted_content"
    || encryptedTask.prompt.split(encryptedPayload).length - 1 !== 1
  ) {
    throw new Error("self-test failed: encrypted V2 task must be delivered completely exactly once");
  }
  const plaintextPayload = "inspect plaintext delivery fixture";
  const plaintextTaskText = `${taskHeader}${plaintextPayload}`;
  const plaintextTaskItem = {
    id: "amsg-plaintext",
    type: "agent_message",
    author: "/root",
    recipient: "/root/test",
    content: [{ type: "input_text", text: plaintextTaskText }],
  };
  const plaintextTask = normalizeSelfTestRequest([plaintextTaskItem]);
  if (
    plaintextTask.taskDiagnostics.taskId !== "amsg-plaintext"
    || plaintextTask.taskDiagnostics.taskDeliveryMode !== "plaintext_v2"
    || plaintextTask.prompt.split(plaintextPayload).length - 1 !== 1
  ) {
    throw new Error("self-test failed: plaintext V2 task delivery regressed");
  }
  const priorResumeTaskText = `${taskHeader}inspect the original bounded fixture and retain its exact scope`;
  const activeResumeTaskText = `${taskHeader}Bridge repaired. Resume the same bounded task from the preserved state and finish.`;
  const afterBridgeRestartResume = normalizeSelfTestRequest([
    { ...plaintextTaskItem, id: "amsg-prior-resume", content: [{ type: "input_text", text: priorResumeTaskText }] },
    { ...plaintextTaskItem, id: "amsg-active-resume", content: [{ type: "input_text", text: activeResumeTaskText }] },
  ], { registry: new ProviderConversationRegistry(), threadId: "self-test-after-bridge-restart" });
  if (
    afterBridgeRestartResume.prompt.split(priorResumeTaskText).length - 1 !== 1
    || afterBridgeRestartResume.prompt.split(activeResumeTaskText).length - 1 !== 1
    || !afterBridgeRestartResume.prompt.includes("[Referenced prior delegated context]")
  ) {
    throw new Error("self-test failed: CodeBuddy bridge restart lost referenced prior task context");
  }
  const reasoningBoundary = normalizeSelfTestRequest([
    plaintextTaskItem,
    {
      type: "reasoning",
      id: "progress_codebuddy_fixture",
      summary: [{ type: "summary_text", text: "BRIDGE_PROGRESS_MUST_NOT_REENTER" }],
    },
    {
      type: "reasoning",
      id: "rs_parent_codebuddy_fixture",
      summary: [{ type: "summary_text", text: "PORTABLE_PARENT_REASONING" }],
    },
  ]);
  if (
    reasoningBoundary.prompt.includes("BRIDGE_PROGRESS_MUST_NOT_REENTER")
    || !reasoningBoundary.prompt.includes("PORTABLE_PARENT_REASONING")
  ) {
    throw new Error("self-test failed: bridge progress re-entered the CodeBuddy provider prompt");
  }
  const resumeRegistry = new ProviderConversationRegistry();
  const resumeThread = "self-test-resume-thread";
  const resumeFirst = normalizeSelfTestRequest(
    [plaintextTaskItem],
    { registry: resumeRegistry, threadId: resumeThread },
  );
  const firstSessionArgs = codeBuddyArguments(resumeFirst, "mcp-config.json");
  if (
    !firstSessionArgs.includes("--session-id")
    || firstSessionArgs.includes("--resume")
    || firstSessionArgs.includes("--no-session-persistence")
  ) {
    throw new Error("self-test failed: first provider turn must create a persistent managed session");
  }
  resumeRegistry.commit(resumeFirst);
  const firstToolResultText = "Exit code: 0\nOutput:\ncontinuation proof";
  const resumed = normalizeSelfTestRequest([
    plaintextTaskItem,
    { type: "function_call", name: "exec_command", call_id: "resume-read", arguments: "{}" },
    { type: "function_call_output", call_id: "resume-read", output: firstToolResultText },
  ], { registry: resumeRegistry, threadId: resumeThread, tools: [] });
  const resumedSessionArgs = codeBuddyArguments(resumed, "mcp-config.json");
  if (
    !resumed.providerSessionStarted
    || !resumedSessionArgs.includes("--resume")
    || resumedSessionArgs.includes("--session-id")
    || resumed.providerSessionId !== resumeFirst.providerSessionId
    || resumed.prompt.includes(plaintextTaskText)
    || !resumed.prompt.includes(firstToolResultText)
    || resumed.taskDiagnostics.completeTaskOccurrences !== 0
    || !resumed.taskDiagnostics.retainedInProviderSession
    || resumed.conversation.deltaItemCount !== 1
    || !resumed.retainedToolSurfaceUsed
    || resumed.incomingCodexToolCount !== 0
    || jsonString(resumed.toolInfo.definitions) !== jsonString(resumeFirst.toolInfo.definitions)
  ) {
    throw new Error("self-test failed: resumed provider turn did not preserve its validated lazy tool surface");
  }
  resumeRegistry.commit(resumed);
  const postCompactionResult = "Exit code: 0\nOutput:\npost-compaction proof";
  const postCompaction = normalizeSelfTestRequest([
    { type: "compaction", encrypted_content: "provider-opaque" },
    { type: "function_call", name: "exec_command", call_id: "post-compact-read", arguments: "{}" },
    { type: "function_call_output", call_id: "post-compact-read", output: postCompactionResult },
  ], { registry: resumeRegistry, threadId: resumeThread, omitTools: true });
  if (
    postCompaction.taskState.activeTask.hash !== plaintextTask.taskState.activeTask.hash
    || !postCompaction.taskDiagnostics.completeTaskDelivered
    || !postCompaction.taskDiagnostics.retainedInProviderSession
    || postCompaction.prompt.includes(plaintextTaskText)
    || !postCompaction.prompt.includes(postCompactionResult)
    || postCompaction.taskState.progress.toolCallsSinceTask !== 2
    || !postCompaction.retainedToolSurfaceUsed
  ) {
    throw new Error("self-test failed: compaction removed retained task or cumulative progress");
  }
  resumeRegistry.commit(postCompaction);
  const replacementResumePayload = "replace the active retained task";
  const replacementResumeText = `${taskHeader}${replacementResumePayload}`;
  const replacementResume = normalizeSelfTestRequest([{
    id: "amsg-resume-replacement",
    type: "agent_message",
    author: "/root",
    recipient: "/root/test",
    content: [{ type: "input_text", text: replacementResumeText }],
  }], { registry: resumeRegistry, threadId: resumeThread });
  if (
    replacementResume.providerSessionId !== resumeFirst.providerSessionId
    || replacementResume.prompt.split(replacementResumeText).length - 1 !== 1
    || replacementResume.prompt.includes(plaintextTaskText)
    || replacementResume.taskState.progress.toolCallsSinceTask !== 0
    || !replacementResume.taskDiagnostics.activeTaskIncludedThisTurn
  ) {
    throw new Error("self-test failed: followup task did not replace retained provider task atomically");
  }
  try {
    normalizeSelfTestRequest(
      [{ type: "message", role: "user", content: "orphan continuation" }],
      { registry: new ProviderConversationRegistry(), threadId: "self-test-orphan" },
    );
    throw new Error("self-test failed: orphan continuation must fail loudly");
  } catch (error) {
    if (!String(error.message).includes("without an active NEW_TASK")) throw error;
  }
  const toolLessNativeTurn = normalizeSelfTestRequest(
    [plaintextTaskItem],
    { registry: new ProviderConversationRegistry(), threadId: "self-test-tool-less-first-turn", tools: [] },
  );
  if (!toolLessNativeTurn.prompt.includes("Single native-agent execution contract")) {
    throw new Error("self-test failed: CodeBuddy native tools must not depend on parent tool schemas");
  }
  const taskChangeRegistry = new ProviderConversationRegistry();
  const taskChangeThread = "self-test-task-change-tools";
  const beforeTaskChange = normalizeSelfTestRequest(
    [plaintextTaskItem],
    { registry: taskChangeRegistry, threadId: taskChangeThread },
  );
  taskChangeRegistry.commit(beforeTaskChange);
  const taskChange = normalizeSelfTestRequest([{
    id: "amsg-task-change-without-tools",
    type: "agent_message",
    author: "/root",
    recipient: "/root/test",
    content: [{ type: "input_text", text: `${taskHeader}replace the task without repeating unchanged tools` }],
  }], { registry: taskChangeRegistry, threadId: taskChangeThread, omitTools: true });
  if (
    !taskChange.retainedToolSurfaceUsed
    || taskChange.taskState.activeTask.id !== "amsg-task-change-without-tools"
    || jsonString(taskChange.toolInfo.definitions) !== jsonString(beforeTaskChange.toolInfo.definitions)
  ) {
    throw new Error("self-test failed: a follow-up task lost the retained provider tool surface");
  }
  const inheritedHistory = "h".repeat(MAX_PROMPT_CHARS + 10_000);
  const longFork = normalizeSelfTestRequest([
    plaintextTaskItem,
    { type: "message", role: "user", content: inheritedHistory },
  ]);
  if (
    !longFork.taskDiagnostics.completeTaskDelivered
    || longFork.prompt.split(plaintextTaskText).length - 1 !== 1
  ) {
    throw new Error("self-test failed: long inherited history removed the active task");
  }
  const afterLargeToolOutput = normalizeSelfTestRequest([
    plaintextTaskItem,
    { type: "function_call", name: "exec_command", call_id: "large-read", arguments: "{}" },
    { type: "function_call_output", call_id: "large-read", output: "r".repeat(MAX_PROMPT_CHARS + 10_000) },
  ]);
  if (
    !afterLargeToolOutput.taskDiagnostics.completeTaskDelivered
    || afterLargeToolOutput.prompt.split(plaintextTaskText).length - 1 !== 1
  ) {
    throw new Error("self-test failed: large tool output removed the resumed active task");
  }
  const replacementPayload = "fix replacement task fixture";
  const replacementTaskText = `${taskHeader}${replacementPayload}`;
  const replacement = normalizeSelfTestRequest([
    plaintextTaskItem,
    { type: "function_call", name: "exec_command", call_id: "old-read", arguments: "{}" },
    { type: "function_call_output", call_id: "old-read", output: inheritedHistory },
    {
      id: "amsg-replacement",
      type: "agent_message",
      author: "/root",
      recipient: "/root/test",
      content: [{ type: "input_text", text: replacementTaskText }],
    },
  ]);
  if (
    replacement.taskDiagnostics.taskId !== "amsg-replacement"
    || replacement.prompt.split(replacementTaskText).length - 1 !== 1
    || replacement.prompt.includes(plaintextTaskText)
  ) {
    throw new Error("self-test failed: follow-up task did not atomically replace the active task");
  }
  try {
    normalizeSelfTestRequest([{
      type: "agent_message",
      author: "/root",
      recipient: "/root/test",
      content: [
        { type: "input_text", text: taskHeader },
        { type: "unsupported_task_content", value: "lost" },
      ],
    }]);
    throw new Error("self-test failed: unsupported inter-agent task content must fail loudly");
  } catch (error) {
    if (!String(error.message).includes("unsupported inter-agent content type")) throw error;
  }
  try {
    normalizeSelfTestRequest([{
      type: "agent_message",
      author: "/root",
      recipient: "/root/test",
      content: [],
    }]);
    throw new Error("self-test failed: missing inter-agent task content must fail loudly");
  } catch (error) {
    if (!String(error.message).includes("must be a non-empty string or content array")) throw error;
  }
  const mutationTaskText = `${taskHeader}Implement the two-step apply_patch fixture.`;
  const mutationTaskItem = {
    id: "amsg-mutation",
    type: "agent_message",
    author: "/root",
    recipient: "/root/test",
    content: [{ type: "input_text", text: mutationTaskText }],
  };
  const checkpointMessage = {
    type: "agent_message",
    author: "/root",
    recipient: "/root/test",
    content: [{
      type: "input_text",
      text: "Message Type: MESSAGE\nTask name: /root/test\nSender: /root\nPayload:\nReturn a checkpoint/report immediately with current progress.",
    }],
  };
  const checkpointNewTask = {
    id: "amsg-checkpoint-control",
    type: "agent_message",
    author: "/root",
    recipient: "/root/test",
    content: [{
      type: "input_text",
      text: "Message Type: NEW_TASK\nTask name: /root/test\nSender: /root\nPayload:\nImmediate checkpoint: finish the current tool call, do not start another tool, and report authoritative progress.",
    }],
  };
  const checkpointResumeNewTask = {
    id: "amsg-checkpoint-resume",
    type: "agent_message",
    author: "/root",
    recipient: "/root/test",
    content: [{
      type: "input_text",
      text: "Message Type: NEW_TASK\nTask name: /root/test\nSender: /root\nPayload:\nContinue the original bounded task from the checkpoint.",
    }],
  };
  const firstPatchHistory = [
    mutationTaskItem,
    { type: "function_call", name: "exec_command", call_id: "inspect", arguments: "{}" },
    { type: "function_call_output", call_id: "inspect", output: "Exit code: 0\nOutput:\nbefore" },
    { type: "custom_tool_call", name: "apply_patch", call_id: "patch-one", input: "patch one" },
    {
      type: "custom_tool_call_output",
      call_id: "patch-one",
      output: "Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nA C:/fixture/proof.txt\n",
    },
    checkpointMessage,
  ];
  const checkpointDeliveredAsNewTask = taskStateFromInput([
    ...firstPatchHistory.slice(0, -1),
    checkpointNewTask,
  ], MAX_ACTIVE_TASK_CHARS);
  if (
    checkpointDeliveredAsNewTask.activeTask.id !== mutationTaskItem.id
    || checkpointDeliveredAsNewTask.progress.successfulMutationCount !== 1
    || checkpointDeliveredAsNewTask.progress.lastCompletedTool !== "apply_patch"
    || !checkpointDeliveredAsNewTask.checkpointRequested
    || !checkpointDeliveredAsNewTask.immediateReturnRequested
  ) {
    throw new Error("self-test failed: NEW_TASK checkpoint control replaced the active task or erased progress");
  }
  const continuationAfterCheckpoint = taskStateFromInput([
    ...firstPatchHistory.slice(0, -1),
    checkpointNewTask,
    checkpointResumeNewTask,
  ], MAX_ACTIVE_TASK_CHARS);
  if (
    continuationAfterCheckpoint.activeTask.id !== "amsg-checkpoint-resume"
    || continuationAfterCheckpoint.referencedPriorTask?.id !== mutationTaskItem.id
    || continuationAfterCheckpoint.progress.successfulMutationCount !== 1
    || continuationAfterCheckpoint.checkpointRequested
    || continuationAfterCheckpoint.immediateReturnRequested
  ) {
    throw new Error("self-test failed: checkpoint continuation replaced the active task or lost cumulative progress");
  }
  const firstPatch = normalizeSelfTestRequest(firstPatchHistory);
  if (
    firstPatch.taskState.progress.successfulMutationCount !== 1
    || firstPatch.taskState.progress.changedPaths.join(",") !== "C:/fixture/proof.txt"
    || !firstPatch.taskState.checkpointRequested
    || !firstPatch.taskState.immediateReturnRequested
    || !firstPatch.prompt.includes("Do not start another tool call")
    || !authoritativeProgressReport(firstPatch.taskState).includes("Successful apply_patch mutations: 1")
  ) {
    throw new Error("self-test failed: checkpoint lost authoritative first-patch progress");
  }
  const resumedMutation = normalizeSelfTestRequest([
    ...firstPatchHistory,
    {
      type: "agent_message",
      author: "/root",
      recipient: "/root/test",
      content: [{ type: "input_text", text: "Message Type: MESSAGE\nTask name: /root/test\nSender: /root\nPayload:\nProceed with the second patch." }],
    },
    { type: "custom_tool_call", name: "apply_patch", call_id: "patch-two", input: "patch two" },
    {
      type: "custom_tool_call_output",
      call_id: "patch-two",
      output: "Exit code: 0\nOutput:\nSuccess. Updated the following files:\nM C:/fixture/proof.txt\n",
    },
    { type: "function_call", name: "exec_command", call_id: "verify", arguments: "{}" },
    { type: "function_call_output", call_id: "verify", output: "Exit code: 0\nOutput:\nafter" },
  ]);
  if (
    resumedMutation.taskState.progress.successfulMutationCount !== 2
    || resumedMutation.taskState.progress.changedPaths.join(",") !== "C:/fixture/proof.txt"
    || resumedMutation.taskState.progress.lastCompletedTool !== "exec_command"
    || resumedMutation.taskState.checkpointRequested
  ) {
    throw new Error("self-test failed: resumed mutation progress is not cumulative and authoritative");
  }
  const mutationRegistry = new ProviderConversationRegistry();
  const mutationThread = "self-test-mutation-resume";
  const mutationFirstTurn = normalizeSelfTestRequest(
    [mutationTaskItem],
    { registry: mutationRegistry, threadId: mutationThread },
  );
  mutationRegistry.commit(mutationFirstTurn);
  const mutationAfterFirstPatch = normalizeSelfTestRequest(firstPatchHistory, {
    registry: mutationRegistry,
    threadId: mutationThread,
  });
  if (mutationAfterFirstPatch.taskState.progress.successfulMutationCount !== 1) {
    throw new Error("self-test failed: retained provider session lost its first patch");
  }
  mutationRegistry.commit(mutationAfterFirstPatch);
  const checkpointControlRegistry = new ProviderConversationRegistry();
  const checkpointControlThread = "self-test-new-task-checkpoint-resume";
  const checkpointControlFirstTurn = normalizeSelfTestRequest(
    [mutationTaskItem],
    { registry: checkpointControlRegistry, threadId: checkpointControlThread },
  );
  checkpointControlRegistry.commit(checkpointControlFirstTurn);
  const checkpointControlTurn = normalizeSelfTestRequest([
    ...firstPatchHistory.slice(0, -1),
    checkpointNewTask,
  ], { registry: checkpointControlRegistry, threadId: checkpointControlThread });
  if (
    checkpointControlTurn.taskState.activeTask.id !== mutationTaskItem.id
    || checkpointControlTurn.taskState.progress.successfulMutationCount !== 1
    || !checkpointControlTurn.taskState.checkpointRequested
    || !checkpointControlTurn.taskDiagnostics.retainedInProviderSession
  ) {
    throw new Error("self-test failed: retained provider checkpoint replaced active ownership or progress");
  }
  checkpointControlRegistry.commit(checkpointControlTurn);
  const checkpointResumeTurn = normalizeSelfTestRequest([
    ...firstPatchHistory.slice(0, -1),
    checkpointNewTask,
    checkpointResumeNewTask,
  ], { registry: checkpointControlRegistry, threadId: checkpointControlThread });
  if (
    checkpointResumeTurn.taskState.activeTask.id !== checkpointResumeNewTask.id
    || checkpointResumeTurn.taskState.progress.successfulMutationCount !== 1
    || checkpointResumeTurn.taskState.checkpointRequested
    || checkpointResumeTurn.taskDiagnostics.retainedInProviderSession
  ) {
    throw new Error("self-test failed: retained provider resume lost cumulative checkpoint progress");
  }
  const mutationAfterCompaction = normalizeSelfTestRequest([
    { type: "context_compaction", encrypted_content: "opaque" },
    { type: "custom_tool_call", name: "apply_patch", call_id: "patch-two", input: "patch two" },
    {
      type: "custom_tool_call_output",
      call_id: "patch-two",
      output: "Exit code: 0\nOutput:\nSuccess. Updated the following files:\nM C:/fixture/proof.txt\n",
    },
  ], { registry: mutationRegistry, threadId: mutationThread });
  if (
    mutationAfterCompaction.taskState.progress.successfulMutationCount !== 2
    || mutationAfterCompaction.taskState.progress.changedPaths.join(",") !== "C:/fixture/proof.txt"
    || mutationAfterCompaction.prompt.includes(mutationTaskText)
    || !mutationAfterCompaction.taskDiagnostics.retainedInProviderSession
  ) {
    throw new Error("self-test failed: compaction lost cumulative apply_patch evidence");
  }
  const sanitizedDiagnostics = JSON.stringify(encryptedTask.taskDiagnostics);
  if (
    sanitizedDiagnostics.includes(encryptedPayload)
    || !sanitizedDiagnostics.includes(encryptedTask.taskDiagnostics.taskHash)
    || !sanitizedDiagnostics.includes("encrypted_content")
  ) {
    throw new Error("self-test failed: task diagnostics are missing hashes/types or persisted raw content");
  }
  if (
    context.toolInfo.definitions.length !== 6 ||
    !context.toolInfo.byWire.has("apply_patch") ||
    context.toolInfo.byWire.has("view_image") ||
    !context.toolInfo.byWire.has("mcp__rzmcp__search_project_index") ||
    !context.toolInfo.byWire.has("mcp__rzmcp__scan_project_index")
  ) {
    throw new Error("self-test failed: lazy Codex tool translation");
  }
  const incompleteSurface = { ...context.toolInfo, byOriginal: new Map(context.toolInfo.byOriginal) };
  incompleteSurface.byOriginal.delete(toolLookupKey(null, "apply_patch"));
  try {
    validateManagedToolSurface(incompleteSurface, route.inputModalities);
    throw new Error("self-test failed: incomplete native capabilities must be rejected");
  } catch (error) {
    if (!String(error.message).includes("apply_patch")) throw error;
  }
  const hostedSurface = codexToolsFrom({ tools: [{ type: "web_search" }] });
  if (!hostedSurface.hosted.has("web_search") || hostedSurface.definitions.length !== 0) {
    throw new Error("self-test failed: hosted web search must map to the provider-native tool");
  }
  try {
    rejectUnsupportedAudio([{ type: "input_audio", audio: "opaque" }], "self-test audio");
    throw new Error("self-test failed: silently dropping audio is forbidden");
  } catch (error) {
    if (!String(error.message).includes("does not support audio")) throw error;
  }
  const discoveryOnly = codexToolsFrom({
    input: [{
      type: "tool_search_output",
      tools: [{
        type: "namespace",
        name: "mcp__rzmcp",
        tools: [{ type: "function", name: "get_tool_info", parameters: { type: "object", properties: {} } }],
      }],
    }],
  });
  if (discoveryOnly.definitions.length !== 1 || !discoveryOnly.byWire.has("mcp__rzmcp__get_tool_info")) {
    throw new Error("self-test failed: discovered tools must survive without top-level tools");
  }
  const longPrompt = "x".repeat(35_000);
  const longPromptArgs = codeBuddyArguments(context, "mcp-config.json");
  const longPromptInput = JSON.parse(codeBuddyInput(longPrompt));
  const anonymousImage = codeBuddyImage(
    { image_url: "data:image/png;base64,aW1hZ2U=" },
    "self-test image",
  );
  const imageInput = JSON.parse(codeBuddyInput(context.prompt, [anonymousImage]));
  if (
    !longPromptArgs.includes("--input-format") ||
    !longPromptArgs.includes("stream-json") ||
    !longPromptArgs.includes("Read,Write,Edit,Bash,Glob,Grep,ToolSearch,DeferExecuteTool,WebSearch") ||
    !longPromptArgs.includes("Agent") ||
    longPromptArgs.some((argument) => argument.includes(longPrompt)) ||
    longPromptInput.message?.content?.[0]?.text !== longPrompt
  ) {
    throw new Error("self-test failed: long prompts must be transported through stream-json stdin");
  }
  if (
    context.images.length !== 0 ||
    context.prompt.includes("aW1hZ2U=") ||
    imageInput.message?.content?.[1]?.type !== "input_image" ||
    imageInput.message.content[1].image !== "data:image/png;base64,aW1hZ2U="
  ) {
    throw new Error("self-test failed: image outputs must use native stream-json image content");
  }
  const search = providerToolCall({
    type: "tool_use", id: "call-1", name: "DeferExecuteTool",
    input: { toolName: "mcp__codex__search_tools", params: { query: "asset search" } },
  }, context);
  if (!search?.entry.toolSearch || search.args.query !== "asset search") throw new Error("self-test failed: CodeBuddy tool-search restoration");
  const call = providerToolCall({
    type: "tool_use", id: "call-2", name: "DeferExecuteTool",
    input: { toolName: "mcp__codex__mcp__rzmcp__search_project_index", params: { query: "QModule" } },
  }, context);
  if (call?.entry.namespace !== "mcp__rzmcp" || call.entry.originalName !== "search_project_index") {
    throw new Error("self-test failed: namespaced Codex tool restoration");
  }
  const patch = providerToolCall({
    type: "tool_use", id: "call-3", name: "DeferExecuteTool",
    input: { toolName: "mcp__codex__apply_patch", params: { input: "*** Begin Patch\n*** End Patch" } },
  }, context);
  const patchItem = patch && callItem(patch);
  if (
    patchItem?.type !== "custom_tool_call" ||
    patchItem.name !== "apply_patch" ||
    patchItem.input !== "*** Begin Patch\n*** End Patch"
  ) {
    throw new Error("self-test failed: free-form Codex tool restoration");
  }
  const duplicatePatch = providerToolCall({
    type: "tool_use", id: "call-4", name: "DeferExecuteTool",
    input: { toolName: "mcp__codex__apply_patch", params: { input: "*** Begin Patch\n*** End Patch" } },
  }, context);
  if (!duplicatePatch || !patch || providerToolCallKey(duplicatePatch) !== providerToolCallKey(patch)) {
    throw new Error("self-test failed: duplicate Codex tool calls must share a semantic key");
  }
  validateResult(context, {
    model: context.model,
    apiKeySource: REQUIRED_AUTH_SOURCE,
    session_id: context.providerSessionId,
  }, {
    subtype: "success", is_error: false, total_cost_usd: 0, modelUsage: { [context.model]: {} },
  });
  process.stdout.write("codebuddy-subagent-bridge self-test: ok\n");
}

function start() {
  const port = configuredPort();
  cleanupOrphanedManagedSessions();
  cleanupStaleRequestArtifacts();
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        jsonResponse(response, 200, {
          ok: true, provider: PROVIDER_ID, port, modelAlias: MODEL_ALIAS,
          mainModelAlias: MAIN_MODEL_ALIAS,
          configuredModel: resolveRoute(MODEL_ALIAS).model, effort: REQUIRED_EFFORT,
          inputModalities: resolveRoute(MODEL_ALIAS).inputModalities,
          authSourceRequired: REQUIRED_AUTH_SOURCE, fallbackModel: null,
          explicitCostRequiredUsd: 0, codexManagedLazyTools: true,
          promptTransport: "single-native-cli-execution", transientProviderSessions: true,
          incrementalVisibleOutput: true,
          routeOwnershipTimeoutMs: ROUTE_OWNERSHIP_TIMEOUT_MS,
          providerProgressHeartbeatMaxHz: 1, runtime,
        });
        return;
      }
      if (request.method === "GET" && request.url?.split("?", 1)[0] === "/v1/models") {
        jsonResponse(response, 200, managedModelsResponse());
        return;
      }
      if (request.method === "POST" && request.url === "/v1/responses") {
        runtime.incomingRequests += 1;
        await handleResponses(request, response);
        return;
      }
      jsonResponse(response, 404, { error: { type: "not_found", message: "Use GET /health, GET /v1/models, or POST /v1/responses" } });
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const status = error instanceof BridgeError ? error.status : 500;
      const message = error instanceof BridgeError ? error.message : `Bridge error: ${error.message}`;
      const redactedMessage = redactSecrets(message);
      if (request.method === "POST" && request.url === "/v1/responses") {
        runtime.rejected += 1;
        runtime.lastRejectedError = redactedMessage;
      }
      jsonResponse(response, status, { error: { type: "bridge_error", message: redactedMessage } });
    }
  });
  server.on("error", (error) => {
    process.stderr.write(`codebuddy-subagent-bridge: ${error.message}\n`);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => process.stdout.write(`codebuddy-subagent-bridge listening on 127.0.0.1:${port}\n`));
}

try {
  if (process.argv.includes("--self-test")) selfTest();
  else start();
} catch (error) {
  process.stderr.write(`codebuddy-subagent-bridge startup failed: ${redactSecrets(error.message)}\n`);
  process.exitCode = 1;
}
