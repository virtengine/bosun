import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { getResearchToolBundle } from "./mcp-registry.mjs";

const SIDECAR_VERSION = "1.2.0";
const ARTIFACT_DIR = [".bosun", "research-evidence"];
const DEFAULT_MAX_SOURCES = 6;
const MAX_TEXT_FILE_BYTES = 256 * 1024;
const MAX_PDF_FILE_BYTES = 12 * 1024 * 1024;
const MAX_LOCAL_FILES = 32;
const MAX_RUNTIME_LOG_BYTES = 256 * 1024;
const DEFAULT_RUNTIME_LOG_FILES = Object.freeze([
  ".bosun/logs/monitor.log",
  ".bosun/logs/error.log",
  ".bosun/logs/daemon.log",
]);
const TEXT_FILE_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".rst",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".csv",
  ".tsv",
  ".html",
  ".htm",
  ".xml",
  ".mjs",
  ".js",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".sql",
  ".sh",
]);
const PDF_FILE_EXTENSIONS = new Set([".pdf"]);
const PDFTOTEXT_COMMAND = "pdftotext";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function truncate(text, maxLength = 320) {
  const normalized = normalizeString(text).replace(/\s+/g, " ");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function dedupeStrings(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = normalizeString(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "n"].includes(normalized)) return false;
  return fallback;
}

function parseInteger(value, fallback, min = 1, max = 50) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function decodePdfLiteralString(value) {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = value[index + 1];
    if (next == null) break;
    if (/[0-7]/.test(next)) {
      let octal = next;
      for (let offset = 2; offset <= 3; offset += 1) {
        const candidate = value[index + offset];
        if (candidate == null || !/[0-7]/.test(candidate)) break;
        octal += candidate;
      }
      out += String.fromCharCode(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "(":
      case ")":
      case "\\":
        out += next;
        break;
      case "\r":
        if (value[index + 2] === "\n") index += 1;
        break;
      case "\n":
        break;
      default:
        out += next;
        break;
    }
    index += 1;
  }
  return out;
}

function decodePdfHexString(value) {
  const normalized = value.replace(/\s+/g, "");
  if (!normalized) return "";
  const even = normalized.length % 2 === 0 ? normalized : `${normalized}0`;
  const bytes = [];
  for (let index = 0; index < even.length; index += 2) {
    const byte = Number.parseInt(even.slice(index, index + 2), 16);
    if (Number.isFinite(byte)) bytes.push(byte);
  }
  return Buffer.from(bytes).toString("latin1");
}

function extractTextFromPdfOperators(content) {
  const tokens = [];
  const pushToken = (value) => {
    const normalized = normalizeString(value).replace(/\s+/g, " ");
    if (normalized) tokens.push(normalized);
  };

  const literalPattern = /\((?:\\.|[^\\()])*\)\s*Tj\b/g;
  for (const match of content.matchAll(literalPattern)) {
    pushToken(decodePdfLiteralString(match[0].replace(/\)\s*Tj\b$/, "").slice(1)));
  }

  const hexPattern = /<([0-9a-fA-F\s]+)>\s*Tj\b/g;
  for (const match of content.matchAll(hexPattern)) {
    pushToken(decodePdfHexString(match[1]));
  }

  const arrayPattern = /\[((?:.|\r|\n)*?)\]\s*TJ\b/g;
  for (const match of content.matchAll(arrayPattern)) {
    const arrayContent = match[1];
    const fragments = [];
    for (const entry of arrayContent.matchAll(/\((?:\\.|[^\\()])*\)|<([0-9a-fA-F\s]+)>/g)) {
      if (entry[0].startsWith("(")) {
        fragments.push(decodePdfLiteralString(entry[0].slice(1, -1)));
      } else {
        fragments.push(decodePdfHexString(entry[1] || ""));
      }
    }
    pushToken(fragments.join(""));
  }

  return tokens.join("\n");
}

export function extractPdfTextHeuristically(buffer) {
  const binary = buffer.toString("latin1");
  const pageMatches = binary.match(/\/Type\s*\/Page\b/g);
  const pageCount = pageMatches?.length || 0;
  const texts = [];
  const streamPattern = /stream\r?\n([\s\S]*?)endstream/g;
  let match;
  while ((match = streamPattern.exec(binary))) {
    const streamStart = match.index + match[0].indexOf(match[1]);
    const streamEnd = streamStart + match[1].length;
    let streamBuffer = buffer.subarray(streamStart, streamEnd);
    const dictPreview = binary.slice(Math.max(0, match.index - 256), match.index);
    if (/\/FlateDecode\b/.test(dictPreview)) {
      try {
        streamBuffer = inflateSync(streamBuffer);
      } catch {
        continue;
      }
    }
    const extracted = extractTextFromPdfOperators(streamBuffer.toString("latin1"));
    if (normalizeString(extracted)) texts.push(extracted);
  }

  const text = normalizeString(texts.join("\n")).replace(/\s+/g, " ").trim();
  if (!text) {
    throw new Error("No extractable text operators found in PDF content streams.");
  }
  return {
    text,
    pageCount: Math.max(1, pageCount),
    ingestionMethod: "pdf-inline-parser",
  };
}

