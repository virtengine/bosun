#!/usr/bin/env node

/**
 * prepublish-check.mjs — Pre-publish validation gate.
 *
 * Validates that every published local source file only imports other files
 * that are also published. This closes the gap where nested modules can import
 * `../foo.mjs` successfully in the repo, but fail after npm publish because the
 * target was omitted from package.json's `files` array.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BUILTIN_SKILLS } from "../agent/bosun-skills.mjs";

const SOURCE_EXTENSIONS = new Set([".mjs", ".cjs", ".js"]);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const REQUIRED_STEP9_TOP_LEVEL_ASSET_FILES = Object.freeze([
  "agent/internal-harness-control-plane.mjs",
  "agent/internal-harness-profile.mjs",
  "agent/internal-harness-runtime.mjs",
  "shell/claude-shell.mjs",
  "shell/codex-sdk-import.mjs",
  "shell/codex-shell.mjs",
  "shell/copilot-shell.mjs",
  "shell/gemini-shell.mjs",
  "shell/opencode-providers.mjs",
  "shell/opencode-shell.mjs",
  "shell/shell-session-compat.mjs",
]);

function isSourceFile(filePath) {
  return SOURCE_EXTENSIONS.has(extname(filePath));
}

function walkFiles(absPath, out = []) {
  const stats = statSync(absPath);
  if (stats.isDirectory()) {
    for (const entry of readdirSync(absPath)) {
      walkFiles(resolve(absPath, entry), out);
    }
    return out;
  }
  out.push(absPath);
  return out;
}

export function findDuplicateEntries(filesArray = []) {
  const seen = new Set();
  const duplicates = [];
  for (const entry of filesArray) {
    if (seen.has(entry)) duplicates.push(entry);
    seen.add(entry);
  }
  return duplicates;
}

export function expandPublishedFiles(rootDir, filesArray = []) {
  const published = new Set();
  for (const entry of filesArray) {
    const absEntry = resolve(rootDir, entry);
    if (!existsSync(absEntry)) continue;
    for (const absFile of walkFiles(absEntry)) {
      published.add(relative(rootDir, absFile).replaceAll("\\", "/"));
    }
  }
  return published;
}

export function findMissingPublishedFiles(publishedFiles, requiredFiles = []) {
  return requiredFiles
    .filter((file) => typeof file === "string" && file.length > 0)
    .filter((file) => !publishedFiles.has(file))
    .sort((a, b) => a.localeCompare(b));
}

export function getRequiredHarnessRuntimeAssets(rootDir = ROOT) {
  const harnessDir = resolve(rootDir, "agent", "harness");
  const harnessFiles = existsSync(harnessDir)
    ? walkFiles(harnessDir)
        .filter(isSourceFile)
        .map((absFile) => relative(rootDir, absFile).replaceAll("\\", "/"))
    : [];

  return [...REQUIRED_STEP9_TOP_LEVEL_ASSET_FILES, ...harnessFiles].sort((a, b) =>
    a.localeCompare(b),
  );
}

export function getRequiredPublishedAssetFiles(rootDir = ROOT) {
  return [
    ...BUILTIN_SKILLS.map((skill) => `agent/skills/${skill.filename}`),
    ...getRequiredHarnessRuntimeAssets(rootDir),
  ];
}

function isIdentifierChar(char) {
  return /[A-Za-z0-9_$]/.test(char);
}

function matchesKeyword(source, index, keyword) {
  if (!source.startsWith(keyword, index)) return false;
  const before = source[index - 1] ?? "";
  const after = source[index + keyword.length] ?? "";
  return !isIdentifierChar(before) && !isIdentifierChar(after);
}

function skipLineComment(source, index) {
  let cursor = index + 2;
  while (cursor < source.length && source[cursor] !== "\n") cursor += 1;
  return cursor;
}

function skipBlockComment(source, index) {
  let cursor = index + 2;
  while (cursor + 1 < source.length) {
    if (source[cursor] === "*" && source[cursor + 1] === "/") return cursor + 2;
    cursor += 1;
  }
  return source.length;
}

function skipWhitespaceAndComments(source, index) {
  let cursor = index;
  while (cursor < source.length) {
    const char = source[cursor];
    const next = source[cursor + 1];
    if (/\s/.test(char)) {
      cursor += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      cursor = skipLineComment(source, cursor);
      continue;
    }
    if (char === "/" && next === "*") {
      cursor = skipBlockComment(source, cursor);
      continue;
    }
    break;
  }
  return cursor;
}

function consumeQuotedString(source, index) {
  const quote = source[index];
  let cursor = index + 1;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === quote) return cursor + 1;
    cursor += 1;
  }
  return source.length;
}

function consumeTemplateLiteral(source, index) {
  let cursor = index + 1;
  let expressionDepth = 0;

  while (cursor < source.length) {
    const char = source[cursor];
    const next = source[cursor + 1];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (expressionDepth === 0 && char === "`") return cursor + 1;
    if (char === "$" && next === "{") {
      expressionDepth += 1;
      cursor += 2;
      continue;
    }
    if (expressionDepth > 0) {
      if (char === "'" || char === '"') {
        cursor = consumeQuotedString(source, cursor);
        continue;
      }
      if (char === "`") {
        cursor = consumeTemplateLiteral(source, cursor);
        continue;
      }
      if (char === "/" && next === "/") {
        cursor = skipLineComment(source, cursor);
        continue;
      }
      if (char === "/" && next === "*") {
        cursor = skipBlockComment(source, cursor);
        continue;
      }
      if (char === "{") {
        expressionDepth += 1;
      } else if (char === "}") {
        expressionDepth -= 1;
      }
    }
    cursor += 1;
  }
  return source.length;
}

function readQuotedLiteral(source, index) {
  const quote = source[index];
  if (quote !== "'" && quote !== '"') return null;
  let cursor = index + 1;
  let value = "";
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\") {
      const escaped = source[cursor + 1];
      if (escaped === undefined) return null;
      value += escaped;
      cursor += 2;
      continue;
    }
    if (char === quote) {
      return { value, end: cursor + 1 };
    }
    value += char;
    cursor += 1;
  }
  return null;
}

function readSpecifierLiteral(source, index) {
  const cursor = skipWhitespaceAndComments(source, index);
  return readQuotedLiteral(source, cursor);
}

function scanForFromSpecifier(source, index) {
  let cursor = index;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;

  while (cursor < source.length) {
    cursor = skipWhitespaceAndComments(source, cursor);
    const char = source[cursor];
    if (char === undefined) break;
    if (char === "'" || char === '"') {
      cursor = consumeQuotedString(source, cursor);
      continue;
    }
    if (char === "`") {
      cursor = consumeTemplateLiteral(source, cursor);
      continue;
    }
    if (char === "(") {
      parenDepth += 1;
      cursor += 1;
      continue;
    }
    if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      cursor += 1;
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      cursor += 1;
      continue;
    }
    if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      cursor += 1;
      continue;
    }
    if (char === "[") {
      bracketDepth += 1;
      cursor += 1;
      continue;
    }
    if (char === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      cursor += 1;
      continue;
    }
    if (
      parenDepth === 0 &&
      braceDepth === 0 &&
      bracketDepth === 0 &&
      matchesKeyword(source, cursor, "from")
    ) {
      const literal = readSpecifierLiteral(source, cursor + 4);
      return {
        end: literal?.end ?? cursor + 4,
        specifier: literal?.value ?? null,
      };
    }
    if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0 && char === ";") {
      return { end: cursor + 1, specifier: null };
    }
    cursor += 1;
  }

  return { end: cursor, specifier: null };
}

function findNextModuleSpecifier(source, index, keyword) {
  const cursor = skipWhitespaceAndComments(source, index + keyword.length);
  if (source[cursor] === ".") {
    return { end: cursor + 1, specifier: null };
  }
  if (keyword === "import" && source[cursor] === "(") {
    const literal = readSpecifierLiteral(source, cursor + 1);
    return {
      end: literal?.end ?? cursor + 1,
      specifier: literal?.value ?? null,
    };
  }
  if (source[cursor] === "'" || source[cursor] === '"') {
    const literal = readQuotedLiteral(source, cursor);
    return {
      end: literal?.end ?? cursor,
      specifier: literal?.value ?? null,
    };
  }
  return scanForFromSpecifier(source, cursor);
}

export async function findLocalImportSpecifiers(source) {
  const specifiers = [];
  let cursor = 0;

  while (cursor < source.length) {
    const char = source[cursor];
    const next = source[cursor + 1];
    if (char === "'" || char === '"') {
      cursor = consumeQuotedString(source, cursor);
      continue;
    }
    if (char === "`") {
      cursor = consumeTemplateLiteral(source, cursor);
      continue;
    }
    if (char === "/" && next === "/") {
      cursor = skipLineComment(source, cursor);
      continue;
    }
    if (char === "/" && next === "*") {
      cursor = skipBlockComment(source, cursor);
      continue;
    }

    let match = null;
    if (matchesKeyword(source, cursor, "import")) {
      match = findNextModuleSpecifier(source, cursor, "import");
    } else if (matchesKeyword(source, cursor, "export")) {
      match = findNextModuleSpecifier(source, cursor, "export");
    }

    if (match) {
      if (match.specifier?.startsWith("./") || match.specifier?.startsWith("../")) {
        specifiers.push(match.specifier);
      }
      cursor = Math.max(match.end, cursor + 1);
      continue;
    }

    cursor += 1;
  }

  return specifiers;
}

export async function validatePublishedLocalImports({ rootDir, pkg }) {
  if (!pkg?.version) {
    return {
      duplicates: [],
      missing: [],
      scannedFiles: [],
      error: "Missing version in package.json",
    };
  }

  const filesArray = Array.isArray(pkg.files) ? pkg.files : [];
  const duplicates = findDuplicateEntries(filesArray);
  const publishedFiles = expandPublishedFiles(rootDir, filesArray);
  const scannedFiles = [...publishedFiles]
    .filter(isSourceFile)
    .sort((a, b) => a.localeCompare(b));
  const missing = [];

  for (const file of scannedFiles) {
    const absFile = resolve(rootDir, file);
    const content = readFileSync(absFile, "utf8");
    const imports = await findLocalImportSpecifiers(content);
    for (const specifier of imports) {
      const absTarget = resolve(dirname(absFile), specifier);
      if (!existsSync(absTarget)) continue;
      const target = relative(rootDir, absTarget).replaceAll("\\", "/");
      if (!publishedFiles.has(target)) {
        missing.push({ file, imported: specifier, resolved: target });
      }
    }
  }

  return { duplicates, missing, scannedFiles, error: null };
}

export async function runPrepublishCheck(rootDir = ROOT) {
  const pkg = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
  const result = await validatePublishedLocalImports({ rootDir, pkg });
  const publishedFiles = expandPublishedFiles(rootDir, Array.isArray(pkg.files) ? pkg.files : []);
  const requiredAssetFiles = getRequiredPublishedAssetFiles(rootDir);
  const missingAssetFiles = findMissingPublishedFiles(publishedFiles, requiredAssetFiles);

  if (result.error) {
    console.error(`:close: ${result.error}`);
    process.exit(1);
  }
  if (result.duplicates.length > 0) {
    console.error(
      `:close: Duplicate entries in files array: ${result.duplicates.join(", ")}`,
    );
    process.exit(1);
  }
  if (result.missing.length > 0) {
    console.error(":close: Published local imports missing from package.json files array:");
    for (const { file, imported, resolved } of result.missing) {
      console.error(`   ${file} -> ${imported} (${resolved})`);
    }
    console.error("\nAdd the resolved targets to the 'files' array in package.json.");
    process.exit(1);
  }
  if (missingAssetFiles.length > 0) {
    console.error(":close: Required published asset files missing from package.json files array:");
    for (const file of missingAssetFiles) {
      console.error(`   ${file}`);
    }
    console.error("\nAdd the missing asset files or a containing directory to the 'files' array in package.json.");
    process.exit(1);
  }

  console.log(
    `:check: ${pkg.name}@${pkg.version} — ${pkg.files.length} manifest entries, ${result.scannedFiles.length} published source files scanned, 0 missing local imports, ${requiredAssetFiles.length} required asset files present`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runPrepublishCheck();
}
