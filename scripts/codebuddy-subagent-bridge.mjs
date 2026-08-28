#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const PROVIDER_ID = "codebuddy";
const MODEL_ALIAS = "@preset/codex-subagents";
const REQUIRED_AUTH_SOURCE = "www.codebuddy.ai";
const REQUIRED_EFFORT = "max";
const DEFAULT_PORT = 54547;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_PROMPT_CHARS = 120_000;
const STDERR_LIMIT = 16 * 1024;
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
const TEXT_TOOL_NAME = "tool_search";
const WIRE_TEXT_TOOL_NAME = "search_tools";
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const MODEL_ROUTES_FILE = join(CODEX_HOME, "subagent-models.json");
const REQUEST_DIRECTORY = join(CODEX_HOME, "codebuddy-bridge", "requests");
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_SCRIPT = join(SCRIPT_DIRECTORY, "codebuddy-codex-tools-mcp.mjs");
const CODEBUDDY_SCRIPT = join(
  process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
  "npm", "node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy",
);

class BridgeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
  }
}

const runtime = {
  incomingRequests: 0,
  requests: 0,
  completed: 0,
  failed: 0,
  rejected: 0,
  lastRejectedError: null,
  lastModel: null,
  lastAuthSource: null,
  lastCostUsd: null,
  lastInputTokens: null,
  lastOutputTokens: null,
  lastDurationApiMs: null,
  lastMaxTurnInputTokens: null,
  lastCodexToolCount: null,
  lastCodexToolSchemaBytes: null,
  maxObservedTurnInputTokens: 0,
  maxObservedCodexToolCount: 0,
  maxObservedCodexToolSchemaBytes: 0,
  lastWorkingDirectory: null,
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
  if (requested !== MODEL_ALIAS) {
    throw new BridgeError(`CodeBuddy subagents must use the centrally managed ${MODEL_ALIAS} alias`);
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
  return candidates.filter((candidate) => isAbsolute(candidate) && existsSync(candidate)).at(-1) || process.cwd();
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

function codexToolsFrom(body) {
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw new BridgeError("tools must be an array");
  const definitions = [];
  const byWire = new Map();
  const byOriginal = new Map();
  const hosted = new Set();
  const add = (namespace, tool, label, toolSearch = false) => {
    const originalName = toolSearch ? TEXT_TOOL_NAME : requireString(tool.name, `${label}.name`);
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
  const hasViewImage = toolInfo.byOriginal.has(toolLookupKey(null, "view_image"));
  if (hasViewImage !== inputModalities.includes("image")) {
    throw new BridgeError(
      `RzCodex image capability disagrees with the managed route: ${inputModalities.join(", ")}`,
      500,
    );
  }
}

function promptFrom(body) {
  assertObject(body, "request body");
  if (body.stream !== true) throw new BridgeError("The CodeBuddy bridge requires stream=true");
  const route = resolveRoute(requireString(body.model, "model"));
  const requestedEffort = body.reasoning?.effort;
  if (requestedEffort !== undefined && requestedEffort !== REQUIRED_EFFORT) {
    throw new BridgeError(`CodeBuddy subagents require reasoning effort ${REQUIRED_EFFORT}, got ${requestedEffort}`);
  }
  const input = typeof body.input === "string" ? [{ type: "message", role: "user", content: body.input }] : body.input;
  if (!Array.isArray(input)) throw new BridgeError("input must be a string or array");
  const toolInfo = codexToolsFrom(body);
  validateManagedToolSurface(toolInfo, route.inputModalities);
  const sections = [
    "[Native delegation contract]\nWork as the delegated CodeBuddy sub-agent in the current workspace. Complete only the bounded task and return concise evidence to the parent. The MCP server named codex exposes exactly the client-executed tools Codex made available for this turn. CodeBuddy serves those schemas lazily: use ToolSearch with the exact mcp__codex__ tool name before invoking it through DeferExecuteTool. When its proxy reports DEFERRED_TO_CODEX_CLIENT, immediately end the turn without retrying, fabricating a result, or calling another tool; the parent will execute it and resume you with the real result.",
  ];
  const roleInstructions = roleInstructionsFrom(body.instructions);
  if (roleInstructions) sections.push(`[Role instructions]\n${roleInstructions}`);
  if (toolInfo.definitions.length > 0) {
    const providerNames = toolInfo.definitions.map((tool) => `mcp__codex__${tool.name}`);
    sections.push(
      `[Codex client tools available this turn]\n${providerNames.join("\n")}\n` +
      "These are names only; load an exact name with ToolSearch before calling it.",
    );
  }
  if (toolInfo.hosted.has("web_search")) {
    sections.push("[Provider-native tools mapped this turn]\nweb_search -> CodeBuddy WebSearch");
  }
  const history = [];
  const pushHistory = (text, images = []) => {
    if (text || images.length > 0) history.push({ text, images });
  };
  for (let index = 0; index < input.length; index += 1) {
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
      const author = typeof item.author === "string" ? item.author : "Codex";
      const recipient = typeof item.recipient === "string" ? item.recipient : "CodeBuddy worker";
      const text = contentText(item.content, `${label}.content`);
      if (text) pushHistory(`[Delegated task ${author} -> ${recipient}]\n${text}`);
    } else if (item.type === "reasoning") {
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
  let retainedChars = 0;
  const retained = [];
  const images = [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const section = history[index];
    if (retainedChars + section.text.length > MAX_PROMPT_CHARS && retained.length > 0) break;
    retained.unshift(section.text.slice(-MAX_PROMPT_CHARS));
    images.unshift(...section.images);
    retainedChars += section.text.length;
  }
  sections.push(...retained);
  const workingDirectory = workingDirectoryFrom(body);
  if (!isAbsolute(workingDirectory) || !existsSync(workingDirectory)) {
    throw new BridgeError(`CodeBuddy working directory does not exist: ${JSON.stringify(workingDirectory)}`);
  }
  if (images.length > 0 && !route.inputModalities.includes("image")) {
    throw new BridgeError("The managed CodeBuddy route does not support image input", 500);
  }
  return { model: route.model, prompt: sections.join("\n\n"), images, workingDirectory, toolInfo };
}

function requestArtifacts(context) {
  mkdirSync(REQUEST_DIRECTORY, { recursive: true });
  const requestId = randomUUID();
  const definitionsPath = join(REQUEST_DIRECTORY, `${requestId}-tools.json`);
  const configPath = join(REQUEST_DIRECTORY, `${requestId}-mcp.json`);
  writeFileSync(definitionsPath, jsonString({ tools: context.toolInfo.definitions }), { encoding: "utf8", flag: "wx" });
  const mcpConfig = {
    mcpServers: { codex: { command: process.execPath, args: [MCP_SERVER_SCRIPT, definitionsPath] } },
  };
  writeFileSync(configPath, jsonString(mcpConfig), { encoding: "utf8", flag: "wx" });
  return {
    mcpConfig: configPath,
    cleanup: () => {
      for (const path of [definitionsPath, configPath]) {
        try { unlinkSync(path); } catch (error) {
          if (error?.code !== "ENOENT") process.stderr.write(`CodeBuddy request cleanup failed: ${redactSecrets(error.message)}\n`);
        }
      }
    },
  };
}

function sanitizedEnvironment() {
  const env = { ...process.env };
  for (const key of [
    "OPENROUTER_API_KEY", "TENCENT_API_KEY", "TENCENTCLOUD_SECRET_ID",
    "TENCENTCLOUD_SECRET_KEY", "CODEBUDDY_API_KEY",
  ]) delete env[key];
  return env;
}

function validateResult(context, initEvent, resultEvent) {
  if (!initEvent) throw new BridgeError("CodeBuddy completed without an init event", 502);
  if (initEvent.model !== context.model) throw new BridgeError(`CodeBuddy initialized unexpected model ${JSON.stringify(initEvent.model)}`, 502);
  if (initEvent.apiKeySource !== REQUIRED_AUTH_SOURCE) throw new BridgeError(`CodeBuddy used unexpected auth source ${JSON.stringify(initEvent.apiKeySource)}`, 502);
  if (!resultEvent || resultEvent.subtype !== "success" || resultEvent.is_error === true) {
    throw new BridgeError(`CodeBuddy failed: ${resultEvent?.result || "no successful result event"}`, 502);
  }
  if (resultEvent.total_cost_usd !== 0) {
    throw new BridgeError(`CodeBuddy reported a non-zero or unknown explicit cost: ${JSON.stringify(resultEvent.total_cost_usd)}`, 502);
  }
  const usedModels = Object.keys(resultEvent.modelUsage || {});
  if (usedModels.length !== 1 || usedModels[0] !== context.model) {
    throw new BridgeError(`CodeBuddy model usage indicates fallback: ${JSON.stringify(usedModels)}`, 502);
  }
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
  const tools = ["ToolSearch", "DeferExecuteTool"];
  if (context.toolInfo.hosted.has("web_search")) tools.push("WebSearch");
  return [
    CODEBUDDY_SCRIPT,
    "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages",
    "--dangerously-skip-permissions", "--tools", tools.join(","),
    "--model", context.model, "--effort", REQUIRED_EFFORT,
    "--mcp-config", mcpConfig, "--strict-mcp-config", "--no-session-persistence",
  ];
}

function codeBuddyInput(prompt, images = []) {
  return `${jsonString({
    type: "user",
    message: { role: "user", content: [{ type: "input_text", text: prompt }, ...images] },
  })}\n`;
}

function runCodeBuddy(context, onSpawn) {
  if (!existsSync(CODEBUDDY_SCRIPT)) throw new BridgeError(`CodeBuddy CLI is not installed at ${CODEBUDDY_SCRIPT}`, 502);
  if (!existsSync(MCP_SERVER_SCRIPT)) throw new BridgeError(`Codex tool MCP adapter is missing at ${MCP_SERVER_SCRIPT}`, 502);
  const artifacts = requestArtifacts(context);
  const args = codeBuddyArguments(context, artifacts.mcpConfig);
  const child = spawn(process.execPath, args, {
    cwd: context.workingDirectory,
    env: sanitizedEnvironment(),
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
    const calls = new Map();
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      artifacts.cleanup();
      error ? reject(error) : resolve(value);
    };
    const parseLine = (line) => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch {
        stderr = `${stderr}${line}\n`.slice(-STDERR_LIMIT);
        return;
      }
      if (event.type === "system" && event.subtype === "init") initEvent = event;
      if (event.type === "assistant" && Array.isArray(event.message?.content)) {
        const turnInput = event.message?.usage?.input_tokens;
        if (Number.isInteger(turnInput)) maxTurnInputTokens = Math.max(maxTurnInputTokens, turnInput);
        const text = event.message.content
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text).join("");
        if (text && !text.includes("DEFERRED_TO_CODEX_CLIENT")) finalText = text;
        for (const part of event.message.content.filter((item) => item?.type === "tool_use")) {
          const call = providerToolCall(part, context);
          if (call) {
            const callKey = providerToolCallKey(call);
            if (!calls.has(callKey)) calls.set(callKey, call);
          }
        }
      }
      if (event.type === "result") resultEvent = event;
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new BridgeError(`CodeBuddy exceeded ${REQUEST_TIMEOUT_MS}ms`, 504));
    }, REQUEST_TIMEOUT_MS);
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
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-STDERR_LIMIT); });
    child.stdin.on("error", (error) => {
      if (error?.code !== "EPIPE") finish(new BridgeError(`CodeBuddy stdin failed: ${error.message}`, 502));
    });
    child.once("error", (error) => finish(new BridgeError(`CodeBuddy failed to start: ${error.message}`, 502)));
    child.once("close", (code, signal) => {
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
      });
    });
    child.stdin.end(codeBuddyInput(context.prompt, context.images));
  });
}

