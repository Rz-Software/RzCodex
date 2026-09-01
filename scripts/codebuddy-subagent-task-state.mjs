import { createHash } from "node:crypto";

const NEW_TASK_HEADER = /^Message Type:\s*NEW_TASK\s*$/m;
const MESSAGE_HEADER = /^Message Type:\s*MESSAGE\s*$/m;
const TASK_NAME_HEADER = /^Task name:\s*(.+?)\s*$/m;
const PAYLOAD_HEADER = /(?:^|\n)Payload:\s*\n/;
const MUTATION_INTENT = /\b(?:implement|fix|patch|edit|modify|create|write|replace|delete|repair|refactor|apply_patch)\b/gi;
const NEGATED_MUTATION_PREFIX = /\b(?:do not|don't|must not|never|cannot|can't|not allowed to)\s+(?:[a-z][a-z0-9_-]*\s+){0,4}$/i;
const CHECKPOINT_REQUEST = /\b(?:checkpoint(?:\/report)?|status report|progress report)\b/i;
const IMMEDIATE_RETURN = /\b(?:return|report|respond)\b[\s\S]{0,80}\b(?:immediately|now|current|where)\b/i;
const NO_MUTATION_REASON = /(?:^|\n)NO_MUTATION_REASON:\s*(\{[^\r\n]+\})\s*(?:\r?\n|$)/;
const NO_MUTATION_CATEGORIES = new Set(["policy", "permission", "tool", "missing_input", "semantic"]);
const NON_TERMINAL_COMPLETION = /^(?:i(?:\s+need\s+to|\s+will|(?:'|’)ll|\s+am\s+going\s+to)|let\s+me|continuing\b|investigation\s+deferred\b|awaiting\b)/i;

export class TaskStateError extends Error {
  constructor(message) {
    super(message);
    this.name = "TaskStateError";
  }
}

export function isBridgeProgressReasoning(item) {
  return item?.type === "reasoning"
    && typeof item.id === "string"
    && item.id.startsWith("progress_");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TaskStateError(`${label} must be a non-empty string`);
  }
  return value;
}

function payloadFrom(text) {
  const match = PAYLOAD_HEADER.exec(text);
  return match ? text.slice(match.index + match[0].length) : text;
}

function isCheckpointRequest(text) {
  const payload = payloadFrom(text);
  return CHECKPOINT_REQUEST.test(payload) && IMMEDIATE_RETURN.test(payload);
}

export function normalizeAgentMessageContent(content, label) {
  if (typeof content === "string") {
    const text = requireNonEmptyString(content, label);
    return {
      text,
      partTypes: ["string"],
      partLengths: [text.length],
      deliveryMode: "plaintext",
    };
  }
  if (!Array.isArray(content) || content.length === 0) {
    throw new TaskStateError(`${label} must be a non-empty string or content array`);
  }
  const texts = [];
  const partTypes = [];
  const partLengths = [];
  let encryptedParts = 0;
  for (let index = 0; index < content.length; index += 1) {
    const part = content[index];
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      throw new TaskStateError(`${label}[${index}] must be an object`);
    }
    const type = requireNonEmptyString(part.type, `${label}[${index}].type`);
    let text;
    if (["input_text", "output_text", "text"].includes(type)) {
      text = requireNonEmptyString(part.text, `${label}[${index}].text`);
    } else if (type === "encrypted_content") {
      text = requireNonEmptyString(
        part.encrypted_content,
        `${label}[${index}].encrypted_content`,
      );
      encryptedParts += 1;
    } else {
      throw new TaskStateError(
        `${label}[${index}] has unsupported inter-agent content type ${JSON.stringify(type)}`,
      );
    }
    texts.push(text);
    partTypes.push(type);
    partLengths.push(text.length);
  }
  return {
    text: texts.join(""),
    partTypes,
    partLengths,
    deliveryMode: encryptedParts > 0 ? "encrypted_v2" : "plaintext_v2",
  };
}

function taskIntent(text) {
  const payload = payloadFrom(text);
  for (const match of payload.matchAll(MUTATION_INTENT)) {
    const prefix = payload.slice(Math.max(0, match.index - 80), match.index);
    if (!NEGATED_MUTATION_PREFIX.test(prefix)) return "mutation";
  }
  return "analysis";
}

function taskName(text, fallback) {
  return TASK_NAME_HEADER.exec(text)?.[1]?.trim() || fallback;
}

function messageState(item, index) {
  const normalized = normalizeAgentMessageContent(item.content, `input[${index}].content`);
  const newTask = NEW_TASK_HEADER.test(normalized.text);
  const checkpoint = isCheckpointRequest(normalized.text);
  return {
    ...normalized,
    index,
    id: typeof item.id === "string" && item.id
      ? item.id
      : `task-${sha256(normalized.text).slice(0, 16)}`,
    author: typeof item.author === "string" ? item.author : "Codex",
    recipient: typeof item.recipient === "string" ? item.recipient : "CodeBuddy worker",
    newTask,
    checkpoint,
  };
}

function outputText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return JSON.stringify(value);
  return value.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return JSON.stringify(part);
    return typeof part.text === "string" ? part.text : JSON.stringify(part);
  }).join("");
}

