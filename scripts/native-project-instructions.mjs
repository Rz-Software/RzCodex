import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const DEFAULT_PROJECT_ROOT_MARKERS = [".git"];
const DEFAULT_PROJECT_DOC_FALLBACK_FILENAMES = [];
const MAX_PROJECT_INSTRUCTIONS_BYTES = 32 * 1024;

export class ProjectInstructionsError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProjectInstructionsError";
  }
}

function skipArrayTrivia(source, start) {
  let index = start;
  for (;;) {
    while (/\s/.test(source[index] || "")) index += 1;
    if (source[index] !== "#") return index;
    while (index < source.length && source[index] !== "\n") index += 1;
  }
}

function parseArrayString(source, start, name) {
  const quote = source[start];
  let index = start + 1;
  if (quote === "'") {
    const end = source.indexOf("'", index);
    if (end < 0 || source.slice(index, end).includes("\n")) {
      throw new ProjectInstructionsError(`Invalid ${name} literal string in config.toml`);
    }
    return { value: source.slice(index, end), next: end + 1 };
  }
  let escaped = false;
  while (index < source.length) {
    const character = source[index];
    if (character === "\n" || character === "\r") {
      throw new ProjectInstructionsError(`Invalid ${name} basic string in config.toml`);
    }
    if (!escaped && character === '"') {
      const encoded = source.slice(start, index + 1);
      try {
        return { value: JSON.parse(encoded), next: index + 1 };
      } catch (error) {
        throw new ProjectInstructionsError(`Invalid ${name} basic string in config.toml: ${error.message}`);
      }
    }
    escaped = !escaped && character === "\\";
    if (character !== "\\") escaped = false;
    index += 1;
  }
  throw new ProjectInstructionsError(`Unterminated ${name} string array in config.toml`);
}

function parseStringArrayAt(source, start, name) {
  let index = skipArrayTrivia(source, start);
  if (source[index] !== "[") {
    throw new ProjectInstructionsError(`${name} in config.toml must be an array of strings`);
  }
  index += 1;
  const values = [];
  let expectingValue = true;
  for (;;) {
    index = skipArrayTrivia(source, index);
    if (source[index] === "]") {
      index += 1;
      while (source[index] === " " || source[index] === "\t") index += 1;
      if (source[index] === "#") {
        while (index < source.length && source[index] !== "\n") index += 1;
      }
      if (index < source.length && source[index] !== "\n" && source[index] !== "\r") {
        throw new ProjectInstructionsError(`Unexpected content after ${name} in config.toml`);
      }
      return { values, next: index };
    }
    if (!expectingValue || (source[index] !== '"' && source[index] !== "'")) {
      throw new ProjectInstructionsError(`${name} in config.toml must be an array of strings`);
    }
    const parsed = parseArrayString(source, index, name);
    values.push(parsed.value);
    index = skipArrayTrivia(source, parsed.next);
    if (source[index] === ",") {
      index += 1;
      expectingValue = true;
      continue;
    }
    expectingValue = false;
  }
}

function lineWithoutComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"' && !escaped && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "#") return line.slice(0, index);
  }
  return line;
}

// Codex owns the full TOML schema. This bridge reads only its two documented root-level
// string-array settings and rejects unsupported values instead of approximating TOML semantics.
function parseStringArraySetting(configText, name) {
  let inTable = false;
  let consumedUntil = 0;
  let found = null;
  const linePattern = /[^\r\n]*(?:\r?\n|$)/g;
  let lineMatch;
  while ((lineMatch = linePattern.exec(configText)) !== null && lineMatch[0]) {
    const lineStart = lineMatch.index;
    if (lineStart < consumedUntil) continue;
    const line = lineMatch[0].replace(/\r?\n$/, "");
    const meaningful = lineWithoutComment(line).trim();
    if (!meaningful) continue;
    if (meaningful.startsWith("[")) {
      inTable = true;
      continue;
    }
    if (inTable) continue;
    const assignment = /^([A-Za-z0-9_-]+|"(?:\\.|[^"\\])*"|'[^']*')\s*=/.exec(meaningful);
    if (!assignment) continue;
    let key = assignment[1];
    if (key.startsWith('"')) {
      try {
        key = JSON.parse(key);
      } catch (error) {
        if (key.includes(name)) {
          throw new ProjectInstructionsError(`Invalid ${name} key in config.toml: ${error.message}`);
        }
        continue;
      }
    } else if (key.startsWith("'")) {
      key = key.slice(1, -1);
    }
    if (key !== name) continue;
    if (found !== null) throw new ProjectInstructionsError(`Duplicate ${name} in config.toml`);
    const equalsInLine = line.search(/\S/) + assignment[0].lastIndexOf("=");
    const parsed = parseStringArrayAt(configText, lineStart + equalsInLine + 1, name);
    found = parsed.values;
    consumedUntil = parsed.next;
  }
  return found;
}

