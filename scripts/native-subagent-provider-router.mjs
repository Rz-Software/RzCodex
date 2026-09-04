const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_RECOVERED_PARTIAL_TEXT_CHARS = 64 * 1024;
const MAX_PROVIDER_DIAGNOSTIC_NAMES = 512;
const MAX_PROVIDER_DIAGNOSTIC_NAME_CHARS = 160;

export class ProviderRouteError extends Error {
  constructor(message, status = 502, options) {
    super(message, options);
    this.name = "ProviderRouteError";
    this.status = status;
  }
}

function validateTimeout(value, label) {
  if (value === undefined || value === null || value === 0) return 0;
  if (!Number.isFinite(value) || value <= 0) {
    throw new ProviderRouteError(`${label} must be a positive number`, 500);
  }
  return value;
}

function streamObservation() {
  return {
    responseId: null,
    responseModel: null,
    eventCount: 0,
    completedOutputItems: new Map(),
    partialText: new Map(),
  };
}

function observeStreamEvent(observation, event) {
  observation.eventCount += 1;
  const payload = event.payload || {};
  if (event.type === "response.created") {
    observation.responseId = payload.response?.id || observation.responseId;
    observation.responseModel = payload.response?.model || observation.responseModel;
  }
  if (
    ["response.incomplete", "response.completed"].includes(event.type)
    && Array.isArray(payload.response?.output)
  ) {
    observation.responseId = payload.response.id || observation.responseId;
    observation.responseModel = payload.response.model || observation.responseModel;
    for (let index = 0; index < payload.response.output.length; index += 1) {
      const item = payload.response.output[index];
      const terminalItemCompleted = event.type === "response.completed" || item?.status === "completed";
      if (terminalItemCompleted && !observation.completedOutputItems.has(index)) {
        observation.completedOutputItems.set(index, item);
      }
    }
  }
  if (event.type === "response.output_item.done" && payload.item && Number.isInteger(payload.output_index)) {
    observation.completedOutputItems.set(payload.output_index, payload.item);
  }
  if (event.type === "response.output_text.delta" && typeof payload.delta === "string" && payload.delta) {
    const itemId = typeof payload.item_id === "string" ? payload.item_id : `output-${payload.output_index ?? "unknown"}`;
    const previous = observation.partialText.get(itemId) || "";
    observation.partialText.set(
      itemId,
      `${previous}${payload.delta}`.slice(-MAX_RECOVERED_PARTIAL_TEXT_CHARS),
    );
  }
}

function attachStreamObservation(error, observation, recoverable = false) {
  error.responseId = observation.responseId;
  error.responseModel = observation.responseModel;
  error.observedEventCount = observation.eventCount;
  error.completedOutputItems = [...observation.completedOutputItems.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, item]) => item);
  error.partialOutputText = [...observation.partialText.values()].join("\n").slice(-MAX_RECOVERED_PARTIAL_TEXT_CHARS);
  if (recoverable) error.recoverableStreamFailure = true;
  return error;
}

function incompleteStreamError(observation, detail = "Fallback bridge ended without a completed response") {
  const error = new ProviderRouteError(detail);
  error.incompleteStream = true;
  return attachStreamObservation(error, observation, true);
}

function isMeaningfulStreamEvent(event) {
  if (event.type === "response.in_progress") {
    return typeof event.payload?.response?.metadata?.provider_activity === "string";
  }
  return event.type !== "response.created";
}

