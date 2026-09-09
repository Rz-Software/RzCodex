import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TaskStateError,
  activeTaskPromptSection,
  referencedPriorTaskPromptSection,
  rzMcpModeForTask,
  taskControlPromptSections,
  taskDeliveryDiagnostics,
  taskOwnershipHash,
  taskStateFromInput,
} from "./codebuddy-subagent-task-state.mjs";
import { projectInstructionsPromptSection } from "./native-project-instructions.mjs";
import {
  executionPolicy as checkedExecutionPolicy,
  sanitizeChildEnvironment,
} from "./bridge-security.mjs";

const MAX_ACTIVE_TASK_CHARS = 40_000;
const MAX_MAIN_PROMPT_CHARS = 120_000;
const MAX_RETAINED_DELIVERY_IDENTITIES = 4_096;
const MAX_RETAINED_DELIVERY_ID_CHARS = 256;
const OLLAMA_CLOUD_CONTEXT_WINDOW = 1_048_576;
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
const ROUTE_OWNERSHIP_TIMEOUT_MS = 55 * 1000;
const TERMINAL_RECOVERY_TIMEOUT_MS = 45 * 1000;
const COMMANDCODE_FIXED_REASONING_MODELS = new Set([
  "meta/muse-spark-1.3-contributor",
]);
const OPENCODE_PRIMARY_AGENT = "rzcodex-native";
// Recovery exists only to close an interrupted provider stream. It may perform one final tool
// iteration, after which OpenCode itself forces the terminal report.
const OPENCODE_TERMINAL_AGENT = "rzcodex-terminal";
const OPENCODE_TERMINAL_STEPS = 1;
const STDERR_LIMIT = 16 * 1024;
const STATE_CLEANUP_RETRY_MS = 50;
const STATE_CLEANUP_RELEASE_MS = 2 * 1000;
const STALE_STATE_AGE_MS = REQUEST_TIMEOUT_MS + 5 * 60 * 1000;
const ORPHAN_STATE_MARKER_SUFFIX = ".orphan.json";
const OPENCODE_EXE = join(
  process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
  "npm", "node_modules", "opencode-ai", "bin", "opencode.exe",
);
function commandCodePackageDirectory(source = process.env) {
  return source.COMMANDCODE_PACKAGE_DIR || join(
    source.APPDATA || join(homedir(), "AppData", "Roaming"),
    "npm", "node_modules", "command-code",
  );
}
const OPENCODE_STATE_DIRECTORY = join(
  process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
  "RzCodex", "native-cli-agents",
);
const COMMAND_CODE_HOME_DIRECTORY = join(
  process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
  "RzCodex", "commandcode-native-home",
);
const COMMAND_CODE_HOME_CONFIG_DIRECTORY = join(COMMAND_CODE_HOME_DIRECTORY, ".commandcode");
const COMMAND_CODE_LAUNCH_DIRECTORY = join(COMMAND_CODE_HOME_DIRECTORY, "workspace-root");
const LAZY_RZMCP_PROXY = join(import.meta.dirname, "devin-rzmcp-lazy-proxy.mjs");
const ROLE_TAG = /<(?:external_cli|codebuddy|cursor)_route_instructions>([\s\S]*?)<\/(?:external_cli|codebuddy|cursor)_route_instructions>/gi;
const MUTATION_TOOL = /^(?:apply_patch|edit|edit_file|write|write_file|create_file|delete_file|move_file)$/i;
const LAZY_RZMCP_CALL_TOOL = /(?:^|[_:.-])call_rzmcp_tool$/i;
const NATIVE_MCP_CALL_TOOL = /^mcp_call_tool$/i;
const READ_ONLY_RZMCP_TOOL_NAME = /^(?:analyze|check|count|describe|discover|does|enumerate|find|get|has|inspect|is|list|locate|query|read|resolve|search|validate)_/i;
const OLLAMA_USAGE_LIMIT = /providerID=ollama[\s\S]{0,2000}(?:reached|exceeded)[\s\S]{0,120}(?:session\s+)?usage limit|providerID=ollama[\s\S]{0,2000}\b429\b[\s\S]{0,120}(?:quota|usage|limit)/i;
const OPENCODE_GO_QUOTA_LIMIT = /\b(?:monthly|weekly|daily|5[- ]?hour|five[- ]?hour)\s+(?:usage\s+)?limit\b|\busage\s+limit\s+(?:reached|exceeded|exhausted)\b|\b(?:insufficient balance|creditserror|not enough credits?|credits? exhausted)\b/i;
const OPENCODE_TRANSIENT_RATE_LIMIT = /\bAI_APICallError:\s*Rate limit exceeded\b/i;
const retainedOpenCodeSessions = new Map();
const retainedCommandCodeSessions = new Map();
const nativeStateTails = new Map();
const OPENCODE_GO_QUOTA_STATE_FILE = join(OPENCODE_STATE_DIRECTORY, "opencode-go-quota-state.json");
const QUOTA_RECOVERY_PROBE_MS = 30 * 60 * 1000;
const RECOVERY_PROBE_STATE_VERSION = 1;

export class RecoveryProbeState {
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
        parsed.version !== RECOVERY_PROBE_STATE_VERSION
        || typeof parsed.reason !== "string"
        || parsed.reason.length === 0
        || !Number.isFinite(parsed.confirmedAt)
        || !Number.isFinite(parsed.nextProbeAt)
        || parsed.nextProbeAt <= parsed.confirmedAt
      ) {
        throw new Error("invalid schema");
      }
      this.state = {
        reason: parsed.reason,
        confirmedAt: parsed.confirmedAt,
        nextProbeAt: parsed.nextProbeAt,
      };
    } catch (error) {
      throw new Error(`Cannot read persisted OpenCode Go quota state: ${error.message}`);
    }
  }

  isActive() {
    return this.state !== null;
  }

  record(reason, nowMs = this.now()) {
    this.state = {
      reason,
      confirmedAt: nowMs,
      nextProbeAt: nowMs + QUOTA_RECOVERY_PROBE_MS,
    };
    this.persist();
    return true;
  }

  claimRecoveryProbe(nowMs = this.now()) {
    if (!this.state || this.state.nextProbeAt > nowMs) return false;
    this.state.nextProbeAt = nowMs + QUOTA_RECOVERY_PROBE_MS;
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
      if (error?.code !== "ENOENT") {
        throw new Error(`Cannot clear persisted OpenCode Go quota state: ${error.message}`);
      }
    }
    return changed;
  }

  persist() {
    if (!this.statePath) return;
    mkdirSync(dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
    try {
      writeFileSync(
        temporaryPath,
        `${JSON.stringify({ version: RECOVERY_PROBE_STATE_VERSION, ...this.state }, null, 2)}\n`,
        "utf8",
      );
      renameSync(temporaryPath, this.statePath);
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") {
          throw new Error(
            `Cannot persist OpenCode Go quota state and clean its temporary file: ${cleanupError.message}`,
          );
        }
      }
      throw new Error(`Cannot persist OpenCode Go quota state: ${error.message}`);
    }
  }

  snapshot() {
    return this.state
      ? { active: true, ...this.state }
      : { active: false, reason: null, confirmedAt: null, nextProbeAt: null };
  }
}

class LazyRecoveryProbeState extends RecoveryProbeState {
  constructor(statePath) {
    super(null);
    this.statePath = statePath;
    this.loaded = false;
  }

  ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    this.load();
  }

  isActive() { this.ensureLoaded(); return super.isActive(); }
  record(reason, nowMs = this.now()) { this.ensureLoaded(); return super.record(reason, nowMs); }
  claimRecoveryProbe(nowMs = this.now()) { this.ensureLoaded(); return super.claimRecoveryProbe(nowMs); }
  clear() { this.ensureLoaded(); return super.clear(); }
  snapshot() { this.ensureLoaded(); return super.snapshot(); }
}

export const openCodeGoQuotaState = new LazyRecoveryProbeState(OPENCODE_GO_QUOTA_STATE_FILE);

function commandCodeReasoningArgs(model, effort) {
  return COMMANDCODE_FIXED_REASONING_MODELS.has(model) ? [] : ["--effort", effort];
}

async function acquireNativeState(key) {
  const previous = nativeStateTails.get(key);
  let resolveCurrent;
  const current = new Promise((resolve) => { resolveCurrent = resolve; });
  nativeStateTails.set(key, current);
  if (previous) await previous;
  return () => {
    if (nativeStateTails.get(key) === current) nativeStateTails.delete(key);
    resolveCurrent();
  };
}

export class NativeCliAgentError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "NativeCliAgentError";
    this.status = status;
  }
}

export function validateFinalNativePrompt(prompt, label = "Native-provider prompt") {
  if (typeof prompt !== "string") {
    throw new NativeCliAgentError(`${label} must be a string`, 400);
  }
  if (prompt.length > MAX_MAIN_PROMPT_CHARS) {
    throw new NativeCliAgentError(
      `${label} requires ${prompt.length} characters, exceeding the ${MAX_MAIN_PROMPT_CHARS}-character transport limit`,
      413,
    );
  }
  return prompt;
}

function json(value) {
  return JSON.stringify(value);
}

