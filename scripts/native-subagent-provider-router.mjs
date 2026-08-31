const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export class ProviderRouteError extends Error {
  constructor(message, status = 502, options) {
    super(message, options);
    this.name = "ProviderRouteError";
    this.status = status;
  }
}

export class ActiveTaskRoutePins {
  #taskHashByThread = new Map();

  has(threadId, taskHash) {
    return typeof threadId === "string"
      && threadId.length > 0
      && typeof taskHash === "string"
      && taskHash.length > 0
      && this.#taskHashByThread.get(threadId) === taskHash;
  }

  pin(threadId, taskHash) {
    if (typeof threadId !== "string" || threadId.length === 0) return false;
    if (typeof taskHash !== "string" || taskHash.length === 0) return false;
    this.#taskHashByThread.set(threadId, taskHash);
    return true;
  }

  releaseAfterFinalResponse(threadId, taskHash, pendingToolCallCount) {
    if (pendingToolCallCount !== 0 || !this.has(threadId, taskHash)) return false;
    this.#taskHashByThread.delete(threadId);
    return true;
  }

  get size() {
    return this.#taskHashByThread.size;
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderRouteError(`${label} must be an object`);
  }
  return value;
}

export function fallbackForwardBody(body, modelAlias, effort) {
  requireObject(body, "request body");
  return {
    ...body,
    model: modelAlias,
    stream: true,
    reasoning: { ...(body.reasoning || {}), effort },
  };
}

