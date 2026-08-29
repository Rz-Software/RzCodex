#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const RZMCP_BRIDGE = "G:/QANGA/Plugins/RzDirectMCP/Source/RzMCP/rzmcp-bridge.mjs";
const MAX_SEARCH_RESULTS = 5;
const MAX_SEARCH_OUTPUT_BYTES = 96 * 1024;
const STDERR_LIMIT = 8 * 1024;

class ProxyError extends Error {}

function json(value) {
  return JSON.stringify(value);
}

function write(value) {
  process.stdout.write(`${json(value)}\n`);
}

function result(id, value) {
  write({ jsonrpc: "2.0", id, result: value });
}

function failure(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function normalizedWords(value) {
  return String(value).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function scoreTool(tool, query) {
  const normalizedQuery = query.trim().toLowerCase();
  const name = tool.name.toLowerCase();
  const description = typeof tool.description === "string" ? tool.description.toLowerCase() : "";
  if (name === normalizedQuery) return 10_000;
  if (name.startsWith(normalizedQuery)) return 8_000 - name.length;
  if (name.includes(normalizedQuery)) return 6_000 - name.length;
  const words = normalizedWords(normalizedQuery);
  const nameWords = new Set(normalizedWords(name));
  const nameHits = words.filter((word) => nameWords.has(word)).length;
  const descriptionHits = words.filter((word) => description.includes(word)).length;
  if (nameHits === 0 && descriptionHits === 0) return 0;
  return (nameHits * 500) + (descriptionHits * 50) - name.length;
}

export function searchCatalog(tools, query, requestedLimit = 3) {
  if (typeof query !== "string" || query.trim().length < 2) {
    throw new ProxyError("query must contain at least two non-whitespace characters");
  }
  const limit = Math.min(
    MAX_SEARCH_RESULTS,
    Math.max(1, Number.isInteger(requestedLimit) ? requestedLimit : 3),
  );
  const exact = tools.find((tool) => tool.name.toLowerCase() === query.trim().toLowerCase());
  if (exact) {
    return [{
      name: exact.name,
      description: typeof exact.description === "string" ? exact.description : "",
      inputSchema: exact.inputSchema ?? { type: "object", additionalProperties: true },
    }];
  }
  return tools
    .map((tool) => ({ tool, score: scoreTool(tool, query) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
    .slice(0, limit)
    .map(({ tool }) => ({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: tool.inputSchema ?? { type: "object", additionalProperties: true },
    }));
}

class RzMcpClient {
  constructor() {
    if (!existsSync(RZMCP_BRIDGE)) {
      throw new ProxyError(`RzMCP bridge is missing at ${RZMCP_BRIDGE}`);
    }
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stdout = "";
    this.stderr = "";
    this.tools = null;
  }

  async start() {
    if (this.child) return;
    this.child = spawn(process.execPath, [RZMCP_BRIDGE], {
      cwd: "G:/QANGA",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-STDERR_LIMIT);
    });
    this.child.once("error", (error) => this.rejectAll(`RzMCP failed to start: ${error.message}`));
    this.child.once("close", (code) => {
      this.rejectAll(`RzMCP exited with code ${code}${this.stderr ? `: ${this.stderr.trim()}` : ""}`);
      this.child = null;
    });
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "rzcodex-devin-lazy-proxy", version: "1.0.0" },
    });
    this.notify("notifications/initialized", {});
  }

  consume(chunk) {
    this.stdout += chunk;
    for (;;) {
      const newline = this.stdout.indexOf("\n");
      if (newline < 0) break;
      const line = this.stdout.slice(0, newline).trim();
      this.stdout = this.stdout.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.stderr = `${this.stderr}${line}\n`.slice(-STDERR_LIMIT);
        continue;
      }
      if (message.id === undefined) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new ProxyError(message.error.message || json(message.error)));
      else pending.resolve(message.result);
    }
  }

  rejectAll(message) {
    for (const pending of this.pending.values()) pending.reject(new ProxyError(message));
    this.pending.clear();
  }

  request(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${json({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${json({ jsonrpc: "2.0", method, params })}\n`);
  }

  async catalog() {
    await this.start();
    if (this.tools) return this.tools;
    const tools = [];
    let cursor;
    do {
      const page = await this.request("tools/list", cursor ? { cursor } : {});
      if (!Array.isArray(page?.tools)) throw new ProxyError("RzMCP returned an invalid tools/list response");
      tools.push(...page.tools);
      cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
    } while (cursor);
    this.tools = tools;
    return tools;
  }

  async call(name, args) {
    await this.start();
    return this.request("tools/call", { name, arguments: args });
  }

  close() {
    if (this.child && !this.child.killed) this.child.kill();
  }
}

const PROXY_TOOLS = [
  {
    name: "search_rzmcp_tools",
    description: "Search the RzMCP catalog lazily. Use an exact tool name when known. Returns only a small bounded set of matching schemas; unrelated RzMCP tools are never injected.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Exact tool name or a focused capability phrase." },
        limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS, default: 3 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "call_rzmcp_tool",
    description: "Call one RzMCP tool that was returned by search_rzmcp_tools in this session. Pass the exact discovered name and arguments matching its returned input schema.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact previously discovered RzMCP tool name." },
        arguments: { type: "object", additionalProperties: true },
      },
      required: ["name", "arguments"],
      additionalProperties: false,
    },
  },
];

function selfTest() {
  const tools = [
    { name: "get_project_info", description: "Get project info", inputSchema: { type: "object" } },
    { name: "search_project_index", description: "Search the project asset index", inputSchema: { type: "object" } },
    { name: "spawn_actor", description: "Spawn an actor", inputSchema: { type: "object" } },
  ];
  const exact = searchCatalog(tools, "get_project_info", 5);
  if (exact.length !== 1 || exact[0].name !== "get_project_info") throw new Error("exact search failed");
  const focused = searchCatalog(tools, "project index", 1);
  if (focused.length !== 1 || focused[0].name !== "search_project_index") throw new Error("focused search failed");
  if (Buffer.byteLength(json(PROXY_TOOLS)) > 4 * 1024) throw new Error("proxy tool surface is unexpectedly large");
  process.stdout.write("devin-rzmcp-lazy-proxy self-test: ok\n");
}

if (process.argv.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

const client = new RzMcpClient();
const discovered = new Set();

async function handle(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) || message.id === undefined) return;
  if (message.method === "initialize") {
    result(message.id, {
      protocolVersion: message.params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "rzcodex-rzmcp-lazy", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "ping") {
    result(message.id, {});
    return;
  }
  if (message.method === "tools/list") {
    result(message.id, { tools: PROXY_TOOLS });
    return;
  }
  if (message.method !== "tools/call") {
    failure(message.id, -32601, `Method not found: ${message.method}`);
    return;
  }
  try {
    const name = message.params?.name;
    const args = message.params?.arguments;
    if (name === "search_rzmcp_tools") {
      const matches = searchCatalog(await client.catalog(), args?.query, args?.limit);
      const text = json({ matches });
      if (Buffer.byteLength(text) > MAX_SEARCH_OUTPUT_BYTES) {
        throw new ProxyError(`focused search output is ${Buffer.byteLength(text)} bytes; narrow the query or lower the limit`);
      }
      for (const match of matches) discovered.add(match.name);
      result(message.id, { content: [{ type: "text", text }], isError: false });
      return;
    }
    if (name === "call_rzmcp_tool") {
      const toolName = args?.name;
      if (typeof toolName !== "string" || !discovered.has(toolName)) {
        throw new ProxyError("RzMCP tool must be discovered with search_rzmcp_tools before it can be called");
      }
      if (!args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments)) {
        throw new ProxyError("arguments must be an object");
      }
      result(message.id, await client.call(toolName, args.arguments));
      return;
    }
    throw new ProxyError(`Unknown lazy proxy tool ${json(name)}`);
  } catch (error) {
    result(message.id, {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    });
  }
}

let pending = "";
let handling = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  for (;;) {
    const newline = pending.indexOf("\n");
    if (newline < 0) break;
    const line = pending.slice(0, newline).trim();
    pending = pending.slice(newline + 1);
    if (!line) continue;
    handling = handling.then(async () => {
      try {
        await handle(JSON.parse(line));
      } catch (error) {
        process.stderr.write(`devin-rzmcp-lazy-proxy: ${error.message}\n`);
      }
    });
  }
});
process.stdin.once("end", () => {
  client.close();
  process.exit(0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    client.close();
    process.exit(0);
  });
}
process.once("exit", () => client.close());