export function extractPdfText(filePath) {
  const pdfBytes = readFileSync(filePath);
  try {
    const result = spawnSync(PDFTOTEXT_COMMAND, ["-q", "-enc", "UTF-8", filePath, "-"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = normalizeString(result.stdout || "").replace(/\s+/g, " ").trim();
    if (result.status === 0 && stdout) {
      const binary = pdfBytes.toString("latin1");
      const pageCount = Math.max(1, binary.match(/\/Type\s*\/Page\b/g)?.length || 0);
      return {
        text: stdout,
        pageCount,
        ingestionMethod: "pdftotext",
      };
    }
  } catch {
    // Fall through to the inline parser when Poppler is unavailable.
  }
  return extractPdfTextHeuristically(pdfBytes);
}

function tokenize(text) {
  return Array.from(
    new Set(
      normalizeString(text)
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3),
    ),
  );
}

function scoreEvidenceCandidate(problemTokens, candidateText) {
  const haystack = new Set(tokenize(candidateText));
  let score = 0;
  for (const token of problemTokens) {
    if (haystack.has(token)) score += 1;
  }
  return score;
}

function slugify(text) {
  return normalizeString(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "research";
}

function makeSourceId(seed) {
  return createHash("sha1").update(seed).digest("hex").slice(0, 12);
}

function toArtifactDir(repoRoot) {
  return resolve(repoRoot, ...ARTIFACT_DIR);
}

function normalizeRepoRelativePath(filePath) {
  return normalizeString(filePath).replace(/\\/g, "/");
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  return [value];
}

function parseCorpusPaths(value) {
  if (Array.isArray(value)) {
    return dedupeStrings(
      value.flatMap((entry) => parseCorpusPaths(entry)),
    );
  }
  return dedupeStrings(
    normalizeString(value)
      .split(/[\r\n,;]+/)
      .map((entry) => entry.trim()),
  );
}

function parsePathList(value) {
  return parseCorpusPaths(value);
}

function normalizeLiteratureResult(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const title = normalizeString(raw.title || raw.name || `Web Result ${index + 1}`);
  const url = normalizeString(raw.url || raw.link || raw.href);
  const snippet = normalizeString(raw.snippet || raw.description || raw.body || raw.text);
  return {
    id: `web-${makeSourceId(`${title}|${url}|${snippet}`)}`,
    title,
    citation: title,
    locator: url || null,
    origin: "literature-search",
    excerpt: truncate(snippet, 420),
    score: 0,
    metadata: {
      rank: index + 1,
      domain: normalizeString(raw.domain || ""),
    },
  };
}

function normalizeExternalSource(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const title = normalizeString(raw.title || raw.citation || `External Source ${index + 1}`);
  const locator = normalizeString(raw.locator || raw.url || raw.path);
  const excerpt = truncate(raw.excerpt || raw.summary || raw.text || raw.snippet, 420);
  return {
    id: normalizeString(raw.id) || `external-${makeSourceId(`${title}|${locator}|${excerpt}`)}`,
    title,
    citation: normalizeString(raw.citation) || title,
    locator: locator || null,
    origin: normalizeString(raw.origin || "external-sidecar"),
    excerpt,
    score: Number.isFinite(Number(raw.score)) ? Number(raw.score) : 0,
    metadata: raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {},
  };
}

async function walkCandidateFiles(targetPath, collected, warnings, limit = MAX_LOCAL_FILES) {
  if (collected.length >= limit) return;
  if (!existsSync(targetPath)) {
    warnings.push(`Corpus path not found: ${targetPath}`);
    return;
  }
  const stats = statSync(targetPath);
  if (stats.isDirectory()) {
    const names = await readdir(targetPath);
    for (const name of names.sort()) {
      if (collected.length >= limit) break;
      await walkCandidateFiles(resolve(targetPath, name), collected, warnings, limit);
    }
    return;
  }
  if (!stats.isFile()) return;
  const extension = extname(targetPath).toLowerCase();
  const isTextFile = TEXT_FILE_EXTENSIONS.has(extension);
  const isPdfFile = PDF_FILE_EXTENSIONS.has(extension);
  if (!isTextFile && !isPdfFile) {
    warnings.push(`Skipped non-text corpus file: ${targetPath}`);
    return;
  }
  const byteLimit = isPdfFile ? MAX_PDF_FILE_BYTES : MAX_TEXT_FILE_BYTES;
  if (stats.size > byteLimit) {
    warnings.push(`Skipped large corpus file (${stats.size} bytes): ${targetPath}`);
    return;
  }
  collected.push(targetPath);
}

function readTextExcerpt(filePath) {
  const raw = readFileSync(filePath, "utf8");
  const normalized = raw.replace(/\0/g, "").trim();
  return truncate(normalized, 1200);
}

function readTailUtf8(filePath, maxBytes = MAX_RUNTIME_LOG_BYTES) {
  const buffer = readFileSync(filePath);
  if (buffer.length <= maxBytes) {
    return buffer.toString("utf8").replace(/\0/g, "");
  }
  return buffer.subarray(buffer.length - maxBytes).toString("utf8").replace(/\0/g, "");
}

function collectMatchedLogLines(text, problemTokens, maxLines = 8) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  const matched = [];
  for (const line of lines) {
    const haystack = line.toLowerCase();
    const hits = problemTokens.filter((token) => haystack.includes(token));
    if (hits.length === 0) continue;
    matched.push({
      line,
      hits,
      score: hits.length,
    });
  }
  matched.sort((left, right) => right.score - left.score || left.line.localeCompare(right.line));
  const excerptLines = matched.slice(0, maxLines).map((entry) => entry.line);
  return dedupeStrings(excerptLines);
}

function resolveContentType(extension) {
  if (PDF_FILE_EXTENSIONS.has(extension)) return "application/pdf";
  if (extension === ".json") return "application/json";
  if (extension === ".jsonl") return "application/x-ndjson";
  if (extension === ".yaml" || extension === ".yml") return "application/yaml";
  if (extension === ".html" || extension === ".htm") return "text/html";
  if (extension === ".xml") return "application/xml";
  if (extension === ".csv") return "text/csv";
  if (extension === ".tsv") return "text/tab-separated-values";
  return "text/plain";
}

function readCorpusSource(filePath) {
  const stats = statSync(filePath);
  const extension = extname(filePath).toLowerCase();
  const baseMetadata = {
    fileExtension: extension,
    fileSizeBytes: stats.size,
    contentType: resolveContentType(extension),
  };
  if (PDF_FILE_EXTENSIONS.has(extension)) {
    const extraction = extractPdfText(filePath);
    return {
      excerpt: truncate(extraction.text, 1200),
      metadata: {
        ...baseMetadata,
        sourceKind: "pdf",
        ingestionMethod: extraction.ingestionMethod,
        pageCount: extraction.pageCount,
        extractedCharacters: extraction.text.length,
      },
    };
  }
  return {
    excerpt: readTextExcerpt(filePath),
    metadata: {
      ...baseMetadata,
      sourceKind: "text",
      ingestionMethod: "utf8-read",
    },
  };
}

async function collectCorpusSources(config) {
  const warnings = [];
  const files = [];
  for (const rawPath of config.corpusPaths) {
    const absolutePath = isAbsolute(rawPath) ? rawPath : resolve(config.repoRoot, rawPath);
    await walkCandidateFiles(absolutePath, files, warnings);
  }

  const problemTokens = tokenize(config.problem);
  const sources = [];
  for (const filePath of files) {
    try {
      const { excerpt, metadata } = readCorpusSource(filePath);
      const relPath = normalizeRepoRelativePath(relative(config.repoRoot, filePath) || basename(filePath));
      sources.push({
        id: `corpus-${makeSourceId(`${filePath}|${excerpt}`)}`,
        title: relPath,
        citation: relPath,
        locator: filePath,
        origin: "corpus",
        excerpt,
        score: scoreEvidenceCandidate(problemTokens, `${relPath}\n${excerpt}`),
        metadata: {
          relativePath: relPath,
          ...metadata,
        },
      });
    } catch (error) {
      warnings.push(`Failed to read corpus file ${filePath}: ${error.message}`);
    }
  }

  return { sources, warnings };
}

async function collectRuntimeLogSources(config) {
  if (config.includeRuntimeLogEvidence !== true) {
    return { sources: [], warnings: [] };
  }
  const warnings = [];
  const problemTokens = tokenize(config.problem);
  const candidatePaths = dedupeStrings(
    (config.runtimeLogPaths.length > 0 ? config.runtimeLogPaths : DEFAULT_RUNTIME_LOG_FILES)
      .map((rawPath) => (isAbsolute(rawPath) ? rawPath : resolve(config.repoRoot, rawPath))),
  );
  const sources = [];
  for (const filePath of candidatePaths) {
    if (!existsSync(filePath)) continue;
    try {
      const stats = statSync(filePath);
      if (!stats.isFile()) continue;
      const logText = readTailUtf8(filePath, MAX_RUNTIME_LOG_BYTES);
      const excerptLines = collectMatchedLogLines(logText, problemTokens);
      if (excerptLines.length === 0) continue;
      const relPath = normalizeRepoRelativePath(relative(config.repoRoot, filePath) || basename(filePath));
      const excerpt = truncate(excerptLines.join("\n"), 1200);
      sources.push({
        id: `runtime-log-${makeSourceId(`${filePath}|${excerpt}`)}`,
        title: relPath,
        citation: relPath,
        locator: filePath,
        origin: "runtime-log",
        excerpt,
        score: scoreEvidenceCandidate(problemTokens, `${relPath}\n${excerpt}`),
        metadata: {
          relativePath: relPath,
          sourceKind: "runtime-log",
          contentType: "text/plain",
          ingestionMethod: "tail-line-query",
          fileSizeBytes: stats.size,
          matchedLineCount: excerptLines.length,
        },
      });
    } catch (error) {
      warnings.push(`Failed to read runtime log ${filePath}: ${error.message}`);
    }
  }
  return { sources, warnings };
}

function buildAnalysisPromptHint(mode) {
  switch (mode) {
    case "contradictions":
      return "Prioritize conflicting findings, disputed assumptions, and explicit disagreement between sources.";
    case "summarize":
      return "Prioritize concise evidence synthesis with citations rather than exploratory speculation.";
    case "evidence-only":
      return "Return an evidence inventory and uncertainty summary without inventing unsupported conclusions.";
    case "answer":
    default:
      return "Ground the answer in the strongest cited evidence and state uncertainty when support is incomplete.";
  }
}

function intersection(left = [], right = []) {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function splitIntoSentences(text) {
  return normalizeString(text)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => normalizeString(sentence))
    .filter(Boolean);
}

function classifySupportStrength(score, overlapCount) {
  const strengthScore = Math.max(Number(score) || 0, overlapCount || 0);
  if (strengthScore >= 5) return "strong";
  if (strengthScore >= 3) return "moderate";
  return "limited";
}

function chooseRepresentativeSentence(source, problemTokens) {
  const sentences = splitIntoSentences(source.excerpt);
  if (sentences.length === 0) {
    return {
      sentence: truncate(source.excerpt, 220),
      overlapTokens: [],
    };
  }

  let bestSentence = sentences[0];
  let bestOverlap = intersection(problemTokens, tokenize(sentences[0]));
  let bestScore = bestOverlap.length;
  for (const sentence of sentences.slice(1)) {
    const overlapTokens = intersection(problemTokens, tokenize(sentence));
    const overlapScore = overlapTokens.length;
    if (overlapScore > bestScore || (overlapScore === bestScore && sentence.length > bestSentence.length)) {
      bestSentence = sentence;
      bestOverlap = overlapTokens;
      bestScore = overlapScore;
    }
  }

  return {
    sentence: truncate(bestSentence, 220),
    overlapTokens: bestOverlap,
  };
}

function buildSourceHighlights(sources, problemTokens) {
  return sources.map((source, index) => {
    const citationKey = `[E${index + 1}]`;
    const representative = chooseRepresentativeSentence(source, problemTokens);
    return {
      citationKey,
      finding: representative.sentence,
      supportStrength: classifySupportStrength(source.score, representative.overlapTokens.length),
      overlapTokens: representative.overlapTokens,
      title: source.title,
    };
  });
}

const SUPPORT_PATTERNS = [
  /\bimprov(?:e|es|ed|ing)\b/i,
  /\beffective\b/i,
  /\bbenefit(?:s|ed|ing)?\b/i,
  /\brecommend(?:ed|s|ing)?\b/i,
  /\bsupport(?:s|ed|ing)?\b/i,
  /\breduc(?:e|es|ed|ing)\b/i,
  /\blower(?:s|ed|ing)?\b/i,
  /\boutperform(?:s|ed|ing)?\b/i,
];

const REFUTE_PATTERNS = [
  /\b(?:does not|do not|did not|no)\s+\w+/i,
  /\bineffective\b/i,
  /\bnot recommended\b/i,
  /\bno evidence\b/i,
  /\bfail(?:s|ed|ing)?\s+to\b/i,
  /\bdoes not support\b/i,
  /\bnot support(?:ed|ing)?\b/i,
  /\bworsen(?:s|ed|ing)?\b/i,
  /\bincreas(?:e|es|ed|ing)\b.*\brisk\b/i,
  /\bmay increase\b/i,
];

const UNCERTAINTY_PATTERNS = [
  /\buncertain\b/i,
  /\bmixed\b/i,
  /\blimited\b/i,
  /\bpreliminary\b/i,
  /\binconclusive\b/i,
  /\bmay\b/i,
  /\bmight\b/i,
];

function scorePatternMatches(text, patterns) {
  return patterns.reduce((score, pattern) => score + (pattern.test(text) ? 1 : 0), 0);
}

function classifyEvidenceStance(text) {
  const normalized = normalizeString(text);
  const supportScore = scorePatternMatches(normalized, SUPPORT_PATTERNS);
  const refuteScore = scorePatternMatches(normalized, REFUTE_PATTERNS);
  const uncertaintyScore = scorePatternMatches(normalized, UNCERTAINTY_PATTERNS);

  if (supportScore > refuteScore && supportScore > 0) return "support";
  if (refuteScore > supportScore && refuteScore > 0) return "refute";
  if (uncertaintyScore > 0) return "uncertain";
  return "neutral";
}

function detectEvidenceConflicts(sources, problemTokens) {
  const conflicts = [];
  for (let leftIndex = 0; leftIndex < sources.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < sources.length; rightIndex += 1) {
      const left = sources[leftIndex];
      const right = sources[rightIndex];
      const leftTokens = tokenize(`${left.title}\n${left.excerpt}`);
      const rightTokens = tokenize(`${right.title}\n${right.excerpt}`);
      const topicTokens = intersection(problemTokens, intersection(leftTokens, rightTokens)).slice(0, 4);
      if (topicTokens.length === 0) continue;

      const leftStance = classifyEvidenceStance(left.excerpt);
      const rightStance = classifyEvidenceStance(right.excerpt);
      if (!((leftStance === "support" && rightStance === "refute") || (leftStance === "refute" && rightStance === "support"))) {
        continue;
      }

      conflicts.push({
        left: left.citationKey || `[E${leftIndex + 1}]`,
        right: right.citationKey || `[E${rightIndex + 1}]`,
        reason: `Sources disagree about ${topicTokens.join(", ")}.`,
        severity: topicTokens.length >= 2 ? "high" : "medium",
        topicTokens,
      });
    }
  }
  return conflicts;
}

