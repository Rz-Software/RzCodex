import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_HEADER_COUNT = 64;
const HEADER_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const EXECUTION_METADATA_KEY = "rzcodex/execution";
const VALID_EFFECTS = new Set(["read", "write", "validation", "editor-control"]);
const VALID_RZMCP_MODES = new Set(["full", "no-validation", "read-only", "disabled"]);

const PROVIDER_CREDENTIALS = Object.freeze({
  openai: Object.freeze([
    "OPENAI_API_KEY", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "CODEX_API_KEY",
    "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_AD_TOKEN",
  ]),
  devin: Object.freeze(["DEVIN_API_KEY", "DEVIN_ORG_ID", "COGNITION_API_KEY"]),
  codebuddy: Object.freeze([
    "CODEBUDDY_API_KEY", "TENCENT_API_KEY", "TENCENTCLOUD_SECRET_ID",
    "TENCENTCLOUD_SECRET_KEY", "TENCENTCLOUD_SESSION_TOKEN",
  ]),
  opencode: Object.freeze(["OPENCODE_API_KEY", "OPENROUTER_API_KEY"]),
  commandcode: Object.freeze(["COMMAND_CODE_API_KEY"]),
  cursor: Object.freeze(["CURSOR_API_KEY"]),
  antigravity: Object.freeze(["GOOGLE_API_KEY", "GEMINI_API_KEY"]),
  ollama: Object.freeze(["OLLAMA_API_KEY"]),
});
const PROVIDER_CREDENTIAL_KEYS = new Set(Object.values(PROVIDER_CREDENTIALS).flat());
const BRIDGE_SECRET_KEYS = Object.freeze([
  "RZCODEX_BRIDGE_BEARER_TOKEN", "RZCODEX_BRIDGE_TOKEN", "BRIDGE_BEARER_TOKEN",
  "AUTHORIZATION", "HTTP_AUTHORIZATION",
]);
const SECRET_ENV_KEY = /(?:^|_)(?:API_KEY|ACCESS_KEY_ID|SECRET|SECRET_KEY|SECRET_ACCESS_KEY|CLIENT_SECRET|SESSION_TOKEN|ACCESS_TOKEN|AUTH_TOKEN|BEARER_TOKEN|TOKEN|PRIVATE_KEY|PASSWORD|CREDENTIALS)$/i;

export class BridgeSecurityError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = "BridgeSecurityError";
    this.statusCode = statusCode;
  }
}

export class BridgePolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "BridgePolicyError";
  }
}

export function codexHome(env = process.env, userHome = homedir()) {
  const configured = typeof env?.CODEX_HOME === "string" ? env.CODEX_HOME.trim() : "";
  return resolve(configured || join(userHome, ".codex"));
}

export function bridgeBearerTokenPath({ env = process.env, userHome = homedir(), tokenPath } = {}) {
  return resolve(tokenPath || join(codexHome(env, userHome), "bridge-security", "bearer-token"));
}

function validateToken(token) {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    throw new BridgeSecurityError("Bridge bearer token is missing or invalid");
  }
  return token;
}

export function loadBridgeBearerToken(options = {}) {
  const tokenPath = bridgeBearerTokenPath(options);
  let token;
  try {
    token = readFileSync(tokenPath, "utf8").trim();
  } catch (error) {
    const failure = new BridgeSecurityError(`Bridge bearer token is unavailable: ${error.code || "read failed"}`);
    failure.code = error.code;
    throw failure;
  }
  return validateToken(token);
}

export function setupBridgeBearerToken(options = {}) {
  const tokenPath = bridgeBearerTokenPath(options);
  try {
    return loadBridgeBearerToken({ ...options, tokenPath });
  } catch (error) {
    if (!(error instanceof BridgeSecurityError) || error.code !== "ENOENT") throw error;
  }

  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  let descriptor;
  let setupError;
  try {
    descriptor = openSync(tokenPath, "wx", 0o600);
    writeFileSync(descriptor, `${token}\n`, "utf8");
  } catch (error) {
    setupError = error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (setupError?.code === "EEXIST") return loadBridgeBearerToken({ ...options, tokenPath });
  if (setupError) {
    if (descriptor !== undefined) {
      try { unlinkSync(tokenPath); } catch { /* The setup error remains authoritative. */ }
    }
    throw new BridgeSecurityError(`Bridge bearer token setup failed: ${setupError.code || "write failed"}`);
  }
  return token;
}

function constantTimeEqual(left, right) {
  const leftDigest = createHash("sha256").update(String(left)).digest();
  const rightDigest = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function bridgeAuthorizationHeaders(token, existingHeaders = {}) {
  validateToken(token);
  const headers = { ...existingHeaders };
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "authorization") delete headers[key];
  }
  headers.authorization = `Bearer ${token}`;
  return headers;
}

