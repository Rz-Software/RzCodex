#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import {
  TaskStateError,
  activeTaskPromptSection,
  formatNativeToolProgress,
  isBridgeProgressReasoning,
  normalizeAgentMessageContent,
  referencedPriorTaskPromptSection,
  taskControlPromptSections,
  taskDeliveryDiagnostics,
  taskOwnershipHash,
  taskStateFromInput,
} from "./codebuddy-subagent-task-state.mjs";
import { projectInstructionsPromptSection } from "./native-project-instructions.mjs";

const PROVIDER_ID = "antigravity";
const MODEL_ALIAS = "@preset/codex-subagents";
const MAIN_MODEL_ALIAS = "@preset/rzcodex-main";
const REQUIRED_EFFORT = "high";
const DEFAULT_PORT = 54549;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_PROMPT_CHARS = 64_000;
const MAX_RESUME_PROMPT_CHARS = 16_000;
const MAX_ACTIVE_TASK_CHARS = 40_000;
const MAX_HISTORY_ENTRY_CHARS = 8_000;
const MAX_ROLE_INSTRUCTIONS_CHARS = 8_000;
const OUTPUT_LIMIT = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
const UNCOMMITTED_ROUTE_TIMEOUT_MS = 55 * 1000;
const INIT_TIMEOUT_MS = 30 * 1000;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SSE_HEARTBEAT_MS = 15 * 1000;
const MAX_SESSIONS = 8;
const QUOTA_CACHE_MS = 30 * 1000;
const PRIMARY_QUOTA_BUCKET_IDS = ["3p-weekly", "3p-5h"];
const FALLBACK_QUOTA_BUCKET_IDS = ["gemini-weekly", "gemini-5h"];
const MODEL_QUOTA_FAILURE = /RESOURCE_EXHAUSTED|LLM_CALL_QUOTA_EXCEEDED|individual quota reached|exhausted your (?:capacity|quota)(?: on this model)?|quota[^\r\n]{0,100}(?:exhaust|exceed|deplet|reach)/i;
const PROVIDER_FAILURE_SIGNAL = /RESOURCE_EXHAUSTED|LLM_CALL_QUOTA_EXCEEDED|individual quota reached|exhausted your (?:capacity|quota)|agent executor error|calling model:/i;
const INTERRUPTED_STREAM_FAILURE = /the stream was interrupted\.\s*please continue the task you were working on\./i;
const STREAM_CONTINUATION_BACKOFF_BASE_MS = 1_000;
const STREAM_CONTINUATION_BACKOFF_MAX_MS = 10_000;
const STREAM_CONTINUATION_RECOVERY_BUDGET_MS = 45_000;
const CENTRAL_CONFIG = join(homedir(), ".codex", "subagent-models.json");
const AGY_EXE = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "agy", "bin", "agy.exe");
const MCP_CONFIG = join(homedir(), ".gemini", "config", "mcp_config.json");
const LAZY_MCP_SERVER = "rzcodex-lazy";
const AGENT_ID = "rzcodex-native";
const AGENT_DEFINITION_PATH = join(homedir(), ".gemini", "config", "agents", AGENT_ID, "agent.md");
const AGENT_DEFINITION = `---
name: ${AGENT_ID}
description: Restricted primary agent used by RzCodex native workers.
tools:
  - view_file
  - list_dir
  - find_by_name
  - grep_search
  - run_command
  - manage_task
  - write_to_file
  - replace_file_content
  - search_web
  - read_url_content
mainAgent: true
subagent: false
forceDisableFundamentalComponents: true
commandExecutionPolicy: eager
inheritCustomizations: false
---

# RzCodex native worker

You are already a bounded native sub-agent owned by a separate Codex main agent. Work directly on the assigned task. Never delegate, invoke another agent, define an agent, or create background work. Honor project AGENTS.md ownership boundaries exactly; when builds, tests, editor control, PIE, runtime validation, or RzMCP execution are reserved to the parent, do not invoke them and instead report the exact checks the parent should run. Use run_command for read-only inspection only; never edit, create, move, delete, build, test, or invoke a side-effecting script through it. On Windows, use PowerShell-native commands, single-quote ripgrep patterns containing |, and never assume Unix-only commands such as head are installed. A long run_command may be moved to the background by the client runtime; manage only that command with manage_task and do not poll it repeatedly. If manage_task reports that exact command is still running and there is no other useful work, schedule at most one wait of 10 seconds or less with Prompt "Wait for task-N to finish" and TimerCondition set to that exact task; never use schedule for future work, recurring work, delegation, or a new prompt. Use the dedicated file tools for file mutations. Keep each reasoning/tool cycle focused, return promptly when the task is complete, and return a concise concrete blocker or question when the main agent must decide something.
`;
const MUTATION_TOOLS = new Set(["multi_replace_file_content", "replace_file_content", "sed_file", "write_to_file"]);
const BOUNDED_WAIT_TOOL = "schedule";
const MAX_BOUNDED_WAIT_SECONDS = 10;
const FORBIDDEN_AGENT_TOOLS = new Set([
  "browser_subagent",
  "define_subagent",
  "invoke_subagent",
  "manage_inbox",
  "manage_subagents",
  "send_message",
]);
const REQUIRED_AGENT_TOOLS = new Set(["call_mcp_tool", "grep_search", "manage_task", "replace_file_content", "run_command", "view_file", "write_to_file"]);

class BridgeError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
    this.code = code;
  }
}

function json(value) {
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isBoundedTaskWait(parameters, conversationId) {
  if (!parameters || typeof parameters !== "object" || typeof conversationId !== "string" || !conversationId) return false;
  const durationSeconds = Number(parameters.DurationSeconds ?? parameters.duration_seconds);
  const prompt = String(parameters.Prompt ?? parameters.prompt ?? "").trim();
  const timerCondition = String(parameters.TimerCondition ?? parameters.timer_condition ?? "").trim();
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > MAX_BOUNDED_WAIT_SECONDS) return false;
  const qualifiedPrefix = `${conversationId}/task-`;
  const taskNumber = timerCondition.startsWith(qualifiedPrefix)
    ? timerCondition.slice(qualifiedPrefix.length)
    : /^task-\d+$/.test(timerCondition)
      ? timerCondition.slice("task-".length)
      : null;
  if (taskNumber === null || !/^\d+$/.test(taskNumber)) return false;
  return new RegExp(`^wait (?:briefly )?for task-${taskNumber} to (?:finish|complete)[.!]?$`, "i").test(prompt);
}

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

function sanitizedEnvironment(source = process.env) {
  const env = { ...source, NO_COLOR: "1" };
  for (const key of [
    "ANTHROPIC_API_KEY", "AZURE_OPENAI_API_KEY", "CODEBUDDY_API_KEY", "CODEX_API_KEY",
    "COGNITION_API_KEY", "COMMAND_CODE_API_KEY", "DEVIN_API_KEY", "GEMINI_API_KEY",
    "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT",
    "OPENAI_API_KEY", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "OPENROUTER_API_KEY",
    "TENCENT_API_KEY", "TENCENTCLOUD_SECRET_ID", "TENCENTCLOUD_SECRET_KEY",
    "VERTEX_AI_API_KEY",
  ]) delete env[key];
  return env;
}

function ensureAgentDefinition() {
  mkdirSync(join(homedir(), ".gemini", "config", "agents", AGENT_ID), { recursive: true });
  const current = existsSync(AGENT_DEFINITION_PATH)
    ? readFileSync(AGENT_DEFINITION_PATH, "utf8")
    : null;
  if (current !== AGENT_DEFINITION) writeFileSync(AGENT_DEFINITION_PATH, AGENT_DEFINITION, "utf8");
  return sha256(AGENT_DEFINITION);
}

function providerFailureDetail(result, stderr) {
  const details = [];
  const add = (value) => {
    if (typeof value !== "string") return;
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized && !details.includes(normalized)) details.push(normalized.slice(0, 600));
  };
  add(result?.error);
  add(result?.error?.message);
  add(result?.message);
  if (typeof result?.response === "string" && PROVIDER_FAILURE_SIGNAL.test(result.response)) {
    add(result.response);
  }
  const diagnosticLines = String(stderr || "").split(/\r?\n/)
    .filter((line) => PROVIDER_FAILURE_SIGNAL.test(line));
  for (const line of diagnosticLines.slice(-3)) {
    add(line.replace(/^.*?(?:run\.go|errorreport\.go):\d+\]\s*/, ""));
  }
  return details.join(" | ").slice(0, 1_500);
}

function attachTurnProgress(error, turn) {
  error.toolCalls = turn.toolStepKeys.size;
  error.toolNames = [...turn.toolNames];
  error.mutationToolCalls = turn.mutationToolStepKeys.size;
  error.rzMcpTools = [...turn.rzMcpTools];
  error.subagentActivity = turn.subagentActivity;
  error.forbiddenToolName = turn.forbiddenToolName;
  error.peakContextTokens = Number(turn.peakContextTokens || 0);
  error.generatedTokens = Number(turn.generatedTokens || 0);
  error.generationSeconds = Number(turn.generationSeconds || 0);
  if (
    error.toolCalls > 0
    || error.rzMcpTools.length > 0
    || error.subagentActivity
    || error.forbiddenToolName
  ) {
    error.routeCommitted = true;
  }
  return error;
}

function uncommittedMutationRouteTimeoutError() {
  const error = new BridgeError(
    `Antigravity did not begin provider tool work within ${UNCOMMITTED_ROUTE_TIMEOUT_MS}ms`,
    504,
  );
  error.uncommittedRouteTimeout = true;
  error.safeToRetry = true;
  error.routeCommitted = false;
  return error;
}

function classifyUncommittedRouteTimeout(error, turn) {
  const classified = attachTurnProgress(error, turn);
  if (classified.uncommittedRouteTimeout !== true) return classified;
  classified.safeToRetry = classified.toolCalls === 0
    && classified.rzMcpTools.length === 0
    && !classified.subagentActivity
    && !classified.forbiddenToolName;
  classified.routeCommitted = !classified.safeToRetry;
  return classified;
}

function clearUncommittedRouteTimer(turn) {
  if (!turn?.uncommittedRouteTimer) return;
  clearTimeout(turn.uncommittedRouteTimer);
  turn.uncommittedRouteTimer = null;
}

function centralRoute() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(CENTRAL_CONFIG, "utf8"));
  } catch (error) {
    throw new BridgeError(`Cannot read central subagent configuration: ${error.message}`, 500);
  }
  const route = assertObject(parsed[PROVIDER_ID], `central route ${PROVIDER_ID}`);
  if (!Array.isArray(route.inputModalities) || route.inputModalities.length !== 1 || route.inputModalities[0] !== "text") {
    throw new BridgeError("Antigravity managed route must declare exactly the text modality", 500);
  }
  return {
    primaryModel: requireString(route.primaryModel, "antigravity.primaryModel"),
    quotaFallbackModel: requireString(route.quotaFallbackModel, "antigravity.quotaFallbackModel"),
    inputModalities: route.inputModalities,
  };
}

function verifyModelAvailable(model) {
  const result = spawnSync(AGY_EXE, ["models"], {
    env: sanitizedEnvironment(), windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
    timeout: 15_000,
  });
  if (result.status !== 0) {
    throw new BridgeError(`Cannot query Antigravity models: ${result.stderr || result.stdout}`, 500);
  }
  const exact = result.stdout.split(/\r?\n/).find((line) => line.trim().split(/\s+/)[0] === model);
  if (!exact) throw new BridgeError(`Configured Antigravity model ${json(model)} is unavailable`, 500);
  return exact.trim().slice(model.length).trim() || model;
}