export function applyPatchSucceeded(output) {
  const exitCodeKnown = /(?:^|\n)Exit code:\s*0\s*(?:\n|$)/.test(output);
  return /(?:^|\n)Success\. Updated the following files:\s*(?:\n|$)/.test(output)
    && (exitCodeKnown || !/(?:^|\n)Exit code:/m.test(output));
}

export function changedPathsFromApplyPatch(output) {
  const paths = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*[AMD]\s+(.+?)\s*$/.exec(line);
    if (match) paths.push(match[1]);
  }
  return paths;
}

function progressFrom(input, activeTaskIndex) {
  const calls = new Map();
  const changedPaths = [];
  let toolCallsSinceTask = 0;
  let successfulMutationCount = 0;
  let lastCompletedTool = null;
  for (let index = activeTaskIndex + 1; index < input.length; index += 1) {
    const item = input[index];
    if (!item || typeof item !== "object") continue;
    if (["function_call", "custom_tool_call", "tool_search_call"].includes(item.type)) {
      const name = item.type === "tool_search_call" ? "tool_search" : item.name;
      if (typeof item.call_id === "string" && typeof name === "string") {
        calls.set(item.call_id, name);
      }
      toolCallsSinceTask += 1;
      continue;
    }
    if (!["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(item.type)) {
      continue;
    }
    const name = calls.get(item.call_id);
    if (name) lastCompletedTool = name;
    if (name !== "apply_patch") continue;
    const output = outputText(item.output);
    if (!applyPatchSucceeded(output)) continue;
    successfulMutationCount += 1;
    changedPaths.push(...changedPathsFromApplyPatch(output));
  }
  return {
    toolCallsSinceTask,
    successfulMutationCount,
    changedPaths: [...new Set(changedPaths)],
    lastCompletedTool,
  };
}

export function taskStateFromInput(input, maxActiveTaskChars) {
  if (!Array.isArray(input)) throw new TaskStateError("input must be an array");
  const messages = [];
  let activeTask = null;
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!item || typeof item !== "object" || item.type !== "agent_message") continue;
    const message = messageState(item, index);
    messages.push(message);
    if (message.newTask && !message.checkpoint) activeTask = message;
  }
  if (!activeTask) {
    return {
      activeTask: null,
      checkpointRequested: false,
      messages,
      progress: {
        toolCallsSinceTask: 0,
        successfulMutationCount: 0,
        changedPaths: [],
        lastCompletedTool: null,
      },
    };
  }
  if (activeTask.text.length > maxActiveTaskChars) {
    throw new TaskStateError(
      `active task ${activeTask.id} is ${activeTask.text.length} characters; maximum is ${maxActiveTaskChars}`,
    );
  }
  activeTask = {
    ...activeTask,
    hash: sha256(activeTask.text),
    name: taskName(activeTask.text, activeTask.recipient),
    intent: taskIntent(activeTask.text),
  };
  const latestControlMessage = messages
    .filter((message) => message.index > activeTask.index)
    .at(-1);
  const checkpointRequested = Boolean(
    latestControlMessage?.checkpoint
      && (MESSAGE_HEADER.test(latestControlMessage.text) || latestControlMessage.newTask),
  );
  return {
    activeTask,
    checkpointRequested,
    messages,
    progress: progressFrom(input, activeTask.index),
  };
}

function occurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

export function taskDeliveryDiagnostics(
  taskState,
  normalizedPrompt,
  { activeTaskIncludedThisTurn = true, retainedInProviderSession = false } = {},
) {
  const task = taskState.activeTask;
  if (!task) {
    return {
      taskId: null,
      taskName: null,
      taskHash: null,
      taskIntent: null,
      taskDeliveryMode: null,
      taskPartTypes: [],
      taskPartLengths: [],
      completeTaskOccurrences: 0,
      completeTaskDelivered: false,
      activeTaskIncludedThisTurn: false,
      retainedInProviderSession: false,
    };
  }
  const completeTaskOccurrences = occurrences(normalizedPrompt, task.text);
  const expectedOccurrences = activeTaskIncludedThisTurn ? 1 : 0;
  if (completeTaskOccurrences !== expectedOccurrences) {
    throw new TaskStateError(
      `active task ${task.id} normalized occurrence count is ${completeTaskOccurrences}; expected exactly ${expectedOccurrences}`,
    );
  }
  if (!activeTaskIncludedThisTurn && !retainedInProviderSession) {
    throw new TaskStateError(
      `active task ${task.id} was neither included this turn nor retained in the provider session`,
    );
  }
  return {
    taskId: task.id,
    taskName: task.name,
    taskHash: task.hash,
    taskIntent: task.intent,
    taskDeliveryMode: task.deliveryMode,
    taskPartTypes: task.partTypes,
    taskPartLengths: task.partLengths,
    completeTaskOccurrences,
    completeTaskDelivered: activeTaskIncludedThisTurn || retainedInProviderSession,
    activeTaskIncludedThisTurn,
    retainedInProviderSession,
  };
}

