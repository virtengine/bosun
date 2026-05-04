import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { taskCreate, taskList } from "../../task/task-cli.mjs";
import { WorkflowEngine } from "../../workflow/workflow-engine.mjs";
import "../../workflow/workflow-nodes.mjs";
import { installTemplateSet } from "../../workflow/workflow-templates.mjs";

const DEFAULT_SWEBENCH_TEMPLATE_IDS = Object.freeze(["template-task-lifecycle"]);
const DEFAULT_SWEBENCH_TEMPLATE_OVERRIDES = Object.freeze({
  "template-task-lifecycle": Object.freeze({
    maxParallel: 1,
  }),
});

export function usage() {
  console.log(`
Bosun SWE-bench bridge

Usage:
  node bench/swebench/bosun-swebench.mjs import --instances <path> [--status todo] [--priority high] [--candidates 3] [--no-ensure-runtime]
  node bench/swebench/bosun-swebench.mjs export --out <predictions.jsonl> --model <name>
  node bench/swebench/bosun-swebench.mjs eval --predictions <predictions.jsonl> --instance-ids <ids.jsonl> [--max-workers 8] [--run-id bosun-run]

Notes:
  - Uses official SWE-bench harness for evaluation:
      python -m swebench.harness.run_evaluation
  - Keeps Bosun in control of execution (multi-task / multi-turn / workflows).
`);
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.split("=", 2);
      if (v !== undefined) {
        args[k.slice(2)] = v;
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          args[k.slice(2)] = next;
          i += 1;
        } else {
          args[k.slice(2)] = true;
        }
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function isFlagDisabled(args, key) {
  const value = args?.[key];
  if (value === undefined) return false;
  if (value === true) return true;
  return ["0", "false", "no", "off"].includes(normString(value).toLowerCase());
}

export function readJsonOrJsonl(pathLike) {
  const file = resolve(pathLike);
  const raw = readFileSync(file, "utf8");
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error("Expected JSON array");
    return parsed;
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, idx) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`Invalid JSONL at line ${idx + 1}: ${err.message}`);
      }
    });
}

function normString(value) {
  return String(value == null ? "" : value).trim();
}

function firstNonEmpty(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v == null) continue;
    const s = normString(v);
    if (s) return s;
  }
  return "";
}

export function buildTaskFromInstance(instance, opts = {}) {
  const instanceId = firstNonEmpty(instance, ["instance_id", "id"]);
  if (!instanceId) throw new Error("Missing instance_id");
  const problem = firstNonEmpty(instance, ["problem_statement", "statement", "text"]);
  const repo = firstNonEmpty(instance, ["repo", "repo_name", "repository"]);
  const baseCommit = firstNonEmpty(instance, ["base_commit", "base_sha"]);
  const workspace = firstNonEmpty(instance, ["workspace", "repo_path", "local_repo"]);
  const parseCount = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.max(1, Math.min(12, Math.trunc(n)));
  };
  const candidateCount =
    parseCount(opts.candidateCount) ||
    parseCount(instance?.candidate_count) ||
    parseCount(instance?.candidateCount) ||
    1;

  const description = [
    problem,
    "",
    "## SWE-bench Metadata",
    `- instance_id: ${instanceId}`,
    repo ? `- repo: ${repo}` : "",
    baseCommit ? `- base_commit: ${baseCommit}` : "",
  ].filter(Boolean).join("\n");

  return {
    id: `swebench-${instanceId}`,
    title: `[SWE-bench] ${instanceId}`,
    description,
    status: opts.status || "todo",
    priority: opts.priority || "high",
    tags: ["swebench", "benchmark", "benchmark:swebench"],
    workspace: workspace || process.cwd(),
    repository: repo,
    baseBranch: "main",
    meta: {
      candidateCount: candidateCount > 1 ? candidateCount : undefined,
      execution: candidateCount > 1 ? { candidateCount } : {},
      benchmark: {
        type: "swebench",
        provider: "swebench",
      },
      swebench: {
        instance_id: instanceId,
        repo,
        base_commit: baseCommit,
        workspace,
        candidate_count: candidateCount > 1 ? candidateCount : undefined,
      },
    },
    candidateCount: candidateCount > 1 ? candidateCount : undefined,
  };
}

export function resolveSwebenchWorkflowRuntimePaths(workspace) {
  const repoRoot = resolve(normString(workspace) || process.cwd());
  return {
    repoRoot,
    workflowDir: resolve(repoRoot, ".bosun", "workflows"),
    runsDir: resolve(repoRoot, ".bosun", "workflow-runs"),
  };
}

export function resolveSwebenchKanbanStorePath(workspace) {
  const repoRoot = resolve(normString(workspace) || process.cwd());
  return resolve(repoRoot, ".bosun", ".cache", "kanban-state.json");
}

