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

export function codeBuddyForwardBody(body, modelAlias, effort) {
  requireObject(body, "request body");
  return {
    ...body,
    model: modelAlias,
    stream: true,
    reasoning: { ...(body.reasoning || {}), effort },
  };
}

async function readBoundedResponse(response, maxResponseBytes) {
  if (!response.body) throw new ProviderRouteError("CodeBuddy bridge returned an empty HTTP body");
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > maxResponseBytes) {
      await response.body.cancel().catch(() => {});
      throw new ProviderRouteError(`CodeBuddy bridge response exceeded ${maxResponseBytes} bytes`);
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
    throw new ProviderRouteError(`CodeBuddy bridge returned malformed SSE JSON: ${error.message}`);
  }
  const payloadType = typeof payload?.type === "string" ? payload.type : null;
  if (eventName && payloadType && eventName !== payloadType) {
    throw new ProviderRouteError(`CodeBuddy bridge SSE event mismatch: event=${eventName} payload=${payloadType}`);
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

export function completedResponseFromSse(raw) {
  let completed = null;
  for (const event of parseResponsesSse(raw)) {
    if (event.type === "response.failed") {
      const error = event.payload?.response?.error;
      throw new ProviderRouteError(`CodeBuddy bridge failed: ${error?.message || error?.type || "unknown provider failure"}`);
    }
    if (event.type === "response.completed") {
      if (completed) throw new ProviderRouteError("CodeBuddy bridge returned more than one completed response");
      completed = event.payload?.response;
    }
  }
  if (!completed) throw new ProviderRouteError("CodeBuddy bridge ended without a completed response");
  return requireObject(completed, "CodeBuddy completed response");
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
    throw new ProviderRouteError(`CodeBuddy bridge request failed: ${error.message}`, 502, { cause: error });
  }
  if (!response.ok) {
    const raw = await readBoundedResponse(response, maxResponseBytes);
    const detail = raw.trim().slice(0, 2_000);
    throw new ProviderRouteError(`CodeBuddy bridge returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    throw new ProviderRouteError(`CodeBuddy bridge returned unexpected content type ${JSON.stringify(contentType)}`);
  }
  if (!response.body) throw new ProviderRouteError("CodeBuddy bridge returned an empty HTTP body");
  const decoder = new ResponsesSseDecoder();
  let completed = null;
  let totalBytes = 0;
  const accept = async (event) => {
    if (event.type === "response.failed") {
      const error = event.payload?.response?.error;
      throw new ProviderRouteError(
        `CodeBuddy bridge failed: ${error?.message || error?.type || "unknown provider failure"}`,
      );
    }
    if (event.type === "response.completed") {
      if (completed) throw new ProviderRouteError("CodeBuddy bridge returned more than one completed response");
      completed = requireObject(event.payload?.response, "CodeBuddy completed response");
    }
    await onEvent(event);
  };
  try {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      totalBytes += bytes.length;
      if (totalBytes > maxResponseBytes) {
        await response.body.cancel().catch(() => {});
        throw new ProviderRouteError(`CodeBuddy bridge response exceeded ${maxResponseBytes} bytes`);
      }
      for (const event of decoder.push(bytes)) await accept(event);
    }
    for (const event of decoder.finish()) await accept(event);
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw error;
    if (error instanceof ProviderRouteError) throw error;
    throw new ProviderRouteError(`CodeBuddy bridge stream failed: ${error.message}`, 502, { cause: error });
  }
  if (!completed) throw new ProviderRouteError("CodeBuddy bridge ended without a completed response");
  return completed;
}

export function validateCodeBuddyCompletion(completion, expected) {
  requireObject(completion, "CodeBuddy completed response");
  if (completion.status !== "completed") {
    throw new ProviderRouteError(`CodeBuddy returned response status ${JSON.stringify(completion.status)}`);
  }
  const metadata = requireObject(completion.metadata, "CodeBuddy response metadata");
  if (metadata.codebuddy_initialized_model !== expected.model) {
    throw new ProviderRouteError(
      `CodeBuddy initialized unexpected model ${JSON.stringify(metadata.codebuddy_initialized_model)}`,
    );
  }
  if (metadata.codebuddy_auth_source !== expected.authSource) {
    throw new ProviderRouteError(
      `CodeBuddy used unexpected auth source ${JSON.stringify(metadata.codebuddy_auth_source)}`,
    );
  }
  if (metadata.codebuddy_total_cost_usd !== 0) {
    throw new ProviderRouteError(
      `CodeBuddy reported non-zero or unknown explicit cost ${JSON.stringify(metadata.codebuddy_total_cost_usd)}`,
    );
  }
  if (!Array.isArray(completion.output) || completion.output.length === 0) {
    throw new ProviderRouteError("CodeBuddy completed without output items");
  }
  return completion;
}

export async function runQuotaFallbackChain({
  signal,
  runCodeBuddy,
  runTerminal,
  onCodeBuddyFailure = () => {},
}) {
  try {
    return { stage: "codebuddy", value: await runCodeBuddy(), codeBuddyError: null };
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError" || error?.status === 499) throw error;
    if (error?.routeCommitted === true) {
      onCodeBuddyFailure(error);
      throw error;
    }
    onCodeBuddyFailure(error);
    return { stage: "terminal", value: await runTerminal(error), codeBuddyError: error };
  }
}
