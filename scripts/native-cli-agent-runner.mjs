import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  TaskStateError,
  activeTaskPromptSection,
  isExplicitReadOnlyTask,
  referencedPriorTaskPromptSection,
  rzMcpModeForTask,
  taskControlPromptSections,
  taskDeliveryDiagnostics,
  taskOwnershipHash,
  taskStateFromInput,
} from "./codebuddy-subagent-task-state.mjs";
import { projectInstructionsPromptSection } from "./native-project-instructions.mjs";

const MAX_ACTIVE_TASK_CHARS = 40_000;
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
const OPENCODE_EXE = join(
  process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
  "npm", "node_modules", "opencode-ai", "bin", "opencode.exe",
);
const COMMAND_CODE_PACKAGE = join(
  process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
  "npm", "node_modules", "command-code",
);
const COMMAND_CODE_ENTRY = join(COMMAND_CODE_PACKAGE, "dist", "index.mjs");
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
const VALIDATION_RESTRICTED_TASK = /\b(?:do not|must not|never)[^.\n]{0,160}\b(?:build|compile|run\s+(?:the\s+)?tests?|test|control\s+(?:the\s+)?editor|use\s+(?:the\s+)?editor|pie|sie)\b|\bno\s+(?:build|compile|tests?|editor|pie|sie)\b/i;
const MUTATION_TOOL = /^(?:apply_patch|edit|edit_file|write|write_file|create_file|delete_file|move_file)$/i;
const LAZY_RZMCP_CALL_TOOL = /(?:^|[_:.-])call_rzmcp_tool$/i;
const NATIVE_MCP_CALL_TOOL = /^mcp_call_tool$/i;
const READ_ONLY_RZMCP_TOOL_NAME = /^(?:analyze|check|count|describe|discover|does|enumerate|find|get|has|inspect|is|list|locate|query|read|resolve|search|validate)_/i;
const OLLAMA_USAGE_LIMIT = /providerID=ollama[\s\S]{0,2000}(?:reached|exceeded)[\s\S]{0,120}(?:session\s+)?usage limit|providerID=ollama[\s\S]{0,2000}\b429\b[\s\S]{0,120}(?:quota|usage|limit)/i;
const retainedOpenCodeStates = new Set();
const retainedOpenCodeProgress = new Map();
const retainedCommandCodeSessions = new Set();
const nativeStateTails = new Map();

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

function sanitizedEnvironment(source = process.env) {
  const env = { ...source, NO_COLOR: "1" };
  for (const key of [
    "DEVIN_API_KEY", "DEVIN_ORG_ID", "COGNITION_API_KEY", "OPENAI_API_KEY",
    "OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "CODEX_API_KEY", "OPENROUTER_API_KEY",
    "TENCENT_API_KEY", "TENCENTCLOUD_SECRET_ID", "TENCENTCLOUD_SECRET_KEY",
    "CODEBUDDY_API_KEY", "COMMAND_CODE_API_KEY", "OLLAMA_API_KEY",
  ]) delete env[key];
  return env;
}