function responseMessageItem(id, text, status = "in_progress") {
  return { type: "message", id, status, role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
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

async function handleResponses(request, response) {
  const context = promptFrom(await readJsonRequest(request));
  runtime.requests += 1;
  runtime.lastWorkingDirectory = context.workingDirectory;
  runtime.lastCodexToolCount = context.toolInfo.definitions.length;
  runtime.lastCodexToolSchemaBytes = Buffer.byteLength(jsonString(context.toolInfo.definitions));
  runtime.maxObservedCodexToolCount = Math.max(runtime.maxObservedCodexToolCount, runtime.lastCodexToolCount);
  runtime.maxObservedCodexToolSchemaBytes = Math.max(runtime.maxObservedCodexToolSchemaBytes, runtime.lastCodexToolSchemaBytes);
  let child = null;
  let clientGone = false;
  const abort = () => { clientGone = true; if (child && !child.killed) child.kill(); };
  request.once("aborted", abort);
  response.once("close", () => { if (!response.writableEnded) abort(); });
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive",
  });
  const responseId = `resp_${randomUUID()}`;
  writeSse(response, "response.created", { response: { id: responseId, object: "response", model: context.model, status: "in_progress" } });
  try {
    const result = await runCodeBuddy(context, (spawned) => { child = spawned; });
    if (clientGone) return;
    runtime.completed += 1;
    runtime.lastModel = result.initEvent.model;
    runtime.lastAuthSource = result.initEvent.apiKeySource;
    runtime.lastCostUsd = result.resultEvent.total_cost_usd;
    runtime.lastInputTokens = result.resultEvent.usage?.input_tokens ?? null;
    runtime.lastOutputTokens = result.resultEvent.usage?.output_tokens ?? null;
    runtime.lastDurationApiMs = result.resultEvent.duration_api_ms ?? null;
    runtime.lastMaxTurnInputTokens = result.maxTurnInputTokens;
    runtime.maxObservedTurnInputTokens = Math.max(runtime.maxObservedTurnInputTokens, result.maxTurnInputTokens);
    const output = [];
    let outputIndex = 0;
    if (result.finalText) {
      const itemId = `msg_${randomUUID()}`;
      writeSse(response, "response.output_item.added", { output_index: outputIndex, item: responseMessageItem(itemId, "") });
      writeSse(response, "response.content_part.added", { item_id: itemId, output_index: outputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      writeSse(response, "response.output_text.delta", { item_id: itemId, output_index: outputIndex, content_index: 0, delta: result.finalText });
      writeSse(response, "response.output_text.done", { item_id: itemId, output_index: outputIndex, content_index: 0, text: result.finalText });
      writeSse(response, "response.content_part.done", { item_id: itemId, output_index: outputIndex, content_index: 0, part: { type: "output_text", text: result.finalText, annotations: [] } });
      const item = responseMessageItem(itemId, result.finalText, "completed");
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
          codebuddy_initialized_model: result.initEvent.model,
          codebuddy_auth_source: result.initEvent.apiKeySource,
          codebuddy_total_cost_usd: result.resultEvent.total_cost_usd,
          codex_client_tool_count: context.toolInfo.definitions.length,
          codex_client_tool_schema_bytes: Buffer.byteLength(jsonString(context.toolInfo.definitions)),
          codebuddy_max_turn_input_tokens: result.maxTurnInputTokens,
        },
      },
    });
    response.end();
  } catch (error) {
    if (clientGone) return;
    runtime.failed += 1;
    writeSse(response, "response.failed", {
      response: { id: responseId, object: "response", status: "failed", error: { type: "bridge_error", message: redactSecrets(error.message) } },
    });
    response.end();
  } finally {
    request.removeListener("aborted", abort);
  }
}

