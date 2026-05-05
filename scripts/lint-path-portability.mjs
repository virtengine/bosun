#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

const DEFAULT_EXTENSIONS = new Set([".mjs"]);
const DEFAULT_IGNORE_DIRS = new Set([
  ".git",
  ".bosun",
  ".cache",
  "node_modules",
  "coverage",
  "dist",
  "build",
  "output",
]);

const DEFAULT_ALLOWLIST = [
  {
    filePattern: "tests/fixtures/",
    patternType: "absolute-unix-path",
  },
  {
    filePattern: "tests/fixtures/",
    patternType: "absolute-windows-path",
  },
  {
    filePattern: "tests/path-portability-lint.test.mjs",
    patternType: "*",
  },
];

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    check: false,
    json: false,
    quiet: false,
    allowlist: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      options.root = argv[++i];
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else if (arg === "--allowlist") {
      options.allowlist = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`lint-path-portability\n\nUsage:\n  node scripts/lint-path-portability.mjs [--root <dir>] [--check] [--json] [--allowlist <file>]\n`);
}

function normalizePath(value) {
  return value.split(sep).join("/");
}

function walkMjsFiles(rootDir) {
  const files = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (!DEFAULT_IGNORE_DIRS.has(entry.name)) {
          stack.push(fullPath);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if ([...DEFAULT_EXTENSIONS].some((ext) => entry.name.endsWith(ext))) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(glob) {
  const normalized = normalizePath(glob);
  const source = normalized
    .split("*")
    .map((part) => escapeRegex(part))
    .join(".*");
  return new RegExp(source);
}

function loadAllowlist(rootDir, customPath) {
  const builtin = DEFAULT_ALLOWLIST.map((entry) => ({ ...entry }));
  const explicitPath = customPath ? resolve(rootDir, customPath) : resolve(rootDir, ".path-portability-allowlist.json");
  if (!existsSync(explicitPath)) {
    return builtin;
  }

  const parsed = JSON.parse(readFileSync(explicitPath, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("Allowlist file must contain an array");
  }

  return builtin.concat(parsed);
}

function matchesAllowlist(finding, allowlist) {
  return allowlist.some((entry) => {
    const filePattern = entry.filePattern ?? "*";
    const patternType = entry.patternType ?? "*";
    const severity = entry.severity ?? "*";
    const line = entry.line ?? "*";
    const messageIncludes = entry.messageIncludes ?? null;

    const fileMatch = filePattern === "*"
      ? true
      : globToRegex(filePattern).test(finding.file);
    const typeMatch = patternType === "*" || patternType === finding.patternType;
    const severityMatch = severity === "*" || severity === finding.severity;
    const lineMatch = line === "*" || line === finding.line;
    const messageMatch = !messageIncludes || finding.message.includes(messageIncludes);

    return fileMatch && typeMatch && severityMatch && lineMatch && messageMatch;
  });
}

function buildFinding(file, line, patternType, severity, message, snippet) {
  return { file, line, patternType, severity, message, snippet };
}

function analyzeFile(rootDir, absolutePath) {
  const relativePath = normalizePath(relative(rootDir, absolutePath));
  const content = readFileSync(absolutePath, "utf8");
  const lines = content.split(/\r?\n/);
  const findings = [];

  const stringLiteralRegex = /(["'`])((?:\\.|(?!\1).)*)\1/g;
  const concatRegex = /(__dirname|process\.cwd\(\))\s*\+\s*(["'`])((?:\\.|(?!\2).)*)\2/g;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];

    for (const match of line.matchAll(stringLiteralRegex)) {
      const literal = match[2];
      if (/\\\\[A-Za-z0-9_.-]/.test(literal)) {
        findings.push(buildFinding(
          relativePath,
          lineNumber,
          "raw-backslash-separator",
          "error",
          "Path-like string uses raw backslash separators; prefer join()/resolve() or forward-slash-safe inputs.",
          line.trim(),
        ));
      }

      if (/^[A-Za-z]:\\\\/.test(literal)) {
        findings.push(buildFinding(
          relativePath,
          lineNumber,
          "absolute-windows-path",
          "error",
          "Absolute Windows path literal detected.",
          line.trim(),
        ));
      }

      if (/^\/(?![/*])/.test(literal)) {
        const severity = /(__dirname|process\.cwd\(\)|cwd|dirname)/.test(line) ? "error" : "warning";
        findings.push(buildFinding(
          relativePath,
          lineNumber,
          "absolute-unix-path",
          severity,
          "Absolute Unix path literal detected.",
          line.trim(),
        ));
      }
    }

    for (const match of line.matchAll(concatRegex)) {
      const base = match[1];
      findings.push(buildFinding(
        relativePath,
        lineNumber,
        "path-concatenation",
        "error",
        `String concatenation with ${base} detected; prefer resolve()/join().`,
        line.trim(),
      ));
    }
  }

  return findings;
}

function analyze(rootDir, allowlist) {
  const startedAt = Date.now();
  const files = walkMjsFiles(rootDir);
  const findings = [];

  for (const file of files) {
    const fileFindings = analyzeFile(rootDir, file);
    for (const finding of fileFindings) {
      if (!matchesAllowlist(finding, allowlist)) {
        findings.push(finding);
      }
    }
  }

  const summary = {
    root: normalizePath(rootDir),
    scannedFiles: files.length,
    findings: findings.length,
    errors: findings.filter((finding) => finding.severity === "error").length,
    warnings: findings.filter((finding) => finding.severity === "warning").length,
    durationMs: Date.now() - startedAt,
  };

  return { summary, findings };
}

function printHumanReport(result) {
  console.log("lint-path-portability");
  console.log(JSON.stringify(result.summary, null, 2));
  for (const finding of result.findings) {
    console.log(`${finding.severity.toUpperCase()} ${finding.patternType} ${finding.file}:${finding.line}`);
    console.log(`  ${finding.message}`);
  }
}

const options = parseArgs(process.argv.slice(2));
const rootDir = resolve(options.root);
const allowlist = loadAllowlist(rootDir, options.allowlist);
const result = analyze(rootDir, allowlist);
const shouldFail = options.check || result.summary.errors > 0;

if (options.json) {
  console.log(JSON.stringify(result, null, 2));
} else if (!options.quiet) {
  printHumanReport(result);
}

if (shouldFail && result.summary.errors > 0) {
  process.exit(1);
}
