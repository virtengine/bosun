import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { loadConfig } from "../config/config.mjs";
import {
  createTask,
  getTask as getKanbanTask,
  listTasks,
  updateTask,
  updateTaskStatus,
} from "../kanban/kanban-adapter.mjs";
import {
  execWithRetry,
  launchEphemeralThread,
  launchOrResumeThread,
} from "../agent/agent-pool.mjs";
import {
  getIsolatedRunnerPoolStatus,
  runInIsolatedRunner,
} from "../infra/container-runner.mjs";
import { createMeetingWorkflowService } from "../workflow/meeting-workflow-service.mjs";
import {
  getWorkflowEngine,
} from "../workflow/workflow-engine.mjs";
import { ensureWorkflowNodeTypesLoaded } from "../workflow/workflow-nodes.mjs";
import {
  installTemplate,
  reconcileInstalledTemplates,
  resolveWorkflowTemplateConfig,
  resolveWorkflowTemplateIds,
} from "../workflow/workflow-templates.mjs";
import {
  canStartTask,
  configureTaskStore,
  loadStore,
  waitForStoreWrites,
} from "./task-store.mjs";
import { resolveKanbanStorePath } from "./task-cli.mjs";

const TASK_SIMULATION_TEMPLATE_ID = "template-task-lifecycle";
const TASK_SIMULATION_TEMPLATE_FORCE_UPDATE_IDS = [
  "template-task-batch-processor",
  "template-task-lifecycle",
  "template-task-finalization-guard",
  "template-agent-session-monitor",
  "template-bosun-pr-watchdog",
  "template-bosun-pr-progressor",
  "template-github-kanban-sync",
  "template-recover-blocked-task",
  "template-recover-blocked-worktrees",
];

function readCurrentGitBranch(repoRoot) {
  try {
    const result = spawnSync("git", ["branch", "--show-current"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env },
    });
    return String(result?.stdout || "").trim();
  } catch {
    return "";
  }
}

export function resolveTaskSimulationDefaultTargetBranch(
  config = {},
  repoRoot = process.cwd(),
  options = {},
) {
  const explicitOverride = String(
    options.defaultTargetBranch || process.env.BOSUN_SIMULATE_TARGET_BRANCH || "",
  ).trim();
  if (explicitOverride) return explicitOverride;

  const configuredBranch = String(
    config?.branchRouting?.defaultBranch || config?.defaultTargetBranch || "",
  ).trim();
  const normalizedConfigured = configuredBranch.toLowerCase();
  const currentBranch = readCurrentGitBranch(repoRoot);
  const normalizedCurrent = currentBranch.toLowerCase();
  const shouldPreferCurrentBranch =
    Boolean(currentBranch)
    && normalizedCurrent !== "head"
    && normalizedCurrent !== "main"
    && normalizedCurrent !== "master"
    && !normalizedCurrent.startsWith("task/")
    && (
      !configuredBranch
      || normalizedConfigured === "origin/main"
      || normalizedConfigured === "main"
    );

  if (shouldPreferCurrentBranch) {
    return currentBranch;
  }
  return configuredBranch || "origin/main";
}

function shouldOverrideSimulationTaskBaseBranch(task, defaultTargetBranch) {
  const normalizedDefault = String(defaultTargetBranch || "").trim().toLowerCase();
  if (
    !normalizedDefault
    || normalizedDefault === "origin/main"
    || normalizedDefault === "main"
  ) {
    return false;
  }
  const taskBaseBranch = String(task?.baseBranch || task?.base_branch || "").trim().toLowerCase();
  return !taskBaseBranch || taskBaseBranch === "origin/main" || taskBaseBranch === "main";
}

function buildSimulationTaskInput(task, defaultTargetBranch) {
  const clonedTask = cloneJson(task);
  if (!clonedTask) return clonedTask;
  if (!shouldOverrideSimulationTaskBaseBranch(clonedTask, defaultTargetBranch)) {
    return clonedTask;
  }
  return {
    ...clonedTask,
    baseBranch: defaultTargetBranch,
    base_branch: defaultTargetBranch,
  };
}