function headerOccurrences(request, targetName) {
  const rawHeaders = Array.isArray(request?.rawHeaders) ? request.rawHeaders : [];
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index]).toLowerCase() === targetName) count += 1;
  }
  return count;
}

function headerSize(request) {
  const rawHeaders = Array.isArray(request?.rawHeaders) ? request.rawHeaders : [];
  if (rawHeaders.length > 0) {
    return rawHeaders.reduce((total, value) => total + Buffer.byteLength(String(value)) + 2, 0);
  }
  return Object.entries(request?.headers || {}).reduce(
    (total, [name, value]) => total + Buffer.byteLength(name) + Buffer.byteLength(String(value)) + 4,
    0,
  );
}

export function isLoopbackAddress(address) {
  if (typeof address !== "string") return false;
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::1") return true;
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  return /^127(?:\.\d{1,3}){3}$/.test(ipv4)
    && ipv4.split(".").slice(1).every((part) => Number(part) <= 255);
}

function validationResult(ok, statusCode, message) {
  return Object.freeze({ ok, statusCode, message });
}

export function validateBridgeRequest(request, { token, maxHeaderBytes = MAX_HEADER_BYTES } = {}) {
  validateToken(token);
  const rawHeaderCount = Array.isArray(request?.rawHeaders)
    ? Math.floor(request.rawHeaders.length / 2)
    : Object.keys(request?.headers || {}).length;
  if (rawHeaderCount > MAX_HEADER_COUNT || headerSize(request) > maxHeaderBytes) {
    return validationResult(false, 431, "Request headers are too large");
  }
  if (!isLoopbackAddress(request?.socket?.remoteAddress)) {
    return validationResult(false, 403, "Loopback access is required");
  }
  if (request?.headers?.origin !== undefined) {
    return validationResult(false, 403, "Browser-origin requests are not accepted");
  }
  if (String(request?.method || "").toUpperCase() === "POST") {
    const mediaType = String(request?.headers?.["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
    if (mediaType !== "application/json") {
      return validationResult(false, 415, "POST requests require application/json");
    }
  }
  if (headerOccurrences(request, "authorization") > 1) {
    return validationResult(false, 401, "Bridge authentication failed");
  }
  const authorization = request?.headers?.authorization;
  const supplied = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (!constantTimeEqual(supplied, token)) {
    return validationResult(false, 401, "Bridge authentication failed");
  }
  return validationResult(true, 200, "ok");
}

export function createAuthenticatedBridgeServer(listener, { token } = {}) {
  validateToken(token);
  if (typeof listener !== "function") throw new BridgeSecurityError("Bridge listener must be a function");
  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (request, response) => {
    const validation = validateBridgeRequest(request, { token });
    if (!validation.ok) {
      response.writeHead(validation.statusCode, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        connection: "close",
      });
      response.end(`${JSON.stringify({ error: validation.message })}\n`);
      return;
    }
    Promise.resolve().then(() => listener(request, response)).catch(() => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(`${JSON.stringify({ error: "Bridge request failed" })}\n`);
    });
  });
  server.maxHeadersCount = MAX_HEADER_COUNT;
  server.headersTimeout = HEADER_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}

export function sanitizeChildEnvironment(
  source = process.env,
  { credentialScope = "none", overrides = {} } = {},
) {
  if (credentialScope !== "none" && !Object.hasOwn(PROVIDER_CREDENTIALS, credentialScope)) {
    throw new BridgeSecurityError(`Unknown child credential scope ${JSON.stringify(credentialScope)}`);
  }
  const allowed = new Set(credentialScope === "none" ? [] : PROVIDER_CREDENTIALS[credentialScope]);
  const env = { ...source, ...overrides, NO_COLOR: "1" };
  const bridgeSecrets = new Set(BRIDGE_SECRET_KEYS);
  for (const key of Object.keys(env)) {
    const normalizedKey = key.toUpperCase();
    if (bridgeSecrets.has(normalizedKey)) {
      delete env[key];
      continue;
    }
    if (
      (PROVIDER_CREDENTIAL_KEYS.has(normalizedKey) || SECRET_ENV_KEY.test(normalizedKey))
      && !allowed.has(normalizedKey)
    ) delete env[key];
  }
  return env;
}