async function readBoundedResponse(response, maxResponseBytes) {
  if (!response.body) throw new ProviderRouteError("Fallback bridge returned an empty HTTP body");
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > maxResponseBytes) {
      await response.body.cancel().catch(() => {});
      throw new ProviderRouteError(`Fallback bridge response exceeded ${maxResponseBytes} bytes`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseResponsesSseBlock(block) {
  if (!block.trim()) return null;
  let eventName = null;
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") eventName = value;
    if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  let payload;
  try {
    payload = JSON.parse(dataLines.join("\n"));
  } catch (error) {
    throw new ProviderRouteError(`Fallback bridge returned malformed SSE JSON: ${error.message}`);
  }
  const payloadType = typeof payload?.type === "string" ? payload.type : null;
  if (eventName && payloadType && eventName !== payloadType) {
    throw new ProviderRouteError(`Fallback bridge SSE event mismatch: event=${eventName} payload=${payloadType}`);
  }
  return { type: eventName || payloadType, payload };
}

class ResponsesSseDecoder {
  #buffer = "";
  #decoder = new TextDecoder();

  push(chunk) {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    return this.#drain(false);
  }

  finish() {
    this.#buffer += this.#decoder.decode();
    return this.#drain(true);
  }

  #drain(finished) {
    const events = [];
    for (;;) {
      const separator = /\r\n\r\n|\n\n|\r\r/.exec(this.#buffer);
      if (!separator) break;
      const event = parseResponsesSseBlock(this.#buffer.slice(0, separator.index));
      this.#buffer = this.#buffer.slice(separator.index + separator[0].length);
      if (event) events.push(event);
    }
    if (finished && this.#buffer.trim()) {
      const event = parseResponsesSseBlock(this.#buffer);
      this.#buffer = "";
      if (event) events.push(event);
    }
    return events;
  }
}

export function parseResponsesSse(raw) {
  const decoder = new ResponsesSseDecoder();
  return [...decoder.push(Buffer.from(String(raw))), ...decoder.finish()];
}

function providerFailure(error) {
  const failure = new ProviderRouteError(
    `Fallback bridge failed: ${error?.message || error?.type || "unknown provider failure"}`,
  );
  if (error?.code === "provider_state_changed") failure.routeCommitted = true;
  return failure;
}

export function completedResponseFromSse(raw) {
  let completed = null;
  for (const event of parseResponsesSse(raw)) {
    if (event.type === "response.failed") {
      const error = event.payload?.response?.error;
      throw providerFailure(error);
    }
    if (event.type === "response.completed") {
      if (completed) throw new ProviderRouteError("Fallback bridge returned more than one completed response");
      completed = event.payload?.response;
    }
  }
  if (!completed) throw new ProviderRouteError("Fallback bridge ended without a completed response");
  return requireObject(completed, "fallback completed response");
}

export async function runResponsesBridge({
  endpoint,
  body,
  signal,
  fetchImpl = globalThis.fetch,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  onEvent = async () => {},
}) {
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw error;
    throw new ProviderRouteError(`Fallback bridge request failed: ${error.message}`, 502, { cause: error });
  }
  if (!response.ok) {
    const raw = await readBoundedResponse(response, maxResponseBytes);
    const detail = raw.trim().slice(0, 2_000);
    throw new ProviderRouteError(`Fallback bridge returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    throw new ProviderRouteError(`Fallback bridge returned unexpected content type ${JSON.stringify(contentType)}`);
  }
  if (!response.body) throw new ProviderRouteError("Fallback bridge returned an empty HTTP body");
  const decoder = new ResponsesSseDecoder();
  let completed = null;
  let totalBytes = 0;
  const accept = async (event) => {
    if (event.type === "response.failed") {
      const error = event.payload?.response?.error;
      throw providerFailure(error);
    }
    if (event.type === "response.completed") {
      if (completed) throw new ProviderRouteError("Fallback bridge returned more than one completed response");
      completed = requireObject(event.payload?.response, "fallback completed response");
    }
    await onEvent(event);
  };
  try {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      totalBytes += bytes.length;
      if (totalBytes > maxResponseBytes) {
        await response.body.cancel().catch(() => {});
        throw new ProviderRouteError(`Fallback bridge response exceeded ${maxResponseBytes} bytes`);
      }
      for (const event of decoder.push(bytes)) await accept(event);
    }
    for (const event of decoder.finish()) await accept(event);
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw error;
    if (error instanceof ProviderRouteError) throw error;
    throw new ProviderRouteError(`Fallback bridge stream failed: ${error.message}`, 502, { cause: error });
  }
  if (!completed) throw new ProviderRouteError("Fallback bridge ended without a completed response");
  return completed;
}

export function validateOAuthFallbackCompletion(completion, expected) {
  requireObject(completion, "fallback completed response");
  if (completion.status !== "completed") {
    throw new ProviderRouteError(`Fallback provider returned response status ${JSON.stringify(completion.status)}`);
  }
  const metadata = requireObject(completion.metadata, "fallback response metadata");
  if (metadata.actual_provider !== expected.provider) {
    throw new ProviderRouteError(
      `Fallback bridge used unexpected provider ${JSON.stringify(metadata.actual_provider)}`,
    );
  }
  const expectedModels = Array.isArray(expected.models) ? expected.models : [expected.model];
  if (!expectedModels.includes(metadata.actual_model)) {
    throw new ProviderRouteError(
      `Fallback bridge initialized unexpected model ${JSON.stringify(metadata.actual_model)}`,
    );
  }
  if (metadata.auth_source !== expected.authSource) {
    throw new ProviderRouteError(
      `Fallback bridge used unexpected auth source ${JSON.stringify(metadata.auth_source)}`,
    );
  }
  if (metadata.codex_tool_schema_bytes_forwarded !== 0 || metadata.lazy_rzmcp_proxy_tools !== 2) {
    throw new ProviderRouteError("Fallback bridge did not preserve lazy RzMCP tool serving");
  }
  if (!Array.isArray(completion.output) || completion.output.length === 0) {
    throw new ProviderRouteError("Fallback provider completed without output items");
  }
  return completion;
}

export async function runOrderedProviderChain({
  signal,
  stages,
  onStageFailure = () => {},
}) {
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new ProviderRouteError("Ordered provider chain must contain at least one stage", 500);
  }
  const failures = [];
  for (let index = 0; index < stages.length; index += 1) {
    const stage = requireObject(stages[index], `provider chain stage[${index}]`);
    if (typeof stage.name !== "string" || stage.name.length === 0) {
      throw new ProviderRouteError(`provider chain stage[${index}].name must be a non-empty string`, 500);
    }
    if (typeof stage.run !== "function") {
      throw new ProviderRouteError(`provider chain stage ${JSON.stringify(stage.name)} has no run function`, 500);
    }
    try {
      const value = await stage.run({ failures: [...failures], index });
      return { stage: stage.name, value, failures };
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError" || error?.status === 499) throw error;
      onStageFailure(stage.name, error, index);
      if (error?.routeCommitted === true || index === stages.length - 1) throw error;
      failures.push({ stage: stage.name, error });
    }
  }
  throw new ProviderRouteError("Ordered provider chain exhausted without a result", 500);
}
