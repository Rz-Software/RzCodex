#!/usr/bin/env node

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import {
  TaskStateError,
  formatNativeToolProgress,
  isBridgeProgressReasoning,
  normalizeAgentMessageContent,
  rzMcpToolNameFromNativeProgress,
  taskControlPromptSections,
  taskOwnershipHash,
  taskStateFromInput,
} from "./codebuddy-subagent-task-state.mjs";
import { projectInstructionsPromptSection } from "./native-project-instructions.mjs";
import {
  NativeCliAgentError,
  nativeCliAgentContext,
  nativeCliUsage,
  runCommandCodeNativeAgent,
  runOpenCodeNativeAgent,
} from "./native-cli-agent-runner.mjs";

const COMMAND_CODE_PACKAGE_NAME = "command-code";
const MINIMUM_COMMAND_CODE_VERSION = "1.33.0";
const SUPPORTED_COMMAND_CODE_MAJOR = 1;
const COMMAND_CODE_GENERATE_URL = "https://api.commandcode.ai/alpha/generate";
const OPENCODE_RESPONSES_URL = "https://opencode.ai/zen/v1/responses";
const OPENCODE_CHAT_COMPLETIONS_URL = "https://opencode.ai/zen/v1/chat/completions";
const SUBAGENT_MODEL_ALIAS = "@preset/codex-subagents";
const MAIN_AGENT_MODEL_ALIAS = "@preset/rzcodex-main";
const COMMANDCODE_REQUIRED_EFFORT = "max";
const OPENCODE_REQUIRED_EFFORT = "xhigh";
const OPENCODE_AUTH_SOURCE = "OpenCode locally authenticated session";
const MAX_ACTIVE_TASK_CHARS = 40_000;
const NATIVE_DELEGATION_CONTRACT = "[Native delegation contract]\nWork as the bounded native sub-agent in the current workspace. Honor project AGENTS.md ownership boundaries exactly; when builds, tests, editor control, PIE, runtime validation, or RzMCP execution are reserved to the parent, do not invoke them and instead report the exact checks the parent should run. On Windows, use PowerShell-native commands, single-quote ripgrep patterns containing |, and never assume Unix-only commands such as head are installed. Complete only the assigned scope and return a concise result or concrete blocker.";
const MAIN_AGENT_CONTRACT = "[RzCodex main-agent contract]\nAct as the primary coding agent for the conversation. Follow the complete system, developer, project, and user instructions supplied by RzCodex. Use Codex tool calls for investigation and implementation, preserve unrelated work, verify changes in proportion to risk, and return only after the current user request is complete or concretely blocked.";
const SUBAGENT_MODEL_ROUTES_FILE = join(
  process.env.CODEX_HOME || join(homedir(), ".codex"),
  "subagent-models.json",
);
// These routes mirror the current OpenCode Zen endpoint table. Do not route a model to
// Responses merely because its provider metadata is absent or stale: each transport has a
// different request and stream contract.
const OPENCODE_RESPONSES_MODELS = new Set([
  "gpt-5",
  "gpt-5-codex",
  "gpt-5-nano",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.4-pro",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "grok-4.5",
  "grok-4.6",
  "grok-build-0.1",
  "muse-spark-1.2",
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);
const OPENCODE_CHAT_COMPLETIONS_MODELS = new Set([
  "big-pickle",
  "hy3-free",
  "mimo-v2.5-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "x-preview-f-free",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "minimax-m2.5",
  "minimax-m2.7",
  "minimax-m3",
  "glm-5",
  "glm-5.1",
  "glm-5.2",
  "kimi-k2.5",
  "kimi-k2.6",
  "kimi-k2.7-code",
  "kimi-k3",
]);
const OPENCODE_ANTHROPIC_MODELS = new Set([
  "claude-fable-5",
  "claude-haiku-4-5",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-sonnet-4",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "qwen3.5-plus",
  "qwen3.6-plus",
]);
const OPENCODE_GOOGLE_MODELS = new Set([
  "gemini-3-flash",
  "gemini-3.1-pro",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
]);
const DEFAULT_PORT = 54545;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;
const TEXT_TOOL_NAME = "tool_search";
const WIRE_TEXT_TOOL_NAME = "search_tools";
const PROVIDER_OPAQUE_INPUT_TYPES = new Set([
  "compaction",
  "context_compaction",
  "compaction_trigger",
]);
const EXIT_WITH_PARENT_ARGUMENT = "--exit-with-parent";
const PARENT_EXIT_POLL_INTERVAL_MS = 250;
const CURSOR_PROMPT_ARGUMENT_LIMIT = 24_000;
const CURSOR_STDERR_LIMIT = 16 * 1024;
const CURSOR_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
const CURSOR_AGENT_ROOT = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "cursor-agent");
const CURSOR_REQUEST_DIRECTORY = join(
  process.env.CODEX_HOME || join(homedir(), ".codex"),
  "commandcode-bridge",
  "cursor-requests",
);

let commandCodeInstallation;
const cursorRuntime = {
  requests: 0,
  completed: 0,
  failed: 0,
  lastInitializedModel: null,
  lastInputTokens: null,
  lastNativeToolNames: [],
  lastRzMcpTools: [],
  lastWorkingDirectory: null,
};
const retainedCursorChats = new Map();
const cursorTurnTails = new Map();

function cursorStateKey(context) {
  const taskHash = taskOwnershipHash(context.taskState);
  if (context.mainAgent && context.threadId) return `${context.threadId}:main`;
  return context.threadId && taskHash ? `${context.threadId}:${taskHash}` : null;
}

async function acquireCursorTurn(key) {
  if (!key) return () => {};
  const previous = cursorTurnTails.get(key);
  let resolveCurrent;
  const current = new Promise((resolve) => { resolveCurrent = resolve; });
  cursorTurnTails.set(key, current);
  if (previous) await previous;
  return () => {
    if (cursorTurnTails.get(key) === current) cursorTurnTails.delete(key);
    resolveCurrent();
  };
}

function semanticVersion(value, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (!match) throw new Error(`${label} must be a semantic version, got ${JSON.stringify(value)}`);
  return match.slice(1).map(Number);
}

function compareSemanticVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function validateCommandCodeVersion(value) {
  const installed = semanticVersion(value, "CommandCode version");
  const minimum = semanticVersion(MINIMUM_COMMAND_CODE_VERSION, "minimum CommandCode version");
  if (installed[0] !== SUPPORTED_COMMAND_CODE_MAJOR || compareSemanticVersions(installed, minimum) < 0) {
    throw new Error(
      `Unsupported CommandCode version ${value}; this bridge supports ${MINIMUM_COMMAND_CODE_VERSION} through ` +
      `${SUPPORTED_COMMAND_CODE_MAJOR}.x`,
    );
  }
}

function subagentModelRoute(provider) {
  let routes;
  try {
    routes = JSON.parse(readFileSync(SUBAGENT_MODEL_ROUTES_FILE, "utf8"));
  } catch (error) {
    throw new Error(`Subagent model routes are unreadable at ${SUBAGENT_MODEL_ROUTES_FILE}: ${error.message}`);
  }
  if (!routes || typeof routes !== "object" || Array.isArray(routes)) {
    throw new Error(`Subagent model routes at ${SUBAGENT_MODEL_ROUTES_FILE} must be a JSON object`);
  }
  return requireString(routes[provider], `subagent model route ${JSON.stringify(provider)}`);
}

function resolveSubagentModelAlias(model, provider) {
  return model === SUBAGENT_MODEL_ALIAS || model === MAIN_AGENT_MODEL_ALIAS
    ? subagentModelRoute(provider)
    : model;
}

function exitWhenParentStops() {
  if (!process.argv.includes(EXIT_WITH_PARENT_ARGUMENT)) return;

  const parentPid = process.ppid;
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      clearInterval(timer);
      process.exit(0);
    }
  }, PARENT_EXIT_POLL_INTERVAL_MS);
  timer.unref();
}

class BridgeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
  }
}

function packageCandidates() {
  const candidates = [];
  if (process.env.COMMANDCODE_PACKAGE_DIR) {
    candidates.push(process.env.COMMANDCODE_PACKAGE_DIR);
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    candidates.push(join(appData, "npm", "node_modules", COMMAND_CODE_PACKAGE_NAME));
  } else {
    candidates.push(join("/usr", "local", "lib", "node_modules", COMMAND_CODE_PACKAGE_NAME));
    candidates.push(join("/usr", "lib", "node_modules", COMMAND_CODE_PACKAGE_NAME));
  }

  candidates.push(join(homedir(), ".npm-global", "lib", "node_modules", COMMAND_CODE_PACKAGE_NAME));
  return [...new Set(candidates)];
}

function readCommandCodeInstallation() {
  if (commandCodeInstallation) return commandCodeInstallation;

  for (const packageDir of packageCandidates()) {
    const packageJsonPath = join(packageDir, "package.json");
    if (!existsSync(packageJsonPath)) continue;

    let packageJson;
    try {
      packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    } catch (error) {
      throw new Error(`CommandCode package metadata is unreadable at ${packageJsonPath}: ${error.message}`);
    }

    if (packageJson.name !== COMMAND_CODE_PACKAGE_NAME || typeof packageJson.version !== "string") {
      throw new Error(`Invalid CommandCode package metadata at ${packageJsonPath}`);
    }
    validateCommandCodeVersion(packageJson.version);

    commandCodeInstallation = {
      directory: packageDir,
      version: packageJson.version,
    };
    return commandCodeInstallation;
  }

  throw new Error(
    `CommandCode ${MINIMUM_COMMAND_CODE_VERSION} or newer ${SUPPORTED_COMMAND_CODE_MAJOR}.x is not installed; ` +
    `set COMMANDCODE_PACKAGE_DIR or install command-code before starting the bridge`,
  );
}

function configuredPort() {
  const raw = process.env.COMMANDCODE_BRIDGE_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`COMMANDCODE_BRIDGE_PORT must be an integer between 1 and 65535, got ${JSON.stringify(raw)}`);
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`COMMANDCODE_BRIDGE_PORT must be an integer between 1 and 65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

function localDate() {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function workingDirectoryFrom(body) {
  const metadataCwd = body.client_metadata?.cwd;
  if (typeof metadataCwd === "string" && isAbsolute(metadataCwd)) return metadataCwd;

  const candidates = [];
  const visit = (value) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/<cwd>([^<]+)<\/cwd>/gi)) candidates.push(match[1].trim());
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const nested of Object.values(value)) visit(nested);
    }
  };
  visit(body.instructions);
  visit(body.input);
  const taggedCwd = candidates.filter((candidate) => isAbsolute(candidate) && existsSync(candidate)).at(-1);
  if (taggedCwd) return taggedCwd;
  throw new BridgeError("native CLI request has no valid authoritative working directory");
}

function projectSlug(workingDirectory) {
  const slug = basename(workingDirectory)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "root";
}

function sessionIdFrom(body) {
  const cacheKey = typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : "";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cacheKey)) {
    return cacheKey;
  }
  if (!cacheKey) return randomUUID();

  const bytes = createHash("sha256").update(cacheKey).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
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

function toNonNegativeInteger(value, label) {
  if (value === undefined || value === null) return 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new BridgeError(`${label} must be a non-negative integer`, 502);
  }
  return value;
}

function jsonString(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new BridgeError(`Could not encode JSON value: ${error.message}`);
  }
}

function decodeDataUrl(dataUrl, label) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    throw new BridgeError(`${label} must be a data URL; CommandCode does not accept remote image URLs`);
  }

  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) {
    throw new BridgeError(`${label} must be a base64 data URL`);
  }
  return { mimeType: match[1], data: match[2] };
}

function contentArray(value, label) {
  if (typeof value === "string") return [{ type: "input_text", text: value }];
  if (!Array.isArray(value)) throw new BridgeError(`${label} must be a string or array`);
  return value;
}

function translateMessageContent(value, role, label) {
  const content = contentArray(value, label);
  const out = [];
  for (let index = 0; index < content.length; index += 1) {
    const item = assertObject(content[index], `${label}[${index}]`);
    if (item.type === "input_text" || (role === "assistant" && item.type === "output_text")) {
      if (typeof item.text !== "string" || (item.text.length === 0 && role !== "assistant")) {
        throw new BridgeError(`${label}[${index}].text must be a non-empty string`);
      }
      if (item.text.length === 0) continue;
      out.push({ type: "text", text: item.text });
      continue;
    }
    if (item.type === "input_image") {
      if (item.detail !== undefined && item.detail !== "auto") {
        throw new BridgeError(`${label}[${index}].detail is unsupported by the CommandCode wire`);
      }
      const image = decodeDataUrl(item.image_url, `${label}[${index}].image_url`);
      out.push({
        type: "image",
        image: `data:${image.mimeType};base64,${image.data}`,
        mimeType: image.mimeType,
      });
      continue;
    }
    throw new BridgeError(`${label}[${index}] has unsupported content type ${JSON.stringify(item.type)}`);
  }
  return out;
}

function wireToolName(namespace, name) {
  const fullName = namespace
    ? (namespace.endsWith("_") || name.startsWith("_") ? `${namespace}${name}` : `${namespace}__${name}`)
    : name;
  if (fullName.length <= 64) return fullName;
  const suffix = `__${createHash("sha256").update(fullName).digest("hex").slice(0, 12)}`;
  return `${fullName.slice(0, 64 - suffix.length)}${suffix}`;
}

function resolveLocalSchemaReference(root, reference, label) {
  if (!reference.startsWith("#/")) {
    throw new BridgeError(`${label} uses unsupported non-local schema reference ${JSON.stringify(reference)}`);
  }
  let current = root;
  for (const encodedPart of reference.slice(2).split("/")) {
    const part = encodedPart.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || typeof current !== "object" || !(part in current)) {
      throw new BridgeError(`${label} has unresolved schema reference ${JSON.stringify(reference)}`);
    }
    current = current[part];
  }
  return current;
}

function normalizeToolSchema(schema, label) {
  const root = structuredClone(schema);
  const expand = (value, activeReferences) => {
    if (Array.isArray(value)) return value.map((item) => expand(item, activeReferences));
    if (value === null || typeof value !== "object") return value;

    if (typeof value.$ref === "string") {
      const reference = value.$ref;
      if (activeReferences.has(reference)) {
        return {
          type: "object",
          description: "A recursively nested value with the same fields as its parent item.",
        };
      }
      const nextReferences = new Set(activeReferences);
      nextReferences.add(reference);
      const resolved = expand(resolveLocalSchemaReference(root, reference, label), nextReferences);
      const siblings = Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== "$ref")
          .map(([key, nested]) => [key, expand(nested, activeReferences)]),
      );
      return { ...resolved, ...siblings };
    }

    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "$defs" && key !== "definitions")
        .map(([key, nested]) => [key, expand(nested, activeReferences)]),
    );
  };
  return expand(root, new Set());
}

function translateToolDefinition(tool, index) {
  assertObject(tool, `tools[${index}]`);
  // CommandCode accepts client-executed tools only. Codex's hosted web search
  // has no client call/result round-trip for the bridge to execute.
  if (tool.type === "web_search") return [];
  if (tool.type === "tool_search") {
    if (tool.execution !== undefined && tool.execution !== "client") {
      throw new BridgeError(`tools[${index}].execution must be "client"`);
    }
    const parameters = tool.parameters ?? tool.input_schema;
    assertObject(parameters, `tools[${index}].parameters`);
    return [{
      originalName: TEXT_TOOL_NAME,
      namespace: null,
      wireName: WIRE_TEXT_TOOL_NAME,
      custom: false,
      toolSearch: true,
      wire: {
        name: WIRE_TEXT_TOOL_NAME,
        description: typeof tool.description === "string" ? tool.description : "",
        input_schema: normalizeToolSchema(parameters, `tools[${index}].parameters`),
      },
    }];
  }
  if (tool.type === "function") {
    const name = requireString(tool.name, `tools[${index}].name`);
    const parameters = tool.parameters ?? tool.input_schema;
    assertObject(parameters, `tools[${index}].parameters`);
    return [{
      originalName: name,
      namespace: null,
      wireName: name === TEXT_TOOL_NAME ? WIRE_TEXT_TOOL_NAME : wireToolName(null, name),
      custom: false,
      toolSearch: name === TEXT_TOOL_NAME,
      wire: {
        name: name === TEXT_TOOL_NAME ? WIRE_TEXT_TOOL_NAME : name,
        description: typeof tool.description === "string" ? tool.description : "",
        input_schema: normalizeToolSchema(parameters, `tools[${index}].parameters`),
      },
    }];
  }

  if (tool.type === "custom") {
    const name = requireString(tool.name, `tools[${index}].name`);
    if (tool.format !== undefined && (tool.format === null || typeof tool.format !== "object")) {
      throw new BridgeError(`tools[${index}].format must be an object when provided`);
    }
    const description = typeof tool.description === "string" ? tool.description : "";
    return [{
      originalName: name,
      namespace: null,
      wireName: wireToolName(null, name),
      custom: true,
      wire: {
        name,
        description,
        input_schema: {
          type: "object",
          properties: {
            input: {
              type: "string",
              description: "The complete free-form input for this custom tool.",
            },
          },
          required: ["input"],
          additionalProperties: false,
        },
      },
    }];
  }

  if (tool.type === "namespace") {
    const namespace = requireString(tool.name, `tools[${index}].name`);
    if (!Array.isArray(tool.tools) || tool.tools.length === 0) {
      throw new BridgeError(`tools[${index}].tools must be a non-empty array`);
    }
    const namespaceDescription = typeof tool.description === "string" ? tool.description.trim() : "";
    return tool.tools.flatMap((nested, nestedIndex) => {
      const nestedLabel = `tools[${index}].tools[${nestedIndex}]`;
      assertObject(nested, nestedLabel);
      if (nested.type !== "function" && nested.type !== "custom") {
        throw new BridgeError(`${nestedLabel} has unsupported type ${JSON.stringify(nested.type)}`);
      }

      const originalName = requireString(nested.name, `${nestedLabel}.name`);
      const wireName = wireToolName(namespace, originalName);
      const nestedDescription = typeof nested.description === "string" ? nested.description : "";
      const description = [namespaceDescription, nestedDescription].filter(Boolean).join("\n\n");
      if (nested.type === "function") {
        const parameters = nested.parameters ?? nested.input_schema;
        assertObject(parameters, `${nestedLabel}.parameters`);
        return [{
          originalName,
          namespace,
          wireName,
          custom: false,
          wire: { name: wireName, description, input_schema: normalizeToolSchema(parameters, `${nestedLabel}.parameters`) },
        }];
      }
      return [{
        originalName,
        namespace,
        wireName,
        custom: true,
        wire: {
          name: wireName,
          description,
          input_schema: {
            type: "object",
            properties: { input: { type: "string", description: "The complete free-form input for this custom tool." } },
            required: ["input"],
            additionalProperties: false,
          },
        },
      }];
    });
  }

  throw new BridgeError(`tools[${index}] has unsupported type ${JSON.stringify(tool.type)}`);
}

function toolLookupKey(namespace, name) {
  return `${namespace ?? ""}\u0000${name}`;
}

function parseFunctionArguments(value, label) {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
  if (typeof value !== "string") throw new BridgeError(`${label} must be a JSON object or JSON string`);
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new BridgeError(`${label} is not valid JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BridgeError(`${label} must decode to a JSON object`);
  }
  return parsed;
}

function customInput(value, label) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value) && typeof value.input === "string") {
    return value.input;
  }
  throw new BridgeError(`${label} must be a string for a custom tool`);
}

function textOutput(value, label) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw new BridgeError(`${label} must be a string or text content array`);
  let text = "";
  for (let index = 0; index < value.length; index += 1) {
    const item = assertObject(value[index], `${label}[${index}]`);
    if (item.type !== "input_text" && item.type !== "output_text" && item.type !== "text") {
      throw new BridgeError(`${label}[${index}] has unsupported type ${JSON.stringify(item.type)}`);
    }
    if (typeof item.text !== "string") throw new BridgeError(`${label}[${index}].text must be a string`);
    text += item.text;
  }
  return text;
}

function openCodeReasoningSummary(item, label) {
  if (isBridgeProgressReasoning(item)) return "";
  const summary = Array.isArray(item.summary) ? item.summary : [];
  return summary.map((entry, summaryIndex) => {
    const summaryEntry = assertObject(entry, `${label}.summary[${summaryIndex}]`);
    if (summaryEntry.type !== "summary_text") throw new BridgeError(`${label}.summary[${summaryIndex}] has unsupported type ${JSON.stringify(summaryEntry.type)}`);
    return requireString(summaryEntry.text, `${label}.summary[${summaryIndex}].text`);
  }).join("");
}

function portableOpenCodeReasoningItem(item, label) {
  const text = openCodeReasoningSummary(item, label);
  if (!text) return null;
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
}

function normalizeOpenCodeFunctionCallArguments(item, label) {
  const callId = requireString(item.call_id, `${label}.call_id`);
  const name = requireString(item.name, `${label}.name`);
  try {
    item.arguments = jsonString(parseFunctionArguments(item.arguments, `${label}.arguments`));
  } catch {
    throw new BridgeError(
      `${label} function_call ${JSON.stringify(name)} (${JSON.stringify(callId)}) arguments must be valid JSON object`,
    );
  }
}

function appendAssistantContent(messages, content) {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") {
    messages.push({ role: "assistant", content: [] });
  }
  messages[messages.length - 1].content.push(content);
}