export function executionPolicy({ readOnly = false, validationRestricted = false, rzMcpMode } = {}) {
  if (typeof readOnly !== "boolean" || typeof validationRestricted !== "boolean") {
    throw new BridgePolicyError("Execution-policy restrictions must be booleans");
  }
  const mode = rzMcpMode ?? (readOnly ? "read-only" : validationRestricted ? "no-validation" : "full");
  if (!VALID_RZMCP_MODES.has(mode)) throw new BridgePolicyError(`Unknown RzMCP mode ${JSON.stringify(mode)}`);
  if (readOnly && !new Set(["read-only", "disabled"]).has(mode)) {
    throw new BridgePolicyError(`Read-only work cannot use RzMCP mode ${JSON.stringify(mode)}`);
  }
  if (validationRestricted && mode === "full") {
    throw new BridgePolicyError("Validation-restricted work cannot use full RzMCP mode");
  }
  return Object.freeze({ readOnly, validationRestricted, rzMcpMode: mode });
}

export function providerBoundaryRequirements(policy) {
  const normalized = executionPolicy(policy);
  return Object.freeze({
    fileWrites: normalized.readOnly ? "disabled" : "unrestricted",
    shell: normalized.readOnly || normalized.validationRestricted ? "disabled" : "unrestricted",
    validationTools: normalized.readOnly || normalized.validationRestricted ? "disabled" : "unrestricted",
    editorControl: normalized.readOnly || normalized.validationRestricted ? "disabled" : "unrestricted",
  });
}

export function assertProviderBoundaryEnforceable(provider, actualBoundary, policy) {
  const requirements = providerBoundaryRequirements(policy);
  for (const [capability, requirement] of Object.entries(requirements)) {
    if (requirement === "disabled" && actualBoundary?.[capability] !== "disabled") {
      throw new BridgePolicyError(
        `${provider || "Provider"} cannot enforce this task: ${capability} must be disabled at the provider tool boundary`,
      );
    }
  }
  return executionPolicy(policy);
}

function executionMetadata(tool) {
  const metadata = tool?._meta?.[EXECUTION_METADATA_KEY];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || metadata.version !== 1) {
    throw new BridgePolicyError(`Tool ${JSON.stringify(tool?.name || "<unknown>")} has no authoritative execution metadata`);
  }
  return metadata;
}

function checkedEffects(effects, context) {
  if (!Array.isArray(effects) || effects.length === 0 || effects.some((effect) => !VALID_EFFECTS.has(effect))) {
    throw new BridgePolicyError(`${context} has invalid or empty execution effects`);
  }
  return effects;
}

function valuesAtPath(value, path, index = 0, started = false) {
  if (index === path.length) return { present: true, complete: true, values: [value] };
  if (!value || typeof value !== "object") return { present: started, complete: false, values: [] };
  const segment = path[index];
  if (segment === "*") {
    if (!Array.isArray(value) || value.length === 0) {
      return { present: started, complete: false, values: [] };
    }
    const children = value.map((entry) => valuesAtPath(entry, path, index + 1, true));
    return {
      present: true,
      complete: children.every((entry) => entry.complete),
      values: children.flatMap((entry) => entry.values),
    };
  }
  return Object.hasOwn(value, segment)
    ? valuesAtPath(value[segment], path, index + 1, true)
    : { present: started, complete: false, values: [] };
}

function rulePathKey(path) {
  return JSON.stringify(path);
}

