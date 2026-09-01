import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  TaskStateError,
  activeTaskPromptSection,
  taskControlPromptSections,
  taskDeliveryDiagnostics,
  taskStateFromInput,
} from "./codebuddy-subagent-task-state.mjs";

const MAX_ACTIVE_TASK_CHARS = 40_000;
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
const INACTIVITY_TIMEOUT_MS = 55 * 1000;
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
const EXPLICIT_READ_ONLY_TASK = /\bread[- ]only\b|\bno[- ]mutation\b|\bno\s+(?:edits?|modifications?|writes?|mutations?|file\s+changes|source\s+changes)\b|\b(?:do not|must not|never)\s+(?:edit|modify|write|mutate)(?:\s+(?:any|the|source|project|workspace|files?)){0,3}(?:[.;,]|$)/i;
const VALIDATION_RESTRICTED_TASK = /\b(?:do not|must not|never)[^.\n]{0,160}\b(?:build|compile|run\s+(?:the\s+)?tests?|test|control\s+(?:the\s+)?editor|use\s+(?:the\s+)?editor|pie|sie)\b|\bno\s+(?:build|compile|tests?|editor|pie|sie)\b/i;
const RZMCP_RESTRICTED_TASK = /\b(?:do not|must not|never)[^.\n]{0,160}\b(?:use|invoke|control|call)\s+(?:any\s+|the\s+)?(?:editor|rzmcp)\b|\bno\s+[^.\n]{0,120}\b(?:editor|rzmcp|pie|sie)\b/i;
const MUTATION_TOOL = /^(?:apply_patch|edit|edit_file|write|write_file|create_file|delete_file|move_file|mcp__rzmcp__call_rzmcp_tool)$/i;

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

function workingDirectoryFrom(body) {
  const cwd = body.client_metadata?.cwd;
  if (typeof cwd === "string" && isAbsolute(cwd) && existsSync(cwd)) return cwd;
  return process.cwd();
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
  const readOnly = taskState.activeTask?.intent === "analysis" || EXPLICIT_READ_ONLY_TASK.test(task);
  return {
    readOnly,
    validationRestricted: VALIDATION_RESTRICTED_TASK.test(task),
    rzMcpMode: RZMCP_RESTRICTED_TASK.test(task)
      ? "disabled"
      : readOnly
        ? "read-only"
        : "no-validation",
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
    "[Single native-agent execution contract]\nComplete this delegated task in this one CLI execution. Use your own local file, search, edit, and shell tools directly. Never delegate to another agent, task, teammate, swarm, or background worker. Do not return an intention, a deferred tool request, or a request for the parent to execute an ordinary file/shell operation. Return only when the bounded task is complete or a concrete blocker requires parent input. Honor the project AGENTS.md in the working directory. Builds, tests, editor control, PIE/SIE, runtime validation, and final integration remain owned by the parent whenever the task or project instructions reserve them.",
  ];
  const role = roleInstructionsFrom(body.instructions);
  if (role) sections.push(`[Role instructions]\n${role}`);
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
    prompt,
    workingDirectory: workingDirectoryFrom(body),
    taskState,
    taskDiagnostics: diagnostics,
    executionPolicy: executionPolicy(taskState),
    toolSchemaBytesIgnored: Buffer.byteLength(json(body.tools || [])),
  };
}

function nativeProcess({ command, args, cwd, env, signal, onEvent, parseLine, label }) {
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
    let lastActivityAt = Date.now();
    const state = {};
    const requestTimer = setTimeout(() => {
      child.kill();
      finish(new NativeCliAgentError(`${label} exceeded ${REQUEST_TIMEOUT_MS}ms`, 504));
    }, REQUEST_TIMEOUT_MS);
    const inactivityTimer = setInterval(() => {
      if (Date.now() - lastActivityAt < INACTIVITY_TIMEOUT_MS) return;
      child.kill();
      finish(new NativeCliAgentError(`${label} produced no process or provider activity for ${INACTIVITY_TIMEOUT_MS}ms`, 504));
    }, 1_000);
    inactivityTimer.unref?.();
    const abort = () => {
      child.kill();
      finish(new NativeCliAgentError(`${label} was aborted`, 499));
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(requestTimer);
      clearInterval(inactivityTimer);
      signal?.removeEventListener("abort", abort);
      if (error) {
        error.nativeToolNames = [...(state.toolNames || [])];
        error.providerMutationCount = Number(state.mutationCount || 0);
      }
      error ? reject(error) : resolve(value);
    };
    const consume = (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        lastActivityAt = Date.now();
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
            limit: { context: 65_536, output: 32_768 },
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

export async function runOpenCodeNativeAgent(context, { providerKind, signal, onEvent }) {
  if (!existsSync(OPENCODE_EXE)) throw new NativeCliAgentError(`OpenCode CLI is missing at ${OPENCODE_EXE}`);
  if (!existsSync(LAZY_RZMCP_PROXY)) throw new NativeCliAgentError(`Lazy RzMCP proxy is missing at ${LAZY_RZMCP_PROXY}`);
  mkdirSync(OPENCODE_STATE_DIRECTORY, { recursive: true });
  sweepStaleNativeState();
  const requestId = randomUUID();
  const dbPath = join(OPENCODE_STATE_DIRECTORY, `${requestId}.db`);
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
  const args = [
    "run", "--pure", "--auto", "--format", "json",
    "--title", "RzCodex native subagent",
    "--model", model, "--variant", context.requiredEffort,
    "--dir", context.workingDirectory, context.prompt,
  ];
  try {
    const { state } = await nativeProcess({
      command: OPENCODE_EXE,
      args,
      cwd: context.workingDirectory,
      env,
      signal,
      onEvent,
      parseLine: openCodeParser,
      label: `${context.provider} native OpenCode agent`,
    });
    return validateResult(context, {
      finalText: state.finalText || "",
      toolNames: state.toolNames || [],
      mutationCount: state.mutationCount || 0,
      inputTokens: state.inputTokens || 0,
      outputTokens: state.outputTokens || 0,
      peakTurnInputTokens: state.peakTurnInputTokens || 0,
      lastTextSequence: state.lastTextSequence || 0,
      lastToolSequence: state.lastToolSequence || 0,
      model,
    });
  } finally {
    // OpenCode can close before its SQLite handles are released on Windows. Cleanup is not part of
    // provider task correctness: retry the release window, retain a named artifact if it remains
    // locked, and let the age-based sweep remove it after no legitimate request can still own it.
    await cleanupNativeState(dbPath);
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
  const args = [
    COMMAND_CODE_ENTRY,
    "-p", context.prompt,
    "--output-format", "json",
    "--no-session", "--no-skills", "--skip-onboarding", "--no-auto-update",
    "--model", context.model, "--effort", context.requiredEffort,
    "--yolo",
  ];
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
  return validateResult(context, {
    finalText: state.finalText || "",
    toolNames: state.toolNames || [],
    mutationCount: state.mutationCount || 0,
    inputTokens: state.inputTokens || 0,
    outputTokens: state.outputTokens || 0,
    peakTurnInputTokens: state.peakTurnInputTokens || 0,
    lastTextSequence: state.lastTextSequence || 0,
    lastToolSequence: state.lastToolSequence || 0,
    model: context.model,
  });
}

export function nativeCliAgentRunnerSelfTest() {
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