function discoveryConfiguration(source = process.env) {
  const codexHome = source.CODEX_HOME || join(homedir(), ".codex");
  const configPath = join(codexHome, "config.toml");
  if (!existsSync(configPath)) {
    return {
      rootMarkers: DEFAULT_PROJECT_ROOT_MARKERS,
      fallbackFilenames: DEFAULT_PROJECT_DOC_FALLBACK_FILENAMES,
    };
  }
  let configText;
  try {
    configText = readFileSync(configPath, "utf8");
  } catch (error) {
    throw new ProjectInstructionsError(`Failed to read project discovery configuration at ${configPath}: ${error.message}`);
  }
  return {
    rootMarkers: parseStringArraySetting(configText, "project_root_markers")
      ?? DEFAULT_PROJECT_ROOT_MARKERS,
    fallbackFilenames: parseStringArraySetting(configText, "project_doc_fallback_filenames")
      ?? DEFAULT_PROJECT_DOC_FALLBACK_FILENAMES,
  };
}

function repositoryRoot(workingDirectory, rootMarkers) {
  const start = resolve(workingDirectory);
  if (rootMarkers.length === 0) return start;
  let current = start;
  for (;;) {
    if (rootMarkers.some((marker) => existsSync(join(current, marker)))) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

function instructionPaths(workingDirectory, configuration) {
  const root = repositoryRoot(workingDirectory, configuration.rootMarkers);
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
    if (existsSync(standard)) return [standard];
    for (const filename of configuration.fallbackFilenames) {
      const fallback = join(directory, filename);
      if (existsSync(fallback)) return [fallback];
    }
    return [];
  });
}

export function projectInstructionsPromptSection(workingDirectory, { environment = process.env } = {}) {
  if (typeof workingDirectory !== "string" || !workingDirectory || !existsSync(workingDirectory)) return "";
  const configuration = discoveryConfiguration(environment);
  const documents = instructionPaths(workingDirectory, configuration).map((path) => {
    let content;
    try {
      if (!statSync(path).isFile()) {
        throw new Error("path is not a regular file");
      }
      content = readFileSync(path, "utf8");
    } catch (error) {
      throw new ProjectInstructionsError(`Failed to read applicable project instructions at ${path}: ${error.message}`);
    }
    return { path, content };
  });
  if (documents.length === 0) return "";
  const body = documents.map(({ path, content }) => `[Applicable instructions: ${path}]\n${content}`).join("\n\n");
  const bodyBytes = Buffer.byteLength(body);
  if (bodyBytes > MAX_PROJECT_INSTRUCTIONS_BYTES) {
    throw new ProjectInstructionsError(
      `Applicable project instructions total ${bodyBytes} bytes, exceeding the ${MAX_PROJECT_INSTRUCTIONS_BYTES}-byte native-provider limit`,
    );
  }
  return [
    "[Project AGENTS instructions - authoritative and complete]",
    "Apply the complete applicable project instructions below directly. They are already supplied; do not spend a tool call reopening the same AGENTS files unless the task explicitly asks you to edit them. Later entries override earlier entries where their scopes overlap.",
    body,
  ].join("\n");
}