function parseQuotaSnapshot(stdout, fetchedAt = Date.now()) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch (error) {
    throw new BridgeError(`Antigravity quota output is not valid JSON: ${error.message}`, 502);
  }
  if (payload.status !== "SUCCESS" || payload.command?.name !== "usage") {
    throw new BridgeError(`Antigravity quota query returned an unexpected payload: ${json(payload.status)}`, 502);
  }
  const buckets = (payload.command?.data?.groups || []).flatMap((group) =>
    (group.buckets || []).map((bucket) => ({ ...bucket, group: group.name })));
  const readBucket = (id, label, required = true) => {
    const bucket = buckets.find((entry) => entry.id === id);
    if (!bucket) {
      if (!required) return null;
      throw new BridgeError(`Antigravity quota query omitted ${label} bucket ${json(id)}`, 502);
    }
    const remainingFraction = Number(bucket.remaining_fraction);
    const resetTime = typeof bucket.reset_time === "string" ? bucket.reset_time.trim() : "";
    const resetAt = resetTime ? Date.parse(resetTime) : null;
    if (!Number.isFinite(remainingFraction) || remainingFraction < 0 || remainingFraction > 1) {
      throw new BridgeError(`Antigravity ${label} quota has invalid remaining fraction ${json(bucket.remaining_fraction)}`, 502);
    }
    if (resetAt !== null && !Number.isFinite(resetAt)) {
      throw new BridgeError(`Antigravity ${label} quota has invalid reset time ${json(bucket.reset_time)}`, 502);
    }
    return {
      id,
      group: bucket.group,
      remainingFraction,
      resetAt: resetAt === null ? null : new Date(resetAt).toISOString(),
    };
  };
  const readPool = (ids, label) => {
    const poolBuckets = ids
      .map((id, index) => readBucket(id, label, index === 0))
      .filter(Boolean);
    const remainingFraction = Math.min(...poolBuckets.map((bucket) => bucket.remainingFraction));
    const limitingBuckets = poolBuckets.filter((bucket) => bucket.remainingFraction === remainingFraction);
    const limitingResetTimes = limitingBuckets
      .map((bucket) => Date.parse(bucket.resetAt))
      .filter(Number.isFinite);
    return {
      group: poolBuckets[0].group,
      remainingFraction,
      resetAt: limitingResetTimes.length > 0
        ? new Date(Math.max(...limitingResetTimes)).toISOString()
        : null,
      buckets: poolBuckets,
    };
  };
  return {
    fetchedAt: new Date(fetchedAt).toISOString(),
    primary: readPool(PRIMARY_QUOTA_BUCKET_IDS, "Claude/GPT"),
    fallback: readPool(FALLBACK_QUOTA_BUCKET_IDS, "Gemini"),
  };
}

class AntigravityQuotaRouter {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.cached = null;
    this.refreshes = 0;
    this.lastError = null;
  }

  snapshot(force = false) {
    const now = this.now();
    const fetchedAt = this.cached ? Date.parse(this.cached.fetchedAt) : 0;
    if (!force && this.cached && now - fetchedAt < QUOTA_CACHE_MS) return this.cached;
    const result = spawnSync(AGY_EXE, ["-p", "/quota", "--output-format", "json"], {
      env: sanitizedEnvironment(),
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 15_000,
    });
    if (result.status !== 0) {
      this.lastError = String(result.stderr || result.stdout || `exit ${result.status}`).slice(0, 2_000);
      throw new BridgeError(`Cannot query Antigravity quota: ${this.lastError}`, 502);
    }
    this.cached = parseQuotaSnapshot(result.stdout, now);
    this.refreshes += 1;
    this.lastError = null;
    return this.cached;
  }

  select(existingModel = null) {
    const snapshot = this.snapshot();
    if (existingModel === route.quotaFallbackModel) {
      if (snapshot.fallback.remainingFraction > 0) return models.fallback;
      throw this.exhausted(snapshot);
    }
    if (snapshot.primary.remainingFraction > 0) return models.primary;
    if (snapshot.fallback.remainingFraction > 0) return models.fallback;
    throw this.exhausted(snapshot);
  }

  markDepleted(model) {
    const snapshot = this.snapshot();
    const bucket = model === route.primaryModel
      ? snapshot.primary
      : model === route.quotaFallbackModel
        ? snapshot.fallback
        : null;
    if (!bucket) throw new BridgeError(`Cannot mark unknown Antigravity model ${json(model)} depleted`, 500);
    bucket.remainingFraction = 0;
    bucket.forcedDepleted = true;
  }

  exhausted(snapshot) {
    return new BridgeError(
      `Both Antigravity usage pools are depleted; Claude/GPT resets ${snapshot.primary.resetAt || "at an unknown time"}, Gemini resets ${snapshot.fallback.resetAt || "at an unknown time"}`,
      429,
    );
  }

  health() {
    return {
      refreshes: this.refreshes,
      lastError: this.lastError,
      snapshot: this.cached,
    };
  }
}

function verifyLazyMcpConfig() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(MCP_CONFIG, "utf8"));
  } catch (error) {
    throw new BridgeError(`Cannot read Antigravity MCP configuration: ${error.message}`, 500);
  }
  const server = parsed?.mcpServers?.[LAZY_MCP_SERVER];
  if (!server || server.disabled === true || typeof server.command !== "string") {
    throw new BridgeError(`Antigravity MCP server ${LAZY_MCP_SERVER} is not enabled`, 500);
  }
  return { command: server.command, argumentCount: Array.isArray(server.args) ? server.args.length : 0 };
}

function contentText(value, label) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw new BridgeError(`${label} must be a string or array`);
  return value.map((entry, index) => {
    const item = assertObject(entry, `${label}[${index}]`);
    if (!["input_text", "output_text", "text"].includes(item.type)) {
      throw new BridgeError(`${label}[${index}] has unsupported text content type ${json(item.type)}`);
    }
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
  return (matches.at(-1)?.[1]?.trim() || "").slice(-MAX_ROLE_INSTRUCTIONS_CHARS);
}

function environmentWorkingDirectoryFrom(input) {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!item || item.type !== "message") continue;
    const text = contentText(item.content, `input[${index}].content`);
    const matches = [...text.matchAll(/<environment_context>[\s\S]*?<cwd>\s*([^<\r\n]+?)\s*<\/cwd>[\s\S]*?<\/environment_context>/gi)];
    const cwd = matches.at(-1)?.[1]?.trim();
    if (cwd && isAbsolute(cwd) && existsSync(cwd)) return normalize(cwd);
  }
  return null;
}

function workingDirectoryFrom(body, input) {
  const cwd = body.client_metadata?.cwd;
  if (typeof cwd === "string" && isAbsolute(cwd) && existsSync(cwd)) return normalize(cwd);
  const environmentCwd = environmentWorkingDirectoryFrom(input);
  if (environmentCwd) return environmentCwd;
  throw new BridgeError("Antigravity request has no valid authoritative working directory");
}

function delegationContract(requestId, workingDirectory) {
  return `[Native Antigravity delegation contract]\nRzCodex request ID: ${requestId}\nWork directly in the supplied workspace as the bounded native sub-agent. Use Antigravity's local file and shell tools; do not emit Codex tool calls and do not invoke Antigravity subagents. AGY's run_command tool starts in an internal scratch directory, so every shell command must begin by changing to the authoritative workspace with Set-Location -LiteralPath, and every file-tool path must be absolute. For Unreal/RzMCP work, use only MCP server ${LAZY_MCP_SERVER}: discover a small focused schema with search_rzmcp_tools, then call only a discovered tool through call_rzmcp_tool. Never request or enumerate the full RzMCP catalog. Return concise evidence as soon as the bounded task is complete or genuinely blocked.\nAuthoritative workspace: ${workingDirectory}`;
}

function mainAgentContract(requestId, workingDirectory) {
  return `[RzCodex main-agent contract]\nRzCodex request ID: ${requestId}\nAct as the primary coding agent for this conversation. Use Antigravity's local file and shell tools directly; do not emit Codex tool calls and do not invoke Antigravity subagents. AGY's run_command tool starts in an internal scratch directory, so every shell command must begin by changing to the authoritative workspace with Set-Location -LiteralPath, and every file-tool path must be absolute. Follow the complete RzCodex, project, and user instructions supplied this turn, preserve unrelated work, verify changes in proportion to risk, and return only after the current user request is complete or concretely blocked. For Unreal/RzMCP work, use only MCP server ${LAZY_MCP_SERVER}: discover a small focused schema with search_rzmcp_tools, then call only a discovered tool through call_rzmcp_tool.\nAuthoritative workspace: ${workingDirectory}`;
}

function messageKey(item, text) {
  const identity = typeof item.id === "string" ? item.id : `${item.type}:${item.role || ""}`;
  return `${identity}:${sha256(text)}`;
}

function historyEntries(input, taskState) {
  const agentMessages = new Map(taskState.messages.map((message) => [message.index, message]));
  const entries = [];
  for (let index = 0; index < input.length; index += 1) {
    const item = assertObject(input[index], `input[${index}]`);
    let text = "";
    let checkpoint = false;
    if (item.type === "message") {
      if (["system", "developer"].includes(item.role)) continue;
      text = `[${item.role}]\n${contentText(item.content, `input[${index}].content`)}`;
    } else if (item.type === "agent_message") {
      const message = agentMessages.get(index) ?? {
        ...normalizeAgentMessageContent(item.content, `input[${index}].content`),
        author: item.author || "Codex",
        recipient: item.recipient || "managed worker",
        newTask: false,
        checkpoint: false,
      };
      if (message.newTask) continue;
      if (message.index === taskState.referencedPriorControl?.index) continue;
      checkpoint = message.checkpoint;
      text = `[Inter-agent message ${message.author} -> ${message.recipient}]\n${message.text}`;
    } else if (["function_call", "custom_tool_call", "tool_search_call"].includes(item.type)) {
      text = `[Prior Codex tool request ${item.name || "tool_search"}; call_id=${item.call_id}]`;
    } else if (["function_call_output", "custom_tool_call_output"].includes(item.type)) {
      text = `[Prior Codex tool result; call_id=${item.call_id}]\n${outputText(item.output)}`;
    } else if (item.type === "tool_search_output") {
      text = `[Prior Codex tool search result; call_id=${item.call_id}]`;
    } else if (item.type === "reasoning") {
      if (isBridgeProgressReasoning(item)) continue;
      const summary = Array.isArray(item.summary) ? item.summary.map((part) => part?.text || "").join("") : "";
      if (!summary) continue;
      text = `[Prior reasoning summary]\n${summary}`;
    } else if (["compaction", "context_compaction", "compaction_trigger"].includes(item.type)) {
      continue;
    } else {
      throw new BridgeError(`input[${index}] has unsupported type ${json(item.type)}`);
    }
    text = text.slice(-MAX_HISTORY_ENTRY_CHARS);
    entries.push({ index, checkpoint, text, key: messageKey(item, text) });
  }
  return entries;
}

function boundedEntries(entries, budget, activeTaskText, entrySeparatorChars = 0) {
  const retained = [];
  let remaining = Math.max(0, budget);
  for (let index = entries.length - 1; index >= 0 && remaining > entrySeparatorChars; index -= 1) {
    let text = entries[index].text;
    if (activeTaskText) text = text.split(activeTaskText).join("[duplicate active task omitted]");
    const textBudget = remaining - entrySeparatorChars;
    if (text.length > textBudget) text = text.slice(-textBudget);
    retained.unshift({ ...entries[index], text });
    remaining -= text.length + entrySeparatorChars;
  }
  return retained;
}

function requestContext(body) {
  assertObject(body, "request body");
  if (body.stream !== true) throw new BridgeError("The Antigravity bridge requires stream=true");
  const requestedModel = requireString(body.model, "model");
  const mainAgent = requestedModel === MAIN_MODEL_ALIAS;
  if (requestedModel !== MODEL_ALIAS && requestedModel !== MAIN_MODEL_ALIAS) {
    throw new BridgeError(`Unknown managed model alias ${json(body.model)}`);
  }
  const effort = body.reasoning?.effort;
  if (effort !== undefined && effort !== REQUIRED_EFFORT) {
    throw new BridgeError(`Antigravity bridge requires centrally configured effort ${REQUIRED_EFFORT}`);
  }
  const input = typeof body.input === "string"
    ? [{ type: "message", role: "user", content: body.input }]
    : body.input;
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
  const entries = historyEntries(input, taskState);
  const threadId = typeof body.client_metadata?.thread_id === "string" && body.client_metadata.thread_id
    ? body.client_metadata.thread_id
    : null;
  const conversationKey = threadId || taskState.activeTask?.name || null;
  const sessionKey = conversationKey
    ? `${conversationKey}:${mainAgent ? "main" : "subagent"}`
    : null;
  return {
    requestId,
    workingDirectory,
    threadId,
    sessionKey,
    modelAlias: requestedModel,
    mainAgent,
    roleInstructions: mainAgent ? "" : roleInstructionsFrom(body.instructions),
    mainInstructions: mainAgent && typeof body.instructions === "string" ? body.instructions.trim() : "",
    taskState,
    entries,
    messageKeys: new Set(entries.map((entry) => entry.key)),
    toolSchemaBytes: Buffer.byteLength(json(body.tools || [])),
  };
}

