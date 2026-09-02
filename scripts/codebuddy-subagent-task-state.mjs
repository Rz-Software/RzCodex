import { createHash } from "node:crypto";

const NEW_TASK_HEADER = /^Message Type:\s*NEW_TASK\s*$/m;
const MESSAGE_HEADER = /^Message Type:\s*MESSAGE\s*$/m;
const TASK_NAME_HEADER = /^Task name:\s*(.+?)\s*$/m;
const PAYLOAD_HEADER = /(?:^|\n)Payload:\s*\n/;
const MUTATION_INTENT = /\b(?:implement|fix|patch|edit|modify|create|write|replace|delete|remove|repair|refactor|instrument|apply_patch)\b/gi;
const NEGATED_MUTATION_PREFIX = /\b(?:do not|don't|must not|never|cannot|can't|not allowed to)\s+(?:[a-z][a-z0-9_-]*\s+){0,4}$/i;
const EXPLICIT_READ_ONLY_TASK = /\bread[- ]only\b|\bno[- ]mutation\b|\bno\s+(?:edits?|modifications?|writes?|mutations?|file\s+changes|source\s+changes)\s*(?:[.;,/]|$)|\b(?:do not|must not|never)\s+(?:edit|modify|write|mutate)(?:\s+(?:any|the|source|project|workspace|files?)){0,3}(?:[.;,/]|$)/i;
const CHECKPOINT_DIRECTIVE = [
  /^\s*(?:please\s+)?(?:return|send|provide|give|report)\s+(?:(?:an?|the|your|current|immediate|brief|concise|requested)\s+){0,6}(?:checkpoint(?:\/report)?|status report|progress report)\b/i,
  /^\s*(?:please\s+)?(?:immediate\s+)?checkpoint(?:\/report)?\s*(?::|-|\bnow\b|\bimmediately\b)/i,
  /^\s*(?:please\s+)?(?:current|immediate|brief|concise)\s+(?:status report|progress report)\s*(?::|-|\bnow\b|\bimmediately\b)/i,
  /^\s*(?:please\s+)?(?:finish|complete)\b[^\n.!?]{0,120}\b(?:then|and)\s+(?:return|send|provide|give|report)\s+(?:(?:an?|the|your|current|immediate|brief|concise|requested)\s+){0,6}(?:checkpoint(?:\/report)?|status report|progress report)\b/i,
];
const IMMEDIATE_RETURN_DIRECTIVE = [
  /^\s*(?:please\s+)?(?:return|report|respond|send|provide|give)\b[^\n.!?]{0,180}\b(?:immediately|right now|now)\b/i,
  /^\s*(?:immediately|right now|now)\s+(?:return|report|respond|send|provide|give)\b/i,
  /^\s*(?:please\s+)?(?:stop|pause)\b[^\n.!?]{0,120}\b(?:and|then)\s+(?:immediately\s+)?(?:return|report|respond|send|provide|give)\b/i,
];
const CONDITIONAL_TIMING = /\b(?:if|when|once|unless|until|after)\b/i;
const RZMCP_NAME = String.raw`rz(?:direct)?mcp`;
const RZMCP_EXPLICIT_PROHIBITION = [
  new RegExp(String.raw`\b(?:do not|don't|must not|never|cannot|can't)\b[^\n.;]{0,160}\b${RZMCP_NAME}\b`, "i"),
  new RegExp(String.raw`\bno\s+[^\n.;]{0,160}\b${RZMCP_NAME}\b`, "i"),
  new RegExp(String.raw`\b(?:ne\s+(?:pas|jamais)|sans|aucun(?:e)?|interdiction\s+d['’](?:utiliser|invoquer|appeler))\b[^\n.;]{0,160}\b${RZMCP_NAME}\b`, "i"),
];
const RZMCP_EXPLICIT_REQUIREMENT = [
  new RegExp(String.raw`\b(?:use|invoke|call|access|query)\b[^\n.;]{0,120}\b${RZMCP_NAME}\b`, "i"),
  new RegExp(String.raw`\b(?:using|via|through|with)\s+(?:the\s+)?${RZMCP_NAME}\b`, "i"),
  new RegExp(String.raw`\b(?:utiliser|utilisez|utilise|invoquer|invoquez|appeler|appelez|acc[eé]der)\b[^\n.;]{0,120}\b${RZMCP_NAME}\b`, "i"),
  /\bmcp__rzmcp__[a-z0-9_]+\b/i,
];
const GENERIC_EDITOR_RESTRICTION = /\b(?:do not|must not|never)[^.\n]{0,160}\b(?:use|invoke|control|call)\s+(?:any\s+|the\s+)?editor\b|\bno\s+[^.\n]{0,120}\b(?:editor|pie|sie)\b|\b(?:aucun(?:e)?|sans|interdiction\s+d['’](?:ex[eé]cuter|utiliser))[^.\n]{0,160}\b(?:editor|[eé]diteur|pie|sie)\b/i;
const PRIOR_TASK_REFERENCE = [
  /^\s*(?:resume|continue|proceed|carry on|pick up)(?:\s+(?:the|this|that|same|previous|prior|original|interrupted|preserved)\s+(?:task|work|scope|ownership|implementation|review|audit))?\s*[.!]?\s*$/i,
  /\b(?:resume|continue|proceed|carry on|pick up)\b[\s\S]{0,240}\b(?:same|previous|prior|original|interrupted|preserved|where you (?:left off|were))\b/i,
  /\b(?:reprends?|reprendre|continue[rz]?|poursuis|poursuivre)\b[\s\S]{0,240}\b(?:m[eê]me|pr[eé]c[eé]dent|initial|original|interrompu|conserv[eé]|l[aà]\s+o[uù]\s+tu)\b/i,
];

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

export function rzMcpModeForTask(text, readOnly) {
  const payload = payloadFrom(text);
  const explicitlyProhibited = RZMCP_EXPLICIT_PROHIBITION.some((pattern) => pattern.test(payload));
  if (explicitlyProhibited) return "disabled";
  const explicitlyRequired = RZMCP_EXPLICIT_REQUIREMENT.some((pattern) => pattern.test(payload));
  if (!explicitlyRequired && GENERIC_EDITOR_RESTRICTION.test(payload)) return "disabled";
  return readOnly ? "read-only" : "no-validation";
}

function leadingDirectiveFrom(text) {
  const payload = payloadFrom(text).trimStart();
  const paragraphEnd = payload.search(/\r?\n\s*\r?\n/);
  const firstParagraph = paragraphEnd >= 0 ? payload.slice(0, paragraphEnd) : payload;
  return firstParagraph.slice(0, 320).trim();
}

function isCheckpointRequest(text) {
  const directive = leadingDirectiveFrom(text);
  return CHECKPOINT_DIRECTIVE.some((pattern) => pattern.test(directive));
}

function isImmediateReturnRequest(text) {
  const directive = leadingDirectiveFrom(text);
  const matched = IMMEDIATE_RETURN_DIRECTIVE.some((pattern) => pattern.test(directive))
    || /^\s*immediate\s+checkpoint(?:\/report)?\b/i.test(directive);
  return matched && !CONDITIONAL_TIMING.test(directive);
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

export function isExplicitReadOnlyTask(text) {
  return EXPLICIT_READ_ONLY_TASK.test(payloadFrom(text));
}

function taskIntent(text) {
  const payload = payloadFrom(text);
  // Mutation words can be audit subjects (for example, "review the previous fix"). An explicit
  // read-only ownership boundary must win over those incidental keywords.
  if (isExplicitReadOnlyTask(payload)) return "analysis";
  for (const match of payload.matchAll(MUTATION_INTENT)) {
    const prefix = payload.slice(Math.max(0, match.index - 80), match.index);
    if (!NEGATED_MUTATION_PREFIX.test(prefix)) return "mutation";
  }
  return "analysis";
}

function taskName(text, fallback) {
  return TASK_NAME_HEADER.exec(text)?.[1]?.trim() || fallback;
}

function enrichedTask(message) {
  return {
    ...message,
    hash: sha256(message.text),
    name: taskName(message.text, message.recipient),
    intent: taskIntent(message.text),
  };
}

function referencesPriorTask(text) {
  const payload = payloadFrom(text);
  return PRIOR_TASK_REFERENCE.some((pattern) => pattern.test(payload));
}

function resumedTaskIntent(text, priorIntent, currentIntent) {
  if (priorIntent !== "mutation" || currentIntent === "mutation" || isExplicitReadOnlyTask(text)) {
    return currentIntent;
  }
  const payload = payloadFrom(text);
  const resumeIndex = payload.search(/\b(?:resume|continue|proceed|carry on|pick up|reprends?|reprendre|continue[rz]?|poursuis|poursuivre)\b/i);
  if (resumeIndex < 0) return currentIntent;
  const resumedScope = payload.slice(resumeIndex);
  const mutationIndex = resumedScope.search(/\b(?:apply|implementation|implementing|patch(?:ing)?|edit(?:ing)?|modify(?:ing)?|mutation|fix(?:ing)?|repair(?:ing)?|refactor(?:ing)?|remove|instrument|code changes?|impl[eé]mentation|corrections?)\b|\b(?:finish|complete|minimi[sz]e|clean up)\b[\s\S]{0,80}\b(?:diff|patch|implementation|diagnostics?|instrumentation|code|changes?)\b/i);
  const analysisIndex = resumedScope.search(/\b(?:statically\s+)?(?:audit|review|inspect|analy[sz]e|assess|confirm|revue|analyse[rz]?|inspecte[rz]?)\b/i);
  if (mutationIndex >= 0) return "mutation";
  if (analysisIndex >= 0) return currentIntent;
  return "mutation";
}

function messageState(item, index) {
  const normalized = normalizeAgentMessageContent(item.content, `input[${index}].content`);
  const newTask = NEW_TASK_HEADER.test(normalized.text);
  const checkpoint = isCheckpointRequest(normalized.text);
  const immediateReturn = isImmediateReturnRequest(normalized.text);
  const intent = taskIntent(normalized.text);
  const terminalControl = intent === "analysis" && (checkpoint || immediateReturn);
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
    immediateReturn,
    intent,
    terminalControl,
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
    if (isBridgeProgressReasoning(item)) {
      const summary = Array.isArray(item.summary)
        ? item.summary.map((part) => part?.type === "summary_text" ? part.text || "" : "").join("")
        : "";
      for (const line of summary.split(/\r?\n/)) {
        const match = /\bnative tool (?:\d+:\s*)?([A-Za-z0-9_.:-]+)\.?\s*$/i.exec(line);
        if (!match) continue;
        toolCallsSinceTask += 1;
        lastCompletedTool = match[1].replace(/\.$/, "");
      }
      continue;
    }
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
    if (
      message.newTask
      && (!activeTask || !message.terminalControl)
    ) {
      activeTask = message;
    }
  }
  if (!activeTask) {
    return {
      activeTask: null,
      referencedPriorTask: null,
      referencedPriorTasks: [],
      referencedPriorControl: null,
      checkpointRequested: false,
      immediateReturnRequested: false,
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
  activeTask = enrichedTask(activeTask);
  const priorTaskMessages = messages.filter((message) => (
    message.newTask
    && !message.terminalControl
    && message.index < activeTask.index
  ));
  let referencedPriorTask = null;
  let referencedPriorTasks = [];
  let referencedPriorControl = null;
  if (referencesPriorTask(activeTask.text)) {
    let priorTaskIndex = priorTaskMessages.length - 1;
    if (priorTaskIndex < 0) {
      throw new TaskStateError(
        `active task ${activeTask.id} references a prior assignment, but no prior NEW_TASK payload is available`,
      );
    }
    while (priorTaskIndex >= 0) {
      const priorTaskMessage = priorTaskMessages[priorTaskIndex];
      if (priorTaskMessage.text.length > maxActiveTaskChars) {
        throw new TaskStateError(
          `referenced prior task ${priorTaskMessage.id} is ${priorTaskMessage.text.length} characters; maximum is ${maxActiveTaskChars}`,
        );
      }
      referencedPriorTasks.unshift(enrichedTask(priorTaskMessage));
      if (!referencesPriorTask(priorTaskMessage.text)) break;
      priorTaskIndex -= 1;
    }
    if (priorTaskIndex < 0 && referencesPriorTask(referencedPriorTasks[0].text)) {
      throw new TaskStateError(
        `referenced task chain for ${activeTask.id} has no complete originating NEW_TASK payload`,
      );
    }
    let inheritedIntent = referencedPriorTasks[0].intent;
    referencedPriorTasks = referencedPriorTasks.map((task, index) => {
      if (index === 0) return task;
      const intent = resumedTaskIntent(task.text, inheritedIntent, task.intent);
      inheritedIntent = intent;
      return { ...task, intent };
    });
    referencedPriorTask = referencedPriorTasks[0];
    activeTask = {
      ...activeTask,
      intent: resumedTaskIntent(activeTask.text, inheritedIntent, activeTask.intent),
    };
    referencedPriorControl = messages
      .filter((message) => (
        (!message.newTask || message.terminalControl)
        && message.index > referencedPriorTask.index
        && message.index < activeTask.index
      ))
      .at(-1) || null;
  }
  const latestControlMessage = messages
    .filter((message) => message.index > activeTask.index)
    .at(-1);
  const activeTaskCanBeTerminalControl = activeTask.intent === "analysis";
  const checkpointRequested = Boolean(
    (activeTaskCanBeTerminalControl && activeTask.checkpoint)
    || (
      latestControlMessage?.checkpoint
      && latestControlMessage.intent === "analysis"
      && (MESSAGE_HEADER.test(latestControlMessage.text) || latestControlMessage.newTask)
    ),
  );
  const immediateReturnRequested = Boolean(
    (activeTaskCanBeTerminalControl && activeTask.immediateReturn)
    || (
      latestControlMessage?.immediateReturn
      && latestControlMessage.intent === "analysis"
      && (MESSAGE_HEADER.test(latestControlMessage.text) || latestControlMessage.newTask)
    ),
  );
  return {
    activeTask,
    referencedPriorTask,
    referencedPriorTasks,
    referencedPriorControl,
    checkpointRequested,
    immediateReturnRequested,
    messages,
    progress: progressFrom(input, referencedPriorTask?.index ?? activeTask.index),
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

export function referencedPriorTaskPromptSection(taskState) {
  const priorTasks = taskState.referencedPriorTasks?.length > 0
    ? taskState.referencedPriorTasks
    : taskState.referencedPriorTask ? [taskState.referencedPriorTask] : [];
  if (priorTasks.length === 0) return "";
  const sections = [
    "[Referenced prior delegated context]\nThe active task explicitly asks to resume or continue its prior assignment chain. Read the retained tasks below in chronological order; each later task overrides earlier text where they differ, and the current active task remains authoritative over all of them. Provider-private progress from an interrupted execution is not assumed to survive unless represented in retained conversation. Do not search Codex session or rollout files merely to reconstruct the assignment; its complete task chain is supplied here.",
  ];
  for (let index = 0; index < priorTasks.length; index += 1) {
    const priorTask = priorTasks[index];
    const label = index === 0 ? "Originating delegated task" : `Prior continuation ${index}`;
    sections.push(`[${label}]\nTask ID: ${priorTask.id}\nTask name: ${priorTask.name}\nTask hash: ${priorTask.hash}\nIntent: ${priorTask.intent}\n${priorTask.text}`);
  }
  if (taskState.referencedPriorControl) {
    sections.push(`[Latest parent control before the resume]\n${taskState.referencedPriorControl.text}`);
  }
  return sections.join("\n\n");
}

export function progressPromptSection(taskState) {
  if (!taskState.activeTask) return "";
  const progress = taskState.progress;
  const paths = progress.changedPaths.length > 0 ? progress.changedPaths.join("\n") : "none";
  return `[Authoritative progress since active task]\nTool calls: ${progress.toolCallsSinceTask}\nSuccessful apply_patch mutations: ${progress.successfulMutationCount}\nChanged paths:\n${paths}\nLast completed tool: ${progress.lastCompletedTool ?? "none"}`;
}

export function parentDirectedTurnPromptSection(taskState) {
  if (!taskState.activeTask) return "";
  return "[Parent-directed turn scope]\nKeep this provider turn focused on the shortest causal path that can complete the bounded assignment. Do not pursue exhaustive certainty, speculative branches, or broad additional probing merely to avoid returning to the parent. If missing input, ambiguous ownership, an architectural choice, or unresolved semantic uncertainty prevents a safe completion, return a concise checkpoint or question immediately with the exact evidence and next decision needed; the parent can answer and resume this same Codex subagent. Do not manufacture a blocker when one targeted safe in-scope tool call would resolve it; make that call instead.";
}

export function mutationContractPromptSection(taskState) {
  if (taskState.activeTask?.intent !== "mutation") return "";
  return `[Mutation convergence contract]\nThe recorded tool and apply_patch results above are authoritative. Do not repeat a completed read, search, or status inspection whose result is already present in this turn. Converge on the requested mutation once the necessary signatures and ownership are established. If you return a final answer while the recorded successful mutation count is zero, include exactly one single-line marker:\nNO_MUTATION_REASON: {"category":"policy|permission|tool|missing_input|semantic","detail":"specific blocker","resolvable_tool":null}\nDo not claim a blocker when you have already identified a safe in-scope tool call that resolves it; make that call instead. If resolvable_tool would not be null, continue the task rather than returning.`;
}

export function analysisContractPromptSection(taskState) {
  if (taskState.activeTask?.intent !== "analysis") return "";
  return "[Analysis convergence contract]\nTreat completed tool results already present in this turn as authoritative; do not repeat the same read, search, or status inspection. Use the narrowest targeted evidence that can answer the bounded deliverable. Do not launch broad recursive binary-asset scans or exhaustive repository-wide inspection when a source file, project index, known artifact, or focused query can establish the result, unless the task explicitly requires an exhaustive inventory. Once the evidence supports the requested verdict, return it and state any residual uncertainty instead of continuing exploratory work. If the requested conclusion cannot be established, return the concrete missing input, semantic uncertainty, or tool limitation so the parent can decide the next step.";
}

export function checkpointPromptSection(taskState) {
  if (!taskState.checkpointRequested) return "";
  return "[On-demand checkpoint requested]\nDo not start another tool call or investigation branch. Return the requested report now using the authoritative progress above, then wait for the parent to resume the active task.";
}

export function immediateReturnPromptSection(taskState) {
  if (!taskState.immediateReturnRequested) return "";
  return "[Immediate terminal report required]\nDo not call another tool, continue investigating, wait for more evidence, or start a new branch. Return the best current verdict now from the authoritative evidence already recorded. Separate proved facts from remaining uncertainty; if evidence is insufficient, report the concrete blocker or question. The parent can resume the task later if needed.";
}

export function taskControlPromptSections(taskState) {
  return [
    progressPromptSection(taskState),
    parentDirectedTurnPromptSection(taskState),
    mutationContractPromptSection(taskState),
    analysisContractPromptSection(taskState),
    checkpointPromptSection(taskState),
    immediateReturnPromptSection(taskState),
  ].filter(Boolean);
}

export function authoritativeProgressReport(taskState) {
  if (!taskState.activeTask) return "";
  const progress = taskState.progress;
  const paths = progress.changedPaths.length > 0 ? progress.changedPaths.join(", ") : "none";
  return `[Authoritative Codex progress]\nTask ID: ${taskState.activeTask.id}\nTask hash: ${taskState.activeTask.hash}\nTool calls since task: ${progress.toolCallsSinceTask}\nSuccessful apply_patch mutations: ${progress.successfulMutationCount}\nChanged paths: ${paths}\nLast completed tool: ${progress.lastCompletedTool ?? "none"}`;
}