export function completedResponseFromRecoverableStream(error) {
  if (error?.recoverableStreamFailure !== true || !Array.isArray(error.completedOutputItems)) return null;
  const output = error.completedOutputItems.filter((item) => item?.type !== "reasoning");
  if (output.length === 0) return null;
  return {
    id: error.responseId || "resp_recovered_stream",
    object: "response",
    status: "completed",
    model: error.responseModel || "unknown",
    output,
    usage: {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    },
    metadata: { recovered_from_completed_stream_items: true },
    error: null,
    incomplete_details: null,
  };
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

export class ActiveTaskProviderPins {
  #pinsByThread = new Map();

  get(threadId, taskHash) {
    if (typeof threadId !== "string" || threadId.length === 0) return null;
    if (typeof taskHash !== "string" || taskHash.length === 0) return null;
    const pin = this.#pinsByThread.get(threadId);
    if (!pin) return null;
    if (pin.taskHash === taskHash) return pin.provider;
    this.#pinsByThread.delete(threadId);
    return null;
  }

  pin(threadId, taskHash, provider) {
    if (typeof threadId !== "string" || threadId.length === 0) return false;
    if (typeof taskHash !== "string" || taskHash.length === 0) return false;
    if (typeof provider !== "string" || provider.length === 0) return false;
    const current = this.#pinsByThread.get(threadId);
    if (current?.taskHash === taskHash && current.provider === provider) return false;
    this.#pinsByThread.set(threadId, { taskHash, provider });
    return true;
  }

  release(threadId, taskHash) {
    if (this.get(threadId, taskHash) === null) return false;
    this.#pinsByThread.delete(threadId);
    return true;
  }

  releaseAfterFinalResponse(threadId, taskHash, pendingToolCallCount) {
    if (pendingToolCallCount !== 0) return false;
    return this.release(threadId, taskHash);
  }

  get size() {
    return this.#pinsByThread.size;
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderRouteError(`${label} must be an object`);
  }
  return value;
}

function providerDiagnosticNames(...values) {
  const names = [];
  const seen = new Set();
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry !== "string") continue;
      const name = entry.trim().slice(0, MAX_PROVIDER_DIAGNOSTIC_NAME_CHARS);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
      if (names.length >= MAX_PROVIDER_DIAGNOSTIC_NAMES) return names;
    }
  }
  return names;
}

function providerDiagnosticCount(...values) {
  let count = 0;
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) count = Math.max(count, Math.trunc(number));
  }
  return count;
}

function providerDiagnosticNameCount(...values) {
  let count = 0;
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    count = Math.max(
      count,
      value.filter((entry) => typeof entry === "string" && entry.trim().length > 0).length,
    );
  }
  return count;
}

function providerLastDiagnosticName(explicitName, ...values) {
  if (typeof explicitName === "string" && explicitName.trim()) {
    return explicitName.trim().slice(0, MAX_PROVIDER_DIAGNOSTIC_NAME_CHARS);
  }
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const entry = value[index];
      if (typeof entry === "string" && entry.trim()) {
        return entry.trim().slice(0, MAX_PROVIDER_DIAGNOSTIC_NAME_CHARS);
      }
    }
  }
  return null;
}

// Failure payloads cross a loopback Responses/SSE boundary before the central router sees them.
// Preserve only bounded, non-content diagnostics: never prompts, tool arguments, output, or secrets.
export function providerFailureDiagnostics(error) {
  const nativeToolNames = providerDiagnosticNames(error?.nativeToolNames, error?.toolNames);
  const rzmcpTools = providerDiagnosticNames(error?.nativeRzMcpTools, error?.rzMcpTools);
  const nativeToolCalls = Math.max(
    providerDiagnosticNameCount(error?.nativeToolNames, error?.toolNames),
    providerDiagnosticCount(error?.toolCalls, error?.nativeToolCalls),
  );
  const mutationToolCalls = providerDiagnosticCount(
    error?.providerMutationCount,
    error?.mutationToolCalls,
  );
  return {
    native_tool_calls: nativeToolCalls,
    native_tool_names: nativeToolNames,
    last_completed_tool: providerLastDiagnosticName(
      error?.lastCompletedTool,
      error?.nativeToolNames,
      error?.toolNames,
    ),
    mutation_tool_calls: mutationToolCalls,
    rzmcp_tools_called: rzmcpTools,
    interrupted_stream_continuations: providerDiagnosticCount(error?.streamContinuations),
    peak_turn_context_tokens: providerDiagnosticCount(error?.peakContextTokens),
    provider_task_pin_preserved: error?.providerTaskPinPreserved === true,
    route_committed: error?.routeCommitted === true || nativeToolCalls > 0 || mutationToolCalls > 0,
  };
}