function computeEvidenceCoverage(problemTokens, sources) {
  if (problemTokens.length === 0) {
    return { coveredTokens: [], missingTokens: [], coverageRatio: 1 };
  }
  const covered = new Set();
  for (const source of sources) {
    for (const token of tokenize(`${source.title}\n${source.excerpt}`)) {
      if (problemTokens.includes(token)) covered.add(token);
    }
  }
  const coveredTokens = problemTokens.filter((token) => covered.has(token));
  return {
    coveredTokens,
    missingTokens: problemTokens.filter((token) => !covered.has(token)),
    coverageRatio: coveredTokens.length / problemTokens.length,
  };
}

function buildUncertaintySummary({ sources, conflicts, coverage }) {
  const clauses = [];
  if (sources.length === 0) {
    clauses.push("No retained evidence sources were available for synthesis.");
  } else if (sources.length === 1) {
    clauses.push("Only one retained source was available, so cross-source corroboration is weak.");
  }
  if ((coverage?.coverageRatio || 0) < 0.45) {
    clauses.push("The retained evidence only partially overlaps the problem statement.");
  }
  if (conflicts.length > 0) {
    clauses.push("Some retained sources point in different directions and need careful verification.");
  }
  return clauses.join(" ").trim();
}

function buildLocalReviewHints({ sources, conflicts, coverage, warnings }) {
  const hints = [];
  if (sources.length === 0) {
    hints.push("No retained evidence sources are available. The answer should stay at limitations and next-data-needed only.");
  } else if (sources.length === 1) {
    hints.push("Only one retained evidence source is available. Treat any conclusion as provisional until corroborated.");
  }
  if ((coverage?.coverageRatio || 0) < 0.45) {
    hints.push(
      `Problem-token coverage is weak (${coverage.coveredTokens.length}/${coverage.coveredTokens.length + coverage.missingTokens.length}). Check for unsupported leaps and note the missing direct evidence.`,
    );
  }
  if (sources.every((source) => (Number(source.score) || 0) < 2)) {
    hints.push("The retained evidence is indirect relative to the question. Avoid strong causal claims.");
  }
  if (conflicts.length > 0) {
    hints.push(`Conflicting evidence detected across ${conflicts.map((conflict) => `${conflict.left}/${conflict.right}`).join(", ")}. Verify the disagreement explicitly before promoting findings.`);
  }
  if (warnings.length > 0) {
    hints.push(`Collection warnings: ${warnings.join(" | ")}`);
  }
  return hints.join(" ").trim();
}