function translateResponsesRequest(body) {
  assertObject(body, "request body");
  if (body.stream !== true) {
    throw new BridgeError("The CommandCode bridge only supports stream=true Responses requests");
  }

  const model = resolveSubagentModelAlias(
    requireString(body.model, "model").replace(/^command[-_]?code\//i, ""),
    "commandcode",
  );
  const input = body.input;
  if (input === undefined || input === null) throw new BridgeError("input is required");
  const inputItems = typeof input === "string" ? [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }] : input;
  if (!Array.isArray(inputItems)) throw new BridgeError("input must be a string or array");
  const taskState = taskStateFromInput(inputItems, MAX_ACTIVE_TASK_CHARS);

  const translatedTools = Array.isArray(body.tools)
    ? body.tools.flatMap(translateToolDefinition)
    : [];
  const uniqueWireNames = new Set(translatedTools.map((tool) => tool.wireName));
  if (uniqueWireNames.size !== translatedTools.length) {
    throw new BridgeError("Tool-name translation produced a collision");
  }
  const referencedSchemas = translatedTools
    .filter((tool) => jsonString(tool.wire.input_schema).includes('"$ref"'))
    .map((tool) => tool.wireName);
  if (referencedSchemas.length > 0) {
    throw new BridgeError(`Tool schema normalization left unresolved references: ${referencedSchemas.join(", ")}`);
  }
  const toolsByName = new Map(translatedTools.map((tool) => [toolLookupKey(tool.namespace, tool.originalName), tool]));
  const toolsByWireName = new Map(translatedTools.map((tool) => [tool.wireName, tool]));
  const toolCalls = new Map();
  const messages = [];
  const systemParts = [body.model === MAIN_AGENT_MODEL_ALIAS ? MAIN_AGENT_CONTRACT : NATIVE_DELEGATION_CONTRACT];
  const projectInstructions = projectInstructionsPromptSection(body.client_metadata?.cwd);
  if (projectInstructions) systemParts.push(projectInstructions);
  if (body.instructions !== undefined) systemParts.push(requireString(body.instructions, "instructions"));
  systemParts.push(...taskControlPromptSections(taskState));

  for (let index = 0; index < inputItems.length; index += 1) {
    const item = assertObject(inputItems[index], `input[${index}]`);
    const label = `input[${index}]`;

    if (item.type === "message") {
      const role = requireString(item.role, `${label}.role`);
      if (role === "system" || role === "developer") {
        const content = translateMessageContent(item.content, "developer", `${label}.content`);
        systemParts.push(content.filter((part) => part.type === "text").map((part) => part.text).join(""));
        if (content.some((part) => part.type !== "text")) {
          throw new BridgeError(`${label} system/developer message cannot contain images`);
        }
        continue;
      }
      if (role !== "user" && role !== "assistant") {
        throw new BridgeError(`${label}.role ${JSON.stringify(role)} is unsupported`);
      }
      const content = translateMessageContent(item.content, role, `${label}.content`);
      messages.push({ role, content });
      continue;
    }

    if (item.type === "agent_message") {
      const content = translateMessageContent(item.content, "user", `${label}.content`);
      messages.push({ role: "user", content });
      continue;
    }

    if (item.type === "reasoning") {
      if (isBridgeProgressReasoning(item)) continue;
      const summary = Array.isArray(item.summary) ? item.summary : [];
      const text = summary.map((entry, summaryIndex) => {
        const summaryEntry = assertObject(entry, `${label}.summary[${summaryIndex}]`);
        if (summaryEntry.type !== "summary_text") {
          throw new BridgeError(`${label}.summary[${summaryIndex}] has unsupported type ${JSON.stringify(summaryEntry.type)}`);
        }
        return requireString(summaryEntry.text, `${label}.summary[${summaryIndex}].text`);
      }).join("");
      // Encrypted reasoning is provider-specific and cannot be consumed by CommandCode.
      // Codex still supplies the adjacent tool call and result needed for continuation.
      if (!text && item.encrypted_content !== undefined) continue;
      if (text) appendAssistantContent(messages, { type: "reasoning", text });
      continue;
    }

    if (PROVIDER_OPAQUE_INPUT_TYPES.has(item.type)) {
      // Compaction payloads are encrypted for the provider that created them. CommandCode
      // cannot consume them, while the surrounding portable history remains authoritative.
      continue;
    }

    if (item.type === "function_call") {
      const callId = requireString(item.call_id, `${label}.call_id`);
      const originalName = requireString(item.name, `${label}.name`);
      const namespace = item.namespace === undefined ? null : requireString(item.namespace, `${label}.namespace`);
      const tool = toolsByName.get(toolLookupKey(namespace, originalName)) || toolsByWireName.get(originalName);
      const wireName = tool?.wireName ?? (originalName === TEXT_TOOL_NAME ? WIRE_TEXT_TOOL_NAME : originalName);
      const args = parseFunctionArguments(item.arguments, `${label}.arguments`);
      toolCalls.set(callId, { name: originalName, namespace, wireName, custom: false });
      appendAssistantContent(messages, {
        type: "tool-call",
        toolCallId: callId,
        toolName: wireName,
        input: args,
      });
      continue;
    }

    if (item.type === "tool_search_call") {
      const callId = requireString(item.call_id, `${label}.call_id`);
      const args = assertObject(item.arguments, `${label}.arguments`);
      toolCalls.set(callId, {
        name: TEXT_TOOL_NAME,
        namespace: null,
        wireName: WIRE_TEXT_TOOL_NAME,
        custom: false,
        toolSearch: true,
      });
      appendAssistantContent(messages, {
        type: "tool-call",
        toolCallId: callId,
        toolName: WIRE_TEXT_TOOL_NAME,
        input: args,
      });
      continue;
    }

    if (item.type === "custom_tool_call") {
      const callId = requireString(item.call_id, `${label}.call_id`);
      const originalName = requireString(item.name, `${label}.name`);
      const namespace = item.namespace === undefined ? null : requireString(item.namespace, `${label}.namespace`);
      const tool = toolsByName.get(toolLookupKey(namespace, originalName)) || toolsByWireName.get(originalName);
      if (tool && !tool.custom) throw new BridgeError(`${label} names a function tool but is a custom call`);
      toolCalls.set(callId, { name: originalName, namespace, wireName: tool?.wireName ?? originalName, custom: true });
      appendAssistantContent(messages, {
        type: "tool-call",
        toolCallId: callId,
        toolName: tool?.wireName ?? originalName,
        input: { input: customInput(item.input, `${label}.input`) },
      });
      continue;
    }

    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const callId = requireString(item.call_id, `${label}.call_id`);
      const call = toolCalls.get(callId);
      if (!call) throw new BridgeError(`${label} has no matching prior tool call ${JSON.stringify(callId)}`);
      const isCustom = item.type === "custom_tool_call_output";
      if (isCustom !== call.custom) {
        throw new BridgeError(`${label} kind does not match tool call ${JSON.stringify(callId)}`);
      }
      const output = textOutput(item.output, `${label}.output`);
      messages.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: callId,
          toolName: call.wireName,
          output: { type: "text", value: output },
        }],
      });
      continue;
    }

    if (item.type === "tool_search_output") {
      const callId = requireString(item.call_id, `${label}.call_id`);
      const call = toolCalls.get(callId);
      if (!call?.toolSearch) throw new BridgeError(`${label} has no matching prior tool search call ${JSON.stringify(callId)}`);
      if (!Array.isArray(item.tools)) throw new BridgeError(`${label}.tools must be an array`);
      messages.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: callId,
          toolName: WIRE_TEXT_TOOL_NAME,
          output: { type: "text", value: jsonString({ tools: item.tools }) },
        }],
      });
      continue;
    }

    throw new BridgeError(`${label} has unsupported input type ${JSON.stringify(item.type)}`);
  }

  const maxOutputTokens = body.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new BridgeError("max_output_tokens must be a positive integer");
  }
  if (body.temperature !== undefined && (typeof body.temperature !== "number" || !Number.isFinite(body.temperature))) {
    throw new BridgeError("temperature must be a finite number");
  }

  const params = {
    model,
    messages,
    tools: translatedTools.map((tool) => tool.wire),
    max_tokens: maxOutputTokens,
    stream: true,
  };
  const system = systemParts.filter((part) => part.length > 0).join("\n\n");
  if (system) params.system = system;
  if (body.temperature !== undefined) params.temperature = body.temperature;
  if (body.reasoning?.effort !== undefined && body.reasoning.effort !== "none") {
    params.reasoning_effort = requireString(body.reasoning.effort, "reasoning.effort");
  }

  const workingDirectory = workingDirectoryFrom(body);
  const sessionId = sessionIdFrom(body);

  return {
    upstream: {
      config: {
        workingDir: workingDirectory,
        date: localDate(),
        environment: process.platform === "win32" ? "Windows" : process.platform,
        structure: [],
        isGitRepo: existsSync(join(workingDirectory, ".git")),
        currentBranch: "",
        mainBranch: "",
        gitStatus: "",
        recentCommits: [],
      },
      memory: null,
      taste: null,
      skills: null,
      permissionMode: "standard",
      threadId: sessionId,
      ...(typeof body.mode === "string" ? { mode: body.mode } : {}),
      params,
    },
    context: {
      model,
      projectSlug: projectSlug(workingDirectory),
      sessionId,
      toolsByWireName,
      taskState,
    },
  };
}

function sseEvent(type, payload) {
  return `event: ${type}\ndata: ${jsonString({ type, ...payload })}\n\n`;
}

function writeSse(response, type, payload) {
  if (response.writableEnded || response.destroyed) return false;
  try {
    response.write(sseEvent(type, payload));
    return true;
  } catch {
    return false;
  }
}

function responseMessageItem(id, text, status = "in_progress") {
  return {
    type: "message",
    id,
    role: "assistant",
    status,
    content: [{ type: "output_text", text }],
  };
}

function responseUsage(totalUsage) {
  const usage = totalUsage && typeof totalUsage === "object" ? totalUsage : {};
  const inputTokens = toNonNegativeInteger(usage.inputTokens, "finish.totalUsage.inputTokens");
  const outputTokens = toNonNegativeInteger(usage.outputTokens, "finish.totalUsage.outputTokens");
  const inputDetails = usage.inputTokenDetails && typeof usage.inputTokenDetails === "object"
    ? usage.inputTokenDetails
    : {};
  const outputDetails = usage.outputTokenDetails && typeof usage.outputTokenDetails === "object"
    ? usage.outputTokenDetails
    : {};
  const cachedTokens = toNonNegativeInteger(inputDetails.cacheReadTokens, "finish.totalUsage.inputTokenDetails.cacheReadTokens");
  const reasoningTokens = toNonNegativeInteger(outputDetails.reasoningTokens, "finish.totalUsage.outputTokenDetails.reasoningTokens");
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: cachedTokens },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens: inputTokens + outputTokens,
  };
}

function normalizeUpstreamError(value) {
  if (typeof value === "string" && value) return redactSecrets(value);
  if (value && typeof value === "object") {
    const message = typeof value.message === "string" ? value.message : "CommandCode returned an error";
    return redactSecrets(message);
  }
  return "CommandCode returned an error";
}

function redactSecrets(value) {
  return String(value)
    .replace(/Bearer\s+[^\s,;)}]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-or-v1-|sk-|user_)[A-Za-z0-9_-]{12,}\b/g, "[redacted]");
}

function finishText(response, state) {
  if (!state.textItemId) return;
  state.lastCompletedText = state.text;
  writeSse(response, "response.output_item.done", {
    item: responseMessageItem(state.textItemId, state.text, "completed"),
  });
  state.textItemId = null;
  state.text = "";
}

function finishReasoning(response, state) {
  if (!state.reasoningItemId) return;
  writeSse(response, "response.output_item.done", {
    item: {
      type: "reasoning",
      id: state.reasoningItemId,
      summary: state.reasoningText ? [{ type: "summary_text", text: state.reasoningText }] : [],
    },
  });
  state.reasoningItemId = null;
  state.reasoningText = "";
}

function upstreamToolInput(event, tool) {
  const raw = event.input ?? event.args;
  if (tool?.custom) return customInput(raw, "CommandCode tool-call input");
  return parseFunctionArguments(raw, "CommandCode tool-call input");
}

function emitUpstreamEvent(response, event, state, context) {
  if (!event || typeof event !== "object") throw new BridgeError("CommandCode emitted a non-object NDJSON event", 502);
  const type = event.type;

  if (
    type === "start" ||
    type === "start-step" ||
    type === "text-start" ||
    type === "text-end" ||
    type === "tool-input-start" ||
    type === "tool-input-delta" ||
    type === "tool-input-end" ||
    type === "finish-step" ||
    type === "provider-metadata"
  ) {
    return true;
  }

  if (type === "text-delta") {
    const delta = requireString(event.text ?? "", "CommandCode text-delta.text");
    finishReasoning(response, state);
    if (!state.textItemId) {
      state.textItemId = `msg_${randomUUID()}`;
      state.text = "";
      if (!writeSse(response, "response.output_item.added", { item: responseMessageItem(state.textItemId, "") })) return false;
    }
    state.text += delta;
    return writeSse(response, "response.output_text.delta", {
      item_id: state.textItemId,
      output_index: 0,
      content_index: 0,
      delta,
    });
  }

  if (type === "reasoning-start") {
    finishText(response, state);
    finishReasoning(response, state);
    state.reasoningItemId = `progress_commandcode_${randomUUID()}`;
    state.reasoningText = "";
    return writeSse(response, "response.output_item.added", {
      item: { type: "reasoning", id: state.reasoningItemId, summary: [] },
    });
  }

  if (type === "reasoning-delta") {
    const delta = requireString(event.text ?? "", "CommandCode reasoning-delta.text");
    if (!state.reasoningItemId) {
      state.reasoningItemId = `progress_commandcode_${randomUUID()}`;
      state.reasoningText = "";
      if (!writeSse(response, "response.output_item.added", {
        item: { type: "reasoning", id: state.reasoningItemId, summary: [] },
      })) return false;
    }
    state.reasoningText += delta;
    return writeSse(response, "response.reasoning_summary_text.delta", {
      item_id: state.reasoningItemId,
      output_index: 0,
      summary_index: 0,
      delta,
    });
  }

  if (type === "reasoning-end") {
    finishReasoning(response, state);
    return true;
  }

  if (type === "tool-call") {
    finishText(response, state);
    finishReasoning(response, state);
    const wireName = requireString(event.toolName, "CommandCode tool-call.toolName");
    const tool = context.toolsByWireName.get(wireName);
    const originalName = tool?.originalName ?? (wireName === WIRE_TEXT_TOOL_NAME ? TEXT_TOOL_NAME : wireName);
    const callId = requireString(event.toolCallId, "CommandCode tool-call.toolCallId");
    state.toolCallCount += 1;
    const input = upstreamToolInput(event, tool);
    if (tool?.toolSearch || wireName === WIRE_TEXT_TOOL_NAME) {
      return writeSse(response, "response.output_item.done", {
        item: {
          type: "tool_search_call",
          call_id: callId,
          execution: "client",
          arguments: input,
        },
      });
    }
    if (tool?.custom) {
      return writeSse(response, "response.output_item.done", {
        item: {
          type: "custom_tool_call",
          id: `ct_${callId}`,
          call_id: callId,
          name: originalName,
          ...(tool.namespace ? { namespace: tool.namespace } : {}),
          input,
        },
      });
    }
    return writeSse(response, "response.output_item.done", {
      item: {
        type: "function_call",
        id: `fc_${callId}`,
        call_id: callId,
        name: originalName,
        ...(tool?.namespace ? { namespace: tool.namespace } : {}),
        arguments: jsonString(input),
      },
    });
  }

  if (type === "tool-result") {
    throw new BridgeError("CommandCode executed a tool itself; Codex must retain tool execution control", 502);
  }

  if (type === "finish") {
    finishText(response, state);
    finishReasoning(response, state);
    state.finished = true;
    state.finish = event;
    return true;
  }

  if (type === "error") {
    throw new BridgeError(normalizeUpstreamError(event.error), 502);
  }

  if (type === "abort") {
    throw new BridgeError("CommandCode aborted the generation before completion", 502);
  }

  throw new BridgeError(`Unsupported CommandCode stream event type ${JSON.stringify(type)}`, 502);
}

async function* ndjsonEvents(body) {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw new BridgeError(`CommandCode returned invalid NDJSON: ${error.message}`, 502);
      }
      yield event;
    }
  }
  const tail = pending.trim();
  if (tail) {
    try {
      yield JSON.parse(tail);
    } catch (error) {
      throw new BridgeError(`CommandCode returned invalid trailing NDJSON: ${error.message}`, 502);
    }
  }
}

async function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) {
        reject(new BridgeError(`Request body exceeds ${MAX_REQUEST_BYTES} bytes`, 413));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function readJsonRequest(request) {
  try {
    return JSON.parse(await readRequestBody(request));
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(`Request body is not valid JSON: ${error.message}`);
  }
}

function jsonResponse(response, status, value) {
  if (response.headersSent) return;
  const body = jsonString(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function bearerFrom(request) {
  const value = request.headers.authorization;
  if (typeof value !== "string" || !/^Bearer\s+\S+$/i.test(value)) {
    throw new BridgeError("Authorization: Bearer <CommandCode API key> is required", 401);
  }
  return value;
}

function cursorContentText(value, label) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw new BridgeError(`${label} must be a string or array`);
  return value.map((entry, index) => {
    const item = assertObject(entry, `${label}[${index}]`);
    if (!["input_text", "output_text", "text"].includes(item.type)) {
      throw new BridgeError(`${label}[${index}] has unsupported Cursor content type ${JSON.stringify(item.type)}`);
    }
    return requireString(item.text, `${label}[${index}].text`);
  }).join("");
}

function preserveCursorCommit(error, nativeToolNames, chatId = null) {
  const names = [...new Set(nativeToolNames.filter((name) => typeof name === "string" && name))];
  if (names.length > 0) {
    error.routeCommitted = true;
    error.nativeToolNames = names;
    if (chatId) error.cursorChatId = chatId;
  }
  return error;
}

function cursorResponseErrorCode(error) {
  return error?.routeCommitted === true ? "provider_state_changed" : "external_provider_error";
}

function nativeCliResponseErrorCode(error) {
  return Array.isArray(error?.nativeToolNames) && error.nativeToolNames.length > 0
    ? "provider_state_changed"
    : "external_provider_error";
}

function cursorPromptFrom(body) {
  assertObject(body, "request body");
  if (body.stream !== true) throw new BridgeError("The Cursor bridge only supports stream=true Responses requests");
  const requestedModel = requireString(body.model, "model");
  const mainAgent = requestedModel === MAIN_AGENT_MODEL_ALIAS;
  const model = resolveSubagentModelAlias(requestedModel, "cursor");
  const input = body.input;
  if (input === undefined || input === null) throw new BridgeError("input is required");
  const items = typeof input === "string"
    ? [{ type: "message", role: "user", content: input }]
    : input;
  if (!Array.isArray(items)) throw new BridgeError("input must be a string or array");
  const taskState = taskStateFromInput(items, MAX_ACTIVE_TASK_CHARS);

  const sections = [
    mainAgent ? MAIN_AGENT_CONTRACT : NATIVE_DELEGATION_CONTRACT,
  ];
  const projectInstructions = projectInstructionsPromptSection(body.client_metadata?.cwd);
  if (projectInstructions) sections.push(projectInstructions);
  if (body.instructions !== undefined) {
    const instructions = requireString(body.instructions, "instructions");
    if (mainAgent) {
      sections.push(`[RzCodex instructions]\n${instructions}`);
    } else {
      const tagged = [...instructions.matchAll(/<cursor_route_instructions>([\s\S]*?)<\/cursor_route_instructions>/gi)];
      const roleInstructions = tagged.at(-1)?.[1]?.trim();
      if (roleInstructions) sections.push(`[Cursor role instructions]\n${roleInstructions}`);
    }
  }
  for (let index = 0; index < items.length; index += 1) {
    const item = assertObject(items[index], `input[${index}]`);
    const label = `input[${index}]`;
    if (item.type === "message") {
      const role = requireString(item.role, `${label}.role`);
      if (role === "system" || role === "developer") continue;
      sections.push(`[${role}]\n${cursorContentText(item.content, `${label}.content`)}`);
      continue;
    }
    if (item.type === "agent_message") {
      const author = typeof item.author === "string" ? item.author : "Codex";
      const recipient = typeof item.recipient === "string" ? item.recipient : "Cursor worker";
      const normalized = normalizeAgentMessageContent(item.content, `${label}.content`);
      sections.push(`[Delegated task ${author} -> ${recipient}]\n${normalized.text}`);
      continue;
    }
    if (item.type === "reasoning") {
      if (isBridgeProgressReasoning(item)) continue;
      const summary = Array.isArray(item.summary) ? item.summary.map((entry, summaryIndex) => {
        const part = assertObject(entry, `${label}.summary[${summaryIndex}]`);
        if (part.type !== "summary_text") {
          throw new BridgeError(`${label}.summary[${summaryIndex}] has unsupported type ${JSON.stringify(part.type)}`);
        }
        return requireString(part.text, `${label}.summary[${summaryIndex}].text`);
      }).join("") : "";
      if (summary) sections.push(`[Prior reasoning summary]\n${summary}`);
      continue;
    }
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const name = requireString(item.name, `${label}.name`);
      const payload = item.type === "function_call" ? item.arguments : item.input;
      sections.push(`[Prior tool call ${name}]\n${typeof payload === "string" ? payload : jsonString(payload)}`);
      continue;
    }
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      sections.push(`[Prior tool result ${requireString(item.call_id, `${label}.call_id`)}]\n${textOutput(item.output, `${label}.output`)}`);
      continue;
    }
    if (PROVIDER_OPAQUE_INPUT_TYPES.has(item.type)) continue;
    throw new BridgeError(`${label} has unsupported Cursor input type ${JSON.stringify(item.type)}`);
  }
  sections.push(...taskControlPromptSections(taskState));
  const prompt = sections.filter(Boolean).join("\n\n");
  if (!prompt) throw new BridgeError("Cursor prompt is empty");
  const workingDirectory = workingDirectoryFrom(body);
  if (!isAbsolute(workingDirectory) || !existsSync(workingDirectory)) {
    throw new BridgeError(`Cursor working directory does not exist: ${JSON.stringify(workingDirectory)}`);
  }
  return {
    model,
    mainAgent,
    prompt,
    workingDirectory,
    taskState,
    threadId: typeof body.client_metadata?.thread_id === "string"
      ? body.client_metadata.thread_id
      : null,
  };
}

