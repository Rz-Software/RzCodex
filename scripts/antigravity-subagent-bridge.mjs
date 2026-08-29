#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import {
  TaskStateError,
  activeTaskPromptSection,
  normalizeAgentMessageContent,
  taskDeliveryDiagnostics,
  taskStateFromInput,
} from "./codebuddy-subagent-task-state.mjs";

const PROVIDER_ID = "antigravity";
const MODEL_ALIAS = "@preset/codex-subagents";
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
const INIT_TIMEOUT_MS = 30 * 1000;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SSE_HEARTBEAT_MS = 15 * 1000;
const MAX_SESSIONS = 8;
const CENTRAL_CONFIG = join(homedir(), ".codex", "subagent-models.json");
const AGY_EXE = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "agy", "bin", "agy.exe");
const MCP_CONFIG = join(homedir(), ".gemini", "config", "mcp_config.json");
const LAZY_MCP_SERVER = "rzcodex-lazy";
const MUTATION_TOOLS = new Set(["multi_replace_file_content", "replace_file_content", "sed_file", "write_to_file"]);

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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
    model: requireString(route.model, "antigravity.model"),
    inputModalities: route.inputModalities,
  };
}

function verifyModelAvailable(model) {
  const result = spawnSync(AGY_EXE, ["models"], {
    env: sanitizedEnvironment(), windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new BridgeError(`Cannot query Antigravity models: ${result.stderr || result.stdout}`, 500);
  }
  const exact = result.stdout.split(/\r?\n/).find((line) => line.trim().split(/\s+/)[0] === model);
  if (!exact) throw new BridgeError(`Configured Antigravity model ${json(model)} is unavailable`, 500);
  return exact.trim().slice(model.length).trim() || model;
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
  return environmentWorkingDirectoryFrom(input) || process.cwd();
}

function delegationContract(requestId, workingDirectory) {
  return `[Native Antigravity delegation contract]\nRzCodex request ID: ${requestId}\nWork directly in the supplied workspace as the bounded native sub-agent. Use Antigravity's local file and shell tools; do not emit Codex tool calls and do not invoke Antigravity subagents. AGY's run_command tool starts in an internal scratch directory, so every shell command must begin by changing to the authoritative workspace with Set-Location -LiteralPath, and every file-tool path must be absolute. For Unreal/RzMCP work, use only MCP server ${LAZY_MCP_SERVER}: discover a small focused schema with search_rzmcp_tools, then call only a discovered tool through call_rzmcp_tool. Never request or enumerate the full RzMCP catalog. Return concise evidence as soon as the bounded task is complete or genuinely blocked.\nAuthoritative workspace: ${workingDirectory}`;
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
      if (message.newTask && !message.checkpoint) continue;
      checkpoint = message.checkpoint;
      text = `[Inter-agent message ${message.author} -> ${message.recipient}]\n${message.text}`;
    } else if (["function_call", "custom_tool_call", "tool_search_call"].includes(item.type)) {
      text = `[Prior Codex tool request ${item.name || "tool_search"}; call_id=${item.call_id}]`;
    } else if (["function_call_output", "custom_tool_call_output"].includes(item.type)) {
      text = `[Prior Codex tool result; call_id=${item.call_id}]\n${outputText(item.output)}`;
    } else if (item.type === "tool_search_output") {
      text = `[Prior Codex tool search result; call_id=${item.call_id}]`;
    } else if (item.type === "reasoning") {
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

function boundedEntries(entries, budget, activeTaskText) {
  const retained = [];
  let remaining = Math.max(0, budget);
  for (let index = entries.length - 1; index >= 0 && remaining > 0; index -= 1) {
    let text = entries[index].text;
    if (activeTaskText) text = text.split(activeTaskText).join("[duplicate active task omitted]");
    if (text.length > remaining) text = text.slice(-remaining);
    retained.unshift({ ...entries[index], text });
    remaining -= text.length;
  }
  return retained;
}

function requestContext(body) {
  assertObject(body, "request body");
  if (body.stream !== true) throw new BridgeError("The Antigravity bridge requires stream=true");
  if (requireString(body.model, "model") !== MODEL_ALIAS) {
    throw new BridgeError(`Unknown managed model alias ${json(body.model)}`);
  }
  const effort = body.reasoning?.effort;
  if (effort !== undefined && effort !== REQUIRED_EFFORT) {
    throw new BridgeError(`Antigravity subagents require centrally configured effort ${REQUIRED_EFFORT}`);
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
  const sessionKey = threadId || taskState.activeTask?.name || null;
  return {
    requestId,
    workingDirectory,
    threadId,
    sessionKey,
    roleInstructions: roleInstructionsFrom(body.instructions),
    taskState,
    entries,
    messageKeys: new Set(entries.map((entry) => entry.key)),
    toolSchemaBytes: Buffer.byteLength(json(body.tools || [])),
  };
}

function fullPrompt(context) {
  const sections = [delegationContract(context.requestId, context.workingDirectory)];
  if (context.roleInstructions) sections.push(`[Role instructions]\n${context.roleInstructions}`);
  const activeTask = activeTaskPromptSection(context.taskState);
  const mandatoryChars = sections.reduce((sum, section) => sum + section.length, 0) + activeTask.length;
  const retained = boundedEntries(
    context.entries,
    MAX_PROMPT_CHARS - mandatoryChars,
    context.taskState.activeTask?.text,
  );
  if (activeTask) {
    const activeIndex = context.taskState.activeTask.index;
    sections.push(...retained.filter((entry) => entry.index < activeIndex && !entry.checkpoint).map((entry) => entry.text));
    sections.push(activeTask);
    sections.push(...retained.filter((entry) => entry.index > activeIndex && !entry.checkpoint).map((entry) => entry.text));
    sections.push(...retained.filter((entry) => entry.checkpoint).map((entry) => entry.text));
  } else {
    sections.push(...retained.map((entry) => entry.text));
  }
  const prompt = sections.join("\n\n");
  if (prompt.length > MAX_PROMPT_CHARS) throw new BridgeError("Normalized Antigravity prompt exceeded its hard limit", 500);
  return prompt;
}

function resumePrompt(context, session) {
  const unseen = context.entries.filter((entry) => !session.seenMessageKeys.has(entry.key));
  const retained = boundedEntries(unseen, MAX_RESUME_PROMPT_CHARS, context.taskState.activeTask?.text);
  const sections = [
    `[Native Antigravity resume]\nContinue the retained active task in ${context.workingDirectory}. Task hash: ${context.taskState.activeTask?.hash || "none"}. The original task remains authoritative; do not restart the investigation.`,
    ...retained.filter((entry) => !entry.checkpoint).map((entry) => entry.text),
    ...retained.filter((entry) => entry.checkpoint).map((entry) => entry.text),
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

class AntigravitySession {
  constructor(key, workingDirectory, activeTaskHash, onClose) {
    this.key = key;
    this.workingDirectory = workingDirectory;
    this.activeTaskHash = activeTaskHash;
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
    const args = [
      "--input-format", "stream-json", "--output-format", "stream-json",
      "--model", route.model, "--effort", REQUIRED_EFFORT,
      "--dangerously-skip-permissions", "--disable-slash-commands",
      "--print-timeout", "30m",
    ];
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
      if (init.model !== route.model) {
        this.fail(new BridgeError(`Antigravity initialized unexpected model ${json(init.model)}`, 502));
        return;
      }
      if (init.permission_mode !== "always-proceed") {
        this.fail(new BridgeError(`Antigravity initialized unexpected permission mode ${json(init.permission_mode)}`, 502));
        return;
      }
      this.init = { ...init, conversationId: event.conversation_id };
      this.initSettled = true;
      runtime.lastAuthVerifiedAt = new Date().toISOString();
      runtime.lastInitializedToolCount = Array.isArray(init.tools) ? init.tools.length : null;
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
      if (step.step_type === "tool" && step.state === "ACTIVE") {
        const name = step.tool_name || step.tool_info?.name;
        if (typeof name === "string") this.turn.toolNames.add(name);
        if (MUTATION_TOOLS.has(name)) this.turn.mutationToolCalls += 1;
        if (name === "call_mcp_tool") {
          const parameters = step.tool_info?.parameters || {};
          const server = parameters.ServerName || parameters.server_name || parameters.server || parameters.mcp_server;
          const tool = parameters.ToolName || parameters.tool_name || parameters.name;
          if (server === LAZY_MCP_SERVER && typeof tool === "string") this.turn.rzMcpTools.add(tool);
        }
      }
      return;
    }
    if (event?.event === "result" && this.turn) this.finishTurn(event.result);
  }

  run(prompt, signal) {
    if (!this.init) throw new BridgeError("Antigravity session is not initialized", 500);
    if (this.turn) throw new BridgeError("Antigravity session already has an active turn", 409);
    if (signal?.aborted) throw new BridgeError("Client disconnected before Antigravity started", 499);
    clearTimeout(this.idleTimer);
    return new Promise((resolve, reject) => {
      const onAbort = () => this.close(new BridgeError("Client disconnected while Antigravity was active", 499));
      signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => this.close(new BridgeError(`Antigravity exceeded ${REQUEST_TIMEOUT_MS}ms`, 504)), REQUEST_TIMEOUT_MS);
      this.turn = {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
        },
        peakContextTokens: 0,
        generatedTokens: 0,
        generationSeconds: 0,
        toolNames: new Set(),
        rzMcpTools: new Set(),
        mutationToolCalls: 0,
      };
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
      turn.reject(new BridgeError(`Antigravity turn failed with status ${json(result?.status)}`, 502));
      this.close();
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
      outputTokensPerSecond: turn.generationSeconds > 0 ? turn.generatedTokens / turn.generationSeconds : null,
      toolNames: [...turn.toolNames],
      rzMcpTools: [...turn.rzMcpTools],
      mutationToolCalls: turn.mutationToolCalls,
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
      turn.reject(error);
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
      turn.reject(error);
    }
    if (this.child && !this.child.killed) this.child.kill();
    this.onClose(this);
  }
}

function writeSse(response, type, payload) {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: ${type}\ndata: ${json({ type, ...payload })}\n\n`);
}

function writeHeartbeat(response, responseId) {
  writeSse(response, "response.in_progress", {
    response: { id: responseId, object: "response", model: MODEL_ALIAS, status: "in_progress" },
  });
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

function emitCompleted(response, responseId, result, metadata) {
  const messageId = `msg_${randomUUID()}`;
  const item = {
    type: "message", id: messageId, status: "completed", role: "assistant",
    content: [{ type: "output_text", text: result.text, annotations: [] }],
  };
  writeSse(response, "response.output_item.added", {
    output_index: 0,
    item: { ...item, status: "in_progress", content: [] },
  });
  writeSse(response, "response.content_part.added", {
    item_id: messageId, output_index: 0, content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });
  writeSse(response, "response.output_text.delta", {
    item_id: messageId, output_index: 0, content_index: 0, delta: result.text,
  });
  writeSse(response, "response.output_text.done", {
    item_id: messageId, output_index: 0, content_index: 0, text: result.text,
  });
  writeSse(response, "response.content_part.done", {
    item_id: messageId, output_index: 0, content_index: 0, part: item.content[0],
  });
  writeSse(response, "response.output_item.done", { output_index: 0, item });
  const completed = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: MODEL_ALIAS,
    output: [item],
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
const modelLabel = verifyModelAvailable(route.model);
const mcpConfig = verifyLazyMcpConfig();
const sessions = new Map();
const runtime = {
  incomingRequests: 0,
  completed: 0,
  failed: 0,
  rejected: 0,
  supersededTurns: 0,
  sessionsCreated: 0,
  sessionsReused: 0,
  lastActualModel: null,
  lastAuthVerifiedAt: null,
  lastConversationId: null,
  lastInitializedToolCount: null,
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
  const taskHash = context.taskState.activeTask?.hash || null;
  const incompatible = session && (
    session.closed
    || session.workingDirectory !== context.workingDirectory
    || session.activeTaskHash !== taskHash
  );
  if (incompatible) {
    session.close();
    session = null;
  }
  if (session?.busy) {
    runtime.supersededTurns += 1;
    session.close(new BridgeError("Antigravity turn superseded by a newer turn for the same worker", 409));
    session = null;
  }
  if (session) {
    runtime.sessionsReused += 1;
    return { session, reused: true };
  }
  if (sessions.size >= MAX_SESSIONS) evictIdleSession();
  const key = context.sessionKey || `ephemeral:${context.requestId}`;
  session = new AntigravitySession(key, context.workingDirectory, taskHash, removeSession);
  sessions.set(key, session);
  runtime.sessionsCreated += 1;
  await session.start();
  return { session, reused: false };
}

async function handleResponses(request, response) {
  const body = await readRequestBody(request);
  const context = requestContext(body);
  runtime.lastWorkingDirectory = context.workingDirectory;
  runtime.lastCodexToolSchemaBytesIgnored = context.toolSchemaBytes;
  runtime.lastTaskId = context.taskState.activeTask?.id || null;
  runtime.lastTaskHash = context.taskState.activeTask?.hash || null;
  runtime.lastTaskDeliveryMode = context.taskState.activeTask?.deliveryMode || null;
  const responseId = `resp_${randomUUID()}`;
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  writeSse(response, "response.created", {
    response: { id: responseId, object: "response", model: MODEL_ALIAS, status: "in_progress" },
  });
  writeHeartbeat(response, responseId);
  const controller = new AbortController();
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  const heartbeat = setInterval(() => writeHeartbeat(response, responseId), SSE_HEARTBEAT_MS);
  let selectedSession;
  try {
    const { session, reused } = await sessionFor(context);
    selectedSession = session;
    const prompt = reused ? resumePrompt(context, session) : fullPrompt(context);
    let diagnostics;
    try {
      diagnostics = taskDeliveryDiagnostics(context.taskState, prompt, {
        activeTaskIncludedThisTurn: !reused,
        retainedInProviderSession: reused,
      });
    } catch (error) {
      if (error instanceof TaskStateError) throw new BridgeError(error.message, 500);
      throw error;
    }
    const result = await session.run(prompt, controller.signal);
    for (const key of context.messageKeys) session.seenMessageKeys.add(key);
    runtime.completed += 1;
    runtime.lastActualModel = route.model;
    runtime.lastInputTokens = result.usage.input_tokens;
    runtime.lastCachedInputTokens = result.usage.cache_read_tokens;
    runtime.lastOutputTokens = result.usage.output_tokens;
    runtime.lastThinkingTokens = result.usage.thinking_tokens;
    runtime.lastPeakTurnContextTokens = result.peakContextTokens;
    runtime.lastOutputTokensPerSecond = result.outputTokensPerSecond;
    runtime.lastDurationSeconds = result.durationSeconds;
    runtime.lastNativeToolCalls = result.toolNames.length;
    runtime.lastNativeToolNames = result.toolNames;
    runtime.lastMutationToolCalls = result.mutationToolCalls;
    runtime.lastRzMcpTools = result.rzMcpTools;
    runtime.lastConversationId = result.conversationId;
    runtime.lastCompleteTaskDelivered = diagnostics.completeTaskDelivered;
    runtime.lastProviderSessionReused = reused;
    runtime.lastError = null;
    emitCompleted(response, responseId, result, {
      provider: PROVIDER_ID,
      actual_provider: PROVIDER_ID,
      actual_model: route.model,
      actual_model_label: modelLabel,
      reasoning_effort: REQUIRED_EFFORT,
      auth_source: "Antigravity cached OAuth session",
      conversation_id: result.conversationId,
      provider_session_reused: reused,
      peak_turn_context_tokens: result.peakContextTokens,
      output_tokens_per_second: result.outputTokensPerSecond,
      native_tool_calls: result.toolNames.length,
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
    });
    response.end();
    if (!context.sessionKey) session.close();
  } catch (error) {
    runtime.failed += 1;
    runtime.lastError = String(error?.message || error).slice(0, 2_000);
    writeSse(response, "response.failed", {
      response: {
        id: responseId,
        object: "response",
        model: MODEL_ALIAS,
        status: "failed",
        error: { code: "external_provider_error", message: runtime.lastError },
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
  return { models: [{
    slug: MODEL_ALIAS,
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
  }] };
}

function health() {
  return {
    ok: true,
    status: "healthy",
    provider: PROVIDER_ID,
    port,
    modelAlias: MODEL_ALIAS,
    configuredModel: route.model,
    configuredModelLabel: modelLabel,
    effort: REQUIRED_EFFORT,
    inputModalities: route.inputModalities,
    auth: {
      source: "Antigravity cached OAuth session",
      apiKeysStripped: true,
      liveVerifiedAt: runtime.lastAuthVerifiedAt,
    },
    lazyRzMcp: { server: LAZY_MCP_SERVER, proxyTools: 2, ...mcpConfig },
    codexToolSchemasForwarded: 0,
    sessionPolicy: { persistentStreamJson: true, idleMilliseconds: SESSION_IDLE_MS, maximumSessions: MAX_SESSIONS },
    activeSessions: sessions.size,
    activeTurns: [...sessions.values()].filter((session) => session.busy).length,
    runtime,
  };
}

async function selfTest() {
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
      { type: "message", role: "user", content: "x".repeat(120_000) },
      {
        type: "agent_message", id: "agy-task", author: "Codex", recipient: "/root/agy_fixture",
        content: [{ type: "input_text", text: taskHeader }, { type: "encrypted_content", encrypted_content: taskPayload }],
      },
    ],
  };
  const context = requestContext(fixture);
  const first = fullPrompt(context);
  const firstDiagnostics = taskDeliveryDiagnostics(context.taskState, first);
  if (first.length > MAX_PROMPT_CHARS || firstDiagnostics.completeTaskOccurrences !== 1) {
    throw new Error("bounded encrypted task delivery failed");
  }
  if (context.toolSchemaBytes < 100_000) throw new Error("tool-schema fixture is too small");
  const retainedSession = { seenMessageKeys: new Set(context.messageKeys) };
  const resumed = resumePrompt(context, retainedSession);
  const resumedDiagnostics = taskDeliveryDiagnostics(context.taskState, resumed, {
    activeTaskIncludedThisTurn: false,
    retainedInProviderSession: true,
  });
  if (!resumedDiagnostics.completeTaskDelivered || resumed.includes(task)) {
    throw new Error("provider-session task retention failed");
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
  emitCompleted({ destroyed: false, writableEnded: false, write: (value) => writes.push(value) }, "resp-test", {
    text: "done",
    usage: { input_tokens: 10, cache_read_tokens: 2, output_tokens: 3, thinking_tokens: 1, total_tokens: 13 },
  }, {});
  const sse = writes.join("");
  if (!sse.includes("response.output_text.delta") || !sse.includes("response.completed")) {
    throw new Error("Responses SSE lifecycle failed");
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