function hasFlag(args, ...flags) {
  return flags.some((flag) => args.includes(flag));
}

function cloneJson(value) {
  return value == null ? value ?? null : JSON.parse(JSON.stringify(value));
}

class TaskSimulationProcessExitError extends Error {
  constructor(code = 0) {
    super(`process.exit(${Number(code) || 0}) called during task simulation`);
    this.name = "TaskSimulationProcessExitError";
    this.exitCode = Number(code) || 0;
  }
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
  } catch (error) {
    if (error && typeof error === "object") {
      error.consoleLines = consoleLines;
    }
    throw error;
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  }
}

async function withInterceptedProcessExit(fn) {
  const originalExit = process.exit;
  process.exit = ((code = 0) => {
    throw new TaskSimulationProcessExitError(code);
  });
  try {
    return await fn();
  } finally {
    process.exit = originalExit;
  }
}

function showHelp(stdout = console.log) {
  stdout(`
  bosun simulate — Live workflow-backed task simulation

  SUBCOMMANDS
    task [id]                Run the real task lifecycle workflow for a task
    task restart             Re-run the last simulated task from scratch
    task resume              Resume the last simulated run from its failure point

  OPTIONS
    --json                   Emit structured JSON output
    --mode <mode>            Retry mode for 'resume': from_failed (default),
                             from_scratch, or replan_from_failed

  EXAMPLES
    bosun simulate task
    bosun simulate task 97d41516-caca-4c78-10c1-ec0000000000
    bosun simulate task restart --json
    bosun simulate task resume
    bosun simulate task resume --mode replan_from_failed
`);
}

function resolveSimulationStatePath(repoRoot, options = {}) {
  if (options.statePath) return resolve(options.statePath);
  return resolve(repoRoot, ".bosun", ".cache", "task-simulator-last-run.json");
}

function readSimulationState(statePath) {
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function writeSimulationState(statePath, payload) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(payload, null, 2), "utf8");
}

function buildAgentPoolService(overrides = {}) {
  const service = {
    launchEphemeralThread,
    launchOrResumeThread,
    execWithRetry,
    async continueSession(sessionId, prompt, opts = {}) {
      const timeout = Number(opts.timeout) || 60 * 60 * 1000;
      const cwd = opts.cwd || process.cwd();
      return launchOrResumeThread(prompt, cwd, timeout, {
        taskKey: sessionId,
        sdk: opts.sdk,
        model: opts.model,
      });
    },
  };
  return {
    ...service,
    ...(overrides && typeof overrides === "object" ? overrides : {}),
  };
}

function buildKanbanService(overrides = {}) {
  const service = {
    createTask,
    updateTaskStatus,
    updateTask,
    listTasks,
    getTask: getKanbanTask,
  };
  return {
    ...service,
    ...(overrides && typeof overrides === "object" ? overrides : {}),
  };
}