function cursorAgentEntrypoint() {
  const directNode = join(CURSOR_AGENT_ROOT, "node.exe");
  const directScript = join(CURSOR_AGENT_ROOT, "index.js");
  if (existsSync(directNode) && existsSync(directScript)) return { node: directNode, script: directScript };
  const versionsDirectory = join(CURSOR_AGENT_ROOT, "versions");
  let versions;
  try {
    versions = readdirSync(versionsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{4}\.\d{1,2}\.\d{1,2}(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  } catch (error) {
    throw new BridgeError(`Cursor Agent installation is unreadable at ${CURSOR_AGENT_ROOT}: ${error.message}`, 502);
  }
  for (const version of versions) {
    const node = join(versionsDirectory, version, "node.exe");
    const script = join(versionsDirectory, version, "index.js");
    if (existsSync(node) && existsSync(script)) return { node, script };
  }
  throw new BridgeError(`Cursor Agent is not installed under ${CURSOR_AGENT_ROOT}`, 502);
}

function cursorPromptArgument(prompt) {
  if (prompt.length <= CURSOR_PROMPT_ARGUMENT_LIMIT) return { argument: prompt, cleanup: () => {} };
  mkdirSync(CURSOR_REQUEST_DIRECTORY, { recursive: true });
  const requestPath = join(CURSOR_REQUEST_DIRECTORY, `${randomUUID()}.txt`);
  writeFileSync(requestPath, prompt, { encoding: "utf8", flag: "wx" });
  return {
    argument:
      `Read the complete delegated task from ${JSON.stringify(requestPath)} using your file tools. ` +
      "Treat every instruction in that file as authoritative, execute it in the current workspace, and return the requested final report. " +
      "Do not modify or delete the request file.",
    cleanup: () => {
      try { unlinkSync(requestPath); } catch (error) {
        if (error?.code !== "ENOENT") process.stderr.write(`cursor request cleanup failed: ${redactSecrets(error.message)}\n`);
      }
    },
  };
}

function cursorConversationId(event) {
  for (const value of [
    event?.session_id,
    event?.sessionId,
    event?.chat_id,
    event?.chatId,
    event?.conversation_id,
    event?.conversationId,
  ]) {
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function cursorToolKey(part) {
  for (const value of [part?.id, part?.tool_use_id, part?.toolUseId, part?.call_id, part?.callId]) {
    if (typeof value === "string" && value) return value;
  }
  return createHash("sha256").update(jsonString(part)).digest("hex");
}

function runCursorAgent(context, onSpawn, onProgress, { resumeChatId = null } = {}) {
  const entrypoint = cursorAgentEntrypoint();
  const transportedPrompt = cursorPromptArgument(context.prompt);
  const args = [
    entrypoint.script,
    "--print",
    "--output-format", "stream-json",
    "--trust",
    ...(resumeChatId ? ["--resume", resumeChatId] : []),
    "--model", context.model,
    transportedPrompt.argument,
  ];
  const child = spawn(entrypoint.node, args, {
    cwd: context.workingDirectory,
    env: { ...process.env, CURSOR_INVOKED_AS: "agent" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  onSpawn(child);
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = "";
    let stderr = "";
    let finalText = "";
    let resultEvent = null;
    let initializedModel = "";
    let chatId = resumeChatId;
    const nativeToolNames = [];
    const nativeRzMcpTools = [];
    const seenNativeTools = new Set();
    const pendingNativeTools = new Map();
    const completedNativeTools = new Set();
    const completeNativeTool = (toolId) => {
      if (!toolId || completedNativeTools.has(toolId)) return;
      const tool = pendingNativeTools.get(toolId);
      if (!tool) return;
      pendingNativeTools.delete(toolId);
      completedNativeTools.add(toolId);
      onProgress?.({ id: toolId, ...tool, index: completedNativeTools.size });
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      transportedPrompt.cleanup();
      error ? reject(preserveCursorCommit(error, nativeToolNames, chatId)) : resolve(value);
    };
    const parseLine = (line) => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch {
        stderr = `${stderr}${line}\n`.slice(-CURSOR_STDERR_LIMIT);
        return;
      }
      if (event.type === "system" && event.subtype === "init" && typeof event.model === "string") {
        initializedModel = event.model;
      }
      chatId ||= cursorConversationId(event);
      if (event.type === "assistant" && Array.isArray(event.message?.content)) {
        for (const part of event.message.content) {
          if (part?.type === "tool_use" && typeof part.name === "string" && part.name) {
            const toolKey = cursorToolKey(part);
            if (seenNativeTools.has(toolKey)) continue;
            seenNativeTools.add(toolKey);
            nativeToolNames.push(part.name);
            const rzMcpTool = rzMcpToolNameFromNativeProgress(part.name, part.input);
            if (rzMcpTool) nativeRzMcpTools.push(rzMcpTool);
            pendingNativeTools.set(toolKey, { name: part.name, input: part.input });
          }
        }
        const text = event.message.content
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("");
        if (text) finalText = text;
      }
      if (event.type === "user" && Array.isArray(event.message?.content)) {
        for (const result of event.message.content.filter((part) => part?.type === "tool_result")) {
          completeNativeTool(result.tool_use_id ?? result.toolUseId ?? result.call_id ?? result.callId);
        }
      }
      if (event.type === "tool" || event.type === "tool_result") {
        completeNativeTool(event.tool_use_id ?? event.toolUseId ?? event.call_id ?? event.callId);
      }
      if (event.type === "result") {
        resultEvent = event;
        if (event.subtype === "success" && event.is_error !== true) {
          for (const toolId of [...pendingNativeTools.keys()]) completeNativeTool(toolId);
        }
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new BridgeError(`Cursor Agent exceeded ${CURSOR_REQUEST_TIMEOUT_MS}ms`, 504));
    }, CURSOR_REQUEST_TIMEOUT_MS);
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
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-CURSOR_STDERR_LIMIT); });
    child.once("error", (error) => finish(new BridgeError(`Cursor Agent failed to start: ${error.message}`, 502)));
    child.once("close", (code, signal) => {
      parseLine(stdoutBuffer);
      if (code !== 0) {
        const detail = stderr.trim() ? `: ${redactSecrets(stderr.trim())}` : "";
        finish(new BridgeError(`Cursor Agent exited with ${signal ? `signal ${signal}` : `code ${code}`}${detail}`, 502));
        return;
      }
      if (!resultEvent || resultEvent.is_error === true || resultEvent.subtype !== "success") {
        const detail = resultEvent?.result || stderr || "no successful result event";
        finish(new BridgeError(`Cursor Agent failed: ${redactSecrets(detail)}`, 502));
        return;
      }
      const text = finalText || (typeof resultEvent.result === "string" ? resultEvent.result : "");
      if (!text) {
        finish(new BridgeError("Cursor Agent completed without assistant output", 502));
        return;
      }
      finish(undefined, {
        text,
        usage: resultEvent.usage ?? {},
        initializedModel,
        chatId,
        nativeToolNames: [...new Set(nativeToolNames)],
        nativeRzMcpTools: [...new Set(nativeRzMcpTools)],
      });
    });
  });
}

function cursorUsage(value) {
  const usage = value && typeof value === "object" ? value : {};
  const inputTokens = toNonNegativeInteger(usage.inputTokens, "Cursor usage.inputTokens");
  const outputTokens = toNonNegativeInteger(usage.outputTokens, "Cursor usage.outputTokens");
  const cachedTokens = toNonNegativeInteger(usage.cacheReadTokens, "Cursor usage.cacheReadTokens");
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: cachedTokens },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inputTokens + outputTokens,
  };
}

async function handleCursorResponses(request, response) {
  const context = cursorPromptFrom(await readJsonRequest(request));
  const stateKey = cursorStateKey(context);
  const releaseCursorTurn = await acquireCursorTurn(stateKey);
  const resumeChatId = stateKey ? retainedCursorChats.get(stateKey) || null : null;
  if (stateKey) retainedCursorChats.delete(stateKey);
  cursorRuntime.requests += 1;
  cursorRuntime.lastWorkingDirectory = context.workingDirectory;
  let child = null;
  let clientGone = false;
  const abort = () => {
    clientGone = true;
    if (child && !child.killed) child.kill();
  };
  request.once("aborted", abort);
  response.once("close", () => { if (!response.writableEnded) abort(); });
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const responseId = `resp_${randomUUID()}`;
  if (!writeSse(response, "response.created", {
    response: { id: responseId, object: "response", model: context.model, status: "in_progress" },
  })) {
    releaseCursorTurn();
    return;
  }
  const progress = nativeCliProgressEmitter(response);
  try {
    const result = await runCursorAgent(
      context,
      (spawned) => { child = spawned; },
      ({ name, input, index }) => progress.emit(formatNativeToolProgress("cursor", index, name, input)),
      { resumeChatId },
    );
    if (clientGone) {
      if (stateKey && result.chatId && result.nativeToolNames.length > 0) {
        retainedCursorChats.set(stateKey, result.chatId);
      }
      return;
    }
    if (stateKey) {
      if (context.taskState.checkpointRequested && result.chatId) {
        retainedCursorChats.set(stateKey, result.chatId);
      } else {
        retainedCursorChats.delete(stateKey);
      }
    }
    cursorRuntime.completed += 1;
    cursorRuntime.lastInitializedModel = result.initializedModel || null;
    cursorRuntime.lastInputTokens = Number.isInteger(result.usage?.inputTokens) ? result.usage.inputTokens : null;
    cursorRuntime.lastNativeToolNames = result.nativeToolNames;
    cursorRuntime.lastRzMcpTools = result.nativeRzMcpTools;
    const output = progress.finish();
    const outputIndex = output.length;
    const itemId = `msg_${randomUUID()}`;
    const item = responseMessageItem(itemId, "");
    writeSse(response, "response.output_item.added", { output_index: outputIndex, item });
    writeSse(response, "response.content_part.added", {
      item_id: itemId, output_index: outputIndex, content_index: 0, part: { type: "output_text", text: "" },
    });
    writeSse(response, "response.output_text.delta", {
      item_id: itemId, output_index: outputIndex, content_index: 0, delta: result.text,
    });
    writeSse(response, "response.output_text.done", {
      item_id: itemId, output_index: outputIndex, content_index: 0, text: result.text,
    });
    writeSse(response, "response.content_part.done", {
      item_id: itemId, output_index: outputIndex, content_index: 0, part: { type: "output_text", text: result.text },
    });
    const completedMessage = responseMessageItem(itemId, result.text, "completed");
    writeSse(response, "response.output_item.done", {
      output_index: outputIndex, item: completedMessage,
    });
    output.push(completedMessage);
    writeSse(response, "response.completed", {
      response: {
        id: responseId,
        object: "response",
        model: context.model,
        status: "completed",
        usage: cursorUsage(result.usage),
        output,
        metadata: {
          actual_provider: "cursor",
          actual_model: result.initializedModel || context.model,
          cursor_initialized_model: result.initializedModel,
          cursor_provider_session_resumed: Boolean(resumeChatId),
          native_tool_names: result.nativeToolNames,
          native_tool_count: result.nativeToolNames.length,
          rzmcp_tools_called: result.nativeRzMcpTools,
        },
      },
    });
    response.end();
  } catch (error) {
    if (clientGone) {
      if (stateKey && error?.cursorChatId && Array.isArray(error?.nativeToolNames) && error.nativeToolNames.length > 0) {
        retainedCursorChats.set(stateKey, error.cursorChatId);
      }
      return;
    }
    cursorRuntime.failed += 1;
    writeSse(response, "response.failed", {
      response: {
        id: responseId,
        object: "response",
        status: "failed",
        error: {
          code: cursorResponseErrorCode(error),
          type: "bridge_error",
          message: redactSecrets(error.message),
        },
      },
    });
    response.end();
  } finally {
    request.removeListener("aborted", abort);
    releaseCursorTurn();
  }
}

async function handleLegacyCommandCodeResponses(request, response, parsedBody = null) {
  const authorization = bearerFrom(request);
  const body = parsedBody ?? await readJsonRequest(request);
  const translated = translateResponsesRequest(body);
  const installation = readCommandCodeInstallation();
  const abortController = new AbortController();
  let clientGone = false;
  const abort = () => {
    clientGone = true;
    abortController.abort();
  };
  request.once("aborted", abort);
  response.once("close", () => {
    if (!response.writableEnded) abort();
  });

  let upstream;
  try {
    upstream = await fetch(COMMAND_CODE_GENERATE_URL, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        accept: "application/x-ndjson",
        "user-agent": "cli",
        "x-command-code-version": installation.version,
        "x-cli-environment": "production",
        "x-project-slug": translated.context.projectSlug,
        "x-taste-learning": "false",
        "x-session-id": translated.context.sessionId,
      },
      body: jsonString(translated.upstream),
      signal: abortController.signal,
    });
  } catch (error) {
    if (clientGone || error?.name === "AbortError") return;
    throw new BridgeError(`CommandCode request failed: ${error.message}`, 502);
  }

  if (!upstream.ok) {
    let diagnostic = "";
    try {
      const payload = JSON.parse(await upstream.text());
      const code = typeof payload?.error?.code === "string" ? payload.error.code : "";
      const message = typeof payload?.error?.message === "string" ? payload.error.message : "";
      diagnostic = [code, message].filter(Boolean).join(": ");
    } catch {
      diagnostic = "";
    }
    const detail = diagnostic ? `: ${redactSecrets(diagnostic)}` : "";
    throw new BridgeError(`CommandCode returned HTTP ${upstream.status}${detail}`, upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502);
  }
  if (!upstream.body) throw new BridgeError("CommandCode returned an empty stream", 502);

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const responseId = `resp_${randomUUID()}`;
  if (!writeSse(response, "response.created", {
    response: { id: responseId, object: "response", model: translated.context.model, status: "in_progress" },
  })) return;

  const state = {
    textItemId: null,
    text: "",
    reasoningItemId: null,
    reasoningText: "",
    lastCompletedText: "",
    toolCallCount: 0,
    finished: false,
    finish: null,
  };
  try {
    for await (const event of ndjsonEvents(upstream.body)) {
      if (clientGone) return;
      if (!emitUpstreamEvent(response, event, state, translated.context)) {
        abort();
        return;
      }
    }
    if (!state.finished) throw new BridgeError("CommandCode stream ended without a finish event", 502);
    const finish = state.finish;
    const finishReason = finish.finishReason ?? finish.rawFinishReason;
    const status = finishReason === "length" || finishReason === "max_tokens" ? "incomplete" : "completed";
    const completedResponse = {
      id: responseId,
      object: "response",
      model: translated.context.model,
      status,
      usage: responseUsage(finish.totalUsage),
      ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
    };
    writeSse(response, "response.completed", { response: completedResponse });
    response.end();
  } catch (error) {
    if (clientGone || error?.name === "AbortError") return;
    if (response.headersSent && !response.writableEnded) {
      const message = error instanceof BridgeError ? error.message : `Bridge error: ${error.message}`;
      writeSse(response, "response.failed", {
        response: {
          id: responseId,
          object: "response",
          status: "failed",
          error: { type: "bridge_error", message: redactSecrets(message) },
        },
      });
      response.end();
      return;
    }
    throw error;
  } finally {
    request.removeListener("aborted", abort);
  }
}

function customToolFunctionDefinition(tool, label) {
  const name = requireString(tool.name, `${label}.name`);
  return {
    type: "function",
    name,
    description: typeof tool.description === "string" ? tool.description : "",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        input: { type: "string", description: "The complete free-form input for this custom tool." },
      },
      required: ["input"],
      additionalProperties: false,
    },
  };
}

function addOpenCodeResponseTool(responseTools, namespace, name, custom, label) {
  const providerName = namespace === null ? name : `${namespace}.${name}`;
  const entry = { namespace, originalName: name, providerName, wireName: wireToolName(namespace, name), custom };
  const aliases = new Set([entry.providerName, entry.wireName]);
  for (const alias of aliases) {
    const previous = responseTools.get(alias);
    if (
      previous &&
      (previous.namespace !== entry.namespace || previous.originalName !== entry.originalName || previous.custom !== entry.custom)
    ) {
      throw new BridgeError(
        `${label} response tool alias ${JSON.stringify(alias)} is ambiguous between ` +
        `${JSON.stringify(`${previous.namespace ?? "<top-level>"}.${previous.originalName}`)} and ` +
        `${JSON.stringify(`${entry.namespace ?? "<top-level>"}.${entry.originalName}`)}`,
      );
    }
    if (!previous) responseTools.set(alias, entry);
  }
}

function normalizeOpenCodeToolChoice(value, responseTools) {
  if (value === undefined || value === null || typeof value === "string") return value;
  const choice = assertObject(value, "tool_choice");
  if (choice.type === "custom") choice.type = "function";
  if (choice.type !== "function") return value;
  const target = choice.function === undefined ? choice : assertObject(choice.function, "tool_choice.function");
  const namespace = target.namespace ?? choice.namespace;
  if (namespace === undefined) return value;
  const name = requireString(target.name, "tool_choice.function.name");
  const namespaceName = requireString(namespace, "tool_choice.namespace");
  const entry = responseTools.get(`${namespaceName}.${name}`) || responseTools.get(wireToolName(namespaceName, name));
  if (!entry) throw new BridgeError(`tool_choice references unknown namespaced function ${JSON.stringify(`${namespaceName}.${name}`)}`);
  target.name = entry.providerName;
  delete target.namespace;
  if (target !== choice) delete choice.namespace;
  return value;
}

function openCodeModelId(value) {
  const model = requireString(value, "model").replace(/^opencode\//i, "");
  return resolveSubagentModelAlias(model, "opencode").replace(/^opencode\//i, "");
}

function openCodeTransport(model) {
  const modelId = openCodeModelId(model);
  if (OPENCODE_RESPONSES_MODELS.has(modelId)) return "responses";
  if (OPENCODE_CHAT_COMPLETIONS_MODELS.has(modelId)) return "chat-completions";
  if (OPENCODE_ANTHROPIC_MODELS.has(modelId)) {
    throw new BridgeError(`OpenCode model ${JSON.stringify(modelId)} uses the Anthropic Messages endpoint, which this bridge does not implement`);
  }
  if (OPENCODE_GOOGLE_MODELS.has(modelId)) {
    throw new BridgeError(`OpenCode model ${JSON.stringify(modelId)} uses the Google Generative endpoint, which this bridge does not implement`);
  }
  throw new BridgeError(`OpenCode model ${JSON.stringify(modelId)} has no supported Zen transport`);
}

function normalizeOpenCodeRequest(body) {
  assertObject(body, "request body");
  if (body.stream !== true) throw new BridgeError("The OpenCode bridge only supports stream=true Responses requests");
  const requestedModel = requireString(body.model, "model").replace(/^opencode\//i, "");
  const mainAgent = requestedModel === MAIN_AGENT_MODEL_ALIAS;
  const taskInput = typeof body.input === "string"
    ? [{ type: "message", role: "user", content: body.input }]
    : body.input;
  if (!Array.isArray(taskInput)) throw new BridgeError("input must be a string or array");
  const taskState = taskStateFromInput(taskInput, MAX_ACTIVE_TASK_CHARS);
  body.model = openCodeModelId(requestedModel);
  if (body.reasoning?.summary === "none") delete body.reasoning.summary;
  if (body.reasoning?.effort === "none" || (body.reasoning && Object.keys(body.reasoning).length === 0)) delete body.reasoning;
  const customTools = new Map();
  const responseTools = new Map();

  if (Array.isArray(body.tools)) {
    for (let index = 0; index < body.tools.length; index += 1) {
      const tool = assertObject(body.tools[index], `tools[${index}]`);
      if (tool.type === "function") {
        const name = requireString(tool.name, `tools[${index}].name`);
        addOpenCodeResponseTool(responseTools, null, name, false, `tools[${index}]`);
        const parameters = tool.parameters ?? tool.input_schema;
        assertObject(parameters, `tools[${index}].parameters`);
        const normalized = normalizeToolSchema(parameters, `tools[${index}].parameters`);
        if (tool.parameters !== undefined) tool.parameters = normalized;
        else tool.input_schema = normalized;
        continue;
      }
      if (tool.type === "custom") {
        const converted = customToolFunctionDefinition(tool, `tools[${index}]`);
        addOpenCodeResponseTool(responseTools, null, converted.name, true, `tools[${index}]`);
        customTools.set(toolLookupKey(null, converted.name), { namespace: null, name: converted.name });
        body.tools[index] = converted;
        continue;
      }
      if (tool.type !== "namespace") continue;
      const namespace = requireString(tool.name, `tools[${index}].name`);
      if (!Array.isArray(tool.tools)) throw new BridgeError(`tools[${index}].tools must be an array`);
      for (let nestedIndex = 0; nestedIndex < tool.tools.length; nestedIndex += 1) {
        const nestedLabel = `tools[${index}].tools[${nestedIndex}]`;
        const nested = assertObject(tool.tools[nestedIndex], nestedLabel);
        if (nested.type === "function") {
          const name = requireString(nested.name, `${nestedLabel}.name`);
          addOpenCodeResponseTool(responseTools, namespace, name, false, nestedLabel);
          const parameters = nested.parameters ?? nested.input_schema;
          assertObject(parameters, `${nestedLabel}.parameters`);
          const normalized = normalizeToolSchema(parameters, `${nestedLabel}.parameters`);
          if (nested.parameters !== undefined) nested.parameters = normalized;
          else nested.input_schema = normalized;
          continue;
        }
        if (nested.type === "custom") {
          const converted = customToolFunctionDefinition(nested, nestedLabel);
          addOpenCodeResponseTool(responseTools, namespace, converted.name, true, nestedLabel);
          customTools.set(toolLookupKey(namespace, converted.name), { namespace, name: converted.name });
          tool.tools[nestedIndex] = converted;
        }
      }
    }
  }

  if (Array.isArray(body.input)) {
    const normalizedInput = [];
    const toolOutputsByCallId = new Map();
    for (let index = 0; index < body.input.length; index += 1) {
      const item = body.input[index];
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        normalizedInput.push(item);
        continue;
      }
      if (PROVIDER_OPAQUE_INPUT_TYPES.has(item.type)) continue;
      if (item.type === "reasoning" && (item.id !== undefined || item.encrypted_content !== undefined)) {
        const portableReasoning = portableOpenCodeReasoningItem(item, `input[${index}]`);
        if (portableReasoning) normalizedInput.push(portableReasoning);
        continue;
      }
      if (item.type === "agent_message") {
        normalizedInput.push({ type: "message", role: "user", content: item.content });
        continue;
      }
      const sourceType = item.type;
      if (item.type === "custom_tool_call") {
        item.type = "function_call";
        item.arguments = jsonString({ input: customInput(item.input, "custom_tool_call.input") });
        delete item.input;
      } else if (item.type === "custom_tool_call_output") {
        item.type = "function_call_output";
      }

      if (item.type === "function_call") {
        try {
          normalizeOpenCodeFunctionCallArguments(item, `input[${index}]`);
        } catch (error) {
          if (sourceType !== "function_call") throw error;
          const callId = requireString(item.call_id, `input[${index}].call_id`);
          const name = requireString(item.name, `input[${index}].name`);
          const next = body.input[index + 1];
          if (next && typeof next === "object" && !Array.isArray(next) && next.type === "function_call_output" && next.call_id === callId) {
            const failureOutput = textOutput(next.output, `input[${index + 1}].output`);
            if (failureOutput === `unsupported call: ${name}`) {
              normalizedInput.push({
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: `Tool call ${name} (${callId}) was not executed: ${failureOutput}` }],
              });
              index += 1;
              continue;
            }
          }
          throw error;
        }
      }
      if (item.type === "function_call_output") {
        const callId = requireString(item.call_id, `input[${index}].call_id`);
        const output = textOutput(item.output, `input[${index}].output`);
        const previous = toolOutputsByCallId.get(callId);
        if (previous) {
          if (previous.sourceType !== sourceType) {
            throw new BridgeError(
              `input[${index}] has irreconcilable function_call_output kinds for call_id ${JSON.stringify(callId)}; ` +
              `the first output is input[${previous.index}]`,
            );
          }
          if (!previous.parts.includes(output)) {
            previous.parts.push(output);
            previous.item.output = previous.parts.join("\n");
          }
          continue;
        }
        toolOutputsByCallId.set(callId, { index, item, parts: [output], sourceType });
      }
      normalizedInput.push(item);
    }
    body.input = normalizedInput;
  }
  if (body.tool_choice?.type === "custom") body.tool_choice.type = "function";
  const taskControlSections = taskControlPromptSections(taskState);
  const instructionSections = [
    mainAgent ? MAIN_AGENT_CONTRACT : taskState.activeTask ? NATIVE_DELEGATION_CONTRACT : "",
    mainAgent || taskState.activeTask ? projectInstructionsPromptSection(body.client_metadata?.cwd) : "",
    typeof body.instructions === "string" ? body.instructions : "",
    ...taskControlSections,
  ].filter(Boolean);
  if (instructionSections.length > 0) body.instructions = instructionSections.join("\n\n");
  else delete body.instructions;
  return { body, customTools, responseTools, taskState };
}

