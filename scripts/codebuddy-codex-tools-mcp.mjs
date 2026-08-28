#!/usr/bin/env node

import { readFileSync } from "node:fs";

const definitionsPath = process.argv[2];
if (!definitionsPath) {
  process.stderr.write("codebuddy-codex-tools-mcp: missing definitions path\n");
  process.exit(2);
}

let tools;
try {
  const parsed = JSON.parse(readFileSync(definitionsPath, "utf8"));
  if (!Array.isArray(parsed.tools)) throw new Error("tools must be an array");
  tools = parsed.tools;
} catch (error) {
  process.stderr.write(`codebuddy-codex-tools-mcp: ${error.message}\n`);
  process.exit(2);
}

const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function result(id, value) {
  write({ jsonrpc: "2.0", id, result: value });
}

function failure(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    result(message.id, {
      protocolVersion: message.params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "codex-client-tools", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "ping") {
    result(message.id, {});
    return;
  }
  if (message.method === "tools/list") {
    result(message.id, { tools });
    return;
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    if (typeof name !== "string" || !toolsByName.has(name)) {
      failure(message.id, -32602, `Unknown Codex client tool ${JSON.stringify(name)}`);
      return;
    }
    result(message.id, {
      content: [{
        type: "text",
        text: "DEFERRED_TO_CODEX_CLIENT: the parent Codex runtime will execute this call and resume with the real result. End this turn now without retrying or assuming a result.",
      }],
      isError: false,
    });
    return;
  }
  failure(message.id, -32601, `Method not found: ${message.method}`);
}

let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  for (;;) {
    const newline = pending.indexOf("\n");
    if (newline < 0) break;
    const line = pending.slice(0, newline).trim();
    pending = pending.slice(newline + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      process.stderr.write(`codebuddy-codex-tools-mcp: ${error.message}\n`);
    }
  }
});