export function activeTaskPromptSection(taskState) {
  const task = taskState.activeTask;
  if (!task) return "";
  return `[Active delegated task - authoritative]\nTask ID: ${task.id}\nTask name: ${task.name}\nTask hash: ${task.hash}\nIntent: ${task.intent}\nDelivery mode: ${task.deliveryMode}\nComplete task follows exactly:\n${task.text}`;
}

export function progressPromptSection(taskState) {
  if (!taskState.activeTask) return "";
  const progress = taskState.progress;
  const paths = progress.changedPaths.length > 0 ? progress.changedPaths.join("\n") : "none";
  return `[Authoritative progress since active task]\nTool calls: ${progress.toolCallsSinceTask}\nSuccessful apply_patch mutations: ${progress.successfulMutationCount}\nChanged paths:\n${paths}\nLast completed tool: ${progress.lastCompletedTool ?? "none"}`;
}

export function mutationContractPromptSection(taskState) {
  if (taskState.activeTask?.intent !== "mutation") return "";
  return `[Mutation convergence contract]\nThe recorded apply_patch results above are authoritative. If you return a final answer while the recorded successful mutation count is zero, include exactly one single-line marker:\nNO_MUTATION_REASON: {"category":"policy|permission|tool|missing_input|semantic","detail":"specific blocker","resolvable_tool":null}\nDo not claim a blocker when you have already identified a safe in-scope tool call that resolves it; make that call instead. If resolvable_tool would not be null, continue the task rather than returning.`;
}

export function checkpointPromptSection(taskState) {
  if (!taskState.checkpointRequested) return "";
  return "[On-demand checkpoint requested]\nDo not start another tool call or investigation branch. Return the requested report now using the authoritative progress above, then wait for the parent to resume the active task.";
}

export function validateNoMutationCompletion(taskState, finalText, pendingCalls) {
  if (
    taskState.activeTask?.intent !== "mutation"
    || taskState.progress.successfulMutationCount > 0
    || pendingCalls.length > 0
    || !finalText
  ) {
    return null;
  }
  const match = NO_MUTATION_REASON.exec(finalText);
  if (!match) {
    throw new TaskStateError(
      `mutation task ${taskState.activeTask.id} ended with zero recorded mutations and no structured no_mutation_reason`,
    );
  }
  let reason;
  try {
    reason = JSON.parse(match[1]);
  } catch (error) {
    throw new TaskStateError(`no_mutation_reason is not valid JSON: ${error.message}`);
  }
  if (!NO_MUTATION_CATEGORIES.has(reason.category)) {
    throw new TaskStateError(`no_mutation_reason category is invalid: ${JSON.stringify(reason.category)}`);
  }
  if (typeof reason.detail !== "string" || reason.detail.trim().length === 0) {
    throw new TaskStateError("no_mutation_reason detail must be a non-empty string");
  }
  if (reason.resolvable_tool !== null) {
    throw new TaskStateError("no_mutation_reason is invalid because resolvable_tool is not null");
  }
  return {
    category: reason.category,
    detailHash: sha256(reason.detail),
    detailLength: reason.detail.length,
  };
}

export function validateTerminalCompletion(
  taskState,
  finalText,
  pendingCalls = [],
  { providerMutationCount = 0 } = {},
) {
  const text = typeof finalText === "string" ? finalText.trim() : "";
  if (pendingCalls.length > 0) return null;
  if (!text) {
    throw new TaskStateError("provider completed without a terminal report");
  }
  if (NON_TERMINAL_COMPLETION.test(text)) {
    throw new TaskStateError(
      "provider returned an intention or deferred-work preamble instead of a terminal result or concrete blocker",
    );
  }
  if (providerMutationCount > 0) return null;
  return validateNoMutationCompletion(taskState, text, pendingCalls);
}

export function authoritativeProgressReport(taskState, noMutationReason) {
  if (!taskState.activeTask) return "";
  const progress = taskState.progress;
  const paths = progress.changedPaths.length > 0 ? progress.changedPaths.join(", ") : "none";
  const reason = noMutationReason
    ? `${noMutationReason.category} (${noMutationReason.detailLength} chars, sha256 ${noMutationReason.detailHash})`
    : "none";
  return `[Authoritative Codex progress]\nTask ID: ${taskState.activeTask.id}\nTask hash: ${taskState.activeTask.hash}\nTool calls since task: ${progress.toolCallsSinceTask}\nSuccessful apply_patch mutations: ${progress.successfulMutationCount}\nChanged paths: ${paths}\nLast completed tool: ${progress.lastCompletedTool ?? "none"}\nRecorded no-mutation reason: ${reason}`;
}