function summarizeEvidenceSupport({ problem, mode, highlights, conflicts, uncertaintySummary }) {
  if (highlights.length === 0) {
    return `The retained evidence does not yet answer "${problem}" directly. ${uncertaintySummary}`.trim();
  }

  const topHighlights = highlights.slice(0, 3);
  const renderHighlight = (highlight) => `${highlight.finding} ${highlight.citationKey}`.trim();

  switch (mode) {
    case "contradictions": {
      const opening = conflicts.length > 0
        ? `The retained evidence is mixed for "${problem}". ${renderHighlight(topHighlights[0])}`
        : `The retained evidence does not show a strong contradiction for "${problem}", but it remains mixed. ${renderHighlight(topHighlights[0])}`;
      const contrast = topHighlights[1]
        ? ` In contrast, ${renderHighlight(topHighlights[1]).replace(/^[A-Z]/, (match) => match.toLowerCase())}`
        : "";
      const conflictLine = conflicts[0] ? ` ${conflicts[0].left} and ${conflicts[0].right} disagree: ${conflicts[0].reason}` : "";
      return `${opening}${contrast}${conflictLine}${uncertaintySummary ? ` ${uncertaintySummary}` : ""}`.trim();
    }
    case "summarize":
      return `Across the retained evidence for "${problem}", ${topHighlights.map((highlight) => renderHighlight(highlight).replace(/^[A-Z]/, (match) => match.toLowerCase())).join("; ")}.${uncertaintySummary ? ` ${uncertaintySummary}` : ""}`.trim();
    case "evidence-only":
      return `Evidence inventory for "${problem}": ${topHighlights.map((highlight) => `${highlight.citationKey} ${highlight.finding}`).join("; ")}.${uncertaintySummary ? ` ${uncertaintySummary}` : ""}`.trim();
    case "answer":
    default: {
      const supporting = topHighlights.slice(1).map((highlight) => renderHighlight(highlight).replace(/^[A-Z]/, (match) => match.toLowerCase()));
      const supportLine = supporting.length > 0 ? ` Additional retained evidence indicates ${supporting.join("; ")}.` : "";
      return `The strongest retained evidence for "${problem}" indicates that ${renderHighlight(topHighlights[0]).replace(/^[A-Z]/, (match) => match.toLowerCase())}.${supportLine}${uncertaintySummary ? ` ${uncertaintySummary}` : ""}`.trim();
    }
  }
}

