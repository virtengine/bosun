import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config/config.mjs";
import {
  listConfiguredWorkflows,
  loadWorkflowInputFromFile,
  runConfiguredWorkflow,
} from "./declarative-workflows.mjs";
import { WorkflowEngine } from "./workflow-engine.mjs";
import { getTemplate, getTemplateGroup, listTemplates } from "./workflow-templates.mjs";
import { inspectCustomWorkflowNodePlugins } from "./workflow-nodes.mjs";

function hasFlag(args, ...flags) {
  return flags.some((flag) => args.includes(flag));
}

function getArgValue(args, flag) {
  const direct = args.find((arg) => arg.startsWith(`${flag}=`));
  if (direct) return direct.slice(flag.length + 1).trim();
  const index = args.indexOf(flag);
  if (index >= 0 && index + 1 < args.length) return String(args[index + 1] || "").trim();
  return "";
}

export function parseWorkflowInput(rawValue, cwd = process.cwd()) {
  const trimmed = String(rawValue || "").trim();
  if (!trimmed) return "";
  const fullPath = resolve(cwd, trimmed);
  if (existsSync(fullPath)) {
    const raw = readFileSync(fullPath, "utf8");
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function parseInput(args, cwd = process.cwd()) {
  const inputFile = getArgValue(args, "--file");
  if (inputFile) return loadWorkflowInputFromFile(inputFile);
  const inlineJson = getArgValue(args, "--input-json");
  if (inlineJson) return JSON.parse(inlineJson);
  const inputText = getArgValue(args, "--input");
  if (inputText) return parseWorkflowInput(inputText, cwd);
  const positional = args.filter((arg) => !arg.startsWith("--"));
  return positional.length > 2 ? positional.slice(2).join(" ") : "";
}

function formatCustomNodeHealthReport(report) {
  const lines = [
    "Custom node health",
    `repo=${report.repoRoot}`,
    `discovered=${report.summary.discovered} loaded=${report.summary.loaded} skipped=${report.summary.skipped} duplicateNodeIds=${report.summary.duplicateNodeIds} smokePassed=${report.summary.smokePassed} smokeFailed=${report.summary.smokeFailed}`,
  ];
  for (const plugin of report.plugins) {
    const manifestText = plugin.manifest?.id
      ? ` manifest=${plugin.manifest.id}@${plugin.manifest.version}`
      : "";
    lines.push(`- ${plugin.fileName}\t${plugin.status}${manifestText}`);
    for (const diagnostic of plugin.diagnostics || []) {
      lines.push(`  ! ${diagnostic.code}: ${diagnostic.message}`);
    }
    if (plugin.smokeTest) {
      lines.push(`  smoke=${plugin.smokeTest.status} ${plugin.smokeTest.message}`);
    }
  }
  return lines;
}

function showHelp(stdout = console.log) {
  stdout(`
  bosun workflow — Declarative multi-agent workflows

  SUBCOMMANDS
    list                      List configured and built-in workflows
    run <name> [input]        Run a workflow with fresh-context agents
    templates                 List built-in workflow-engine templates
    template-run <id> [input] Run a workflow-engine template directly
    nodes                     Inspect custom workflow node plugin health

  OPTIONS
    --json                    Emit JSON output
    --dry-run                 Render prompts without executing agents
    --input <text>            Inline workflow input
    --input-json <json>       Structured JSON input
    --file <path>             Load workflow input from a file
    --smoke                   Run plugin smoke tests during health inspection
`);
}

export function listWorkflowSummaries(config = loadConfig(process.argv)) {
  return listConfiguredWorkflows(config);
}

function cloneJson(value) {
  return value == null ? value ?? null : JSON.parse(JSON.stringify(value));
}

export function getTemplateRunDependencyIds(templateId) {
  const group = getTemplateGroup(templateId);
  if (!group || !Array.isArray(group.members)) return [];
  return group.members.filter((memberId) => memberId && memberId !== templateId);
}

export function installTemplateRunDependencies(engine, templateId) {
  if (!engine || typeof engine.save !== "function") return [];
  const dependencyIds = getTemplateRunDependencyIds(templateId);
  const installed = [];
  for (const dependencyId of dependencyIds) {
    const dependency = getTemplate(dependencyId);
    if (!dependency) continue;
    engine.save(cloneJson(dependency));
    installed.push(dependencyId);
  }
  return installed;
}

export async function waitForTemplateRunDispatches(dispatches = []) {
  const results = [];
  let index = 0;
  while (index < dispatches.length) {
    const batch = dispatches.slice(index);
    index = dispatches.length;
    results.push(...await Promise.all(batch));
  }
  return results;
}

function formatConsoleCaptureArg(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function withCapturedConsole(enabled, fn) {
  if (!enabled) {
    return { result: await fn(), consoleLines: [] };
  }
  const consoleLines = [];
  const originals = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const capture = (level) => (...args) => {
    consoleLines.push({
      level,
      message: args.map((value) => formatConsoleCaptureArg(value)).join(" ").trim(),
    });
  };
  console.log = capture("log");
  console.warn = capture("warn");
  console.error = capture("error");
  try {
    return { result: await fn(), consoleLines };
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  }
}

function buildTemplateRunReport(template, ctx, statusEvents = [], options = {}) {
  const nodes = Array.isArray(template?.nodes) ? template.nodes : [];
  return {
    template: {
      id: template?.id || null,
      name: template?.name || null,
      description: template?.description || "",
      category: template?.category || null,
    },
    runId: ctx?.id || null,
    dryRun: options.dryRun === true,
    status: String(ctx?.data?._workflowTerminalStatus || (ctx?.errors?.length ? "failed" : "completed")).trim().toLowerCase() || "completed",
    errors: Array.isArray(ctx?.errors) ? [...ctx.errors] : [],
    logs: Array.isArray(ctx?.logs) ? [...ctx.logs] : [],
    statusEvents: Array.isArray(statusEvents) ? statusEvents.map((entry) => ({ ...entry })) : [],
    engineConsole: Array.isArray(options.engineConsole) ? options.engineConsole.map((entry) => ({ ...entry })) : [],
    dispatches: Array.isArray(options.dispatches) ? options.dispatches.map((entry) => cloneJson(entry)) : [],
    data: cloneJson(ctx?.data || {}),
    nodes: nodes.map((node) => ({
      id: node?.id || null,
      label: node?.label || node?.id || null,
      type: node?.type || null,
      status: ctx?.getNodeStatus?.(node?.id) || "pending",
      input: cloneJson(ctx?.getNodeInput?.(node?.id) ?? null),
      output: cloneJson(ctx?.getNodeOutput?.(node?.id) ?? null),
      timing: cloneJson(ctx?.getNodeTiming?.(node?.id) ?? null),
    })),
  };
}

function formatTemplateRunReport(report = {}) {
  const lines = [
    `template=${report?.template?.id || "unknown"} status=${report?.status || "unknown"} runId=${report?.runId || "n/a"} dryRun=${report?.dryRun === true}`,
  ];
  for (const node of report?.nodes || []) {
    lines.push(`- ${node.id}\t${node.status}\t${node.type}`);
  }
  const dispatches = Array.isArray(report?.dispatches) ? report.dispatches : [];
  if (dispatches.length > 0) {
    const failed = dispatches.filter((entry) => entry?.status !== "fulfilled" || entry?.success === false).length;
    lines.push(`dispatches=${dispatches.length} failed=${failed}`);
  }
  const logTail = Array.isArray(report?.logs) ? report.logs.slice(-12) : [];
  for (const entry of logTail) {
    lines.push(`  log:${entry?.nodeId || "workflow"} ${entry?.level || "info"} ${String(entry?.message || "").trim()}`);
  }
  return lines;
}

export async function executeWorkflowCommand(args, options = {}) {
  const normalizedArgs = Array.isArray(args) && args[0] === "workflow" ? args.slice(1) : args;
  const subcommand = normalizedArgs?.[0] || "list";
  const stdout = options.stdout || ((line) => console.log(line));
  if (hasFlag(normalizedArgs, "--help", "-h") || subcommand === "help") {
    showHelp(stdout);
    return { ok: true, command: "help" };
  }

  const asJson = hasFlag(normalizedArgs, "--json") || options.json === true;
  if (subcommand === "nodes") {
    const inspectorOptions = {
      forceReload: hasFlag(normalizedArgs, "--reload", "--force-reload"),
      runSmokeTests: hasFlag(normalizedArgs, "--smoke", "--run-smoke-tests"),
      logWarnings: false,
    };
    if (options.repoRoot) {
      inspectorOptions.repoRoot = options.repoRoot;
    } else if (options.cwd) {
      inspectorOptions.repoRoot = options.cwd;
    }
    const report = await inspectCustomWorkflowNodePlugins(inspectorOptions);
    if (asJson) {
      stdout(JSON.stringify(report, null, 2));
    } else {
      for (const line of formatCustomNodeHealthReport(report)) stdout(line);
    }
    return { ok: true, command: "nodes", report };
  }

  const config = options.config || loadConfig(process.argv);
  if (subcommand === "list") {
    const workflows = listConfiguredWorkflows(config);
    if (asJson) {
      stdout(JSON.stringify(workflows, null, 2));
    } else {
      for (const workflow of workflows) {
        stdout(`${workflow.id}\t${workflow.type}\t${workflow.description}`);
      }
    }
    return { ok: true, command: "list", workflows };
  }

  if (subcommand === "templates") {
    const templates = listTemplates(options.cwd || process.cwd());
    if (asJson) {
      stdout(JSON.stringify(templates, null, 2));
    } else {
      for (const template of templates) {
        stdout(`${template.id}\t${template.category}\t${template.name}`);
      }
    }
    return { ok: true, command: "templates", templates };
  }

  if (subcommand === "run") {
    const name = normalizedArgs[1];
    if (!name) throw new Error("Workflow name is required. Usage: bosun workflow run <name>");
    const input = parseInput(normalizedArgs, options.cwd || process.cwd());
    const result = await runConfiguredWorkflow(name, input, {
      config,
      dryRun: hasFlag(normalizedArgs, "--dry-run"),
      services: options.services,
      runOptions: options.runOptions,
    });
    if (asJson || options.forceJsonOutput === true) {
      stdout(JSON.stringify(result, null, 2));
    } else {
      stdout(`workflow=${result.workflow.id} status=${result.status} outputs=${result.outputs.length} errors=${result.errors.length}`);
      for (const output of result.outputs) {
        const summary = String(output.summary || output.output || "").slice(0, 160);
        stdout(`- ${output.agentId}: ${summary}`);
      }
      if (result.consensus?.text) {
        stdout(`consensus=${result.consensus.text}`);
      }
    }
    return { ok: true, command: "run", workflowName: name, result };
  }

  if (subcommand === "template-run") {
    const templateId = normalizedArgs[1];
    if (!templateId) {
      throw new Error("Template id is required. Usage: bosun workflow template-run <id>");
    }
    const template = getTemplate(templateId);
    if (!template) {
      throw new Error(`Workflow template "${templateId}" not found`);
    }
    const input = parseInput(normalizedArgs, options.cwd || process.cwd());
    const dryRun = hasFlag(normalizedArgs, "--dry-run");
    const tempRoot = mkdtempSync(join(tmpdir(), "bosun-workflow-template-run-"));
    const statusEvents = [];
    try {
      const engine = new WorkflowEngine({
        workflowDir: join(tempRoot, "workflows"),
        runsDir: join(tempRoot, "runs"),
        configDir: options.cwd || process.cwd(),
        services: options.services || {},
        detectInterruptedRuns: false,
      });
      installTemplateRunDependencies(engine, templateId);
      const dispatchedWorkflows = [];
      engine.trackDispatchedWorkflow = (promise, meta = {}) => {
        const tracked = Promise.resolve(promise)
          .then((runCtx) => ({
            status: "fulfilled",
            success: !(Array.isArray(runCtx?.errors) && runCtx.errors.length > 0),
            workflowId: meta?.workflowId || null,
            nodeId: meta?.nodeId || null,
            index: Number.isFinite(Number(meta?.index)) ? Number(meta.index) : null,
            runId: runCtx?.id || null,
            errors: Array.isArray(runCtx?.errors) ? [...runCtx.errors] : [],
          }))
          .catch((error) => ({
            status: "rejected",
            success: false,
            workflowId: meta?.workflowId || null,
            nodeId: meta?.nodeId || null,
            index: Number.isFinite(Number(meta?.index)) ? Number(meta.index) : null,
            runId: null,
            errors: [error?.message || String(error)],
          }));
        dispatchedWorkflows.push(tracked);
        return tracked;
      };
      engine.on("workflow:status", (event) => {
        statusEvents.push(cloneJson(event));
      });
      const captureConsole = asJson || options.forceJsonOutput === true;
      const { result: ctx, consoleLines } = await withCapturedConsole(captureConsole, async () => (
        engine.executeDefinition(cloneJson(template), input, {
          dryRun,
          force: true,
        })
      ));
      const dispatchResults = dryRun ? [] : await waitForTemplateRunDispatches(dispatchedWorkflows);
      const dispatchFailures = dispatchResults.filter((entry) => entry?.success === false);
      if (dispatchFailures.length > 0) {
        if (!Array.isArray(ctx.errors)) ctx.errors = [];
        for (const failure of dispatchFailures) {
          const label = failure?.workflowId || "unknown";
          const index = failure?.index === null || failure?.index === undefined ? "unknown" : failure.index;
          const detail = Array.isArray(failure?.errors) && failure.errors.length > 0
            ? failure.errors.join("; ")
            : "child workflow failed";
          ctx.errors.push(`Dispatched workflow ${label}[${index}] failed: ${detail}`);
        }
        ctx.data._workflowTerminalStatus = "failed";
      }
      const report = buildTemplateRunReport(template, ctx, statusEvents, {
        dryRun,
        engineConsole: consoleLines,
        dispatches: dispatchResults,
      });
      if (asJson || options.forceJsonOutput === true) {
        stdout(JSON.stringify(report, null, 2));
      } else {
        for (const line of formatTemplateRunReport(report)) stdout(line);
      }
      return { ok: true, command: "template-run", templateId, report };
    } finally {
      try {
        rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only; Windows can briefly retain run files.
      }
    }
  }

  throw new Error(`Unknown workflow subcommand: ${subcommand}`);
}

export async function runWorkflowCli(args, options = {}) {
  return executeWorkflowCommand(["workflow", ...(Array.isArray(args) ? args : [])], options);
}

export default runWorkflowCli;
