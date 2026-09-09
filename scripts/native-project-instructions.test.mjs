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

test("configured root markers and fallback filenames match native discovery", () => {
  const fixture = mkdtempSync(join(tmpdir(), "rzcodex-project-instructions-"));
  try {
    const codexHome = join(fixture, "codex-home");
    const root = join(fixture, "workspace");
    const nested = join(root, "nested");
    mkdirSync(codexHome);
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), [
      '"project_root_markers" = [".workspace]-root"] # inline comment',
      'project_doc_fallback_filenames = [',
      '  "WORKFLOW].md", # quoted closing bracket is data',
      "  'TEAM.md',",
      '] # trailing comment',
      '[nested]',
      'project_root_markers = ["ignored-nested-marker"]',
      "",
    ].join("\n"));
    writeFileSync(join(root, ".workspace]-root"), "");
    writeFileSync(join(root, "WORKFLOW].md"), "ROOT_FALLBACK\n");
    writeFileSync(join(root, "TEAM.md"), "LOWER_PRIORITY_FALLBACK\n");
    writeFileSync(join(nested, "AGENTS.md"), "NESTED_STANDARD\n");

    const prompt = projectInstructionsPromptSection(nested, {
      environment: { CODEX_HOME: codexHome },
    });
    assert.match(prompt, /ROOT_FALLBACK[\s\S]*NESTED_STANDARD/);
    assert.doesNotMatch(prompt, /LOWER_PRIORITY_FALLBACK/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("unsupported configured discovery values fail explicitly", () => {
  const fixture = mkdtempSync(join(tmpdir(), "rzcodex-project-instructions-"));
  try {
    const codexHome = join(fixture, "codex-home");
    const root = join(fixture, "workspace");
    mkdirSync(codexHome);
    mkdirSync(root);
    writeFileSync(join(codexHome, "config.toml"), "project_root_markers = [42]\n");
    assert.throws(
      () => projectInstructionsPromptSection(root, { environment: { CODEX_HOME: codexHome } }),
      (error) => error instanceof ProjectInstructionsError && /array of strings/.test(error.message),
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("empty configured root markers limit discovery to the selected cwd", () => {
  const fixture = mkdtempSync(join(tmpdir(), "rzcodex-project-instructions-"));
  try {
    const codexHome = join(fixture, "codex-home");
    const nested = join(fixture, "workspace", "nested");
    mkdirSync(codexHome);
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), "project_root_markers = []\n");
    writeFileSync(join(fixture, "workspace", "AGENTS.md"), "PARENT_INSTRUCTION\n");
    writeFileSync(join(nested, "AGENTS.md"), "CWD_INSTRUCTION\n");

    const prompt = projectInstructionsPromptSection(nested, {
      environment: { CODEX_HOME: codexHome },
    });
    assert.match(prompt, /CWD_INSTRUCTION/);
    assert.doesNotMatch(prompt, /PARENT_INSTRUCTION/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