const OPENCODE_CHAT_IMAGE_MODELS = new Set([
  "mimo-v2.5-free",
  "x-preview-f-free",
  "kimi-k2.5",
  "kimi-k2.6",
  "kimi-k2.7-code",
  "kimi-k3",
  "minimax-m3",
]);

function openCodeChatContent(value, label, model, role) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw new BridgeError(`${label} must be a string or array`);
  const content = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = assertObject(value[index], `${label}[${index}]`);
    if (item.type === "input_text" || item.type === "output_text" || item.type === "text") {
      if (typeof item.text !== "string" || (item.text.length === 0 && role !== "assistant")) {
        throw new BridgeError(`${label}[${index}].text must be a non-empty string`);
      }
      content.push({ type: "text", text: item.text });
      continue;
    }
    if (item.type === "input_image") {
      if (!OPENCODE_CHAT_IMAGE_MODELS.has(model)) {
        throw new BridgeError(`${label}[${index}] image input is unsupported by OpenCode model ${JSON.stringify(model)}`);
      }
      const imageUrl = requireString(item.image_url, `${label}[${index}].image_url`);
      if (!imageUrl.startsWith("data:") && !/^https?:\/\//i.test(imageUrl)) {
        throw new BridgeError(`${label}[${index}].image_url must be a data or HTTPS URL`);
      }
      if (item.detail !== undefined && !["auto", "low", "high"].includes(item.detail)) {
        throw new BridgeError(`${label}[${index}].detail is unsupported by OpenCode Chat Completions`);
      }
      content.push({
        type: "image_url",
        image_url: { url: imageUrl, ...(item.detail ? { detail: item.detail } : {}) },
      });
      continue;
    }
    throw new BridgeError(`${label}[${index}] has unsupported content type ${JSON.stringify(item.type)}`);
  }
  if (role === "system" || role === "assistant") {
    if (content.some((item) => item.type !== "text")) {
      throw new BridgeError(`${label} ${role} content cannot contain input images`);
    }
    return content.map((item) => item.text).join("");
  }
  return content;
}

function openCodeChatTools(body, customTools) {
  if (body.tools === undefined) {
    return { tools: undefined, byOriginal: new Map(), byWire: new Map(), byUnqualified: new Map() };
  }
  if (!Array.isArray(body.tools)) throw new BridgeError("tools must be an array");

  const tools = [];
  const byOriginal = new Map();
  const byWire = new Map();
  const byUnqualified = new Map();
  const add = (namespace, tool, label) => {
    const name = requireString(tool.name, `${label}.name`);
    const toolSearch = namespace === null && name === TEXT_TOOL_NAME;
    const wireName = toolSearch ? WIRE_TEXT_TOOL_NAME : wireToolName(namespace, name);
    const parameters = tool.parameters ?? tool.input_schema;
    assertObject(parameters, `${label}.parameters`);
    if (byWire.has(wireName)) throw new BridgeError(`Tool-name translation produced a collision for ${JSON.stringify(wireName)}`);
    const custom = customTools.has(toolLookupKey(namespace, name));
    const definition = {
      type: "function",
      function: {
        name: wireName,
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: normalizeToolSchema(parameters, `${label}.parameters`),
        ...(tool.strict !== undefined ? { strict: Boolean(tool.strict) } : {}),
      },
    };
    const entry = { namespace, originalName: name, wireName, custom, toolSearch, definition };
    tools.push(definition);
    byOriginal.set(toolLookupKey(namespace, name), entry);
    byWire.set(wireName, entry);
    const unqualifiedEntries = byUnqualified.get(name) ?? [];
    unqualifiedEntries.push(entry);
    byUnqualified.set(name, unqualifiedEntries);
  };

  for (let index = 0; index < body.tools.length; index += 1) {
    const tool = assertObject(body.tools[index], `tools[${index}]`);
    const label = `tools[${index}]`;
    // Hosted Responses tools have no client-executable equivalent on the Chat Completions endpoint.
    if (tool.type === "web_search") continue;
    if (tool.type === "tool_search") {
      if (tool.execution !== undefined && tool.execution !== "client") {
        throw new BridgeError(`${label}.execution must be "client"`);
      }
      add(null, { ...tool, type: "function", name: TEXT_TOOL_NAME }, label);
      continue;
    }
    if (tool.type === "function" || tool.type === "custom") {
      add(null, tool, label);
      continue;
    }
    if (tool.type !== "namespace") throw new BridgeError(`${label} has unsupported type ${JSON.stringify(tool.type)}`);
    const namespace = requireString(tool.name, `${label}.name`);
    if (!Array.isArray(tool.tools) || tool.tools.length === 0) throw new BridgeError(`${label}.tools must be a non-empty array`);
    for (let nestedIndex = 0; nestedIndex < tool.tools.length; nestedIndex += 1) {
      const nested = assertObject(tool.tools[nestedIndex], `${label}.tools[${nestedIndex}]`);
      if (nested.type !== "function" && nested.type !== "custom") {
        throw new BridgeError(`${label}.tools[${nestedIndex}] has unsupported type ${JSON.stringify(nested.type)}`);
      }
      const description = [tool.description, nested.description].filter((value) => typeof value === "string" && value).join("\n\n");
      add(namespace, { ...nested, ...(description ? { description } : {}) }, `${label}.tools[${nestedIndex}]`);
    }
  }
  return { tools: tools.length > 0 ? tools : undefined, byOriginal, byWire, byUnqualified };
}

function openCodeChatReplayTool(toolInfo, namespace, name, label) {
  if (namespace !== null) {
    const entry = toolInfo.byOriginal.get(toolLookupKey(namespace, name));
    if (entry) return entry;
    const wireEntry = toolInfo.byWire.get(name);
    if (wireEntry?.namespace === namespace) return wireEntry;
    if (wireEntry) {
      throw new BridgeError(
        `${label} function ${JSON.stringify(name)} belongs to namespace ` +
        `${JSON.stringify(wireEntry.namespace ?? "<top-level>")}, not ${JSON.stringify(namespace)}`,
      );
    }

    // Responses history remains valid when a prior tool is not callable this turn.
    // Its namespace and inner name fully determine the flat Chat Completions name.
    const historicalWireName = wireToolName(namespace, name);
    const collision = toolInfo.byWire.get(historicalWireName);
    if (collision) {
      throw new BridgeError(
        `${label} historical function ${JSON.stringify(`${namespace}.${name}`)} collides with current function ` +
        `${JSON.stringify(`${collision.namespace ?? "<top-level>"}.${collision.originalName}`)}`,
      );
    }
    return { namespace, originalName: name, wireName: historicalWireName, custom: false, historical: true };
  }

  const candidates = toolInfo.byUnqualified.get(name) ?? [];
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    const owners = candidates.map((entry) => entry.namespace ?? "<top-level>").join(", ");
    throw new BridgeError(`${label} references ambiguous unqualified function ${JSON.stringify(name)} from: ${owners}`);
  }

  const wireEntry = toolInfo.byWire.get(name);
  if (wireEntry) return wireEntry;

  // Responses history can retain a completed top-level call after deferred
  // tool loading removes that tool from the current request's callable set.
  // Preserve the call for Chat Completions replay without advertising it as
  // callable; response-side validation still rejects any new call to it.
  return {
    namespace: null,
    originalName: name,
    wireName: wireToolName(null, name),
    custom: false,
    historical: true,
  };
}

function openCodeChatToolChoice(value, toolInfo) {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    if (!["auto", "none", "required"].includes(value)) throw new BridgeError(`tool_choice ${JSON.stringify(value)} is unsupported by OpenCode Chat Completions`);
    return value;
  }
  const choice = assertObject(value, "tool_choice");
  if (choice.type !== "function") throw new BridgeError(`tool_choice type ${JSON.stringify(choice.type)} is unsupported by OpenCode Chat Completions`);
  const functionChoice = assertObject(choice.function, "tool_choice.function");
  const name = requireString(functionChoice.name, "tool_choice.function.name");
  const entry = toolInfo.byWire.get(name) || toolInfo.byOriginal.get(toolLookupKey(null, name));
  if (!entry) throw new BridgeError(`tool_choice references unknown function ${JSON.stringify(name)}`);
  return { type: "function", function: { name: entry.wireName } };
}

function openCodeChatRequest(body, customTools) {
  const model = openCodeModelId(body.model);
  const toolInfo = openCodeChatTools(body, customTools);
  const messages = [];
  const toolCalls = new Map();
  const addSystem = (value, label) => {
    const text = openCodeChatContent(value, label, model, "system");
    const existing = messages.find((message) => message.role === "system");
    if (existing) existing.content = `${existing.content}\n\n${text}`;
    else messages.push({ role: "system", content: text });
  };
  if (body.instructions !== undefined) addSystem(requireString(body.instructions, "instructions"), "instructions");

  const input = body.input;
  if (input === undefined || input === null) throw new BridgeError("input is required");
  const inputItems = typeof input === "string" ? [{ type: "message", role: "user", content: input }] : input;
  if (!Array.isArray(inputItems)) throw new BridgeError("input must be a string or array");

  for (let index = 0; index < inputItems.length; index += 1) {
    const item = assertObject(inputItems[index], `input[${index}]`);
    const label = `input[${index}]`;
    if (item.type === "message") {
      const role = requireString(item.role, `${label}.role`);
      if (role === "system" || role === "developer") {
        addSystem(item.content, `${label}.content`);
        continue;
      }
      if (role !== "user" && role !== "assistant") throw new BridgeError(`${label}.role ${JSON.stringify(role)} is unsupported`);
      const content = openCodeChatContent(item.content, `${label}.content`, model, role);
      const previous = messages.at(-1);
      if (
        role === "assistant" &&
        previous?.role === "assistant" &&
        typeof previous.reasoning_content === "string" &&
        previous.content === "" &&
        previous.tool_calls === undefined
      ) {
        previous.content = content;
      } else {
        messages.push({ role, content });
      }
      continue;
    }
    if (item.type === "agent_message") {
      messages.push({ role: "user", content: openCodeChatContent(item.content, `${label}.content`, model, "user") });
      continue;
    }
    if (item.type === "reasoning") {
      const reasoning = openCodeReasoningSummary(item, label);
      if (reasoning) {
        const previous = messages.at(-1);
        if (previous?.role === "assistant" && previous.tool_calls === undefined && previous.content === "") {
          previous.reasoning_content = `${previous.reasoning_content ?? ""}${reasoning}`;
        } else {
          messages.push({ role: "assistant", content: "", reasoning_content: reasoning });
        }
      }
      else if (item.encrypted_content !== undefined && item.encrypted_content !== null) continue;
      continue;
    }
    if (item.type === "function_call") {
      const callId = requireString(item.call_id, `${label}.call_id`);
      const originalName = requireString(item.name, `${label}.name`);
      const namespace = item.namespace === undefined ? null : requireString(item.namespace, `${label}.namespace`);
      const entry = openCodeChatReplayTool(toolInfo, namespace, originalName, label);
      const argumentsText = requireString(item.arguments, `${label}.arguments`);
      parseFunctionArguments(argumentsText, `${label}.arguments`);
      let message = messages.at(-1);
      const canAppendToolCall = message?.role === "assistant" && (message.content === "" || message.content === null);
      if (!canAppendToolCall) {
        message = { role: "assistant", content: null, tool_calls: [] };
        messages.push(message);
      }
      if (message.tool_calls === undefined) message.tool_calls = [];
      if (!Array.isArray(message.tool_calls)) throw new BridgeError(`${label} has invalid assistant tool-call state`);
      if (message.content === "") message.content = null;
      message.tool_calls.push({ id: callId, type: "function", function: { name: entry.wireName, arguments: argumentsText } });
      toolCalls.set(callId, entry);
      continue;
    }
    if (item.type === "tool_search_call") {
      const callId = requireString(item.call_id, `${label}.call_id`);
      const entry = toolInfo.byOriginal.get(toolLookupKey(null, TEXT_TOOL_NAME));
      if (!entry?.toolSearch) throw new BridgeError(`${label} has no current tool_search definition`);
      const argumentsText = jsonString(assertObject(item.arguments, `${label}.arguments`));
      let message = messages.at(-1);
      const canAppendToolCall = message?.role === "assistant" && (message.content === "" || message.content === null);
      if (!canAppendToolCall) {
        message = { role: "assistant", content: null, tool_calls: [] };
        messages.push(message);
      }
      if (message.tool_calls === undefined) message.tool_calls = [];
      message.tool_calls.push({ id: callId, type: "function", function: { name: entry.wireName, arguments: argumentsText } });
      toolCalls.set(callId, entry);
      continue;
    }
    if (item.type === "function_call_output") {
      const callId = requireString(item.call_id, `${label}.call_id`);
      if (!toolCalls.has(callId)) throw new BridgeError(`${label} has no matching prior tool call ${JSON.stringify(callId)}`);
      messages.push({ role: "tool", tool_call_id: callId, content: textOutput(item.output, `${label}.output`) });
      continue;
    }
    if (item.type === "tool_search_output") {
      const callId = requireString(item.call_id, `${label}.call_id`);
      if (!toolCalls.get(callId)?.toolSearch) {
        throw new BridgeError(`${label} has no matching prior tool search call ${JSON.stringify(callId)}`);
      }
      if (!Array.isArray(item.tools)) throw new BridgeError(`${label}.tools must be an array`);
      messages.push({ role: "tool", tool_call_id: callId, content: jsonString({ tools: item.tools }) });
      continue;
    }
    throw new BridgeError(`${label} has unsupported input type ${JSON.stringify(item.type)}`);
  }

  const maxOutputTokens = body.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) throw new BridgeError("max_output_tokens must be a positive integer");
  const request = {
    model,
    messages,
    stream: true,
    max_tokens: maxOutputTokens,
    stream_options: { include_usage: true },
    ...(toolInfo.tools ? { tools: toolInfo.tools } : {}),
  };
  if (body.temperature !== undefined) {
    if (typeof body.temperature !== "number" || !Number.isFinite(body.temperature)) throw new BridgeError("temperature must be a finite number");
    request.temperature = body.temperature;
  }
  if (body.top_p !== undefined) {
    if (typeof body.top_p !== "number" || !Number.isFinite(body.top_p)) throw new BridgeError("top_p must be a finite number");
    request.top_p = body.top_p;
  }
  if (body.reasoning?.effort !== undefined && body.reasoning.effort !== "none") request.reasoning_effort = requireString(body.reasoning.effort, "reasoning.effort");
  const toolChoice = openCodeChatToolChoice(body.tool_choice, toolInfo);
  if (toolChoice !== undefined) request.tool_choice = toolChoice;
  if (body.parallel_tool_calls !== undefined) {
    if (typeof body.parallel_tool_calls !== "boolean") throw new BridgeError("parallel_tool_calls must be boolean");
    request.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (body.text !== undefined) throw new BridgeError("structured text output is unsupported by the OpenCode Chat Completions adapter");
  return { body: request, toolInfo };
}

async function* sseBlocks(body) {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    let separator = /\r?\n\r?\n/.exec(pending);
    while (separator) {
      const end = separator.index + separator[0].length;
      yield pending.slice(0, end);
      pending = pending.slice(end);
      separator = /\r?\n\r?\n/.exec(pending);
    }
  }
  pending += decoder.decode();
  if (pending) yield pending;
}

function customToolForItem(item, customTools) {
  if (!item || item.type !== "function_call" || typeof item.name !== "string") return null;
  const namespace = typeof item.namespace === "string" ? item.namespace : null;
  return customTools.get(toolLookupKey(namespace, item.name)) ?? null;
}

function convertFunctionItemToCustom(item, customTools) {
  const tool = customToolForItem(item, customTools);
  if (!tool) return item;
  const args = parseFunctionArguments(item.arguments, `OpenCode function call ${tool.name} arguments`);
  const converted = {
    ...item,
    type: "custom_tool_call",
    input: customInput(args, `OpenCode function call ${tool.name} input`),
  };
  delete converted.arguments;
  return converted;
}

function validateOpenCodeResponseFunctionCall(item, label) {
  if (!item || item.type !== "function_call") return;
  const callId = requireString(item.call_id, `${label}.call_id`);
  const name = requireString(item.name, `${label}.name`);
  try {
    if (typeof item.arguments !== "string") throw new Error("arguments is not a string");
    parseFunctionArguments(item.arguments, `${label}.arguments`);
  } catch {
    throw new BridgeError(
      `OpenCode returned function_call ${JSON.stringify(name)} (${JSON.stringify(callId)}) with invalid JSON arguments`,
      502,
    );
  }
}

function restoreOpenCodeResponseFunctionItem(item, responseTools, label) {
  if (!item || item.type !== "function_call") return item;
  const providerName = requireString(item.name, `${label}.name`);
  const entry = responseTools?.get(providerName);
  if (!entry) return item;
  const restored = { ...item, name: entry.originalName };
  if (entry.namespace === null) delete restored.namespace;
  else restored.namespace = entry.namespace;
  return restored;
}

function transformOpenCodeSseBlock(block, customTools, suppressedItemIds, responseTools = new Map()) {
  const normalized = block.replace(/\r\n/g, "\n");
  const lines = normalized.trimEnd().split("\n");
  const eventLine = lines.find((line) => line.startsWith("event:"));
  const dataLines = lines.filter((line) => line.startsWith("data:"));
  if (dataLines.length === 0) return block;
  const rawData = dataLines.map((line) => line.slice(5).trimStart()).join("\n");
  if (rawData === "[DONE]") return block;

  let payload;
  try {
    payload = JSON.parse(rawData);
  } catch (error) {
    throw new BridgeError(`OpenCode returned invalid SSE JSON: ${error.message}`, 502);
  }

  if (payload.item?.type === "function_call") {
    payload.item = restoreOpenCodeResponseFunctionItem(payload.item, responseTools, "response.item");
  }
  if (payload.type === "response.output_item.added" && customToolForItem(payload.item, customTools)) {
    if (typeof payload.item.id === "string") suppressedItemIds.add(payload.item.id);
    return null;
  }
  if (
    (payload.type === "response.function_call_arguments.delta" || payload.type === "response.function_call_arguments.done") &&
    suppressedItemIds.has(payload.item_id)
  ) {
    return null;
  }
  if (payload.type === "response.output_item.done") {
    validateOpenCodeResponseFunctionCall(payload.item, "response.output_item.done");
    if (customToolForItem(payload.item, customTools)) {
      if (typeof payload.item.id === "string") suppressedItemIds.delete(payload.item.id);
      payload.item = convertFunctionItemToCustom(payload.item, customTools);
    }
  }
  if (payload.response && Array.isArray(payload.response.output)) {
    payload.response.output = payload.response.output.map((rawItem, index) => {
      const item = restoreOpenCodeResponseFunctionItem(rawItem, responseTools, `response.output[${index}]`);
      validateOpenCodeResponseFunctionCall(item, `response.output[${index}]`);
      return convertFunctionItemToCustom(item, customTools);
    });
  }

  const event = eventLine ? eventLine.slice(6).trim() : payload.type;
  return `event: ${event}\ndata: ${jsonString(payload)}\n\n`;
}

function openCodeChatPayload(block) {
  const normalized = block.replace(/\r\n/g, "\n");
  const dataLines = normalized.trimEnd().split("\n").filter((line) => line.startsWith("data:"));
  if (dataLines.length === 0) return null;
  const rawData = dataLines.map((line) => line.slice(5).trimStart()).join("\n");
  if (rawData === "[DONE]") return "done";
  let payload;
  try {
    payload = JSON.parse(rawData);
  } catch (error) {
    throw new BridgeError(`OpenCode Chat Completions returned invalid SSE JSON: ${error.message}`, 502);
  }
  if (payload?.error) {
    const message = typeof payload.error === "string" ? payload.error : payload.error.message;
    throw new BridgeError(redactSecrets(message || "OpenCode Chat Completions returned an error"), 502);
  }
  return assertObject(payload, "OpenCode Chat Completions SSE payload");
}

function openCodeChatUsage(usage) {
  if (usage === undefined || usage === null) return responseUsage({});
  const value = assertObject(usage, "OpenCode Chat Completions usage");
  const inputTokens = toNonNegativeInteger(value.prompt_tokens, "usage.prompt_tokens");
  const outputTokens = toNonNegativeInteger(value.completion_tokens, "usage.completion_tokens");
  const inputDetails = value.prompt_tokens_details && typeof value.prompt_tokens_details === "object"
    ? value.prompt_tokens_details
    : {};
  const outputDetails = value.completion_tokens_details && typeof value.completion_tokens_details === "object"
    ? value.completion_tokens_details
    : {};
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: toNonNegativeInteger(inputDetails.cached_tokens, "usage.prompt_tokens_details.cached_tokens") },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: toNonNegativeInteger(outputDetails.reasoning_tokens, "usage.completion_tokens_details.reasoning_tokens") },
    total_tokens: toNonNegativeInteger(value.total_tokens, "usage.total_tokens") || inputTokens + outputTokens,
  };
}

function openCodeChatState(responseId, model) {
  return {
    responseId,
    model,
    nextOutputIndex: 0,
    textItem: null,
    reasoningItem: null,
    toolCalls: new Map(),
    completedItems: [],
    finishReason: null,
    usage: null,
    doneSeen: false,
    completed: false,
  };
}

function openCodeChatStoreCompletedItem(state, outputIndex, item) {
  if (state.completedItems[outputIndex] !== undefined) {
    throw new BridgeError(`OpenCode output index ${outputIndex} completed more than once`, 502);
  }
  state.completedItems[outputIndex] = item;
}