export function toolEffects(tool, args = {}) {
  const metadata = executionMetadata(tool);
  const defaultEffects = checkedEffects(metadata.defaultEffects, `Tool ${JSON.stringify(tool.name)} default`);
  if (metadata.argumentRules === undefined) return Object.freeze([...new Set(defaultEffects)]);
  if (!Array.isArray(metadata.argumentRules) || metadata.argumentRules.length === 0) {
    throw new BridgePolicyError(`Tool ${JSON.stringify(tool.name)} has invalid argument rules`);
  }
  const groups = new Map();
  for (const rule of metadata.argumentRules) {
    if (!Array.isArray(rule?.path) || rule.path.length === 0 || rule.path.some((part) => typeof part !== "string")) {
      throw new BridgePolicyError(`Tool ${JSON.stringify(tool.name)} has an invalid execution-rule path`);
    }
    if (!Array.isArray(rule.values) || rule.values.length === 0) {
      throw new BridgePolicyError(`Tool ${JSON.stringify(tool.name)} has an execution rule without values`);
    }
    checkedEffects(rule.effects, `Tool ${JSON.stringify(tool.name)} execution rule`);
    if (rule.selector !== undefined && (typeof rule.selector !== "string" || !rule.selector.trim())) {
      throw new BridgePolicyError(`Tool ${JSON.stringify(tool.name)} has an invalid execution-rule selector`);
    }
    const key = rule.selector ? `selector:${rule.selector}` : `path:${rulePathKey(rule.path)}`;
    if (!groups.has(key)) groups.set(key, { paths: new Map(), rules: [] });
    const group = groups.get(key);
    group.paths.set(rulePathKey(rule.path), rule.path);
    group.rules.push(rule);
  }

  const resolvedEffects = new Set();
  for (const { paths, rules } of groups.values()) {
    const populatedPaths = [...paths.values()]
      .map((path) => ({ path, resolution: valuesAtPath(args, path) }))
      .filter((entry) => entry.resolution.present);
    if (populatedPaths.length !== 1 || !populatedPaths[0].resolution.complete) {
      const labels = [...paths.values()].map((path) => path.join(".")).join(" or ");
      throw new BridgePolicyError(`Tool ${JSON.stringify(tool.name)} requires exactly one execution selector at ${labels}`);
    }
    const [{ path, resolution: { values } }] = populatedPaths;
    const selectedPath = rulePathKey(path);
    for (const value of values) {
      const matches = rules.filter(
        (rule) => rulePathKey(rule.path) === selectedPath
          && rule.values.some((candidate) => Object.is(candidate, value)),
      );
      if (matches.length !== 1) {
        throw new BridgePolicyError(
          `Tool ${JSON.stringify(tool.name)} has an unknown or ambiguous execution selector at ${path.join(".")}`,
        );
      }
      for (const effect of matches[0].effects) resolvedEffects.add(effect);
    }
  }
  if (resolvedEffects.size === 0) {
    throw new BridgePolicyError(`Tool ${JSON.stringify(tool.name)} resolved no execution effects`);
  }
  return Object.freeze([...resolvedEffects]);
}

function effectsAllowed(policy, effects) {
  if (policy.readOnly || policy.rzMcpMode === "read-only") {
    return effects.every((effect) => effect === "read");
  }
  if (policy.validationRestricted || policy.rzMcpMode === "no-validation") {
    return effects.every((effect) => effect !== "validation" && effect !== "editor-control");
  }
  return true;
}

export function toolVisibleUnderPolicy(policy, tool) {
  const normalized = executionPolicy(policy);
  if (normalized.rzMcpMode === "disabled") return false;
  if (normalized.rzMcpMode === "full") return true;
  const metadata = executionMetadata(tool);
  checkedEffects(metadata.defaultEffects, `Tool ${JSON.stringify(tool.name)} default`);
  const candidates = metadata.argumentRules === undefined
    ? [checkedEffects(metadata.defaultEffects, `Tool ${JSON.stringify(tool.name)} default`)]
    : metadata.argumentRules.map((rule) => checkedEffects(rule.effects, `Tool ${JSON.stringify(tool.name)} execution rule`));
  return candidates.some((effects) => effectsAllowed(normalized, effects));
}

export function assertToolCallAllowed(policy, tool, args = {}) {
  const normalized = executionPolicy(policy);
  if (normalized.rzMcpMode === "disabled") {
    throw new BridgePolicyError("RzMCP is disabled for this task");
  }
  if (normalized.rzMcpMode === "full") return Object.freeze([]);
  const effects = toolEffects(tool, args);
  if (!effectsAllowed(normalized, effects)) {
    throw new BridgePolicyError(
      `Tool ${JSON.stringify(tool?.name || "<unknown>")} is not allowed by RzMCP mode ${normalized.rzMcpMode}`,
    );
  }
  return effects;
}