function attachProviderFailureDiagnostics(failure, error) {
  const diagnostics = error?.provider_diagnostics;
  if (!diagnostics || typeof diagnostics !== "object" || Array.isArray(diagnostics)) return failure;
  const toolNames = providerDiagnosticNames(diagnostics.native_tool_names);
  const rzmcpTools = providerDiagnosticNames(diagnostics.rzmcp_tools_called);
  failure.toolCalls = Math.max(
    toolNames.length,
    providerDiagnosticCount(diagnostics.native_tool_calls),
  );
  failure.nativeToolNames = toolNames;
  failure.toolNames = toolNames;
  failure.lastCompletedTool = providerLastDiagnosticName(diagnostics.last_completed_tool);
  failure.mutationToolCalls = providerDiagnosticCount(diagnostics.mutation_tool_calls);
  failure.providerMutationCount = failure.mutationToolCalls;
  failure.nativeRzMcpTools = rzmcpTools;
  failure.rzMcpTools = rzmcpTools;
  failure.streamContinuations = providerDiagnosticCount(diagnostics.interrupted_stream_continuations);
  failure.peakContextTokens = providerDiagnosticCount(diagnostics.peak_turn_context_tokens);
  if (diagnostics.provider_task_pin_preserved === true) failure.providerTaskPinPreserved = true;
  if (
    diagnostics.route_committed === true
    || failure.toolCalls > 0
    || failure.mutationToolCalls > 0
  ) failure.routeCommitted = true;
  return failure;
}

