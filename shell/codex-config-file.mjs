import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

export const CODEX_DIR = resolve(homedir(), ".codex");
export const CONFIG_PATH = resolve(CODEX_DIR, "config.toml");

export function readCodexConfig() {
  if (!existsSync(CONFIG_PATH)) return "";
  return readFileSync(CONFIG_PATH, "utf8");
}

export function writeCodexConfig(content) {
  mkdirSync(CODEX_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, content, "utf8");
}

export function getConfigPath() {
  return CONFIG_PATH;
}

function tomlEscapeStr(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function formatTomlArrayEscaped(values) {
  return `[${values.map((value) => `"${tomlEscapeStr(value)}"`).join(", ")}]`;
}

function toWindowsNamespacePath(pathValue) {
  const value = String(pathValue || "").trim();
  if (!value) return null;
  if (value.startsWith("\\\\?\\")) return value;
  const drivePath = toWindowsDrivePath(value);
  if (drivePath) return `\\\\?\\${drivePath}`;
  return null;
}

function toWindowsDrivePath(pathValue) {
  const raw = String(pathValue || "").trim();
  if (!raw) return null;
  let value = raw.replace(/\//g, "\\");
  if (value.startsWith("\\\\?\\")) value = value.slice(4);
  if (/^[a-zA-Z]:\\/.test(value)) return value;
  const wslMatch = raw.match(/^\/mnt\/([a-zA-Z])\/(.+)$/);
  if (wslMatch) {
    const drive = wslMatch[1].toUpperCase();
    const rest = wslMatch[2].replace(/\//g, "\\");
    return `${drive}:\\${rest}`;
  }
  return null;
}

function normalizeTrustedPathForCompare(pathValue) {
  const trimTrailingPathSeparators = (value) => {
    let out = String(value || "");
    while (out.endsWith("/") || out.endsWith("\\")) out = out.slice(0, -1);
    return out;
  };
  const raw = String(pathValue || "").trim();
  if (!raw) return "";
  const windowsDrivePath = toWindowsDrivePath(raw);
  if (windowsDrivePath) {
    return trimTrailingPathSeparators(windowsDrivePath).toLowerCase();
  }
  if (process.platform === "win32") {
    let normalized = raw.replace(/\//g, "\\");
    if (normalized.startsWith("\\\\?\\UNC\\")) {
      normalized = "\\\\" + normalized.slice(8);
    } else if (normalized.startsWith("\\\\?\\")) {
      normalized = normalized.slice(4);
    }
    normalized = trimTrailingPathSeparators(normalized);
    return normalized.toLowerCase();
  }
  return trimTrailingPathSeparators(resolve(raw));
}

function buildTrustedPathVariants(pathValue) {
  const base = resolve(pathValue);
  const variants = [base];
  const namespaced = toWindowsNamespacePath(base);
  if (namespaced && namespaced !== base) variants.push(namespaced);
  // On Windows, resolve() changes WSL-style paths (/mnt/c/...) to native Windows paths,
  // losing the WSL drive letter. Also try namespace conversion on the original unresolved path
  // so that /mnt/c/... produces \\?\C:\... entries as expected.
  if (pathValue !== base) {
    const namespacedOrig = toWindowsNamespacePath(pathValue);
    if (namespacedOrig && namespacedOrig !== base && !variants.includes(namespacedOrig)) {
      variants.push(namespacedOrig);
    }
  }
  return variants;
}

function parseTomlArrayLiteralEscaped(raw) {
  if (!raw) return [];
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];
  const items = [];
  let buffer = "";
  let inString = false;
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index];
    if (char === "\\" && inString) {
      buffer += char + (inner[++index] || "");
      continue;
    }
    if (char === '"') {
      inString = !inString;
      buffer += char;
      continue;
    }
    if (char === "," && !inString) {
      items.push(buffer.trim());
      buffer = "";
      continue;
    }
    buffer += char;
  }
  if (buffer.trim()) items.push(buffer.trim());
  return items
    .map((item) => item.replace(/^"(.*)"$/s, "$1"))
    .map((item) => item.replace(/\\(["\\])/g, "$1"))
    .filter(Boolean);
}

function collectTrustedProjectVariants(paths) {
  return (paths || [])
    .flatMap((pathValue) => buildTrustedPathVariants(pathValue))
    .filter(Boolean);
}

function mergeTrustedProjectEntries(existing, desired) {
  const existingNormalized = new Set(
    existing.map((pathValue) => normalizeTrustedPathForCompare(pathValue)).filter(Boolean),
  );
  const added = [];
  const already = [];
  for (const pathValue of desired) {
    const normalized = normalizeTrustedPathForCompare(pathValue);
    if (!normalized) continue;
    if (existingNormalized.has(normalized)) {
      already.push(pathValue);
      continue;
    }
    existing.push(pathValue);
    existingNormalized.add(normalized);
    added.push(pathValue);
  }
  return { existing, added, already };
}

function upsertTrustedProjectsLine(toml, newLine, existingMatch) {
  if (existingMatch) {
    return toml.replace(/^trusted_projects\s*=\s*\[[^\]]*\]/m, newLine);
  }
  const firstSection = toml.search(/^\[/m);
  if (firstSection === -1) {
    return `${newLine}\n${toml}`;
  }
  return `${toml.slice(0, firstSection)}${newLine}\n\n${toml.slice(firstSection)}`;
}

export function ensureTrustedProjects(paths, { dryRun = false } = {}) {
  const result = { added: [], already: [], path: CONFIG_PATH };
  const desired = collectTrustedProjectVariants(paths);
  if (desired.length === 0) return result;

  let toml = readCodexConfig() || "";
  const existingMatch = toml.match(/^trusted_projects\s*=\s*(\[[^\]]*\])/m);
  const existing = existingMatch ? parseTomlArrayLiteralEscaped(existingMatch[1]) : [];
  const merged = mergeTrustedProjectEntries(existing, desired);
  result.added = merged.added;
  result.already = merged.already;
  if (result.added.length === 0) return result;
  if (dryRun) return result;

  toml = upsertTrustedProjectsLine(
    toml,
    `trusted_projects = ${formatTomlArrayEscaped(merged.existing)}`,
    existingMatch,
  );
  mkdirSync(CODEX_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, toml, "utf8");
  return result;
}