function buildEvidenceBrief(bundle) {
  const lines = [
    `Mode: ${bundle.mode}`,
    `Evidence sources retained: ${bundle.sources.length}`,
  ];
  if (bundle.toolBundleBrief) {
    lines.push(`Tool bundle: ${bundle.toolBundleBrief}`);
  }
  if (bundle.warnings.length > 0) {
    lines.push(`Warnings: ${bundle.warnings.join(" | ")}`);
  }
  lines.push("");
  for (const [index, source] of bundle.sources.entries()) {
    const locator = source.locator ? ` (${source.locator})` : "";
    lines.push(`[E${index + 1}] ${source.citation}${locator}`);
    lines.push(`Excerpt: ${truncate(source.excerpt, 260)}`);
  }
  return lines.join("\n").trim();
}

function summarizeToolBundle(bundle) {
  if (!bundle) return "";
  const recommended = Array.isArray(bundle.recommendedCatalogEntries)
    ? bundle.recommendedCatalogEntries.map((entry) => entry.id)
    : [];
  const optional = Array.isArray(bundle.optionalCatalogEntries)
    ? bundle.optionalCatalogEntries.map((entry) => entry.id)
    : [];
  const nativeCaps = Array.isArray(bundle.nativeCapabilities)
    ? bundle.nativeCapabilities.map((entry) => entry.id)
    : [];
  return [
    `${bundle.name} (${bundle.id})`,
    recommended.length > 0 ? `recommended MCP: ${recommended.join(", ")}` : "",
    optional.length > 0 ? `optional MCP: ${optional.join(", ")}` : "",
    nativeCaps.length > 0 ? `native: ${nativeCaps.join(", ")}` : "",
  ].filter(Boolean).join(" | ");
}

