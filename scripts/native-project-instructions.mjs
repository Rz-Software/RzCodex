import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const MAX_PROJECT_INSTRUCTIONS_CHARS = 32_000;

export class ProjectInstructionsError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProjectInstructionsError";
  }
}

function repositoryRoot(workingDirectory) {
  const start = resolve(workingDirectory);
  let current = start;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

function instructionPaths(workingDirectory) {
  const root = repositoryRoot(workingDirectory);
  const target = resolve(workingDirectory);
  const remainder = relative(root, target);
  if (remainder.startsWith("..")) return [];
  const directories = [root];
  let current = root;
  for (const segment of remainder.split(/[\\/]+/).filter(Boolean)) {
    current = join(current, segment);
    directories.push(current);
  }
  return directories.flatMap((directory) => {
    const override = join(directory, "AGENTS.override.md");
    if (existsSync(override)) return [override];
    const standard = join(directory, "AGENTS.md");
    return existsSync(standard) ? [standard] : [];
  });
}

export function projectInstructionsPromptSection(workingDirectory) {
  if (typeof workingDirectory !== "string" || !workingDirectory || !existsSync(workingDirectory)) return "";
  const documents = instructionPaths(workingDirectory).map((path) => {
    let content;
    try {
      content = readFileSync(path, "utf8");
    } catch (error) {
      throw new ProjectInstructionsError(`Failed to read applicable project instructions at ${path}: ${error.message}`);
    }
    return { path, content };
  });
  if (documents.length === 0) return "";
  const body = documents.map(({ path, content }) => `[Applicable instructions: ${path}]\n${content}`).join("\n\n");
  if (body.length > MAX_PROJECT_INSTRUCTIONS_CHARS) {
    throw new ProjectInstructionsError(
      `Applicable project instructions total ${body.length} characters, exceeding the ${MAX_PROJECT_INSTRUCTIONS_CHARS}-character native-provider limit`,
    );
  }
  return [
    "[Project AGENTS instructions - authoritative and complete]",
    "Apply the complete applicable project instructions below directly. They are already supplied; do not spend a tool call reopening the same AGENTS files unless the task explicitly asks you to edit them. Later entries override earlier entries where their scopes overlap.",
    body,
  ].join("\n");
}
