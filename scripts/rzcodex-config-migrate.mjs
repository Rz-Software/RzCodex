import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export const BRIDGE_PROVIDER_IDS = Object.freeze([
  "opencode",
  "commandcode",
  "cursor",
  "codebuddy",
  "devin",
  "ollama_native",
  "antigravity",
]);

export const AUTHENTICATED_HEALTH_ROUTES = Object.freeze([
  "auto",
  "codebuddy",
  "devin-free",
  "opencode",
  "commandcode",
  "cursor",
  "antigravity",
]);

function tomlLiteral(value) {
  return JSON.stringify(value);
}

function parseSectionHeader(line, lineNumber) {
  const arraySection = line.match(/^\s*\[\[([^\]]+)]]\s*(?:#.*)?$/);
  if (arraySection) return { name: arraySection[1].trim(), array: true };
  const section = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
  if (section) return { name: section[1].trim(), array: false };
  if (/^\s*\[/.test(line)) {
    throw new Error(`unsupported or malformed TOML section header at line ${lineNumber}`);
  }
  return null;
}

function classifyManagedProviderSection(section, lineNumber) {
  if (section === null) return null;
  if (section.array) return { kind: "other", provider: null };
  const base = section.name.match(/^model_providers\.([A-Za-z0-9_-]+)$/);
  const auth = section.name.match(/^model_providers\.([A-Za-z0-9_-]+)\.auth$/);
  if (base && BRIDGE_PROVIDER_IDS.includes(base[1])) return { kind: "base", provider: base[1] };
  if (auth && BRIDGE_PROVIDER_IDS.includes(auth[1])) return { kind: "auth", provider: auth[1] };

  if (
    section.name.startsWith("model_providers.") &&
    /["']/.test(section.name) &&
    BRIDGE_PROVIDER_IDS.some((provider) => section.name.includes(provider))
  ) {
    throw new Error(`quoted managed provider section is unsupported at line ${lineNumber}: ${section.name}`);
  }
  return { kind: "other", provider: null };
}

export function migrateProviderAuthToml(contents, tokenScriptPath) {
  if (typeof contents !== "string" || contents.length === 0) throw new TypeError("config contents must be non-empty text");
  if (typeof tokenScriptPath !== "string" || tokenScriptPath.length === 0) throw new TypeError("token script path must be non-empty");

  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const lines = contents.split(/\r?\n/);
  const baseSectionCounts = new Map();
  const authSectionCounts = new Map();
  let activeBaseProvider = null;
  let skippingAuthSection = false;
  const output = [];

  for (const [index, line] of lines.entries()) {
    const section = parseSectionHeader(line, index + 1);
    if (section !== null) {
      const managed = classifyManagedProviderSection(section, index + 1);
      activeBaseProvider = managed.kind === "base" ? managed.provider : null;
      skippingAuthSection = managed.kind === "auth";
      if (activeBaseProvider) {
        const count = (baseSectionCounts.get(activeBaseProvider) ?? 0) + 1;
        baseSectionCounts.set(activeBaseProvider, count);
        if (count > 1) throw new Error(`duplicate managed provider section: model_providers.${activeBaseProvider}`);
      }
      if (skippingAuthSection) {
        const count = (authSectionCounts.get(managed.provider) ?? 0) + 1;
        authSectionCounts.set(managed.provider, count);
        if (count > 1) throw new Error(`duplicate managed provider auth section: model_providers.${managed.provider}.auth`);
      }
      if (skippingAuthSection) continue;
    }
    if (skippingAuthSection) continue;
    if (activeBaseProvider && /^\s*(?:env_key|experimental_bearer_token|auth)\s*=/.test(line)) continue;
    output.push(line);
  }

  const missing = BRIDGE_PROVIDER_IDS.filter((provider) => !baseSectionCounts.has(provider));
  if (missing.length > 0) throw new Error(`missing managed bridge provider sections: ${missing.join(", ")}`);
  while (output.length > 0 && output.at(-1) === "") output.pop();

  const authCwd = dirname(tokenScriptPath);
  for (const provider of BRIDGE_PROVIDER_IDS) {
    output.push(
      "",
      `[model_providers.${provider}.auth]`,
      'command = "node"',
      `args = [${tomlLiteral(tokenScriptPath)}]`,
      "timeout_ms = 5000",
      "refresh_interval_ms = 300000",
      `cwd = ${tomlLiteral(authCwd)}`,
    );
  }
  return `${output.join(newline)}${newline}`;
}

export function migrateRouteHealthAuth(contents) {
  const routesConfig = typeof contents === "string" ? JSON.parse(contents) : structuredClone(contents);
  if (!routesConfig || typeof routesConfig !== "object" || !routesConfig.routes || typeof routesConfig.routes !== "object") {
    throw new Error("subagent routes must contain a routes object");
  }
  for (const routeName of AUTHENTICATED_HEALTH_ROUTES) {
    if (!routesConfig.routes[routeName]) throw new Error(`missing managed health route ${routeName}`);
    routesConfig.routes[routeName].healthAuth = "bridgeBearer";
  }
  if (!routesConfig.routes.ollama) throw new Error("missing direct Ollama health route");
  routesConfig.routes.ollama.healthAuth = "none";
  return `${JSON.stringify(routesConfig, null, 2)}\n`;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name} value`);
  return process.argv[index + 1];
}

function main() {
  if (process.argv.includes("--config")) {
    process.stdout.write(migrateProviderAuthToml(
      readFileSync(argumentValue("--config"), "utf8"),
      argumentValue("--token-script"),
    ));
    return;
  }
  if (process.argv.includes("--routes")) {
    process.stdout.write(migrateRouteHealthAuth(readFileSync(argumentValue("--routes"), "utf8")));
    return;
  }
  throw new Error("expected --config <path> --token-script <path> or --routes <path>");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