function normalizeExternalBundle(raw, config) {
  if (!raw || typeof raw !== "object") return null;
  const externalSources = asArray(raw.sources)
    .map((entry, index) => normalizeExternalSource(entry, index))
    .filter(Boolean);
  return {
    mode: normalizeString(raw.mode) || config.evidenceMode,
    summary: normalizeString(raw.summary || raw.answer || ""),
    citations: dedupeStrings(asArray(raw.citations)),
    reviewHints: normalizeString(raw.reviewHints || raw.verificationHints || ""),
    warnings: dedupeStrings(asArray(raw.warnings)),
    sources: externalSources,
    conflicts: Array.isArray(raw.conflicts) ? raw.conflicts : [],
    highlights: Array.isArray(raw.highlights) ? raw.highlights : [],
    uncertaintySummary: normalizeString(raw.uncertaintySummary),
    metrics: raw.metrics && typeof raw.metrics === "object" ? raw.metrics : {},
    raw,
  };
}

function mergeEvidenceBundles(localBundle, externalBundle, config) {
  const merged = [];
  const seen = new Set();
  for (const source of [...(externalBundle?.sources || []), ...(localBundle.sources || [])]) {
    if (!source) continue;
    const key = `${normalizeString(source.citation).toLowerCase()}|${normalizeString(source.locator).toLowerCase()}|${normalizeString(source.excerpt).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(source);
  }

  const problemTokens = tokenize(config.problem);
  for (const source of merged) {
    const intrinsic = scoreEvidenceCandidate(problemTokens, `${source.title}\n${source.excerpt}`);
    source.score = Math.max(Number(source.score) || 0, intrinsic);
  }

  merged.sort((left, right) => {
    if ((right.score || 0) !== (left.score || 0)) return (right.score || 0) - (left.score || 0);
    return normalizeString(left.citation).localeCompare(normalizeString(right.citation));
  });

  const sources = merged.slice(0, config.maxEvidenceSources).map((source, index) => ({
    ...source,
    citationKey: `[E${index + 1}]`,
  }));
  const coverage = computeEvidenceCoverage(problemTokens, sources);
  const localHighlights = buildSourceHighlights(sources, problemTokens);
  const localConflicts = detectEvidenceConflicts(sources, problemTokens);
  const localUncertaintySummary = buildUncertaintySummary({
    sources,
    conflicts: localConflicts,
    coverage,
  });
  const localReviewHints = buildLocalReviewHints({
    sources,
    conflicts: localConflicts,
    coverage,
    warnings: dedupeStrings([
      ...(localBundle.warnings || []),
      ...(externalBundle?.warnings || []),
    ]),
  });
  const localSummary = summarizeEvidenceSupport({
    problem: config.problem,
    mode: config.evidenceMode,
    highlights: localHighlights,
    conflicts: localConflicts,
    uncertaintySummary: localUncertaintySummary,
  });
  return {
    schemaVersion: 1,
    sidecarVersion: SIDECAR_VERSION,
    problem: config.problem,
    domain: config.domain,
    mode: config.evidenceMode,
    analysisPromptHint: buildAnalysisPromptHint(config.evidenceMode),
    summary: normalizeString(externalBundle?.summary) || localSummary,
    citations: dedupeStrings([
      ...(externalBundle?.citations || []),
      ...sources.map((source, index) => `[E${index + 1}] ${source.citation}`),
    ]),
    reviewHints: normalizeString(externalBundle?.reviewHints) || localReviewHints,
    warnings: dedupeStrings([
      ...(localBundle.warnings || []),
      ...(externalBundle?.warnings || []),
    ]),
    sources,
    highlights: externalBundle?.highlights?.length ? externalBundle.highlights : localHighlights,
    conflicts: externalBundle?.conflicts?.length ? externalBundle.conflicts : localConflicts,
    uncertaintySummary: normalizeString(externalBundle?.uncertaintySummary) || localUncertaintySummary,
    metrics: {
      literatureSearchSourceCount: localBundle.metrics.literatureSearchSourceCount || 0,
      corpusSourceCount: localBundle.metrics.corpusSourceCount || 0,
      runtimeLogSourceCount: localBundle.metrics.runtimeLogSourceCount || 0,
      retainedSourceCount: sources.length,
      delegationUsed: externalBundle != null,
      unsupportedCorpusCount: (localBundle.metrics.unsupportedCorpusCount || 0),
      externalMetrics: externalBundle?.metrics || {},
      problemTokenCoverageRatio: Number(coverage.coverageRatio.toFixed(3)),
      coveredProblemTokenCount: coverage.coveredTokens.length,
      conflictingSourcePairs: (externalBundle?.conflicts?.length || localConflicts.length),
    },
  };
}

function splitCommandArguments(command) {
  const tokens = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (char === "\\" && quote === '"' && index + 1 < command.length) {
        const next = command[index + 1];
        if (next === '"' || next === "\\") {
          current += next;
          index += 1;
          continue;
        }
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) return null;
  if (current) tokens.push(current);
  return tokens;
}

function commandRequiresShell(command, tokens) {
  if (!tokens?.length) return true;
  if (/[|&;<>()`]/.test(command)) return true;
  const executable = normalizeString(tokens[0]).toLowerCase();
  return executable.endsWith(".cmd") || executable.endsWith(".bat");
}

