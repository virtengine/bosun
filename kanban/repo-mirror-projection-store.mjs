import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const REPO_MIRROR_PROTOCOL_VERSION = "1";
const REPO_MIRROR_PROJECTION_MANAGER_ID = "bosun-repo-mirror-projection";
const MAX_TASK_DESCRIPTION_LENGTH = 16000;
const MAX_MESSAGE_BODY_LENGTH = 12000;
const MAX_SANITIZE_INPUT_LENGTH = 200;
const MAX_TIMELINE_ENTRIES = 24;
const MAX_ATTACHMENT_ENTRIES = 32;
const MAX_WORKFLOW_RUN_ENTRIES = 24;

function normalizeString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function normalizeStringList(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function truncateText(value, maxLength) {
  const text = String(value ?? "");
  if (!Number.isFinite(maxLength) || maxLength <= 0) return text;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function sanitizeFileComponent(value, fallback) {
  const lower = String(value ?? "").trim().slice(0, MAX_SANITIZE_INPUT_LENGTH).toLowerCase();
  let normalized = "";
  let prevDash = true; // suppress leading dash
  for (const ch of lower) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "." || ch === "_") {
      normalized += ch;
      prevDash = false;
    } else if (ch === "-") {
      if (!prevDash) { normalized += "-"; prevDash = true; }
    } else if (!prevDash) {
      normalized += "-";
      prevDash = true;
    }
  }
  // Remove trailing dash
  if (normalized.endsWith("-")) normalized = normalized.slice(0, -1);
  normalized = normalized.slice(0, 64);
  return normalized || fallback;
}

function hashId(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 12);
}

function createDeterministicFileName(prefix, identifier) {
  return `${sanitizeFileComponent(prefix, "record")}--${hashId(identifier)}.json`;
}

function resolveRepoPath(rawPath) {
  const candidate =
    normalizeString(rawPath) ||
    normalizeString(process.env.REPO_MIRROR_REPO_PATH) ||
    normalizeString(process.env.REPO_ROOT) ||
    process.cwd();
  return path.resolve(candidate);
}

function resolveRepoMirrorDir(repoPath) {
  if (path.basename(repoPath).toLowerCase() === ".repo-mirror") {
    return repoPath;
  }
  return path.join(repoPath, ".repo-mirror");
}

export function resolveRepoMirrorProjectionConfig(config = {}) {
  const repoPath = resolveRepoPath(config?.repoPath);
  const repoMirrorDir = resolveRepoMirrorDir(repoPath);
  return Object.freeze({
    enabled: config?.enabled === true,
    repoPath,
    repoMirrorDir,
    syncMode: normalizeString(config?.syncMode)?.toLowerCase() || "projection",
    runStorage: normalizeString(config?.runStorage)?.toLowerCase() || "git",
    messageStorage: normalizeString(config?.messageStorage)?.toLowerCase() || "off",
    publicRoadmapEnabled: config?.publicRoadmapEnabled === true,
  });
}

function taskFilePath(config, taskId) {
  return path.join(
    config.repoMirrorDir,
    "tasks",
    createDeterministicFileName(`task-${taskId}`, taskId),
  );
}

function runFilePath(config, taskId, runId) {
  return path.join(
    config.repoMirrorDir,
    "runs",
    createDeterministicFileName(`run-${taskId}-${runId}`, `${taskId}:${runId}`),
  );
}