export function ensureSwebenchWorkflowRuntime(workspace, opts = {}) {
  const { repoRoot, workflowDir, runsDir } = resolveSwebenchWorkflowRuntimePaths(workspace);
  if (!existsSync(repoRoot)) {
    return {
      repoRoot,
      workflowDir,
      runsDir,
      installed: [],
      skipped: [],
      errors: [{ id: "workspace", error: `Workspace does not exist: ${repoRoot}` }],
    };
  }
  const templateIds = Array.isArray(opts.templateIds) && opts.templateIds.length > 0
    ? opts.templateIds
    : [...DEFAULT_SWEBENCH_TEMPLATE_IDS];
  const lifecycleOverrides = {
    ...DEFAULT_SWEBENCH_TEMPLATE_OVERRIDES["template-task-lifecycle"],
    ...(opts.overridesById?.["template-task-lifecycle"] || {}),
  };
  const overridesById = {
    ...DEFAULT_SWEBENCH_TEMPLATE_OVERRIDES,
    ...(opts.overridesById || {}),
    "template-task-lifecycle": lifecycleOverrides,
  };
  const engine = new WorkflowEngine({ workflowDir, runsDir });
  const result = installTemplateSet(engine, templateIds, overridesById);
  return {
    repoRoot,
    workflowDir,
    runsDir,
    ...result,
  };
}

export function writeJsonl(pathLike, records) {
  const outFile = resolve(pathLike);
  mkdirSync(dirname(outFile), { recursive: true });
  const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(outFile, body, "utf8");
  return outFile;
}

export function sha256File(pathLike) {
  const content = readFileSync(pathLike);
  return createHash("sha256").update(content).digest("hex");
}

function normalizeSafeGitArgs(args) {
  if (!Array.isArray(args)) return null;
  const normalized = args.map((arg) => String(arg || "").trim());
  if (normalized.length === 2 && normalized[0] === "rev-parse" && normalized[1] === "HEAD") {
    return normalized;
  }
  if (
    normalized.length === 3 &&
    normalized[0] === "rev-parse" &&
    normalized[1] === "--abbrev-ref" &&
    normalized[2] === "HEAD"
  ) {
    return normalized;
  }
  return null;
}

export function safeGit(args, cwd = process.cwd()) {
  try {
    const normalizedArgs = normalizeSafeGitArgs(args);
    if (!normalizedArgs) return "";
    return execFileSync("git", normalizedArgs, { encoding: "utf8", cwd }).trim();
  } catch {
    return "";
  }
}

export function getTaskSwebenchMeta(task) {
  const meta = task?.meta?.swebench;
  if (!meta || typeof meta !== "object") return null;
  const instanceId = normString(meta.instance_id);
  if (!instanceId) return null;
  return {
    instance_id: instanceId,
    repo: normString(meta.repo),
    base_commit: normString(meta.base_commit),
    workspace: normString(meta.workspace || task.workspace),
  };
}

