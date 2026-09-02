import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
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

const MAX_ACTIVE_TASK_CHARS = 40_000;
const OLLAMA_CLOUD_CONTEXT_WINDOW = 1_048_576;
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
const ROUTE_OWNERSHIP_TIMEOUT_MS = 55 * 1000;
const TERMINAL_RECOVERY_TIMEOUT_MS = 45 * 1000;
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
const LAZY_RZMCP_PROXY = join(import.meta.dirname, "devin-rzmcp-lazy-proxy.mjs");
const ROLE_TAG = /<(?:external_cli|codebuddy|cursor)_route_instructions>([\s\S]*?)<\/(?:external_cli|codebuddy|cursor)_route_instructions>/gi;
const VALIDATION_RESTRICTED_TASK = /\b(?:do not|must not|never)[^.\n]{0,160}\b(?:build|compile|run\s+(?:the\s+)?tests?|test|control\s+(?:the\s+)?editor|use\s+(?:the\s+)?editor|pie|sie)\b|\bno\s+(?:build|compile|tests?|editor|pie|sie)\b/i;
const MUTATION_TOOL = /^(?:apply_patch|edit|edit_file|write|write_file|create_file|delete_file|move_file|mcp__rzmcp__call_rzmcp_tool)$/i;
const retainedOpenCodeStates = new Set();
const retainedCommandCodeSessions = new Set();
const nativeStateTails = new Map();

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
  const sections = [
    "[Single native-agent turn contract]\nComplete this delegated task within this one Codex subagent turn. Use your own local file, search, edit, and shell tools directly. Never delegate to another agent, task, teammate, swarm, or background worker. Do not return an intention, a deferred tool request, or a request for the parent to execute an ordinary file/shell operation. Return only when the bounded task is complete or a concrete blocker requires parent input. Honor the project AGENTS.md in the working directory. Builds, tests, editor control, PIE/SIE, runtime validation, and final integration remain owned by the parent whenever the task or project instructions reserve them.",
    "[Native tool boundary]\nThe host shell is PowerShell on Windows. Never read, grep, decode, strings-scan, hex-dump, or otherwise inspect Unreal .uasset or .umap bytes through file or shell tools. Use the lazy RzMCP semantic tools when the task authorizes asset access. If those tools are disabled, unavailable, or semantically insufficient, return that concrete blocker; do not approximate asset semantics from binary bytes or repeat equivalent offset/chunk probes. Never read secret environment files.",
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
    workingDirectory: workingDirectoryFrom(body, input),
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
      if (state.providerToolStarted || (state.toolNames || []).length > 0) {
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
  error.providerMutationCount = Number(
    nativeState.mutationCount ?? error.providerMutationCount ?? 0,
  );
  Object.defineProperty(error, "nativeState", {
    value: nativeState,
    configurable: true,
  });
  return error;
}

function terminalRecoveryPrompt(context, primary) {
  return [
    "[Native CLI terminal-message recovery]",
    "The retained provider session ended immediately after completed native tool work without a terminal assistant response.",
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
      initialFailure = attachNativeState(error, state);
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
        "*.env*": "deny",
        "*.env.example*": "allow",
        "*.uasset*": "deny",
        "*.umap*": "deny",
        "*ReadAllBytes*": "deny",
        "*Format-Hex*": "deny",
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

function openCodeParser(event, state) {
  state.finalText ||= "";
  state.toolNames ||= [];
  state.mutationCount ||= 0;
  state.inputTokens ||= 0;
  state.outputTokens ||= 0;
  state.peakTurnInputTokens ||= 0;
  state.eventSequence = Number(state.eventSequence || 0) + 1;
  if (event.type === "text" && typeof event.part?.text === "string") {
    state.finalText = event.part.text;
    state.lastTextSequence = state.eventSequence;
  }
  if (event.type === "tool_use") state.providerToolStarted = true;
  if (event.type === "tool_use" && event.part?.state?.status === "completed") {
    const name = String(event.part.tool || "unknown_tool");
    state.toolNames.push(name);
    state.lastToolSequence = state.eventSequence;
    if (MUTATION_TOOL.test(name)) state.mutationCount += 1;
  }
  if (event.type === "step_finish") {
    const input = Number(event.part?.tokens?.input || 0);
    state.inputTokens += input;
    state.outputTokens += Number(event.part?.tokens?.output || 0);
    state.peakTurnInputTokens = Math.max(state.peakTurnInputTokens, input);
  }
}

function openCodeRunArgs(context, providerKind, prompt, continueSession = false) {
  const args = ["run", "--pure", "--auto", "--format", "json"];
  if (continueSession) args.push("--continue");
  else args.push("--title", "RzCodex native subagent");
  args.push(
    "--model", `${providerKind}/${context.model}`,
    "--variant", context.requiredEffort,
    "--dir", context.workingDirectory,
    prompt,
  );
  return args;
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
  retainedOpenCodeStates.delete(dbPath);
  if (!resumeRetainedSession && nativeStateExists(dbPath)) await cleanupNativeState(dbPath);
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
  const run = async (prompt, continueSession, timeoutMs = REQUEST_TIMEOUT_MS) => {
    const { state } = await nativeProcess({
      command: OPENCODE_EXE,
      args: openCodeRunArgs(context, providerKind, prompt, continueSession),
      cwd: context.workingDirectory,
      env,
      signal,
      onEvent,
      parseLine: openCodeParser,
      label: `${context.provider} native OpenCode agent`,
      requestTimeoutMs: timeoutMs,
      routeOwnershipTimeoutMs: Math.min(ROUTE_OWNERSHIP_TIMEOUT_MS, timeoutMs),
    });
    return state;
  };
  let preserveRetainedSession = false;
  try {
    const result = await completeOpenCodeTurn(
      context,
      model,
      () => run(context.prompt, resumeRetainedSession),
      (prompt) => run(prompt, true, TERMINAL_RECOVERY_TIMEOUT_MS),
      onRecovery,
    );
    if (context.taskState.checkpointRequested) {
      retainedOpenCodeStates.add(dbPath);
      preserveRetainedSession = true;
    }
    return {
      ...result,
      resumedProviderSession: resumeRetainedSession,
    };
  } catch (error) {
    preserveRetainedSession = error?.status === 499
      && (resumeRetainedSession || (error.nativeToolNames || []).length > 0);
    if (preserveRetainedSession) retainedOpenCodeStates.add(dbPath);
    throw error;
  } finally {
    // OpenCode can close before its SQLite handles are released on Windows. Cleanup is not part of
    // provider task correctness: retry the release window, retain a named artifact if it remains
    // locked, and let the age-based sweep remove it after no legitimate request can still own it.
    if (!preserveRetainedSession) {
      retainedOpenCodeStates.delete(dbPath);
      await cleanupNativeState(dbPath);
    }
    releaseNativeState();
  }
}

function commandCodeParser(event, state) {
  const payload = event?.type === "event" ? event.event : event;
  state.finalText ||= "";
  state.toolNames ||= [];
  state.mutationCount ||= 0;
  state.inputTokens ||= 0;
  state.outputTokens ||= 0;
  state.peakTurnInputTokens ||= 0;
  state.eventSequence = Number(state.eventSequence || 0) + 1;
  if (payload?.type === "text_delta" && typeof payload.delta === "string") {
    state.finalText += payload.delta;
    state.lastTextSequence = state.eventSequence;
  }
  if (payload?.type === "tool_running" || payload?.type === "tool_completed") {
    state.providerToolStarted = true;
  }
  if (payload?.type === "tool_completed") {
    const name = String(payload.toolName || "unknown_tool");
    state.toolNames.push(name);
    state.lastToolSequence = state.eventSequence;
    if (MUTATION_TOOL.test(name)) state.mutationCount += 1;
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
  const args = [
    COMMAND_CODE_ENTRY,
    "-p", context.prompt,
    "--output-format", "json",
    ...(sessionName
      ? resumeRetainedSession ? ["--resume", sessionName] : ["--name", sessionName]
      : ["--no-session"]),
    "--no-skills", "--skip-onboarding", "--no-auto-update",
    "--model", context.model, "--effort", context.requiredEffort,
    "--yolo",
  ];
  try {
    const { state } = await nativeProcess({
      command: process.execPath,
      args,
      cwd: context.workingDirectory,
      env: {
        ...sanitizedEnvironment(),
        COMMANDCODE_SKIP_UPDATES: "1",
        RZCODEX_SUBAGENT_RZMCP_MODE: context.executionPolicy.rzMcpMode,
      },
      signal,
      onEvent,
      parseLine: commandCodeParser,
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
  const authoritativeWorkspace = homedir();
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
  const readPermissionEntries = Object.entries(ollamaConfigFixture.permission?.read || {});
  const bashPermissionEntries = Object.entries(ollamaConfigFixture.permission?.bash || {});
  if (
    readPermissionEntries[0]?.[0] !== "*"
    || ollamaConfigFixture.permission?.read?.["*.uasset"] !== "deny"
    || ollamaConfigFixture.permission?.read?.["**/*.uasset"] !== "deny"
    || ollamaConfigFixture.permission?.read?.["*.umap"] !== "deny"
    || ollamaConfigFixture.permission?.read?.["**/*.umap"] !== "deny"
    || bashPermissionEntries[0]?.[0] !== "*"
    || ollamaConfigFixture.permission?.bash?.["*.uasset*"] !== "deny"
    || ollamaConfigFixture.permission?.bash?.["*.umap*"] !== "deny"
    || ollamaConfigFixture.permission?.bash?.["*ReadAllBytes*"] !== "deny"
    || ollamaConfigFixture.permission?.bash?.["*Format-Hex*"] !== "deny"
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
    || !cwdContext.prompt.includes("Never read, grep, decode, strings-scan, hex-dump")
    || !cwdContext.prompt.includes("Use the lazy RzMCP semantic tools")
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

  let recoveryPrompt = "";
  let recoveryNotices = 0;
  const recovered = await completeOpenCodeTurn(
    resumedMutationContext,
    "ollama/glm-5.3-flash:cloud",
    async () => ({
      finalText: "I'll inspect the file now.",
      toolNames: ["read"],
      mutationCount: 0,
      inputTokens: 100,
      outputTokens: 10,
      peakTurnInputTokens: 100,
      lastTextSequence: 1,
      lastToolSequence: 2,
    }),
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
  const recoveryArgs = openCodeRunArgs(resumedMutationContext, "ollama", recoveryPrompt, true);
  if (
    initialArgs.includes("--continue")
    || !initialArgs.includes("--title")
    || !recoveryArgs.includes("--continue")
    || recoveryArgs.includes("--title")
  ) {
    throw new Error("native OpenCode continuation did not retain the isolated provider session");
  }

  let recoveryFailure = null;
  try {
    await completeOpenCodeTurn(
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