function installConfiguredTemplates(engine, config) {
  const workflowDefaults =
    config?.workflowDefaults && typeof config.workflowDefaults === "object"
      ? config.workflowDefaults
      : {};
  const typedWorkflowTemplateConfig =
    typeof resolveWorkflowTemplateConfig === "function"
      ? resolveWorkflowTemplateConfig(config?.workflows || [])
      : { templateIds: [], overridesById: {} };
  const typedWorkflowTemplateIds = new Set(
    Array.isArray(typedWorkflowTemplateConfig?.templateIds)
      ? typedWorkflowTemplateConfig.templateIds
      : [],
  );
  const requestedTemplateOverridesById = {
    ...(workflowDefaults.templateOverridesById || {}),
    ...(typedWorkflowTemplateConfig.overridesById || {}),
  };
  const requestedTemplateIds = new Set(
    typeof resolveWorkflowTemplateIds === "function"
      ? resolveWorkflowTemplateIds({
          profileId: workflowDefaults.profile || "balanced",
          templateIds: workflowDefaults.templates || [],
          workflows: config?.workflows || [],
        })
      : [],
  );
  requestedTemplateIds.add(TASK_SIMULATION_TEMPLATE_ID);
  const workflowDefaultAutoInstallEnabled = workflowDefaults.autoInstall !== false;
  for (const templateId of requestedTemplateIds) {
    const overrides = requestedTemplateOverridesById?.[templateId] || {};
    let installed = (engine.list?.() || []).find(
      (wf) => String(wf?.metadata?.installedFrom || "").trim() === templateId,
    );
    if (
      !installed &&
      (typedWorkflowTemplateIds.has(templateId) || workflowDefaultAutoInstallEnabled)
    ) {
      try {
        installed = installTemplate(templateId, engine, overrides);
      } catch (error) {
        const alreadyInstalled =
          String(error?.message || "").includes("already installed");
        if (!alreadyInstalled) throw error;
        installed = (engine.list?.() || []).find(
          (wf) => String(wf?.metadata?.installedFrom || "").trim() === templateId,
        );
      }
    }
    if (!installed) continue;
    const def = engine.get?.(installed.id);
    if (!def) continue;
    if (!def.metadata?.pausedByWorkflow) {
      def.enabled = true;
    }
    def.variables = {
      ...(def.variables || {}),
      ...overrides,
    };
    def.metadata = {
      ...(def.metadata || {}),
      configuredFrom: typedWorkflowTemplateIds.has(templateId)
        ? "workflows.config"
        : "workflowDefaults",
    };
    engine.save(def);
  }

  if (typeof reconcileInstalledTemplates === "function") {
    const reconcile = reconcileInstalledTemplates(engine, {
      autoUpdateUnmodified: true,
      forceUpdateTemplateIds: TASK_SIMULATION_TEMPLATE_FORCE_UPDATE_IDS,
    });
    if (
      typeof engine.load === "function" &&
      (Number(reconcile?.autoUpdated || 0) > 0 ||
        Number(reconcile?.metadataUpdated || 0) > 0 ||
        (Array.isArray(reconcile?.updatedWorkflowIds) &&
          reconcile.updatedWorkflowIds.length > 0))
    ) {
      engine.load();
    }
  }
}

function resolveInstalledTaskLifecycleWorkflowId(engine) {
  const installed = (engine.list?.() || []).find(
    (workflow) =>
      String(workflow?.metadata?.installedFrom || "").trim()
      === TASK_SIMULATION_TEMPLATE_ID &&
      workflow?.enabled !== false,
  );
  if (installed?.id) return installed.id;
  const fallback = (engine.list?.() || []).find(
    (workflow) =>
      String(workflow?.metadata?.installedFrom || "").trim()
      === TASK_SIMULATION_TEMPLATE_ID,
  );
  if (fallback?.id) return fallback.id;
  return "";
}