async function runExternalResearchEvidenceSidecar(config) {
  const command = normalizeString(config.sidecarCommand);
  if (!command) return null;
  return new Promise((resolvePromise) => {
    const tokens = splitCommandArguments(command);
    const useShell = commandRequiresShell(command, tokens);
    const child = spawn(
      useShell
        ? (process.platform === "win32" ? "cmd.exe" : "sh")
        : tokens[0],
      useShell
        ? (process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command])
        : tokens.slice(1),
      {
        cwd: config.repoRoot,
        env: {
          ...process.env,
          BOSUN_RESEARCH_SIDECAR_MODE: config.evidenceMode,
          BOSUN_RESEARCH_SIDECAR_DOMAIN: config.domain,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      resolvePromise({
        success: false,
        error: error.message,
        stdout,
        stderr,
      });
    });
    child.on("close", (exitCode) => {
      let parsed = null;
      try {
        parsed = JSON.parse(stdout.trim() || "{}");
      } catch {
        parsed = null;
      }
      resolvePromise({
        success: exitCode === 0 && parsed != null,
        exitCode,
        parsed,
        stdout: truncate(stdout, 1600),
        stderr: truncate(stderr, 1200),
        error: exitCode === 0 ? null : `External sidecar exited with code ${exitCode}`,
      });
    });
    child.stdin.end(JSON.stringify({
      schemaVersion: 1,
      problem: config.problem,
      domain: config.domain,
      evidenceMode: config.evidenceMode,
      maxEvidenceSources: config.maxEvidenceSources,
      corpusPaths: config.corpusPaths,
      literatureResults: config.literatureResults,
      repoRoot: config.repoRoot,
    }));
  });
}