function commandCodeMcpConfigText() {
  return `${JSON.stringify({
    mcpServers: {
      rzmcp: {
        // CommandCode starts stdio MCP servers with `shell: true` on Windows. An absolute
        // node.exe path under Program Files is split by cmd.exe before the proxy can start.
        command: "node",
        args: [LAZY_RZMCP_PROXY],
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
  const env = sanitizedEnvironment();
  env.HOME = COMMAND_CODE_HOME_DIRECTORY;
  env.USERPROFILE = COMMAND_CODE_HOME_DIRECTORY;
  const apiKey = commandCodeApiKey();
  if (apiKey) env.COMMAND_CODE_API_KEY = apiKey;
  return env;
}

function commandCodePrompt(context) {
  return `[CommandCode workspace boundary]\nThe CLI launch directory is an internal MCP-isolation directory, not the project. The authoritative workspace is ${context.workingDirectory}. Use absolute paths for file tools. Begin every shell command by changing to that workspace with PowerShell Set-Location -LiteralPath. Do not inspect or write the internal launch directory.\n\n${context.prompt}`;
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
  for (const path of pending) reportRetainedNativeState(path, lastError);
}

function sweepStaleNativeState(now = Date.now()) {
  if (!existsSync(OPENCODE_STATE_DIRECTORY)) return;
  for (const name of readdirSync(OPENCODE_STATE_DIRECTORY)) {
    const path = join(OPENCODE_STATE_DIRECTORY, name);
    try {
      if (now - statSync(path).mtimeMs < STALE_STATE_AGE_MS) continue;
      unlinkSync(path);
      const dbPath = path.replace(/-(?:shm|wal)$/, "");
      retainedOpenCodeStates.delete(dbPath);
      retainedOpenCodeProgress.delete(dbPath);
    } catch (error) {
      if (error?.code !== "ENOENT") reportRetainedNativeState(path, error);
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

function latestControlMessage(taskState) {
  if (!taskState.activeTask) return "";
  const message = taskState.messages.filter((entry) => entry.index > taskState.activeTask.index).at(-1);
  return message?.text?.trim() || "";
}

function executionPolicy(taskState) {
  const task = taskState.activeTask?.text || "";
  const readOnly = taskState.activeTask?.intent === "analysis" || isExplicitReadOnlyTask(task);
  return {
    readOnly,
    validationRestricted: VALIDATION_RESTRICTED_TASK.test(task),
    rzMcpMode: rzMcpModeForTask(task, readOnly),
  };
}

export function nativeCliAgentContext(body, { provider, model, requiredEffort }) {
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
  if (!taskState.activeTask) {
    throw new NativeCliAgentError(`${provider} native CLI route received no active NEW_TASK payload`, 400);
  }
  const workingDirectory = workingDirectoryFrom(body, input);
  const sections = [
    "[Single native-agent turn contract]\nComplete this delegated task within this one Codex subagent turn. Use your own local file, search, edit, and shell tools directly. Never delegate to another agent, task, teammate, swarm, or background worker. Do not return an intention, a deferred tool request, or a request for the parent to execute an ordinary file/shell operation. Return only when the bounded task is complete or a concrete blocker requires parent input. Honor the project AGENTS.md in the working directory. Builds, tests, editor control, PIE/SIE, runtime validation, and final integration remain owned by the parent whenever the task or project instructions reserve them.",
    "[Native tool boundary]\nThe host shell is PowerShell on Windows. Never read, grep, decode, strings-scan, hex-dump, or otherwise inspect Unreal .uasset or .umap bytes through file or shell tools. When the task authorizes RzMCP, it is exposed lazily as exactly search_rzmcp_tools and call_rzmcp_tool: search for a focused schema first, then call only a discovered tool. Never enumerate or request the full RzMCP catalog. If those tools are disabled, unavailable, or semantically insufficient, return that concrete blocker; do not approximate asset semantics from binary bytes or repeat equivalent offset/chunk probes. Never read secret environment files.",
    projectInstructionsPromptSection(workingDirectory),
  ];
  const role = roleInstructionsFrom(body.instructions);
  if (role) sections.push(`[Role instructions]\n${role}`);
  sections.push(referencedPriorTaskPromptSection(taskState));
  sections.push(activeTaskPromptSection(taskState));
  sections.push(...taskControlPromptSections(taskState));
  const control = latestControlMessage(taskState);
  if (control && control !== taskState.activeTask.text) sections.push(`[Latest parent control message]\n${control}`);
  const prompt = sections.filter(Boolean).join("\n\n");
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
    threadId: typeof body.client_metadata?.thread_id === "string"
      ? body.client_metadata.thread_id
      : null,
    prompt,
    workingDirectory,
    taskState,
    taskDiagnostics: diagnostics,
    executionPolicy: executionPolicy(taskState),
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
  return join(OPENCODE_STATE_DIRECTORY, `${providerKind}-${threadHash}-${taskHash}.db`);
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
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let stdoutBuffer = "";
    let stderr = "";
    const routeOwnershipDeadline = Date.now() + routeOwnershipTimeoutMs;
    const state = {};
    const requestTimer = setTimeout(() => {
      child.kill();
      finish(new NativeCliAgentError(`${label} exceeded ${requestTimeoutMs}ms`, 504));
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
      child.kill();
      finish(new NativeCliAgentError(
        `${label} did not begin provider tool work within ${routeOwnershipTimeoutMs}ms`,
        504,
      ));
    }, Math.min(1_000, Math.max(10, Math.floor(routeOwnershipTimeoutMs / 4))));
    routeOwnershipTimer.unref?.();
    const abort = () => {
      child.kill();
      finish(new NativeCliAgentError(`${label} was aborted`, 499));
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
        child.kill();
        finish(error);
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
        child.kill();
        finish(error);
      }
    });
    child.once("error", (error) => finish(new NativeCliAgentError(`${label} failed to start: ${error.message}`)));
    child.once("close", (code, closeSignal) => {
      consume(stdoutBuffer);
      if (settled) return;
      if (code !== 0) {
        const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
        finish(new NativeCliAgentError(`${label} exited with ${closeSignal ? `signal ${closeSignal}` : `code ${code}`}${detail}`));
        return;
      }
      finish(undefined, { state, stderr });
    });
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
  if (initialFailure?.status === 499 || primary.toolNames.length === 0) throw initialFailure;
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

function openCodeParser(event, state, executionPolicy) {
  state.finalText ||= "";
  state.toolNames ||= [];
  state.toolInputs ||= [];
  state.rzMcpTools ||= [];
  state.mutationCount ||= 0;
  state.inputTokens ||= 0;
  state.outputTokens ||= 0;
  state.peakTurnInputTokens ||= 0;
  state.eventSequence = Number(state.eventSequence || 0) + 1;
  if (event.type === "error") {
    const errorName = typeof event.error?.name === "string" ? event.error.name : "provider error";
    throw new NativeCliAgentError(`OpenCode reported ${errorName}`, 502);
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
  if (event.type === "tool_use") state.providerToolStarted = true;
  if (event.type === "tool_use" && event.part?.state?.status === "completed") {
    const name = String(event.part.tool || "unknown_tool");
    const input = event.part?.state?.input;
    state.toolNames.push(name);
    state.toolInputs.push(input ?? null);
    if (LAZY_RZMCP_CALL_TOOL.test(name)) {
      const outer = parsedToolInput(input);
      const nested = outer?.tool_name === "call_rzmcp_tool"
        ? parsedToolInput(outer.arguments)
        : outer;
      if (typeof nested?.name === "string" && nested.name) state.rzMcpTools.push(nested.name);
    }
    state.lastToolSequence = state.eventSequence;
    if (nativeToolIsMutation(name, input, executionPolicy)) {
      state.mutationCount += 1;
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
  prompt,
  continueSession = false,
  agent = OPENCODE_PRIMARY_AGENT,
) {
  const args = ["run", "--pure", "--auto", "--format", "json"];
  if (providerKind === "ollama") args.push("--print-logs", "--log-level", "ERROR");
  if (continueSession) args.push("--continue");
  else args.push("--title", "RzCodex native subagent");
  args.push(
    "--agent", agent,
    "--model", `${providerKind}/${context.model}`,
    "--variant", context.requiredEffort,
    "--dir", context.workingDirectory,
    prompt,
  );
  return args;
}

function inspectOpenCodeStderr(providerKind, stderr) {
  if (providerKind !== "ollama" || !OLLAMA_USAGE_LIMIT.test(stderr)) return;
  const error = new NativeCliAgentError(
    "Ollama cloud usage limit is currently exhausted",
    503,
  );
  error.quotaFailure = true;
  throw error;
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
}) {
  if (!existsSync(OPENCODE_EXE)) throw new NativeCliAgentError(`OpenCode CLI is missing at ${OPENCODE_EXE}`);
  if (!existsSync(LAZY_RZMCP_PROXY)) throw new NativeCliAgentError(`Lazy RzMCP proxy is missing at ${LAZY_RZMCP_PROXY}`);
  mkdirSync(OPENCODE_STATE_DIRECTORY, { recursive: true });
  sweepStaleNativeState();
  const dbPath = retainedNativeStatePath(context, providerKind);
  const releaseNativeState = await acquireNativeState(dbPath);
  const resumeRetainedSession = retainedOpenCodeStates.has(dbPath) && nativeStateExists(dbPath);
  const priorProgress = resumeRetainedSession ? retainedOpenCodeProgress.get(dbPath) : null;
  retainedOpenCodeStates.delete(dbPath);
  if (!resumeRetainedSession) {
    retainedOpenCodeProgress.delete(dbPath);
    if (nativeStateExists(dbPath)) await cleanupNativeState(dbPath);
  }
  const env = {
    ...sanitizedEnvironment(),
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
      args: openCodeRunArgs(context, providerKind, prompt, continueSession, agent),
      cwd: context.workingDirectory,
      env,
      signal,
      onEvent,
      parseLine: (event, state) => openCodeParser(event, state, parserPolicy),
      inspectStderr: (stderr) => inspectOpenCodeStderr(providerKind, stderr),
      label: `${context.provider} native OpenCode agent`,
      requestTimeoutMs: timeoutMs,
      routeOwnershipTimeoutMs: routeOwnershipTimeout(continueSession, timeoutMs),
    });
    return state;
  };
  let preserveRetainedSession = false;
  try {
    const currentResult = await completeOpenCodeTurn(
      context,
      model,
      () => run(context.prompt, resumeRetainedSession),
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
      retainedOpenCodeStates.add(dbPath);
      retainedOpenCodeProgress.set(dbPath, result);
      preserveRetainedSession = true;
    }
    return {
      ...result,
      resumedProviderSession: resumeRetainedSession,
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
    preserveRetainedSession = resumeRetainedSession || cumulativeProgress.toolNames.length > 0;
    if (preserveRetainedSession) {
      retainedOpenCodeStates.add(dbPath);
      retainedOpenCodeProgress.set(dbPath, cumulativeProgress);
    }
    throw error;
  } finally {
    // OpenCode can close before its SQLite handles are released on Windows. Cleanup is not part of
    // provider task correctness: retry the release window, retain a named artifact if it remains
    // locked, and let the age-based sweep remove it after no legitimate request can still own it.
    if (!preserveRetainedSession) {
      retainedOpenCodeStates.delete(dbPath);
      retainedOpenCodeProgress.delete(dbPath);
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
  state.eventSequence = Number(state.eventSequence || 0) + 1;
  if (payload?.type === "text_delta" && typeof payload.delta === "string") {
    state.finalText += payload.delta;
    state.lastTextSequence = state.eventSequence;
  }
  if (payload?.type === "tool_running" || payload?.type === "tool_completed") {
    state.providerToolStarted = true;
  }
  if (payload?.type === "tool_queued" && payload.toolCallId) {
    state.pendingToolInputs.set(payload.toolCallId, payload.input);
  }
  if (payload?.type === "tool_completed") {
    const name = String(payload.toolName || "unknown_tool");
    const input = payload.toolInput
      ?? payload.input
      ?? payload.arguments
      ?? state.pendingToolInputs.get(payload.toolCallId);
    state.pendingToolInputs.delete(payload.toolCallId);
    state.lastCompletedToolCallId = payload.toolCallId;
    state.lastCompletedToolInput = input;
    state.toolNames.push(name);
    state.toolInputs.push(input ?? null);
    const rzMcpTool = nativeRzMcpToolName(name, input);
    if (rzMcpTool) state.rzMcpTools.push(rzMcpTool);
    state.lastToolSequence = state.eventSequence;
    if (nativeToolIsMutation(name, input, executionPolicy)) state.mutationCount += 1;
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
  if (!existsSync(COMMAND_CODE_ENTRY)) {
    throw new NativeCliAgentError(`CommandCode CLI is missing at ${COMMAND_CODE_ENTRY}`);
  }
  const sessionName = commandCodeSessionName(context);
  const releaseNativeState = await acquireNativeState(`commandcode:${sessionName || randomUUID()}`);
  const resumeRetainedSession = sessionName ? retainedCommandCodeSessions.has(sessionName) : false;
  const reasoningArgs = commandCodeReasoningArgs(context.model, context.requiredEffort);
  const args = [
    COMMAND_CODE_ENTRY,
    "-p", commandCodePrompt(context),
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
    });
    if (sessionName) {
      if (context.taskState.checkpointRequested) retainedCommandCodeSessions.add(sessionName);
      else retainedCommandCodeSessions.delete(sessionName);
    }
    return {
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
        model: context.model,
      }),
      executionCount: 1,
      sameSessionContinuations: resumeRetainedSession ? 1 : 0,
      resumedProviderSession: resumeRetainedSession,
      actualReasoningEffort: reasoningArgs.length > 0 ? context.requiredEffort : "fixed-model-maximum",
    };
  } catch (error) {
    if (sessionName && error?.status === 499 && (error.nativeToolNames || []).length > 0) {
      retainedCommandCodeSessions.add(sessionName);
    }
    throw error;
  } finally {
    releaseNativeState();
  }
}

export async function nativeCliAgentRunnerSelfTest() {
  const authoritativeWorkspace = join(import.meta.dirname, "..");
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
  const explicitReadOnlyRzMcp = policyContext(
    "Read-only inspection. No edits/build/tests/editor control/assets saves/staging. Use RzDirectMCP semantic/read-only APIs only (never binary grep).",
  );
  const explicitRzMcpBan = policyContext(
    "Read-only inspection. Use repository text tools, but do not use or invoke RzDirectMCP.",
  );
  const genericEditorBan = policyContext(
    "Read-only inspection. No edits/build/tests/editor/PIE/staging.",
  );
  if (
    explicitReadOnlyRzMcp.rzMcpMode !== "read-only"
    || explicitRzMcpBan.rzMcpMode !== "disabled"
    || genericEditorBan.rzMcpMode !== "disabled"
  ) {
    throw new Error("native CLI RzMCP task capability classification failed");
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
  const initialArgs = openCodeRunArgs(resumedMutationContext, "ollama", resumedMutationContext.prompt);
  const recoveryArgs = openCodeRunArgs(
    resumedMutationContext,
    "ollama",
    recoveryPrompt,
    true,
    OPENCODE_TERMINAL_AGENT,
  );
  const nonOllamaArgs = openCodeRunArgs(resumedMutationContext, "opencode", resumedMutationContext.prompt);
  if (
    initialArgs.includes("--continue")
    || !initialArgs.includes("--title")
    || initialArgs[initialArgs.indexOf("--agent") + 1] !== OPENCODE_PRIMARY_AGENT
    || !initialArgs.includes("--print-logs")
    || !initialArgs.includes("ERROR")
    || !recoveryArgs.includes("--continue")
    || recoveryArgs.includes("--title")
    || recoveryArgs[recoveryArgs.indexOf("--agent") + 1] !== OPENCODE_TERMINAL_AGENT
    || nonOllamaArgs.includes("--print-logs")
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
  const postToolSilence = await nativeProcess({
    command: process.execPath,
    args: [
      "-e",
      "console.log(JSON.stringify({type:'tool',name:'read'})); setTimeout(() => { console.log(JSON.stringify({type:'done',text:'complete'})); }, 350);",
    ],
    cwd: process.cwd(),
    env: sanitizedEnvironment(),
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
    env: sanitizedEnvironment(),
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
      env: sanitizedEnvironment(),
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
    env: sanitizedEnvironment(),
    parseLine: fixtureParser,
    inspectStderr: (stderr) => inspectOpenCodeStderr("ollama", stderr),
    label: "Ollama benign stderr fixture",
    requestTimeoutMs: 2_000,
    routeOwnershipTimeoutMs: 1_500,
  });
  if (benignStderr.state.finalText !== "complete") {
    throw new Error("native Ollama stderr inspection rejected a non-quota message");
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

  let preToolTimeout = null;
  try {
    await nativeProcess({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 1000);"],
      cwd: process.cwd(),
      env: sanitizedEnvironment(),
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