function selfTest() {
  const route = resolveRoute(MODEL_ALIAS);
  const context = promptFrom({
    model: MODEL_ALIAS,
    stream: true,
    reasoning: { effort: "max" },
    client_metadata: { cwd: process.cwd() },
    instructions: "<external_cli_route_instructions>bounded role</external_cli_route_instructions>",
    tools: [
      { type: "web_search" },
      { type: "tool_search", execution: "client", description: "Find tools", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      { type: "custom", name: "apply_patch", description: "Apply a patch" },
      { type: "function", name: "exec_command", description: "Run a command", parameters: { type: "object", properties: {} } },
      { type: "function", name: "write_stdin", description: "Continue a command", parameters: { type: "object", properties: {} } },
      { type: "namespace", name: "mcp__rzmcp", tools: [{ type: "function", name: "search_project_index", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }] },
    ],
    input: [
      { type: "compaction", encrypted_content: "opaque" },
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
    ],
  });
  if (context.model !== route.model || !context.prompt.includes("inspect one file") || context.prompt.includes("opaque")) {
    throw new Error("self-test failed: request normalization");
  }
  if (
    context.toolInfo.definitions.length !== 6 ||
    !context.toolInfo.byWire.has("apply_patch") ||
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
    !longPromptArgs.includes("ToolSearch,DeferExecuteTool,WebSearch") ||
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
  validateResult(context, { model: context.model, apiKeySource: REQUIRED_AUTH_SOURCE }, {
    subtype: "success", is_error: false, total_cost_usd: 0, modelUsage: { [context.model]: {} },
  });
  process.stdout.write("codebuddy-subagent-bridge self-test: ok\n");
}

function start() {
  const port = configuredPort();
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        jsonResponse(response, 200, {
          ok: true, provider: PROVIDER_ID, port, modelAlias: MODEL_ALIAS,
          configuredModel: resolveRoute(MODEL_ALIAS).model, effort: REQUIRED_EFFORT,
          inputModalities: resolveRoute(MODEL_ALIAS).inputModalities,
          authSourceRequired: REQUIRED_AUTH_SOURCE, fallbackModel: null,
          explicitCostRequiredUsd: 0, codexManagedLazyTools: true,
          promptTransport: "stream-json-stdin", runtime,
        });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/responses") {
        runtime.incomingRequests += 1;
        await handleResponses(request, response);
        return;
      }
      jsonResponse(response, 404, { error: { type: "not_found", message: "Use GET /health or POST /v1/responses" } });
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