function openCodeChatFinishText(state) {
  if (!state.textItem) return [];
  const item = responseMessageItem(state.textItem.id, state.textItem.text, "completed");
  const events = [
    sseEvent("response.output_text.done", {
      item_id: state.textItem.id,
      output_index: state.textItem.outputIndex,
      content_index: 0,
      text: state.textItem.text,
    }),
    sseEvent("response.content_part.done", {
      item_id: state.textItem.id,
      output_index: state.textItem.outputIndex,
      content_index: 0,
      part: { type: "output_text", text: state.textItem.text },
    }),
    sseEvent("response.output_item.done", { output_index: state.textItem.outputIndex, item }),
  ];
  openCodeChatStoreCompletedItem(state, state.textItem.outputIndex, item);
  state.textItem = null;
  return events;
}

function openCodeChatFinishReasoning(state) {
  if (!state.reasoningItem) return [];
  const item = {
    type: "reasoning",
    id: state.reasoningItem.id,
    status: "completed",
    summary: state.reasoningItem.text ? [{ type: "summary_text", text: state.reasoningItem.text }] : [],
  };
  const events = [
    sseEvent("response.reasoning_summary_text.done", {
      item_id: state.reasoningItem.id,
      output_index: state.reasoningItem.outputIndex,
      summary_index: 0,
      text: state.reasoningItem.text,
    }),
    sseEvent("response.output_item.done", { output_index: state.reasoningItem.outputIndex, item }),
  ];
  openCodeChatStoreCompletedItem(state, state.reasoningItem.outputIndex, item);
  state.reasoningItem = null;
  return events;
}

function openCodeChatFinishActiveNarrative(state) {
  const activeItems = [
    state.reasoningItem ? { outputIndex: state.reasoningItem.outputIndex, finish: openCodeChatFinishReasoning } : null,
    state.textItem ? { outputIndex: state.textItem.outputIndex, finish: openCodeChatFinishText } : null,
  ].filter(Boolean).sort((left, right) => left.outputIndex - right.outputIndex);
  return activeItems.flatMap((active) => active.finish(state));
}

function openCodeChatToolItem(state, call, toolInfo) {
  const entry = toolInfo.byWire.get(call.name);
  if (!entry) throw new BridgeError(`OpenCode returned an unknown tool call ${JSON.stringify(call.name)}`, 502);
  const argumentsObject = parseFunctionArguments(call.arguments, `OpenCode tool call ${call.name} arguments`);
  if (entry.toolSearch) {
    return {
      type: "tool_search_call",
      call_id: call.callId,
      execution: "client",
      arguments: argumentsObject,
    };
  }
  if (entry.custom) {
    const item = {
      type: "custom_tool_call",
      id: `ct_${call.callId}`,
      call_id: call.callId,
      name: entry.originalName,
      ...(entry.namespace ? { namespace: entry.namespace } : {}),
      input: customInput(argumentsObject, `OpenCode custom tool call ${entry.originalName} input`),
    };
    return item;
  }
  return {
    type: "function_call",
    id: `fc_${call.callId}`,
    call_id: call.callId,
    name: entry.originalName,
    ...(entry.namespace ? { namespace: entry.namespace } : {}),
    arguments: jsonString(argumentsObject),
  };
}

function openCodeChatFinishTools(state, toolInfo) {
  const events = [];
  for (const call of state.toolCalls.values()) {
    if (call.finished) continue;
    const item = openCodeChatToolItem(state, call, toolInfo);
    call.finished = true;
    openCodeChatStoreCompletedItem(state, call.outputIndex, item);
    events.push(sseEvent("response.output_item.done", { output_index: call.outputIndex, item }));
  }
  return events;
}

function openCodeChatComplete(state) {
  if (state.completed) return "";
  if (!state.doneSeen) throw new BridgeError("OpenCode Chat Completions stream ended without [DONE]", 502);
  const output = [];
  for (let outputIndex = 0; outputIndex < state.nextOutputIndex; outputIndex += 1) {
    const item = state.completedItems[outputIndex];
    if (item === undefined) throw new BridgeError(`OpenCode output index ${outputIndex} did not complete`, 502);
    output.push(item);
  }
  const finishReason = state.finishReason;
  const status = finishReason === "length" || finishReason === "max_tokens" ? "incomplete" : "completed";
  const response = {
    id: state.responseId,
    object: "response",
    model: state.model,
    status,
    output,
    usage: state.usage || responseUsage({}),
    ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
  };
  state.completed = true;
  return sseEvent("response.completed", { response });
}

function transformOpenCodeChatSseBlock(block, state, toolInfo) {
  const payload = openCodeChatPayload(block);
  if (payload === null) return "";
  if (payload === "done") {
    const events = [
      ...openCodeChatFinishActiveNarrative(state),
      ...openCodeChatFinishTools(state, toolInfo),
    ];
    state.doneSeen = true;
    return events.join("") + openCodeChatComplete(state);
  }
  if (state.doneSeen) return "";
  const events = [];
  const ensureReasoningItem = () => {
    if (!state.reasoningItem) return;
    if (state.reasoningItem.added) return;
    state.reasoningItem.added = true;
    events.push(sseEvent("response.output_item.added", {
      output_index: state.reasoningItem.outputIndex,
      item: { type: "reasoning", id: state.reasoningItem.id, status: "in_progress", summary: [] },
    }));
  };
  const ensureTextItem = () => {
    if (!state.textItem) return;
    if (state.textItem.added) return;
    state.textItem.added = true;
    events.push(
      sseEvent("response.output_item.added", { output_index: state.textItem.outputIndex, item: responseMessageItem(state.textItem.id, "") }),
      sseEvent("response.content_part.added", {
        item_id: state.textItem.id,
        output_index: state.textItem.outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "" },
      }),
    );
  };
  if (Array.isArray(payload.choices)) {
    for (let choiceIndex = 0; choiceIndex < payload.choices.length; choiceIndex += 1) {
      const choice = assertObject(payload.choices[choiceIndex], `choices[${choiceIndex}]`);
      const delta = choice.delta === undefined ? {} : assertObject(choice.delta, `choices[${choiceIndex}].delta`);
      if (delta.reasoning_content !== undefined || delta.reasoning !== undefined) {
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning !== "string") throw new BridgeError(`choices[${choiceIndex}].delta reasoning must be a string`, 502);
        if (reasoning.length > 0) {
          if (state.textItem) events.push(...openCodeChatFinishText(state));
          if (!state.reasoningItem) {
            state.reasoningItem = {
              id: `progress_commandcode_${randomUUID()}`,
              outputIndex: state.nextOutputIndex++,
              text: "",
            };
          }
          ensureReasoningItem();
          state.reasoningItem.text += reasoning;
          events.push(sseEvent("response.reasoning_summary_text.delta", {
            item_id: state.reasoningItem.id,
            output_index: state.reasoningItem.outputIndex,
            summary_index: 0,
            delta: reasoning,
          }));
        }
      }
      if (delta.content !== undefined && delta.content !== null) {
        if (typeof delta.content !== "string") throw new BridgeError(`choices[${choiceIndex}].delta.content must be a string`, 502);
        if (delta.content.length > 0) {
          if (state.reasoningItem) events.push(...openCodeChatFinishReasoning(state));
          if (!state.textItem) {
            state.textItem = { id: `msg_${randomUUID()}`, outputIndex: state.nextOutputIndex++, text: "" };
          }
          ensureTextItem();
          state.textItem.text += delta.content;
          events.push(sseEvent("response.output_text.delta", {
            item_id: state.textItem.id,
            output_index: state.textItem.outputIndex,
            content_index: 0,
            delta: delta.content,
          }));
        }
      }
      const toolCallDeltas = delta.tool_calls;
      if (toolCallDeltas !== undefined) {
        if (!Array.isArray(toolCallDeltas)) throw new BridgeError(`choices[${choiceIndex}].delta.tool_calls must be an array`, 502);
        if (toolCallDeltas.length > 0) events.push(...openCodeChatFinishActiveNarrative(state));
        for (let toolIndex = 0; toolIndex < toolCallDeltas.length; toolIndex += 1) {
          const part = assertObject(toolCallDeltas[toolIndex], `choices[${choiceIndex}].delta.tool_calls[${toolIndex}]`);
          if (!Number.isInteger(part.index) || part.index < 0) throw new BridgeError("OpenCode tool call index must be a non-negative integer", 502);
          const call = state.toolCalls.get(part.index) || {
            index: part.index,
            callId: typeof part.id === "string" && part.id ? part.id : `call_${randomUUID()}`,
            name: "",
            arguments: "",
            outputIndex: state.nextOutputIndex++,
            finished: false,
          };
          if (part.id !== undefined) call.callId = requireString(part.id, "OpenCode tool call id");
          if (part.type !== undefined && part.type !== "function") throw new BridgeError(`OpenCode tool call type ${JSON.stringify(part.type)} is unsupported`, 502);
          if (part.function !== undefined) {
            const functionPart = assertObject(part.function, "OpenCode tool call function");
            if (functionPart.name !== undefined) call.name = requireString(functionPart.name, "OpenCode tool call function.name");
            if (functionPart.arguments !== undefined) {
              if (typeof functionPart.arguments !== "string") throw new BridgeError("OpenCode tool call function.arguments must be a string", 502);
              call.arguments += functionPart.arguments;
            }
          }
          if (call.name && !call.added) {
            const entry = toolInfo.byWire.get(call.name);
            if (!entry) throw new BridgeError(`OpenCode returned an unknown tool call ${JSON.stringify(call.name)}`, 502);
            call.added = true;
            events.push(sseEvent("response.output_item.added", {
              output_index: call.outputIndex,
              item: entry.custom
                ? { type: "custom_tool_call", id: `ct_${call.callId}`, call_id: call.callId, name: entry.originalName, ...(entry.namespace ? { namespace: entry.namespace } : {}), input: "", status: "in_progress" }
                : { type: "function_call", id: `fc_${call.callId}`, call_id: call.callId, name: entry.originalName, ...(entry.namespace ? { namespace: entry.namespace } : {}), arguments: "", status: "in_progress" },
            }));
          }
          state.toolCalls.set(part.index, call);
        }
      }
      if (delta.function_call !== undefined) {
        events.push(...openCodeChatFinishActiveNarrative(state));
        const functionCall = assertObject(delta.function_call, `choices[${choiceIndex}].delta.function_call`);
        const call = state.toolCalls.get(0) || {
          index: 0,
          callId: `call_${randomUUID()}`,
          name: "",
          arguments: "",
          outputIndex: state.nextOutputIndex++,
          finished: false,
        };
        if (functionCall.name !== undefined) call.name = requireString(functionCall.name, "OpenCode function_call.name");
        if (functionCall.arguments !== undefined) {
          if (typeof functionCall.arguments !== "string") throw new BridgeError("OpenCode function_call.arguments must be a string", 502);
          call.arguments += functionCall.arguments;
        }
        if (call.name && !call.added) {
          const entry = toolInfo.byWire.get(call.name);
          if (!entry) throw new BridgeError(`OpenCode returned an unknown tool call ${JSON.stringify(call.name)}`, 502);
          call.added = true;
          events.push(sseEvent("response.output_item.added", {
            output_index: call.outputIndex,
            item: entry.custom
              ? { type: "custom_tool_call", id: `ct_${call.callId}`, call_id: call.callId, name: entry.originalName, ...(entry.namespace ? { namespace: entry.namespace } : {}), input: "", status: "in_progress" }
              : { type: "function_call", id: `fc_${call.callId}`, call_id: call.callId, name: entry.originalName, ...(entry.namespace ? { namespace: entry.namespace } : {}), arguments: "", status: "in_progress" },
          }));
        }
        state.toolCalls.set(0, call);
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        state.finishReason = requireString(choice.finish_reason, `choices[${choiceIndex}].finish_reason`);
      }
    }
  } else if (payload.choices !== undefined) {
    throw new BridgeError("OpenCode Chat Completions choices must be an array", 502);
  }
  if (payload.usage !== undefined) state.usage = openCodeChatUsage(payload.usage);
  if (payload.choices === undefined && payload.usage === undefined && payload.cost === undefined) {
    throw new BridgeError("OpenCode Chat Completions emitted an unsupported SSE payload", 502);
  }

  if (state.finishReason) {
    events.push(...openCodeChatFinishActiveNarrative(state));
    events.push(...openCodeChatFinishTools(state, toolInfo));
  }
  ensureTextItem();
  ensureReasoningItem();
  return events.join("");
}

async function handleLegacyOpenCodeResponses(request, response, parsedBody = null) {
  const authorization = bearerFrom(request);
  const translated = normalizeOpenCodeRequest(parsedBody ?? await readJsonRequest(request));
  const taskState = translated.taskState;
  const transport = openCodeTransport(translated.body.model);
  const chatRequest = transport === "chat-completions"
    ? openCodeChatRequest(translated.body, translated.customTools)
    : null;
  const upstreamUrl = transport === "chat-completions" ? OPENCODE_CHAT_COMPLETIONS_URL : OPENCODE_RESPONSES_URL;
  const upstreamBody = chatRequest?.body ?? translated.body;
  const abortController = new AbortController();
  let clientGone = false;
  let responseId = null;
  const abort = () => {
    clientGone = true;
    abortController.abort();
  };
  request.once("aborted", abort);
  response.once("close", () => {
    if (!response.writableEnded) abort();
  });

  try {
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: jsonString(upstreamBody),
      signal: abortController.signal,
    });
    if (clientGone) return;

    if (!upstream.ok) {
      const contentType = upstream.headers.get("content-type") || "application/json; charset=utf-8";
      const errorBody = redactSecrets(await upstream.text());
      response.writeHead(upstream.status, { "content-type": contentType });
      response.end(errorBody);
      return;
    }
    if (!upstream.body) throw new BridgeError("OpenCode returned an empty stream", 502);

    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    if (transport === "chat-completions") {
      responseId = `resp_${randomUUID()}`;
      if (!writeSse(response, "response.created", {
        response: { id: responseId, object: "response", model: translated.body.model, status: "in_progress" },
      })) return;
      const state = openCodeChatState(responseId, translated.body.model);
      for await (const block of sseBlocks(upstream.body)) {
        if (clientGone) return;
        const transformed = transformOpenCodeChatSseBlock(block, state, chatRequest.toolInfo);
        if (!transformed) continue;
        if (!response.write(transformed)) await new Promise((resolve) => response.once("drain", resolve));
      }
      if (!state.completed) throw new BridgeError("OpenCode Chat Completions stream ended without a completed response", 502);
      response.end();
      return;
    }

    responseId = `resp_${randomUUID()}`;
    const suppressedItemIds = new Set();
    for await (const block of sseBlocks(upstream.body)) {
      if (clientGone) return;
      const payload = openCodeChatPayload(block);
      const transformed = transformOpenCodeSseBlock(block, translated.customTools, suppressedItemIds, translated.responseTools);
      if (transformed === null) continue;
      if (!response.write(transformed)) {
        await new Promise((resolve) => response.once("drain", resolve));
      }
    }
    response.end();
  } catch (error) {
    if (clientGone || error?.name === "AbortError") return;
    abortController.abort();
    if (response.headersSent && !response.writableEnded && responseId) {
      writeSse(response, "response.failed", {
        response: {
          id: responseId,
          object: "response",
          model: translated.body.model,
          status: "failed",
          error: { type: "bridge_error", message: redactSecrets(error instanceof BridgeError ? error.message : `Bridge error: ${error.message}`) },
        },
      });
      response.end();
      return;
    }
    throw error;
  } finally {
    request.removeListener("aborted", abort);
  }
}

function nativeCliProgressEmitter(response) {
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

function nativeCliToolEvent(event, state) {
  if (event?.type === "tool_use" && event.part?.state?.status === "completed") {
    return {
      id: event.part.callID || event.part.id,
      name: event.part.tool,
      input: event.part.state.input,
    };
  }
  const payload = event?.type === "event" ? event.event : null;
  if (payload?.type === "tool_completed") {
    return {
      id: payload.toolCallId,
      name: payload.toolName,
      input: payload.toolInput
        ?? payload.input
        ?? payload.arguments
        ?? (state?.lastCompletedToolCallId === payload.toolCallId
          ? state.lastCompletedToolInput
          : undefined),
    };
  }
  return null;
}

async function handleNativeCliResponses(request, response, provider, parsedBody = null) {
  const body = parsedBody ?? await readJsonRequest(request);
  const commandCode = provider === "commandcode";
  const requiredEffort = commandCode ? COMMANDCODE_REQUIRED_EFFORT : OPENCODE_REQUIRED_EFFORT;
  const model = resolveSubagentModelAlias(body.model, provider);
  let context;
  try {
    context = nativeCliAgentContext(body, { provider, model, requiredEffort });
  } catch (error) {
    if (error instanceof NativeCliAgentError) throw new BridgeError(error.message, error.status);
    throw error;
  }
  const abortController = new AbortController();
  let clientGone = false;
  const abort = () => {
    clientGone = true;
    abortController.abort();
  };
  request.once("aborted", abort);
  response.once("close", () => {
    if (!response.writableEnded) abort();
  });
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const responseId = `resp_${randomUUID()}`;
  writeSse(response, "response.created", {
    response: { id: responseId, object: "response", model: body.model, status: "in_progress" },
  });
  const progress = nativeCliProgressEmitter(response);
  const announcedTools = new Set();
  let lastHeartbeatAt = 0;
  const onEvent = (event, state) => {
    const now = Date.now();
    if (now - lastHeartbeatAt >= 5_000) {
      lastHeartbeatAt = now;
      writeSse(response, "response.in_progress", {
        response: { id: responseId, object: "response", model: body.model, status: "in_progress" },
      });
    }
    const tool = nativeCliToolEvent(event, state);
    if (!tool?.name) return;
    const key = tool.id || `${tool.name}:${announcedTools.size}`;
    if (announcedTools.has(key)) return;
    announcedTools.add(key);
    progress.emit(formatNativeToolProgress(provider, announcedTools.size, tool.name, tool.input));
  };
  try {
    const result = commandCode
      ? await runCommandCodeNativeAgent(context, { signal: abortController.signal, onEvent })
      : await runOpenCodeNativeAgent(context, {
          providerKind: "opencode",
          signal: abortController.signal,
          onEvent,
          onRecovery: () => progress.emit("opencode resumed the same retained native session after a missing terminal response.\n"),
        });
    if (clientGone) return;
    const output = [];
    const progressItems = progress.finish();
    output.push(...progressItems);
    const outputIndex = output.length;
    const itemId = `msg_${randomUUID()}`;
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
      delta: result.finalText,
    });
    writeSse(response, "response.output_text.done", {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      text: result.finalText,
    });
    writeSse(response, "response.content_part.done", {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: result.finalText, annotations: [] },
    });
    const message = responseMessageItem(itemId, result.finalText, "completed");
    writeSse(response, "response.output_item.done", { output_index: outputIndex, item: message });
    output.push(message);
    writeSse(response, "response.completed", {
      response: {
        id: responseId,
        object: "response",
        model: body.model,
        status: "completed",
        usage: nativeCliUsage(result),
        output,
        metadata: {
          actual_provider: provider,
          actual_model: result.model,
          actual_reasoning_effort: result.actualReasoningEffort || requiredEffort,
          ...(provider === "opencode" ? { auth_source: OPENCODE_AUTH_SOURCE } : {}),
          native_cli_single_execution: result.executionCount === 1,
          native_cli_execution_count: result.executionCount,
          native_cli_same_session_continuations: result.sameSessionContinuations,
          native_cli_resumed_provider_session: result.resumedProviderSession === true,
          native_tool_names: result.toolNames,
          native_tool_count: result.toolNames.length,
          rzmcp_tools_called: [...new Set(result.rzMcpTools || [])],
          provider_mutation_count: result.mutationCount,
          peak_turn_context_tokens: result.peakTurnInputTokens,
          normalized_prompt_chars: context.prompt.length,
          codex_tool_schema_bytes_forwarded: 0,
          codex_tool_schema_bytes_ignored: context.toolSchemaBytesIgnored,
          lazy_rzmcp_proxy_tools: commandCode || context.executionPolicy.rzMcpMode !== "disabled" ? 2 : 0,
          complete_active_task_delivered: context.taskDiagnostics.completeTaskDelivered,
          active_task_hash: context.taskDiagnostics.taskHash,
        },
      },
    });
    response.end();
  } catch (error) {
    if (clientGone || error?.status === 499) return;
    const message = redactSecrets(error.message || String(error));
    writeSse(response, "response.failed", {
      response: {
        id: responseId,
        object: "response",
        model: body.model,
        status: "failed",
        error: {
          code: nativeCliResponseErrorCode(error),
          type: "bridge_error",
          message,
        },
      },
    });
    response.end();
  } finally {
    request.removeListener("aborted", abort);
  }
}

async function handleResponses(request, response) {
  const body = await readJsonRequest(request);
  return body.model === SUBAGENT_MODEL_ALIAS
    ? handleNativeCliResponses(request, response, "commandcode", body)
    : handleLegacyCommandCodeResponses(request, response, body);
}

async function handleOpenCodeResponses(request, response) {
  const body = await readJsonRequest(request);
  return body.model === SUBAGENT_MODEL_ALIAS
    ? handleNativeCliResponses(request, response, "opencode", body)
    : handleLegacyOpenCodeResponses(request, response, body);
}