export function computePatchForTask(task, sweMeta) {
  const repoDir = sweMeta.workspace || process.cwd();
  const base = sweMeta.base_commit;
  const ref = normString(task.branchName || "HEAD");
  if (!base) {
    throw new Error(`Task ${task.id} missing base_commit in meta.swebench`);
  }
  const diff = execFileSync("git", ["-C", repoDir, "diff", "--binary", `${base}...${ref}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return diff;
}

export async function cmdImport(args) {
  const instancesPath = normString(args.instances);
  if (!instancesPath) throw new Error("--instances is required");
  const instances = readJsonOrJsonl(instancesPath);
  const ensureRuntime = !isFlagDisabled(args, "no-ensure-runtime");
  let created = 0;
  let skipped = 0;
  const runtimeResults = new Map();

  for (const inst of instances) {
    const task = buildTaskFromInstance(inst, {
      status: normString(args.status) || "todo",
      priority: normString(args.priority) || "high",
      candidateCount: normString(args.candidates || args.candidateCount || ""),
    });
    if (ensureRuntime) {
      const runtimeKey = resolve(normString(task.workspace) || process.cwd());
      if (!runtimeResults.has(runtimeKey)) {
        const runtimeResult = ensureSwebenchWorkflowRuntime(task.workspace);
        if (Array.isArray(runtimeResult.errors) && runtimeResult.errors.length > 0) {
          const firstError = runtimeResult.errors[0];
          throw new Error(
            `Failed to ensure SWE-bench workflow runtime for ${runtimeKey}: ${firstError?.error || "unknown error"}`,
          );
        }
        runtimeResults.set(runtimeKey, runtimeResult);
      }
    }

    try {
      const previousStorePath = process.env.BOSUN_STORE_PATH;
      process.env.BOSUN_STORE_PATH = resolveSwebenchKanbanStorePath(task.workspace);
      try {
        await taskCreate(task);
      } finally {
        if (previousStorePath == null) {
          delete process.env.BOSUN_STORE_PATH;
        } else {
          process.env.BOSUN_STORE_PATH = previousStorePath;
        }
      }
      created += 1;
    } catch (err) {
      if (String(err.message || "").toLowerCase().includes("exists")) {
        skipped += 1;
      } else {
        throw err;
      }
    }
  }

  if (ensureRuntime) {
    let installed = 0;
    let alreadyPresent = 0;
    for (const result of runtimeResults.values()) {
      installed += Array.isArray(result.installed) ? result.installed.length : 0;
      alreadyPresent += Array.isArray(result.skipped) ? result.skipped.length : 0;
    }
    console.log(
      `Ensured SWE-bench workflow runtime: workspaces=${runtimeResults.size}, installed=${installed}, already_present=${alreadyPresent}`,
    );
  }

  console.log(`Imported SWE-bench tasks: created=${created}, skipped=${skipped}, total=${instances.length}`);
  return {
    created,
    skipped,
    total: instances.length,
    ensureRuntime,
    runtime: {
      workspaces: runtimeResults.size,
      installed: [...runtimeResults.values()].reduce(
        (sum, result) => sum + (Array.isArray(result.installed) ? result.installed.length : 0),
        0,
      ),
      alreadyPresent: [...runtimeResults.values()].reduce(
        (sum, result) => sum + (Array.isArray(result.skipped) ? result.skipped.length : 0),
        0,
      ),
    },
  };
}

export async function cmdExport(args) {
  const out = normString(args.out);
  if (!out) throw new Error("--out is required");
  const model = normString(args.model) || "bosun";

  const tasks = await taskList({});
  const candidates = tasks.filter((t) => {
    const meta = getTaskSwebenchMeta(t);
    if (!meta) return false;
    return ["done", "inreview"].includes(normString(t.status).toLowerCase());
  });

  const predictions = [];
  const errors = [];
  for (const task of candidates) {
    const sweMeta = getTaskSwebenchMeta(task);
    try {
      const patch = computePatchForTask(task, sweMeta);
      predictions.push({
        instance_id: sweMeta.instance_id,
        model_name_or_path: model,
        model_patch: patch,
      });
    } catch (err) {
      errors.push(`${task.id}: ${err.message}`);
    }
  }

  const outFile = writeJsonl(out, predictions);
  console.log(`Wrote ${predictions.length} predictions to ${outFile}`);
  if (errors.length > 0) {
    console.warn("Export warnings:");
    for (const e of errors) console.warn(`- ${e}`);
  }
}

export function cmdEval(args) {
  const predictions = normString(args.predictions);
  const instanceIds = normString(args["instance-ids"] || args.instances);
  if (!predictions) throw new Error("--predictions is required");
  if (!instanceIds) throw new Error("--instance-ids is required");

  const maxWorkers = Number(args["max-workers"] || 8);
  const runId = normString(args["run-id"]) || `bosun-${Date.now()}`;

  const cmd = [
    "-m",
    "swebench.harness.run_evaluation",
    "--predictions_path",
    resolve(predictions),
    "--instance_ids",
    resolve(instanceIds),
    "--run_id",
    runId,
    "--max_workers",
    String(Number.isFinite(maxWorkers) && maxWorkers > 0 ? Math.trunc(maxWorkers) : 8),
  ];

  console.log(`Running official SWE-bench evaluation: python ${cmd.join(" ")}`);
  const runDir = resolve("bench", "swebench", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const manifest = {
    run_id: runId,
    created_at: new Date().toISOString(),
    bosun_repo: process.cwd(),
    bosun_commit: safeGit(["rev-parse", "HEAD"]),
    bosun_branch: safeGit(["rev-parse", "--abbrev-ref", "HEAD"]),
    node_version: process.version,
    python_command: ["python", ...cmd],
    inputs: {
      predictions_path: resolve(predictions),
      predictions_sha256: existsSync(resolve(predictions)) ? sha256File(resolve(predictions)) : "",
      instance_ids_path: resolve(instanceIds),
      instance_ids_sha256: existsSync(resolve(instanceIds)) ? sha256File(resolve(instanceIds)) : "",
    },
  };
  const manifestPath = resolve(runDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Run manifest written: ${manifestPath}`);
  execFileSync("python", cmd, { stdio: "inherit" });
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const cmd = normString(args._[0] || "").toLowerCase();
  if (!cmd || ["-h", "--help", "help"].includes(cmd)) {
    usage();
    return;
  }

  if (cmd === "import") {
    await cmdImport(args);
    return;
  }
  if (cmd === "export") {
    await cmdExport(args);
    return;
  }
  if (cmd === "eval") {
    cmdEval(args);
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((err) => {
    console.error(`[bosun-swebench] ${err.message}`);
    process.exit(1);
  });
}