function fullPrompt(context) {
  const sections = [
    context.mainAgent
      ? mainAgentContract(context.requestId, context.workingDirectory)
      : delegationContract(context.requestId, context.workingDirectory),
    projectInstructionsPromptSection(context.workingDirectory),
  ];
  if (context.mainAgent) {
    if (context.mainInstructions) sections.push(`[RzCodex instructions]\n${context.mainInstructions}`);
  } else if (context.roleInstructions) {
    sections.push(`[Role instructions]\n${context.roleInstructions}`);
  }
  const referencedPriorTask = context.mainAgent ? "" : referencedPriorTaskPromptSection(context.taskState);
  const activeTask = context.mainAgent ? "" : activeTaskPromptSection(context.taskState);
  const taskControlSections = context.mainAgent ? [] : taskControlPromptSections(context.taskState);
  const mandatorySectionCount = sections.length + (referencedPriorTask ? 1 : 0) + (activeTask ? 1 : 0) + taskControlSections.length;
  const mandatoryChars = sections.reduce((sum, section) => sum + section.length, 0)
    + referencedPriorTask.length
    + activeTask.length
    + taskControlSections.reduce((sum, section) => sum + section.length, 0)
    + Math.max(0, mandatorySectionCount - 1) * 2;
  if (mandatoryChars > MAX_PROMPT_CHARS) {
    throw new BridgeError("Antigravity mandatory task context exceeded its hard prompt limit", 400);
  }
  const retained = boundedEntries(
    context.entries,
    MAX_PROMPT_CHARS - mandatoryChars,
    context.taskState.activeTask?.text,
    2,
  );
  if (activeTask) {
    const activeIndex = context.taskState.activeTask.index;
    sections.push(...retained.filter((entry) => entry.index < activeIndex && !entry.checkpoint).map((entry) => entry.text));
    if (referencedPriorTask) sections.push(referencedPriorTask);
    sections.push(activeTask);
    sections.push(...retained.filter((entry) => entry.index > activeIndex && !entry.checkpoint).map((entry) => entry.text));
    sections.push(...retained.filter((entry) => entry.checkpoint).map((entry) => entry.text));
  } else {
    sections.push(...retained.map((entry) => entry.text));
  }
  sections.push(...taskControlSections);
  const prompt = sections.join("\n\n");
  if (prompt.length > MAX_PROMPT_CHARS) throw new BridgeError("Normalized Antigravity prompt exceeded its hard limit", 500);
  return prompt;
}

function resumePrompt(context, session) {
  const unseen = context.entries.filter((entry) => !session.seenMessageKeys.has(entry.key));
  const taskControlSections = context.mainAgent ? [] : taskControlPromptSections(context.taskState);
  const controlChars = taskControlSections.reduce((sum, section) => sum + section.length + 2, 0);
  const retained = boundedEntries(
    unseen,
    MAX_RESUME_PROMPT_CHARS - controlChars,
    context.taskState.activeTask?.text,
  );
  const resumeHeader = context.mainAgent
    ? `[RzCodex main-agent continuation]\nContinue this conversation as the primary coding agent in ${context.workingDirectory}. Use your local tools directly and return only when the current user request is complete or concretely blocked.`
    : `[Native Antigravity resume]\nContinue the retained active task in ${context.workingDirectory}. Task hash: ${context.taskState.activeTask?.hash || "none"}. The original task remains authoritative; do not restart the investigation.`;
  const sections = [
    resumeHeader,
    ...retained.filter((entry) => !entry.checkpoint).map((entry) => entry.text),
    ...retained.filter((entry) => entry.checkpoint).map((entry) => entry.text),
    ...taskControlSections,
  ];
  if (retained.length === 0) sections.push("Continue from the retained provider state and return when complete or concretely blocked.");
  return sections.join("\n\n");
}

function subtractUsage(current, previous) {
  const result = {};
  for (const key of ["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens"]) {
    const currentValue = Number(current?.[key] || 0);
    const previousValue = Number(previous?.[key] || 0);
    result[key] = Math.max(0, currentValue - previousValue);
  }
  return result;
}