function selfTest() {
  readCommandCodeInstallation();
  if (
    nativeCliToolEvent({ type: "event", event: { type: "tool_running", toolCallId: "call-1", toolName: "read" } }) !== null
    || nativeCliToolEvent({ type: "event", event: { type: "tool_completed", toolCallId: "call-1", toolName: "read" } })?.name !== "read"
  ) {
    throw new Error("self-test failed: CommandCode progress boundary must follow tool completion");
  }
  if (
    nativeCliResponseErrorCode({ nativeToolNames: ["read"] }) !== "provider_state_changed"
    || nativeCliResponseErrorCode({ nativeToolNames: [] }) !== "external_provider_error"
    || cursorResponseErrorCode(preserveCursorCommit(new BridgeError("fixture"), ["read_file"]))
      !== "provider_state_changed"
  ) {
    throw new Error("self-test failed: native CLI read-only provider work was eligible for replay");
  }
  const cursorTaskPayload = "Message Type: NEW_TASK\nTask name: /root/worker\nPayload:\nInspect the bounded active Cursor task.";
  const cursorTask = cursorPromptFrom({
    model: "cursor/test-model",
    input: [
      { type: "compaction", encrypted_content: "provider-opaque" },
      {
        type: "agent_message",
        author: "/root",
        recipient: "/root/worker",
        content: [
          { type: "input_text", text: "[inter-agent header]\n" },
          { type: "encrypted_content", encrypted_content: cursorTaskPayload },
        ],
      },
    ],
    stream: true,
    client_metadata: { cwd: homedir() },
  });
  if (
    cursorTask.prompt.split(cursorTaskPayload).length !== 2
    || cursorTask.prompt.includes("provider-opaque")
    || cursorTask.workingDirectory !== homedir()
  ) {
    throw new Error("self-test failed: Cursor encrypted task and compaction portability");
  }
  const analysisTaskText = "Message Type: NEW_TASK\nTask name: /root/worker\nPayload:\nInspect the bounded evidence and report only when complete.";
  const immediateTaskText = "Message Type: NEW_TASK\nTask name: /root/worker\nPayload:\nReturn your current implementation verdict immediately. Do not investigate further.";
  const taskItem = (text) => ({
    type: "agent_message",
    id: `task-${text.length}`,
    author: "/root",
    recipient: "/root/worker",
    content: [{ type: "input_text", text }],
  });
  const nativeTaskPayload = "Message Type: NEW_TASK\nTask name: /root/native-cli-fixture\nPayload:\nRead the bounded fixture and report exactly once.";
  const nativeContext = nativeCliAgentContext({
    model: "@preset/codex-subagents",
    reasoning: { effort: COMMANDCODE_REQUIRED_EFFORT },
    stream: true,
    instructions: "<external_cli_route_instructions>Act as the bounded builder.</external_cli_route_instructions>",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: `inherited-${"x".repeat(130_000)}` }] },
      { type: "compaction", encrypted_content: "provider-opaque-compaction" },
      taskItem(nativeTaskPayload),
    ],
    tools: [{ type: "function", name: "large_parent_schema", parameters: { type: "object", description: "z".repeat(50_000) } }],
    client_metadata: { cwd: homedir() },
  }, {
    provider: "commandcode",
    model: "meta/muse-spark-1.3-contributor",
    requiredEffort: COMMANDCODE_REQUIRED_EFFORT,
  });
  if (
    nativeContext.prompt.split(nativeTaskPayload).length !== 2
    || nativeContext.prompt.includes("provider-opaque-compaction")
    || nativeContext.prompt.includes("inherited-")
    || nativeContext.toolSchemaBytesIgnored < 50_000
    || nativeContext.taskDiagnostics.completeTaskDelivered !== true
    || nativeContext.workingDirectory !== homedir()
  ) {
    throw new Error("self-test failed: native CLI must pin the complete task exactly once outside inherited history and parent schemas");
  }
  const mainAgentContext = nativeCliAgentContext({
    model: MAIN_AGENT_MODEL_ALIAS,
    reasoning: { effort: COMMANDCODE_REQUIRED_EFFORT },
    stream: true,
    instructions: "MAIN_AGENT_INSTRUCTIONS",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "MAIN_AGENT_REQUEST" }] }],
    tools: [{ type: "function", name: "ignored_parent_schema", parameters: { type: "object" } }],
    client_metadata: { cwd: homedir(), thread_id: "main-agent-fixture" },
  }, {
    provider: "commandcode",
    model: subagentModelRoute("commandcode"),
    requiredEffort: COMMANDCODE_REQUIRED_EFFORT,
    mainAgent: true,
  });
  if (
    !mainAgentContext.mainAgent
    || mainAgentContext.taskState.activeTask !== null
    || !mainAgentContext.prompt.includes("[RzCodex main-agent contract]")
    || !mainAgentContext.prompt.includes("MAIN_AGENT_INSTRUCTIONS")
    || !mainAgentContext.prompt.includes("MAIN_AGENT_REQUEST")
  ) {
    throw new Error("self-test failed: native main-agent context must accept ordinary history without NEW_TASK");
  }
  const commandCodeMain = translateResponsesRequest({
    model: MAIN_AGENT_MODEL_ALIAS,
    instructions: "MAIN_AGENT_INSTRUCTIONS",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "MAIN_AGENT_REQUEST" }] }],
    tools: [{ type: "function", name: "echo", parameters: { type: "object", properties: {} } }],
    stream: true,
    client_metadata: { cwd: homedir() },
  });
  if (
    commandCodeMain.upstream.params.model !== subagentModelRoute("commandcode")
    || !commandCodeMain.upstream.params.system.includes(MAIN_AGENT_CONTRACT)
    || !commandCodeMain.upstream.params.system.includes("MAIN_AGENT_INSTRUCTIONS")
    || commandCodeMain.upstream.params.tools.length !== 1
  ) {
    throw new Error("self-test failed: CommandCode main-agent alias must preserve the full tool protocol");
  }
  const openCodeMain = normalizeOpenCodeRequest({
    model: MAIN_AGENT_MODEL_ALIAS,
    instructions: "MAIN_AGENT_INSTRUCTIONS",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "MAIN_AGENT_REQUEST" }] }],
    tools: [{ type: "function", name: "echo", parameters: { type: "object", properties: {} } }],
    stream: true,
    client_metadata: { cwd: homedir() },
  });
  if (
    openCodeMain.body.model !== subagentModelRoute("opencode")
    || !openCodeMain.body.instructions.includes(MAIN_AGENT_CONTRACT)
    || !openCodeMain.body.instructions.includes("MAIN_AGENT_INSTRUCTIONS")
    || openCodeMain.responseTools.size !== 1
  ) {
    throw new Error("self-test failed: OpenCode main-agent alias must preserve the full tool protocol");
  }
  const cursorMain = cursorPromptFrom({
    model: MAIN_AGENT_MODEL_ALIAS,
    instructions: "MAIN_AGENT_INSTRUCTIONS",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "MAIN_AGENT_REQUEST" }] }],
    stream: true,
    client_metadata: { cwd: homedir(), thread_id: "cursor-main-fixture" },
  });
  if (
    !cursorMain.mainAgent
    || cursorMain.model !== subagentModelRoute("cursor")
    || !cursorMain.prompt.includes(MAIN_AGENT_CONTRACT)
    || !cursorMain.prompt.includes("MAIN_AGENT_INSTRUCTIONS")
    || cursorStateKey(cursorMain) !== "cursor-main-fixture:main"
  ) {
    throw new Error("self-test failed: Cursor main-agent alias must accept ordinary history without NEW_TASK");
  }
  const commandCodeAnalysis = translateResponsesRequest({
    model: "commandcode/test-model",
    input: [taskItem(analysisTaskText)],
    stream: true,
    client_metadata: { cwd: process.cwd() },
  }).upstream.params.system;
  const cursorAnalysis = cursorPromptFrom({
    model: "cursor/test-model",
    input: [taskItem(analysisTaskText)],
    stream: true,
    client_metadata: { cwd: process.cwd() },
  }).prompt;
  const cursorRetainedThread = "cursor-retained-checkpoint-fixture";
  const cursorOriginalContext = cursorPromptFrom({
    model: "cursor/test-model",
    input: [taskItem(analysisTaskText)],
    stream: true,
    client_metadata: { cwd: process.cwd(), thread_id: cursorRetainedThread },
  });
  const cursorContinuedContext = cursorPromptFrom({
    model: "cursor/test-model",
    input: [
      taskItem(analysisTaskText),
      taskItem("Message Type: NEW_TASK\nTask name: /root/worker\nPayload:\nContinue the original bounded task from the checkpoint."),
    ],
    stream: true,
    client_metadata: { cwd: process.cwd(), thread_id: cursorRetainedThread },
  });
  if (cursorStateKey(cursorOriginalContext) !== cursorStateKey(cursorContinuedContext)) {
    throw new Error("self-test failed: Cursor continuation changed the retained chat identity");
  }
  const openCodeAnalysis = normalizeOpenCodeRequest({
    model: "opencode/muse-spark-1.3-contributor-free",
    input: [taskItem(analysisTaskText)],
    stream: true,
    client_metadata: { cwd: process.cwd() },
  });
  for (const [label, normalized] of [
    ["CommandCode", commandCodeAnalysis],
    ["Cursor", cursorAnalysis],
    ["OpenCode", openCodeAnalysis.body.instructions],
  ]) {
    if (
      !normalized.includes("[Analysis convergence contract]")
      || !normalized.includes("[Project AGENTS instructions - authoritative and complete]")
      || normalized.includes("[Immediate terminal report required]")
    ) {
      throw new Error(`self-test failed: ${label} analysis convergence control`);
    }
  }
  if (!openCodeAnalysis.taskState.activeTask || openCodeAnalysis.taskState.activeTask.text !== analysisTaskText) {
    throw new Error("self-test failed: OpenCode lost native task state during normalization");
  }
  const immediatePrompts = [
    translateResponsesRequest({ model: "commandcode/test-model", input: [taskItem(immediateTaskText)], stream: true, client_metadata: { cwd: process.cwd() } }).upstream.params.system,
    cursorPromptFrom({ model: "cursor/test-model", input: [taskItem(immediateTaskText)], stream: true, client_metadata: { cwd: process.cwd() } }).prompt,
    normalizeOpenCodeRequest({ model: "opencode/muse-spark-1.2-contributor-free", input: [taskItem(immediateTaskText)], stream: true }).body.instructions,
  ];
  if (immediatePrompts.some((prompt) => !prompt.includes("[Immediate terminal report required]"))) {
    throw new Error("self-test failed: immediate terminal report control did not reach every CLI bridge");
  }
  const reasoningBoundaryInput = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    {
      type: "reasoning",
      id: "progress_commandcode_fixture",
      summary: [{ type: "summary_text", text: "BRIDGE_PROGRESS_MUST_NOT_REENTER" }],
    },
    {
      type: "reasoning",
      id: "rs_parent_commandcode_fixture",
      summary: [{ type: "summary_text", text: "PORTABLE_PARENT_REASONING" }],
    },
  ];
  const commandCodeReasoningBoundary = jsonString(translateResponsesRequest({
    model: "commandcode/test-model",
    input: reasoningBoundaryInput,
    stream: true,
    client_metadata: { cwd: process.cwd() },
  }).upstream.params.messages);
  const cursorReasoningBoundary = cursorPromptFrom({
    model: "cursor/test-model",
    input: reasoningBoundaryInput,
    stream: true,
    client_metadata: { cwd: process.cwd() },
  }).prompt;
  const openCodeReasoningBoundary = jsonString(normalizeOpenCodeRequest({
    model: "opencode/muse-spark-1.2-contributor-free",
    input: reasoningBoundaryInput,
    stream: true,
  }).body.input);
  for (const [label, normalized] of [
    ["CommandCode", commandCodeReasoningBoundary],
    ["Cursor", cursorReasoningBoundary],
    ["OpenCode", openCodeReasoningBoundary],
  ]) {
    if (
      normalized.includes("BRIDGE_PROGRESS_MUST_NOT_REENTER")
      || !normalized.includes("PORTABLE_PARENT_REASONING")
    ) {
      throw new Error(`self-test failed: bridge progress re-entered the ${label} provider prompt`);
    }
  }
  const cursorCommittedError = preserveCursorCommit(
    new BridgeError("fixture", 502),
    ["read_file", "apply_patch", "apply_patch"],
  );
  if (
    cursorResponseErrorCode(cursorCommittedError) !== "provider_state_changed"
    || cursorCommittedError.nativeToolNames.join(",") !== "read_file,apply_patch"
    || cursorResponseErrorCode(new BridgeError("transient", 502)) !== "external_provider_error"
  ) {
    throw new Error("self-test failed: Cursor native-tool commitment classification");
  }
  if (translateToolDefinition({ type: "web_search" }, 0).length !== 0) {
    throw new Error("self-test failed: hosted web search must not be forwarded to CommandCode");
  }
  const commandCodeAgentMessage = translateResponsesRequest({
    model: "commandcode/test-model",
    input: [{ type: "agent_message", author: "/root", recipient: "/root/worker", content: [{ type: "input_text", text: "delegated" }] }],
    stream: true,
    client_metadata: { cwd: process.cwd() },
  });
  if (
    commandCodeAgentMessage.upstream.params.messages[0]?.role !== "user" ||
    commandCodeAgentMessage.upstream.params.messages[0]?.content?.[0]?.text !== "delegated"
  ) {
    throw new Error("self-test failed: CommandCode native agent message translation");
  }
  for (const itemType of PROVIDER_OPAQUE_INPUT_TYPES) {
    const portableHistory = Array.from({ length: 22 }, (_, index) => ({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `portable-${index}` }],
    }));
    const compactedCommandCode = translateResponsesRequest({
      model: "commandcode/test-model",
      input: [
        ...portableHistory,
        { type: itemType, encrypted_content: "provider-opaque" },
        { type: "agent_message", content: [{ type: "input_text", text: "active-task" }] },
      ],
      stream: true,
      client_metadata: { cwd: process.cwd() },
    });
    const compactedMessages = compactedCommandCode.upstream.params.messages;
    const serializedMessages = jsonString(compactedMessages);
    if (
      compactedMessages.length !== 23
      || compactedMessages[0]?.content?.[0]?.text !== "portable-0"
      || compactedMessages[21]?.content?.[0]?.text !== "portable-21"
      || compactedMessages[22]?.content?.[0]?.text !== "active-task"
      || serializedMessages.includes("provider-opaque")
      || serializedMessages.split("active-task").length !== 2
    ) {
      throw new Error(`self-test failed: CommandCode ${itemType} portability`);
    }
  }
  let unknownCommandCodeInputRejected = false;
  try {
    translateResponsesRequest({
      model: "commandcode/test-model",
      input: [{ type: "unknown-provider-state", value: "must-not-be-dropped" }],
      stream: true,
      client_metadata: { cwd: process.cwd() },
    });
  } catch (error) {
    unknownCommandCodeInputRejected = error instanceof BridgeError
      && error.message.includes("unsupported input type")
      && error.message.includes("unknown-provider-state");
  }
  if (!unknownCommandCodeInputRejected) {
    throw new Error("self-test failed: CommandCode unknown input must fail loudly");
  }
  const translated = translateResponsesRequest({
    model: "commandcode/test-model",
    instructions: "system",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "" }] },
      { type: "function_call", call_id: "call-1", name: "echo", arguments: "{\"value\":1}" },
      { type: "function_call_output", call_id: "call-1", output: "done" },
    ],
    tools: [{ type: "function", name: "echo", description: "Echo", parameters: { type: "object", properties: {} } }],
    stream: true,
    client_metadata: { cwd: process.cwd() },
  });
  if (translated.upstream.params.messages[1]?.content[0]?.type !== "tool-call") {
    throw new Error("self-test failed: function call translation");
  }
  if (translated.upstream.params.messages[2]?.role !== "tool") {
    throw new Error("self-test failed: tool output translation");
  }

  const namespace = "namespace_with_a_name_long_enough_to_force_wire_name_shortening";
  const recursive = {
    type: "object",
    properties: { children: { type: "array", items: { $ref: "#/$defs/node" } } },
    $defs: {
      node: {
        type: "object",
        properties: { children: { type: "array", items: { $ref: "#/$defs/node" } } },
      },
    },
  };
  const namespaced = translateResponsesRequest({
    model: "test-model",
    input: [
      { type: "reasoning", encrypted_content: "provider-opaque", summary: [] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    ],
    tools: [{
      type: "namespace",
      name: namespace,
      description: "namespace",
      tools: [{ type: "function", name: "recursive_tool", description: "recursive", parameters: recursive }],
    }],
    stream: true,
    client_metadata: { cwd: process.cwd() },
  });
  const namespacedTool = namespaced.upstream.params.tools[0];
  if (namespacedTool.name.length > 64 || jsonString(namespacedTool.input_schema).includes('"$ref"')) {
    throw new Error("self-test failed: namespace/schema normalization");
  }

  const output = [];
  const fakeResponse = {
    writableEnded: false,
    destroyed: false,
    write(chunk) { output.push(chunk); return true; },
  };
  const state = { textItemId: null, text: "", reasoningItemId: null, reasoningText: "", finished: false, finish: null };
  const context = { toolsByWireName: new Map() };
  emitUpstreamEvent(fakeResponse, { type: "text-delta", text: "ok" }, state, context);
  emitUpstreamEvent(fakeResponse, { type: "finish", finishReason: "end_turn", totalUsage: {} }, state, context);
  if (!output.some((chunk) => chunk.includes("response.output_text.delta")) || !output.some((chunk) => chunk.includes("response.output_item.done"))) {
    throw new Error("self-test failed: Responses SSE translation");
  }

  const boundaryOutput = [];
  const boundaryProgress = nativeCliProgressEmitter({
    writableEnded: false,
    destroyed: false,
    write(chunk) { boundaryOutput.push(chunk); return true; },
  });
  boundaryProgress.emit("cursor native tool 1: read_file.\n");
  boundaryProgress.emit("cursor native tool 2: apply_patch.\n");
  const boundaryItems = boundaryProgress.finish();
  const boundaryState = taskStateFromInput([
    taskItem(nativeTaskPayload),
    ...boundaryItems,
  ], MAX_ACTIVE_TASK_CHARS);
  if (
    boundaryItems.length !== 2
    || boundaryOutput.filter((chunk) => chunk.includes("event: response.output_item.done")).length !== 2
    || boundaryState.progress.toolCallsSinceTask !== 2
    || boundaryState.progress.lastCompletedTool !== "apply_patch"
  ) {
    throw new Error("self-test failed: native tools must produce independent mailbox boundaries and resumable progress");
  }


  const toolOutput = [];
  const toolResponse = {
    writableEnded: false,
    destroyed: false,
    write(chunk) { toolOutput.push(chunk); return true; },
  };
  emitUpstreamEvent(toolResponse, {
    type: "tool-call",
    toolCallId: "call-ns",
    toolName: namespacedTool.name,
    input: { children: [] },
  }, { textItemId: null, text: "", reasoningItemId: null, reasoningText: "", finished: false, finish: null }, namespaced.context);
  if (!toolOutput.some((chunk) => chunk.includes(`"namespace":"${namespace}"`) && chunk.includes('"name":"recursive_tool"'))) {
    throw new Error("self-test failed: namespaced tool-call restoration");
  }

  const openCode = normalizeOpenCodeRequest({
    model: "test-model",
    reasoning: { effort: "none", summary: "none" },
    input: [
      { type: "custom_tool_call", call_id: "call-custom", name: "apply_patch", input: "*** Begin Patch" },
      { type: "custom_tool_call_output", call_id: "call-custom", output: "ok" },
    ],
    tools: [
      { type: "custom", name: "apply_patch", description: "patch", format: { type: "text" } },
      { type: "function", name: "recursive", description: "recursive", parameters: recursive },
    ],
    stream: true,
  });
  if (
    openCode.body.reasoning !== undefined ||
    openCode.body.tools[0].type !== "function" ||
    openCode.body.input[0].type !== "function_call" ||
    openCode.body.input[1].type !== "function_call_output" ||
    jsonString(openCode.body.tools[1].parameters).includes('"$ref"')
  ) {
    throw new Error("self-test failed: OpenCode request normalization");
  }
  const openCodeAgentMessage = normalizeOpenCodeRequest({
    model: "opencode/muse-spark-1.2-contributor-free",
    input: [{ type: "agent_message", author: "/root", recipient: "/root/worker", content: [{ type: "input_text", text: "delegated" }] }],
    stream: true,
  });
  if (
    openCodeAgentMessage.body.input[0]?.type !== "message" ||
    openCodeAgentMessage.body.input[0]?.role !== "user" ||
    openCodeAgentMessage.body.input[0]?.content?.[0]?.text !== "delegated"
  ) {
    throw new Error("self-test failed: OpenCode native agent message normalization");
  }
  const openCodeChatAgentMessage = normalizeOpenCodeRequest({
    model: "opencode/hy3-free",
    input: [{ type: "agent_message", author: "/root", recipient: "/root/worker", content: [{ type: "input_text", text: "delegated" }] }],
    stream: true,
  });
  const openCodeChatAgentRequest = openCodeChatRequest(
    openCodeChatAgentMessage.body,
    openCodeChatAgentMessage.customTools,
    openCodeChatAgentMessage.responseTools,
  );
  const openCodeChatAgentUserMessage = openCodeChatAgentRequest.body.messages.find((message) => message.role === "user");
  if (
    openCodeChatAgentUserMessage?.content?.[0]?.text !== "delegated"
  ) {
    throw new Error("self-test failed: OpenCode Chat native agent message translation");
  }
  const duplicateNotifyCallId = "call_93b19e6f6cc54dcf83b458af";
  const duplicateNotifyNormalized = normalizeOpenCodeRequest({
    model: "opencode/x-preview-f-free",
    input: [
      {
        type: "custom_tool_call",
        call_id: duplicateNotifyCallId,
        name: "exec",
        input: "notify('HELLO');\ntext('done')",
      },
      {
        type: "custom_tool_call_output",
        call_id: duplicateNotifyCallId,
        output: [
          { type: "input_text", text: "Script completed\nWall time: 0.0 seconds\nOutput:\n" },
          { type: "input_text", text: "done" },
        ],
      },
      { type: "custom_tool_call_output", call_id: duplicateNotifyCallId, name: "exec", output: "HELLO" },
    ],
    stream: true,
  });
  if (
    duplicateNotifyNormalized.body.input.length !== 2 ||
    duplicateNotifyNormalized.body.input[1]?.type !== "function_call_output" ||
    duplicateNotifyNormalized.body.input[1]?.output !== "Script completed\nWall time: 0.0 seconds\nOutput:\ndone\nHELLO"
  ) {
    throw new Error("self-test failed: notify and normal tool outputs must merge losslessly");
  }
  const identicalOutputsNormalized = normalizeOpenCodeRequest({
    model: "opencode/x-preview-f-free",
    input: [
      { type: "function_call", call_id: "duplicate-identical", name: "echo", arguments: "{}" },
      { type: "function_call_output", call_id: "duplicate-identical", output: "same" },
      { type: "function_call_output", call_id: "duplicate-identical", output: [{ type: "input_text", text: "same" }] },
    ],
    stream: true,
  });
  if (
    identicalOutputsNormalized.body.input.length !== 2 ||
    identicalOutputsNormalized.body.input[1]?.output !== "same"
  ) {
    throw new Error("self-test failed: identical tool outputs must be emitted once");
  }
  let irreconcilableOutputKindsRejected = false;
  try {
    normalizeOpenCodeRequest({
      model: "opencode/x-preview-f-free",
      input: [
        { type: "function_call_output", call_id: "duplicate-kind", output: "function" },
        { type: "custom_tool_call_output", call_id: "duplicate-kind", output: "custom" },
      ],
      stream: true,
    });
  } catch (error) {
    irreconcilableOutputKindsRejected = error instanceof BridgeError && error.message.includes("irreconcilable function_call_output kinds");
  }
  if (!irreconcilableOutputKindsRejected) {
    throw new Error("self-test failed: irreconcilable tool-output kinds must be rejected");
  }
  const objectArgumentsNormalized = normalizeOpenCodeRequest({
    model: "opencode/muse-spark-1.2-contributor-free",
    input: [{ type: "function_call", call_id: "object-arguments", name: "echo", arguments: { value: 1 } }],
    stream: true,
  });
  if (objectArgumentsNormalized.body.input[0]?.arguments !== '{"value":1}') {
    throw new Error("self-test failed: object function arguments must normalize to JSON");
  }
  const unsupportedCallId = "call_01a0409e66887b21b685b8e58661b3da";
  const unsupportedCallReplayNormalized = normalizeOpenCodeRequest({
    model: "opencode/muse-spark-1.2-contributor-free",
    input: [
      { type: "function_call", call_id: unsupportedCallId, name: "default.update_plan", arguments: "" },
      { type: "function_call_output", call_id: unsupportedCallId, output: "unsupported call: default.update_plan" },
    ],
    stream: true,
  });
  if (
    unsupportedCallReplayNormalized.body.input.length !== 1 ||
    unsupportedCallReplayNormalized.body.input[0]?.type !== "message" ||
    unsupportedCallReplayNormalized.body.input[0]?.role !== "assistant" ||
    unsupportedCallReplayNormalized.body.input[0]?.content?.[0]?.text !==
      `Tool call default.update_plan (${unsupportedCallId}) was not executed: unsupported call: default.update_plan`
  ) {
    throw new Error("self-test failed: unsupported malformed call replay must become portable failure context");
  }
  let malformedNativeArgumentsRejected = false;
  try {
    normalizeOpenCodeRequest({
      model: "opencode/muse-spark-1.2-contributor-free",
      input: [{
        type: "function_call",
        call_id: "unmatched-malformed",
        name: "default.update_plan",
        arguments: "",
      }],
      stream: true,
    });
  } catch (error) {
    malformedNativeArgumentsRejected = error instanceof BridgeError &&
      error.message.includes("unmatched-malformed") &&
      error.message.includes("default.update_plan") &&
      error.message.includes("arguments must be valid JSON object");
  }
  if (!malformedNativeArgumentsRejected) {
    throw new Error("self-test failed: malformed native function arguments must be rejected with call identity");
  }
  let malformedResponseArgumentsRejected = false;
  try {
    transformOpenCodeSseBlock(
      `event: response.output_item.done\ndata: ${jsonString({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "fc_01a0409e66887b21b685b8e58661b3da",
          call_id: unsupportedCallId,
          name: "default.update_plan",
          arguments: "",
        },
      })}\n\n`,
      new Map(),
      new Set(),
    );
  } catch (error) {
    malformedResponseArgumentsRejected = error instanceof BridgeError &&
      error.status === 502 &&
      error.message.includes(unsupportedCallId) &&
      error.message.includes("default.update_plan") &&
      error.message.includes("invalid JSON arguments");
  }
  if (!malformedResponseArgumentsRejected) {
    throw new Error("self-test failed: malformed terminal response arguments must be rejected");
  }
  let malformedResponseFinalArgumentsRejected = false;
  try {
    transformOpenCodeSseBlock(
      `event: response.completed\ndata: ${jsonString({
        type: "response.completed",
        response: {
          output: [{
            type: "function_call",
            id: "fc_final_malformed",
            call_id: "call-final-malformed",
            name: "default.update_plan",
            arguments: "",
          }],
        },
      })}\n\n`,
      new Map(),
      new Set(),
    );
  } catch (error) {
    malformedResponseFinalArgumentsRejected = error instanceof BridgeError &&
      error.status === 502 &&
      error.message.includes("call-final-malformed") &&
      error.message.includes("default.update_plan") &&
      error.message.includes("invalid JSON arguments");
  }
  if (!malformedResponseFinalArgumentsRejected) {
    throw new Error("self-test failed: malformed final response arguments must be rejected");
  }
  const namespacedResponseNormalized = normalizeOpenCodeRequest({
    model: "opencode/muse-spark-1.2-contributor-free",
    tools: [{
      type: "namespace",
      name: "default",
      tools: [
        { type: "function", name: "update_plan", parameters: { type: "object", properties: {} } },
        { type: "custom", name: "apply_patch", format: { type: "text" } },
      ],
    }],
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }],
    stream: true,
  });
  const namespacedResponseTerminal = transformOpenCodeSseBlock(
    `event: response.output_item.done\ndata: ${jsonString({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: "fc-namespaced-terminal",
        call_id: "call-namespaced-terminal",
        name: "default.update_plan",
        arguments: "{\"plan\":[]}",
      },
    })}\n\n`,
    namespacedResponseNormalized.customTools,
    new Set(),
    namespacedResponseNormalized.responseTools,
  );
  if (
    !namespacedResponseTerminal.includes('"name":"update_plan"') ||
    !namespacedResponseTerminal.includes('"namespace":"default"') ||
    namespacedResponseTerminal.includes('"name":"default.update_plan"')
  ) {
    throw new Error("self-test failed: namespaced native response identity restoration");
  }
  const namespacedResponseFinal = transformOpenCodeSseBlock(
    `event: response.completed\ndata: ${jsonString({
      type: "response.completed",
      response: {
        output: [
          {
            type: "function_call",
            id: "fc-namespaced-final",
            call_id: "call-namespaced-final",
            name: "default__update_plan",
            arguments: "{\"plan\":[]}",
          },
          {
            type: "function_call",
            id: "fc-namespaced-custom",
            call_id: "call-namespaced-custom",
            name: "default.apply_patch",
            arguments: "{\"input\":\"*** Begin Patch\"}",
          },
        ],
      },
    })}\n\n`,
    namespacedResponseNormalized.customTools,
    new Set(),
    namespacedResponseNormalized.responseTools,
  );
  if (
    !namespacedResponseFinal.includes('"name":"update_plan"') ||
    !namespacedResponseFinal.includes('"namespace":"default"') ||
    !namespacedResponseFinal.includes('"type":"custom_tool_call"') ||
    !namespacedResponseFinal.includes('"name":"apply_patch"') ||
    !namespacedResponseFinal.includes('"input":"*** Begin Patch"')
  ) {
    throw new Error("self-test failed: namespaced final native/custom response restoration");
  }
  let namespacedEmptyArgumentsRejected = false;
  try {
    transformOpenCodeSseBlock(
      `event: response.output_item.done\ndata: ${jsonString({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "fc-namespaced-empty",
          call_id: "call-namespaced-empty",
          name: "default.update_plan",
          arguments: "",
        },
      })}\n\n`,
      namespacedResponseNormalized.customTools,
      new Set(),
      namespacedResponseNormalized.responseTools,
    );
  } catch (error) {
    namespacedEmptyArgumentsRejected = error instanceof BridgeError &&
      error.status === 502 &&
      error.message.includes("call-namespaced-empty") &&
      error.message.includes("update_plan");
  }
  if (!namespacedEmptyArgumentsRejected) {
    throw new Error("self-test failed: namespaced empty response arguments must be rejected");
  }
  const topLevelResponseNormalized = normalizeOpenCodeRequest({
    model: "opencode/muse-spark-1.2-contributor-free",
    tools: [{ type: "function", name: "echo", parameters: { type: "object", properties: {} } }],
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }],
    stream: true,
  });
  const topLevelResponse = transformOpenCodeSseBlock(
    `event: response.output_item.done\ndata: ${jsonString({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: "fc-top-level",
        call_id: "call-top-level",
        name: "echo",
        arguments: "{}",
      },
    })}\n\n`,
    topLevelResponseNormalized.customTools,
    new Set(),
    topLevelResponseNormalized.responseTools,
  );
  if (!topLevelResponse.includes('"name":"echo"') || topLevelResponse.includes('"namespace"')) {
    throw new Error("self-test failed: top-level response identity changed");
  }
  let responseToolAliasCollisionRejected = false;
  try {
    normalizeOpenCodeRequest({
      model: "opencode/muse-spark-1.2-contributor-free",
      tools: [
        { type: "function", name: "default.update_plan", parameters: { type: "object", properties: {} } },
        { type: "namespace", name: "default", tools: [{ type: "function", name: "update_plan", parameters: { type: "object", properties: {} } }] },
      ],
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }],
      stream: true,
    });
  } catch (error) {
    responseToolAliasCollisionRejected = error instanceof BridgeError && error.message.includes("response tool alias");
  }
  if (!responseToolAliasCollisionRejected) {
    throw new Error("self-test failed: ambiguous response tool aliases must be rejected");
  }
  const staleReasoningId = "rs_5566eb53-1177-4862-b7fe-ecb7ef8b3a12";
  const staleReasoningNormalized = normalizeOpenCodeRequest({
    model: "opencode/muse-spark-1.2-contributor-free",
    input: [
      {
        type: "reasoning",
        id: staleReasoningId,
        summary: [{ type: "summary_text", text: "Prior visible reasoning" }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ],
    stream: true,
  });
  if (
    staleReasoningNormalized.body.input.length !== 2 ||
    staleReasoningNormalized.body.input[0]?.type !== "message" ||
    staleReasoningNormalized.body.input[0]?.role !== "assistant" ||
    staleReasoningNormalized.body.input[0]?.content?.[0]?.type !== "output_text" ||
    staleReasoningNormalized.body.input[0]?.content?.[0]?.text !== "Prior visible reasoning" ||
    jsonString(staleReasoningNormalized.body.input).includes(staleReasoningId)
  ) {
    throw new Error("self-test failed: stale reasoning must become portable assistant context");
  }
  const opaqueReasoningNormalized = normalizeOpenCodeRequest({
    model: "opencode/muse-spark-1.2-contributor-free",
    input: [
      { type: "reasoning", id: "rs_opaque", encrypted_content: "provider-opaque", summary: [] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ],
    stream: true,
  });
  if (
    opaqueReasoningNormalized.body.input.length !== 1 ||
    opaqueReasoningNormalized.body.input[0]?.type !== "message"
  ) {
    throw new Error("self-test failed: opaque reasoning without summary must be omitted");
  }
  const openCodeWithoutSummary = normalizeOpenCodeRequest({
    model: "test-model",
    reasoning: { effort: "low", summary: "none" },
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
    stream: true,
  });
  if (openCodeWithoutSummary.body.reasoning?.effort !== "low" || "summary" in openCodeWithoutSummary.body.reasoning) {
    throw new Error("self-test failed: OpenCode unsupported reasoning summary removal");
  }
  for (const itemType of PROVIDER_OPAQUE_INPUT_TYPES) {
    const compactedOpenCode = normalizeOpenCodeRequest({
      model: "x-preview-f-free",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "portable-before" }] },
        { type: itemType, encrypted_content: "provider-opaque" },
        { type: "agent_message", content: [{ type: "input_text", text: "active-task" }] },
      ],
      stream: true,
    });
    const serializedInput = jsonString(compactedOpenCode.body.input);
    if (
      compactedOpenCode.body.input.length !== 2
      || compactedOpenCode.body.input[0]?.content?.[0]?.text !== "portable-before"
      || compactedOpenCode.body.input[1]?.content?.[0]?.text !== "active-task"
      || serializedInput.includes("provider-opaque")
      || serializedInput.split("active-task").length !== 2
    ) {
      throw new Error(`self-test failed: OpenCode ${itemType} portability`);
    }
  }
  const unknownOpenCodeInput = normalizeOpenCodeRequest({
    model: "x-preview-f-free",
    input: [{ type: "unknown-provider-state", value: "must-not-be-dropped" }],
    stream: true,
  });
  if (
    unknownOpenCodeInput.body.input.length !== 1
    || unknownOpenCodeInput.body.input[0]?.type !== "unknown-provider-state"
    || unknownOpenCodeInput.body.input[0]?.value !== "must-not-be-dropped"
  ) {
    throw new Error("self-test failed: OpenCode unknown input must not be silently discarded");
  }
  const suppressed = new Set();
  const added = transformOpenCodeSseBlock(
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","name":"apply_patch","call_id":"call-custom","arguments":""}}\n\n',
    openCode.customTools,
    suppressed,
  );
  const done = transformOpenCodeSseBlock(
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"fc_1","type":"function_call","name":"apply_patch","call_id":"call-custom","arguments":"{\\"input\\":\\"*** Begin Patch\\"}"}}\n\n',
    openCode.customTools,
    suppressed,
  );
  if (added !== null || !done.includes('"type":"custom_tool_call"') || !done.includes('"input":"*** Begin Patch"')) {
    throw new Error("self-test failed: OpenCode custom tool restoration");
  }

  const expectedResponses = [
    "gpt-5", "gpt-5-codex", "gpt-5-nano", "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-max", "gpt-5.1-codex-mini",
    "gpt-5.2", "gpt-5.2-codex", "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano",
    "gpt-5.4-pro", "gpt-5.5", "gpt-5.5-pro", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "grok-4.5", "grok-4.6",
    "grok-build-0.1", "muse-spark-1.2", "muse-spark-1.2-contributor-free", "muse-spark-1.3-contributor-free",
  ];
  const expectedChat = [
    "big-pickle", "hy3-free", "mimo-v2.5-free", "nemotron-3-ultra-free", "nemotron-3.5-lightning-free", "x-preview-f-free",
    "deepseek-v4-flash", "deepseek-v4-pro", "minimax-m2.5", "minimax-m2.7", "minimax-m3", "glm-5", "glm-5.1", "glm-5.2",
    "kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code", "kimi-k3",
  ];
  if (expectedResponses.some((model) => openCodeTransport(model) !== "responses")) throw new Error("self-test failed: OpenCode Responses route table");
  if (expectedChat.some((model) => openCodeTransport(model) !== "chat-completions")) throw new Error("self-test failed: OpenCode Chat route table");
  let unsupportedTransport = false;
  try {
    openCodeTransport("claude-opus-4-6");
  } catch (error) {
    unsupportedTransport = error instanceof BridgeError && error.message.includes("Anthropic Messages");
  }
  if (!unsupportedTransport) throw new Error("self-test failed: unsupported OpenCode transport rejection");

  const chatNormalized = normalizeOpenCodeRequest({
    model: "opencode/hy3-free",
    instructions: "system",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "call echo" }] },
      { type: "custom_tool_call", call_id: "chat-call", name: "apply_patch", input: "*** Begin Patch" },
      { type: "custom_tool_call_output", call_id: "chat-call", output: "ok" },
    ],
    tools: [
      { type: "custom", name: "apply_patch", description: "patch", format: { type: "text" } },
      { type: "web_search" },
    ],
    stream: true,
    max_output_tokens: 8,
  });
  const chatRequest = openCodeChatRequest(chatNormalized.body, chatNormalized.customTools);
  if (
    chatRequest.body.model !== "hy3-free" ||
    chatRequest.body.stream !== true ||
    chatRequest.body.messages[0]?.role !== "system" ||
    chatRequest.body.messages[2]?.role !== "assistant" ||
    chatRequest.body.messages[2]?.tool_calls?.[0]?.function?.name !== "apply_patch" ||
    chatRequest.body.messages[3]?.role !== "tool" ||
    chatRequest.body.tools?.length !== 1
  ) {
    throw new Error("self-test failed: OpenCode Chat request translation");
  }
  const replayNormalized = normalizeOpenCodeRequest({
    model: "opencode/x-preview-f-free",
    input: [
      { type: "message", role: "system", content: [{ type: "input_text", text: "system" }] },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "developer" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "inspect" }] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "think" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "" }] },
      { type: "function_call", call_id: "parallel-1", name: "first", arguments: "{}" },
      { type: "function_call", call_id: "parallel-2", name: "second", arguments: "{}" },
      { type: "function_call_output", call_id: "parallel-1", output: [{ type: "text", text: "" }] },
      { type: "function_call_output", call_id: "parallel-2", output: "two" },
    ],
    tools: [
      { type: "function", name: "first", parameters: { type: "object", properties: {} } },
      { type: "function", name: "second", parameters: { type: "object", properties: {} } },
    ],
    stream: true,
    max_output_tokens: 8,
  });
  const replayRequest = openCodeChatRequest(replayNormalized.body, replayNormalized.customTools);
  const replayAssistant = replayRequest.body.messages[2];
  if (
    !replayRequest.body.messages[0]?.content?.endsWith("system\n\ndeveloper") ||
    replayAssistant?.role !== "assistant" ||
    replayAssistant.content !== null ||
    replayAssistant.reasoning_content !== "think" ||
    replayAssistant.tool_calls?.length !== 2 ||
    replayRequest.body.messages[3]?.role !== "tool" ||
    replayRequest.body.messages[3]?.content !== "" ||
    replayRequest.body.messages[4]?.role !== "tool"
  ) {
    throw new Error("self-test failed: OpenCode empty assistant and parallel tool replay");
  }
  const visibleTextNormalized = normalizeOpenCodeRequest({
    model: "opencode/x-preview-f-free",
    input: [
      { type: "message", role: "user", content: "inspect" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "visible" }] },
      { type: "function_call", call_id: "visible-call", name: "first", arguments: "{}" },
      { type: "function_call_output", call_id: "visible-call", output: "done" },
    ],
    tools: [{ type: "function", name: "first", parameters: { type: "object", properties: {} } }],
    stream: true,
    max_output_tokens: 8,
  });
  const visibleTextRequest = openCodeChatRequest(visibleTextNormalized.body, visibleTextNormalized.customTools);
  if (
    visibleTextRequest.body.messages[1]?.content !== "visible" ||
    visibleTextRequest.body.messages[1]?.tool_calls !== undefined ||
    visibleTextRequest.body.messages[2]?.content !== null ||
    visibleTextRequest.body.messages[2]?.tool_calls?.length !== 1 ||
    visibleTextRequest.body.messages[3]?.role !== "tool"
  ) {
    throw new Error("self-test failed: OpenCode visible assistant text and tool-call separation");
  }
  const scalarEmptyNormalized = normalizeOpenCodeRequest({
    model: "opencode/x-preview-f-free",
    input: [
      { type: "message", role: "user", content: "inspect" },
      { type: "message", role: "assistant", content: "" },
      { type: "function_call", call_id: "scalar-empty-call", name: "first", arguments: "{}" },
      { type: "function_call_output", call_id: "scalar-empty-call", output: "done" },
    ],
    tools: [{ type: "function", name: "first", parameters: { type: "object", properties: {} } }],
    stream: true,
    max_output_tokens: 8,
  });
  const scalarEmptyRequest = openCodeChatRequest(scalarEmptyNormalized.body, scalarEmptyNormalized.customTools);
  if (
    scalarEmptyRequest.body.messages[1]?.content !== null ||
    scalarEmptyRequest.body.messages[1]?.tool_calls?.length !== 1 ||
    scalarEmptyRequest.body.messages[2]?.role !== "tool"
  ) {
    throw new Error("self-test failed: OpenCode scalar empty assistant replay");
  }
  const namespacedReplayNormalized = normalizeOpenCodeRequest({
    model: "opencode/x-preview-f-free",
    input: [
      { type: "message", role: "user", content: "inspect" },
      { type: "function_call", call_id: "namespaced-replay", name: "blueprint_inspect", arguments: "{}" },
      { type: "function_call_output", call_id: "namespaced-replay", output: "done" },
    ],
    tools: [{
      type: "namespace",
      name: "rzmcp",
      tools: [{ type: "function", name: "blueprint_inspect", parameters: { type: "object", properties: {} } }],
    }],
    stream: true,
    max_output_tokens: 8,
  });
  const namespacedReplayRequest = openCodeChatRequest(namespacedReplayNormalized.body, namespacedReplayNormalized.customTools);
  if (
    namespacedReplayRequest.body.messages[1]?.tool_calls?.[0]?.function?.name !== "rzmcp__blueprint_inspect" ||
    namespacedReplayRequest.body.messages[2]?.role !== "tool"
  ) {
    throw new Error("self-test failed: OpenCode lost namespace replay");
  }
  const collidingTools = [
    {
      type: "namespace",
      name: "first_namespace",
      tools: [{ type: "function", name: "duplicate", parameters: { type: "object", properties: {} } }],
    },
    {
      type: "namespace",
      name: "second_namespace",
      tools: [{ type: "function", name: "duplicate", parameters: { type: "object", properties: {} } }],
    },
  ];
  const explicitNamespaceNormalized = normalizeOpenCodeRequest({
    model: "opencode/x-preview-f-free",
    input: [{ type: "function_call", call_id: "explicit-namespace", namespace: "first_namespace", name: "duplicate", arguments: "{}" }],
    tools: structuredClone(collidingTools),
    stream: true,
    max_output_tokens: 8,
  });
  const explicitNamespaceRequest = openCodeChatRequest(explicitNamespaceNormalized.body, explicitNamespaceNormalized.customTools);
  if (explicitNamespaceRequest.body.messages[0]?.tool_calls?.[0]?.function?.name !== "first_namespace__duplicate") {
    throw new Error("self-test failed: OpenCode explicit namespace replay");
  }
  const namespacedWireNormalized = normalizeOpenCodeRequest({
    model: "opencode/x-preview-f-free",
    input: [{
      type: "function_call",
      call_id: "namespaced-wire",
      namespace: "first_namespace",
      name: "first_namespace__duplicate",
      arguments: "{}",
    }],
    tools: structuredClone(collidingTools),
    stream: true,
    max_output_tokens: 8,
  });
  const namespacedWireRequest = openCodeChatRequest(namespacedWireNormalized.body, namespacedWireNormalized.customTools);
  if (namespacedWireRequest.body.messages[0]?.tool_calls?.[0]?.function?.name !== "first_namespace__duplicate") {
    throw new Error("self-test failed: OpenCode namespaced wire-name replay");
  }
  let mismatchedWireNamespaceRejected = false;
  try {
    const mismatchedWireNamespaceNormalized = normalizeOpenCodeRequest({
      model: "opencode/x-preview-f-free",
      input: [{
        type: "function_call",
        call_id: "mismatched-wire-namespace",
        namespace: "second_namespace",
        name: "first_namespace__duplicate",
        arguments: "{}",
      }],
      tools: structuredClone(collidingTools),
      stream: true,
      max_output_tokens: 8,
    });
    openCodeChatRequest(mismatchedWireNamespaceNormalized.body, mismatchedWireNamespaceNormalized.customTools);
  } catch (error) {
    mismatchedWireNamespaceRejected = error instanceof BridgeError && error.message.includes("belongs to namespace");
  }
  if (!mismatchedWireNamespaceRejected) {
    throw new Error("self-test failed: mismatched OpenCode wire namespace rejection");
  }
  let ambiguousNamespaceRejected = false;
  try {
    const ambiguousNamespaceNormalized = normalizeOpenCodeRequest({
      model: "opencode/x-preview-f-free",
      input: [{ type: "function_call", call_id: "ambiguous-namespace", name: "duplicate", arguments: "{}" }],
      tools: structuredClone(collidingTools),
      stream: true,
      max_output_tokens: 8,
    });
    openCodeChatRequest(ambiguousNamespaceNormalized.body, ambiguousNamespaceNormalized.customTools);
  } catch (error) {
    ambiguousNamespaceRejected = error instanceof BridgeError && error.message.includes("ambiguous unqualified function");
  }
  if (!ambiguousNamespaceRejected) {
    throw new Error("self-test failed: ambiguous OpenCode namespace replay rejection");
  }
  const historicalNamespaceNormalized = normalizeOpenCodeRequest({
    model: "opencode/x-preview-f-free",
    input: [
      { type: "message", role: "user", content: "inspect" },
      {
        type: "function_call",
        call_id: "historical-namespace",
        namespace: "mcp__rzmcp",
        name: "blueprint_inspect",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "historical-namespace", output: "done" },
    ],
    stream: true,
    max_output_tokens: 8,
  });
  const historicalNamespaceRequest = openCodeChatRequest(
    historicalNamespaceNormalized.body,
    historicalNamespaceNormalized.customTools,
  );
  if (
    historicalNamespaceRequest.body.messages[1]?.tool_calls?.[0]?.function?.name !== "mcp__rzmcp__blueprint_inspect" ||
    historicalNamespaceRequest.body.messages[2]?.role !== "tool" ||
    historicalNamespaceRequest.body.tools !== undefined
  ) {
    throw new Error("self-test failed: catalog-independent OpenCode namespace replay");
  }
  const unrelatedHistoricalNormalized = normalizeOpenCodeRequest({
    model: "opencode/x-preview-f-free",
    input: [{
      type: "function_call",
      call_id: "historical-with-unrelated-tool",
      namespace: "mcp__rzmcp",
      name: "blueprint_inspect",
      arguments: "{}",
    }],
    tools: [{ type: "function", name: "unrelated", parameters: { type: "object", properties: {} } }],
    stream: true,
    max_output_tokens: 8,
  });
  const unrelatedHistoricalRequest = openCodeChatRequest(
    unrelatedHistoricalNormalized.body,
    unrelatedHistoricalNormalized.customTools,
  );
  if (
    unrelatedHistoricalRequest.body.messages[0]?.tool_calls?.[0]?.function?.name !== "mcp__rzmcp__blueprint_inspect" ||
    unrelatedHistoricalRequest.body.tools?.length !== 1 ||
    unrelatedHistoricalRequest.body.tools[0]?.function?.name !== "unrelated"
  ) {
    throw new Error("self-test failed: historical OpenCode replay must not become callable");
  }
  const longHistoricalNamespace = `namespace_${"n".repeat(80)}`;
  const longHistoricalName = `tool_${"x".repeat(80)}`;
  const longHistoricalNormalized = normalizeOpenCodeRequest({
    model: "opencode/x-preview-f-free",
    input: [{
      type: "function_call",
      call_id: "long-historical-namespace",
      namespace: longHistoricalNamespace,
      name: longHistoricalName,
      arguments: "{}",
    }],
    stream: true,
    max_output_tokens: 8,
  });
  const longHistoricalRequest = openCodeChatRequest(longHistoricalNormalized.body, longHistoricalNormalized.customTools);
  const longHistoricalWireName = longHistoricalRequest.body.messages[0]?.tool_calls?.[0]?.function?.name;
  const longHistoricalFullName = `${longHistoricalNamespace}__${longHistoricalName}`;
  const longHistoricalSuffix = `__${createHash("sha256").update(longHistoricalFullName).digest("hex").slice(0, 12)}`;
  if (longHistoricalWireName?.length !== 64 || !longHistoricalWireName.endsWith(longHistoricalSuffix)) {
    throw new Error("self-test failed: long historical OpenCode namespace replay");
  }
  const historicalCustomNormalized = normalizeOpenCodeRequest({
    model: "opencode/x-preview-f-free",
    input: [
      {
        type: "custom_tool_call",
        call_id: "historical-custom",
        namespace: "mcp__rzmcp",
        name: "historical_patch",
        input: "*** Begin Patch",
      },
      { type: "custom_tool_call_output", call_id: "historical-custom", output: "done" },
    ],
    stream: true,
    max_output_tokens: 8,
  });
  const historicalCustomRequest = openCodeChatRequest(historicalCustomNormalized.body, historicalCustomNormalized.customTools);
  if (
    historicalCustomRequest.body.messages[0]?.tool_calls?.[0]?.function?.name !== "mcp__rzmcp__historical_patch" ||
    historicalCustomRequest.body.messages[0]?.tool_calls?.[0]?.function?.arguments !== jsonString({ input: "*** Begin Patch" }) ||
    historicalCustomRequest.body.messages[1]?.role !== "tool" ||
    historicalCustomRequest.body.tools !== undefined
  ) {
    throw new Error("self-test failed: historical OpenCode custom replay");
  }
  let historicalCollisionRejected = false;
  try {
    const historicalCollisionNormalized = normalizeOpenCodeRequest({
      model: "opencode/x-preview-f-free",
      input: [{
        type: "function_call",
        call_id: "historical-collision",
        namespace: "first_",
        name: "duplicate",
        arguments: "{}",
      }],
      tools: [{ type: "function", name: "first_duplicate", parameters: { type: "object", properties: {} } }],
      stream: true,
      max_output_tokens: 8,
    });
    openCodeChatRequest(historicalCollisionNormalized.body, historicalCollisionNormalized.customTools);
  } catch (error) {
    historicalCollisionRejected = error instanceof BridgeError && error.message.includes("collides with current function");
  }
  if (!historicalCollisionRejected) {
    throw new Error("self-test failed: historical OpenCode wire collision rejection");
  }
  let historicalSyntheticCallRejected = false;
  try {
    transformOpenCodeChatSseBlock(
      `data: ${jsonString({
        id: "chat",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: "synthetic-call",
              type: "function",
              function: { name: "mcp__rzmcp__blueprint_inspect", arguments: "{}" },
            }],
          },
        }],
      })}\n\n`,
      openCodeChatState("resp_historical_synthetic", "x-preview-f-free"),
      historicalNamespaceRequest.toolInfo,
    );
  } catch (error) {
    historicalSyntheticCallRejected = error instanceof BridgeError && error.status === 502 && error.message.includes("unknown tool call");
  }
  if (!historicalSyntheticCallRejected) {
    throw new Error("self-test failed: historical OpenCode tool must remain non-callable");
  }
  const historicalUnqualifiedNormalized = normalizeOpenCodeRequest({
    model: "opencode/x-preview-f-free",
    input: [
      {
        type: "custom_tool_call",
        call_id: "historical-exec",
        name: "exec",
        input: "return await tools.wait({});",
      },
      { type: "custom_tool_call_output", call_id: "historical-exec", output: "done" },
    ],
    tools: [{ type: "function", name: "wait", parameters: { type: "object", properties: {} } }],
    stream: true,
    max_output_tokens: 8,
  });
  const historicalUnqualifiedRequest = openCodeChatRequest(
    historicalUnqualifiedNormalized.body,
    historicalUnqualifiedNormalized.customTools,
  );
  if (
    historicalUnqualifiedRequest.body.messages[0]?.tool_calls?.[0]?.function?.name !== "exec" ||
    historicalUnqualifiedRequest.body.messages[1]?.role !== "tool" ||
    historicalUnqualifiedRequest.body.tools?.length !== 1 ||
    historicalUnqualifiedRequest.body.tools[0]?.function?.name !== "wait"
  ) {
    throw new Error("self-test failed: deferred top-level OpenCode tool replay");
  }
  let historicalUnqualifiedCallRejected = false;
  try {
    openCodeChatToolItem(
      { completedItems: [] },
      { callId: "new-exec", name: "exec", arguments: "{}" },
      historicalUnqualifiedRequest.toolInfo,
    );
  } catch (error) {
    historicalUnqualifiedCallRejected = error instanceof BridgeError && error.status === 502 && error.message.includes("unknown tool call");
  }
  if (!historicalUnqualifiedCallRejected) {
    throw new Error("self-test failed: historical top-level OpenCode tool must remain non-callable");
  }
  const parseSseData = (stream) => stream
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  const completedOutputTypes = (stream) => {
    const completedEvent = parseSseData(stream).find((payload) => payload.type === "response.completed");
    return completedEvent?.response?.output?.map((item) => item.type);
  };
  const completedToolCount = (stream) => parseSseData(stream).filter(
    (payload) => payload.type === "response.output_item.done" && payload.item?.type === "custom_tool_call",
  ).length;
  const chatState = openCodeChatState("resp_self_test", "hy3-free");
  const chatChunks = [];
  const feedChat = (data) => {
    const transformed = transformOpenCodeChatSseBlock(`data: ${jsonString(data)}\n\n`, chatState, chatRequest.toolInfo);
    if (transformed) chatChunks.push(transformed);
  };
  feedChat({ id: "chat", choices: [{ index: 0, delta: { role: "assistant" } }] });
  feedChat({ id: "chat", choices: [{ index: 0, delta: { reasoning_content: "think" } }] });
  feedChat({ id: "chat", choices: [{ index: 0, delta: { content: "OK" } }] });
  feedChat({ id: "chat", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  feedChat({ id: "chat", choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
  const completed = transformOpenCodeChatSseBlock("data: [DONE]\n\n", chatState, chatRequest.toolInfo);
  chatChunks.push(completed);
  const chatOutput = chatChunks.join("");
  if (!chatOutput.includes("response.reasoning_summary_text.delta") || !chatOutput.includes("response.output_text.delta") || !chatOutput.includes("response.completed")) {
    throw new Error("self-test failed: OpenCode Chat SSE translation");
  }
  const textThenToolState = openCodeChatState("resp_text_then_tool", "x-preview-f-free");
  const textBeforeToolChunk = transformOpenCodeChatSseBlock(
    `data: ${jsonString({ id: "chat", choices: [{ index: 0, delta: { content: "Checking." } }] })}\n\n`,
    textThenToolState,
    chatRequest.toolInfo,
  );
  const toolAfterTextChunk = transformOpenCodeChatSseBlock(
    `data: ${jsonString({
      id: "chat",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: "tool-after-text",
            type: "function",
            function: { name: "apply_patch", arguments: jsonString({ input: "x" }) },
          }],
        },
        finish_reason: "tool_calls",
      }],
    })}\n\n`,
    textThenToolState,
    chatRequest.toolInfo,
  );
  const textThenToolDone = transformOpenCodeChatSseBlock("data: [DONE]\n\n", textThenToolState, chatRequest.toolInfo);
  const textThenToolStream = textBeforeToolChunk + toolAfterTextChunk + textThenToolDone;
  const textThenToolAddedAt = toolAfterTextChunk.indexOf('"type":"custom_tool_call"');
  if (
    !textBeforeToolChunk.includes("response.output_text.delta") ||
    toolAfterTextChunk.indexOf("response.output_text.done") < 0 ||
    textThenToolAddedAt < toolAfterTextChunk.indexOf("response.output_text.done") ||
    completedToolCount(textThenToolStream) !== 1 ||
    jsonString(completedOutputTypes(textThenToolStream)) !== jsonString(["message", "custom_tool_call"])
  ) {
    throw new Error("self-test failed: OpenCode text before tool-call translation");
  }
  const sameChunkTextToolState = openCodeChatState("resp_same_chunk_text_tool", "x-preview-f-free");
  const sameChunkTextTool = transformOpenCodeChatSseBlock(
    `data: ${jsonString({
      id: "chat",
      choices: [{
        index: 0,
        delta: {
          content: "Checking.",
          tool_calls: [{
            index: 0,
            id: "same-chunk-tool",
            type: "function",
            function: { name: "apply_patch", arguments: jsonString({ input: "x" }) },
          }],
        },
        finish_reason: "tool_calls",
      }],
    })}\n\n`,
    sameChunkTextToolState,
    chatRequest.toolInfo,
  );
  const sameChunkTextToolDone = transformOpenCodeChatSseBlock("data: [DONE]\n\n", sameChunkTextToolState, chatRequest.toolInfo);
  const sameChunkTextToolStream = sameChunkTextTool + sameChunkTextToolDone;
  const sameChunkToolAddedAt = sameChunkTextTool.indexOf('"type":"custom_tool_call"');
  if (
    sameChunkTextTool.indexOf("response.output_text.delta") < 0 ||
    sameChunkTextTool.indexOf("response.output_text.done") < sameChunkTextTool.indexOf("response.output_text.delta") ||
    sameChunkToolAddedAt < sameChunkTextTool.indexOf("response.output_text.done") ||
    completedToolCount(sameChunkTextToolStream) !== 1 ||
    jsonString(completedOutputTypes(sameChunkTextToolStream)) !== jsonString(["message", "custom_tool_call"])
  ) {
    throw new Error("self-test failed: OpenCode same-chunk text/tool translation");
  }
  const reasoningThenToolState = openCodeChatState("resp_reasoning_then_tool", "x-preview-f-free");
  const reasoningChunk = transformOpenCodeChatSseBlock(
    `data: ${jsonString({ id: "chat", choices: [{ index: 0, delta: { reasoning_content: "Inspecting." } }] })}\n\n`,
    reasoningThenToolState,
    chatRequest.toolInfo,
  );
  const toolAfterReasoningChunk = transformOpenCodeChatSseBlock(
    `data: ${jsonString({
      id: "chat",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: "tool-after-reasoning",
            type: "function",
            function: { name: "apply_patch", arguments: jsonString({ input: "x" }) },
          }],
        },
        finish_reason: "tool_calls",
      }],
    })}\n\n`,
    reasoningThenToolState,
    chatRequest.toolInfo,
  );
  const reasoningThenToolDone = transformOpenCodeChatSseBlock("data: [DONE]\n\n", reasoningThenToolState, chatRequest.toolInfo);
  const reasoningThenToolStream = reasoningChunk + toolAfterReasoningChunk + reasoningThenToolDone;
  if (
    toolAfterReasoningChunk.indexOf("response.reasoning_summary_text.done") < 0 ||
    toolAfterReasoningChunk.indexOf('"type":"custom_tool_call"') < toolAfterReasoningChunk.indexOf("response.reasoning_summary_text.done") ||
    completedToolCount(reasoningThenToolStream) !== 1 ||
    jsonString(completedOutputTypes(reasoningThenToolStream)) !== jsonString(["reasoning", "custom_tool_call"])
  ) {
    throw new Error("self-test failed: OpenCode reasoning before tool-call translation");
  }
  const legacyTextThenToolState = openCodeChatState("resp_legacy_text_then_tool", "x-preview-f-free");
  const legacyTextChunk = transformOpenCodeChatSseBlock(
    `data: ${jsonString({ id: "chat", choices: [{ index: 0, delta: { content: "Checking." } }] })}\n\n`,
    legacyTextThenToolState,
    chatRequest.toolInfo,
  );
  const legacyToolChunk = transformOpenCodeChatSseBlock(
    `data: ${jsonString({
      id: "chat",
      choices: [{
        index: 0,
        delta: { function_call: { name: "apply_patch", arguments: jsonString({ input: "x" }) } },
        finish_reason: "function_call",
      }],
    })}\n\n`,
    legacyTextThenToolState,
    chatRequest.toolInfo,
  );
  const legacyTextThenToolDone = transformOpenCodeChatSseBlock("data: [DONE]\n\n", legacyTextThenToolState, chatRequest.toolInfo);
  const legacyTextThenToolStream = legacyTextChunk + legacyToolChunk + legacyTextThenToolDone;
  if (
    legacyToolChunk.indexOf("response.output_text.done") < 0 ||
    legacyToolChunk.indexOf('"type":"custom_tool_call"') < legacyToolChunk.indexOf("response.output_text.done") ||
    completedToolCount(legacyTextThenToolStream) !== 1 ||
    jsonString(completedOutputTypes(legacyTextThenToolStream)) !== jsonString(["message", "custom_tool_call"])
  ) {
    throw new Error("self-test failed: OpenCode legacy text before function-call translation");
  }
  const emptyToolArrayState = openCodeChatState("resp_empty_tool_array", "x-preview-f-free");
  const textBeforeEmptyToolArray = transformOpenCodeChatSseBlock(
    `data: ${jsonString({ id: "chat", choices: [{ index: 0, delta: { content: "One" } }] })}\n\n`,
    emptyToolArrayState,
    chatRequest.toolInfo,
  );
  const emptyToolArrayChunk = transformOpenCodeChatSseBlock(
    `data: ${jsonString({ id: "chat", choices: [{ index: 0, delta: { tool_calls: [] } }] })}\n\n`,
    emptyToolArrayState,
    chatRequest.toolInfo,
  );
  const textAfterEmptyToolArray = transformOpenCodeChatSseBlock(
    `data: ${jsonString({ id: "chat", choices: [{ index: 0, delta: { content: " two" }, finish_reason: "stop" }] })}\n\n`,
    emptyToolArrayState,
    chatRequest.toolInfo,
  );
  const emptyToolArrayDone = transformOpenCodeChatSseBlock("data: [DONE]\n\n", emptyToolArrayState, chatRequest.toolInfo);
  const emptyToolArrayStream = textBeforeEmptyToolArray + emptyToolArrayChunk + textAfterEmptyToolArray + emptyToolArrayDone;
  if (
    emptyToolArrayChunk !== "" ||
    emptyToolArrayState.completedItems.length !== 1 ||
    emptyToolArrayState.completedItems[0]?.content?.[0]?.text !== "One two" ||
    jsonString(completedOutputTypes(emptyToolArrayStream)) !== jsonString(["message"])
  ) {
    throw new Error("self-test failed: empty OpenCode tool-call array must not split text");
  }
  const toolThenTextState = openCodeChatState("resp_tool_then_text", "x-preview-f-free");
  const toolBeforeTextChunk = transformOpenCodeChatSseBlock(
    `data: ${jsonString({
      id: "chat",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: "tool-before-text",
            type: "function",
            function: { name: "apply_patch", arguments: jsonString({ input: "x" }) },
          }],
        },
      }],
    })}\n\n`,
    toolThenTextState,
    chatRequest.toolInfo,
  );
  const firstTextAfterTool = transformOpenCodeChatSseBlock(
    `data: ${jsonString({ id: "chat", choices: [{ index: 0, delta: { content: "One" } }] })}\n\n`,
    toolThenTextState,
    chatRequest.toolInfo,
  );
  const secondTextAfterTool = transformOpenCodeChatSseBlock(
    `data: ${jsonString({ id: "chat", choices: [{ index: 0, delta: { content: " two" }, finish_reason: "stop" }] })}\n\n`,
    toolThenTextState,
    chatRequest.toolInfo,
  );
  const toolThenTextDone = transformOpenCodeChatSseBlock("data: [DONE]\n\n", toolThenTextState, chatRequest.toolInfo);
  const toolThenTextStream = toolBeforeTextChunk + firstTextAfterTool + secondTextAfterTool + toolThenTextDone;
  if (
    firstTextAfterTool.includes("response.output_text.done") ||
    toolThenTextState.completedItems.length !== 2 ||
    toolThenTextState.completedItems[1]?.content?.[0]?.text !== "One two" ||
    completedToolCount(toolThenTextStream) !== 1 ||
    jsonString(completedOutputTypes(toolThenTextStream)) !== jsonString(["custom_tool_call", "message"])
  ) {
    throw new Error("self-test failed: OpenCode text after tool-call must remain one output item");
  }
  const toolState = openCodeChatState("resp_tool_test", "hy3-free");
  const emptyContentChunk = transformOpenCodeChatSseBlock(
    `data: ${jsonString({ id: "chat", choices: [{ index: 0, delta: { content: "" } }] })}\n\n`,
    toolState,
    chatRequest.toolInfo,
  );
  if (emptyContentChunk !== "" || toolState.textItem !== null) {
    throw new Error("self-test failed: empty OpenCode Chat content suppression");
  }
  const toolPayload = {
    id: "chat",
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, id: "tool-1", type: "function", function: { name: "apply_patch", arguments: jsonString({ input: "x" }) } }] },
      finish_reason: "tool_calls",
    }],
  };
  const toolChunk = transformOpenCodeChatSseBlock(
    `data: ${jsonString(toolPayload)}\n\n`,
    toolState,
    chatRequest.toolInfo,
  );
  const trailingEmptyContentChunk = transformOpenCodeChatSseBlock(
    `data: ${jsonString({ id: "chat", choices: [{ index: 0, delta: { content: "" } }] })}\n\n`,
    toolState,
    chatRequest.toolInfo,
  );
  const toolDone = transformOpenCodeChatSseBlock("data: [DONE]\n\n", toolState, chatRequest.toolInfo);
  if (
    !toolChunk.includes('"type":"custom_tool_call"') ||
    trailingEmptyContentChunk !== "" ||
    toolState.textItem !== null ||
    !toolDone.includes("response.completed") ||
    !toolDone.includes('"input":"x"')
  ) {
    throw new Error("self-test failed: OpenCode Chat custom tool SSE translation");
  }
  process.stdout.write("commandcode-bridge self-test: ok\n");
}