function messageFilePath(config, taskId, messageId) {
  return path.join(
    config.repoMirrorDir,
    "messages",
    createDeterministicFileName(
      `message-${taskId}-${messageId}`,
      `${taskId}:${messageId}`,
    ),
  );
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeTextIfChanged(filePath, content) {
  let current = null;
  try {
    current = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (current === content) return false;
  await fs.writeFile(filePath, content, "utf8");
  return true;
}

async function writeJsonIfChanged(filePath, value) {
  return writeTextIfChanged(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function safeReadDir(dirPath) {
  try {
    return await fs.readdir(dirPath);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function safeReadJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function toSortableTimestamp(...values) {
  for (const value of values) {
    const parsed = Date.parse(String(value || "").trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function isBosunManagedProjection(doc = {}) {
  return String(doc?.managed_by || "").trim() === REPO_MIRROR_PROJECTION_MANAGER_ID;
}

function compareProjectedTaskRecords(left, right) {
  const timeDelta =
    toSortableTimestamp(
      right?.doc?.updated_at,
      right?.doc?.last_activity_at,
      right?.doc?.created_at,
    )
    - toSortableTimestamp(
      left?.doc?.updated_at,
      left?.doc?.last_activity_at,
      left?.doc?.created_at,
    );
  if (timeDelta !== 0) return timeDelta;
  const managedDelta = Number(isBosunManagedProjection(right?.doc)) - Number(isBosunManagedProjection(left?.doc));
  if (managedDelta !== 0) return managedDelta;
  return String(left?.filePath || "").localeCompare(String(right?.filePath || ""));
}

function selectCanonicalProjectedTaskRecord(records = []) {
  const list = (Array.isArray(records) ? records : []).filter(
    (entry) => entry?.doc && typeof entry.doc === "object",
  );
  if (list.length === 0) return null;
  list.sort(compareProjectedTaskRecords);
  return list[0] || null;
}

function dedupeProjectedTaskRecords(records = []) {
  const grouped = new Map();
  for (const entry of Array.isArray(records) ? records : []) {
    const taskId = String(entry?.doc?.task_id || "").trim();
    if (!taskId) continue;
    const list = grouped.get(taskId) || [];
    list.push(entry);
    grouped.set(taskId, list);
  }
  return Array.from(grouped.values())
    .map((entries) => selectCanonicalProjectedTaskRecord(entries))
    .filter(Boolean);
}

function mapBosunStatusToRepoMirrorState(status) {
  const key = String(status ?? "").trim().toLowerCase();
  if (key === "done") return "done";
  if (key === "inreview") return "review";
  if (key === "inprogress") return "in_progress";
  if (key === "blocked") return "blocked";
  if (key === "cancelled") return "cancelled";
  if (key === "draft") return "backlog";
  return "ready";
}

function mapRepoMirrorStateToBosunStatus(state) {
  const key = String(state ?? "").trim().toLowerCase();
  if (key === "done") return "done";
  if (key === "review") return "inreview";
  if (key === "in_progress") return "inprogress";
  if (key === "blocked") return "blocked";
  if (key === "cancelled") return "cancelled";
  if (key === "backlog") return "draft";
  return "todo";
}

function normalizeAttachment(entry = {}) {
  return {
    id: normalizeString(entry.id) || hashId(JSON.stringify(entry)),
    name: normalizeString(entry.name) || "attachment",
    kind: normalizeString(entry.kind) || "file",
    url: normalizeString(entry.url),
    content_type: normalizeString(entry.contentType || entry.content_type),
    size_bytes: Number.isFinite(Number(entry.sizeBytes || entry.size_bytes))
      ? Number(entry.sizeBytes || entry.size_bytes)
      : null,
  };
}

function normalizeTimelineEntry(entry = {}) {
  return {
    type: normalizeString(entry.type) || "event",
    source: normalizeString(entry.source),
    status: normalizeString(entry.status),
    from_status: normalizeString(entry.fromStatus || entry.from_status),
    to_status: normalizeString(entry.toStatus || entry.to_status),
    actor: normalizeString(entry.actor),
    message: normalizeString(entry.message),
    timestamp: normalizeString(entry.timestamp) || new Date().toISOString(),
  };
}

function normalizeWorkflowRunSummary(entry = {}) {
  return {
    workflow_id: normalizeString(entry.workflowId || entry.workflow_id),
    run_id: normalizeString(entry.runId || entry.run_id),
    status: normalizeString(entry.status),
    started_at: normalizeString(entry.startedAt || entry.started_at),
    ended_at: normalizeString(entry.endedAt || entry.ended_at),
  };
}

function normalizeMaterializedWorkflowRun(entry = {}) {
  return {
    workflowId: normalizeString(entry.workflowId || entry.workflow_id),
    runId: normalizeString(entry.runId || entry.run_id),
    status: normalizeString(entry.status) || mapRepoMirrorStateToBosunStatus(entry.state),
    startedAt: normalizeString(entry.startedAt || entry.started_at),
    endedAt: normalizeString(entry.endedAt || entry.ended_at),
    summary: normalizeString(entry.summary),
    source: normalizeString(entry.source),
  };
}

function mergeWorkflowRunCollections(...lists) {
  const merged = new Map();
  for (const list of lists) {
    for (const entry of Array.isArray(list) ? list : []) {
      if (!entry || typeof entry !== "object") continue;
      const normalized = normalizeMaterializedWorkflowRun(entry);
      const key =
        normalized.runId ||
        [
          normalized.workflowId,
          normalized.startedAt,
          normalized.endedAt,
          normalized.source,
          normalized.summary,
        ].join("|");
      const current = merged.get(key) || {};
      merged.set(key, {
        ...current,
        ...normalized,
      });
    }
  }
  return [...merged.values()];
}

function buildSyntheticRuns(task = {}, rawTask = {}) {
  const history = Array.isArray(task.statusHistory) ? task.statusHistory : [];
  if (history.length === 0) return [];

  /** @type {Array<object>} */
  const runs = [];
  let current = null;
  let sequence = 0;
  const startRun = (entry, nextStatus) => {
    sequence += 1;
    current = {
      run_id: `status-${sequence}`,
      task_id: String(task.id || rawTask.id || ""),
      state: mapBosunStatusToRepoMirrorState(nextStatus),
      status: nextStatus === "inreview" ? "reviewing" : "running",
      source: normalizeString(entry.source) || "task-status",
      actor: normalizeString(entry.actor) || normalizeString(task.assignee),
      started_at: normalizeString(entry.timestamp) || new Date().toISOString(),
      updated_at: normalizeString(entry.timestamp) || new Date().toISOString(),
      ended_at: null,
      workflow_id: null,
      branch_name: normalizeString(task.branchName),
      pr: {
        number: task.prNumber ?? null,
        url: normalizeString(task.prUrl),
      },
      summary: `Derived from task status transition to ${nextStatus}`,
    };
    runs.push(current);
  };

  const closeRun = (entry, nextStatus) => {
    if (!current) return;
    current.updated_at = normalizeString(entry.timestamp) || current.updated_at;
    current.ended_at = normalizeString(entry.timestamp) || current.ended_at;
    if (nextStatus === "done") current.status = "completed";
    else if (nextStatus === "cancelled") current.status = "cancelled";
    else if (nextStatus === "blocked") current.status = "blocked";
    else current.status = "stopped";
    current.state = mapBosunStatusToRepoMirrorState(nextStatus);
    current = null;
  };

  for (const entry of history) {
    const nextStatus = String(entry?.status ?? "").trim().toLowerCase();
    if (!nextStatus) continue;
    if (nextStatus === "inprogress" || nextStatus === "inreview") {
      if (!current) {
        startRun(entry, nextStatus);
        continue;
      }
      current.updated_at = normalizeString(entry.timestamp) || current.updated_at;
      current.state = mapBosunStatusToRepoMirrorState(nextStatus);
      if (nextStatus === "inreview") current.status = "reviewing";
      continue;
    }
    if (["done", "cancelled", "blocked", "todo", "draft"].includes(nextStatus)) {
      closeRun(entry, nextStatus);
    }
  }

  if (current && !current.ended_at) {
    current.updated_at = normalizeString(task.updatedAt || task.lastActivityAt) || current.updated_at;
    if (String(task.status || "").trim().toLowerCase() === "inreview") {
      current.status = "reviewing";
    }
  }
  return runs;
}

function buildRunDocuments(task = {}, rawTask = {}) {
  const rawRuns = Array.isArray(rawTask.runs) ? rawTask.runs : [];
  const workflowRuns = Array.isArray(task.workflowRuns) ? task.workflowRuns : [];
  const runs = [];

  for (const [index, run] of rawRuns.entries()) {
    const runId =
      normalizeString(run.runId || run.id || run.attemptId || run.attempt_id) ||
      `raw-${index + 1}`;
    runs.push({
      protocol: "bosun-repo-mirror-run.v1",
      schema_version: 1,
      managed_by: REPO_MIRROR_PROJECTION_MANAGER_ID,
      run_id: runId,
      task_id: String(task.id || rawTask.id || ""),
      status: normalizeString(run.status) || "running",
      state: mapBosunStatusToRepoMirrorState(run.status || task.status),
      source: normalizeString(run.source) || "task-run",
      actor: normalizeString(run.actor || run.agentId || run.agent_id || task.assignee),
      workflow_id: normalizeString(run.workflowId || run.workflow_id),
      started_at: normalizeString(run.startedAt || run.started_at || task.createdAt),
      updated_at:
        normalizeString(run.updatedAt || run.updated_at || run.endedAt || run.ended_at) ||
        normalizeString(task.updatedAt || task.lastActivityAt),
      ended_at: normalizeString(run.endedAt || run.ended_at),
      branch_name: normalizeString(run.branchName || run.branch_name || task.branchName),
      pr: {
        number: run.prNumber ?? task.prNumber ?? null,
        url: normalizeString(run.prUrl || run.pr_url || task.prUrl),
      },
      summary:
        normalizeString(run.summary || run.message || run.reason) ||
        `Bosun task run ${runId}`,
    });
  }

  for (const [index, run] of workflowRuns.entries()) {
    const runId =
      normalizeString(run.runId || run.id || run.workflowRunId || run.workflow_run_id) ||
      `workflow-${index + 1}`;
    runs.push({
      protocol: "bosun-repo-mirror-run.v1",
      schema_version: 1,
      managed_by: REPO_MIRROR_PROJECTION_MANAGER_ID,
      run_id: runId,
      task_id: String(task.id || rawTask.id || ""),
      status: normalizeString(run.status) || "running",
      state: mapBosunStatusToRepoMirrorState(run.status || task.status),
      source: "workflow",
      actor: normalizeString(run.actor || task.assignee),
      workflow_id: normalizeString(run.workflowId || run.workflow_id),
      started_at: normalizeString(run.startedAt || run.started_at),
      updated_at:
        normalizeString(run.endedAt || run.ended_at || run.startedAt || run.started_at) ||
        normalizeString(task.updatedAt || task.lastActivityAt),
      ended_at: normalizeString(run.endedAt || run.ended_at),
      branch_name: normalizeString(task.branchName),
      pr: {
        number: task.prNumber ?? null,
        url: normalizeString(task.prUrl),
      },
      summary:
        normalizeString(run.summary) ||
        `Workflow ${normalizeString(run.workflowId || run.workflow_id) || runId}`,
    });
  }

  if (runs.length === 0) {
    runs.push(...buildSyntheticRuns(task, rawTask).map((run) => ({
      protocol: "bosun-repo-mirror-run.v1",
      schema_version: 1,
      managed_by: REPO_MIRROR_PROJECTION_MANAGER_ID,
      ...run,
    })));
  }

  const deduped = new Map();
  for (const run of runs) {
    const runId = normalizeString(run.run_id) || randomUUID();
    deduped.set(runId, {
      ...run,
      run_id: runId,
    });
  }
  return [...deduped.values()];
}

function buildMessageDocuments(task = {}, rawTask = {}, config = {}) {
  const rawComments = []
    .concat(Array.isArray(task.comments) ? task.comments : [])
    .concat(Array.isArray(rawTask.comments) ? rawTask.comments : [])
    .concat(Array.isArray(rawTask.meta?.comments) ? rawTask.meta.comments : []);
  const docs = [];
  const seen = new Set();
  for (const [index, comment] of rawComments.entries()) {
    const body = truncateText(comment?.body, MAX_MESSAGE_BODY_LENGTH);
    if (!normalizeString(body)) continue;
    const createdAt =
      normalizeString(comment?.createdAt || comment?.created_at) ||
      normalizeString(task.updatedAt || task.lastActivityAt) ||
      new Date().toISOString();
    const author =
      normalizeString(comment?.author || comment?.actor || comment?.source) ||
      normalizeString(task.assignee) ||
      "bosun";
    const messageId =
      normalizeString(comment?.id || comment?.messageId || comment?.message_id) ||
      `comment-${index + 1}-${hashId(`${body}:${createdAt}:${author}`)}`;
    if (seen.has(messageId)) continue;
    seen.add(messageId);
    docs.push({
      protocol: "bosun-repo-mirror-message.v1",
      schema_version: 1,
      managed_by: REPO_MIRROR_PROJECTION_MANAGER_ID,
      message_id: messageId,
      task_id: String(task.id || rawTask.id || ""),
      kind: "comment",
      author,
      source: normalizeString(comment?.source) || "bosun-comment",
      created_at: createdAt,
      visibility: config.publicRoadmapEnabled ? "shared" : "private",
      body,
    });
  }
  return docs;
}

export function buildProjectedTaskDocument(task = {}, rawTask = {}, config = {}) {
  const runDocs = buildRunDocuments(task, rawTask);
  const messageDocs =
    config.messageStorage !== "off"
      ? buildMessageDocuments(task, rawTask, config)
      : [];
  const attachments = []
    .concat(Array.isArray(task.attachments) ? task.attachments : [])
    .concat(Array.isArray(rawTask.attachments) ? rawTask.attachments : [])
    .slice(0, MAX_ATTACHMENT_ENTRIES)
    .map((entry) => normalizeAttachment(entry));
  const workflowRuns = (Array.isArray(task.workflowRuns) ? task.workflowRuns : [])
    .slice(0, MAX_WORKFLOW_RUN_ENTRIES)
    .map((entry) => normalizeWorkflowRunSummary(entry));
  const timeline = (Array.isArray(task.timeline) ? task.timeline : [])
    .filter(Boolean)
    .slice(-MAX_TIMELINE_ENTRIES)
    .map((entry) => normalizeTimelineEntry(entry));
  const doc = {
    protocol: "bosun-repo-mirror-task.v1",
    schema_version: 1,
    task_id: String(task.id || rawTask.id || ""),
    title: normalizeString(task.title) || "Untitled task",
    description: truncateText(task.description || "", MAX_TASK_DESCRIPTION_LENGTH),
    state: mapBosunStatusToRepoMirrorState(task.status),
    status: normalizeString(task.status) || "todo",
    priority: normalizeString(task.priority),
    assignee: normalizeString(task.assignee),
    assignees: normalizeStringList(task.assignees),
    project_id: normalizeString(task.projectId) || "repo-mirror",
    workspace: normalizeString(task.workspace),
    repository: normalizeString(task.repository),
    repositories: normalizeStringList(task.repositories),
    tags: normalizeStringList(task.tags),
    draft: task.draft === true,
    blocked_reason: normalizeString(rawTask.blockedReason || task.meta?.blockedReason),
    dependencies: normalizeStringList(rawTask.dependencyTaskIds || rawTask.dependsOn),
    blocked_by: normalizeStringList(rawTask.blockedByTaskIds),
    child_task_ids: normalizeStringList(rawTask.childTaskIds),
    base_branch: normalizeString(task.baseBranch),
    branch_name: normalizeString(task.branchName),
    pr: {
      number: task.prNumber ?? null,
      url: normalizeString(task.prUrl),
    },
    created_at: normalizeString(task.createdAt),
    updated_at: normalizeString(task.updatedAt),
    last_activity_at: normalizeString(task.lastActivityAt || task.updatedAt),
    attachment_count: attachments.length,
    comment_count: messageDocs.length,
    run_count: runDocs.length,
    evidence: {
      attachments,
      workflow_runs: workflowRuns,
    },
    timeline,
    source: {
      system: "bosun",
      backend: "internal",
      managed_by: REPO_MIRROR_PROJECTION_MANAGER_ID,
      sync_mode: normalizeString(config.syncMode) || "projection",
      run_storage: normalizeString(config.runStorage) || "git",
      message_storage: normalizeString(config.messageStorage) || "off",
    },
  };
  return {
    task: doc,
    runs: config.runStorage === "off" ? [] : runDocs,
    messages: messageDocs,
  };
}

export async function ensureProjectionScaffold(config) {
  await ensureDir(config.repoMirrorDir);
  await ensureDir(path.join(config.repoMirrorDir, "tasks"));
  await ensureDir(path.join(config.repoMirrorDir, "runs"));
  await ensureDir(path.join(config.repoMirrorDir, "messages"));
  await writeTextIfChanged(
    path.join(config.repoMirrorDir, "version"),
    `${REPO_MIRROR_PROTOCOL_VERSION}\n`,
  );
  const agentsPath = path.join(config.repoMirrorDir, "agents.json");
  const currentAgents = await safeReadJson(agentsPath);
  if (!currentAgents) {
    await writeJsonIfChanged(agentsPath, {
      protocol: "bosun-repo-mirror-agents.v1",
      schema_version: 1,
      generated_at: new Date().toISOString(),
      agents: [],
    });
  }
}

export async function upsertProjectedTask(config, taskDoc, runDocs = [], messageDocs = []) {
  await ensureProjectionScaffold(config);
  const taskId = String(taskDoc?.task_id || "").trim();
  if (!taskId) {
    throw new Error("RepoMirror projection requires task_id");
  }
  const existingTaskDocs = await loadSurfaceDocuments(
    path.join(config.repoMirrorDir, "tasks"),
    (doc) => String(doc?.task_id || "").trim() === taskId,
  );
  const canonicalTaskRecord = selectCanonicalProjectedTaskRecord(existingTaskDocs);
  const canonicalTaskPath = canonicalTaskRecord?.filePath || taskFilePath(config, taskId);
  await writeJsonIfChanged(canonicalTaskPath, taskDoc);
  for (const entry of existingTaskDocs) {
    if (!entry?.filePath || entry.filePath === canonicalTaskPath) continue;
    await fs.unlink(entry.filePath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }

  const runsDir = path.join(config.repoMirrorDir, "runs");
  const existingRunFiles = await safeReadDir(runsDir);
  const expectedRunIds = new Set(runDocs.map((run) => String(run?.run_id || "").trim()).filter(Boolean));
  for (const fileName of existingRunFiles) {
    const doc = await safeReadJson(path.join(runsDir, fileName));
    if (doc?.task_id !== taskId) continue;
    const managedByBosun =
      String(doc?.managed_by || "").trim() === REPO_MIRROR_PROJECTION_MANAGER_ID;
    if (managedByBosun && !expectedRunIds.has(String(doc?.run_id || "").trim())) {
      await fs.unlink(path.join(runsDir, fileName)).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }
  for (const run of runDocs) {
    const runId = String(run?.run_id || "").trim();
    if (!runId) continue;
    await writeJsonIfChanged(runFilePath(config, taskId, runId), run);
  }

  const messagesDir = path.join(config.repoMirrorDir, "messages");
  const existingMessageFiles = await safeReadDir(messagesDir);
  const expectedMessageIds = new Set(
    messageDocs.map((message) => String(message?.message_id || "").trim()).filter(Boolean),
  );
  for (const fileName of existingMessageFiles) {
    const doc = await safeReadJson(path.join(messagesDir, fileName));
    if (doc?.task_id !== taskId) continue;
    const managedByBosun =
      String(doc?.managed_by || "").trim() === REPO_MIRROR_PROJECTION_MANAGER_ID;
    if (managedByBosun && !expectedMessageIds.has(String(doc?.message_id || "").trim())) {
      await fs.unlink(path.join(messagesDir, fileName)).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }
  for (const message of messageDocs) {
    const messageId = String(message?.message_id || "").trim();
    if (!messageId) continue;
    await writeJsonIfChanged(messageFilePath(config, taskId, messageId), message);
  }
}

export async function deleteProjectedTask(config, taskId) {
  await ensureProjectionScaffold(config);
  const normalizedTaskId = String(taskId || "").trim();
  if (!normalizedTaskId) return;
  const taskDocs = await loadSurfaceDocuments(
    path.join(config.repoMirrorDir, "tasks"),
    (doc) => String(doc?.task_id || "").trim() === normalizedTaskId,
  );
  for (const entry of taskDocs) {
    await fs.unlink(entry.filePath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  await fs.unlink(taskFilePath(config, normalizedTaskId)).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  for (const surface of ["runs", "messages"]) {
    const dirPath = path.join(config.repoMirrorDir, surface);
    const files = await safeReadDir(dirPath);
    for (const fileName of files) {
      const filePath = path.join(dirPath, fileName);
      const doc = await safeReadJson(filePath);
      if (doc?.task_id !== normalizedTaskId) continue;
      await fs.unlink(filePath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }
}

async function loadSurfaceDocuments(dirPath, matcher = () => true) {
  const fileNames = await safeReadDir(dirPath);
  const docs = [];
  for (const fileName of fileNames) {
    const filePath = path.join(dirPath, fileName);
    const doc = await safeReadJson(filePath);
    if (!doc || !matcher(doc)) continue;
    docs.push({ doc, filePath });
  }
  return docs;
}

export async function listProjectedTaskRecords(config) {
  await ensureProjectionScaffold(config);
  const docs = await loadSurfaceDocuments(path.join(config.repoMirrorDir, "tasks"));
  return dedupeProjectedTaskRecords(docs);
}

export async function readProjectedTaskRecord(config, taskId) {
  const normalizedTaskId = String(taskId || "").trim();
  if (!normalizedTaskId) return null;
  const docs = await loadSurfaceDocuments(
    path.join(config.repoMirrorDir, "tasks"),
    (doc) => String(doc?.task_id || "").trim() === normalizedTaskId,
  );
  return selectCanonicalProjectedTaskRecord(docs);
}

export async function rebuildAgentsRegistry(config) {
  await ensureProjectionScaffold(config);
  const taskDocs = await listProjectedTaskRecords(config);
  const runDocs = await loadSurfaceDocuments(path.join(config.repoMirrorDir, "runs"));
  const messageDocs = await loadSurfaceDocuments(path.join(config.repoMirrorDir, "messages"));
  const agents = new Map();

  const touchAgent = (id, data = {}) => {
    const normalizedId = normalizeString(id);
    if (!normalizedId) return;
    const current = agents.get(normalizedId) || {
      id: normalizedId,
      name: normalizedId,
      role: "agent",
      reports_to: null,
      last_seen_at: null,
      sources: [],
    };
    current.name = normalizeString(data.name) || current.name;
    current.last_seen_at = normalizeString(data.last_seen_at) || current.last_seen_at;
    if (data.source) {
      current.sources = normalizeStringList([...(current.sources || []), data.source]);
    }
    agents.set(normalizedId, current);
  };

  for (const { doc } of taskDocs) {
    touchAgent(doc?.assignee, {
      last_seen_at: doc?.updated_at || doc?.last_activity_at,
      source: "task-assignee",
    });
    for (const assignee of doc?.assignees || []) {
      touchAgent(assignee, {
        last_seen_at: doc?.updated_at || doc?.last_activity_at,
        source: "task-assignee",
      });
    }
  }

  for (const { doc } of runDocs) {
    touchAgent(doc?.actor, {
      last_seen_at: doc?.updated_at || doc?.ended_at || doc?.started_at,
      source: "run-actor",
    });
  }

  for (const { doc } of messageDocs) {
    touchAgent(doc?.author, {
      last_seen_at: doc?.created_at,
      source: "message-author",
    });
  }

  await writeJsonIfChanged(path.join(config.repoMirrorDir, "agents.json"), {
    protocol: "bosun-repo-mirror-agents.v1",
    schema_version: 1,
    generated_at: new Date().toISOString(),
    agents: [...agents.values()].sort((left, right) => left.id.localeCompare(right.id)),
  });
}

export async function listProjectedMessagesForTask(config, taskId) {
  const normalizedTaskId = String(taskId || "").trim();
  if (!normalizedTaskId) return [];
  return loadSurfaceDocuments(
    path.join(config.repoMirrorDir, "messages"),
    (doc) => String(doc?.task_id || "").trim() === normalizedTaskId,
  );
}

export async function listProjectedRunsForTask(config, taskId) {
  const normalizedTaskId = String(taskId || "").trim();
  if (!normalizedTaskId) return [];
  return loadSurfaceDocuments(
    path.join(config.repoMirrorDir, "runs"),
    (doc) => String(doc?.task_id || "").trim() === normalizedTaskId,
  );
}

export function materializeProjectedTask(doc = {}, filePath, runDocs = [], messageDocs = []) {
  const status = normalizeString(doc.status) || mapRepoMirrorStateToBosunStatus(doc.state);
  const workflowRuns = mergeWorkflowRunCollections(
    Array.isArray(doc?.evidence?.workflow_runs) ? doc.evidence.workflow_runs : [],
    runDocs.map(({ doc: run }) => ({
      workflow_id: run?.workflow_id,
      run_id: run?.run_id,
      status: run?.status,
      state: run?.state,
      started_at: run?.started_at,
      ended_at: run?.ended_at,
      summary: run?.summary,
      source: run?.source,
    })),
  );
  return {
    id: String(doc.task_id || ""),
    title: normalizeString(doc.title) || "Untitled task",
    description: String(doc.description || ""),
    status,
    assignee: normalizeString(doc.assignee),
    assignees: normalizeStringList(doc.assignees),
    priority: normalizeString(doc.priority),
    projectId: normalizeString(doc.project_id) || "repo-mirror",
    baseBranch: normalizeString(doc.base_branch),
    branchName: normalizeString(doc.branch_name),
    prNumber:
      doc?.pr?.number == null || doc?.pr?.number === ""
        ? null
        : Number.parseInt(String(doc.pr.number), 10),
    prUrl: normalizeString(doc?.pr?.url),
    backend: "repo-mirror",
    createdAt: normalizeString(doc.created_at),
    updatedAt: normalizeString(doc.updated_at),
    lastActivityAt: normalizeString(doc.last_activity_at || doc.updated_at),
    draft: doc.draft === true,
    tags: normalizeStringList(doc.tags),
    workspace: normalizeString(doc.workspace),
    repository: normalizeString(doc.repository),
    repositories: normalizeStringList(doc.repositories),
    attachments: Array.isArray(doc?.evidence?.attachments)
      ? doc.evidence.attachments.map((entry) => ({
        id: normalizeString(entry?.id),
        name: normalizeString(entry?.name),
        kind: normalizeString(entry?.kind),
        url: normalizeString(entry?.url),
        contentType: normalizeString(entry?.content_type || entry?.contentType),
        sizeBytes:
          entry?.size_bytes == null || entry?.size_bytes === ""
            ? null
            : Number(entry.size_bytes),
      }))
      : [],
    workflowRuns,
    comments: messageDocs.map(({ doc: message }) => ({
      id: normalizeString(message?.message_id),
      body: String(message?.body || ""),
      author: normalizeString(message?.author),
      source: normalizeString(message?.source),
      createdAt: normalizeString(message?.created_at),
    })),
    meta: {
      projectionOnly: true,
      repoMirror: {
        taskPath: filePath,
        state: normalizeString(doc.state),
        runCount: runDocs.length,
        messageCount: messageDocs.length,
        syncMode: normalizeString(doc?.source?.sync_mode) || "projection",
        runStorage: normalizeString(doc?.source?.run_storage) || "git",
        messageStorage: normalizeString(doc?.source?.message_storage) || "off",
      },
      evidence: doc?.evidence || {},
      timeline: Array.isArray(doc.timeline) ? doc.timeline : [],
    },
  };
}