function abortError() {
  return new BridgeError("Client disconnected while Antigravity was active", 499);
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

function streamContinuationBackoffMs(attempt) {
  return Math.min(
    STREAM_CONTINUATION_BACKOFF_BASE_MS * (2 ** Math.max(0, attempt - 1)),
    STREAM_CONTINUATION_BACKOFF_MAX_MS,
  );
}

function emptyInterruptedProgress() {
  return {
    streamContinuations: 0,
    toolCalls: 0,
    toolNames: new Set(),
    mutationToolCalls: 0,
    rzMcpTools: new Set(),
    subagentActivity: false,
    forbiddenToolName: null,
    peakContextTokens: 0,
    generatedTokens: 0,
    generationSeconds: 0,
    durationSeconds: 0,
  };
}

function accumulateInterruptedProgress(progress, source) {
  progress.toolCalls += Number(source?.toolCalls || 0);
  for (const name of source?.toolNames || []) progress.toolNames.add(name);
  progress.mutationToolCalls += Number(source?.mutationToolCalls || 0);
  for (const name of source?.rzMcpTools || []) progress.rzMcpTools.add(name);
  progress.subagentActivity ||= source?.subagentActivity === true;
  progress.forbiddenToolName ||= source?.forbiddenToolName || null;
  progress.peakContextTokens = Math.max(progress.peakContextTokens, Number(source?.peakContextTokens || 0));
  progress.generatedTokens += Number(source?.generatedTokens || 0);
  progress.generationSeconds += Number(source?.generationSeconds || 0);
  progress.durationSeconds += Number(source?.durationSeconds || 0);
}

function applyInterruptedProgress(target, progress) {
  target.streamContinuations = progress.streamContinuations;
  target.toolCalls = progress.toolCalls + Number(target.toolCalls || 0);
  target.toolNames = [...new Set([...progress.toolNames, ...(target.toolNames || [])])];
  target.mutationToolCalls = progress.mutationToolCalls + Number(target.mutationToolCalls || 0);
  target.rzMcpTools = [...new Set([...progress.rzMcpTools, ...(target.rzMcpTools || [])])];
  target.subagentActivity = progress.subagentActivity || target.subagentActivity === true;
  target.forbiddenToolName = progress.forbiddenToolName || target.forbiddenToolName || null;
  target.peakContextTokens = Math.max(progress.peakContextTokens, Number(target.peakContextTokens || 0));
  target.generatedTokens = progress.generatedTokens + Number(target.generatedTokens || 0);
  target.generationSeconds = progress.generationSeconds + Number(target.generationSeconds || 0);
  target.durationSeconds = progress.durationSeconds + Number(target.durationSeconds || 0);
  return target;
}

function interruptedStreamContinuationPrompt(session) {
  return `[Native Antigravity stream recovery]\nThe upstream stream was interrupted. Continue the same retained task and conversation from its current state. Task hash: ${session.activeTaskHash || "none"}. Do not repeat completed tool calls or file edits. Return when complete or concretely blocked.`;
}

async function runWithInterruptedStreamRecovery(
  session,
  prompt,
  signal,
  onProgress = () => {},
  onRecovery = () => {},
  options = {},
) {
  const now = options.now || Date.now;
  const delay = options.delay || delayWithAbort;
  const requestDeadline = options.deadline || now() + REQUEST_TIMEOUT_MS;
  const uncommittedRouteDeadline = options.uncommittedRouteDeadline || null;
  const recoveryBudgetMs = options.recoveryBudgetMs || STREAM_CONTINUATION_RECOVERY_BUDGET_MS;
  const conversationId = session.init?.conversationId || null;
  const progress = emptyInterruptedProgress();
  let currentPrompt = prompt;
  let attempt = 0;
  let recoveryDeadline = null;
  for (;;) {
    if (signal?.aborted) {
      const error = applyInterruptedProgress(abortError(), progress);
      session.close?.();
      throw error;
    }
    const activeDeadline = recoveryDeadline || requestDeadline;
    const remainingMs = activeDeadline - now();
    if (remainingMs <= 0) {
      const error = applyInterruptedProgress(
        new BridgeError("Antigravity interrupted-stream recovery exceeded the request deadline", 504),
        progress,
      );
      session.close?.();
      throw error;
    }
    const hasProviderActivity = progress.toolCalls > 0;
    const remainingUncommittedMs = uncommittedRouteDeadline && !hasProviderActivity
      ? uncommittedRouteDeadline - now()
      : null;
    if (remainingUncommittedMs !== null && remainingUncommittedMs <= 0) {
      const error = applyInterruptedProgress(uncommittedMutationRouteTimeoutError(), progress);
      error.safeToRetry = error.toolCalls === 0 && error.rzMcpTools.length === 0;
      error.routeCommitted = !error.safeToRetry;
      session.close?.();
      throw error;
    }
    try {
      const result = await session.run(
        currentPrompt,
        signal,
        (event) => onProgress({ ...event, index: progress.toolCalls + event.index }),
        remainingMs,
        remainingUncommittedMs,
      );
      if ((result.conversationId || null) !== conversationId) {
        session.close?.();
        throw new BridgeError("Antigravity changed conversation during interrupted-stream recovery", 502);
      }
      const combined = applyInterruptedProgress(result, progress);
      combined.outputTokensPerSecond = combined.generationSeconds > 0
        ? combined.generatedTokens / combined.generationSeconds
        : null;
      return combined;
    } catch (error) {
      if (error?.sameSessionContinuation !== true) {
        throw applyInterruptedProgress(error, progress);
      }
      accumulateInterruptedProgress(progress, error);
      progress.streamContinuations += 1;
      if (attempt >= 1) {
        const exhaustedError = applyInterruptedProgress(
          new BridgeError("Antigravity remained stream-interrupted after one same-session continuation", 502),
          progress,
        );
        const committed = exhaustedError.toolCalls > 0 || exhaustedError.rzMcpTools.length > 0;
        exhaustedError.safeToRetry = !committed;
        exhaustedError.routeCommitted = committed;
        session.close?.();
        throw exhaustedError;
      }
      if (recoveryDeadline === null) {
        recoveryDeadline = Math.min(requestDeadline, now() + recoveryBudgetMs);
      }
      if (session.closed || (session.init?.conversationId || null) !== conversationId) {
        throw applyInterruptedProgress(
          new BridgeError("Antigravity lost the retained conversation after a stream interruption", 502),
          progress,
        );
      }
      attempt += 1;
      const backoffMs = streamContinuationBackoffMs(attempt);
      if (now() + backoffMs >= recoveryDeadline) {
        const deadlineError = applyInterruptedProgress(
          new BridgeError("Antigravity remained stream-interrupted until the request deadline", 504),
          progress,
        );
        session.close?.();
        throw deadlineError;
      }
      onRecovery({ attempt, backoffMs, conversationId });
      try {
        await delay(backoffMs, signal);
      } catch (delayError) {
        const error = applyInterruptedProgress(delayError, progress);
        if (error.status === 499) session.close?.();
        throw error;
      }
      currentPrompt = interruptedStreamContinuationPrompt(session);
    }
  }
}

function sessionArguments(selectedModel, conversationId = null) {
  return [
    "--input-format", "stream-json", "--output-format", "stream-json",
    "--agent", AGENT_ID,
    "--model", selectedModel.id,
    ...(selectedModel.effort ? ["--effort", selectedModel.effort] : []),
    ...(conversationId ? ["--conversation", conversationId] : []),
    "--dangerously-skip-permissions", "--disable-slash-commands",
    "--print-timeout", "30m",
  ];
}

class AntigravitySession {
  constructor(key, workingDirectory, activeTaskHash, selectedModel, onClose, conversationId = null) {
    this.key = key;
    this.workingDirectory = workingDirectory;
    this.activeTaskHash = activeTaskHash;
    this.model = selectedModel.id;
    this.modelLabel = selectedModel.label;
    this.modelEffort = selectedModel.effort;
    this.resumeConversationId = conversationId;
    this.onClose = onClose;
    this.seenMessageKeys = new Set();
    this.child = null;
    this.buffer = "";
    this.stderr = "";
    this.init = null;
    this.initSettled = false;
    this.turn = null;
    this.lastUsage = {};
    this.lastUsedAt = Date.now();
    this.idleTimer = null;
    this.closed = false;
  }

  get busy() {
    return this.turn !== null;
  }

  async start() {
    if (this.child) return this.initPromise;
    const args = sessionArguments(
      { id: this.model, effort: this.modelEffort },
      this.resumeConversationId,
    );
    this.child = spawn(AGY_EXE, args, {
      cwd: this.workingDirectory,
      env: sanitizedEnvironment(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.initPromise = new Promise((resolve, reject) => {
      this.resolveInit = resolve;
      this.rejectInit = reject;
    });
    const initTimer = setTimeout(() => this.fail(new BridgeError("Antigravity did not initialize in time", 504)), INIT_TIMEOUT_MS);
    this.initPromise.finally(() => clearTimeout(initTimer)).catch(() => {});
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-OUTPUT_LIMIT); });
    this.child.once("error", (error) => this.fail(new BridgeError(`Antigravity failed to start: ${error.message}`, 502)));
    this.child.once("close", (code) => {
      if (!this.closed) this.fail(new BridgeError(`Antigravity exited with code ${code}${this.stderr ? `: ${this.stderr.trim()}` : ""}`, 502));
    });
    return this.initPromise;
  }

  consume(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        this.fail(new BridgeError(`Antigravity emitted malformed stream JSON: ${error.message}`, 502));
        return;
      }
      try {
        this.consumeEvent(event);
      } catch (error) {
        this.fail(error instanceof BridgeError ? error : new BridgeError(`Invalid Antigravity event: ${error.message}`, 502));
        return;
      }
    }
  }

  consumeEvent(event) {
    if (event?.event === "init") {
      const init = assertObject(event.init, "Antigravity init");
      if (init.model !== this.model) {
        this.fail(new BridgeError(`Antigravity initialized unexpected model ${json(init.model)}`, 502));
        return;
      }
      if (init.agent !== AGENT_ID) {
        this.fail(new BridgeError(`Antigravity initialized unexpected agent ${json(init.agent)}`, 502));
        return;
      }
      if (init.permission_mode !== "always-proceed") {
        this.fail(new BridgeError(`Antigravity initialized unexpected permission mode ${json(init.permission_mode)}`, 502));
        return;
      }
      const initializedTools = new Set(Array.isArray(init.tools) ? init.tools : []);
      const reportedForbiddenTools = [...FORBIDDEN_AGENT_TOOLS].filter((name) => initializedTools.has(name));
      const missingTools = [...REQUIRED_AGENT_TOOLS].filter((name) => !initializedTools.has(name));
      if (missingTools.length > 0) {
        this.fail(new BridgeError(`Antigravity omitted required worker tools: ${missingTools.join(", ")}`, 502));
        return;
      }
      this.init = { ...init, conversationId: event.conversation_id };
      this.initSettled = true;
      runtime.lastAuthVerifiedAt = new Date().toISOString();
      runtime.lastInitializedToolCount = Array.isArray(init.tools) ? init.tools.length : null;
      runtime.lastInitializedForbiddenTools = reportedForbiddenTools;
      runtime.lastConversationId = event.conversation_id || null;
      this.resolveInit(this.init);
      return;
    }
    if (event?.event === "step_update" && this.turn) {
      const step = event.step_update || {};
      if (step.step_type === "agent_response" && step.state === "DONE") {
        const inputTokens = Number(step.usage?.input_tokens || 0) + Number(step.usage?.cache_read_tokens || 0);
        this.turn.peakContextTokens = Math.max(this.turn.peakContextTokens, inputTokens);
        this.turn.generatedTokens += Number(step.usage?.output_tokens || 0);
        this.turn.generationSeconds += Number(step.duration_seconds || 0);
      }
      if (step.step_type === "tool") {
        const name = step.tool_name || step.tool_info?.name;
        const parameters = step.tool_info?.parameters || {};
        const stepIndex = Number.isInteger(step.step_index) ? step.step_index : `unknown-${this.turn.unknownToolSteps++}`;
        const stepKey = `${step.conversation_id || this.init?.conversationId || "unknown"}:${stepIndex}`;
        const firstObservation = !this.turn.toolStepKeys.has(stepKey);
        this.turn.toolStepKeys.add(stepKey);
        this.turn.completedToolStepKeys ||= new Set();
        const completed = ["DONE", "COMPLETED", "SUCCESS"].includes(String(step.state || "").toUpperCase());
        const firstCompletedObservation = completed && !this.turn.completedToolStepKeys.has(stepKey);
        if (completed) this.turn.completedToolStepKeys.add(stepKey);
        if (typeof name === "string") this.turn.toolNames.add(name);
        if (firstObservation) clearUncommittedRouteTimer(this.turn);
        if (firstCompletedObservation) {
          this.turn.onProgress?.({
            kind: "tool",
            index: this.turn.completedToolStepKeys.size,
            name: typeof name === "string" ? name : "unknown_tool",
            input: parameters,
          });
        }
        if (firstCompletedObservation && MUTATION_TOOLS.has(name)) {
          this.turn.mutationToolStepKeys.add(stepKey);
        }
        const invalidBoundedWait = name === BOUNDED_WAIT_TOOL
          && step.state === "DONE"
          && !isBoundedTaskWait(parameters, this.init?.conversationId);
        if (firstObservation && (FORBIDDEN_AGENT_TOOLS.has(name) || invalidBoundedWait)) {
          this.turn.forbiddenToolName = name;
          const error = attachTurnProgress(
            new BridgeError(`Antigravity attempted forbidden orchestration tool ${json(name)}`, 502, "provider_state_changed"),
            this.turn,
          );
          this.fail(error);
          return;
        }
        if (name === "call_mcp_tool") {
          const server = parameters.ServerName || parameters.server_name || parameters.server || parameters.mcp_server;
          const tool = parameters.ToolName || parameters.tool_name || parameters.name;
          if (server === LAZY_MCP_SERVER && typeof tool === "string") {
            this.turn.rzMcpTools.add(tool);
            clearUncommittedRouteTimer(this.turn);
          }
        }
      }
      if (step.subagent_info) {
        this.turn.subagentActivity = true;
        const error = attachTurnProgress(
          new BridgeError("Antigravity attempted forbidden nested-agent activity", 502, "provider_state_changed"),
          this.turn,
        );
        this.fail(error);
      }
      return;
    }
    if (event?.event === "result" && this.turn) this.finishTurn(event.result);
  }

  run(prompt, signal, onProgress = () => {}, timeoutMs = REQUEST_TIMEOUT_MS, uncommittedTimeoutMs = null) {
    if (!this.init) throw new BridgeError("Antigravity session is not initialized", 500);
    if (this.turn) throw new BridgeError("Antigravity session already has an active turn", 409);
    if (signal?.aborted) throw new BridgeError("Client disconnected before Antigravity started", 499);
    clearTimeout(this.idleTimer);
    return new Promise((resolve, reject) => {
      const onAbort = () => this.close(new BridgeError("Client disconnected while Antigravity was active", 499));
      signal?.addEventListener("abort", onAbort, { once: true });
      const turn = {
        resolve,
        reject,
        cleanup: null,
        peakContextTokens: 0,
        generatedTokens: 0,
        generationSeconds: 0,
        toolNames: new Set(),
        toolStepKeys: new Set(),
        completedToolStepKeys: new Set(),
        mutationToolStepKeys: new Set(),
        rzMcpTools: new Set(),
        subagentActivity: false,
        forbiddenToolName: null,
        unknownToolSteps: 0,
        uncommittedRouteTimer: null,
        onProgress,
      };
      const timeout = setTimeout(() => this.close(new BridgeError(`Antigravity exceeded ${timeoutMs}ms`, 504)), timeoutMs);
      if (Number.isFinite(uncommittedTimeoutMs) && uncommittedTimeoutMs > 0) {
        turn.uncommittedRouteTimer = setTimeout(
          () => this.close(uncommittedMutationRouteTimeoutError()),
          uncommittedTimeoutMs,
        );
      }
      turn.cleanup = () => {
        clearTimeout(timeout);
        clearUncommittedRouteTimer(turn);
        signal?.removeEventListener("abort", onAbort);
      };
      this.turn = turn;
      this.child.stdin.write(`${json({ event: "user", message: { content: prompt } })}\n`, (error) => {
        if (error) this.fail(new BridgeError(`Cannot deliver the task to Antigravity: ${error.message}`, 502));
      });
    });
  }

  finishTurn(result) {
    const turn = this.turn;
    this.turn = null;
    turn.cleanup();
    if (!result || result.status !== "SUCCESS") {
      const detail = providerFailureDetail(result, this.stderr);
      const quotaFailure = MODEL_QUOTA_FAILURE.test(`${json(result || {})}\n${detail}`);
      const interruptedStream = !quotaFailure
        && INTERRUPTED_STREAM_FAILURE.test(`${json(result || {})}\n${detail}`);
      const error = attachTurnProgress(new BridgeError(
        quotaFailure
          ? `Antigravity model quota is depleted for ${this.model}${detail ? `: ${detail}` : ""}`
          : `Antigravity turn failed with status ${json(result?.status)}${detail ? `: ${detail}` : ""}`,
        quotaFailure ? 429 : 502,
      ), turn);
      error.durationSeconds = Number(result?.duration_seconds || 0);
      error.conversationId = result?.conversation_id || this.init?.conversationId || null;
      error.modelQuotaFailure = quotaFailure;
      error.sameSessionContinuation = interruptedStream;
      error.safeToRetry = !interruptedStream
        && error.toolCalls === 0
        && error.rzMcpTools.length === 0
        && !error.subagentActivity
        && !error.forbiddenToolName;
      error.routeCommitted = !error.safeToRetry;
      turn.reject(error);
      if (!interruptedStream) this.close();
      return;
    }
    if (typeof result.response !== "string" || result.response.length === 0) {
      turn.reject(new BridgeError("Antigravity completed without a response", 502));
      this.close();
      return;
    }
    const usage = subtractUsage(result.usage, this.lastUsage);
    this.lastUsage = result.usage || {};
    this.lastUsedAt = Date.now();
    this.idleTimer = setTimeout(() => this.close(), SESSION_IDLE_MS);
    turn.resolve({
      text: result.response,
      usage,
      peakContextTokens: turn.peakContextTokens,
      generatedTokens: turn.generatedTokens,
      generationSeconds: turn.generationSeconds,
      outputTokensPerSecond: turn.generationSeconds > 0 ? turn.generatedTokens / turn.generationSeconds : null,
      toolCalls: turn.completedToolStepKeys?.size ?? turn.toolStepKeys.size,
      toolNames: [...turn.toolNames],
      rzMcpTools: [...turn.rzMcpTools],
      mutationToolCalls: turn.mutationToolStepKeys.size,
      durationSeconds: Number(result.duration_seconds || 0),
      conversationId: result.conversation_id || this.init?.conversationId || null,
    });
  }

  fail(error) {
    if (!this.initSettled) {
      this.initSettled = true;
      this.rejectInit(error);
    }
    if (this.turn) {
      const turn = this.turn;
      this.turn = null;
      turn.cleanup();
      turn.reject(classifyUncommittedRouteTimeout(error, turn));
    }
    this.close();
  }

  close(error) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    if (error && this.turn) {
      const turn = this.turn;
      this.turn = null;
      turn.cleanup();
      turn.reject(classifyUncommittedRouteTimeout(error, turn));
    }
    if (this.child && !this.child.killed) this.child.kill();
    this.onClose(this);
  }
}