export function fallbackForwardBody(body, modelAlias, effort, workingDirectory) {
  requireObject(body, "request body");
  const forwarded = {
    ...body,
    model: modelAlias,
    stream: true,
    reasoning: { ...(body.reasoning || {}), effort },
  };
  if (workingDirectory !== undefined) {
    if (typeof workingDirectory !== "string" || !workingDirectory) {
      throw new ProviderRouteError("forwarded provider working directory must be a non-empty string");
    }
    forwarded.client_metadata = {
      ...(body.client_metadata || {}),
      cwd: workingDirectory,
    };
  }
  return forwarded;
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
  return attachProviderFailureDiagnostics(failure, error);
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
  inactivityTimeoutMs = 0,
  requestTimeoutMs = 0,
  onEvent = async () => {},
}) {
  const inactivityMs = validateTimeout(inactivityTimeoutMs, "inactivityTimeoutMs");
  const requestMs = validateTimeout(requestTimeoutMs, "requestTimeoutMs");
  const controller = new AbortController();
  const observation = streamObservation();
  let localAbortError = null;
  let inactivityTimer = null;
  let requestTimer = null;
  const abortWith = (error) => {
    if (controller.signal.aborted) return;
    localAbortError = attachStreamObservation(error, observation, true);
    controller.abort(error);
  };
  const resetInactivityTimer = () => {
    if (!inactivityMs) return;
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => abortWith(new ProviderRouteError(
      `Fallback bridge stream was silent for ${inactivityMs}ms`,
      504,
    )), inactivityMs);
    inactivityTimer.unref?.();
  };
  const onParentAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) onParentAbort();
  else signal?.addEventListener("abort", onParentAbort, { once: true });
  if (requestMs) {
    requestTimer = setTimeout(() => abortWith(new ProviderRouteError(
      `Fallback bridge recovery exceeded ${requestMs}ms`,
      504,
    )), requestMs);
    requestTimer.unref?.();
  }
  resetInactivityTimer();
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(inactivityTimer);
    clearTimeout(requestTimer);
    signal?.removeEventListener("abort", onParentAbort);
    if (localAbortError) throw localAbortError;
    if (signal?.aborted || error?.name === "AbortError") throw error;
    throw new ProviderRouteError(`Fallback bridge request failed: ${error.message}`, 502, { cause: error });
  }
  try {
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
      observeStreamEvent(observation, event);
      if (event.type === "response.failed") {
        const error = event.payload?.response?.error;
        throw providerFailure(error);
      }
      if (event.type === "response.incomplete") {
        const reason = event.payload?.response?.incomplete_details?.reason;
        throw incompleteStreamError(
          observation,
          `Fallback bridge returned an incomplete response${reason ? `: ${reason}` : ""}`,
        );
      }
      if (event.type === "response.completed") {
        if (completed) throw new ProviderRouteError("Fallback bridge returned more than one completed response");
        completed = requireObject(event.payload?.response, "fallback completed response");
      }
      try {
        await onEvent(event);
      } catch (error) {
        throw new ProviderRouteError(`Fallback bridge event handler failed: ${error.message}`, 502, { cause: error });
      }
    };
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      totalBytes += bytes.length;
      if (totalBytes > maxResponseBytes) {
        await response.body.cancel().catch(() => {});
        throw new ProviderRouteError(`Fallback bridge response exceeded ${maxResponseBytes} bytes`);
      }
      for (const event of decoder.push(bytes)) {
        if (isMeaningfulStreamEvent(event)) resetInactivityTimer();
        await accept(event);
      }
    }
    for (const event of decoder.finish()) {
      if (isMeaningfulStreamEvent(event)) resetInactivityTimer();
      await accept(event);
    }
    if (!completed) throw incompleteStreamError(observation);
    return completed;
  } catch (error) {
    if (localAbortError) throw localAbortError;
    if (signal?.aborted || error?.name === "AbortError") throw error;
    if (error instanceof ProviderRouteError) throw error;
    throw attachStreamObservation(
      new ProviderRouteError(`Fallback bridge stream failed: ${error.message}`, 502, { cause: error }),
      observation,
      observation.eventCount > 0,
    );
  } finally {
    clearTimeout(inactivityTimer);
    clearTimeout(requestTimer);
    signal?.removeEventListener("abort", onParentAbort);
  }
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
  const expectedLazyRzMcpTools = expected.lazyRzMcpProxyTools ?? 2;
  if (
    metadata.codex_tool_schema_bytes_forwarded !== 0
    || metadata.lazy_rzmcp_proxy_tools !== expectedLazyRzMcpTools
  ) {
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
  pinnedStage = null,
  onStageFailure = () => {},
}) {
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new ProviderRouteError("Ordered provider chain must contain at least one stage", 500);
  }
  let runnableStages = stages;
  if (pinnedStage !== null) {
    if (typeof pinnedStage !== "string" || pinnedStage.length === 0) {
      throw new ProviderRouteError("Pinned provider stage must be a non-empty string", 500);
    }
    const pinned = stages.filter((stage) => stage?.name === pinnedStage);
    if (pinned.length !== 1) {
      throw new ProviderRouteError(
        `Pinned provider stage ${JSON.stringify(pinnedStage)} is not present exactly once in the configured chain`,
        500,
      );
    }
    runnableStages = pinned;
  }
  const failures = [];
  for (let index = 0; index < runnableStages.length; index += 1) {
    const stage = requireObject(runnableStages[index], `provider chain stage[${index}]`);
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
      error.failedStage ||= stage.name;
      if (pinnedStage !== null) {
        error.routeCommitted = true;
        error.providerTaskPinPreserved = true;
      }
      if (signal?.aborted || error?.name === "AbortError" || error?.status === 499) throw error;
      onStageFailure(stage.name, error, index);
      if (error?.routeCommitted === true || index === runnableStages.length - 1) throw error;
      failures.push({ stage: stage.name, error });
    }
  }
  throw new ProviderRouteError("Ordered provider chain exhausted without a result", 500);
}
