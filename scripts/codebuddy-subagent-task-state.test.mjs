import assert from "node:assert/strict";
import test from "node:test";
import { TaskStateError, taskStateFromInput } from "./codebuddy-subagent-task-state.mjs";

function task(id, payload) {
  return {
    type: "agent_message", id, author: "Codex", recipient: "/root/fixture",
    content: `Message Type: NEW_TASK\nTask name: /root/fixture\nPayload:\n${payload}`,
  };
}

test("self-contained code tasks discussing resume behavior do not inherit another assignment", () => {
  for (const payload of [
    "Implement prompt budgeting and resume behavior. This message fully defines an original independent task.",
    "Inspect requestContext, historyEntries, boundedEntries, resumePrompt and projectInstructionsPromptSection. Preserve the original current control.",
    "Fix resume handling so the same model is retained. Keep existing ownership checks.",
    'Test the phrase "Resume the same task" as parser input. Implement the bounded classifier correction.',
  ]) {
    const state = taskStateFromInput([task("fresh", payload)], 40_000);
    assert.equal(state.activeTask.id, "fresh");
    assert.equal(state.referencedPriorTask, null);
  }
});

test("genuine task continuation requires its originating assignment", () => {
  for (const payload of [
    "Resume",
    "Bridge repaired. Resume the same bounded task from the preserved state and finish.",
    "Please continue the original task from the checkpoint.",
    "Reprends la même tâche et termine la correction.",
  ]) {
    assert.throws(() => taskStateFromInput([task("continuation", payload)], 40_000), TaskStateError);
    const state = taskStateFromInput([
      task("origin", "Implement the bounded source correction without running tests."),
      task("continuation", payload),
    ], 40_000);
    assert.equal(state.referencedPriorTask.id, "origin");
    assert.equal(state.activeTask.intent, "mutation");
  }
});