export async function createTaskSimulationRuntime(options = {}) {
  const config = options.config || loadConfig(process.argv);
  const repoRoot = resolve(
    options.repoRoot || config?.repoRoot || process.env.REPO_ROOT || process.cwd(),
  );
  const defaultTargetBranch = resolveTaskSimulationDefaultTargetBranch(
    config,
    repoRoot,
    options,
  );
  const effectiveConfig = {
    ...(config && typeof config === "object" ? config : {}),
    defaultTargetBranch,
    branchRouting: {
      ...(config?.branchRouting && typeof config.branchRouting === "object"
        ? config.branchRouting
        : {}),
      defaultBranch: defaultTargetBranch,
    },
  };
  const storePath = resolve(options.storePath || resolveKanbanStorePath());
  configureTaskStore({ storePath });
  loadStore();

  await ensureWorkflowNodeTypesLoaded({ repoRoot });

  const promptServices =
    effectiveConfig?.agentPrompts && typeof effectiveConfig.agentPrompts === "object"
      ? { ...effectiveConfig.agentPrompts }
      : {};
  let meetingService = options.services?.meeting || null;
  if (!meetingService) {
    try {
      meetingService = createMeetingWorkflowService();
    } catch {
      meetingService = null;
    }
  }
  const workflowDir = options.workflowDir
    ? resolve(options.workflowDir)
    : resolve(repoRoot, ".bosun", "workflows");
  const runsDir = options.runsDir
    ? resolve(options.runsDir)
    : resolve(repoRoot, ".bosun", "workflow-runs");
  const services = {
    kanban: buildKanbanService(options.services?.kanban),
    agentPool: buildAgentPoolService(options.services?.agentPool),
    taskStore: {
      canStartTask,
      ...(options.services?.taskStore || {}),
    },
    prompts: Object.keys(promptServices).length > 0 ? promptServices : null,
    isolatedRunner: {
      run: runInIsolatedRunner,
      getStatus: getIsolatedRunnerPoolStatus,
      ...(options.services?.isolatedRunner || {}),
    },
    meeting: meetingService,
    ...(options.services || {}),
  };

  const engine = options.engine || getWorkflowEngine({
    services,
    workflowDir,
    runsDir,
    configDir: repoRoot,
    detectInterruptedRuns: false,
  });
  if (!options.skipInstall) {
    installConfiguredTemplates(engine, effectiveConfig);
  }
  const workflowId =
    options.workflowId || resolveInstalledTaskLifecycleWorkflowId(engine);
  if (!workflowId) {
    throw new Error(
      `Installed workflow for ${TASK_SIMULATION_TEMPLATE_ID} not found`,
    );
  }
  if (defaultTargetBranch) {
    const workflowDefinition =
      typeof engine.get === "function" ? engine.get(workflowId) : null;
    if (
      workflowDefinition &&
      typeof workflowDefinition === "object" &&
      String(workflowDefinition?.metadata?.installedFrom || "").trim() === TASK_SIMULATION_TEMPLATE_ID
    ) {
      workflowDefinition.variables = {
        ...(workflowDefinition.variables || {}),
        defaultTargetBranch,
      };
      if (typeof engine.save === "function") {
        engine.save(workflowDefinition);
      }
    }
  }
  return {
    config: effectiveConfig,
    engine,
    repoRoot,
    storePath,
    workflowId,
    defaultTargetBranch,
    statePath: resolveSimulationStatePath(repoRoot, options),
    async close() {
      await waitForStoreWrites();
    },
  };
}