function writeArtifact(repoRoot, problem, payload) {
  const artifactDir = toArtifactDir(repoRoot);
  mkdirSync(artifactDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactPath = resolve(artifactDir, `${timestamp}-${slugify(problem)}.json`);
  writeFileSync(artifactPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return artifactPath;
}

export function resolveResearchEvidenceSidecarConfig(input = {}) {
  const repoRoot = resolve(normalizeString(input.repoRoot) || process.cwd());
  const problem = normalizeString(input.problem || input.question);
  if (!problem) {
    throw new Error("Research evidence sidecar requires a problem statement.");
  }

  return {
    repoRoot,
    workspaceId: normalizeString(input.workspaceId),
    domain: normalizeString(input.domain || "computer-science") || "computer-science",
    problem,
    researchToolBundleId: normalizeString(input.researchToolBundleId || input.toolBundleId || "scientific-evidence") || "scientific-evidence",
    evidenceMode: normalizeString(input.evidenceMode || input.mode || "answer") || "answer",
    maxEvidenceSources: parseInteger(input.maxEvidenceSources || input.maxSources, DEFAULT_MAX_SOURCES, 1, 20),
    searchLiterature: parseBoolean(input.searchLiterature, true),
    promoteReviewedFindings: parseBoolean(input.promoteReviewedFindings, true),
    includeRuntimeLogEvidence: parseBoolean(input.includeRuntimeLogEvidence, true),
    corpusPaths: parseCorpusPaths(input.corpusPaths),
    runtimeLogPaths: parsePathList(input.runtimeLogPaths),
    literatureResults: asArray(input.literatureResults),
    triggerSource: normalizeString(input.triggerSource || "manual"),
    sidecarCommand: normalizeString(input.sidecarCommand),
  };
}

export async function runResearchEvidenceSidecar(input = {}) {
  const config = resolveResearchEvidenceSidecarConfig(input);
  const researchToolBundle = getResearchToolBundle(config.researchToolBundleId, {
    includeExperimental: true,
  });
  const literatureSources = config.searchLiterature
    ? config.literatureResults.map((entry, index) => normalizeLiteratureResult(entry, index)).filter(Boolean)
    : [];
  const { sources: corpusSources, warnings: corpusWarnings } = await collectCorpusSources(config);
  const { sources: runtimeLogSources, warnings: runtimeLogWarnings } = await collectRuntimeLogSources(config);

  const localBundle = {
    sources: [...literatureSources, ...corpusSources, ...runtimeLogSources],
    warnings: [...corpusWarnings, ...runtimeLogWarnings],
    metrics: {
      literatureSearchSourceCount: literatureSources.length,
      corpusSourceCount: corpusSources.length,
      runtimeLogSourceCount: runtimeLogSources.length,
      unsupportedCorpusCount: corpusWarnings.filter((warning) => warning.startsWith("Skipped")).length,
    },
  };

  let externalResult = null;
  let externalBundle = null;
  if (config.sidecarCommand) {
    externalResult = await runExternalResearchEvidenceSidecar(config);
    if (externalResult?.success && externalResult.parsed) {
      externalBundle = normalizeExternalBundle(externalResult.parsed, config);
    } else if (externalResult) {
      localBundle.warnings.push(
        `External sidecar fallback engaged: ${externalResult.error || externalResult.stderr || "unknown delegation error"}`,
      );
    }
  }

  const bundle = mergeEvidenceBundles(localBundle, externalBundle, config);
  bundle.researchToolBundle = researchToolBundle;
  bundle.toolBundleBrief = summarizeToolBundle(researchToolBundle);
  bundle.summary = bundle.summary || summarizeEvidenceSupport({
    problem: config.problem,
    mode: config.evidenceMode,
    highlights: bundle.highlights || [],
    conflicts: bundle.conflicts || [],
    uncertaintySummary: bundle.uncertaintySummary || "",
  }) || buildEvidenceBrief(bundle);
  const artifactPayload = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    config,
    bundle,
    delegation: externalResult
      ? {
          command: config.sidecarCommand,
          success: externalResult.success === true,
          exitCode: externalResult.exitCode ?? null,
          stderr: externalResult.stderr || "",
        }
      : null,
  };
  const artifactPath = writeArtifact(config.repoRoot, config.problem, artifactPayload);

  return {
    success: true,
    artifactPath,
    bundle,
    evidenceBrief: buildEvidenceBrief(bundle),
    citationsMarkdown: bundle.citations.join("\n"),
    researchToolBundle,
    toolBundleBrief: bundle.toolBundleBrief,
    delegation: artifactPayload.delegation,
  };
}

function normalizeVerdict(value) {
  const text = normalizeString(value).toLowerCase();
  if (text.includes("critical")) return "critical";
  if (text.includes("minor")) return "minor";
  if (text.includes("correct")) return "correct";
  return text || "unknown";
}

export function buildReviewedKnowledgeCandidate(input = {}) {
  const bundle = input.bundle && typeof input.bundle === "object" ? input.bundle : null;
  const verdict = normalizeVerdict(input.verdict || input.verifierOutput);
  if (verdict !== "correct") {
    return {
      success: false,
      promote: false,
      reason: `Reviewed finding promotion requires a correct verdict, received: ${verdict || "unknown"}`,
    };
  }

  const problem = normalizeString(input.problem || bundle?.problem);
  const domain = normalizeString(input.domain || bundle?.domain || "computer-science");
  const finalAnswer = truncate(input.finalAnswer || input.answer || "", 900);
  const verifierOutput = truncate(input.verifierOutput || "", 280);
  const artifactPath = normalizeString(input.artifactPath);
  const citations = asArray(bundle?.citations).slice(0, 4);
  const topSources = asArray(bundle?.sources)
    .slice(0, 3)
    .map((source, index) => `[E${index + 1}] ${source.citation}${source.locator ? ` (${source.locator})` : ""}`);

  const lines = [
    `Reviewed research finding in ${domain}: ${problem}`,
    `Conclusion: ${finalAnswer}`,
  ];
  if (topSources.length > 0) {
    lines.push(`Evidence: ${topSources.join("; ")}`);
  }
  if (citations.length > 0) {
    lines.push(`Citation keys: ${citations.join(", ")}`);
  }
  if (verifierOutput) {
    lines.push(`Verifier: ${verifierOutput}`);
  }
  if (artifactPath) {
    lines.push(`Artifact: ${artifactPath}`);
  }

  return {
    success: true,
    promote: true,
    content: truncate(lines.join("\n"), 1800),
    scope: `research/${domain}`,
    category: "tip",
    tags: dedupeStrings(["research", "evidence-sidecar", domain, normalizeString(bundle?.mode || input.evidenceMode)]),
    artifactPath,
  };
}

function readCliInput() {
  if (process.env.BOSUN_RESEARCH_SIDECAR_INPUT) {
    return JSON.parse(process.env.BOSUN_RESEARCH_SIDECAR_INPUT);
  }
  const stdin = readFileSync(0, "utf8").trim();
  if (!stdin) return {};
  return JSON.parse(stdin);
}

async function runCli() {
  const command = normalizeString(process.argv[2] || "run").toLowerCase();
  const input = readCliInput();
  if (command === "promote") {
    const result = buildReviewedKnowledgeCandidate(input);
    process.stdout.write(JSON.stringify(result));
    return;
  }
  const result = await runResearchEvidenceSidecar(input);
  process.stdout.write(JSON.stringify(result));
}

const __filename = fileURLToPath(import.meta.url);

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