function start() {
  const installation = readCommandCodeInstallation();
  const port = configuredPort();
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        jsonResponse(response, 200, {
          ok: true,
          commandCodeVersion: installation.version,
          openCodeSchemaAdapter: true,
          cursorAgentAdapter: true,
          cursorRuntime,
          port,
        });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/responses") {
        await handleResponses(request, response);
        return;
      }
      if (request.method === "POST" && request.url === "/opencode/v1/responses") {
        await handleOpenCodeResponses(request, response);
        return;
      }
      if (request.method === "POST" && request.url === "/cursor/v1/responses") {
        await handleCursorResponses(request, response);
        return;
      }
      jsonResponse(response, 404, {
        error: {
          type: "not_found",
          message: "Use GET /health, POST /v1/responses, POST /opencode/v1/responses, or POST /cursor/v1/responses",
        },
      });
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const status = error instanceof BridgeError ? error.status : 500;
      const message = error instanceof BridgeError ? error.message : `Bridge error: ${error.message}`;
      jsonResponse(response, status, { error: { type: "bridge_error", message: redactSecrets(message) } });
    }
  });

  server.on("error", (error) => {
    process.stderr.write(`commandcode-bridge: ${error.message}\n`);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`commandcode-bridge listening on 127.0.0.1:${port} (CommandCode ${installation.version})\n`);
  });
}

try {
  if (process.argv.includes("--self-test")) selfTest();
  else {
    exitWhenParentStops();
    start();
  }
} catch (error) {
  process.stderr.write(`commandcode-bridge startup failed: ${redactSecrets(error.message)}\n`);
  process.exitCode = 1;
}