function buildSimulationReport({
  workflowId,
  workflowDefinition = null,
  ctx,
  task = null,
  explicitTaskId = "",
  restarted = false,
  resumed = false,
  resumeMode = null,
  originalRunId = null,
  statePath = "",
  statusEvents = [],
  engineConsole = [],
  executionError = null,
}) {
  const triggerNodeId = "trigger";
  const triggerOutput = ctx?.getNodeOutput?.(triggerNodeId) || null;
  const taskId = String(
    ctx?.data?.taskId || triggerOutput?.taskId || explicitTaskId || "",
  ).trim();
  const resolvedTask =
    ctx?.data?.task
    || triggerOutput?.task
    || task
    || null;
  const nodes = Array.isArray(ctx?.definition?.nodes)
    ? ctx.definition.nodes
    : Array.isArray(workflowDefinition?.nodes)
      ? workflowDefinition.nodes
    : [];
  const inferredStatus =
    executionError
      ? "failed"
      :
    triggerOutput?.triggered === false && triggerOutput?.reason === "no_tasks"
      ? "no_task"
      : triggerOutput?.triggered === false
        ? "skipped"
        : Array.isArray(ctx?.errors) && ctx.errors.length > 0
          ? "failed"
          : String(ctx?.data?._workflowTerminalStatus || "completed")
            .trim()
            .toLowerCase() || "completed";
  return {
    templateId: TASK_SIMULATION_TEMPLATE_ID,
    workflowId: workflowId || null,
    runId: ctx?.id || null,
    status: inferredStatus,
    explicitTaskId: explicitTaskId || null,
    restarted,
    resumed,
    resumeMode: resumeMode || null,
    originalRunId: originalRunId || null,
    taskId: taskId || null,
    taskTitle: String(
      resolvedTask?.title || ctx?.data?.taskTitle || triggerOutput?.taskTitle || "",
    ).trim() || null,
    trigger: cloneJson(triggerOutput),
    restartStatePath: statePath || null,
    errors: [
      ...(Array.isArray(ctx?.errors) ? [...ctx.errors] : []),
      ...(executionError ? [normalizeExecutionError(executionError)] : []),
    ],
    logs: Array.isArray(ctx?.logs) ? [...ctx.logs] : [],
    statusEvents: Array.isArray(statusEvents)
      ? statusEvents.map((entry) => cloneJson(entry))
      : [],
    engineConsole: Array.isArray(engineConsole)
      ? engineConsole.map((entry) => cloneJson(entry))
      : [],
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

function normalizeExecutionError(error) {
  if (!error) return null;
  return {
    name: String(error?.name || "Error"),
    message: String(error?.message || error),
    exitCode:
      Number.isFinite(Number(error?.exitCode)) ? Number(error.exitCode) : null,
    stack: typeof error?.stack === "string" ? error.stack : null,
  };
}

function formatSimulationReport(report = {}) {
  const lines = [
    `template=${report.templateId || TASK_SIMULATION_TEMPLATE_ID} status=${report.status || "unknown"} runId=${report.runId || "n/a"} workflow=${report.workflowId || "n/a"}`,
  ];
  if (report.taskId) {
    lines.push(`task=${report.taskId}${report.taskTitle ? ` ${report.taskTitle}` : ""}`);
  }
  if (report.resumed) {
    lines.push(`mode=resume retryMode=${report.resumeMode || "from_failed"}${report.originalRunId ? ` originalRunId=${report.originalRunId}` : ""}`);
  } else if (report.restarted) {
    lines.push("mode=restart");
  } else if (report.explicitTaskId) {
    lines.push("mode=explicit-task");
  } else {
    lines.push("mode=next-runnable-task");
  }
  for (const node of report.nodes || []) {
    lines.push(`- ${node.id}\t${node.status}\t${node.type}`);
  }
  return lines;
}

export async function executeTaskSimulationCommand(args, options = {}) {
  const normalizedArgs =
    Array.isArray(args) && args[0] === "simulate" ? args.slice(1) : args;
  const subcommand = normalizedArgs?.[0] || "";
  const stdout = options.stdout || ((line) => console.log(line));
  if (
    !subcommand ||
    subcommand === "help" ||
    hasFlag(normalizedArgs, "--help", "-h")
  ) {
    showHelp(stdout);
    return { ok: true, command: "help" };
  }
  if (subcommand !== "task") {
    throw new Error(`Unknown simulate subcommand: ${subcommand}`);
  }

  const taskArgs = normalizedArgs.slice(1);
  const asJson = hasFlag(taskArgs, "--json") || options.json === true;
  const runtime =
    options.runtime || await createTaskSimulationRuntime(options);
  const statePath = resolveSimulationStatePath(runtime.repoRoot, {
    statePath: options.statePath || runtime.statePath,
  });
  const positional = taskArgs.filter((arg) => !arg.startsWith("--"));
  let explicitTaskId = String(positional[0] || "").trim();
  let restarted = false;
  let resumed = false;
  let resumeRunId = "";
  let resumeMode = "from_failed";

  if (explicitTaskId.toLowerCase() === "restart") {
    const savedState = readSimulationState(statePath);
    explicitTaskId = String(savedState?.taskId || "").trim();
    if (!explicitTaskId) {
      throw new Error("No prior simulated task recorded for restart");
    }
    restarted = true;
  } else if (explicitTaskId.toLowerCase() === "resume") {
    const modeIdx = taskArgs.indexOf("--mode");
    if (modeIdx >= 0) {
      resumeMode = String(taskArgs[modeIdx + 1] || "from_failed").trim() || "from_failed";
    }
    const savedState = readSimulationState(statePath);
    resumeRunId = String(savedState?.runId || "").trim();
    if (!resumeRunId) {
      throw new Error(
        "No prior simulation run recorded for resume — run `bosun simulate task` first",
      );
    }
    // Restore task identity from state for display / report
    explicitTaskId = String(savedState?.taskId || "").trim();
    resumed = true;
  }

  const kanbanTask =
    explicitTaskId && !resumed && typeof runtime.engine?.services?.kanban?.getTask === "function"
      ? await runtime.engine.services.kanban.getTask(explicitTaskId)
      : explicitTaskId && resumed && typeof runtime.engine?.services?.kanban?.getTask === "function"
        ? await runtime.engine.services.kanban.getTask(explicitTaskId).catch(() => null)
        : null;
  if (explicitTaskId && !kanbanTask && !resumed) {
    throw new Error(`Task "${explicitTaskId}" not found`);
  }

  const input = {
    repoRoot: runtime.repoRoot,
    _triggerSource: restarted ? "simulate.task.restart" : "simulate.task",
    _simulation: true,
  };
  if (explicitTaskId && !resumed) {
    input.taskId = explicitTaskId;
    input.taskTitle = kanbanTask?.title || "";
    if (kanbanTask) {
      input.task = buildSimulationTaskInput(
        kanbanTask,
        runtime.defaultTargetBranch,
      );
    }
  }

  const statusEvents = [];
  const onStatus = (event) => {
    statusEvents.push(cloneJson(event));
  };
  runtime.engine.on?.("workflow:status", onStatus);
  try {
    const captureConsole = asJson || options.forceJsonOutput === true;
    let ctx = null;
    let consoleLines = [];
    let executionError = null;
    let originalRunId = null;
    try {
      if (resumed) {
        const execution = await withCapturedConsole(
          captureConsole,
          async () => withInterceptedProcessExit(
            () => runtime.engine.retryRun(resumeRunId, { mode: resumeMode }),
          ),
        );
        const retryResult = execution.result;
        ctx = retryResult?.ctx || null;
        originalRunId = resumeRunId;
        consoleLines = execution.consoleLines;
      } else {
        const execution = await withCapturedConsole(
          captureConsole,
          async () => withInterceptedProcessExit(
            () => runtime.engine.execute(runtime.workflowId, input),
          ),
        );
        ctx = execution.result;
        consoleLines = execution.consoleLines;
      }
    } catch (error) {
      executionError = error;
      consoleLines = Array.isArray(error?.consoleLines) ? error.consoleLines : [];
    }
    const report = buildSimulationReport({
      workflowId: runtime.workflowId,
      workflowDefinition:
        typeof runtime.engine?.get === "function"
          ? runtime.engine.get(runtime.workflowId)
          : null,
      ctx,
      task: kanbanTask,
      explicitTaskId,
      restarted,
      resumed,
      resumeMode: resumed ? resumeMode : null,
      originalRunId,
      statePath,
      statusEvents,
      engineConsole: consoleLines,
      executionError,
    });
    if (report.runId) {
      writeSimulationState(statePath, {
        taskId: report.taskId || explicitTaskId || null,
        taskTitle: report.taskTitle,
        runId: report.runId,
        workflowId: runtime.workflowId,
        repoRoot: runtime.repoRoot,
        savedAt: new Date().toISOString(),
      });
    }
    if (asJson || options.forceJsonOutput === true) {
      stdout(JSON.stringify(report, null, 2));
    } else {
      for (const line of formatSimulationReport(report)) stdout(line);
    }
    return { ok: true, command: "task", report };
  } finally {
    runtime.engine.off?.("workflow:status", onStatus);
    await runtime.close?.();
  }
}

export async function runTaskSimulationCli(args, options = {}) {
  return executeTaskSimulationCommand(
    ["simulate", ...(Array.isArray(args) ? args : [])],
    options,
  );
}

export default runTaskSimulationCli;