function writeSse(response, type, payload) {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: ${type}\ndata: ${json({ type, ...payload })}\n\n`);
}

function writeHeartbeat(response, responseId, modelAlias = MODEL_ALIAS) {
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

function usageFrom(result) {
  return {
    input_tokens: result.usage.input_tokens,
    input_tokens_details: { cached_tokens: result.usage.cache_read_tokens },
    output_tokens: result.usage.output_tokens,
    output_tokens_details: { reasoning_tokens: result.usage.thinking_tokens },
    total_tokens: result.usage.total_tokens,
  };
}

function emitCompleted(response, responseId, result, metadata, prefixOutput = [], modelAlias = MODEL_ALIAS) {
  const messageId = `msg_${randomUUID()}`;
  const outputIndex = prefixOutput.length;
  const item = {
    type: "message", id: messageId, status: "completed", role: "assistant",
    content: [{ type: "output_text", text: result.text, annotations: [] }],
  };
  writeSse(response, "response.output_item.added", {
    output_index: outputIndex,
    item: { ...item, status: "in_progress", content: [] },
  });
  writeSse(response, "response.content_part.added", {
    item_id: messageId, output_index: outputIndex, content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });
  writeSse(response, "response.output_text.delta", {
    item_id: messageId, output_index: outputIndex, content_index: 0, delta: result.text,
  });
  writeSse(response, "response.output_text.done", {
    item_id: messageId, output_index: outputIndex, content_index: 0, text: result.text,
  });
  writeSse(response, "response.content_part.done", {
    item_id: messageId, output_index: outputIndex, content_index: 0, part: item.content[0],
  });
  writeSse(response, "response.output_item.done", { output_index: outputIndex, item });
  const completed = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: modelAlias,
    output: [...prefixOutput, item],
    usage: usageFrom(result),
    error: null,
    incomplete_details: null,
    metadata,
  };
  writeSse(response, "response.completed", { response: completed });
}

function jsonResponse(response, status, value) {
  const body = json(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) {
        reject(new BridgeError(`Request exceeded ${MAX_REQUEST_BYTES} bytes`, 413));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(new BridgeError(`Malformed request JSON: ${error.message}`));
      }
    });
    request.once("error", reject);
  });
}

const route = centralRoute();
if (!existsSync(AGY_EXE)) throw new BridgeError(`Antigravity CLI is missing at ${AGY_EXE}`, 500);
const agentDefinitionHash = ensureAgentDefinition();
const models = {
  primary: { id: route.primaryModel, label: verifyModelAvailable(route.primaryModel), effort: null },
  fallback: {
    id: route.quotaFallbackModel,
    label: verifyModelAvailable(route.quotaFallbackModel),
    effort: REQUIRED_EFFORT,
  },
};
const mcpConfig = verifyLazyMcpConfig();
const quotaRouter = new AntigravityQuotaRouter();
quotaRouter.snapshot(true);
const sessions = new Map();
const retainedConversations = new Map();
const runtime = {
  incomingRequests: 0,
  completed: 0,
  failed: 0,
  rejected: 0,
  supersededTurns: 0,
  sessionsCreated: 0,
  sessionsReused: 0,
  quotaPoolSwitches: 0,
  streamContinuations: 0,
  lastStreamContinuations: 0,
  lastStreamContinuationAt: null,
  lastStreamContinuationConversationId: null,
  lastActualModel: null,
  lastActualModelLabel: null,
  lastAuthVerifiedAt: null,
  lastConversationId: null,
  lastInitializedToolCount: null,
  lastInitializedForbiddenTools: [],
  lastInputTokens: null,
  lastCachedInputTokens: null,
  lastOutputTokens: null,
  lastThinkingTokens: null,
  lastPeakTurnContextTokens: null,
  lastOutputTokensPerSecond: null,
  lastDurationSeconds: null,
  lastNativeToolCalls: 0,
  lastNativeToolNames: [],
  lastMutationToolCalls: 0,
  lastRzMcpTools: [],
  lastCodexToolSchemaBytesIgnored: 0,
  lastWorkingDirectory: null,
  lastTaskId: null,
  lastTaskHash: null,
  lastTaskDeliveryMode: null,
  lastCompleteTaskDelivered: false,
  lastProviderSessionReused: false,
  lastError: null,
};

function removeSession(session) {
  if (session.key && sessions.get(session.key) === session) sessions.delete(session.key);
}

function evictIdleSession() {
  const idle = [...sessions.values()].filter((session) => !session.busy)
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
  if (!idle) throw new BridgeError(`All ${MAX_SESSIONS} Antigravity sessions are busy`, 429);
  idle.close();
}

async function sessionFor(context) {
  let session = context.sessionKey ? sessions.get(context.sessionKey) : null;
  const taskHash = taskOwnershipHash(context.taskState);
  let retained = context.sessionKey ? retainedConversations.get(context.sessionKey) : null;
  if (retained && retained.taskHash !== taskHash) {
    retainedConversations.delete(context.sessionKey);
    retained = null;
  }
  const taskIncompatible = session && (
    session.closed
    || session.workingDirectory !== context.workingDirectory
    || session.activeTaskHash !== taskHash
  );
  if (taskIncompatible) {
    session.close();
    session = null;
  }
  if (session?.busy) {
    runtime.supersededTurns += 1;
    session.close(new BridgeError("Antigravity turn superseded by a newer turn for the same worker", 409));
    session = null;
  }
  const selectedModel = quotaRouter.select(session?.model || null);
  if (session && session.model !== selectedModel.id) {
    session.close();
    session = null;
    runtime.quotaPoolSwitches += 1;
  }
  if (session) {
    runtime.sessionsReused += 1;
    return { session, reused: true };
  }
  const resumeConversationId = retained?.model === selectedModel.id
    ? retained.conversationId
    : null;
  if (retained && !resumeConversationId) {
    retainedConversations.delete(context.sessionKey);
    retained = null;
  }
  if (sessions.size >= MAX_SESSIONS) evictIdleSession();
  const key = context.sessionKey || `ephemeral:${context.requestId}`;
  session = new AntigravitySession(
    key,
    context.workingDirectory,
    taskHash,
    selectedModel,
    removeSession,
    resumeConversationId,
  );
  sessions.set(key, session);
  runtime.sessionsCreated += 1;
  await session.start();
  return { session, reused: false };
}

async function handleResponses(request, response) {
  const body = await readRequestBody(request);
  const context = requestContext(body);
  const uncommittedRouteDeadline = Date.now() + UNCOMMITTED_ROUTE_TIMEOUT_MS;
  runtime.lastWorkingDirectory = context.workingDirectory;
  runtime.lastCodexToolSchemaBytesIgnored = context.toolSchemaBytes;
  runtime.lastTaskId = context.taskState.activeTask?.id || null;
  runtime.lastTaskHash = context.taskState.activeTask?.hash || null;
  runtime.lastTaskDeliveryMode = context.taskState.activeTask?.deliveryMode || null;
  runtime.lastStreamContinuations = 0;
  const responseId = `resp_${randomUUID()}`;
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  writeSse(response, "response.created", {
    response: { id: responseId, object: "response", model: context.modelAlias, status: "in_progress" },
  });
  writeHeartbeat(response, responseId, context.modelAlias);
  const progress = createProgressEmitter(response);
  const controller = new AbortController();
  let selectedSession;
  response.once("close", () => {
    if (response.writableEnded) return;
    const conversationId = selectedSession?.init?.conversationId;
    if (
      context.sessionKey
      && conversationId
      && selectedSession?.turn?.completedToolStepKeys?.size > 0
    ) {
      retainedConversations.set(context.sessionKey, {
        conversationId,
        model: selectedSession.model,
        taskHash: selectedSession.activeTaskHash,
      });
    }
    controller.abort();
  });
  const heartbeat = setInterval(() => writeHeartbeat(response, responseId, context.modelAlias), SSE_HEARTBEAT_MS);
  try {
    let { session, reused } = await sessionFor(context);
    selectedSession = session;
    progress.emit(`${context.mainAgent ? "Antigravity main agent" : "Antigravity native worker"} started with ${session.modelLabel}.\n`);
    let prompt = reused ? resumePrompt(context, session) : fullPrompt(context);
    const diagnosticsFor = (currentPrompt, currentReused) => {
      if (context.mainAgent) {
        return { taskId: null, taskName: null, taskHash: null, taskIntent: null, taskDeliveryMode: null, taskPartTypes: [], taskPartLengths: [], completeTaskDelivered: true, activeTaskIncludedThisTurn: true, retainedInProviderSession: currentReused };
      }
      try {
        return taskDeliveryDiagnostics(context.taskState, currentPrompt, {
          activeTaskIncludedThisTurn: !currentReused,
          retainedInProviderSession: currentReused,
        });
      } catch (error) {
        if (error instanceof TaskStateError) throw new BridgeError(error.message, 500);
        throw error;
      }
    };
    let diagnostics = diagnosticsFor(prompt, reused);
    runtime.lastCompleteTaskDelivered = diagnostics.completeTaskDelivered;
    let result;
    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    const runSession = (currentSession, currentPrompt) => runWithInterruptedStreamRecovery(
      currentSession,
      currentPrompt,
      controller.signal,
      ({ index, name, input }) => {
        progress.emit(formatNativeToolProgress("Antigravity", index, name, input));
      },
      ({ backoffMs, conversationId }) => {
        runtime.streamContinuations += 1;
        runtime.lastStreamContinuationAt = new Date().toISOString();
        runtime.lastStreamContinuationConversationId = conversationId;
        progress.emit(`Antigravity upstream stream interrupted; continuing the same conversation after ${backoffMs}ms.\n`);
      },
      { deadline, uncommittedRouteDeadline },
    );
    try {
      result = await runSession(session, prompt);
    } catch (error) {
      const modelQuotaFailure = error?.modelQuotaFailure === true;
      if (modelQuotaFailure) quotaRouter.markDepleted(session.model);
      const safeClaudeQuotaFailure = session.model === route.primaryModel
        && modelQuotaFailure
        && error?.safeToRetry === true;
      if (!safeClaudeQuotaFailure) throw error;
      runtime.quotaPoolSwitches += 1;
      ({ session, reused } = await sessionFor(context));
      selectedSession = session;
      progress.emit(`Antigravity quota route switched to ${session.modelLabel}.\n`);
      prompt = fullPrompt(context);
      diagnostics = diagnosticsFor(prompt, false);
      result = await runSession(session, prompt);
    }
    for (const key of context.messageKeys) session.seenMessageKeys.add(key);
    runtime.completed += 1;
    runtime.lastActualModel = session.model;
    runtime.lastActualModelLabel = session.modelLabel;
    runtime.lastInputTokens = result.usage.input_tokens;
    runtime.lastCachedInputTokens = result.usage.cache_read_tokens;
    runtime.lastOutputTokens = result.usage.output_tokens;
    runtime.lastThinkingTokens = result.usage.thinking_tokens;
    runtime.lastPeakTurnContextTokens = result.peakContextTokens;
    runtime.lastOutputTokensPerSecond = result.outputTokensPerSecond;
    runtime.lastDurationSeconds = result.durationSeconds;
    runtime.lastNativeToolCalls = result.toolCalls;
    runtime.lastNativeToolNames = result.toolNames;
    runtime.lastMutationToolCalls = result.mutationToolCalls;
    runtime.lastRzMcpTools = result.rzMcpTools;
    runtime.lastStreamContinuations = result.streamContinuations;
    runtime.lastConversationId = result.conversationId;
    runtime.lastCompleteTaskDelivered = diagnostics.completeTaskDelivered;
    runtime.lastProviderSessionReused = reused;
    runtime.lastError = null;
    if (context.sessionKey) retainedConversations.delete(context.sessionKey);
    const progressItems = progress.finish();
    emitCompleted(response, responseId, result, {
      provider: PROVIDER_ID,
      actual_provider: PROVIDER_ID,
      actual_model: session.model,
      actual_model_label: session.modelLabel,
      reasoning_effort: session.modelEffort || "model-default-thinking",
      auth_source: "Antigravity cached OAuth session",
      conversation_id: result.conversationId,
      provider_session_reused: reused,
      interrupted_stream_continuations: result.streamContinuations,
      peak_turn_context_tokens: result.peakContextTokens,
      output_tokens_per_second: result.outputTokensPerSecond,
      native_tool_calls: result.toolCalls,
      native_tool_names: result.toolNames,
      mutation_tool_calls: result.mutationToolCalls,
      rzmcp_tools_called: result.rzMcpTools,
      lazy_rzmcp_proxy_tools: 2,
      codex_tool_schema_bytes_ignored: context.toolSchemaBytes,
      codex_tool_schema_bytes_forwarded: 0,
      active_task_id: diagnostics.taskId,
      active_task_hash: diagnostics.taskHash,
      active_task_delivery_mode: diagnostics.taskDeliveryMode,
      active_task_included_this_turn: diagnostics.activeTaskIncludedThisTurn,
      active_task_retained_in_provider_session: diagnostics.retainedInProviderSession,
      complete_active_task_delivered: diagnostics.completeTaskDelivered,
    }, progressItems, context.modelAlias);
    response.end();
    if (!context.sessionKey) session.close();
  } catch (error) {
    runtime.failed += 1;
    progress.finish();
    runtime.lastError = String(error?.message || error).slice(0, 2_000);
    runtime.lastActualModel = selectedSession?.model || null;
    runtime.lastActualModelLabel = selectedSession?.modelLabel || null;
    runtime.lastNativeToolCalls = Number(error?.toolCalls || 0);
    runtime.lastNativeToolNames = Array.isArray(error?.toolNames) ? error.toolNames : [];
    runtime.lastMutationToolCalls = Number(error?.mutationToolCalls || 0);
    runtime.lastRzMcpTools = Array.isArray(error?.rzMcpTools) ? error.rzMcpTools : [];
    runtime.lastStreamContinuations = Number(error?.streamContinuations || 0);
    writeSse(response, "response.failed", {
      response: {
        id: responseId,
        object: "response",
        model: context.modelAlias,
        status: "failed",
        error: {
          code: error?.code || (error?.routeCommitted === true ? "provider_state_changed" : "external_provider_error"),
          message: runtime.lastError,
        },
      },
    });
    response.end();
    if (selectedSession?.closed === false && !context.sessionKey) selectedSession.close();
  } finally {
    clearInterval(heartbeat);
  }
}

function managedModelsResponse() {
  const contextWindow = 131_072;
  const baseModel = {
    display_name: "Managed Antigravity subagent",
    description: "Centrally routed native Antigravity subagent",
    base_instructions: "You are a bounded delegated coding sub-agent. Use local tools and return concise evidence.",
    default_reasoning_level: REQUIRED_EFFORT,
    supported_reasoning_levels: [{ effort: REQUIRED_EFFORT, description: "High" }],
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
    context_window: contextWindow,
    max_context_window: contextWindow,
    experimental_supported_tools: [],
    input_modalities: route.inputModalities,
    supports_search_tool: true,
    use_responses_lite: false,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
    tool_mode: "direct",
    multi_agent_version: "v2",
  };
  return { models: [
    { ...baseModel, slug: MODEL_ALIAS },
    {
      ...baseModel,
      slug: MAIN_MODEL_ALIAS,
      display_name: "RzCodex main agent (Antigravity)",
      description: "Antigravity Claude Opus / Gemini as the primary main-agent provider",
      base_instructions: "You are the primary coding agent. Follow the supplied RzCodex and project instructions, use local tools, and complete the current request.",
      visibility: "visible",
    },
  ] };
}

function health() {
  return {
    ok: true,
    status: "healthy",
    provider: PROVIDER_ID,
    port,
    modelAlias: MODEL_ALIAS,
    mainModelAlias: MAIN_MODEL_ALIAS,
    configuredModel: route.primaryModel,
    configuredModelLabel: models.primary.label,
    agent: {
      id: AGENT_ID,
      definitionPath: AGENT_DEFINITION_PATH,
      definitionHash: agentDefinitionHash,
      declarativeToolAllowlist: AGENT_DEFINITION.match(/^  - .+$/gm)?.map((line) => line.slice(4)) || [],
      forceDisableFundamentalComponents: true,
      forbiddenToolPolicy: "terminate_committed_turn",
      forbiddenTools: [...FORBIDDEN_AGENT_TOOLS],
      boundedWaitToolPolicy: `${BOUNDED_WAIT_TOOL} may only wait up to ${MAX_BOUNDED_WAIT_SECONDS}s for an existing command task`,
      initReportsProviderBaseToolSurface: true,
    },
    routing: {
      primary: {
        model: models.primary.id,
        label: models.primary.label,
        effort: "model-default-thinking",
        quotaBuckets: PRIMARY_QUOTA_BUCKET_IDS,
      },
      quotaFallback: {
        model: models.fallback.id,
        label: models.fallback.label,
        effort: models.fallback.effort,
        quotaBuckets: FALLBACK_QUOTA_BUCKET_IDS,
      },
      policy: "claude_gpt_pool_then_gemini_pool",
    },
    quota: quotaRouter.health(),
    effort: REQUIRED_EFFORT,
    inputModalities: route.inputModalities,
    auth: {
      source: "Antigravity cached OAuth session",
      apiKeysStripped: true,
      liveVerifiedAt: runtime.lastAuthVerifiedAt,
    },
    lazyRzMcp: { server: LAZY_MCP_SERVER, proxyTools: 2, ...mcpConfig },
    codexToolSchemasForwarded: 0,
    sessionPolicy: {
      persistentStreamJson: true,
      idleMilliseconds: SESSION_IDLE_MS,
      maximumSessions: MAX_SESSIONS,
      maximumConcurrentTurns: MAX_SESSIONS,
      uncommittedRouteTimeoutMs: UNCOMMITTED_ROUTE_TIMEOUT_MS,
    },
    activeSessions: sessions.size,
    activeTurns: [...sessions.values()].filter((session) => session.busy).length,
    runtime,
  };
}

async function selfTest() {
  const primaryArgs = sessionArguments(models.primary);
  const fallbackArgs = sessionArguments(models.fallback);
  if (primaryArgs[primaryArgs.indexOf("--agent") + 1] !== AGENT_ID) {
    throw new Error("restricted Antigravity agent was not selected");
  }
  if (primaryArgs.includes("--effort")) throw new Error("Opus Thinking received an unsupported effort flag");
  if (fallbackArgs[fallbackArgs.indexOf("--effort") + 1] !== REQUIRED_EFFORT) {
    throw new Error("Gemini Flash High did not receive high effort");
  }
  const quotaFixture = parseQuotaSnapshot(json({
    status: "SUCCESS",
    command: {
      name: "usage",
      data: {
        groups: [
          { name: "Gemini Models", buckets: [
            { id: FALLBACK_QUOTA_BUCKET_IDS[0], remaining_fraction: 0.75, reset_time: "2026-09-04T00:13:07Z" },
            { id: FALLBACK_QUOTA_BUCKET_IDS[1], remaining_fraction: 0.25, reset_time: "2026-08-30T17:00:00Z" },
          ] },
          { name: "Claude and GPT models", buckets: [
            { id: PRIMARY_QUOTA_BUCKET_IDS[0], remaining_fraction: 1, reset_time: "2026-09-06T01:56:48Z" },
            { id: PRIMARY_QUOTA_BUCKET_IDS[1], remaining_fraction: 0.5 },
          ] },
        ],
      },
    },
  }), Date.parse("2026-08-30T12:00:00Z"));
  const fixtureRouter = new AntigravityQuotaRouter(() => Date.parse("2026-08-30T12:00:01Z"));
  fixtureRouter.snapshot = () => quotaFixture;
  if (quotaFixture.primary.remainingFraction !== 0.5 || quotaFixture.fallback.remainingFraction !== 0.25) {
    throw new Error("Antigravity effective quota did not honor the tightest active window");
  }
  if (quotaFixture.primary.buckets[1].resetAt !== null || quotaFixture.primary.resetAt !== null) {
    throw new Error("Antigravity missing reset timestamps were not preserved as unknown");
  }
  if (fixtureRouter.select().id !== route.primaryModel) throw new Error("Claude/GPT pool was not preferred");
  if (fixtureRouter.select(route.quotaFallbackModel).id !== route.quotaFallbackModel) {
    throw new Error("Gemini task route was not sticky");
  }
  const weeklyOnlyQuota = parseQuotaSnapshot(json({
    status: "SUCCESS",
    command: {
      name: "usage",
      data: { groups: [
        { name: "Gemini Models", buckets: [{ id: FALLBACK_QUOTA_BUCKET_IDS[0], remaining_fraction: 0.75, reset_time: "2026-09-04T00:13:07Z" }] },
        { name: "Claude and GPT models", buckets: [{ id: PRIMARY_QUOTA_BUCKET_IDS[0], remaining_fraction: 1, reset_time: "2026-09-06T01:56:48Z" }] },
      ] },
    },
  }));
  if (weeklyOnlyQuota.primary.buckets.length !== 1 || weeklyOnlyQuota.fallback.buckets.length !== 1) {
    throw new Error("weekly-only Antigravity plans were not accepted");
  }
  const liveMissingResetQuota = parseQuotaSnapshot(json({
    status: "SUCCESS",
    command: {
      name: "usage",
      data: { groups: [
        { name: "Gemini Models", buckets: [
          { id: FALLBACK_QUOTA_BUCKET_IDS[0], remaining_fraction: 0.77, reset_time: "2026-09-06T02:55:38Z" },
          { id: FALLBACK_QUOTA_BUCKET_IDS[1], remaining_fraction: 0.93, reset_time: "2026-08-30T19:58:39Z" },
        ] },
        { name: "Claude and GPT models", buckets: [
          { id: PRIMARY_QUOTA_BUCKET_IDS[0], remaining_fraction: 0, reset_time: "2026-09-06T02:56:54Z" },
          { id: PRIMARY_QUOTA_BUCKET_IDS[1], remaining_fraction: 0.02 },
        ] },
      ] },
    },
  }));
  fixtureRouter.snapshot = () => liveMissingResetQuota;
  if (fixtureRouter.select().id !== route.quotaFallbackModel) {
    throw new Error("missing non-limiting Claude reset time skipped the available Gemini pool");
  }
  fixtureRouter.snapshot = () => quotaFixture;
  quotaFixture.primary.remainingFraction = 0;
  if (fixtureRouter.select().id !== route.quotaFallbackModel) throw new Error("Gemini quota fallback was not selected");
  quotaFixture.fallback.remainingFraction = 0;
  try {
    fixtureRouter.select();
    throw new Error("depleted Antigravity pools did not fail");
  } catch (error) {
    if (!(error instanceof BridgeError) || error.status !== 429) throw error;
  }
  const quotaFailureFor = (toolNames, generatedTokens = 0, message = "Individual quota reached. Resets in 1h.") => {
    const session = new AntigravitySession("quota-fixture", process.cwd(), "task", models.primary, () => {});
    session.close = () => {};
    session.init = { conversationId: "quota-fixture" };
    let rejected;
    session.turn = {
      cleanup: () => {},
      reject: (error) => { rejected = error; },
      generatedTokens,
      toolNames: new Set(),
      toolStepKeys: new Set(),
      mutationToolStepKeys: new Set(),
      rzMcpTools: new Set(),
      subagentActivity: false,
      forbiddenToolName: null,
      unknownToolSteps: 0,
    };
    for (const [stepIndex, toolName] of toolNames.entries()) {
      session.consumeEvent({
        event: "step_update",
        step_update: {
          conversation_id: "quota-fixture",
          step_index: stepIndex,
          state: "DONE",
          step_type: "tool",
          tool_name: toolName,
          tool_info: { name: toolName, parameters: {} },
        },
      });
    }
    session.finishTurn({ status: "ERROR", error: message });
    return rejected;
  };
  const safeQuotaFailure = quotaFailureFor([], 100);
  const readOnlyQuotaFailure = quotaFailureFor(["view_file", "grep_search", "run_command", "manage_task"]);
  const committedQuotaFailure = quotaFailureFor(["write_to_file"]);
  if (!safeQuotaFailure?.modelQuotaFailure || !safeQuotaFailure.safeToRetry || safeQuotaFailure.routeCommitted) {
    throw new Error("safe model-quota retry classification failed");
  }
  if (!readOnlyQuotaFailure?.modelQuotaFailure || readOnlyQuotaFailure.safeToRetry || !readOnlyQuotaFailure.routeCommitted) {
    throw new Error("read-only provider work was incorrectly eligible for cross-provider replay");
  }
  if (!committedQuotaFailure?.modelQuotaFailure || committedQuotaFailure.safeToRetry || !committedQuotaFailure.routeCommitted) {
    throw new Error("committed model-quota failure classification failed");
  }
  if (committedQuotaFailure.toolCalls !== 1 || committedQuotaFailure.mutationToolCalls !== 1) {
    throw new Error("DONE-only tool commitment accounting failed");
  }
  const capacityQuotaFailure = quotaFailureFor([], 0, "You have exhausted your capacity on this model.");
  if (!capacityQuotaFailure?.modelQuotaFailure) throw new Error("capacity quota classification failed");
  const fakeChild = () => ({
    killed: false,
    stdin: { write: (_payload, callback) => callback?.() },
    kill() { this.killed = true; },
  });
  const uncommittedTimeoutSession = new AntigravitySession(
    "uncommitted-timeout-fixture",
    process.cwd(),
    "mutation-task",
    models.fallback,
    () => {},
  );
  uncommittedTimeoutSession.init = { conversationId: "uncommitted-timeout-fixture" };
  uncommittedTimeoutSession.initSettled = true;
  uncommittedTimeoutSession.child = fakeChild();
  const uncommittedTimeoutPromise = uncommittedTimeoutSession.run("task", null, () => {}, 1_000, 5);
  uncommittedTimeoutSession.consumeEvent({
    event: "step_update",
    step_update: {
      conversation_id: "uncommitted-timeout-fixture",
      step_index: 0,
      state: "DONE",
      step_type: "tool",
      tool_name: "grep_search",
      tool_info: { name: "grep_search", parameters: {} },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  uncommittedTimeoutSession.finishTurn({
    status: "SUCCESS",
    response: "read-only result",
    conversation_id: "uncommitted-timeout-fixture",
    duration_seconds: 0.01,
    usage: {},
  });
  const uncommittedTimeoutResult = await uncommittedTimeoutPromise;
  if (
    uncommittedTimeoutResult.text !== "read-only result"
    || uncommittedTimeoutResult.toolCalls !== 1
    || uncommittedTimeoutResult.mutationToolCalls !== 0
  ) {
    throw new Error("read-only Antigravity activity did not clear the pre-work route deadline");
  }
  uncommittedTimeoutSession.close();
  const committedTimeoutSession = new AntigravitySession(
    "committed-timeout-fixture",
    process.cwd(),
    "mutation-task",
    models.fallback,
    () => {},
  );
  committedTimeoutSession.init = { conversationId: "committed-timeout-fixture" };
  committedTimeoutSession.initSettled = true;
  committedTimeoutSession.child = fakeChild();
  const committedTimeoutPromise = committedTimeoutSession.run("task", null, () => {}, 1_000, 5);
  committedTimeoutSession.consumeEvent({
    event: "step_update",
    step_update: {
      conversation_id: "committed-timeout-fixture",
      step_index: 0,
      state: "DONE",
      step_type: "tool",
      tool_name: "replace_file_content",
      tool_info: { name: "replace_file_content", parameters: {} },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  committedTimeoutSession.finishTurn({
    status: "SUCCESS",
    response: "done",
    conversation_id: "committed-timeout-fixture",
    duration_seconds: 0.01,
    usage: {},
  });
  const committedTimeoutResult = await committedTimeoutPromise;
  if (committedTimeoutResult.text !== "done" || committedTimeoutResult.mutationToolCalls !== 1) {
    throw new Error("Antigravity mutation did not cancel the uncommitted route deadline");
  }
  committedTimeoutSession.close();
  const interruptionSession = new AntigravitySession(
    "interruption-fixture",
    process.cwd(),
    "stream-task",
    models.fallback,
    () => {},
  );
  interruptionSession.init = { conversationId: "interruption-conversation" };
  interruptionSession.initSettled = true;
  let interruptionFailure;
  interruptionSession.turn = {
    cleanup: () => {},
    reject: (error) => { interruptionFailure = error; },
    generatedTokens: 12,
    generationSeconds: 0.25,
    peakContextTokens: 321,
    toolNames: new Set(["replace_file_content"]),
    toolStepKeys: new Set(["interruption-conversation:1"]),
    mutationToolStepKeys: new Set(["interruption-conversation:1"]),
    rzMcpTools: new Set(),
    subagentActivity: false,
    forbiddenToolName: null,
    unknownToolSteps: 0,
  };
  interruptionSession.finishTurn({
    status: "ERROR",
    error: "The stream was interrupted. Please continue the task you were working on.",
    duration_seconds: 0.5,
    conversation_id: "interruption-conversation",
  });
  if (
    !interruptionFailure?.sameSessionContinuation
    || interruptionFailure.safeToRetry
    || !interruptionFailure.routeCommitted
    || interruptionFailure.mutationToolCalls !== 1
    || interruptionFailure.generatedTokens !== 12
    || interruptionFailure.durationSeconds !== 0.5
    || interruptionSession.closed
  ) {
    throw new Error("same-session interrupted-stream classification failed");
  }
  interruptionSession.close();
  let fakeNow = 1_000;
  let recoveryRun = 0;
  const recoveryCalls = [];
  const recoveryDelays = [];
  const recoveryEvents = [];
  const recoveryToolEvents = [];
  const interruptedError = (toolName, mutationToolCalls, generatedTokens) => Object.assign(
    new BridgeError("fixture stream interruption", 502),
    {
      sameSessionContinuation: true,
      safeToRetry: false,
      routeCommitted: true,
      toolCalls: 1,
      toolNames: [toolName],
      mutationToolCalls,
      rzMcpTools: [],
      subagentActivity: false,
      forbiddenToolName: null,
      peakContextTokens: 100 + recoveryRun,
      generatedTokens,
      generationSeconds: 0.1,
      durationSeconds: 0.25,
      conversationId: "recovery-conversation",
    },
  );
  const recoverySession = {
    activeTaskHash: "recovery-task-hash",
    init: { conversationId: "recovery-conversation" },
    closed: false,
    run: async (currentPrompt, _signal, onProgress, timeoutMs) => {
      recoveryCalls.push({ prompt: currentPrompt, timeoutMs });
      recoveryRun += 1;
      if (recoveryRun === 1) {
        onProgress({ kind: "tool", index: 1, name: "replace_file_content" });
        throw interruptedError("replace_file_content", 1, 10);
      }
      onProgress({ kind: "tool", index: 1, name: "read_file" });
      return {
        text: "recovered completion",
        toolCalls: 1,
        toolNames: ["read_file"],
        mutationToolCalls: 0,
        rzMcpTools: [],
        peakContextTokens: 150,
        generatedTokens: 5,
        generationSeconds: 0.05,
        durationSeconds: 0.1,
        conversationId: "recovery-conversation",
      };
    },
  };
  const committedRecovery = await runWithInterruptedStreamRecovery(
    recoverySession,
    "original task payload",
    undefined,
    (event) => recoveryToolEvents.push(event),
    (event) => recoveryEvents.push(event),
    {
      now: () => fakeNow,
      deadline: 100_000,
      delay: async (milliseconds) => {
        recoveryDelays.push(milliseconds);
        fakeNow += milliseconds;
      },
    },
  );
  if (
    recoveryCalls.length !== 2
    || recoveryCalls[0].prompt !== "original task payload"
    || recoveryCalls[0].timeoutMs !== 99000
    || !recoveryCalls[1].prompt.includes("[Native Antigravity stream recovery]")
    || !recoveryCalls[1].prompt.includes("recovery-task-hash")
    || recoveryCalls[1].timeoutMs !== 44000
    || recoveryDelays.join(",") !== "1000"
    || recoveryEvents.length !== 1
    || recoveryToolEvents.map(({ index }) => index).join(",") !== "1,2"
    || committedRecovery.text !== "recovered completion"
    || committedRecovery.streamContinuations !== 1
    || committedRecovery.toolCalls !== 2
    || committedRecovery.mutationToolCalls !== 1
    || committedRecovery.toolNames.join(",") !== "replace_file_content,read_file"
    || committedRecovery.generatedTokens !== 15
    || committedRecovery.conversationId !== "recovery-conversation"
  ) {
    throw new Error("post-tool Antigravity stream interruption did not resume the retained session once");
  }
  let exhaustedCommittedRuns = 0;
  let exhaustedCommittedFailure;
  try {
    await runWithInterruptedStreamRecovery(
      {
        activeTaskHash: "exhausted-committed-task",
        init: { conversationId: "exhausted-committed-conversation" },
        closed: false,
        close: () => {},
        run: async () => {
          exhaustedCommittedRuns += 1;
          throw interruptedError("replace_file_content", 1, 3);
        },
      },
      "exhausted committed task",
      undefined,
      undefined,
      undefined,
      { now: () => 1_000, deadline: 100_000, delay: async () => {} },
    );
  } catch (error) {
    exhaustedCommittedFailure = error;
  }
  if (
    exhaustedCommittedRuns !== 2
    || exhaustedCommittedFailure?.streamContinuations !== 2
    || exhaustedCommittedFailure?.toolCalls !== 2
    || exhaustedCommittedFailure?.mutationToolCalls !== 2
    || exhaustedCommittedFailure?.routeCommitted !== true
    || exhaustedCommittedFailure?.safeToRetry !== false
  ) {
    throw new Error("exhausted post-tool Antigravity recovery lost committed provider ownership");
  }
  let terminalRecoveryRun = 0;
  let terminalRecoveryFailure;
  const terminalRecoverySession = {
    activeTaskHash: "terminal-recovery-task",
    init: { conversationId: "terminal-recovery-conversation" },
    closed: false,
    run: async () => {
      terminalRecoveryRun += 1;
      if (terminalRecoveryRun === 1) {
        throw Object.assign(new BridgeError("fixture stream interruption", 502), {
          sameSessionContinuation: true,
          safeToRetry: false,
          routeCommitted: true,
          toolCalls: 0,
          toolNames: [],
          mutationToolCalls: 0,
          rzMcpTools: [],
        });
      }
      throw Object.assign(new BridgeError("fixture terminal provider failure", 502), {
        safeToRetry: true,
        routeCommitted: false,
        toolCalls: 0,
        toolNames: [],
        mutationToolCalls: 0,
        rzMcpTools: [],
      });
    },
  };
  try {
    await runWithInterruptedStreamRecovery(
      terminalRecoverySession,
      "terminal recovery task",
      undefined,
      undefined,
      undefined,
      { now: () => 1_000, deadline: 10_000, delay: async () => {} },
    );
  } catch (error) {
    terminalRecoveryFailure = error;
  }
  if (
    terminalRecoveryRun !== 2
    || terminalRecoveryFailure?.streamContinuations !== 1
    || terminalRecoveryFailure?.routeCommitted !== false
    || terminalRecoveryFailure?.safeToRetry !== true
  ) {
    throw new Error("read-only post-interruption terminal failure was not eligible for rerouting");
  }
  const abortedRecoveryController = new AbortController();
  abortedRecoveryController.abort();
  let abortedRecoveryClosed = false;
  let abortedRecoveryFailure;
  try {
    await runWithInterruptedStreamRecovery(
      {
        activeTaskHash: "aborted-recovery-task",
        init: { conversationId: "aborted-recovery-conversation" },
        closed: false,
        close: () => { abortedRecoveryClosed = true; },
      },
      "aborted recovery task",
      abortedRecoveryController.signal,
    );
  } catch (error) {
    abortedRecoveryFailure = error;
  }
  if (!abortedRecoveryClosed || abortedRecoveryFailure?.status !== 499) {
    throw new Error("aborted interrupted-stream recovery did not release its provider session");
  }
  const initSession = new AntigravitySession("init-fixture", process.cwd(), "task", models.primary, () => {});
  let initResolved = false;
  let initRejected = false;
  initSession.resolveInit = () => { initResolved = true; };
  initSession.rejectInit = () => { initRejected = true; };
  initSession.consumeEvent({
    event: "init",
    conversation_id: "init-fixture",
    init: {
      model: models.primary.id,
      agent: AGENT_ID,
      permission_mode: "always-proceed",
      tools: [...REQUIRED_AGENT_TOOLS, ...FORBIDDEN_AGENT_TOOLS],
    },
  });
  if (!initResolved || initRejected || runtime.lastInitializedForbiddenTools.length !== FORBIDDEN_AGENT_TOOLS.size) {
    throw new Error("provider base-tool init surface was mistaken for the effective agent allowlist");
  }
  const boundedWaitSession = new AntigravitySession("bounded-wait-fixture", process.cwd(), "task", models.primary, () => {});
  boundedWaitSession.close = () => {};
  boundedWaitSession.init = { conversationId: "bounded-wait-fixture" };
  boundedWaitSession.initSettled = true;
  let boundedWaitFailure;
  boundedWaitSession.turn = {
    cleanup: () => {},
    reject: (error) => { boundedWaitFailure = error; },
    generatedTokens: 0,
    toolNames: new Set(),
    toolStepKeys: new Set(),
    mutationToolStepKeys: new Set(),
    rzMcpTools: new Set(),
    subagentActivity: false,
    forbiddenToolName: null,
    unknownToolSteps: 0,
  };
  boundedWaitSession.consumeEvent({
    event: "step_update",
    step_update: {
      conversation_id: "bounded-wait-fixture/task-30",
      step_index: 0,
      state: "RUNNING",
      step_type: "tool",
      tool_name: BOUNDED_WAIT_TOOL,
      tool_info: { name: BOUNDED_WAIT_TOOL },
    },
  });
  if (boundedWaitFailure) {
    throw new Error("incomplete running Antigravity wait metadata was rejected before its DONE update");
  }
  boundedWaitSession.consumeEvent({
    event: "step_update",
    step_update: {
      conversation_id: "bounded-wait-fixture",
      step_index: 0,
      state: "DONE",
      step_type: "tool",
      tool_name: BOUNDED_WAIT_TOOL,
      tool_info: {
        name: BOUNDED_WAIT_TOOL,
        parameters: {
          DurationSeconds: 2,
          Prompt: "Wait for task-30 to finish",
          TimerCondition: "bounded-wait-fixture/task-30",
        },
      },
    },
  });
  if (boundedWaitFailure || boundedWaitSession.turn?.forbiddenToolName || !boundedWaitSession.turn?.toolNames.has(BOUNDED_WAIT_TOOL)) {
    throw new Error("bounded Antigravity command wait was rejected as orchestration");
  }
  if (!isBoundedTaskWait({
    DurationSeconds: MAX_BOUNDED_WAIT_SECONDS,
    Prompt: "Wait for task-30 to finish",
    TimerCondition: "task-30",
  }, "bounded-wait-fixture")) {
    throw new Error("conversation-local Antigravity task wait was rejected");
  }
  if (isBoundedTaskWait({
    DurationSeconds: MAX_BOUNDED_WAIT_SECONDS,
    Prompt: "Wait for task-30 to finish",
    TimerCondition: "another-conversation/task-30",
  }, "bounded-wait-fixture")) {
    throw new Error("cross-conversation Antigravity task wait was accepted");
  }
  if (isBoundedTaskWait({
    DurationSeconds: MAX_BOUNDED_WAIT_SECONDS + 1,
    Prompt: "Wait for task-30 to finish",
    TimerCondition: "bounded-wait-fixture/task-30",
  }, "bounded-wait-fixture")) {
    throw new Error("unbounded Antigravity command wait was accepted");
  }
  const forbiddenSession = new AntigravitySession("forbidden-fixture", process.cwd(), "task", models.primary, () => {});
  forbiddenSession.close = () => {};
  forbiddenSession.init = { conversationId: "forbidden-fixture" };
  forbiddenSession.initSettled = true;
  let forbiddenFailure;
  forbiddenSession.turn = {
    cleanup: () => {},
    reject: (error) => { forbiddenFailure = error; },
    generatedTokens: 0,
    toolNames: new Set(),
    toolStepKeys: new Set(),
    mutationToolStepKeys: new Set(),
    rzMcpTools: new Set(),
    subagentActivity: false,
    forbiddenToolName: null,
    unknownToolSteps: 0,
  };
  forbiddenSession.consumeEvent({
    event: "step_update",
    step_update: {
      conversation_id: "forbidden-fixture",
      step_index: 0,
      state: "DONE",
      step_type: "tool",
      tool_name: "invoke_subagent",
      tool_info: { name: "invoke_subagent", parameters: {} },
    },
  });
  if (!forbiddenFailure?.routeCommitted || forbiddenFailure.code !== "provider_state_changed" || forbiddenFailure.forbiddenToolName !== "invoke_subagent") {
    throw new Error("forbidden Antigravity orchestration tool did not fail closed");
  }
  if (/^model\s*:/m.test(AGENT_DEFINITION)) throw new Error("agent definition pinned a model");
  for (const name of FORBIDDEN_AGENT_TOOLS) {
    if (AGENT_DEFINITION.includes(`  - ${name}\n`)) throw new Error(`agent definition exposed ${name}`);
  }
  if (!AGENT_DEFINITION.includes("subagent: false\n") || !AGENT_DEFINITION.includes("forceDisableFundamentalComponents: true\n")) {
    throw new Error("agent definition did not disable provider-side nesting");
  }
  const mainContext = requestContext({
    stream: true,
    model: MAIN_MODEL_ALIAS,
    reasoning: { effort: REQUIRED_EFFORT },
    instructions: "MAIN_AGENT_INSTRUCTIONS",
    client_metadata: { cwd: homedir(), thread_id: "thread-agy-main" },
    tools: [{ type: "function", name: "ignored_parent_schema", parameters: { type: "object" } }],
    input: [{ type: "message", role: "user", content: "MAIN_AGENT_REQUEST" }],
  });
  const mainPrompt = fullPrompt(mainContext);
  const advertisedModels = managedModelsResponse().models;
  if (
    !mainContext.mainAgent
    || mainContext.modelAlias !== MAIN_MODEL_ALIAS
    || mainContext.sessionKey !== "thread-agy-main:main"
    || mainContext.taskState.activeTask !== null
    || !mainPrompt.includes("[RzCodex main-agent contract]")
    || !mainPrompt.includes("MAIN_AGENT_INSTRUCTIONS")
    || !mainPrompt.includes("MAIN_AGENT_REQUEST")
    || advertisedModels.length !== 2
    || !advertisedModels.some((model) => model.slug === MAIN_MODEL_ALIAS && model.visibility === "visible")
  ) {
    throw new Error("Antigravity main-agent alias failed ordinary-history normalization");
  }
  const taskHeader = "Message Type: NEW_TASK\nTask name: /root/agy_fixture\nPayload:\n";
  const taskPayload = "Implement the bounded fixture now.";
  const task = `${taskHeader}${taskPayload}`;
  const fixture = {
    stream: true,
    model: MODEL_ALIAS,
    reasoning: { effort: REQUIRED_EFFORT },
    client_metadata: { cwd: process.cwd(), thread_id: "thread-agy-fixture" },
    tools: Array.from({ length: 100 }, (_, index) => ({ name: `ignored_${index}`, description: "x".repeat(1_000) })),
    input: [
      ...Array.from({ length: 12 }, (_, index) => ({
        type: "message",
        role: index % 2 === 0 ? "user" : "assistant",
        content: `saturated-history-${index}\n${"x".repeat(9_000)}`,
      })),
      {
        type: "agent_message", id: "agy-task", author: "Codex", recipient: "/root/agy_fixture",
        content: [{ type: "input_text", text: taskHeader }, { type: "encrypted_content", encrypted_content: taskPayload }],
      },
    ],
  };
  const context = requestContext(fixture);
  const first = fullPrompt(context);
  if (!first.includes("[Project AGENTS instructions - authoritative and complete]")) {
    throw new Error("project AGENTS instructions did not reach Antigravity");
  }
  const firstDiagnostics = taskDeliveryDiagnostics(context.taskState, first);
  if (
    first.length > MAX_PROMPT_CHARS
    || first.length < MAX_PROMPT_CHARS - 100
    || firstDiagnostics.completeTaskOccurrences !== 1
  ) {
    throw new Error("bounded encrypted task delivery failed");
  }
  if (context.toolSchemaBytes < 100_000) throw new Error("tool-schema fixture is too small");
  const reasoningBoundaryContext = requestContext({
    ...fixture,
    tools: [],
    input: [
      {
        type: "reasoning",
        id: "progress_antigravity_fixture",
        summary: [{ type: "summary_text", text: "BRIDGE_PROGRESS_MUST_NOT_REENTER" }],
      },
      {
        type: "reasoning",
        id: "rs_parent_antigravity_fixture",
        summary: [{ type: "summary_text", text: "PORTABLE_PARENT_REASONING" }],
      },
      fixture.input.at(-1),
    ],
  });
  const reasoningBoundaryPrompt = fullPrompt(reasoningBoundaryContext);
  if (
    reasoningBoundaryPrompt.includes("BRIDGE_PROGRESS_MUST_NOT_REENTER")
    || !reasoningBoundaryPrompt.includes("PORTABLE_PARENT_REASONING")
  ) {
    throw new Error("bridge progress re-entered the Antigravity provider prompt");
  }
  const retainedSession = { seenMessageKeys: new Set(context.messageKeys) };
  const resumed = resumePrompt(context, retainedSession);
  const resumedDiagnostics = taskDeliveryDiagnostics(context.taskState, resumed, {
    activeTaskIncludedThisTurn: false,
    retainedInProviderSession: true,
  });
  if (!resumedDiagnostics.completeTaskDelivered || resumed.includes(task)) {
    throw new Error("provider-session task retention failed");
  }
  const analysisTask = "Message Type: NEW_TASK\nTask name: /root/agy_analysis\nPayload:\nInspect the bounded evidence and report only when complete.";
  const immediateMessage = "Message Type: MESSAGE\nTask name: /root/agy_analysis\nPayload:\nStop further investigation and immediately return your current verdict.";
  const analysisContext = requestContext({
    stream: true,
    model: MODEL_ALIAS,
    reasoning: { effort: REQUIRED_EFFORT },
    client_metadata: { cwd: homedir(), thread_id: "thread-agy-analysis" },
    input: [{
      type: "agent_message",
      id: "agy-analysis-task",
      author: "Codex",
      recipient: "/root/agy_analysis",
      content: [{ type: "input_text", text: analysisTask }],
    }],
  });
  const analysisFirst = fullPrompt(analysisContext);
  if (
    analysisContext.workingDirectory !== homedir()
    ||
    !analysisFirst.includes("[Analysis convergence contract]")
    || analysisFirst.includes("[Immediate terminal report required]")
  ) {
    throw new Error("Antigravity analysis convergence control failed");
  }
  const priorResumeTaskText = "Message Type: NEW_TASK\nTask name: /root/agy_resume\nPayload:\nInspect the original bounded fixture under its exact ownership constraints.";
  const activeResumeTaskText = "Message Type: NEW_TASK\nTask name: /root/agy_resume\nPayload:\nBridge repaired. Resume the same bounded audit from your preserved state; keep the original scope and finish.";
  const afterBridgeRestartResume = requestContext({
    stream: true,
    model: MODEL_ALIAS,
    reasoning: { effort: REQUIRED_EFFORT },
    client_metadata: { cwd: homedir(), thread_id: "thread-agy-after-restart" },
    input: [
      { type: "agent_message", id: "agy-prior-resume", author: "Codex", recipient: "/root/agy_resume", content: [{ type: "input_text", text: priorResumeTaskText }] },
      { type: "agent_message", id: "agy-active-resume", author: "Codex", recipient: "/root/agy_resume", content: [{ type: "input_text", text: activeResumeTaskText }] },
    ],
  });
  const priorResumeContext = requestContext({
    stream: true,
    model: MODEL_ALIAS,
    reasoning: { effort: REQUIRED_EFFORT },
    client_metadata: { cwd: homedir(), thread_id: "thread-agy-before-restart" },
    input: [
      { type: "agent_message", id: "agy-prior-only", author: "Codex", recipient: "/root/agy_resume", content: [{ type: "input_text", text: priorResumeTaskText }] },
    ],
  });
  if (
    taskOwnershipHash(afterBridgeRestartResume.taskState)
      !== taskOwnershipHash(priorResumeContext.taskState)
  ) {
    throw new Error("Antigravity continuation changed the retained conversation identity");
  }
  const afterBridgeRestartPrompt = fullPrompt(afterBridgeRestartResume);
  if (
    afterBridgeRestartPrompt.split(priorResumeTaskText).length - 1 !== 1
    || afterBridgeRestartPrompt.split(activeResumeTaskText).length - 1 !== 1
    || !afterBridgeRestartPrompt.includes("[Referenced prior delegated context]")
  ) {
    throw new Error("Antigravity bridge restart lost referenced prior task context");
  }
  const immediateContext = requestContext({
    stream: true,
    model: MODEL_ALIAS,
    reasoning: { effort: REQUIRED_EFFORT },
    client_metadata: { cwd: process.cwd(), thread_id: "thread-agy-analysis" },
    input: [
      {
        type: "agent_message",
        id: "agy-analysis-task",
        author: "Codex",
        recipient: "/root/agy_analysis",
        content: [{ type: "input_text", text: analysisTask }],
      },
      {
        type: "agent_message",
        id: "agy-analysis-immediate",
        author: "Codex",
        recipient: "/root/agy_analysis",
        content: [{ type: "input_text", text: immediateMessage }],
      },
    ],
  });
  const immediateResume = resumePrompt(immediateContext, {
    seenMessageKeys: new Set(analysisContext.messageKeys),
  });
  if (!immediateResume.includes("[Immediate terminal report required]")) {
    throw new Error("Antigravity resumed immediate terminal report control failed");
  }
  const isolated = sanitizedEnvironment({
    GEMINI_API_KEY: "secret",
    GOOGLE_API_KEY: "secret",
    OPENAI_API_KEY: "secret",
    RETAINED_TEST_VALUE: "retained",
  });
  if (["GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY"].some((key) => key in isolated)) {
    throw new Error("API credential isolation failed");
  }
  if (isolated.RETAINED_TEST_VALUE !== "retained") throw new Error("environment isolation removed unrelated values");
  const writes = [];
  const testResponse = { destroyed: false, writableEnded: false, write: (value) => writes.push(value) };
  const testProgress = createProgressEmitter(testResponse);
  testProgress.emit("Antigravity native worker started.\n");
  testProgress.emit(`Antigravity native tool 1: ${progressToolName("view file with unsafe spacing")}.\n`);
  const testProgressItems = testProgress.finish();
  emitCompleted(testResponse, "resp-test", {
    text: "done",
    usage: { input_tokens: 10, cache_read_tokens: 2, output_tokens: 3, thinking_tokens: 1, total_tokens: 13 },
  }, {}, testProgressItems);
  const sse = writes.join("");
  if (
    testProgressItems.length !== 2
    || writes.filter((value) => value.includes("event: response.output_item.done")).length !== 3
    || !sse.includes("response.reasoning_summary_text.delta")
    || !sse.includes("Antigravity native tool 1: view_file_with_unsafe_spacing")
    || !sse.includes('"output_index":2')
    || !sse.includes('"output":[{"type":"reasoning"')
    || !sse.includes("response.output_text.delta")
    || !sse.includes("response.completed")
  ) {
    throw new Error("Responses SSE lifecycle failed");
  }
  if (MAX_SESSIONS < 3) {
    throw new Error("Antigravity concurrent turn capacity was unexpectedly restricted");
  }
  process.stdout.write("antigravity-subagent-bridge self-test: ok\n");
}

if (process.argv.includes("--self-test")) {
  await selfTest();
  process.exit(0);
}

const portValue = Number.parseInt(process.env.RZCODEX_ANTIGRAVITY_BRIDGE_PORT || `${DEFAULT_PORT}`, 10);
if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
  throw new BridgeError("Invalid Antigravity bridge port", 500);
}
const port = portValue;
const server = createServer(async (request, response) => {
  runtime.incomingRequests += 1;
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (request.method === "GET" && url.pathname === "/health") return jsonResponse(response, 200, health());
    if (request.method === "GET" && ["/models", "/v1/models"].includes(url.pathname)) {
      return jsonResponse(response, 200, managedModelsResponse());
    }
    if (request.method === "POST" && url.pathname === "/v1/responses") return await handleResponses(request, response);
    runtime.rejected += 1;
    return jsonResponse(response, 404, { error: { message: `No route for ${request.method} ${url.pathname}` } });
  } catch (error) {
    runtime.rejected += 1;
    runtime.lastError = String(error?.message || error).slice(0, 2_000);
    if (!response.headersSent) jsonResponse(response, error.status || 500, { error: { message: runtime.lastError } });
    else if (!response.writableEnded) response.end();
  }
});

server.listen(port, "127.0.0.1");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    for (const session of sessions.values()) session.close();
    server.close(() => process.exit(0));
  });
}
