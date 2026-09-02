import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ProjectInstructionsError,
  projectInstructionsPromptSection,
} from "./native-project-instructions.mjs";

test("project instructions are delivered completely in scope order", () => {
  const root = mkdtempSync(join(tmpdir(), "rzcodex-project-instructions-"));
  try {
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "AGENTS.md"), "ROOT_INSTRUCTION\n");
    writeFileSync(join(root, "nested", "AGENTS.md"), "SHADOWED_INSTRUCTION\n");
    writeFileSync(join(root, "nested", "AGENTS.override.md"), "NESTED_OVERRIDE\n");
    const prompt = projectInstructionsPromptSection(join(root, "nested"));
    assert.match(prompt, /ROOT_INSTRUCTION[\s\S]*NESTED_OVERRIDE/);
    assert.doesNotMatch(prompt, /SHADOWED_INSTRUCTION/);
    assert.match(prompt, /do not spend a tool call reopening/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized project instructions fail explicitly", () => {
  const root = mkdtempSync(join(tmpdir(), "rzcodex-project-instructions-"));
  try {
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "AGENTS.md"), "x".repeat(33_000));
    assert.throws(
      () => projectInstructionsPromptSection(root),
      (error) => error instanceof ProjectInstructionsError && /exceeding/.test(error.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