function parsedToolInput(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function nativeRzMcpToolName(name, input) {
  const toolName = String(name || "");
  if (!LAZY_RZMCP_CALL_TOOL.test(toolName) && !NATIVE_MCP_CALL_TOOL.test(toolName)) return null;
  const outer = parsedToolInput(input);
  const nested = NATIVE_MCP_CALL_TOOL.test(toolName) && outer?.tool_name === "call_rzmcp_tool"
    ? parsedToolInput(outer.arguments)
    : outer;
  return typeof nested?.name === "string" && nested.name ? nested.name : null;
}

function toolMutationPath(input) {
  const parsed = parsedToolInput(input);
  for (const key of ["file_path", "filePath", "path", "absolute_path", "absolutePath"]) {
    if (typeof parsed?.[key] === "string" && parsed[key]) return parsed[key];
  }
  return null;
}

function pathIsWithinWorkspace(path, workingDirectory) {
  if (!workingDirectory || !isAbsolute(path)) return true;
  const offset = relative(resolve(workingDirectory), resolve(path));
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function nativeToolIsMutation(name, input, executionPolicy) {
  if (MUTATION_TOOL.test(String(name || ""))) {
    const path = toolMutationPath(input);
    return path === null || pathIsWithinWorkspace(path, executionPolicy?.workingDirectory);
  }
  if (!LAZY_RZMCP_CALL_TOOL.test(String(name || "")) && !NATIVE_MCP_CALL_TOOL.test(String(name || ""))) return false;
  if (executionPolicy?.rzMcpMode === "read-only") return false;
  const rzMcpToolName = nativeRzMcpToolName(name, input);
  return rzMcpToolName === null || !READ_ONLY_RZMCP_TOOL_NAME.test(rzMcpToolName);
}

function commandCodeMcpConfigText() {
  const commandEnvironment = {
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ""}`,
  };
  return `${JSON.stringify({
    mcpServers: {
      rzmcp: {
        // CommandCode's supported stdio MCP launcher resolves the command through PATH. Pin the
        // current Node directory first so Windows never has to shell-parse an executable path.
        command: "node",
        args: [LAZY_RZMCP_PROXY],
        env: commandEnvironment,
        enabled: true,
      },
    },
  })}\n`;
}

function ensureCommandCodeHome() {
  mkdirSync(COMMAND_CODE_HOME_CONFIG_DIRECTORY, { recursive: true });
  mkdirSync(COMMAND_CODE_LAUNCH_DIRECTORY, { recursive: true });
  const projectMcpPath = join(COMMAND_CODE_LAUNCH_DIRECTORY, ".mcp.json");
  if (existsSync(projectMcpPath)) {
    throw new NativeCliAgentError(
      `CommandCode isolated launch directory unexpectedly contains ${projectMcpPath}`,
    );
  }
  const configPath = join(COMMAND_CODE_HOME_CONFIG_DIRECTORY, "mcp.json");
  const configText = commandCodeMcpConfigText();
  let existing = null;
  try {
    existing = readFileSync(configPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new NativeCliAgentError(`Cannot read CommandCode isolated MCP configuration: ${error.message}`);
    }
  }
  if (existing !== configText) writeFileSync(configPath, configText, { encoding: "utf8" });
}

function commandCodeApiKey(source = process.env) {
  const environmentKey = typeof source.COMMAND_CODE_API_KEY === "string"
    ? source.COMMAND_CODE_API_KEY.trim()
    : "";
  if (environmentKey) return environmentKey;
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".commandcode", "auth.json"), "utf8"));
    return typeof auth?.apiKey === "string" && auth.apiKey.trim() ? auth.apiKey.trim() : null;
  } catch {
    return null;
  }
}

function commandCodeEnvironment() {
  ensureCommandCodeHome();
  const env = sanitizeChildEnvironment(process.env, { credentialScope: "commandcode" });
  env.HOME = COMMAND_CODE_HOME_DIRECTORY;
  env.USERPROFILE = COMMAND_CODE_HOME_DIRECTORY;
  const apiKey = commandCodeApiKey();
  if (apiKey) env.COMMAND_CODE_API_KEY = apiKey;
  return env;
}

function commandCodePrompt(context, prompt = context.prompt) {
  return `[CommandCode workspace boundary]\nThe CLI launch directory is an internal MCP-isolation directory, not the project. The authoritative workspace is ${context.workingDirectory}. Use absolute paths for file tools. Begin every shell command by changing to that workspace with PowerShell Set-Location -LiteralPath. Do not inspect or write the internal launch directory.\n\n${prompt}`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function nativeStatePaths(dbPath) {
  return [dbPath, `${dbPath}-shm`, `${dbPath}-wal`];
}

function reportRetainedNativeState(path, error) {
  const name = path.split(/[\\/]/).at(-1) || "unknown";
  process.stderr.write(
    `[RzCodex] Deferred cleanup of native CLI state ${name}: ${error?.code || error?.name || "unknown_error"}\n`,
  );
}

async function cleanupNativeState(dbPath) {
  const deadline = Date.now() + STATE_CLEANUP_RELEASE_MS;
  const pending = new Set(nativeStatePaths(dbPath));
  let lastError = null;
  do {
    for (const path of [...pending]) {
      try {
        unlinkSync(path);
        pending.delete(path);
      } catch (error) {
        if (error?.code === "ENOENT") pending.delete(path);
        else lastError = error;
      }
    }
    if (pending.size === 0 || Date.now() >= deadline) break;
    await delay(STATE_CLEANUP_RETRY_MS);
  } while (true);
  const markerPath = `${dbPath}${ORPHAN_STATE_MARKER_SUFFIX}`;
  if (pending.size > 0) {
    for (const path of pending) reportRetainedNativeState(path, lastError);
    try {
      writeFileSync(markerPath, `${json({ version: 1, dbPath, orphanedAt: Date.now() })}\n`, "utf8");
    } catch (error) {
      reportRetainedNativeState(markerPath, error);
    }
  } else {
    try { unlinkSync(markerPath); } catch (error) {
      if (error?.code !== "ENOENT") reportRetainedNativeState(markerPath, error);
    }
  }
}

function sweepStaleNativeState(now = Date.now()) {
  if (!existsSync(OPENCODE_STATE_DIRECTORY)) return;
  for (const name of readdirSync(OPENCODE_STATE_DIRECTORY)) {
    if (!name.endsWith(`.db${ORPHAN_STATE_MARKER_SUFFIX}`)) continue;
    const markerPath = join(OPENCODE_STATE_DIRECTORY, name);
    try {
      if (now - statSync(markerPath).mtimeMs < STALE_STATE_AGE_MS) continue;
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      const dbPath = resolve(String(marker?.dbPath || ""));
      const expectedDbPath = resolve(markerPath.slice(0, -ORPHAN_STATE_MARKER_SUFFIX.length));
      if (marker?.version !== 1 || dbPath !== expectedDbPath) {
        throw new Error("invalid native-state orphan marker");
      }
      if (retainedOpenCodeSessions.has(dbPath) || nativeStateTails.has(dbPath)) continue;
      for (const path of nativeStatePaths(dbPath)) {
        try { unlinkSync(path); } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      unlinkSync(markerPath);
    } catch (error) {
      if (error?.code !== "ENOENT") reportRetainedNativeState(markerPath, error);
    }
  }
}

function inputArray(body) {
  if (typeof body.input === "string") {
    return [{ type: "message", role: "user", content: [{ type: "input_text", text: body.input }] }];
  }
  if (!Array.isArray(body.input)) throw new NativeCliAgentError("input must be a string or array", 400);
  return body.input;
}

function environmentWorkingDirectoryFrom(input) {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!item || item.type !== "message") continue;
    const content = typeof item.content === "string"
      ? item.content
      : Array.isArray(item.content)
        ? item.content.map((part) => part?.text || "").join("")
        : "";
    const matches = [...content.matchAll(/<environment_context>[\s\S]*?<cwd>\s*([^<\r\n]+?)\s*<\/cwd>[\s\S]*?<\/environment_context>/gi)];
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
  throw new NativeCliAgentError("native CLI route received no valid authoritative working directory", 400);
}

function roleInstructionsFrom(instructions) {
  if (typeof instructions !== "string") return "";
  const sections = [];
  for (const match of instructions.matchAll(ROLE_TAG)) {
    const text = match[1]?.trim();
    if (text) sections.push(text);
  }
  return sections.join("\n\n");
}

function portableText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value == null ? "" : json(value);
  return value.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    if (typeof part.text === "string") return part.text;
    if (part.type === "input_image" || part.type === "image") return "[Image input]";
    return "";
  }).filter(Boolean).join("\n");
}

function mainAgentHistory(input, availableChars) {
  const sections = [];
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!item || typeof item !== "object") continue;
    if (item.type === "message") {
      const text = portableText(item.content);
      if (text) sections.push({ inputIndex: index, current: item.role === "user", text: `[${item.role || "message"}]\n${text}` });
      continue;
    }
    if (item.type === "agent_message") {
      const text = portableText(item.content);
      if (text) sections.push({ inputIndex: index, current: true, text: `[Agent message]\n${text}` });
      continue;
    }
    if (item.type === "reasoning") {
      const text = Array.isArray(item.summary)
        ? item.summary.map((part) => part?.text || "").join("")
        : "";
      if (text) sections.push({ inputIndex: index, current: false, text: `[Prior reasoning summary]\n${text}` });
      continue;
    }
    if (["function_call", "custom_tool_call", "tool_search_call"].includes(item.type)) {
      sections.push({ inputIndex: index, current: false, text: `[Prior Codex tool request ${item.name || "tool_search"}]\n${portableText(item.arguments ?? item.input ?? item.query)}` });
      continue;
    }
    if (["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(item.type)) {
      sections.push({ inputIndex: index, current: false, text: `[Prior Codex tool result]\n${portableText(item.output ?? item.tools)}` });
    }
  }
  const currentStart = sections.findLast((section) => section.current)?.inputIndex;
  if (currentStart === undefined) {
    throw new NativeCliAgentError("native main-agent route received no current user request", 400);
  }
  const required = sections.filter((section) => section.inputIndex >= currentStart);
  const requiredChars = required.reduce((total, section) => total + section.text.length + 2, 0);
  if (requiredChars > availableChars) {
    throw new NativeCliAgentError(
      `Current main-agent request requires ${requiredChars} prompt characters, exceeding the ${availableChars}-character remaining native-provider limit`,
      413,
    );
  }
  const retained = [];
  let chars = requiredChars;
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const section = sections[index];
    if (section.inputIndex >= currentStart) {
      retained.unshift(section.text);
      continue;
    }
    if (chars + section.text.length + 2 > availableChars) continue;
    retained.unshift(section.text);
    chars += section.text.length + 2;
  }
  return retained;
}

function latestControlMessage(taskState) {
  if (!taskState.activeTask) return "";
  const message = taskState.messages.filter((entry) => entry.index > taskState.activeTask.index).at(-1);
  return message?.text?.trim() || "";
}

function retainedDeliveryItems(input, taskState) {
  const taskMessagesByIndex = new Map(taskState.messages.map((message) => [message.index, message]));
  const items = [];
  const identities = new Set();
  const append = (inputIndex, item, kind, text) => {
    const itemId = typeof item.id === "string" && item.id
      ? item.id
      : kind === "tool_result" && typeof item.call_id === "string" && item.call_id
        ? item.call_id
        : null;
    const identitySource = typeof item.id === "string" && item.id ? "item" : "call";
    if (!itemId) {
      throw new NativeCliAgentError(
        `Retained native delivery item input[${inputIndex}] (${item.type}) has no stable item.id${kind === "tool_result" ? " or call_id" : ""}`,
        400,
      );
    }
    if (itemId.length > MAX_RETAINED_DELIVERY_ID_CHARS) {
      throw new NativeCliAgentError(
        `Retained native delivery item input[${inputIndex}] identity is ${itemId.length} characters; maximum is ${MAX_RETAINED_DELIVERY_ID_CHARS}`,
        413,
      );
    }
    const identity = `${item.type}:${identitySource}:${itemId}`;
    if (identities.has(identity)) {
      throw new NativeCliAgentError(
        `Retained native delivery received duplicate stable identity ${JSON.stringify(identity)}`,
        400,
      );
    }
    identities.add(identity);
    if (identities.size > MAX_RETAINED_DELIVERY_IDENTITIES) {
      throw new NativeCliAgentError(
        `Retained native delivery contains more than ${MAX_RETAINED_DELIVERY_IDENTITIES} identity-bearing items`,
        413,
      );
    }
    items.push({ inputIndex, identity, kind, text });
  };
  for (let inputIndex = 0; inputIndex < input.length; inputIndex += 1) {
    const item = input[inputIndex];
    if (!item || typeof item !== "object") continue;
    if (item.type === "agent_message") {
      const text = taskMessagesByIndex.get(inputIndex)?.text;
      if (text) append(inputIndex, item, "parent_control", text);
      continue;
    }
    if (["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(item.type)) {
      const outputText = portableText(item.output ?? item.tools);
      append(
        inputIndex,
        item,
        "tool_result",
        `[New Codex tool result${item.call_id ? `: ${item.call_id}` : ""}]\n${outputText || "(empty result)"}`,
      );
    }
  }
  return items;
}

function activeTaskDeliveryIdentity(context) {
  return context.retainedDeliveryItems
    .find((item) => item.inputIndex === context.taskState.activeTask?.index)
    ?.identity ?? null;
}

function deliveredNativeInput(context, retainedSession = null) {
  const deliveredItemIdentities = new Set(retainedSession?.deliveredItemIdentities || []);
  for (const item of context.retainedDeliveryItems) deliveredItemIdentities.add(item.identity);
  if (deliveredItemIdentities.size > MAX_RETAINED_DELIVERY_IDENTITIES) {
    throw new NativeCliAgentError(
      `Retained native session delivery identity state would exceed ${MAX_RETAINED_DELIVERY_IDENTITIES} items`,
      413,
    );
  }
  return {
    lastDeliveredTaskIdentity: activeTaskDeliveryIdentity(context),
    lastDeliveredTaskHash: context.taskState.activeTask?.hash ?? null,
    deliveredItemIdentities: [...deliveredItemIdentities],
  };
}

function retainedContinuation(context, retainedSession) {
  const activeTask = context.taskState.activeTask;
  const activeTaskIdentity = activeTaskDeliveryIdentity(context);
  const taskChanged = retainedSession.lastDeliveredTaskIdentity !== activeTaskIdentity
    || retainedSession.lastDeliveredTaskHash !== activeTask?.hash;
  const deliveredItemIdentities = new Set(retainedSession.deliveredItemIdentities || []);
  const sections = [
    "[Retained native session continuation]\nContinue the same bounded assignment from the provider-private state retained in this session. Do not restart the investigation or repeat completed work. Apply only the new authoritative task/control/result material below, then continue or return immediately as directed.",
  ];
  if (taskChanged) sections.push(activeTaskPromptSection(context.taskState));
  for (const item of context.retainedDeliveryItems) {
    if (deliveredItemIdentities.has(item.identity)) continue;
    if (item.inputIndex === activeTask?.index) continue;
    sections.push(item.kind === "parent_control"
      ? `[New parent control message - authoritative]\n${item.text}`
      : item.text);
  }
  sections.push(...taskControlPromptSections(context.taskState));
  const prompt = sections.filter(Boolean).join("\n\n");
  validateFinalNativePrompt(prompt, "Retained native-provider continuation");
  let taskDiagnostics;
  try {
    taskDiagnostics = taskDeliveryDiagnostics(context.taskState, prompt, {
      activeTaskIncludedThisTurn: taskChanged,
      retainedInProviderSession: !taskChanged,
    });
  } catch (error) {
    if (error instanceof TaskStateError) throw new NativeCliAgentError(error.message, 400);
    throw error;
  }
  return {
    prompt,
    taskDiagnostics,
    delivery: deliveredNativeInput(context, retainedSession),
  };
}

export function nativeExecutionPolicyFromTaskState(taskState) {
  return checkedExecutionPolicy({
    rzMcpMode: rzMcpModeForTask(taskState.activeTask?.text || ""),
  });
}

export function nativeCliAgentContext(body, { provider, model, requiredEffort, mainAgent = false }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new NativeCliAgentError("request body must be an object", 400);
  }
  if (body.stream !== true) throw new NativeCliAgentError(`${provider} native CLI bridge requires stream=true`, 400);
  const effort = body.reasoning?.effort;
  if (effort !== undefined && effort !== requiredEffort) {
    throw new NativeCliAgentError(`${provider} native CLI route requires reasoning effort ${requiredEffort}, got ${effort}`, 400);
  }
  const input = inputArray(body);
  let taskState;
  try {
    taskState = taskStateFromInput(input, MAX_ACTIVE_TASK_CHARS);
  } catch (error) {
    if (error instanceof TaskStateError) throw new NativeCliAgentError(error.message, 400);
    throw error;
  }
  if (!mainAgent && !taskState.activeTask) {
    throw new NativeCliAgentError(`${provider} native CLI route received no active NEW_TASK payload`, 400);
  }
  const workingDirectory = workingDirectoryFrom(body, input);
  const executionPolicy = mainAgent
    ? checkedExecutionPolicy({ rzMcpMode: "full" })
    : nativeExecutionPolicyFromTaskState(taskState);
  const turnContract = mainAgent
    ? "[RzCodex main-agent contract]\nAct as the primary coding agent for this conversation. Use your local file, search, edit, shell, and lazy RzMCP tools directly. Follow the supplied RzCodex and project instructions, preserve unrelated work, and complete the current user request before returning unless a concrete blocker requires user input."
    : taskState.activeTask?.intent === "analysis"
      ? "[Single native-agent turn contract]\nComplete this delegated task within this one Codex subagent turn using local file read, search, and edit tools directly. Builds, compilation, tests, editor control, PIE/SIE, runtime validation, and final integration are disabled and reserved to the parent. Never delegate or request that the parent perform an ordinary read/search operation. Return the bounded analysis with concrete evidence, then state any residual uncertainty."
      : "[Single native-agent turn contract]\nComplete this delegated task within this one Codex subagent turn using local file read, search, and edit tools directly. Builds, compilation, tests, editor control, PIE/SIE, runtime validation, and final integration are disabled and reserved to the parent. Never delegate or request that the parent perform an ordinary file operation. Implement and statically review the bounded change, then report the exact focused validation the parent should run.";
  const platformBoundary = mainAgent
    ? "The host shell is PowerShell on Windows."
    : "Local file, search, edit, and shell tools are exposed in this turn; the host shell is PowerShell on Windows. Builds, tests, editor control, PIE/SIE, and runtime validation remain reserved to the parent.";
  const sections = [
    turnContract,
    `[Native tool boundary]\n${platformBoundary} Never read, grep, decode, strings-scan, hex-dump, or otherwise inspect Unreal .uasset or .umap bytes through file or shell tools. When the task authorizes RzMCP, it is exposed lazily as exactly search_rzmcp_tools and call_rzmcp_tool: search for a focused schema first, then call only a discovered tool. Never enumerate or request the full RzMCP catalog. If those tools are disabled, unavailable, or semantically insufficient, return that concrete blocker; do not approximate asset semantics from binary bytes or repeat equivalent offset/chunk probes. Never read secret environment files.`,
    projectInstructionsPromptSection(workingDirectory),
  ];
  if (mainAgent) {
    if (typeof body.instructions === "string" && body.instructions.trim()) {
      sections.push(`[RzCodex instructions]\n${body.instructions.trim()}`);
    }
    const fixedPromptChars = sections.filter(Boolean).join("\n\n").length;
    sections.push(...mainAgentHistory(input, MAX_MAIN_PROMPT_CHARS - fixedPromptChars - 2));
  } else {
    const role = roleInstructionsFrom(body.instructions);
    if (role) sections.push(`[Role instructions]\n${role}`);
    sections.push(referencedPriorTaskPromptSection(taskState));
    sections.push(activeTaskPromptSection(taskState));
    sections.push(...taskControlPromptSections(taskState));
    const control = latestControlMessage(taskState);
    if (control && control !== taskState.activeTask.text) sections.push(`[Latest parent control message]\n${control}`);
  }
  const prompt = sections.filter(Boolean).join("\n\n");
  validateFinalNativePrompt(prompt);
  let diagnostics;
  try {
    diagnostics = taskDeliveryDiagnostics(taskState, prompt);
  } catch (error) {
    if (error instanceof TaskStateError) throw new NativeCliAgentError(error.message, 400);
    throw error;
  }
  return {
    provider,
    model,
    requiredEffort,
    mainAgent,
    threadId: typeof body.client_metadata?.thread_id === "string"
      ? body.client_metadata.thread_id
      : null,
    prompt,
    workingDirectory,
    taskState,
    taskDiagnostics: diagnostics,
    executionPolicy,
    retainedDeliveryItems: retainedDeliveryItems(input, taskState),
    toolSchemaBytesIgnored: Buffer.byteLength(json(body.tools || [])),
  };
}

function retainedNativeStatePath(context, providerKind) {
  const ownershipHash = taskOwnershipHash(context.taskState) ?? context.taskDiagnostics?.taskHash;
  if (!context.threadId || !ownershipHash) {
    return join(OPENCODE_STATE_DIRECTORY, `${randomUUID()}.db`);
  }
  const threadHash = createHash("sha256").update(context.threadId).digest("hex").slice(0, 20);
  const taskHash = createHash("sha256").update(ownershipHash).digest("hex").slice(0, 20);
  const rawModel = context.model ?? "";
  const modelSlug = rawModel ? rawModel.replace(/[^a-zA-Z0-9._-]/g, "_") : "";
  const prefix = modelSlug ? `${providerKind}-${modelSlug}` : providerKind;
  return join(OPENCODE_STATE_DIRECTORY, `${prefix}-${threadHash}-${taskHash}.db`);
}

function commandCodeSessionName(context) {
  const ownershipHash = taskOwnershipHash(context.taskState) ?? context.taskDiagnostics?.taskHash;
  return context.threadId && ownershipHash
    ? `rzcodex-${createHash("sha256").update(`${context.threadId}:${ownershipHash}`).digest("hex").slice(0, 24)}`
    : null;
}

function nativeStateExists(dbPath) {
  return nativeStatePaths(dbPath).some((path) => existsSync(path));
}

function nativeProcess({
  command,
  args,
  cwd,
  env,
  signal,
  onEvent,
  parseLine,
  inspectStderr,
  label,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  routeOwnershipTimeoutMs = ROUTE_OWNERSHIP_TIMEOUT_MS,
  stdinText = null,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: [stdinText === null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let settled = false;
    let terminationError = null;
    let stdoutBuffer = "";
    let stderr = "";
    const routeOwnershipDeadline = Date.now() + routeOwnershipTimeoutMs;
    const state = {};
    const requestTimer = setTimeout(() => {
      terminate(new NativeCliAgentError(`${label} exceeded ${requestTimeoutMs}ms`, 504));
    }, requestTimeoutMs);
    const routeOwnershipTimer = setInterval(() => {
      if (
        state.providerActivityObserved
        || state.providerToolStarted
        || (state.toolNames || []).length > 0
      ) {
        clearInterval(routeOwnershipTimer);
        return;
      }
      if (Date.now() < routeOwnershipDeadline) return;
      terminate(new NativeCliAgentError(
        `${label} did not begin provider tool work within ${routeOwnershipTimeoutMs}ms`,
        504,
      ));
    }, Math.min(1_000, Math.max(10, Math.floor(routeOwnershipTimeoutMs / 4))));
    routeOwnershipTimer.unref?.();
    const abort = () => {
      terminate(new NativeCliAgentError(`${label} was aborted`, 499));
    };
    const terminate = (error) => {
      if (settled || terminationError) return;
      terminationError = attachNativeState(error, state);
      child.kill();
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(requestTimer);
      clearInterval(routeOwnershipTimer);
      signal?.removeEventListener("abort", abort);
      if (error) {
        attachNativeState(error, state);
      }
      error ? reject(error) : resolve(value);
    };
    const consume = (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        parseLine(event, state);
        onEvent?.(event, state);
      } catch (error) {
        if (error instanceof SyntaxError) {
          stderr = `${stderr}${line}\n`.slice(-STDERR_LIMIT);
          return;
        }
        terminate(error);
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        consume(stdoutBuffer.slice(0, newline));
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-STDERR_LIMIT);
      try {
        inspectStderr?.(stderr, state);
      } catch (error) {
        terminate(error);
      }
    });
    child.once("error", (error) => finish(
      terminationError || new NativeCliAgentError(`${label} failed to start: ${error.message}`),
    ));
    child.once("close", (code, closeSignal) => {
      consume(stdoutBuffer);
      if (settled) return;
      if (terminationError) {
        finish(terminationError);
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
        finish(new NativeCliAgentError(`${label} exited with ${closeSignal ? `signal ${closeSignal}` : `code ${code}`}${detail}`));
        return;
      }
      finish(undefined, { state, stderr });
    });
    if (stdinText !== null) {
      child.stdin.once("error", (error) => {
        terminate(new NativeCliAgentError(`${label} could not receive its prompt on stdin: ${error.message}`));
      });
      child.stdin.end(stdinText, "utf8");
    }
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function validateResult(context, result) {
  const fail = (message) => {
    const error = new NativeCliAgentError(message);
    error.nativeToolNames = [...(result.toolNames || [])];
    error.providerMutationCount = Number(result.mutationCount || 0);
    throw error;
  };
  if (!result.finalText?.trim()) fail(`${context.provider} CLI completed without a final report`);
  if (
    Number(result.lastToolSequence || 0) > 0
    && Number(result.lastTextSequence || 0) <= Number(result.lastToolSequence || 0)
  ) {
    fail(`${context.provider} CLI ended after native tool execution without a terminal assistant message`);
  }
  return result;
}

function openCodeResult(context, state, model) {
  return {
    finalText: state.finalText || "",
    toolNames: state.toolNames || [],
    toolInputs: state.toolInputs || [],
    rzMcpTools: state.rzMcpTools || [],
    mutationCount: state.mutationCount || 0,
    inputTokens: state.inputTokens || 0,
    outputTokens: state.outputTokens || 0,
    peakTurnInputTokens: state.peakTurnInputTokens || 0,
    lastTextSequence: state.lastTextSequence || 0,
    lastToolSequence: state.lastToolSequence || 0,
    startedTools: [...(state.startedTools || [])],
    commitUncertain: (state.startedTools || []).some((tool) => tool.status !== "completed"),
    model,
  };
}

function attachNativeState(error, state) {
  const nativeState = state || {};
  error.nativeToolNames = [...(nativeState.toolNames || error.nativeToolNames || [])];
  error.nativeRzMcpTools = [...(nativeState.rzMcpTools || error.nativeRzMcpTools || [])];
  error.toolCalls = error.nativeToolNames.length;
  error.rzMcpTools = [...error.nativeRzMcpTools];
  error.providerMutationCount = Number(
    nativeState.mutationCount ?? error.providerMutationCount ?? 0,
  );
  error.nativeToolInputs = [...(nativeState.toolInputs || error.nativeToolInputs || [])];
  error.nativeStartedTools = [
    ...(nativeState.startedTools || error.nativeStartedTools || []),
  ].map((tool) => ({ ...tool }));
  error.commitUncertain = nativeState.commitUncertain === true
    || (nativeState.startedTools || []).some((tool) => tool.status !== "completed")
    || error.commitUncertain === true;
  if (error.nativeToolNames.length > 0 || nativeState.providerToolStarted === true) {
    error.routeCommitted = true;
  }
  Object.defineProperty(error, "nativeState", {
    value: nativeState,
    configurable: true,
  });
  return error;
}

function mergeNativeExecutionResults(previous, current) {
  if (!previous) return current;
  return {
    ...current,
    toolNames: [...(previous.toolNames || []), ...(current.toolNames || [])],
    toolInputs: [...(previous.toolInputs || []), ...(current.toolInputs || [])],
    rzMcpTools: [...(previous.rzMcpTools || []), ...(current.rzMcpTools || [])],
    mutationCount: Number(previous.mutationCount || 0) + Number(current.mutationCount || 0),
    inputTokens: Number(previous.inputTokens || 0) + Number(current.inputTokens || 0),
    outputTokens: Number(previous.outputTokens || 0) + Number(current.outputTokens || 0),
    peakTurnInputTokens: Math.max(
      Number(previous.peakTurnInputTokens || 0),
      Number(current.peakTurnInputTokens || 0),
    ),
    executionCount: Number(previous.executionCount || 1) + Number(current.executionCount || 1),
    sameSessionContinuations: Number(previous.sameSessionContinuations || 0)
      + Number(current.sameSessionContinuations || 0),
    startedTools: [...(previous.startedTools || []), ...(current.startedTools || [])],
    commitUncertain: previous.commitUncertain === true || current.commitUncertain === true,
  };
}

function terminalRecoveryPrompt(context, primary) {
  return [
    "[Native CLI terminal-message recovery]",
    "The retained provider stream was interrupted after completed native tool work and before a terminal assistant response.",
    "Continue this same bounded task in the same session. Do not restart the investigation, repeat completed tool calls, or delegate.",
    "Return only when the task is complete or a concrete blocker requires parent input.",
    `Task hash: ${context.taskDiagnostics.taskHash}`,
    `Completed native tool calls before recovery: ${primary.toolNames.length}`,
    `Observed mutation calls before recovery: ${primary.mutationCount}`,
    referencedPriorTaskPromptSection(context.taskState),
    activeTaskPromptSection(context.taskState),
  ].join("\n");
}

function mergeRecoveredResult(primary, recovered) {
  return {
    ...recovered,
    toolNames: [...primary.toolNames, ...recovered.toolNames],
    toolInputs: [...(primary.toolInputs || []), ...(recovered.toolInputs || [])],
    rzMcpTools: [...(primary.rzMcpTools || []), ...(recovered.rzMcpTools || [])],
    mutationCount: primary.mutationCount + recovered.mutationCount,
    inputTokens: primary.inputTokens + recovered.inputTokens,
    outputTokens: primary.outputTokens + recovered.outputTokens,
    peakTurnInputTokens: Math.max(primary.peakTurnInputTokens, recovered.peakTurnInputTokens),
    executionCount: 2,
    sameSessionContinuations: 1,
    startedTools: [...(primary.startedTools || []), ...(recovered.startedTools || [])],
    commitUncertain: primary.commitUncertain === true || recovered.commitUncertain === true,
  };
}

async function completeOpenCodeTurn(context, model, runInitial, runContinuation, onRecovery) {
  let primary;
  let initialFailure = null;
  try {
    const state = await runInitial();
    primary = openCodeResult(context, state, model);
    try {
      return {
        ...validateResult(context, primary),
        executionCount: 1,
        sameSessionContinuations: 0,
      };
    } catch (error) {
      throw attachNativeState(error, state);
    }
  } catch (error) {
    initialFailure = error;
    primary = openCodeResult(context, error.nativeState || {
      toolNames: error.nativeToolNames || [],
      mutationCount: error.providerMutationCount || 0,
    }, model);
  }
  if (initialFailure?.status === 499 || primary.toolNames.length === 0 || primary.commitUncertain) {
    throw initialFailure;
  }
  onRecovery?.({
    toolCalls: primary.toolNames.length,
    mutationCount: primary.mutationCount,
  });
  try {
    const recoveryState = await runContinuation(terminalRecoveryPrompt(context, primary));
    let recovered;
    try {
      recovered = validateResult(context, openCodeResult(context, recoveryState, model));
    } catch (error) {
      throw attachNativeState(error, recoveryState);
    }
    return mergeRecoveredResult(primary, recovered);
  } catch (error) {
    const recoveryState = error.nativeState || {
      toolNames: error.nativeToolNames || [],
      mutationCount: error.providerMutationCount || 0,
    };
    const combined = mergeRecoveredResult(primary, openCodeResult(context, recoveryState, model));
    const failure = new NativeCliAgentError(
      `${context.provider} CLI remained non-terminal after one same-session continuation: ${error.message}`,
      error.status || 502,
    );
    throw attachNativeState(failure, combined);
  }
}

function openCodeConfig(context, providerKind) {
  const rzMcpEnabled = context.executionPolicy.rzMcpMode !== "disabled";
  const config = {
    enabled_providers: [providerKind],
    plugin: [],
    instructions: [],
    snapshot: false,
    autoupdate: false,
    skills: { paths: [] },
    default_agent: OPENCODE_PRIMARY_AGENT,
    agent: {
      [OPENCODE_PRIMARY_AGENT]: {
        mode: "primary",
      },
      [OPENCODE_TERMINAL_AGENT]: {
        mode: "primary",
        steps: OPENCODE_TERMINAL_STEPS,
      },
    },
    permission: {
      "*": "allow",
      read: {
        "*": "allow",
        "*.env": "deny",
        "*.env.*": "deny",
        "*.env.example": "allow",
        "*.uasset": "deny",
        "**/*.uasset": "deny",
        "*.umap": "deny",
        "**/*.umap": "deny",
      },
      bash: {
        "*": "allow",
        "rg *uasset*": "deny",
        "rg *umap*": "deny",
        "grep *uasset*": "deny",
        "grep *umap*": "deny",
        "Get-Content *uasset*": "deny",
        "Get-Content *umap*": "deny",
        "Select-String *uasset*": "deny",
        "Select-String *umap*": "deny",
        "*.env*": "deny",
        "*.env.example*": "allow",
        "*.uasset*": "deny",
        "*.umap*": "deny",
        "*ReadAllBytes*": "deny",
        "*Format-Hex*": "deny",
      },
      grep: {
        "*": "allow",
        "*.uasset": "deny",
        "**/*.uasset": "deny",
        "*.umap": "deny",
        "**/*.umap": "deny",
      },
      glob: {
        "*": "allow",
        "*.uasset": "deny",
        "**/*.uasset": "deny",
        "*.umap": "deny",
        "**/*.umap": "deny",
      },
      task: "deny",
      question: "deny",
      webfetch: "deny",
      websearch: "deny",
      doom_loop: "deny",
    },
    mcp: {
      "chrome-devtools": { enabled: false },
      "backblaze-backup": { enabled: false },
      discord: { enabled: false },
      rzmcp: rzMcpEnabled
        ? { type: "local", command: [process.execPath, LAZY_RZMCP_PROXY], enabled: true, timeout: 300_000 }
        : { enabled: false },
    },
  };
  if (providerKind === "ollama") {
    config.provider = {
      ollama: {
        npm: "@ai-sdk/openai-compatible",
        name: "Ollama",
        options: { baseURL: "http://127.0.0.1:11434/v1" },
        models: {
          [context.model]: {
            name: context.model,
            tool_call: true,
            reasoning: true,
            limit: { context: OLLAMA_CLOUD_CONTEXT_WINDOW, output: 32_768 },
          },
        },
      },
    };
  }
  return json(config);
}

function openCodeQuotaError(event, providerKind) {
  if (providerKind !== "opencode-go") return false;
  const error = event?.error || {};
  const evidence = [
    error.name,
    error.data?.message,
    typeof error.data?.responseBody === "string"
      ? error.data.responseBody
      : JSON.stringify(error.data?.responseBody || {}),
  ].filter((value) => typeof value === "string").join("\n");
  return OPENCODE_GO_QUOTA_LIMIT.test(evidence);
}

function openCodeParser(event, state, executionPolicy, providerKind = null) {
  state.finalText ||= "";
  state.toolNames ||= [];
  state.toolInputs ||= [];
  state.rzMcpTools ||= [];
  state.mutationCount ||= 0;
  state.inputTokens ||= 0;
  state.outputTokens ||= 0;
  state.peakTurnInputTokens ||= 0;
  state.startedTools ||= [];
  state.startedToolIndexes ||= new Map();
  state.eventSequence = Number(state.eventSequence || 0) + 1;
  if (event.type === "error") {
    const errorName = typeof event.error?.name === "string" ? event.error.name : "provider error";
    const dataMessage = typeof event.error?.data?.message === "string" ? event.error.data.message : "";
    const detail = dataMessage ? `: ${dataMessage}` : "";
    const error = new NativeCliAgentError(`OpenCode reported ${errorName}${detail}`, 502);
    error.openCodeErrorName = errorName;
    error.openCodeErrorDataMessage = dataMessage;
    error.openCodeQuotaError = openCodeQuotaError(event, providerKind);
    throw error;
  }
  if (
    ["step_start", "step-start"].includes(event.type)
    || (event.type === "reasoning" && typeof event.part?.text === "string" && event.part.text.length > 0)
    || (event.type === "text" && typeof event.part?.text === "string" && event.part.text.length > 0)
  ) {
    state.providerActivityObserved = true;
  }
  if (event.type === "text" && typeof event.part?.text === "string") {
    state.finalText = event.part.text;
    state.lastTextSequence = state.eventSequence;
  }
  if (event.type === "tool_use") {
    state.providerToolStarted = true;
    const name = String(event.part.tool || "unknown_tool");
    const input = event.part?.state?.input;
    const key = String(
      event.part?.id
      || event.part?.callID
      || event.part?.callId
      || createHash("sha256").update(`${name}\0${json(input ?? null)}`).digest("hex"),
    );
    let toolIndex = state.startedToolIndexes.get(key);
    if (toolIndex === undefined) {
      toolIndex = state.startedTools.length;
      state.startedToolIndexes.set(key, toolIndex);
      state.startedTools.push({ key, name, input: input ?? null, status: "started" });
      state.toolNames.push(name);
      state.toolInputs.push(input ?? null);
      state.lastToolSequence = state.eventSequence;
      if (nativeToolIsMutation(name, input, executionPolicy)) state.mutationCount += 1;
    } else if (input !== undefined) {
      state.startedTools[toolIndex].input = input;
      state.toolInputs[toolIndex] = input;
    }
    if (event.part?.state?.status === "completed") {
      state.startedTools[toolIndex].status = "completed";
    }
    if (LAZY_RZMCP_CALL_TOOL.test(name)) {
      const outer = parsedToolInput(input);
      const nested = outer?.tool_name === "call_rzmcp_tool"
        ? parsedToolInput(outer.arguments)
        : outer;
      if (typeof nested?.name === "string" && nested.name && !state.rzMcpTools.includes(nested.name)) {
        state.rzMcpTools.push(nested.name);
      }
    }
  }
  if (event.type === "step_finish") {
    const input = Number(event.part?.tokens?.input || 0);
    state.inputTokens += input;
    state.outputTokens += Number(event.part?.tokens?.output || 0);
    state.peakTurnInputTokens = Math.max(state.peakTurnInputTokens, input);
  }
}

function openCodeRunArgs(
  context,
  providerKind,
  continueSession = false,
  agent = OPENCODE_PRIMARY_AGENT,
) {
  const args = ["run", "--pure", "--auto", "--format", "json"];
  args.push("--print-logs", "--log-level", "ERROR");
  if (continueSession) args.push("--continue");
  else args.push("--title", "RzCodex native subagent");
  args.push(
    "--agent", agent,
    "--model", `${providerKind}/${context.model}`,
    "--variant", context.requiredEffort,
    "--dir", context.workingDirectory,
  );
  return args;
}

function inspectOpenCodeStderr(providerKind, stderr) {
  if (providerKind === "ollama" && OLLAMA_USAGE_LIMIT.test(stderr)) {
    const error = new NativeCliAgentError(
      "Ollama cloud usage limit is currently exhausted",
      503,
    );
    error.quotaFailure = true;
    throw error;
  }
  if (providerKind === "opencode-go" && OPENCODE_GO_QUOTA_LIMIT.test(stderr)) {
    const error = new NativeCliAgentError(
      "OpenCode Go usage quota or credits are currently exhausted",
      503,
    );
    error.openCodeQuotaError = true;
    throw error;
  }
  if (
    (providerKind === "opencode" || providerKind === "opencode-go")
    && OPENCODE_TRANSIENT_RATE_LIMIT.test(stderr)
  ) {
    const error = new NativeCliAgentError(
      `${providerKind} is currently rate limited`,
      503,
    );
    error.transientProviderFailure = true;
    throw error;
  }
}

function routeOwnershipTimeout(continueSession, requestTimeoutMs) {
  return continueSession
    ? requestTimeoutMs
    : Math.min(ROUTE_OWNERSHIP_TIMEOUT_MS, requestTimeoutMs);
}

export async function runOpenCodeNativeAgent(context, {
  providerKind,
  signal,
  onEvent,
  onRecovery,
  onSessionStart,
}) {
  if (!existsSync(OPENCODE_EXE)) throw new NativeCliAgentError(`OpenCode CLI is missing at ${OPENCODE_EXE}`);
  if (!existsSync(LAZY_RZMCP_PROXY)) throw new NativeCliAgentError(`Lazy RzMCP proxy is missing at ${LAZY_RZMCP_PROXY}`);
  mkdirSync(OPENCODE_STATE_DIRECTORY, { recursive: true });
  sweepStaleNativeState();
  const dbPath = retainedNativeStatePath(context, providerKind);
  const releaseNativeState = await acquireNativeState(dbPath);
  const retainedSession = retainedOpenCodeSessions.get(dbPath) || null;
  const resumeRetainedSession = retainedSession !== null && nativeStateExists(dbPath);
  onSessionStart?.({ resumed: resumeRetainedSession });
  const priorProgress = resumeRetainedSession ? retainedSession.progress : null;
  let turnDelivery;
  try {
    turnDelivery = resumeRetainedSession
      ? retainedContinuation(context, retainedSession)
      : {
          prompt: context.prompt,
          taskDiagnostics: context.taskDiagnostics,
          delivery: deliveredNativeInput(context),
        };
  } catch (error) {
    releaseNativeState();
    throw error;
  }
  retainedOpenCodeSessions.delete(dbPath);
  if (!resumeRetainedSession) {
    if (nativeStateExists(dbPath)) await cleanupNativeState(dbPath);
  }
  const env = {
    ...sanitizeChildEnvironment(process.env, {
      credentialScope: providerKind === "ollama" ? "ollama" : "opencode",
    }),
    RZCODEX_SUBAGENT_RZMCP_MODE: context.executionPolicy.rzMcpMode,
    OPENCODE_CONFIG_CONTENT: openCodeConfig(context, providerKind),
    OPENCODE_DB: dbPath,
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_SHARE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
  };
  const model = `${providerKind}/${context.model}`;
  const parserPolicy = {
    ...context.executionPolicy,
    workingDirectory: context.workingDirectory,
  };
  const run = async (
    prompt,
    continueSession,
    timeoutMs = REQUEST_TIMEOUT_MS,
    agent = OPENCODE_PRIMARY_AGENT,
  ) => {
    const { state } = await nativeProcess({
      command: OPENCODE_EXE,
      args: openCodeRunArgs(context, providerKind, continueSession, agent),
      cwd: context.workingDirectory,
      env,
      signal,
      onEvent,
      parseLine: (event, state) => openCodeParser(event, state, parserPolicy, providerKind),
      inspectStderr: (stderr) => inspectOpenCodeStderr(providerKind, stderr),
      label: `${context.provider} native OpenCode agent`,
      requestTimeoutMs: timeoutMs,
      routeOwnershipTimeoutMs: routeOwnershipTimeout(continueSession, timeoutMs),
      stdinText: validateFinalNativePrompt(prompt, `${context.provider} native OpenCode prompt`),
    });
    return state;
  };
  let preserveRetainedSession = false;
  try {
    const currentResult = await completeOpenCodeTurn(
      context,
      model,
      () => run(turnDelivery.prompt, resumeRetainedSession),
      (prompt) => run(
        prompt,
        true,
        TERMINAL_RECOVERY_TIMEOUT_MS,
        OPENCODE_TERMINAL_AGENT,
      ),
      onRecovery,
    );
    const result = mergeNativeExecutionResults(priorProgress, currentResult);
    if (context.taskState.checkpointRequested) {
      retainedOpenCodeSessions.set(dbPath, {
        progress: result,
        ...turnDelivery.delivery,
      });
      preserveRetainedSession = true;
    }
    return {
      ...result,
      actualReasoningEffort: context.requiredEffort,
      resumedProviderSession: resumeRetainedSession,
      taskDiagnostics: turnDelivery.taskDiagnostics,
      normalizedPromptChars: turnDelivery.prompt.length,
    };
  } catch (error) {
    const currentProgress = {
      ...openCodeResult(context, error.nativeState || {
        toolNames: error.nativeToolNames || [],
        rzMcpTools: error.nativeRzMcpTools || [],
        mutationCount: error.providerMutationCount || 0,
      }, model),
      executionCount: Number(error.nativeState?.executionCount || 1),
      sameSessionContinuations: Number(error.nativeState?.sameSessionContinuations || 0),
    };
    const cumulativeProgress = mergeNativeExecutionResults(priorProgress, currentProgress);
    attachNativeState(error, cumulativeProgress);
    if (resumeRetainedSession) error.routeCommitted = true;
    const currentProviderWorkStarted = currentProgress.toolNames.length > 0
      || error.nativeState?.providerToolStarted === true;
    preserveRetainedSession = resumeRetainedSession || currentProviderWorkStarted;
    if (preserveRetainedSession) {
      retainedOpenCodeSessions.set(dbPath, currentProviderWorkStarted
        ? {
            progress: cumulativeProgress,
            ...turnDelivery.delivery,
          }
        : retainedSession);
    }
    throw error;
  } finally {
    // OpenCode can close before its SQLite handles are released on Windows. Cleanup is not part of
    // provider task correctness: retry the release window, retain a named artifact if it remains
    // locked, and let the age-based sweep remove it after no legitimate request can still own it.
    if (!preserveRetainedSession) {
      retainedOpenCodeSessions.delete(dbPath);
      await cleanupNativeState(dbPath);
    }
    releaseNativeState();
  }
}

function commandCodeParser(event, state, executionPolicy) {
  const payload = event?.type === "event" ? event.event : event;
  state.finalText ||= "";
  state.toolNames ||= [];
  state.toolInputs ||= [];
  state.rzMcpTools ||= [];
  state.mutationCount ||= 0;
  state.inputTokens ||= 0;
  state.outputTokens ||= 0;
  state.peakTurnInputTokens ||= 0;
  state.pendingToolInputs ||= new Map();
  state.startedTools ||= [];
  state.startedToolIndexes ||= new Map();
  state.eventSequence = Number(state.eventSequence || 0) + 1;
  if (payload?.type === "text_delta" && typeof payload.delta === "string") {
    state.finalText += payload.delta;
    state.lastTextSequence = state.eventSequence;
  }
  if (payload?.type === "tool_running" || payload?.type === "tool_completed") {
    state.providerToolStarted = true;
    const name = String(payload.toolName || "unknown_tool");
    const key = String(payload.toolCallId || `${name}:${state.startedTools.length}`);
    const input = payload.toolInput
      ?? payload.input
      ?? payload.arguments
      ?? state.pendingToolInputs.get(payload.toolCallId);
    let toolIndex = state.startedToolIndexes.get(key);
    if (toolIndex === undefined) {
      toolIndex = state.startedTools.length;
      state.startedToolIndexes.set(key, toolIndex);
      state.startedTools.push({ key, name, input: input ?? null, status: "started" });
      state.toolNames.push(name);
      state.toolInputs.push(input ?? null);
      state.lastToolSequence = state.eventSequence;
      if (nativeToolIsMutation(name, input, executionPolicy)) state.mutationCount += 1;
    } else if (input !== undefined) {
      state.startedTools[toolIndex].input = input;
      state.toolInputs[toolIndex] = input;
    }
    if (payload.type === "tool_completed") state.startedTools[toolIndex].status = "completed";
  }
  if (payload?.type === "tool_queued" && payload.toolCallId) {
    state.pendingToolInputs.set(payload.toolCallId, payload.input);
  }
  if (payload?.type === "tool_completed") {
    const input = payload.toolInput
      ?? payload.input
      ?? payload.arguments
      ?? state.pendingToolInputs.get(payload.toolCallId);
    state.pendingToolInputs.delete(payload.toolCallId);
    state.lastCompletedToolCallId = payload.toolCallId;
    state.lastCompletedToolInput = input;
    const name = String(payload.toolName || "unknown_tool");
    const rzMcpTool = nativeRzMcpToolName(name, input);
    if (rzMcpTool && !state.rzMcpTools.includes(rzMcpTool)) state.rzMcpTools.push(rzMcpTool);
  }
  if (payload?.type === "model_request_end") {
    const input = Number(payload.usage?.inputTokens || 0);
    state.inputTokens += input;
    state.outputTokens += Number(payload.usage?.outputTokens || 0);
    state.peakTurnInputTokens = Math.max(state.peakTurnInputTokens, input);
  }
  if (event?.type === "result" && typeof event.finalText === "string") {
    state.finalText = event.finalText;
    state.lastTextSequence = state.eventSequence;
  }
}

export async function runCommandCodeNativeAgent(context, { signal, onEvent }) {
  const commandCodeEntry = join(commandCodePackageDirectory(), "dist", "index.mjs");
  if (!existsSync(commandCodeEntry)) {
    throw new NativeCliAgentError(`CommandCode CLI is missing at ${commandCodeEntry}`);
  }
  const sessionName = commandCodeSessionName(context);
  const releaseNativeState = await acquireNativeState(`commandcode:${sessionName || randomUUID()}`);
  const retainedSession = sessionName ? retainedCommandCodeSessions.get(sessionName) || null : null;
  const resumeRetainedSession = retainedSession !== null;
  const priorProgress = resumeRetainedSession ? retainedSession.progress : null;
  let turnDelivery;
  let providerPrompt;
  try {
    turnDelivery = resumeRetainedSession
      ? retainedContinuation(context, retainedSession)
      : {
          prompt: context.prompt,
          taskDiagnostics: context.taskDiagnostics,
          delivery: deliveredNativeInput(context),
        };
    providerPrompt = validateFinalNativePrompt(
      commandCodePrompt(context, turnDelivery.prompt),
      `${context.provider} native CommandCode prompt`,
    );
  } catch (error) {
    releaseNativeState();
    throw error;
  }
  if (sessionName) retainedCommandCodeSessions.delete(sessionName);
  const reasoningArgs = commandCodeReasoningArgs(context.model, context.requiredEffort);
  const args = [
    commandCodeEntry,
    "-p",
    "--output-format", "json",
    "--add-dir", context.workingDirectory,
    ...(sessionName
      ? resumeRetainedSession ? ["--resume", sessionName] : ["--name", sessionName]
      : ["--no-session"]),
    "--no-skills", "--skip-onboarding", "--no-auto-update",
    "--model", context.model,
    ...reasoningArgs,
    "--yolo",
  ];
  const parserPolicy = {
    ...context.executionPolicy,
    workingDirectory: context.workingDirectory,
  };
  try {
    const { state } = await nativeProcess({
      command: process.execPath,
      args,
      cwd: COMMAND_CODE_LAUNCH_DIRECTORY,
      env: {
        ...commandCodeEnvironment(),
        COMMANDCODE_SKIP_UPDATES: "1",
        RZCODEX_SUBAGENT_RZMCP_MODE: context.executionPolicy.rzMcpMode,
      },
      signal,
      onEvent,
      parseLine: (event, state) => commandCodeParser(event, state, parserPolicy),
      label: `${context.provider} native CommandCode agent`,
      stdinText: providerPrompt,
    });
    const currentResult = {
      ...validateResult(context, {
        finalText: state.finalText || "",
        toolNames: state.toolNames || [],
        toolInputs: state.toolInputs || [],
        rzMcpTools: state.rzMcpTools || [],
        mutationCount: state.mutationCount || 0,
        inputTokens: state.inputTokens || 0,
        outputTokens: state.outputTokens || 0,
        peakTurnInputTokens: state.peakTurnInputTokens || 0,
        lastTextSequence: state.lastTextSequence || 0,
        lastToolSequence: state.lastToolSequence || 0,
        startedTools: [...(state.startedTools || [])],
        commitUncertain: (state.startedTools || []).some((tool) => tool.status !== "completed"),
        model: context.model,
      }),
      executionCount: 1,
      sameSessionContinuations: resumeRetainedSession ? 1 : 0,
    };
    const result = mergeNativeExecutionResults(priorProgress, currentResult);
    if (sessionName) {
      if (context.taskState.checkpointRequested) {
        retainedCommandCodeSessions.set(sessionName, {
          progress: result,
          ...turnDelivery.delivery,
        });
      }
    }
    return {
      ...result,
      resumedProviderSession: resumeRetainedSession,
      actualReasoningEffort: reasoningArgs.length > 0 ? context.requiredEffort : "fixed-model-maximum",
      taskDiagnostics: turnDelivery.taskDiagnostics,
      normalizedPromptChars: providerPrompt.length,
    };
  } catch (error) {
    const currentState = error.nativeState || {
      toolNames: error.nativeToolNames || [],
      toolInputs: error.nativeToolInputs || [],
      rzMcpTools: error.nativeRzMcpTools || [],
      mutationCount: error.providerMutationCount || 0,
    };
    const currentProgress = {
      finalText: currentState.finalText || "",
      toolNames: currentState.toolNames || [],
      toolInputs: currentState.toolInputs || [],
      rzMcpTools: currentState.rzMcpTools || [],
      mutationCount: currentState.mutationCount || 0,
      inputTokens: currentState.inputTokens || 0,
      outputTokens: currentState.outputTokens || 0,
      peakTurnInputTokens: currentState.peakTurnInputTokens || 0,
      startedTools: [...(currentState.startedTools || [])],
      commitUncertain: (currentState.startedTools || []).some((tool) => tool.status !== "completed"),
      model: context.model,
      executionCount: 1,
      sameSessionContinuations: resumeRetainedSession ? 1 : 0,
    };
    const currentProviderWorkStarted = currentProgress.toolNames.length > 0
      || currentState.providerToolStarted === true;
    const cumulativeProgress = mergeNativeExecutionResults(priorProgress, currentProgress);
    attachNativeState(error, cumulativeProgress);
    if (resumeRetainedSession) error.routeCommitted = true;
    if (sessionName && (resumeRetainedSession || currentProviderWorkStarted)) {
      retainedCommandCodeSessions.set(sessionName, currentProviderWorkStarted
        ? {
            progress: cumulativeProgress,
            ...turnDelivery.delivery,
          }
        : retainedSession);
    }
    throw error;
  } finally {
    releaseNativeState();
  }
}

export async function nativeCliAgentRunnerSelfTest() {
  const authoritativeWorkspace = join(import.meta.dirname, "..");
  const exactPromptBudgetFixture = "x".repeat(MAX_MAIN_PROMPT_CHARS);
  if (validateFinalNativePrompt(exactPromptBudgetFixture) !== exactPromptBudgetFixture) {
    throw new Error("native prompt budget rejected an exact-limit prompt");
  }
  let commandCodeFinalPromptBudgetError = null;
  try {
    validateFinalNativePrompt(
      commandCodePrompt({ workingDirectory: authoritativeWorkspace }, exactPromptBudgetFixture),
      "fixture native CommandCode prompt",
    );
  } catch (error) {
    commandCodeFinalPromptBudgetError = error;
  }
  if (
    commandCodeFinalPromptBudgetError?.status !== 413
    || !commandCodeFinalPromptBudgetError.message.includes("exceeding the 120000-character transport limit")
  ) {
    throw new Error("CommandCode final workspace-wrapped prompt escaped the shared aggregate budget");
  }
  if (
    commandCodeReasoningArgs("meta/muse-spark-1.3-contributor", "max").length !== 0
    || commandCodeReasoningArgs("z-ai/glm-5.3-flash", "max").join(" ") !== "--effort max"
  ) {
    throw new Error("CommandCode fixed-reasoning CLI arguments are incorrect");
  }
  const commandCodeServers = JSON.parse(commandCodeMcpConfigText()).mcpServers;
  if (
    Object.keys(commandCodeServers || {}).length !== 1
    || commandCodeServers.rzmcp?.command !== "node"
    || commandCodeServers.rzmcp?.args?.length !== 1
    || commandCodeServers.rzmcp?.args?.[0] !== LAZY_RZMCP_PROXY
    || commandCodeServers.rzmcp?.enabled !== true
  ) {
    throw new Error("CommandCode MCP isolation must expose exactly the lazy RzMCP proxy");
  }
  const mutationScopeFixture = {};
  openCodeParser({
    type: "tool_use",
    part: {
      tool: "write",
      state: { status: "completed", input: { filePath: join(homedir(), "AppData", "Local", "Temp", "scratch.txt") } },
    },
  }, mutationScopeFixture, { rzMcpMode: "no-validation", workingDirectory: authoritativeWorkspace });
  openCodeParser({
    type: "tool_use",
    part: {
      tool: "write",
      state: { status: "completed", input: { filePath: join(authoritativeWorkspace, "fixture.txt") } },
    },
  }, mutationScopeFixture, { rzMcpMode: "no-validation", workingDirectory: authoritativeWorkspace });
  if (mutationScopeFixture.mutationCount !== 1) {
    throw new Error("native OpenCode mutation accounting did not distinguish workspace files from scratch artifacts");
  }
  const lazyRzMcpProgressFixture = {};
  openCodeParser({
    type: "tool_use",
    part: {
      tool: "rzmcp_call_rzmcp_tool",
      state: {
        status: "completed",
        input: { name: "inspect_graph_by_path", arguments: { blueprint: "/Game/Fixture" } },
      },
    },
  }, lazyRzMcpProgressFixture, { rzMcpMode: "read-only" });
  if (
    lazyRzMcpProgressFixture.toolNames?.join(",") !== "rzmcp_call_rzmcp_tool"
    || lazyRzMcpProgressFixture.rzMcpTools?.join(",") !== "inspect_graph_by_path"
    || lazyRzMcpProgressFixture.mutationCount !== 0
  ) {
    throw new Error("native OpenCode lazy RzMCP calls were not identified authoritatively");
  }
  const startedToolFixture = {};
  openCodeParser({
    type: "tool_use",
    part: {
      callID: "started-tool-fixture",
      tool: "edit",
      state: { status: "running", input: { filePath: join(authoritativeWorkspace, "fixture.txt") } },
    },
  }, startedToolFixture, { rzMcpMode: "no-validation", workingDirectory: authoritativeWorkspace });
  const startedToolError = attachNativeState(new NativeCliAgentError("fixture interrupted"), startedToolFixture);
  if (
    startedToolError.routeCommitted !== true
    || startedToolError.commitUncertain !== true
    || startedToolError.nativeToolNames?.join(",") !== "edit"
    || startedToolError.nativeToolInputs?.[0]?.filePath !== join(authoritativeWorkspace, "fixture.txt")
    || startedToolError.nativeStartedTools?.[0]?.status !== "started"
  ) {
    throw new Error("native OpenCode started tool did not commit route ownership with explicit diagnostics");
  }
  const commandCodeLazyRzMcpFixture = {};
  commandCodeParser({
    type: "event",
    event: {
      type: "tool_queued",
      toolCallId: "commandcode-lazy-fixture",
      toolName: "mcp__rzmcp__call_rzmcp_tool",
      input: { name: "get_project_info", arguments: {} },
    },
  }, commandCodeLazyRzMcpFixture, { rzMcpMode: "read-only" });
  commandCodeParser({
    type: "event",
    event: {
      type: "tool_completed",
      toolCallId: "commandcode-lazy-fixture",
      toolName: "mcp__rzmcp__call_rzmcp_tool",
      result: [],
    },
  }, commandCodeLazyRzMcpFixture, { rzMcpMode: "read-only" });
  if (
    commandCodeLazyRzMcpFixture.rzMcpTools?.join(",") !== "get_project_info"
    || commandCodeLazyRzMcpFixture.mutationCount !== 0
    || commandCodeLazyRzMcpFixture.lastCompletedToolInput?.name !== "get_project_info"
  ) {
    throw new Error("native CommandCode queued tool input was not retained through completion");
  }
  const ollamaConfigFixture = JSON.parse(openCodeConfig({
    model: "glm-5.3-flash:cloud",
    executionPolicy: { rzMcpMode: "disabled" },
  }, "ollama"));
  if (
    ollamaConfigFixture.provider?.ollama?.models?.["glm-5.3-flash:cloud"]?.limit?.context
      !== OLLAMA_CLOUD_CONTEXT_WINDOW
  ) {
    throw new Error("Ollama cloud model context window was truncated by the OpenCode adapter");
  }
  if (
    ollamaConfigFixture.default_agent !== OPENCODE_PRIMARY_AGENT
    || Object.hasOwn(ollamaConfigFixture.agent?.[OPENCODE_PRIMARY_AGENT] || {}, "steps")
    || ollamaConfigFixture.agent?.[OPENCODE_TERMINAL_AGENT]?.steps !== OPENCODE_TERMINAL_STEPS
  ) {
    throw new Error("native OpenCode primary execution must not have an artificial step boundary");
  }
  const readPermissionEntries = Object.entries(ollamaConfigFixture.permission?.read || {});
  const bashPermissionEntries = Object.entries(ollamaConfigFixture.permission?.bash || {});
  if (
    readPermissionEntries[0]?.[0] !== "*"
    || ollamaConfigFixture.permission?.read?.["*.uasset"] !== "deny"
    || ollamaConfigFixture.permission?.read?.["**/*.uasset"] !== "deny"
    || ollamaConfigFixture.permission?.read?.["*.umap"] !== "deny"
    || ollamaConfigFixture.permission?.read?.["**/*.umap"] !== "deny"
    || bashPermissionEntries[0]?.[0] !== "*"
    || ollamaConfigFixture.permission?.bash?.["rg *uasset*"] !== "deny"
    || ollamaConfigFixture.permission?.bash?.["rg *umap*"] !== "deny"
    || ollamaConfigFixture.permission?.bash?.["*.uasset*"] !== "deny"
    || ollamaConfigFixture.permission?.bash?.["*.umap*"] !== "deny"
    || ollamaConfigFixture.permission?.bash?.["*ReadAllBytes*"] !== "deny"
    || ollamaConfigFixture.permission?.bash?.["*Format-Hex*"] !== "deny"
    || ollamaConfigFixture.permission?.grep?.["**/*.uasset"] !== "deny"
    || ollamaConfigFixture.permission?.glob?.["**/*.umap"] !== "deny"
    || ollamaConfigFixture.permission?.doom_loop !== "deny"
  ) {
    throw new Error("native OpenCode Unreal binary/tool-loop boundary was not enforced");
  }
  const cwdTask = "Message Type: NEW_TASK\nTask name: /root/cwd_fixture\nPayload:\nInspect the bounded fixture and report.";
  const cwdContext = nativeCliAgentContext({
    model: "@preset/codex-subagents",
    reasoning: { effort: "max" },
    stream: true,
    client_metadata: { cwd: authoritativeWorkspace },
    input: [{
      type: "agent_message",
      id: "cwd-fixture-task",
      author: "Codex",
      recipient: "/root/cwd_fixture",
      content: [{ type: "input_text", text: cwdTask }],
    }],
  }, {
    provider: "fixture",
    model: "fixture-model",
    requiredEffort: "max",
  });
  if (cwdContext.workingDirectory !== authoritativeWorkspace) {
    throw new Error("native CLI ignored the authoritative request working directory");
  }
  const retainedThreadId = "native-retained-session-fixture";
  const continuationTask = "Message Type: NEW_TASK\nTask name: /root/cwd_fixture\nPayload:\nContinue the original bounded task from the checkpoint and finish.";
  const retainedContextBody = (input) => ({
    model: "@preset/codex-subagents",
    reasoning: { effort: "max" },
    stream: true,
    client_metadata: { cwd: authoritativeWorkspace, thread_id: retainedThreadId },
    input,
  });
  const originalTaskItem = {
    type: "agent_message",
    id: "retained-original-task",
    author: "Codex",
    recipient: "/root/cwd_fixture",
    content: [{ type: "input_text", text: cwdTask }],
  };
  const originalRetainedContext = nativeCliAgentContext(retainedContextBody([originalTaskItem]), {
    provider: "fixture",
    model: "fixture-model",
    requiredEffort: "max",
  });
  const continuedRetainedContext = nativeCliAgentContext(retainedContextBody([
    originalTaskItem,
    {
      type: "agent_message",
      id: "retained-continuation-task",
      author: "Codex",
      recipient: "/root/cwd_fixture",
      content: [{ type: "input_text", text: continuationTask }],
    },
  ]), {
    provider: "fixture",
    model: "fixture-model",
    requiredEffort: "max",
  });
  if (
    taskOwnershipHash(continuedRetainedContext.taskState)
      !== originalRetainedContext.taskState.activeTask.hash
    || retainedNativeStatePath(originalRetainedContext, "fixture")
      !== retainedNativeStatePath(continuedRetainedContext, "fixture")
    || commandCodeSessionName(originalRetainedContext)
      !== commandCodeSessionName(continuedRetainedContext)
  ) {
    throw new Error("native CLI continuation changed the retained provider-session identity");
  }
  const reindexedOriginalRetainedContext = nativeCliAgentContext(retainedContextBody([
    ...Array.from({ length: 10 }, (_, index) => ({ type: "compaction", id: `compaction-${index}` })),
    originalTaskItem,
  ]), {
    provider: "fixture",
    model: "fixture-model",
    requiredEffort: "max",
  });
  const retainedDeliveryRecord = {
    progress: null,
    ...deliveredNativeInput(reindexedOriginalRetainedContext),
  };
  const checkpointControlText = "Message Type: MESSAGE\nTask name: /root/cwd_fixture\nPayload:\nCheckpoint now and preserve the native provider session; do not start another tool call.";
  const unseenToolResult = "fixture-result-that-must-survive-retained-delivery";
  const compactedCheckpointContext = nativeCliAgentContext(retainedContextBody([
    originalTaskItem,
    {
      type: "agent_message",
      id: "retained-checkpoint-control",
      author: "Codex",
      recipient: "/root/cwd_fixture",
      content: [{ type: "input_text", text: checkpointControlText }],
    },
    {
      type: "function_call_output",
      id: "fcout_retained_fixture",
      call_id: "retained-fixture-call",
      output: unseenToolResult,
    },
  ]), {
    provider: "fixture",
    model: "fixture-model",
    requiredEffort: "max",
  });
  const unchangedTaskContinuation = retainedContinuation(
    compactedCheckpointContext,
    retainedDeliveryRecord,
  );
  const changedTaskContinuation = retainedContinuation(
    continuedRetainedContext,
    retainedDeliveryRecord,
  );
  const sameTextDistinctTaskContext = nativeCliAgentContext(retainedContextBody([
    originalTaskItem,
    {
      ...originalTaskItem,
      id: "retained-same-text-distinct-task",
    },
  ]), {
    provider: "fixture",
    model: "fixture-model",
    requiredEffort: "max",
  });
  const sameTextDistinctTaskContinuation = retainedContinuation(
    sameTextDistinctTaskContext,
    retainedDeliveryRecord,
  );
  if (
    originalRetainedContext.prompt.split(cwdTask).length - 1 !== 1
    || unchangedTaskContinuation.prompt.includes(cwdTask)
    || unchangedTaskContinuation.taskDiagnostics.activeTaskIncludedThisTurn
    || !unchangedTaskContinuation.taskDiagnostics.retainedInProviderSession
    || !unchangedTaskContinuation.prompt.includes(checkpointControlText)
    || !unchangedTaskContinuation.prompt.includes(unseenToolResult)
    || changedTaskContinuation.prompt.split(continuationTask).length - 1 !== 1
    || changedTaskContinuation.prompt.includes(cwdTask)
    || !changedTaskContinuation.taskDiagnostics.activeTaskIncludedThisTurn
    || changedTaskContinuation.taskDiagnostics.retainedInProviderSession
    || sameTextDistinctTaskContinuation.prompt.split(cwdTask).length - 1 !== 1
    || !sameTextDistinctTaskContinuation.taskDiagnostics.activeTaskIncludedThisTurn
    || sameTextDistinctTaskContinuation.taskDiagnostics.retainedInProviderSession
    || unchangedTaskContinuation.delivery.deliveredItemIdentities.length
      !== retainedDeliveryRecord.deliveredItemIdentities.length + 2
  ) {
    throw new Error("retained native session delivery replayed tasks or dropped reindexed control/result input");
  }
  let idlessRetainedItemError = null;
  try {
    nativeCliAgentContext(retainedContextBody([{
      ...originalTaskItem,
      id: undefined,
    }]), {
      provider: "fixture",
      model: "fixture-model",
      requiredEffort: "max",
    });
  } catch (error) {
    idlessRetainedItemError = error;
  }
  if (!idlessRetainedItemError?.message.includes("has no stable item.id")) {
    throw new Error("retained native session silently accepted an id-less deliverable item");
  }
  if (
    !cwdContext.prompt.includes("[Native tool boundary]")
    || !cwdContext.prompt.includes("[Project AGENTS instructions - authoritative and complete]")
    || !cwdContext.prompt.includes("Never read, grep, decode, strings-scan, hex-dump")
    || !cwdContext.prompt.includes("it is exposed lazily as exactly search_rzmcp_tools and call_rzmcp_tool")
  ) {
    throw new Error("native CLI prompt omitted the Unreal semantic-tool boundary");
  }
  const policyContext = (payload) => nativeCliAgentContext({
    model: "@preset/codex-subagents",
    reasoning: { effort: "max" },
    stream: true,
    client_metadata: { cwd: authoritativeWorkspace },
    input: [{
      type: "agent_message",
      id: `policy-fixture-${randomUUID()}`,
      author: "Codex",
      recipient: "/root/policy_fixture",
      content: [{
        type: "input_text",
        text: `Message Type: NEW_TASK\nTask name: /root/policy_fixture\nPayload:\n${payload}`,
      }],
    }],
  }, {
    provider: "fixture",
    model: "fixture-model",
    requiredEffort: "max",
  }).executionPolicy;
  const explicitRzMcpBan = policyContext(
    "Review the bounded diff. Do not use or invoke RzDirectMCP.",
  );
  const genericEditorRestriction = policyContext(
    "Review the bounded diff. No editor/PIE use.",
  );
  if (
    genericEditorRestriction.rzMcpMode !== "full"
    || explicitRzMcpBan.rzMcpMode !== "disabled"
  ) {
    throw new Error("native CLI RzMCP task capability classification failed");
  }
  const ordinaryMutationTask = "Message Type: NEW_TASK\nTask name: /root/default_validation_fixture\nPayload:\nFix the bounded parser defect and return the changed file.";
  const ordinaryMutationContext = nativeCliAgentContext({
    model: "@preset/codex-subagents",
    reasoning: { effort: "max" },
    stream: true,
    client_metadata: { cwd: authoritativeWorkspace },
    input: [{
      type: "agent_message",
      id: "default-validation-fixture",
      author: "Codex",
      recipient: "/root/default_validation_fixture",
      content: [{ type: "input_text", text: ordinaryMutationTask }],
    }],
  }, {
    provider: "fixture",
    model: "fixture-model",
    requiredEffort: "max",
  });
  if (
    ordinaryMutationContext.taskDiagnostics.taskIntent !== "mutation"
    || ordinaryMutationContext.executionPolicy.rzMcpMode !== "full"
    || !ordinaryMutationContext.prompt.includes("Builds, compilation, tests, editor control")
    || !ordinaryMutationContext.prompt.includes("Implement and statically review the bounded change")
  ) {
    throw new Error("native mutation task without prohibition words lost its native delegated contract");
  }
  const priorTaskText = "Message Type: NEW_TASK\nTask name: /root/resume_fixture\nPayload:\nInspect the exact bounded source and report the original evidence.";
  const intermediateResumeTaskText = "Message Type: NEW_TASK\nTask name: /root/resume_fixture\nPayload:\nBridge repaired. Resume the same bounded task from its original scope and preserve the focused ownership.";
  const resumeTaskText = "Message Type: NEW_TASK\nTask name: /root/resume_fixture\nPayload:\nBridge repaired. Resume the same bounded task from your preserved state; keep the original scope and finish.";
  const priorControlText = "Message Type: MESSAGE\nTask name: /root/resume_fixture\nPayload:\nReturn only after the bounded evidence is complete.";
  const resumedTaskContext = nativeCliAgentContext({
    model: "@preset/codex-subagents",
    reasoning: { effort: "max" },
    stream: true,
    client_metadata: { cwd: authoritativeWorkspace },
    input: [
      { type: "agent_message", id: "prior-task-fixture", author: "Codex", recipient: "/root/resume_fixture", content: [{ type: "input_text", text: priorTaskText }] },
      { type: "agent_message", id: "intermediate-resume-task-fixture", author: "Codex", recipient: "/root/resume_fixture", content: [{ type: "input_text", text: intermediateResumeTaskText }] },
      { type: "agent_message", id: "prior-control-fixture", author: "Codex", recipient: "/root/resume_fixture", content: [{ type: "input_text", text: priorControlText }] },
      { type: "agent_message", id: "resume-task-fixture", author: "Codex", recipient: "/root/resume_fixture", content: [{ type: "input_text", text: resumeTaskText }] },
    ],
  }, {
    provider: "fixture",
    model: "fixture-model",
    requiredEffort: "max",
  });
  if (
    resumedTaskContext.prompt.split(priorTaskText).length - 1 !== 1
    || resumedTaskContext.prompt.split(intermediateResumeTaskText).length - 1 !== 1
    || resumedTaskContext.prompt.split(priorControlText).length - 1 !== 1
    || resumedTaskContext.prompt.split(resumeTaskText).length - 1 !== 1
    || !resumedTaskContext.prompt.includes("Do not search Codex session or rollout files merely to reconstruct the assignment")
  ) {
    throw new Error("native CLI resumed task lost its explicitly referenced prior assignment");
  }
  const mutationOriginText = "Message Type: NEW_TASK\nTask name: /root/resumed_mutation_fixture\nPayload:\nImplement the bounded diagnostic and remove obsolete code. Do not build or run tests.";
  const mutationResumeText = "Message Type: NEW_TASK\nTask name: /root/resumed_mutation_fixture\nPayload:\nBridge repaired. Resume the same task. Apply the integration-review corrections, minimize the current diff, and finish; no build/editor/tests.";
  const resumedMutationContext = nativeCliAgentContext({
    model: "@preset/codex-subagents",
    reasoning: { effort: "max" },
    stream: true,
    client_metadata: { cwd: authoritativeWorkspace },
    input: [
      { type: "agent_message", id: "mutation-origin-fixture", author: "Codex", recipient: "/root/resumed_mutation_fixture", content: [{ type: "input_text", text: mutationOriginText }] },
      { type: "agent_message", id: "mutation-resume-fixture", author: "Codex", recipient: "/root/resumed_mutation_fixture", content: [{ type: "input_text", text: mutationResumeText }] },
    ],
  }, {
    provider: "fixture",
    model: "fixture-model",
    requiredEffort: "max",
  });
  if (
    resumedMutationContext.taskDiagnostics.taskIntent !== "mutation"
    || !resumedMutationContext.prompt.includes("[Parent-directed turn scope]")
    || !resumedMutationContext.prompt.includes("the parent can answer and resume this same Codex subagent")
    || !resumedMutationContext.prompt.includes("[Mutation convergence contract]")
    || resumedMutationContext.prompt.includes("[Analysis convergence contract]")
  ) {
    throw new Error("native CLI resumed implementation was misclassified as analysis");
  }
  const slashDelimitedReadOnlyTask = "Message Type: NEW_TASK\nTask name: /root/slash_read_only_fixture\nPayload:\nIndependent architecture audit. Review the implementation and builder patch. Do not edit/build/test/editor. Return evidence only.";
  const slashDelimitedReadOnlyContext = nativeCliAgentContext({
    model: "@preset/codex-subagents",
    reasoning: { effort: "max" },
    stream: true,
    client_metadata: { cwd: authoritativeWorkspace },
    input: [
      { type: "agent_message", id: "slash-read-only-fixture", author: "Codex", recipient: "/root/slash_read_only_fixture", content: [{ type: "input_text", text: slashDelimitedReadOnlyTask }] },
    ],
  }, {
    provider: "fixture",
    model: "fixture-model",
    requiredEffort: "max",
  });
  if (
    slashDelimitedReadOnlyContext.taskDiagnostics.taskIntent !== "analysis"
    || !slashDelimitedReadOnlyContext.prompt.includes("[Analysis convergence contract]")
    || slashDelimitedReadOnlyContext.prompt.includes("[Mutation convergence contract]")
  ) {
    throw new Error("slash-delimited read-only task was misclassified as mutation");
  }
  let missingCwdError = null;
  try {
    nativeCliAgentContext({
      model: "@preset/codex-subagents",
      reasoning: { effort: "max" },
      stream: true,
      input: [{
        type: "agent_message",
        id: "missing-cwd-fixture-task",
        author: "Codex",
        recipient: "/root/cwd_fixture",
        content: [{ type: "input_text", text: cwdTask }],
      }],
    }, {
      provider: "fixture",
      model: "fixture-model",
      requiredEffort: "max",
    });
  } catch (error) {
    missingCwdError = error;
  }
  if (!missingCwdError?.message.includes("no valid authoritative working directory")) {
    throw new Error("native CLI silently accepted a request without an authoritative working directory");
  }

  const context = { provider: "fixture" };
  let incompleteError = null;
  try {
    validateResult(context, {
      finalText: "I'll start by reading the file.",
      toolNames: ["read"],
      mutationCount: 0,
      lastTextSequence: 1,
      lastToolSequence: 2,
    });
  } catch (error) {
    incompleteError = error;
  }
  if (
    !incompleteError?.message.includes("without a terminal assistant message")
    || incompleteError?.providerMutationCount !== 0
  ) {
    throw new Error("native CLI incomplete tool turn detection failed");
  }
  const completed = validateResult(context, {
    finalText: "Work complete.",
    toolNames: ["read", "edit"],
    mutationCount: 1,
    lastTextSequence: 3,
    lastToolSequence: 2,
  });
  if (completed.finalText !== "Work complete.") throw new Error("native CLI terminal tool turn detection failed");
  if (
    nativeToolIsMutation("mcp__rzmcp__call_rzmcp_tool", { name: "inspect_graph_by_path" }, { rzMcpMode: "full" })
    || nativeToolIsMutation("mcp__rzmcp__call_rzmcp_tool", { name: "connect_pins_with_details" }, { rzMcpMode: "read-only" })
    || !nativeToolIsMutation("mcp__rzmcp__call_rzmcp_tool", { name: "connect_pins_with_details" }, { rzMcpMode: "full" })
    || !nativeToolIsMutation("edit", {}, { rzMcpMode: "read-only" })
  ) {
    throw new Error("native CLI lazy RzMCP mutation accounting failed");
  }

  let recoveryPrompt = "";
  let recoveryNotices = 0;
  const recovered = await completeOpenCodeTurn(
    resumedMutationContext,
    "ollama/glm-5.3-flash:cloud",
    async () => {
      throw attachNativeState(new NativeCliAgentError("stream interrupted"), {
        finalText: "I'll inspect the file now.",
        toolNames: ["read"],
        mutationCount: 0,
        inputTokens: 100,
        outputTokens: 10,
        peakTurnInputTokens: 100,
        lastTextSequence: 1,
        lastToolSequence: 2,
      });
    },
    async (prompt) => {
      recoveryPrompt = prompt;
      return {
        finalText: "Work complete.",
        toolNames: ["edit"],
        mutationCount: 1,
        inputTokens: 120,
        outputTokens: 20,
        peakTurnInputTokens: 120,
        lastTextSequence: 2,
        lastToolSequence: 1,
      };
    },
    () => { recoveryNotices += 1; },
  );
  if (
    recovered.finalText !== "Work complete."
    || recovered.toolNames.join(",") !== "read,edit"
    || recovered.mutationCount !== 1
    || recovered.inputTokens !== 220
    || recovered.outputTokens !== 30
    || recovered.peakTurnInputTokens !== 120
    || recovered.executionCount !== 2
    || recovered.sameSessionContinuations !== 1
    || recoveryNotices !== 1
    || !recoveryPrompt.includes("[Native CLI terminal-message recovery]")
    || recoveryPrompt.split(mutationOriginText).length - 1 !== 1
    || recoveryPrompt.split(mutationResumeText).length - 1 !== 1
  ) {
    throw new Error("native OpenCode same-session terminal recovery failed");
  }
  const initialArgs = openCodeRunArgs(resumedMutationContext, "ollama", false);
  const recoveryArgs = openCodeRunArgs(
    resumedMutationContext,
    "ollama",
    true,
    OPENCODE_TERMINAL_AGENT,
  );
  const nonOllamaArgs = openCodeRunArgs(resumedMutationContext, "opencode", false);
  if (
    initialArgs.includes("--continue")
    || !initialArgs.includes("--title")
    || initialArgs[initialArgs.indexOf("--agent") + 1] !== OPENCODE_PRIMARY_AGENT
    || !initialArgs.includes("--print-logs")
    || !initialArgs.includes("ERROR")
    || initialArgs.includes(resumedMutationContext.prompt)
    || !recoveryArgs.includes("--continue")
    || recoveryArgs.includes("--title")
    || recoveryArgs[recoveryArgs.indexOf("--agent") + 1] !== OPENCODE_TERMINAL_AGENT
    || !nonOllamaArgs.includes("--print-logs")
    || !nonOllamaArgs.includes("ERROR")
    || nonOllamaArgs.includes(resumedMutationContext.prompt)
    || routeOwnershipTimeout(false, 120_000) !== ROUTE_OWNERSHIP_TIMEOUT_MS
    || routeOwnershipTimeout(true, 120_000) !== 120_000
  ) {
    throw new Error("native OpenCode continuation did not retain the isolated provider session");
  }

  let cleanExitContinuationCalls = 0;
  const cleanExitRecovered = await completeOpenCodeTurn(
    resumedMutationContext,
    "ollama/glm-5.3-flash:cloud",
    async () => ({
      finalText: "Starting.",
      toolNames: ["read"],
      mutationCount: 0,
      lastTextSequence: 1,
      lastToolSequence: 2,
    }),
    async () => {
      cleanExitContinuationCalls += 1;
      return {
        finalText: "Recovered terminal report.",
        toolNames: [],
        mutationCount: 0,
        lastTextSequence: 1,
        lastToolSequence: 0,
      };
    },
  );
  if (
    cleanExitContinuationCalls !== 1
    || cleanExitRecovered.finalText !== "Recovered terminal report."
    || cleanExitRecovered.toolNames.join(",") !== "read"
    || cleanExitRecovered.sameSessionContinuations !== 1
  ) {
    throw new Error("native OpenCode clean incomplete exit did not recover in the retained session");
  }

  const cumulativeFixture = mergeNativeExecutionResults(
    {
      finalText: "",
      toolNames: ["read", "search_rzmcp_tools"],
      toolInputs: [{ path: "a" }, { query: "asset" }],
      rzMcpTools: [],
      mutationCount: 0,
      inputTokens: 100,
      outputTokens: 10,
      peakTurnInputTokens: 100,
      executionCount: 1,
      sameSessionContinuations: 0,
    },
    {
      finalText: "Complete.",
      toolNames: ["call_rzmcp_tool", "edit"],
      toolInputs: [{ name: "inspect_graph_by_path" }, { path: "b" }],
      rzMcpTools: ["inspect_graph_by_path"],
      mutationCount: 1,
      inputTokens: 80,
      outputTokens: 20,
      peakTurnInputTokens: 120,
      executionCount: 2,
      sameSessionContinuations: 1,
    },
  );
  if (
    cumulativeFixture.toolNames.join(",") !== "read,search_rzmcp_tools,call_rzmcp_tool,edit"
    || cumulativeFixture.rzMcpTools.join(",") !== "inspect_graph_by_path"
    || cumulativeFixture.mutationCount !== 1
    || cumulativeFixture.inputTokens !== 180
    || cumulativeFixture.outputTokens !== 30
    || cumulativeFixture.peakTurnInputTokens !== 120
    || cumulativeFixture.executionCount !== 3
    || cumulativeFixture.sameSessionContinuations !== 1
  ) {
    throw new Error("native OpenCode retained-session progress was not cumulative");
  }
  let recoveryFailure = null;
  try {
    await completeOpenCodeTurn(
      resumedMutationContext,
      "ollama/glm-5.3-flash:cloud",
      async () => {
        throw attachNativeState(new NativeCliAgentError("stream interrupted"), {
          finalText: "Starting.",
          toolNames: ["read"],
          mutationCount: 0,
          lastTextSequence: 1,
          lastToolSequence: 2,
        });
      },
      async () => {
        throw attachNativeState(new NativeCliAgentError("stream interrupted"), {
          toolNames: ["edit"],
          mutationCount: 1,
          inputTokens: 75,
          outputTokens: 8,
          peakTurnInputTokens: 75,
        });
      },
    );
  } catch (error) {
    recoveryFailure = error;
  }
  if (
    !recoveryFailure?.message.includes("after one same-session continuation")
    || recoveryFailure.nativeToolNames.join(",") !== "read,edit"
    || recoveryFailure.providerMutationCount !== 1
    || recoveryFailure.nativeState?.inputTokens !== 75
    || recoveryFailure.nativeState?.outputTokens !== 8
    || recoveryFailure.nativeState?.peakTurnInputTokens !== 75
  ) {
    throw new Error("native OpenCode exhausted recovery lost committed tool evidence");
  }

  const fixtureParser = (event, state) => {
    state.toolNames ||= [];
    if (event.type === "tool") state.toolNames.push(event.name);
    if (event.type === "reasoning") state.providerActivityObserved = true;
    if (event.type === "done") state.finalText = event.text;
  };
  const stdinFixtureText = "exact stdin prompt with spaces, quotes ' \" and a newline\nsecond line";
  const stdinTransport = await nativeProcess({
    command: process.execPath,
    args: [
      "-e",
      "let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { input += chunk; }); process.stdin.on('end', () => console.log(JSON.stringify({type:'done',text:input})));",
    ],
    cwd: process.cwd(),
    env: sanitizeChildEnvironment(process.env),
    parseLine: fixtureParser,
    label: "stdin transport fixture",
    requestTimeoutMs: 2_000,
    routeOwnershipTimeoutMs: 1_500,
    stdinText: stdinFixtureText,
  });
  if (stdinTransport.state.finalText !== stdinFixtureText) {
    throw new Error("native CLI prompt was not delivered losslessly through child stdin");
  }
  const postToolSilence = await nativeProcess({
    command: process.execPath,
    args: [
      "-e",
      "console.log(JSON.stringify({type:'tool',name:'read'})); setTimeout(() => { console.log(JSON.stringify({type:'done',text:'complete'})); }, 350);",
    ],
    cwd: process.cwd(),
    env: sanitizeChildEnvironment(process.env),
    parseLine: fixtureParser,
    label: "post-tool silence fixture",
    requestTimeoutMs: 2_000,
    routeOwnershipTimeoutMs: 200,
  });
  if (postToolSilence.state.finalText !== "complete") {
    throw new Error("native CLI post-tool silence incorrectly triggered provider rerouting");
  }
  const activeReasoning = await nativeProcess({
    command: process.execPath,
    args: [
      "-e",
      "console.log(JSON.stringify({type:'reasoning'})); setTimeout(() => { console.log(JSON.stringify({type:'done',text:'complete'})); }, 350);",
    ],
    cwd: process.cwd(),
    env: sanitizeChildEnvironment(process.env),
    parseLine: fixtureParser,
    label: "active provider reasoning fixture",
    requestTimeoutMs: 2_000,
    routeOwnershipTimeoutMs: 200,
  });
  if (activeReasoning.state.finalText !== "complete") {
    throw new Error("native CLI active reasoning incorrectly triggered provider rerouting");
  }

  const quotaStartedAt = Date.now();
  let ollamaQuotaError = null;
  try {
    await nativeProcess({
      command: process.execPath,
      args: [
        "-e",
        "console.error('level=ERROR providerID=ollama modelID=fixture error.error=\"AI_APICallError: reached your session usage limit\"'); setTimeout(() => {}, 1000);",
      ],
      cwd: process.cwd(),
      env: sanitizeChildEnvironment(process.env),
      parseLine: fixtureParser,
      inspectStderr: (stderr) => inspectOpenCodeStderr("ollama", stderr),
      label: "Ollama quota fixture",
      requestTimeoutMs: 2_000,
      routeOwnershipTimeoutMs: 1_500,
    });
  } catch (error) {
    ollamaQuotaError = error;
  }
  if (
    ollamaQuotaError?.status !== 503
    || ollamaQuotaError?.quotaFailure !== true
    || !ollamaQuotaError.message.includes("usage limit")
    || Date.now() - quotaStartedAt >= 1_000
  ) {
    throw new Error("native Ollama quota error was not surfaced immediately");
  }

  const benignStderr = await nativeProcess({
    command: process.execPath,
    args: [
      "-e",
      "console.error('level=ERROR providerID=ollama message=temporary-note'); console.log(JSON.stringify({type:'done',text:'complete'}));",
    ],
    cwd: process.cwd(),
    env: sanitizeChildEnvironment(process.env),
    parseLine: fixtureParser,
    inspectStderr: (stderr) => inspectOpenCodeStderr("ollama", stderr),
    label: "Ollama benign stderr fixture",
    requestTimeoutMs: 2_000,
    routeOwnershipTimeoutMs: 1_500,
  });
  if (benignStderr.state.finalText !== "complete") {
    throw new Error("native Ollama stderr inspection rejected a non-quota message");
  }

  let transientOpenCodeRateLimit = null;
  try {
    inspectOpenCodeStderr(
      "opencode",
      "level=ERROR providerID=opencode error.error=\"AI_APICallError: Rate limit exceeded. Please try again later.\"",
    );
  } catch (error) {
    transientOpenCodeRateLimit = error;
  }
  let openCodeGoQuotaStderr = null;
  try {
    inspectOpenCodeStderr(
      "opencode-go",
      "level=ERROR providerID=opencode-go error.error=\"AI_APICallError: Monthly usage limit reached.\"",
    );
  } catch (error) {
    openCodeGoQuotaStderr = error;
  }
  if (
    transientOpenCodeRateLimit?.transientProviderFailure !== true
    || transientOpenCodeRateLimit?.openCodeQuotaError === true
    || openCodeGoQuotaStderr?.openCodeQuotaError !== true
  ) {
    throw new Error("native OpenCode stderr failures did not distinguish transient throttling from Go quota exhaustion");
  }

  let providerEventError = null;
  try {
    openCodeParser({ type: "error", error: { name: "UnknownError" } }, {}, { rzMcpMode: "disabled" });
  } catch (error) {
    providerEventError = error;
  }
  if (providerEventError?.message !== "OpenCode reported UnknownError") {
    throw new Error("native OpenCode terminal error event was silently ignored");
  }

  let openCodeGoQuotaError = null;
  try {
    openCodeParser({
      type: "error",
      error: { name: "APIError", data: { message: "Monthly usage limit reached." } },
    }, {}, { rzMcpMode: "disabled" }, "opencode-go");
  } catch (error) {
    openCodeGoQuotaError = error;
  }
  let ordinaryRateLimit = null;
  try {
    openCodeParser({
      type: "error",
      error: { name: "APIError", data: { message: "Rate limit exceeded; retry shortly." } },
    }, {}, { rzMcpMode: "disabled" }, "opencode-go");
  } catch (error) {
    ordinaryRateLimit = error;
  }
  let freeModelCreditError = null;
  try {
    openCodeParser({
      type: "error",
      error: { name: "APIError", data: { responseBody: { type: "CreditsError" } } },
    }, {}, { rzMcpMode: "disabled" }, "opencode");
  } catch (error) {
    freeModelCreditError = error;
  }
  if (
    openCodeGoQuotaError?.openCodeQuotaError !== true
    || ordinaryRateLimit?.openCodeQuotaError !== false
    || freeModelCreditError?.openCodeQuotaError !== false
  ) {
    throw new Error("OpenCode Go quota classification confused exhaustion, transient throttling, or the free provider");
  }

  const openCodeQuotaFixturePath = join(
    tmpdir(),
    `rzcodex-opencode-go-quota-self-test-${process.pid}-${randomUUID()}.json`,
  );
  let quotaNow = 1_000;
  try {
    const quotaState = new RecoveryProbeState(openCodeQuotaFixturePath, () => quotaNow);
    quotaState.record("quota_fixture");
    const reloadedQuotaState = new RecoveryProbeState(openCodeQuotaFixturePath, () => quotaNow);
    if (
      !reloadedQuotaState.isActive()
      || reloadedQuotaState.claimRecoveryProbe()
      || reloadedQuotaState.snapshot().reason !== "quota_fixture"
    ) {
      throw new Error("OpenCode Go quota state did not suppress premature probes");
    }
    quotaNow += QUOTA_RECOVERY_PROBE_MS;
    if (
      !reloadedQuotaState.claimRecoveryProbe()
      || reloadedQuotaState.claimRecoveryProbe()
      || !reloadedQuotaState.clear()
      || reloadedQuotaState.isActive()
    ) {
      throw new Error("OpenCode Go quota state did not provide one bounded recovery probe");
    }
  } finally {
    try { unlinkSync(openCodeQuotaFixturePath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    try { unlinkSync(`${openCodeQuotaFixturePath}.${process.pid}.tmp`); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }

  let preToolTimeout = null;
  try {
    await nativeProcess({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 1000);"],
      cwd: process.cwd(),
      env: sanitizeChildEnvironment(process.env),
      parseLine: fixtureParser,
      label: "pre-tool silence fixture",
      requestTimeoutMs: 2_000,
      routeOwnershipTimeoutMs: 200,
    });
  } catch (error) {
    preToolTimeout = error;
  }
  if (!preToolTimeout?.message.includes("did not begin provider tool work within 200ms")) {
    throw new Error("native CLI pre-tool route deadline failed");
  }
}

export function nativeCliUsage(result) {
  return {
    input_tokens: result.inputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: result.outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: result.inputTokens + result.outputTokens,
  };
}

const directlyExecuted = process.argv[1]
  ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
  : false;
if (directlyExecuted && process.argv.includes("--self-test")) {
  await nativeCliAgentRunnerSelfTest();
  process.stdout.write("native-cli-agent-runner self-test: ok\n");
}
