import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";

const TAG = "[state-ledger]";
const DEFAULT_LEDGER_FILENAME = "state-ledger.sqlite";
const DEFAULT_SCHEMA_VERSION = 9;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const STATE_LEDGER_CACHE_KEY = Symbol.for("bosun.stateLedger.cache");
const _stateLedgerCache = globalThis[STATE_LEDGER_CACHE_KEY] instanceof Map
  ? globalThis[STATE_LEDGER_CACHE_KEY]
  : new Map();
if (!(globalThis[STATE_LEDGER_CACHE_KEY] instanceof Map)) {
  globalThis[STATE_LEDGER_CACHE_KEY] = _stateLedgerCache;
}

function isLikelyTestRuntime() {
  if (process.env.VITEST) return true;
  if (process.env.VITEST_POOL_ID) return true;
  if (process.env.VITEST_WORKER_ID) return true;
  if (process.env.JEST_WORKER_ID) return true;
  if (process.env.NODE_ENV === "test") return true;
  const argv = Array.isArray(process.argv) ? process.argv.join(" ").toLowerCase() : "";
  return argv.includes("vitest") || argv.includes("jest");
}

function asText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function asInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function normalizeTimestamp(value) {
  return asText(value) || new Date().toISOString();
}

function toJsonText(value) {
  return JSON.stringify(value ?? null);
}

function parseJsonText(value) {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function cloneJson(value) {
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value));
}

function inferRepoRoot(startDir) {
  let current = resolve(String(startDir || process.cwd()));
  while (true) {
    if (existsSync(resolve(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolveBosunHomeDir() {
  const explicit = asText(process.env.BOSUN_HOME || process.env.BOSUN_DIR || "");
  if (explicit) return resolve(explicit);

  const base = asText(
    process.env.APPDATA
      || process.env.LOCALAPPDATA
      || process.env.USERPROFILE
      || process.env.HOME
      || "",
  );
  if (!base) return null;
  if (/[/\\]bosun$/i.test(base)) return resolve(base);
  return resolve(base, "bosun");
}

function isPathInside(parentPath, childPath) {
  const parent = resolve(String(parentPath || ""));
  const child = resolve(String(childPath || ""));
  if (!parent || !child) return false;
  if (process.platform === "win32") {
    const normalizedParent = parent.toLowerCase();
    const normalizedChild = child.toLowerCase();
    return normalizedChild === normalizedParent
      || normalizedChild.startsWith(`${normalizedParent}\\`)
      || normalizedChild.startsWith(`${normalizedParent}/`);
  }
  return child === parent || child.startsWith(`${parent}/`);
}

function findBosunDir(startPath) {
  if (!startPath) return null;
  let current = resolve(String(startPath));
  while (true) {
    if (basename(current).toLowerCase() === ".bosun") {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function collectTaskIdentityFromEvents(events = []) {
  const list = Array.isArray(events) ? [...events].reverse() : [];
  for (const event of list) {
    const meta = event?.meta && typeof event.meta === "object" ? event.meta : null;
    const taskId = asText(
      meta?.taskId || meta?.task?.id || meta?.taskInfo?.id || meta?.taskDetail?.id || "",
    );
    if (!taskId) continue;
    return {
      taskId,
      taskTitle: asText(
        meta?.taskTitle || meta?.task?.title || meta?.taskInfo?.title || meta?.taskDetail?.title || "",
      ),
    };
  }
  return { taskId: null, taskTitle: null };
}

function collectSessionIdentityFromEvents(events = []) {
  const list = Array.isArray(events) ? [...events].reverse() : [];
  for (const event of list) {
    const meta = event?.meta && typeof event.meta === "object" ? event.meta : null;
    const sessionId = asText(
      meta?.sessionId || meta?.threadId || meta?.chatSessionId || event?.sessionId || event?.threadId || "",
    );
    if (!sessionId) continue;
    return {
      sessionId,
      sessionType: asText(meta?.sessionType || meta?.runKind || ""),
    };
  }
  return { sessionId: null, sessionType: null };
}

function inferValueType(value) {
  if (value == null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return Number.isFinite(value) ? "number" : "string";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return typeof value;
  }
}

function sanitizeKeyPart(value, fallback = "item") {
  const text = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return text || fallback;
}

function extractArtifactPath(event = {}, meta = null) {
  return asText(
    meta?.path
      || meta?.filePath
      || meta?.artifactPath
      || meta?.registryPath
      || meta?.targetFile
      || event?.path
      || event?.artifactPath
      || "",
  );
}

export function resolveStateLedgerPath(options = {}) {
  const explicitPath = asText(options.ledgerPath || "");
  if (explicitPath) {
    return explicitPath === ":memory:" ? explicitPath : resolve(explicitPath);
  }

  const anchorPath = asText(options.anchorPath || options.runsDir || options.storePath || "");
  const repoRoot = asText(options.repoRoot || process.env.REPO_ROOT || "");
  const envLedgerPath = asText(process.env.BOSUN_STATE_LEDGER_PATH || "");
  const bosunHomeDir = resolveBosunHomeDir();
  const repoBosunDir = repoRoot && (!anchorPath || isPathInside(repoRoot, anchorPath))
    ? resolve(repoRoot, ".bosun")
    : null;
  const isWithinBosunHome = bosunHomeDir && anchorPath
    ? isPathInside(bosunHomeDir, anchorPath)
    : false;
  const bosunDir = asText(options.bosunDir || "")
    || findBosunDir(anchorPath)
    || repoBosunDir
    || (() => {
      const inferred = inferRepoRoot(anchorPath || process.cwd());
      return inferred ? resolve(inferred, ".bosun") : null;
    })()
    || (isWithinBosunHome ? resolve(bosunHomeDir) : null);

  if (bosunDir) {
    return resolve(bosunDir, ".cache", DEFAULT_LEDGER_FILENAME);
  }

  if (envLedgerPath) {
    if (!anchorPath || !isLikelyTestRuntime()) {
      return envLedgerPath === ":memory:" ? envLedgerPath : resolve(envLedgerPath);
    }
    const sandboxRoot = asText(process.env.BOSUN_TEST_SANDBOX_ROOT || "");
    if (sandboxRoot && isPathInside(sandboxRoot, anchorPath)) {
      return envLedgerPath === ":memory:" ? envLedgerPath : resolve(envLedgerPath);
    }
  }

  if (anchorPath) {
    return resolve(dirname(resolve(anchorPath)), DEFAULT_LEDGER_FILENAME);
  }

  if (bosunHomeDir) {
    return resolve(bosunHomeDir, ".cache", DEFAULT_LEDGER_FILENAME);
  }

  return resolve(process.cwd(), DEFAULT_LEDGER_FILENAME);
}

function ensureParentDir(filePath) {
  if (filePath === ":memory:") return;
  mkdirSync(dirname(filePath), { recursive: true });
}

function configureDatabase(db, { transient = false, testRuntime = false } = {}) {
  const journalMode = transient ? "MEMORY" : "WAL";
  const synchronousMode = transient || testRuntime ? "NORMAL" : "FULL";
  db.exec(`
    PRAGMA journal_mode = ${journalMode};
    PRAGMA synchronous = ${synchronousMode};
    PRAGMA foreign_keys = ON;
    PRAGMA temp_store = MEMORY;
    PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS};
  `);
}

function ensureSchema(entry) {
  entry.db.exec(`
    PRAGMA user_version = ${DEFAULT_SCHEMA_VERSION};

    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value_text TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_runs (
      run_id TEXT PRIMARY KEY,
      root_run_id TEXT,
      parent_run_id TEXT,
      retry_of TEXT,
      retry_mode TEXT,
      workflow_id TEXT,
      workflow_name TEXT,
      run_kind TEXT,
      status TEXT,
      started_at TEXT,
      ended_at TEXT,
      updated_at TEXT,
      task_id TEXT,
      task_title TEXT,
      session_id TEXT,
      session_type TEXT,
      event_count INTEGER NOT NULL DEFAULT 0,
      document_json TEXT NOT NULL,
      detail_json TEXT
    );

    CREATE TABLE IF NOT EXISTS workflow_events (
      event_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      root_run_id TEXT,
      parent_run_id TEXT,
      retry_of TEXT,
      retry_mode TEXT,
      run_kind TEXT,
      execution_id TEXT,
      execution_key TEXT,
      execution_kind TEXT,
      execution_label TEXT,
      parent_execution_id TEXT,
      caused_by_execution_id TEXT,
      child_run_id TEXT,
      node_id TEXT,
      node_type TEXT,
      node_label TEXT,
      tool_id TEXT,
      tool_name TEXT,
      server_id TEXT,
      status TEXT,
      attempt INTEGER,
      duration_ms INTEGER,
      error_text TEXT,
      summary TEXT,
      reason TEXT,
      meta_json TEXT,
      payload_json TEXT NOT NULL,
      UNIQUE(run_id, seq)
    );

    CREATE TABLE IF NOT EXISTS harness_runs (
      run_id TEXT PRIMARY KEY,
      task_id TEXT,
      task_key TEXT,
      actor TEXT,
      recorded_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      mode TEXT,
      dry_run INTEGER NOT NULL DEFAULT 0,
      source_origin TEXT,
      source_path TEXT,
      artifact_id TEXT,
      artifact_path TEXT,
      agent_id TEXT,
      success INTEGER,
      status TEXT,
      event_count INTEGER NOT NULL DEFAULT 0,
      document_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS harness_events (
      event_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      category TEXT,
      stage_id TEXT,
      stage_type TEXT,
      reason TEXT,
      status TEXT,
      actor TEXT,
      intervention_type TEXT,
      payload_json TEXT NOT NULL,
      UNIQUE(run_id, seq)
    );

    CREATE TABLE IF NOT EXISTS workflow_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      run_id TEXT,
      workflow_id TEXT,
      created_at TEXT NOT NULL,
      has_trajectory INTEGER NOT NULL DEFAULT 0,
      snapshot_json TEXT NOT NULL,
      trajectory_json TEXT
    );

    CREATE TABLE IF NOT EXISTS task_claim_snapshots (
      task_id TEXT PRIMARY KEY,
      instance_id TEXT,
      claim_token TEXT,
      claimed_at TEXT,
      expires_at TEXT,
      renewed_at TEXT,
      ttl_minutes INTEGER,
      metadata_json TEXT,
      claim_json TEXT,
      registry_updated_at TEXT,
      updated_at TEXT NOT NULL,
      released_at TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS task_claim_events (
      event_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      action TEXT NOT NULL,
      instance_id TEXT,
      claim_token TEXT,
      timestamp TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_snapshots (
      task_id TEXT PRIMARY KEY,
      title TEXT,
      status TEXT,
      priority TEXT,
      assignee TEXT,
      project_id TEXT,
      created_at TEXT,
      updated_at TEXT,
      last_activity_at TEXT,
      sync_dirty INTEGER NOT NULL DEFAULT 0,
      comment_count INTEGER NOT NULL DEFAULT 0,
      attachment_count INTEGER NOT NULL DEFAULT 0,
      workflow_run_count INTEGER NOT NULL DEFAULT 0,
      run_count INTEGER NOT NULL DEFAULT 0,
      document_json TEXT NOT NULL,
      deleted_at TEXT,
      is_deleted INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS task_topology (
      task_id TEXT PRIMARY KEY,
      graph_root_task_id TEXT,
      graph_parent_task_id TEXT,
      graph_depth INTEGER NOT NULL DEFAULT 0,
      graph_path_json TEXT NOT NULL,
      workflow_id TEXT,
      workflow_name TEXT,
      latest_node_id TEXT,
      latest_run_id TEXT,
      root_run_id TEXT,
      parent_run_id TEXT,
      session_id TEXT,
      latest_session_id TEXT,
      root_session_id TEXT,
      parent_session_id TEXT,
      root_task_id TEXT,
      parent_task_id TEXT,
      delegation_depth INTEGER NOT NULL DEFAULT 0,
      child_task_count INTEGER NOT NULL DEFAULT 0,
      dependency_count INTEGER NOT NULL DEFAULT 0,
      workflow_run_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      document_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_calls (
      call_id TEXT PRIMARY KEY,
      run_id TEXT,
      root_run_id TEXT,
      task_id TEXT,
      session_id TEXT,
      execution_id TEXT,
      node_id TEXT,
      tool_id TEXT,
      tool_name TEXT,
      server_id TEXT,
      provider TEXT,
      status TEXT,
      started_at TEXT,
      completed_at TEXT,
      duration_ms INTEGER,
      cwd TEXT,
      args_json TEXT,
      request_json TEXT,
      response_json TEXT,
      error_text TEXT,
      summary TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT,
      root_run_id TEXT,
      task_id TEXT,
      session_id TEXT,
      execution_id TEXT,
      node_id TEXT,
      kind TEXT,
      path TEXT,
      summary TEXT,
      source_event_id TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS key_values (
      scope TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      key_name TEXT NOT NULL,
      value_json TEXT NOT NULL,
      value_type TEXT,
      source TEXT,
      run_id TEXT,
      task_id TEXT,
      session_id TEXT,
      metadata_json TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope, scope_id, key_name)
    );

    CREATE TABLE IF NOT EXISTS operator_actions (
      action_id TEXT PRIMARY KEY,
      action_type TEXT NOT NULL,
      actor_id TEXT,
      actor_type TEXT,
      scope TEXT,
      scope_id TEXT,
      target_id TEXT,
      run_id TEXT,
      task_id TEXT,
      session_id TEXT,
      status TEXT,
      request_json TEXT,
      result_json TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_trace_events (
      event_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      task_title TEXT,
      workflow_id TEXT,
      workflow_name TEXT,
      run_id TEXT,
      status TEXT,
      node_id TEXT,
      node_type TEXT,
      node_label TEXT,
      event_type TEXT NOT NULL,
      summary TEXT,
      error_text TEXT,
      duration_ms INTEGER,
      branch TEXT,
      pr_number TEXT,
      pr_url TEXT,
      workspace_id TEXT,
      session_id TEXT,
      session_type TEXT,
      agent_id TEXT,
      trace_id TEXT,
      span_id TEXT,
      parent_span_id TEXT,
      benchmark_hint_json TEXT,
      meta_json TEXT,
      payload_json TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_activity (
      session_id TEXT PRIMARY KEY,
      session_type TEXT,
      workspace_id TEXT,
      agent_id TEXT,
      latest_task_id TEXT,
      latest_task_title TEXT,
      latest_run_id TEXT,
      latest_workflow_id TEXT,
      latest_workflow_name TEXT,
      latest_event_type TEXT,
      latest_status TEXT,
      trace_id TEXT,
      last_span_id TEXT,
      parent_span_id TEXT,
      last_error_text TEXT,
      last_summary TEXT,
      started_at TEXT,
      updated_at TEXT NOT NULL,
      event_count INTEGER NOT NULL DEFAULT 0,
      document_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_activity (
      agent_id TEXT PRIMARY KEY,
      workspace_id TEXT,
      latest_task_id TEXT,
      latest_task_title TEXT,
      latest_session_id TEXT,
      latest_run_id TEXT,
      latest_workflow_id TEXT,
      latest_workflow_name TEXT,
      latest_event_type TEXT,
      latest_status TEXT,
      trace_id TEXT,
      last_span_id TEXT,
      parent_span_id TEXT,
      last_error_text TEXT,
      last_summary TEXT,
      first_seen_at TEXT,
      updated_at TEXT NOT NULL,
      event_count INTEGER NOT NULL DEFAULT 0,
      document_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS promoted_strategies (
      strategy_id TEXT PRIMARY KEY,
      workflow_id TEXT,
      run_id TEXT,
      task_id TEXT,
      session_id TEXT,
      team_id TEXT,
      workspace_id TEXT,
      scope TEXT,
      scope_level TEXT,
      category TEXT,
      decision TEXT,
      status TEXT,
      verification_status TEXT,
      confidence REAL,
      recommendation TEXT,
      rationale TEXT,
      knowledge_hash TEXT,
      knowledge_registry_path TEXT,
      tags_json TEXT,
      evidence_json TEXT,
      provenance_json TEXT,
      benchmark_json TEXT,
      metrics_json TEXT,
      evaluation_json TEXT,
      knowledge_json TEXT,
      promoted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      document_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS promoted_strategy_events (
      event_id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL,
      workflow_id TEXT,
      run_id TEXT,
      task_id TEXT,
      session_id TEXT,
      scope TEXT,
      scope_id TEXT,
      category TEXT,
      decision TEXT,
      status TEXT,
      verification_status TEXT,
      confidence REAL,
      recommendation TEXT,
      rationale TEXT,
      knowledge_hash TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS knowledge_entries (
      entry_hash TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      scope TEXT,
      scope_level TEXT NOT NULL,
      scope_id TEXT,
      agent_id TEXT,
      agent_type TEXT,
      category TEXT,
      task_ref TEXT,
      timestamp TEXT NOT NULL,
      team_id TEXT,
      workspace_id TEXT,
      session_id TEXT,
      run_id TEXT,
      workflow_id TEXT,
      strategy_id TEXT,
      confidence REAL,
      verification_status TEXT,
      verified_at TEXT,
      provenance_json TEXT,
      evidence_json TEXT,
      tags_json TEXT,
      search_text TEXT,
      document_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_runs_root_run_id
      ON workflow_runs(root_run_id, started_at, updated_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_task_id
      ON workflow_runs(task_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_events_run_id_seq
      ON workflow_events(run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_workflow_events_timestamp
      ON workflow_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_harness_runs_started_at
      ON harness_runs(started_at, finished_at);
    CREATE INDEX IF NOT EXISTS idx_harness_runs_task_id
      ON harness_runs(task_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_harness_events_run_id_seq
      ON harness_events(run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_harness_events_timestamp
      ON harness_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_workflow_snapshots_workflow_created_at
      ON workflow_snapshots(workflow_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_task_claim_snapshots_active
      ON task_claim_snapshots(is_active, updated_at);
    CREATE INDEX IF NOT EXISTS idx_task_claim_events_task_id_timestamp
      ON task_claim_events(task_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_task_snapshots_status_updated_at
      ON task_snapshots(is_deleted, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_task_topology_root_task_id
      ON task_topology(root_task_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_task_topology_parent_task_id
      ON task_topology(parent_task_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_task_topology_latest_run_id
      ON task_topology(latest_run_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_task_topology_latest_session_id
      ON task_topology(latest_session_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_run_id_updated_at
      ON tool_calls(run_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_artifacts_run_id_created_at
      ON artifacts(run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_key_values_scope_updated_at
      ON key_values(scope, updated_at);
    CREATE INDEX IF NOT EXISTS idx_operator_actions_scope_created_at
      ON operator_actions(scope, created_at);
    CREATE INDEX IF NOT EXISTS idx_task_trace_events_task_id_timestamp
      ON task_trace_events(task_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_task_trace_events_session_id_timestamp
      ON task_trace_events(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_task_trace_events_agent_id_timestamp
      ON task_trace_events(agent_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_task_trace_events_trace_id_timestamp
      ON task_trace_events(trace_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_session_activity_updated_at
      ON session_activity(updated_at);
    CREATE INDEX IF NOT EXISTS idx_agent_activity_updated_at
      ON agent_activity(updated_at);
    CREATE INDEX IF NOT EXISTS idx_promoted_strategies_workflow_updated_at
      ON promoted_strategies(workflow_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_promoted_strategies_decision_updated_at
      ON promoted_strategies(decision, updated_at);
    CREATE INDEX IF NOT EXISTS idx_promoted_strategy_events_strategy_created_at
      ON promoted_strategy_events(strategy_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_promoted_strategy_events_workflow_created_at
      ON promoted_strategy_events(workflow_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_knowledge_entries_scope_timestamp
      ON knowledge_entries(scope_level, scope_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_knowledge_entries_workspace_timestamp
      ON knowledge_entries(workspace_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_knowledge_entries_session_timestamp
      ON knowledge_entries(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_knowledge_entries_run_timestamp
      ON knowledge_entries(run_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_knowledge_entries_workflow_timestamp
      ON knowledge_entries(workflow_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_knowledge_entries_strategy_timestamp
      ON knowledge_entries(strategy_id, timestamp);
  `);
  ensureTableColumn(entry, "workflow_runs", "detail_json", "TEXT");

  const now = new Date().toISOString();
  prepare(entry, `
    INSERT INTO schema_meta (key, value_text, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_text = excluded.value_text,
      updated_at = excluded.updated_at
  `).run("schema_version", String(DEFAULT_SCHEMA_VERSION), now);
}

function ensureTableColumn(entry, tableName, columnName, columnSql) {
  const normalizedTableName = asText(tableName);
  const normalizedColumnName = asText(columnName);
  const normalizedColumnSql = asText(columnSql);
  if (!normalizedTableName || !normalizedColumnName || !normalizedColumnSql) return;
  const columns = prepare(entry, `PRAGMA table_info(${normalizedTableName})`).all();
  if (columns.some((column) => String(column?.name || "").trim() === normalizedColumnName)) {
    return;
  }
  entry.db.exec(`ALTER TABLE ${normalizedTableName} ADD COLUMN ${normalizedColumnName} ${normalizedColumnSql}`);
}

function openDatabase(options = {}) {
  const path = resolveStateLedgerPath(options);
  const transient = path === ":memory:" || options?.transient === true;
  const cacheable = !transient;
  const testRuntime = isLikelyTestRuntime();
  if (cacheable && _stateLedgerCache.has(path)) {
    return _stateLedgerCache.get(path);
  }

  ensureParentDir(path);
  const db = new DatabaseSync(path);
  const entry = {
    db,
    path,
    transient,
    cacheable,
    statements: new Map(),
  };
  configureDatabase(db, { transient, testRuntime });
  ensureSchema(entry);
  if (cacheable) {
    _stateLedgerCache.set(path, entry);
  }
  return entry;
}

function closeTransientDatabase(entry) {
  if (!entry?.transient) return;
  try {
    entry.db.close();
  } catch {
    /* best effort */
  }
}

function prepare(entry, sql) {
  if (!entry.cacheable) {
    return entry.db.prepare(sql);
  }
  if (!entry.statements.has(sql)) {
    entry.statements.set(sql, entry.db.prepare(sql));
  }
  return entry.statements.get(sql);
}

function withLedger(options, fn) {
  const entry = openDatabase(options);
  try {
    return fn(entry);
  } finally {
    closeTransientDatabase(entry);
  }
}

function runTransaction(entry, fn) {
  entry.db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    entry.db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      entry.db.exec("ROLLBACK");
    } catch {
      /* best effort */
    }
    throw err;
  }
}

function normalizeWorkflowRunDocument(runDocument = {}) {
  const events = Array.isArray(runDocument.events) ? runDocument.events : [];
  const taskIdentity = collectTaskIdentityFromEvents(events);
  const sessionIdentity = collectSessionIdentityFromEvents(events);
  const runId = asText(runDocument.runId || "");
  const taskId = taskIdentity.taskId || asText(runDocument.taskId || "");
  const taskTitle = taskIdentity.taskTitle || asText(runDocument.taskTitle || "");
  const sessionId = sessionIdentity.sessionId || asText(runDocument.sessionId || runDocument.threadId || "");
  const sessionType = sessionIdentity.sessionType
    || asText(runDocument.sessionType || runDocument.runKind || "");
  return {
    version: asInteger(runDocument.version) || 2,
    runId,
    workflowId: asText(runDocument.workflowId || ""),
    workflowName: asText(runDocument.workflowName || ""),
    rootRunId: asText(runDocument.rootRunId || runId || ""),
    parentRunId: asText(runDocument.parentRunId || ""),
    retryOf: asText(runDocument.retryOf || ""),
    retryMode: asText(runDocument.retryMode || ""),
    runKind: asText(runDocument.runKind || ""),
    startedAt: asText(runDocument.startedAt || ""),
    endedAt: asText(runDocument.endedAt || ""),
    status: asText(runDocument.status || ""),
    updatedAt: normalizeTimestamp(runDocument.updatedAt || runDocument.startedAt),
    taskId,
    taskTitle,
    sessionId,
    sessionType,
    events,
  };
}

function normalizeHarnessRunDocument(runDocument = {}) {
  const events = Array.isArray(runDocument.events) ? runDocument.events : [];
  return {
    schemaVersion: asInteger(runDocument.schemaVersion) || 1,
    kind: asText(runDocument.kind || "bosun-harness-run-record") || "bosun-harness-run-record",
    runId: asText(runDocument.runId || ""),
    taskId: asText(runDocument.taskId || ""),
    taskKey: asText(runDocument.taskKey || ""),
    actor: asText(runDocument.actor || ""),
    recordedAt: normalizeTimestamp(runDocument.recordedAt),
    startedAt: normalizeTimestamp(runDocument.startedAt),
    finishedAt: asText(runDocument.finishedAt || ""),
    mode: asText(runDocument.mode || "run") || "run",
    dryRun: runDocument.dryRun === true,
    sourceOrigin: asText(runDocument.sourceOrigin || ""),
    sourcePath: asText(runDocument.sourcePath || ""),
    artifactId: asText(runDocument.artifactId || ""),
    artifactPath: asText(runDocument.artifactPath || ""),
    compiledProfile:
      runDocument.compiledProfile && typeof runDocument.compiledProfile === "object"
        ? cloneJson(runDocument.compiledProfile)
        : null,
    result:
      runDocument.result && typeof runDocument.result === "object"
        ? cloneJson(runDocument.result)
        : null,
    events,
  };
}

function hydrateWorkflowRunRow(entry, row) {
  const parsed = parseJsonText(row?.document_json);
  if (parsed && typeof parsed === "object") {
    if (!Array.isArray(parsed.events)) {
      parsed.events = listWorkflowEventsInternal(entry, row.run_id);
    }
    return normalizeWorkflowRunDocument({
      ...parsed,
      runId: parsed.runId || row.run_id,
      rootRunId: parsed.rootRunId || row.root_run_id || row.run_id,
      updatedAt: parsed.updatedAt || row.updated_at,
    });
  }

  return normalizeWorkflowRunDocument({
    runId: row?.run_id || null,
    workflowId: row?.workflow_id || null,
    workflowName: row?.workflow_name || null,
    rootRunId: row?.root_run_id || row?.run_id || null,
    parentRunId: row?.parent_run_id || null,
    retryOf: row?.retry_of || null,
    retryMode: row?.retry_mode || null,
    runKind: row?.run_kind || null,
    startedAt: row?.started_at || null,
    endedAt: row?.ended_at || null,
    status: row?.status || null,
    updatedAt: row?.updated_at || null,
    events: listWorkflowEventsInternal(entry, row?.run_id),
  });
}

function listWorkflowEventsInternal(entry, runId) {
  if (!asText(runId)) return [];
  return prepare(
    entry,
    `SELECT payload_json
       FROM workflow_events
      WHERE run_id = ?
      ORDER BY seq ASC`,
  ).all(runId).map((row) => parseJsonText(row?.payload_json)).filter(Boolean);
}

function upsertToolCallFromEvent(entry, runDocument, event = {}) {
  const eventType = asText(event.eventType || "");
  if (!eventType || !eventType.startsWith("tool.")) return;
  const meta = event?.meta && typeof event.meta === "object" ? event.meta : null;
  const timestamp = normalizeTimestamp(event.timestamp);
  const callId = asText(
    event.executionId
      || event.toolCallId
      || `${runDocument.runId}:${event.nodeId || "node"}:${event.toolId || event.toolName || "tool"}`,
  );
  if (!callId) return;
  const startedAt = eventType === "tool.started" ? timestamp : null;
  const completedAt = eventType === "tool.completed" || eventType === "tool.failed" ? timestamp : null;
  prepare(
    entry,
    `INSERT INTO tool_calls (
       call_id, run_id, root_run_id, task_id, session_id, execution_id, node_id,
       tool_id, tool_name, server_id, provider, status, started_at, completed_at,
       duration_ms, cwd, args_json, request_json, response_json, error_text, summary, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(call_id) DO UPDATE SET
       run_id = excluded.run_id,
       root_run_id = excluded.root_run_id,
       task_id = excluded.task_id,
       session_id = excluded.session_id,
       execution_id = excluded.execution_id,
       node_id = excluded.node_id,
       tool_id = excluded.tool_id,
       tool_name = excluded.tool_name,
       server_id = excluded.server_id,
       provider = COALESCE(excluded.provider, tool_calls.provider),
       status = excluded.status,
       started_at = COALESCE(tool_calls.started_at, excluded.started_at),
       completed_at = COALESCE(excluded.completed_at, tool_calls.completed_at),
       duration_ms = COALESCE(excluded.duration_ms, tool_calls.duration_ms),
       cwd = COALESCE(excluded.cwd, tool_calls.cwd),
       args_json = COALESCE(excluded.args_json, tool_calls.args_json),
       request_json = COALESCE(excluded.request_json, tool_calls.request_json),
       response_json = COALESCE(excluded.response_json, tool_calls.response_json),
       error_text = COALESCE(excluded.error_text, tool_calls.error_text),
       summary = COALESCE(excluded.summary, tool_calls.summary),
       updated_at = excluded.updated_at`,
  ).run(
    callId,
    runDocument.runId,
    runDocument.rootRunId,
    runDocument.taskId,
    runDocument.sessionId,
    asText(event.executionId),
    asText(event.nodeId),
    asText(event.toolId),
    asText(event.toolName || event.toolId),
    asText(event.serverId),
    asText(meta?.provider || event.provider),
    asText(event.status || (eventType === "tool.started" ? "running" : null)),
    startedAt,
    completedAt,
    asInteger(event.durationMs),
    asText(meta?.cwd),
    toJsonText(meta?.args ?? null),
    toJsonText(eventType === "tool.started" ? event : (meta?.request ?? null)),
    toJsonText(eventType === "tool.started" ? null : event),
    asText(event.error),
    asText(event.summary),
    timestamp,
  );
}

function appendArtifactFromEvent(entry, runDocument, event = {}) {
  const eventType = asText(event.eventType || "");
  if (!["artifact.emitted", "proof.emitted", "planner.post_attachment"].includes(eventType)) return;
  const meta = event?.meta && typeof event.meta === "object" ? event.meta : null;
  const timestamp = normalizeTimestamp(event.timestamp);
  const kind = asText(meta?.attachmentKind || meta?.kind || eventType);
  const path = extractArtifactPath(event, meta);
  const artifactId = asText(
    event.artifactId
      || event.id
      || `${runDocument.runId}:${sanitizeKeyPart(kind, "artifact")}:${sanitizeKeyPart(path || event.summary || timestamp, "entry")}`,
  );
  if (!artifactId) return;
  prepare(
    entry,
    `INSERT INTO artifacts (
       artifact_id, run_id, root_run_id, task_id, session_id, execution_id, node_id,
       kind, path, summary, source_event_id, metadata_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(artifact_id) DO UPDATE SET
       run_id = excluded.run_id,
       root_run_id = excluded.root_run_id,
       task_id = excluded.task_id,
       session_id = excluded.session_id,
       execution_id = excluded.execution_id,
       node_id = excluded.node_id,
       kind = excluded.kind,
       path = excluded.path,
       summary = excluded.summary,
       source_event_id = excluded.source_event_id,
       metadata_json = excluded.metadata_json,
       updated_at = excluded.updated_at`,
  ).run(
    artifactId,
    runDocument.runId,
    runDocument.rootRunId,
    runDocument.taskId,
    runDocument.sessionId,
    asText(event.executionId),
    asText(event.nodeId),
    kind,
    path,
    asText(event.summary || meta?.summary || meta?.stepLabel),
    asText(event.id),
    toJsonText({
      eventType,
      meta,
      payload: event,
    }),
    timestamp,
    timestamp,
  );
}

export function writeWorkflowStateLedger(payload = {}, options = {}) {
  return withLedger(options, (entry) => {
    const runDocument = normalizeWorkflowRunDocument(payload.runDocument || {});
    if (!runDocument.runId) {
      throw new Error(`${TAG} workflow runId is required`);
    }
    const runDetail = payload.runDetail === undefined ? undefined : cloneJson(payload.runDetail);
    const runDetailJson = runDetail === undefined ? null : toJsonText(runDetail);
    const appendedEvent = payload.appendedEvent && typeof payload.appendedEvent === "object"
      ? payload.appendedEvent
      : null;
    runTransaction(entry, () => {
      prepare(
        entry,
        `INSERT INTO workflow_runs (
           run_id, root_run_id, parent_run_id, retry_of, retry_mode,
           workflow_id, workflow_name, run_kind, status, started_at, ended_at, updated_at,
           task_id, task_title, session_id, session_type, event_count, document_json, detail_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           root_run_id = excluded.root_run_id,
           parent_run_id = excluded.parent_run_id,
           retry_of = excluded.retry_of,
           retry_mode = excluded.retry_mode,
           workflow_id = excluded.workflow_id,
           workflow_name = excluded.workflow_name,
           run_kind = excluded.run_kind,
           status = excluded.status,
           started_at = excluded.started_at,
           ended_at = excluded.ended_at,
           updated_at = excluded.updated_at,
           task_id = excluded.task_id,
           task_title = excluded.task_title,
           session_id = excluded.session_id,
           session_type = excluded.session_type,
           event_count = excluded.event_count,
           document_json = excluded.document_json,
           detail_json = COALESCE(excluded.detail_json, workflow_runs.detail_json)`,
      ).run(
        runDocument.runId,
        runDocument.rootRunId,
        runDocument.parentRunId,
        runDocument.retryOf,
        runDocument.retryMode,
        runDocument.workflowId,
        runDocument.workflowName,
        runDocument.runKind,
        runDocument.status,
        runDocument.startedAt,
        runDocument.endedAt,
        runDocument.updatedAt,
        runDocument.taskId,
        runDocument.taskTitle,
        runDocument.sessionId,
        runDocument.sessionType,
        runDocument.events.length,
        toJsonText(runDocument),
        runDetailJson,
      );

      if (appendedEvent) {
        prepare(
          entry,
          `INSERT INTO workflow_events (
             event_id, run_id, seq, timestamp, event_type,
             root_run_id, parent_run_id, retry_of, retry_mode, run_kind,
             execution_id, execution_key, execution_kind, execution_label,
             parent_execution_id, caused_by_execution_id, child_run_id,
             node_id, node_type, node_label, tool_id, tool_name, server_id,
             status, attempt, duration_ms, error_text, summary, reason, meta_json, payload_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(event_id) DO UPDATE SET
             payload_json = excluded.payload_json,
             timestamp = excluded.timestamp,
             status = excluded.status,
             summary = excluded.summary,
             reason = excluded.reason,
             meta_json = excluded.meta_json`,
        ).run(
          asText(appendedEvent.id || `${runDocument.runId}:${appendedEvent.seq || runDocument.events.length}`),
          runDocument.runId,
          asInteger(appendedEvent.seq) ?? runDocument.events.length,
          normalizeTimestamp(appendedEvent.timestamp),
          asText(appendedEvent.eventType || "event"),
          asText(appendedEvent.rootRunId || runDocument.rootRunId || runDocument.runId),
          asText(appendedEvent.parentRunId || runDocument.parentRunId),
          asText(appendedEvent.retryOf || runDocument.retryOf),
          asText(appendedEvent.retryMode || runDocument.retryMode),
          asText(appendedEvent.runKind || runDocument.runKind),
          asText(appendedEvent.executionId),
          asText(appendedEvent.executionKey),
          asText(appendedEvent.executionKind),
          asText(appendedEvent.executionLabel),
          asText(appendedEvent.parentExecutionId),
          asText(appendedEvent.causedByExecutionId),
          asText(appendedEvent.childRunId),
          asText(appendedEvent.nodeId),
          asText(appendedEvent.nodeType),
          asText(appendedEvent.nodeLabel),
          asText(appendedEvent.toolId),
          asText(appendedEvent.toolName),
          asText(appendedEvent.serverId),
          asText(appendedEvent.status),
          asInteger(appendedEvent.attempt),
          asInteger(appendedEvent.durationMs),
          asText(appendedEvent.error),
          asText(appendedEvent.summary),
          asText(appendedEvent.reason),
          toJsonText(appendedEvent.meta),
          toJsonText(appendedEvent),
        );
        upsertToolCallFromEvent(entry, runDocument, appendedEvent);
        appendArtifactFromEvent(entry, runDocument, appendedEvent);
      }
    });
    return { path: entry.path };
  });
}

function normalizeTaskTraceEventRecord(record = {}) {
  const eventId = asText(
    record.eventId
      || record.event_id
      || record.id
      || `${record.taskId || record.task_id || "task"}:${record.runId || record.run_id || "run"}:${record.eventType || record.event_type || "event"}:${record.timestamp || ""}`,
  );
  const taskId = asText(record.taskId || record.task_id);
  if (!taskId) {
    throw new Error(`${TAG} task trace taskId is required`);
  }
  return {
    eventId,
    taskId,
    taskTitle: asText(record.taskTitle || record.task_title),
    workflowId: asText(record.workflowId || record.workflow_id),
    workflowName: asText(record.workflowName || record.workflow_name),
    runId: asText(record.runId || record.run_id),
    status: asText(record.status),
    nodeId: asText(record.nodeId || record.node_id),
    nodeType: asText(record.nodeType || record.node_type),
    nodeLabel: asText(record.nodeLabel || record.node_label),
    eventType: asText(record.eventType || record.event_type) || "workflow.event",
    summary: asText(record.summary),
    errorText: asText(record.error || record.errorText || record.error_text),
    durationMs: asInteger(record.durationMs || record.duration_ms),
    branch: asText(record.branch),
    prNumber: asText(record.prNumber || record.pr_number),
    prUrl: asText(record.prUrl || record.pr_url),
    workspaceId: asText(record.workspaceId || record.workspace_id),
    sessionId: asText(record.sessionId || record.session_id),
    sessionType: asText(record.sessionType || record.session_type),
    agentId: asText(record.agentId || record.agent_id),
    traceId: asText(record.traceId || record.trace_id),
    spanId: asText(record.spanId || record.span_id),
    parentSpanId: asText(record.parentSpanId || record.parent_span_id),
    benchmarkHint: Object.prototype.hasOwnProperty.call(record, "benchmarkHint")
      ? record.benchmarkHint
      : (Object.prototype.hasOwnProperty.call(record, "benchmark_hint") ? record.benchmark_hint : null),
    meta: record.meta && typeof record.meta === "object" ? record.meta : null,
    payload: record && typeof record === "object" ? record : {},
    timestamp: normalizeTimestamp(record.timestamp),
  };
}

function buildSessionActivityDocument(record = {}, current = null) {
  const currentDoc = current && typeof current === "object" ? current : {};
  return {
    sessionId: record.sessionId,
    sessionType: record.sessionType || currentDoc.sessionType || null,
    workspaceId: record.workspaceId || currentDoc.workspaceId || null,
    agentId: record.agentId || currentDoc.agentId || null,
    latestTaskId: record.taskId || currentDoc.latestTaskId || null,
    latestTaskTitle: record.taskTitle || currentDoc.latestTaskTitle || null,
    latestRunId: record.runId || currentDoc.latestRunId || null,
    latestWorkflowId: record.workflowId || currentDoc.latestWorkflowId || null,
    latestWorkflowName: record.workflowName || currentDoc.latestWorkflowName || null,
    latestEventType: record.eventType || currentDoc.latestEventType || null,
    latestStatus: record.status || currentDoc.latestStatus || null,
    traceId: record.traceId || currentDoc.traceId || null,
    lastSpanId: record.spanId || currentDoc.lastSpanId || null,
    parentSpanId: record.parentSpanId || currentDoc.parentSpanId || null,
    lastErrorText: record.errorText || currentDoc.lastErrorText || null,
    lastSummary: record.summary || currentDoc.lastSummary || null,
    startedAt: currentDoc.startedAt || record.timestamp,
    updatedAt: record.timestamp,
    eventCount: Number(currentDoc.eventCount || 0) + 1,
  };
}

function normalizeSessionActivityRecord(record = {}) {
  const sessionId = asText(record.sessionId || record.id || record.taskId || "");
  if (!sessionId) {
    throw new Error(`${TAG} session activity sessionId is required`);
  }
  const document = cloneJson(
    record.document && typeof record.document === "object"
      ? record.document
      : record,
  ) || {};
  const metadata = document?.metadata && typeof document.metadata === "object"
    ? document.metadata
    : null;
  const updatedAt = normalizeTimestamp(
    record.updatedAt
      || record.lastActiveAt
      || document.updatedAt
      || document.lastActiveAt
      || document.createdAt,
  );
  const workspaceId = asText(
    record.workspaceId || document.workspaceId || metadata?.workspaceId || "",
  );
  const workspaceDir = asText(
    record.workspaceDir || document.workspaceDir || metadata?.workspaceDir || "",
  );
  const workspaceRoot = asText(
    record.workspaceRoot || document.workspaceRoot || metadata?.workspaceRoot || "",
  );
  const normalized = {
    sessionId,
    sessionType: asText(record.sessionType || record.type || document.sessionType || document.type),
    workspaceId,
    agentId: asText(
      record.agentId
        || document.agentId
        || metadata?.agentId
        || metadata?.agent
        || "",
    ),
    latestTaskId: asText(record.taskId || document.taskId || sessionId),
    latestTaskTitle: asText(
      record.taskTitle || record.title || document.taskTitle || document.title || "",
    ),
    latestRunId: asText(
      record.runId || document.latestRunId || document.runId || document.rootRunId || "",
    ),
    latestWorkflowId: asText(
      record.workflowId || document.latestWorkflowId || document.workflowId || "",
    ),
    latestWorkflowName: asText(
      record.workflowName || document.latestWorkflowName || document.workflowName || "",
    ),
    latestEventType: asText(
      record.latestEventType || record.lastEventType || document.latestEventType || document.lastEventType || "",
    ),
    latestStatus: asText(
      record.lifecycleStatus
        || record.status
        || document.lifecycleStatus
        || document.status
        || "",
    ),
    traceId: asText(record.traceId || document.traceId || ""),
    lastSpanId: asText(record.lastSpanId || document.lastSpanId || ""),
    parentSpanId: asText(record.parentSpanId || document.parentSpanId || ""),
    lastErrorText: asText(record.lastErrorText || document.lastErrorText || ""),
    lastSummary: asText(
      record.lastSummary
        || record.preview
        || record.summary
        || document.lastSummary
        || document.preview
        || document.lastMessage
        || document.summary
        || "",
    ),
    startedAt: asText(record.startedAt || document.startedAt || document.createdAt || updatedAt),
    updatedAt,
    eventCount: Math.max(
      0,
      asInteger(record.eventCount ?? record.totalEvents ?? document.eventCount ?? document.totalEvents) || 0,
    ),
    document,
  };
  if (!normalized.document.sessionId) normalized.document.sessionId = normalized.sessionId;
  if (!normalized.document.id) normalized.document.id = normalized.sessionId;
  if (!normalized.document.taskId) normalized.document.taskId = normalized.latestTaskId;
  if (!normalized.document.workspaceId && workspaceId) normalized.document.workspaceId = workspaceId;
  if (!normalized.document.workspaceDir && workspaceDir) normalized.document.workspaceDir = workspaceDir;
  if (!normalized.document.workspaceRoot && workspaceRoot) normalized.document.workspaceRoot = workspaceRoot;
  if (!normalized.document.taskTitle && normalized.latestTaskTitle) {
    normalized.document.taskTitle = normalized.latestTaskTitle;
  }
  if (!normalized.document.updatedAt) normalized.document.updatedAt = normalized.updatedAt;
  if (!normalized.document.eventCount) normalized.document.eventCount = normalized.eventCount;
  if (!normalized.document.metadata || typeof normalized.document.metadata !== "object") {
    normalized.document.metadata = {};
  }
  if (!normalized.document.metadata.workspaceId && workspaceId) {
    normalized.document.metadata.workspaceId = workspaceId;
  }
  if (!normalized.document.metadata.workspaceDir && workspaceDir) {
    normalized.document.metadata.workspaceDir = workspaceDir;
  }
  if (!normalized.document.metadata.workspaceRoot && workspaceRoot) {
    normalized.document.metadata.workspaceRoot = workspaceRoot;
  }
  return normalized;
}

function mapSessionActivityRow(row) {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    sessionType: row.session_type || null,
    workspaceId: row.workspace_id || null,
    agentId: row.agent_id || null,
    latestTaskId: row.latest_task_id || null,
    latestTaskTitle: row.latest_task_title || null,
    latestRunId: row.latest_run_id || null,
    latestWorkflowId: row.latest_workflow_id || null,
    latestWorkflowName: row.latest_workflow_name || null,
    latestEventType: row.latest_event_type || null,
    latestStatus: row.latest_status || null,
    traceId: row.trace_id || null,
    lastSpanId: row.last_span_id || null,
    parentSpanId: row.parent_span_id || null,
    lastErrorText: row.last_error_text || null,
    lastSummary: row.last_summary || null,
    startedAt: row.started_at || null,
    updatedAt: row.updated_at,
    eventCount: Number(row.event_count || 0) || 0,
    document: parseJsonText(row.document_json),
  };
}

function buildAgentActivityDocument(record = {}, current = null) {
  const currentDoc = current && typeof current === "object" ? current : {};
  return {
    agentId: record.agentId,
    workspaceId: record.workspaceId || currentDoc.workspaceId || null,
    latestTaskId: record.taskId || currentDoc.latestTaskId || null,
    latestTaskTitle: record.taskTitle || currentDoc.latestTaskTitle || null,
    latestSessionId: record.sessionId || currentDoc.latestSessionId || null,
    latestRunId: record.runId || currentDoc.latestRunId || null,
    latestWorkflowId: record.workflowId || currentDoc.latestWorkflowId || null,
    latestWorkflowName: record.workflowName || currentDoc.latestWorkflowName || null,
    latestEventType: record.eventType || currentDoc.latestEventType || null,
    latestStatus: record.status || currentDoc.latestStatus || null,
    traceId: record.traceId || currentDoc.traceId || null,
    lastSpanId: record.spanId || currentDoc.lastSpanId || null,
    parentSpanId: record.parentSpanId || currentDoc.parentSpanId || null,
    lastErrorText: record.errorText || currentDoc.lastErrorText || null,
    lastSummary: record.summary || currentDoc.lastSummary || null,
    firstSeenAt: currentDoc.firstSeenAt || record.timestamp,
    updatedAt: record.timestamp,
    eventCount: Number(currentDoc.eventCount || 0) + 1,
  };
}

function normalizePromotedStrategyRecord(record = {}) {
  const strategyId = asText(record.strategyId || record.strategy_id || record?.strategy?.strategyId || "");
  if (!strategyId) {
    throw new Error(`${TAG} promoted strategy strategyId is required`);
  }
  const promotedAt = normalizeTimestamp(
    record.promotedAt || record.promoted_at || record.createdAt || record.created_at || record.updatedAt || record.updated_at,
  );
  const decision = asText(record.decision || record.verificationStatus || record.verification_status || record.status) || "promote_strategy";
  const status = asText(record.status) || "promoted";
  const knowledge = cloneJson(record.knowledge);
  const normalized = {
    strategyId,
    workflowId: asText(record.workflowId || record.workflow_id),
    runId: asText(record.runId || record.run_id),
    taskId: asText(record.taskId || record.task_id),
    sessionId: asText(record.sessionId || record.session_id),
    teamId: asText(record.teamId || record.team_id),
    workspaceId: asText(record.workspaceId || record.workspace_id),
    scope: asText(record.scope),
    scopeId: asText(record.scopeId || record.scope_id || record.workspaceId || record.workspace_id || record.teamId || record.team_id || record.sessionId || record.session_id || record.runId || record.run_id),
    scopeLevel: asText(record.scopeLevel || record.scope_level) || "workspace",
    category: asText(record.category) || "strategy",
    decision,
    status,
    verificationStatus: asText(record.verificationStatus || record.verification_status) || decision,
    confidence: Number.isFinite(Number(record.confidence)) ? Number(record.confidence) : null,
    recommendation: asText(record.recommendation || record.summary),
    rationale: asText(record.rationale),
    tags: Array.isArray(record.tags) ? cloneJson(record.tags) : (typeof record.tags === "string" ? record.tags.split(",").map((item) => item.trim()).filter(Boolean) : []),
    evidence: Array.isArray(record.evidence) ? cloneJson(record.evidence) : [],
    provenance: Array.isArray(record.provenance) ? cloneJson(record.provenance) : [],
    benchmark: cloneJson(record.benchmark),
    metrics: cloneJson(record.metrics),
    evaluation: cloneJson(record.evaluation),
    knowledge,
    knowledgeHash: asText(record.knowledgeHash || record.knowledge_hash || knowledge?.hash),
    knowledgeRegistryPath: asText(record.knowledgeRegistryPath || record.knowledge_registry_path || knowledge?.registryPath),
    promotedAt,
    updatedAt: normalizeTimestamp(record.updatedAt || record.updated_at || promotedAt),
  };
  normalized.document = {
    ...normalized,
    strategy: cloneJson(record.strategy && typeof record.strategy === "object" ? record.strategy : null),
  };
  normalized.eventId = asText(
    record.eventId
      || record.event_id
      || `${normalized.strategyId}:${normalized.decision}:${normalized.promotedAt}`,
  );
  return normalized;
}

function normalizeKnowledgeEntryRecord(record = {}) {
  const content = asText(record.content);
  if (!content) {
    throw new Error(`${TAG} knowledge entry content is required`);
  }
  const scopeLevel = asText(record.scopeLevel || record.scope_level) || "workspace";
  const teamId = asText(record.teamId || record.team_id);
  const workspaceId = asText(record.workspaceId || record.workspace_id);
  const sessionId = asText(record.sessionId || record.session_id);
  const runId = asText(record.runId || record.run_id);
  const scopeId = asText(
    record.scopeId
      || record.scope_id
      || (scopeLevel === "team" ? teamId : null)
      || (scopeLevel === "workspace" ? workspaceId : null)
      || (scopeLevel === "session" ? sessionId : null)
      || (scopeLevel === "run" ? runId : null),
  );
  const provenance = Array.isArray(record.provenance) ? cloneJson(record.provenance) : [];
  const evidence = Array.isArray(record.evidence) ? cloneJson(record.evidence) : [];
  const tags = Array.isArray(record.tags) ? cloneJson(record.tags) : [];
  const document = cloneJson(
    record.document && typeof record.document === "object"
      ? record.document
      : record,
  ) || {};
  const normalized = {
    entryHash: asText(record.entryHash || record.entry_hash || record.hash),
    content,
    scope: asText(record.scope),
    scopeLevel,
    scopeId,
    agentId: asText(record.agentId || record.agent_id),
    agentType: asText(record.agentType || record.agent_type) || "codex",
    category: asText(record.category) || "pattern",
    taskRef: asText(record.taskRef || record.task_ref),
    timestamp: normalizeTimestamp(record.timestamp || record.createdAt || record.updatedAt),
    teamId,
    workspaceId,
    sessionId,
    runId,
    workflowId: asText(record.workflowId || record.workflow_id),
    strategyId: asText(record.strategyId || record.strategy_id),
    confidence: Number.isFinite(Number(record.confidence)) ? Number(record.confidence) : null,
    verificationStatus: asText(record.verificationStatus || record.verification_status),
    verifiedAt: asText(record.verifiedAt || record.verified_at),
    provenance,
    evidence,
    tags,
    searchText: [
      content,
      asText(record.scope),
      asText(record.category),
      asText(record.taskRef || record.task_ref),
      asText(record.agentId || record.agent_id),
      teamId,
      workspaceId,
      sessionId,
      runId,
      asText(record.workflowId || record.workflow_id),
      asText(record.strategyId || record.strategy_id),
      ...provenance,
      ...evidence,
      ...tags,
    ].filter(Boolean).join(" "),
    document,
  };
  if (!normalized.entryHash) {
    throw new Error(`${TAG} knowledge entry hash is required`);
  }
  if (!normalized.document.hash) normalized.document.hash = normalized.entryHash;
  if (!normalized.document.content) normalized.document.content = normalized.content;
  if (!normalized.document.scopeLevel) normalized.document.scopeLevel = normalized.scopeLevel;
  if (!normalized.document.timestamp) normalized.document.timestamp = normalized.timestamp;
  if (!normalized.document.agentId && normalized.agentId) normalized.document.agentId = normalized.agentId;
  if (!normalized.document.agentType) normalized.document.agentType = normalized.agentType;
  if (!normalized.document.category) normalized.document.category = normalized.category;
  if (!normalized.document.scopeId && normalized.scopeId) normalized.document.scopeId = normalized.scopeId;
  return normalized;
}

export function appendTaskTraceEventToStateLedger(record = {}, options = {}) {
  return withLedger(options, (entry) => {
    const normalized = normalizeTaskTraceEventRecord(record);
    runTransaction(entry, () => {
      prepare(
        entry,
        `INSERT INTO task_trace_events (
           event_id, task_id, task_title, workflow_id, workflow_name, run_id, status,
           node_id, node_type, node_label, event_type, summary, error_text, duration_ms,
           branch, pr_number, pr_url, workspace_id, session_id, session_type, agent_id,
           trace_id, span_id, parent_span_id, benchmark_hint_json, meta_json, payload_json, timestamp
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO UPDATE SET
           task_title = excluded.task_title,
           workflow_id = excluded.workflow_id,
           workflow_name = excluded.workflow_name,
           run_id = excluded.run_id,
           status = excluded.status,
           node_id = excluded.node_id,
           node_type = excluded.node_type,
           node_label = excluded.node_label,
           summary = excluded.summary,
           error_text = excluded.error_text,
           duration_ms = excluded.duration_ms,
           branch = excluded.branch,
           pr_number = excluded.pr_number,
           pr_url = excluded.pr_url,
           workspace_id = excluded.workspace_id,
           session_id = excluded.session_id,
           session_type = excluded.session_type,
           agent_id = excluded.agent_id,
           trace_id = excluded.trace_id,
           span_id = excluded.span_id,
           parent_span_id = excluded.parent_span_id,
           benchmark_hint_json = excluded.benchmark_hint_json,
           meta_json = excluded.meta_json,
           payload_json = excluded.payload_json,
           timestamp = excluded.timestamp`,
      ).run(
        normalized.eventId,
        normalized.taskId,
        normalized.taskTitle,
        normalized.workflowId,
        normalized.workflowName,
        normalized.runId,
        normalized.status,
        normalized.nodeId,
        normalized.nodeType,
        normalized.nodeLabel,
        normalized.eventType,
        normalized.summary,
        normalized.errorText,
        normalized.durationMs,
        normalized.branch,
        normalized.prNumber,
        normalized.prUrl,
        normalized.workspaceId,
        normalized.sessionId,
        normalized.sessionType,
        normalized.agentId,
        normalized.traceId,
        normalized.spanId,
        normalized.parentSpanId,
        toJsonText(normalized.benchmarkHint),
        toJsonText(normalized.meta),
        toJsonText(normalized.payload),
        normalized.timestamp,
      );

      if (normalized.sessionId) {
        const currentSessionRow = prepare(
          entry,
          `SELECT document_json
             FROM session_activity
            WHERE session_id = ?`,
        ).get(normalized.sessionId);
        const sessionDocument = buildSessionActivityDocument(
          normalized,
          parseJsonText(currentSessionRow?.document_json),
        );
        prepare(
          entry,
          `INSERT INTO session_activity (
             session_id, session_type, workspace_id, agent_id, latest_task_id, latest_task_title,
             latest_run_id, latest_workflow_id, latest_workflow_name, latest_event_type, latest_status,
             trace_id, last_span_id, parent_span_id, last_error_text, last_summary,
             started_at, updated_at, event_count, document_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             session_type = excluded.session_type,
             workspace_id = excluded.workspace_id,
             agent_id = excluded.agent_id,
             latest_task_id = excluded.latest_task_id,
             latest_task_title = excluded.latest_task_title,
             latest_run_id = excluded.latest_run_id,
             latest_workflow_id = excluded.latest_workflow_id,
             latest_workflow_name = excluded.latest_workflow_name,
             latest_event_type = excluded.latest_event_type,
             latest_status = excluded.latest_status,
             trace_id = excluded.trace_id,
             last_span_id = excluded.last_span_id,
             parent_span_id = excluded.parent_span_id,
             last_error_text = excluded.last_error_text,
             last_summary = excluded.last_summary,
             started_at = excluded.started_at,
             updated_at = excluded.updated_at,
             event_count = excluded.event_count,
             document_json = excluded.document_json`,
        ).run(
          normalized.sessionId,
          sessionDocument.sessionType,
          sessionDocument.workspaceId,
          sessionDocument.agentId,
          sessionDocument.latestTaskId,
          sessionDocument.latestTaskTitle,
          sessionDocument.latestRunId,
          sessionDocument.latestWorkflowId,
          sessionDocument.latestWorkflowName,
          sessionDocument.latestEventType,
          sessionDocument.latestStatus,
          sessionDocument.traceId,
          sessionDocument.lastSpanId,
          sessionDocument.parentSpanId,
          sessionDocument.lastErrorText,
          sessionDocument.lastSummary,
          sessionDocument.startedAt,
          sessionDocument.updatedAt,
          sessionDocument.eventCount,
          toJsonText(sessionDocument),
        );
      }

      if (normalized.agentId) {
        const currentAgentRow = prepare(
          entry,
          `SELECT document_json
             FROM agent_activity
            WHERE agent_id = ?`,
        ).get(normalized.agentId);
        const agentDocument = buildAgentActivityDocument(
          normalized,
          parseJsonText(currentAgentRow?.document_json),
        );
        prepare(
          entry,
          `INSERT INTO agent_activity (
             agent_id, workspace_id, latest_task_id, latest_task_title, latest_session_id,
             latest_run_id, latest_workflow_id, latest_workflow_name, latest_event_type, latest_status,
             trace_id, last_span_id, parent_span_id, last_error_text, last_summary,
             first_seen_at, updated_at, event_count, document_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET
             workspace_id = excluded.workspace_id,
             latest_task_id = excluded.latest_task_id,
             latest_task_title = excluded.latest_task_title,
             latest_session_id = excluded.latest_session_id,
             latest_run_id = excluded.latest_run_id,
             latest_workflow_id = excluded.latest_workflow_id,
             latest_workflow_name = excluded.latest_workflow_name,
             latest_event_type = excluded.latest_event_type,
             latest_status = excluded.latest_status,
             trace_id = excluded.trace_id,
             last_span_id = excluded.last_span_id,
             parent_span_id = excluded.parent_span_id,
             last_error_text = excluded.last_error_text,
             last_summary = excluded.last_summary,
             first_seen_at = excluded.first_seen_at,
             updated_at = excluded.updated_at,
             event_count = excluded.event_count,
             document_json = excluded.document_json`,
        ).run(
          normalized.agentId,
          agentDocument.workspaceId,
          agentDocument.latestTaskId,
          agentDocument.latestTaskTitle,
          agentDocument.latestSessionId,
          agentDocument.latestRunId,
          agentDocument.latestWorkflowId,
          agentDocument.latestWorkflowName,
          agentDocument.latestEventType,
          agentDocument.latestStatus,
          agentDocument.traceId,
          agentDocument.lastSpanId,
          agentDocument.parentSpanId,
          agentDocument.lastErrorText,
          agentDocument.lastSummary,
          agentDocument.firstSeenAt,
          agentDocument.updatedAt,
          agentDocument.eventCount,
          toJsonText(agentDocument),
        );
      }
    });
    return { path: entry.path, eventId: normalized.eventId };
  });
}

export function upsertSessionRecordToStateLedger(record = {}, options = {}) {
  return withLedger(options, (entry) => {
    const normalized = normalizeSessionActivityRecord(record);
    prepare(
      entry,
      `INSERT INTO session_activity (
         session_id, session_type, workspace_id, agent_id, latest_task_id, latest_task_title,
         latest_run_id, latest_workflow_id, latest_workflow_name, latest_event_type, latest_status,
         trace_id, last_span_id, parent_span_id, last_error_text, last_summary,
         started_at, updated_at, event_count, document_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         session_type = excluded.session_type,
         workspace_id = excluded.workspace_id,
         agent_id = excluded.agent_id,
         latest_task_id = excluded.latest_task_id,
         latest_task_title = excluded.latest_task_title,
         latest_run_id = excluded.latest_run_id,
         latest_workflow_id = excluded.latest_workflow_id,
         latest_workflow_name = excluded.latest_workflow_name,
         latest_event_type = excluded.latest_event_type,
         latest_status = excluded.latest_status,
         trace_id = excluded.trace_id,
         last_span_id = excluded.last_span_id,
         parent_span_id = excluded.parent_span_id,
         last_error_text = excluded.last_error_text,
         last_summary = excluded.last_summary,
         started_at = excluded.started_at,
         updated_at = excluded.updated_at,
         event_count = excluded.event_count,
         document_json = excluded.document_json`,
    ).run(
      normalized.sessionId,
      normalized.sessionType,
      normalized.workspaceId,
      normalized.agentId,
      normalized.latestTaskId,
      normalized.latestTaskTitle,
      normalized.latestRunId,
      normalized.latestWorkflowId,
      normalized.latestWorkflowName,
      normalized.latestEventType,
      normalized.latestStatus,
      normalized.traceId,
      normalized.lastSpanId,
      normalized.parentSpanId,
      normalized.lastErrorText,
      normalized.lastSummary,
      normalized.startedAt,
      normalized.updatedAt,
      normalized.eventCount,
      toJsonText(normalized.document),
    );
    return mapSessionActivityRow({
      session_id: normalized.sessionId,
      session_type: normalized.sessionType,
      workspace_id: normalized.workspaceId,
      agent_id: normalized.agentId,
      latest_task_id: normalized.latestTaskId,
      latest_task_title: normalized.latestTaskTitle,
      latest_run_id: normalized.latestRunId,
      latest_workflow_id: normalized.latestWorkflowId,
      latest_workflow_name: normalized.latestWorkflowName,
      latest_event_type: normalized.latestEventType,
      latest_status: normalized.latestStatus,
      trace_id: normalized.traceId,
      last_span_id: normalized.lastSpanId,
      parent_span_id: normalized.parentSpanId,
      last_error_text: normalized.lastErrorText,
      last_summary: normalized.lastSummary,
      started_at: normalized.startedAt,
      updated_at: normalized.updatedAt,
      event_count: normalized.eventCount,
      document_json: toJsonText(normalized.document),
    });
  });
}

export function deleteSessionRecordFromStateLedger(sessionId, options = {}) {
  return withLedger(options, (entry) => {
    const normalizedSessionId = asText(sessionId);
    if (!normalizedSessionId) {
      return { sessionId: null, deleted: false };
    }
    const result = prepare(
      entry,
      `DELETE FROM session_activity
        WHERE session_id = ?`,
    ).run(normalizedSessionId);
    return {
      sessionId: normalizedSessionId,
      deleted: Number(result?.changes || 0) > 0,
    };
  });
}

export function getWorkflowRunFromStateLedger(runId, options = {}) {
  return withLedger(options, (entry) => {
    const normalizedRunId = asText(runId);
    if (!normalizedRunId) return null;
    const row = prepare(
      entry,
      `SELECT *
         FROM workflow_runs
        WHERE run_id = ?`,
    ).get(normalizedRunId);
    return row ? hydrateWorkflowRunRow(entry, row) : null;
  });
}

export function writeWorkflowRunDetailToStateLedger(runId, detail, options = {}) {
  return withLedger(options, (entry) => {
    const normalizedRunId = asText(runId);
    if (!normalizedRunId) {
      throw new Error(`${TAG} workflow runId is required`);
    }
    const timestamp = normalizeTimestamp(detail?.updatedAt || detail?.endedAt || detail?.startedAt);
    const existingRow = prepare(
      entry,
      `SELECT document_json
         FROM workflow_runs
        WHERE run_id = ?`,
    ).get(normalizedRunId);
    const existingDocument = parseJsonText(existingRow?.document_json);
    const baseRunDocument = normalizeWorkflowRunDocument(
      existingDocument && typeof existingDocument === "object"
        ? existingDocument
        : {
            runId: normalizedRunId,
            rootRunId: normalizedRunId,
            updatedAt: timestamp,
            events: [],
          },
    );
    const terminalRaw = String(asText(detail?.data?._workflowTerminalStatus || "") || "").toLowerCase();
    const derivedStatus = terminalRaw === "failed" || terminalRaw === "error"
      ? "failed"
      : (terminalRaw === "cancelled"
          ? "cancelled"
          : (Array.isArray(detail?.errors) && detail.errors.length > 0 ? "failed" : ""));
    const runDocument = normalizeWorkflowRunDocument({
      ...baseRunDocument,
      workflowId: baseRunDocument.workflowId || asText(detail?.data?._workflowId || ""),
      workflowName: baseRunDocument.workflowName || asText(detail?.data?._workflowName || ""),
      rootRunId: baseRunDocument.rootRunId || asText(detail?.data?._workflowRootRunId || normalizedRunId),
      parentRunId: baseRunDocument.parentRunId || asText(detail?.data?._workflowParentRunId || ""),
      retryOf: baseRunDocument.retryOf || asText(detail?.data?._retryOf || ""),
      retryMode: baseRunDocument.retryMode || asText(detail?.data?._retryMode || ""),
      runKind: baseRunDocument.runKind || asText(detail?.data?._sessionType || ""),
      status: baseRunDocument.status || derivedStatus,
      startedAt: baseRunDocument.startedAt || normalizeTimestamp(detail?.startedAt),
      endedAt: baseRunDocument.endedAt || normalizeTimestamp(detail?.endedAt),
      taskId: baseRunDocument.taskId || asText(detail?.data?.taskId || detail?.inputData?.taskId || ""),
      taskTitle: baseRunDocument.taskTitle || asText(detail?.data?.taskTitle || detail?.inputData?.taskTitle || ""),
      sessionId: baseRunDocument.sessionId || asText(detail?.data?.sessionId || detail?.data?._sessionId || ""),
      sessionType: baseRunDocument.sessionType || asText(detail?.data?._sessionType || ""),
      updatedAt: timestamp,
    });
    prepare(
      entry,
      `INSERT INTO workflow_runs (
         run_id, root_run_id, parent_run_id, retry_of, retry_mode,
         workflow_id, workflow_name, run_kind, status, started_at, ended_at, updated_at,
         task_id, task_title, session_id, session_type, event_count, document_json, detail_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         root_run_id = excluded.root_run_id,
         parent_run_id = COALESCE(excluded.parent_run_id, workflow_runs.parent_run_id),
         retry_of = COALESCE(excluded.retry_of, workflow_runs.retry_of),
         retry_mode = COALESCE(excluded.retry_mode, workflow_runs.retry_mode),
         workflow_id = COALESCE(excluded.workflow_id, workflow_runs.workflow_id),
         workflow_name = COALESCE(excluded.workflow_name, workflow_runs.workflow_name),
         run_kind = COALESCE(excluded.run_kind, workflow_runs.run_kind),
         status = COALESCE(excluded.status, workflow_runs.status),
         started_at = COALESCE(excluded.started_at, workflow_runs.started_at),
         ended_at = COALESCE(excluded.ended_at, workflow_runs.ended_at),
         updated_at = excluded.updated_at,
         task_id = COALESCE(excluded.task_id, workflow_runs.task_id),
         task_title = COALESCE(excluded.task_title, workflow_runs.task_title),
         session_id = COALESCE(excluded.session_id, workflow_runs.session_id),
         session_type = COALESCE(excluded.session_type, workflow_runs.session_type),
         event_count = COALESCE(excluded.event_count, workflow_runs.event_count),
         document_json = COALESCE(workflow_runs.document_json, excluded.document_json),
         detail_json = excluded.detail_json`,
    ).run(
      runDocument.runId,
      runDocument.rootRunId,
      runDocument.parentRunId,
      runDocument.retryOf,
      runDocument.retryMode,
      runDocument.workflowId,
      runDocument.workflowName,
      runDocument.runKind,
      runDocument.status,
      runDocument.startedAt,
      runDocument.endedAt,
      timestamp,
      runDocument.taskId,
      runDocument.taskTitle,
      runDocument.sessionId,
      runDocument.sessionType,
      runDocument.events.length,
      toJsonText(runDocument),
      toJsonText(detail),
    );
    return { path: entry.path, runId: normalizedRunId };
  });
}

export function getWorkflowRunDetailFromStateLedger(runId, options = {}) {
  return withLedger(options, (entry) => {
    const normalizedRunId = asText(runId);
    if (!normalizedRunId) return null;
    const row = prepare(
      entry,
      `SELECT detail_json
         FROM workflow_runs
        WHERE run_id = ?`,
    ).get(normalizedRunId);
    const parsed = parseJsonText(row?.detail_json);
    return parsed && typeof parsed === "object" ? parsed : null;
  });
}

export function listWorkflowRunsFromStateLedger(options = {}) {
  return withLedger(options, (entry) =>
    prepare(
      entry,
      `SELECT *
         FROM workflow_runs
        ORDER BY COALESCE(started_at, updated_at) ASC, run_id ASC`,
    ).all().map((row) => hydrateWorkflowRunRow(entry, row)),
  );
}

export function listWorkflowRunSummariesPageFromStateLedger(options = {}) {
  return withLedger(options, (entry) => {
    const workflowId = asText(options.workflowId || options.workflow_id);
    const rawOffset = Number(options.offset);
    const rawLimit = Number(options.limit);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0
      ? Math.max(0, Math.floor(rawOffset))
      : 0;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.max(1, Math.floor(rawLimit))
      : 20;
    const whereClause = workflowId ? "WHERE workflow_id = ?" : "";
    const countSql = `SELECT COUNT(*) AS total FROM workflow_runs ${whereClause}`;
    const totalRow = workflowId
      ? prepare(entry, countSql).get(workflowId)
      : prepare(entry, countSql).get();
    const total = asInteger(totalRow?.total) ?? 0;
    const querySql = `
      SELECT
        run_id,
        root_run_id,
        parent_run_id,
        retry_of,
        retry_mode,
        workflow_id,
        workflow_name,
        run_kind,
        status,
        started_at,
        ended_at,
        updated_at,
        COALESCE(task_id, json_extract(document_json, '$.taskId')) AS task_id,
        COALESCE(task_title, json_extract(document_json, '$.taskTitle')) AS task_title,
        COALESCE(session_id, json_extract(document_json, '$.sessionId')) AS session_id,
        COALESCE(session_type, json_extract(document_json, '$.sessionType')) AS session_type,
        event_count
      FROM workflow_runs
      ${whereClause}
      ORDER BY COALESCE(started_at, updated_at) DESC, run_id DESC
      LIMIT ? OFFSET ?`;
    const rows = workflowId
      ? prepare(entry, querySql).all(workflowId, limit, offset)
      : prepare(entry, querySql).all(limit, offset);
    const runs = rows.map((row) => normalizeWorkflowRunDocument({
      runId: row?.run_id || null,
      workflowId: row?.workflow_id || null,
      workflowName: row?.workflow_name || null,
      rootRunId: row?.root_run_id || row?.run_id || null,
      parentRunId: row?.parent_run_id || null,
      retryOf: row?.retry_of || null,
      retryMode: row?.retry_mode || null,
      runKind: row?.run_kind || null,
      startedAt: row?.started_at || null,
      endedAt: row?.ended_at || null,
      status: row?.status || null,
      updatedAt: row?.updated_at || null,
      taskId: row?.task_id || null,
      taskTitle: row?.task_title || null,
      sessionId: row?.session_id || null,
      sessionType: row?.session_type || null,
      eventCount: row?.event_count || 0,
      events: [],
    }));
    return {
      runs,
      total,
      offset,
      limit,
      count: runs.length,
      hasMore: offset + runs.length < total,
      nextOffset: offset + runs.length < total ? offset + runs.length : null,
    };
  });
}

export function listWorkflowRunFamilyFromStateLedger(runId, options = {}) {
  return withLedger(options, (entry) => {
    const normalizedRunId = asText(runId);
    if (!normalizedRunId) return [];
    const row = prepare(
      entry,
      `SELECT root_run_id, run_id
         FROM workflow_runs
        WHERE run_id = ?`,
    ).get(normalizedRunId);
    if (!row) return [];
    const rootRunId = asText(row.root_run_id || row.run_id || normalizedRunId);
    return prepare(
      entry,
      `SELECT *
         FROM workflow_runs
        WHERE root_run_id = ?
           OR run_id = ?
        ORDER BY COALESCE(started_at, updated_at) ASC, run_id ASC`,
    ).all(rootRunId, rootRunId).map((familyRow) => hydrateWorkflowRunRow(entry, familyRow));
  });
}

export function writeWorkflowSnapshotToStateLedger(snapshot = {}, options = {}) {
  return withLedger(options, (entry) => {
    const snapshotId = asText(snapshot.snapshotId || snapshot.id);
    if (!snapshotId) {
      throw new Error(`${TAG} workflow snapshot id is required`);
    }
    const createdAt = normalizeTimestamp(snapshot.createdAt);
    const trajectory = snapshot.replayTrajectory && typeof snapshot.replayTrajectory === "object"
      ? cloneJson(snapshot.replayTrajectory)
      : null;
    prepare(
      entry,
      `INSERT INTO workflow_snapshots (
         snapshot_id, run_id, workflow_id, created_at, has_trajectory, snapshot_json, trajectory_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(snapshot_id) DO UPDATE SET
         run_id = excluded.run_id,
         workflow_id = excluded.workflow_id,
         created_at = excluded.created_at,
         has_trajectory = excluded.has_trajectory,
         snapshot_json = excluded.snapshot_json,
         trajectory_json = excluded.trajectory_json`,
    ).run(
      snapshotId,
      asText(snapshot.runId || null),
      asText(snapshot.workflowId || null),
      createdAt,
      trajectory ? 1 : 0,
      toJsonText(snapshot),
      trajectory ? toJsonText(trajectory) : null,
    );
    return { path: entry.path, snapshotId };
  });
}

export function getWorkflowSnapshotFromStateLedger(snapshotId, options = {}) {
  return withLedger(options, (entry) => {
    const normalizedSnapshotId = asText(snapshotId);
    if (!normalizedSnapshotId) return null;
    const row = prepare(
      entry,
      `SELECT snapshot_json, trajectory_json
         FROM workflow_snapshots
        WHERE snapshot_id = ?`,
    ).get(normalizedSnapshotId);
    const snapshot = parseJsonText(row?.snapshot_json);
    if (!snapshot || typeof snapshot !== "object") return null;
    if ((!snapshot.replayTrajectory || typeof snapshot.replayTrajectory !== "object") && row?.trajectory_json) {
      const trajectory = parseJsonText(row.trajectory_json);
      if (trajectory && typeof trajectory === "object") {
        snapshot.replayTrajectory = trajectory;
      }
    }
    return snapshot;
  });
}

export function listWorkflowSnapshotsFromStateLedger(options = {}) {
  return withLedger(options, (entry) => {
    const workflowId = asText(options.workflowId || options.workflow_id);
    const limit = Number.isFinite(Number(options.limit))
      ? Math.max(1, Math.min(1000, Math.trunc(Number(options.limit))))
      : 100;
    const rows = workflowId
      ? prepare(
        entry,
        `SELECT snapshot_json, has_trajectory
           FROM workflow_snapshots
          WHERE workflow_id = ?
          ORDER BY created_at DESC, snapshot_id DESC
          LIMIT ?`,
      ).all(workflowId, limit)
      : prepare(
        entry,
        `SELECT snapshot_json, has_trajectory
           FROM workflow_snapshots
          ORDER BY created_at DESC, snapshot_id DESC
          LIMIT ?`,
      ).all(limit);
    return rows
      .map((row) => {
        const snapshot = parseJsonText(row?.snapshot_json);
        if (!snapshot || typeof snapshot !== "object") return null;
        return {
          snapshotId: asText(snapshot.snapshotId || snapshot.id),
          runId: asText(snapshot.runId),
          workflowId: asText(snapshot.workflowId),
          createdAt: snapshot.createdAt ?? null,
          hasTrajectory: Number(row?.has_trajectory || 0) !== 0,
        };
      })
      .filter(Boolean);
  });
}

export function listWorkflowTaskRunEntriesFromStateLedger(options = {}) {
  return withLedger(options, (entry) =>
    prepare(
      entry,
      `SELECT run_id, root_run_id, task_id, task_title, started_at, updated_at, status
         FROM workflow_runs
        WHERE task_id IS NOT NULL
        ORDER BY COALESCE(started_at, updated_at) ASC, run_id ASC`,
    ).all().map((row) => ({
      runId: row.run_id,
      rootRunId: row.root_run_id || row.run_id,
      taskId: row.task_id,
      taskTitle: row.task_title || null,
      startedAt: row.started_at || null,
      updatedAt: row.updated_at || null,
      status: row.status || null,
    })),
  );
}

export function listWorkflowEventsFromStateLedger(runId, options = {}) {
  return withLedger(options, (entry) => listWorkflowEventsInternal(entry, runId));
}

function listHarnessEventsInternal(entry, runId) {
  if (!asText(runId)) return [];
  return prepare(
    entry,
    `SELECT payload_json
       FROM harness_events
      WHERE run_id = ?
      ORDER BY seq ASC`,
  ).all(runId).map((row) => parseJsonText(row?.payload_json)).filter(Boolean);
}

export function writeHarnessRunToStateLedger(payload = {}, options = {}) {
  return withLedger(options, (entry) => {
    const runDocument = normalizeHarnessRunDocument(payload.runDocument || payload || {});
    if (!runDocument.runId) {
      throw new Error(`${TAG} harness runId is required`);
    }
    const success =
      runDocument.result?.success === true
        ? 1
        : (runDocument.result?.success === false ? 0 : null);
    const status = asText(runDocument.result?.status || "");
    const agentId = asText(runDocument.compiledProfile?.agentId || "");
    runTransaction(entry, () => {
      prepare(
        entry,
        `INSERT INTO harness_runs (
           run_id, task_id, task_key, actor, recorded_at, started_at, finished_at,
           mode, dry_run, source_origin, source_path, artifact_id, artifact_path,
           agent_id, success, status, event_count, document_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           task_id = excluded.task_id,
           task_key = excluded.task_key,
           actor = excluded.actor,
           recorded_at = excluded.recorded_at,
           started_at = excluded.started_at,
           finished_at = excluded.finished_at,
           mode = excluded.mode,
           dry_run = excluded.dry_run,
           source_origin = excluded.source_origin,
           source_path = excluded.source_path,
           artifact_id = excluded.artifact_id,
           artifact_path = excluded.artifact_path,
           agent_id = excluded.agent_id,
           success = excluded.success,
           status = excluded.status,
           event_count = excluded.event_count,
           document_json = excluded.document_json`,
      ).run(
        runDocument.runId,
        runDocument.taskId,
        runDocument.taskKey,
        runDocument.actor,
        runDocument.recordedAt,
        runDocument.startedAt,
        runDocument.finishedAt,
        runDocument.mode,
        runDocument.dryRun === true ? 1 : 0,
        runDocument.sourceOrigin,
        runDocument.sourcePath,
        runDocument.artifactId,
        runDocument.artifactPath,
        agentId,
        success,
        status,
        runDocument.events.length,
        toJsonText(runDocument),
      );

      for (let index = 0; index < runDocument.events.length; index += 1) {
        const event = runDocument.events[index] && typeof runDocument.events[index] === "object"
          ? runDocument.events[index]
          : {};
        const seq = asInteger(event.seq) ?? (index + 1);
        const timestamp = normalizeTimestamp(event.timestamp);
        const eventId = asText(event.id || `${runDocument.runId}:${seq}`) || `${runDocument.runId}:${seq}`;
        prepare(
          entry,
          `INSERT INTO harness_events (
             event_id, run_id, seq, timestamp, event_type, category, stage_id,
             stage_type, reason, status, actor, intervention_type, payload_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(event_id) DO UPDATE SET
             timestamp = excluded.timestamp,
             event_type = excluded.event_type,
             category = excluded.category,
             stage_id = excluded.stage_id,
             stage_type = excluded.stage_type,
             reason = excluded.reason,
             status = excluded.status,
             actor = excluded.actor,
             intervention_type = excluded.intervention_type,
             payload_json = excluded.payload_json`,
        ).run(
          eventId,
          runDocument.runId,
          seq,
          timestamp,
          asText(event.type || event.eventType || "event") || "event",
          asText(event.category || ""),
          asText(event.stageId || ""),
          asText(event.stageType || ""),
          asText(event.reason || ""),
          asText(event.status || ""),
          asText(event.actor || ""),
          asText(event.interventionType || ""),
          toJsonText(event),
        );
      }
    });
    return runDocument;
  });
}

export function getHarnessRunFromStateLedger(runId, options = {}) {
  return withLedger(options, (entry) => {
    const normalizedRunId = asText(runId);
    if (!normalizedRunId) return null;
    const row = prepare(
      entry,
      `SELECT document_json
         FROM harness_runs
        WHERE run_id = ?`,
    ).get(normalizedRunId);
    const parsed = parseJsonText(row?.document_json);
    if (!parsed || typeof parsed !== "object") return null;
    const normalized = normalizeHarnessRunDocument(parsed);
    if (!Array.isArray(normalized.events) || normalized.events.length === 0) {
      normalized.events = listHarnessEventsInternal(entry, normalizedRunId);
    }
    return normalized;
  });
}

export function listHarnessRunsFromStateLedger(options = {}) {
  return withLedger(options, (entry) => {
    const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.max(1, Math.floor(Number(options.limit)))
      : 25;
    return prepare(
      entry,
      `SELECT document_json
         FROM harness_runs
        ORDER BY COALESCE(finished_at, started_at, recorded_at) DESC, run_id DESC
        LIMIT ?`,
    ).all(limit).map((row) => normalizeHarnessRunDocument(parseJsonText(row?.document_json) || {}));
  });
}

export function listHarnessRunEventsFromStateLedger(runId, options = {}) {
  return withLedger(options, (entry) => listHarnessEventsInternal(entry, runId));
}

function normalizeClaim(claim = {}, taskId) {
  return {
    task_id: asText(claim.task_id || taskId || ""),
    instance_id: asText(claim.instance_id),
    claim_token: asText(claim.claim_token),
    claimed_at: asText(claim.claimed_at),
    expires_at: asText(claim.expires_at),
    renewed_at: asText(claim.renewed_at),
    ttl_minutes: asInteger(claim.ttl_minutes),
    metadata: claim.metadata && typeof claim.metadata === "object" ? claim.metadata : null,
    raw: claim && typeof claim === "object" ? claim : null,
  };
}

export function syncTaskClaimsRegistryToStateLedger(registry = {}, options = {}) {
  return withLedger(options, (entry) => {
    const claims = registry?.claims && typeof registry.claims === "object" ? registry.claims : {};
    const registryUpdatedAt = normalizeTimestamp(registry?.updated_at);
    const taskIds = new Set(
      Object.keys(claims).map((taskId) => asText(taskId)).filter(Boolean),
    );
    runTransaction(entry, () => {
      for (const [taskId, rawClaim] of Object.entries(claims)) {
        const claim = normalizeClaim(rawClaim, taskId);
        if (!claim.task_id) continue;
        prepare(
          entry,
          `INSERT INTO task_claim_snapshots (
             task_id, instance_id, claim_token, claimed_at, expires_at, renewed_at,
             ttl_minutes, metadata_json, claim_json, registry_updated_at, updated_at, released_at, is_active
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET
             instance_id = excluded.instance_id,
             claim_token = excluded.claim_token,
             claimed_at = excluded.claimed_at,
             expires_at = excluded.expires_at,
             renewed_at = excluded.renewed_at,
             ttl_minutes = excluded.ttl_minutes,
             metadata_json = excluded.metadata_json,
             claim_json = excluded.claim_json,
             registry_updated_at = excluded.registry_updated_at,
             updated_at = excluded.updated_at,
             released_at = excluded.released_at,
             is_active = excluded.is_active`,
        ).run(
          claim.task_id,
          claim.instance_id,
          claim.claim_token,
          claim.claimed_at,
          claim.expires_at,
          claim.renewed_at,
          claim.ttl_minutes,
          toJsonText(claim.metadata),
          toJsonText(claim.raw),
          registryUpdatedAt,
          registryUpdatedAt,
          null,
          1,
        );
      }

      const existingRows = prepare(
        entry,
        `SELECT task_id
           FROM task_claim_snapshots
          WHERE is_active = 1`,
      ).all();
      for (const row of existingRows) {
        const taskId = asText(row?.task_id);
        if (!taskId || taskIds.has(taskId)) continue;
        prepare(
          entry,
          `UPDATE task_claim_snapshots
              SET is_active = 0,
                  released_at = ?,
                  registry_updated_at = ?,
                  updated_at = ?
            WHERE task_id = ?`,
        ).run(registryUpdatedAt, registryUpdatedAt, registryUpdatedAt, taskId);
      }
    });
    return { path: entry.path };
  });
}

export function appendTaskClaimAuditToStateLedger(auditEntry = {}, options = {}) {
  return withLedger(options, (entry) => {
    const timestamp = normalizeTimestamp(auditEntry.timestamp);
    const eventId = asText(
      auditEntry.event_id
        || auditEntry.id
        || `${auditEntry.task_id || "task"}:${auditEntry.action || "event"}:${timestamp}:${auditEntry.claim_token || ""}`,
    );
    prepare(
      entry,
      `INSERT INTO task_claim_events (
         event_id, task_id, action, instance_id, claim_token, timestamp, payload_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
         payload_json = excluded.payload_json,
         timestamp = excluded.timestamp`,
    ).run(
      eventId,
      asText(auditEntry.task_id || "") || "unknown-task",
      asText(auditEntry.action || "") || "event",
      asText(auditEntry.instance_id),
      asText(auditEntry.claim_token),
      timestamp,
      toJsonText({ ...auditEntry, timestamp }),
    );
    return { path: entry.path };
  });
}

export function getActiveTaskClaimFromStateLedger(taskId, options = {}) {
  return withLedger(options, (entry) => {
    const normalizedTaskId = asText(taskId);
    if (!normalizedTaskId) return null;
    const row = prepare(
      entry,
      `SELECT claim_json
         FROM task_claim_snapshots
        WHERE task_id = ?
          AND is_active = 1`,
    ).get(normalizedTaskId);
    return parseJsonText(row?.claim_json);
  });
}

export function listTaskClaimEventsFromStateLedger(taskId, options = {}) {
  return withLedger(options, (entry) => {
    const normalizedTaskId = asText(taskId);
    const rows = normalizedTaskId
      ? prepare(
        entry,
        `SELECT payload_json
           FROM task_claim_events
          WHERE task_id = ?
          ORDER BY timestamp ASC, event_id ASC`,
      ).all(normalizedTaskId)
      : prepare(
        entry,
        `SELECT payload_json
           FROM task_claim_events
          ORDER BY timestamp ASC, event_id ASC`,
      ).all();
    return rows.map((row) => parseJsonText(row?.payload_json)).filter(Boolean);
  });
}

function normalizeTaskRecord(task = {}) {
  return {
    id: asText(task.id || ""),
    title: asText(task.title),
    status: asText(task.status),
    priority: task.priority == null ? null : String(task.priority),
    assignee: asText(task.assignee),
    projectId: asText(task.projectId),
    createdAt: asText(task.createdAt),
    updatedAt: asText(task.updatedAt),
    lastActivityAt: asText(task.lastActivityAt),
    syncDirty: task.syncDirty === true ? 1 : 0,
    commentCount: Array.isArray(task.comments) ? task.comments.length : 0,
    attachmentCount: Array.isArray(task.attachments) ? task.attachments.length : 0,
    workflowRunCount: Array.isArray(task.workflowRuns) ? task.workflowRuns.length : 0,
    runCount: Array.isArray(task.runs) ? task.runs.length : 0,
    raw: task && typeof task === "object" ? task : null,
  };
}

function normalizeTaskTopologyRecord(task = {}) {
  const taskId = asText(task.id || "");
  const topology = task?.topology && typeof task.topology === "object" ? task.topology : {};
  const graphPath = uniqueTextList(Array.isArray(topology.graphPath) ? topology.graphPath : []);
  const workflowRuns = Array.isArray(task.workflowRuns) ? task.workflowRuns : [];
  const dependencyIds = uniqueTextList(
    Array.isArray(task.dependencyTaskIds) && task.dependencyTaskIds.length > 0
      ? task.dependencyTaskIds
      : task.dependsOn,
  );
  const childTaskIds = uniqueTextList(task.childTaskIds);
  const parseCount = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : fallback;
  };
  const normalized = {
    taskId,
    graphRootTaskId: asText(topology.graphRootTaskId || topology.rootTaskId || graphPath[0] || taskId),
    graphParentTaskId: asText(topology.graphParentTaskId || task.parentTaskId),
    graphDepth: parseCount(topology.graphDepth, graphPath.length > 0 ? Math.max(0, graphPath.length - 1) : 0),
    graphPath,
    workflowId: asText(topology.workflowId),
    workflowName: asText(topology.workflowName),
    latestNodeId: asText(topology.latestNodeId),
    latestRunId: asText(topology.latestRunId || topology.runId),
    rootRunId: asText(topology.rootRunId),
    parentRunId: asText(topology.parentRunId),
    sessionId: asText(topology.sessionId || topology.latestSessionId),
    latestSessionId: asText(topology.latestSessionId || topology.sessionId),
    rootSessionId: asText(topology.rootSessionId),
    parentSessionId: asText(topology.parentSessionId),
    rootTaskId: asText(topology.rootTaskId || topology.graphRootTaskId || graphPath[0] || taskId),
    parentTaskId: asText(topology.parentTaskId || task.parentTaskId),
    delegationDepth: parseCount(topology.delegationDepth, 0),
    childTaskCount: Math.max(childTaskIds.length, parseCount(topology.childTaskCount, 0)),
    dependencyCount: Math.max(dependencyIds.length, parseCount(topology.dependencyCount, 0)),
    workflowRunCount: Math.max(workflowRuns.length, parseCount(topology.workflowRunCount, 0)),
    updatedAt: normalizeTimestamp(task.updatedAt || task.lastActivityAt),
  };
  normalized.raw = {
    ...normalized,
    graphPath: [...normalized.graphPath],
    childTaskIds,
    dependencyTaskIds: dependencyIds,
  };
  return normalized;
}

function hydrateTaskTopologyRow(row = null) {
  if (!row) return null;
  const parsed = parseJsonText(row.document_json);
  if (parsed && typeof parsed === "object") {
    return {
      ...parsed,
      taskId: asText(parsed.taskId || row.task_id),
      graphRootTaskId: asText(parsed.graphRootTaskId || row.graph_root_task_id),
      graphParentTaskId: asText(parsed.graphParentTaskId || row.graph_parent_task_id),
      graphDepth: asInteger(parsed.graphDepth ?? row.graph_depth) ?? 0,
      graphPath: uniqueTextList(Array.isArray(parsed.graphPath) ? parsed.graphPath : parseJsonText(row.graph_path_json)),
      workflowId: asText(parsed.workflowId || row.workflow_id),
      workflowName: asText(parsed.workflowName || row.workflow_name),
      latestNodeId: asText(parsed.latestNodeId || row.latest_node_id),
      latestRunId: asText(parsed.latestRunId || row.latest_run_id),
      rootRunId: asText(parsed.rootRunId || row.root_run_id),
      parentRunId: asText(parsed.parentRunId || row.parent_run_id),
      sessionId: asText(parsed.sessionId || row.session_id),
      latestSessionId: asText(parsed.latestSessionId || row.latest_session_id),
      rootSessionId: asText(parsed.rootSessionId || row.root_session_id),
      parentSessionId: asText(parsed.parentSessionId || row.parent_session_id),
      rootTaskId: asText(parsed.rootTaskId || row.root_task_id),
      parentTaskId: asText(parsed.parentTaskId || row.parent_task_id),
      delegationDepth: asInteger(parsed.delegationDepth ?? row.delegation_depth) ?? 0,
      childTaskCount: asInteger(parsed.childTaskCount ?? row.child_task_count) ?? 0,
      dependencyCount: asInteger(parsed.dependencyCount ?? row.dependency_count) ?? 0,
      workflowRunCount: asInteger(parsed.workflowRunCount ?? row.workflow_run_count) ?? 0,
      updatedAt: asText(parsed.updatedAt || row.updated_at),
    };
  }
  return {
    taskId: asText(row.task_id),
    graphRootTaskId: asText(row.graph_root_task_id),
    graphParentTaskId: asText(row.graph_parent_task_id),
    graphDepth: asInteger(row.graph_depth) ?? 0,
    graphPath: uniqueTextList(parseJsonText(row.graph_path_json)),
    workflowId: asText(row.workflow_id),
    workflowName: asText(row.workflow_name),
    latestNodeId: asText(row.latest_node_id),
    latestRunId: asText(row.latest_run_id),
    rootRunId: asText(row.root_run_id),
    parentRunId: asText(row.parent_run_id),
    sessionId: asText(row.session_id),
    latestSessionId: asText(row.latest_session_id),
    rootSessionId: asText(row.root_session_id),
    parentSessionId: asText(row.parent_session_id),
    rootTaskId: asText(row.root_task_id),
    parentTaskId: asText(row.parent_task_id),
    delegationDepth: asInteger(row.delegation_depth) ?? 0,
    childTaskCount: asInteger(row.child_task_count) ?? 0,
    dependencyCount: asInteger(row.dependency_count) ?? 0,
    workflowRunCount: asInteger(row.workflow_run_count) ?? 0,
    updatedAt: asText(row.updated_at),
  };
}

export function syncTaskStoreToStateLedger(store = {}, options = {}) {
  return withLedger(options, (entry) => {
    const tasks = store?.tasks && typeof store.tasks === "object" ? store.tasks : {};
    const updatedAt = normalizeTimestamp(store?._meta?.updatedAt);
    const currentIds = new Set(
      Object.keys(tasks).map((taskId) => asText(taskId)).filter(Boolean),
    );
    runTransaction(entry, () => {
      for (const rawTask of Object.values(tasks)) {
        const task = normalizeTaskRecord(rawTask);
        const taskTopology = normalizeTaskTopologyRecord(rawTask);
        if (!task.id) continue;
        prepare(
          entry,
          `INSERT INTO task_snapshots (
             task_id, title, status, priority, assignee, project_id, created_at, updated_at,
             last_activity_at, sync_dirty, comment_count, attachment_count, workflow_run_count,
             run_count, document_json, deleted_at, is_deleted
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET
             title = excluded.title,
             status = excluded.status,
             priority = excluded.priority,
             assignee = excluded.assignee,
             project_id = excluded.project_id,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             last_activity_at = excluded.last_activity_at,
             sync_dirty = excluded.sync_dirty,
             comment_count = excluded.comment_count,
             attachment_count = excluded.attachment_count,
             workflow_run_count = excluded.workflow_run_count,
             run_count = excluded.run_count,
             document_json = excluded.document_json,
             deleted_at = excluded.deleted_at,
             is_deleted = excluded.is_deleted`,
        ).run(
          task.id,
          task.title,
          task.status,
          task.priority,
          task.assignee,
          task.projectId,
          task.createdAt,
          task.updatedAt || updatedAt,
          task.lastActivityAt,
          task.syncDirty,
          task.commentCount,
          task.attachmentCount,
          task.workflowRunCount,
          task.runCount,
          toJsonText(task.raw),
          null,
          0,
        );
        prepare(
          entry,
          `INSERT INTO task_topology (
             task_id, graph_root_task_id, graph_parent_task_id, graph_depth, graph_path_json,
             workflow_id, workflow_name, latest_node_id, latest_run_id, root_run_id, parent_run_id,
             session_id, latest_session_id, root_session_id, parent_session_id, root_task_id, parent_task_id,
             delegation_depth, child_task_count, dependency_count, workflow_run_count, updated_at, document_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET
             graph_root_task_id = excluded.graph_root_task_id,
             graph_parent_task_id = excluded.graph_parent_task_id,
             graph_depth = excluded.graph_depth,
             graph_path_json = excluded.graph_path_json,
             workflow_id = excluded.workflow_id,
             workflow_name = excluded.workflow_name,
             latest_node_id = excluded.latest_node_id,
             latest_run_id = excluded.latest_run_id,
             root_run_id = excluded.root_run_id,
             parent_run_id = excluded.parent_run_id,
             session_id = excluded.session_id,
             latest_session_id = excluded.latest_session_id,
             root_session_id = excluded.root_session_id,
             parent_session_id = excluded.parent_session_id,
             root_task_id = excluded.root_task_id,
             parent_task_id = excluded.parent_task_id,
             delegation_depth = excluded.delegation_depth,
             child_task_count = excluded.child_task_count,
             dependency_count = excluded.dependency_count,
             workflow_run_count = excluded.workflow_run_count,
             updated_at = excluded.updated_at,
             document_json = excluded.document_json`,
        ).run(
          taskTopology.taskId,
          taskTopology.graphRootTaskId,
          taskTopology.graphParentTaskId,
          taskTopology.graphDepth,
          toJsonText(taskTopology.graphPath),
          taskTopology.workflowId,
          taskTopology.workflowName,
          taskTopology.latestNodeId,
          taskTopology.latestRunId,
          taskTopology.rootRunId,
          taskTopology.parentRunId,
          taskTopology.sessionId,
          taskTopology.latestSessionId,
          taskTopology.rootSessionId,
          taskTopology.parentSessionId,
          taskTopology.rootTaskId,
          taskTopology.parentTaskId,
          taskTopology.delegationDepth,
          taskTopology.childTaskCount,
          taskTopology.dependencyCount,
          taskTopology.workflowRunCount,
          taskTopology.updatedAt,
          toJsonText(taskTopology.raw),
        );
      }

      const existingRows = prepare(
        entry,
        `SELECT task_id
           FROM task_snapshots
          WHERE is_deleted = 0`,
      ).all();
      for (const row of existingRows) {
        const taskId = asText(row?.task_id);
        if (!taskId || currentIds.has(taskId)) continue;
        prepare(
          entry,
          `UPDATE task_snapshots
              SET is_deleted = 1,
                  deleted_at = ?
            WHERE task_id = ?`,
        ).run(updatedAt, taskId);
        prepare(
          entry,
          `DELETE FROM task_topology
            WHERE task_id = ?`,
        ).run(taskId);
      }
    });
    return { path: entry.path };
  });
}

export function getTaskSnapshotFromStateLedger(taskId, options = {}) {
  return withLedger(options, (entry) => {
    const normalizedTaskId = asText(taskId);
    if (!normalizedTaskId) return null;
    const includeDeleted = options.includeDeleted === true;
    const row = prepare(
      entry,
      `SELECT document_json, is_deleted
         FROM task_snapshots
        WHERE task_id = ?`,
    ).get(normalizedTaskId);
    if (!row) return null;
    if (!includeDeleted && Number(row.is_deleted || 0) !== 0) {
      return null;
    }
    const document = parseJsonText(row.document_json);
    if (!document || typeof document !== "object") return null;
    const topology = getTaskTopologyFromStateLedger(normalizedTaskId, options);
    if (topology) {
      document.topology = {
        ...(document.topology && typeof document.topology === "object" ? document.topology : {}),
        ...topology,
      };
    }
    return document;
  });
}

export function getTaskTopologyFromStateLedger(taskId, options = {}) {
  return withLedger(options, (entry) => {
    const normalizedTaskId = asText(taskId);
    if (!normalizedTaskId) return null;
    const row = prepare(
      entry,
      `SELECT *
         FROM task_topology
        WHERE task_id = ?`,
    ).get(normalizedTaskId);
    return hydrateTaskTopologyRow(row);
  });
}

export function listTaskSnapshotsFromStateLedger(options = {}) {
  return withLedger(options, (entry) => {
    const includeDeleted = options.includeDeleted === true;
    const rows = includeDeleted
      ? prepare(
        entry,
        `SELECT document_json
           FROM task_snapshots
          ORDER BY COALESCE(updated_at, created_at) ASC, task_id ASC`,
      ).all()
      : prepare(
        entry,
        `SELECT document_json
           FROM task_snapshots
          WHERE is_deleted = 0
          ORDER BY COALESCE(updated_at, created_at) ASC, task_id ASC`,
      ).all();
    return rows
      .map((row) => {
        const document = parseJsonText(row?.document_json);
        if (!document || typeof document !== "object") return null;
        const topology = getTaskTopologyFromStateLedger(document.id || document.taskId, options);
        if (topology) {
          document.topology = {
            ...(document.topology && typeof document.topology === "object" ? document.topology : {}),
            ...topology,
          };
        }
        return document;
      })
      .filter(Boolean);
  });
}

export function listTaskTopologiesFromStateLedger(options = {}) {
  return withLedger(options, (entry) => {
    const taskId = asText(options.taskId || options.task_id);
    const rootTaskId = asText(options.rootTaskId || options.root_task_id);
    const parentTaskId = asText(options.parentTaskId || options.parent_task_id);
    const latestRunId = asText(options.latestRunId || options.latest_run_id);
    const latestSessionId = asText(options.latestSessionId || options.latest_session_id);
    const clauses = [];
    const args = [];
    if (taskId) {
      clauses.push("task_id = ?");
      args.push(taskId);
    }
    if (rootTaskId) {
      clauses.push("root_task_id = ?");
      args.push(rootTaskId);
    }
    if (parentTaskId) {
      clauses.push("parent_task_id = ?");
      args.push(parentTaskId);
    }
    if (latestRunId) {
      clauses.push("latest_run_id = ?");
      args.push(latestRunId);
    }
    if (latestSessionId) {
      clauses.push("latest_session_id = ?");
      args.push(latestSessionId);
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = prepare(
      entry,
      `SELECT *
         FROM task_topology
         ${whereSql}
        ORDER BY updated_at ASC, task_id ASC`,
    ).all(...args);
    return rows.map((row) => hydrateTaskTopologyRow(row)).filter(Boolean);
  });
}

export function listToolCallsFromStateLedger(options = {}) {
  return withLedger(options, (entry) => {
    const clauses = [];
    const args = [];
    const runId = asText(options.runId || options.run_id);
    const taskId = asText(options.taskId || options.task_id);
    const sessionId = asText(options.sessionId || options.session_id);
    const toolName = asText(options.toolName || options.tool_name);
    const status = asText(options.status);
    if (runId) {
      clauses.push("run_id = ?");
      args.push(runId);
    }
    if (taskId) {
      clauses.push("task_id = ?");
      args.push(taskId);
    }
    if (sessionId) {
      clauses.push("session_id = ?");
      args.push(sessionId);
    }
    if (toolName) {
      clauses.push("tool_name = ?");
      args.push(toolName);
    }
    if (status) {
      clauses.push("status = ?");
      args.push(status);
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = prepare(
      entry,
      `SELECT *
         FROM tool_calls
         ${whereSql}
        ORDER BY COALESCE(started_at, updated_at) ASC, call_id ASC`,
    ).all(...args);
    return rows.map((row) => ({
      callId: row.call_id,
      runId: row.run_id || null,
      rootRunId: row.root_run_id || null,
      taskId: row.task_id || null,
      sessionId: row.session_id || null,
      executionId: row.execution_id || null,
      nodeId: row.node_id || null,
      toolId: row.tool_id || null,
      toolName: row.tool_name || null,
      serverId: row.server_id || null,
      provider: row.provider || null,
      status: row.status || null,
      startedAt: row.started_at || null,
      completedAt: row.completed_at || null,
      durationMs: Number(row.duration_ms || 0) || null,
      cwd: row.cwd || null,
      args: parseJsonText(row.args_json),
      request: parseJsonText(row.request_json),
      response: parseJsonText(row.response_json),
      error: row.error_text || null,
      summary: row.summary || null,
      updatedAt: row.updated_at,
    }));
  });
}

export function listArtifactsFromStateLedger(options = {}) {
  return withLedger(options, (entry) => {
    const clauses = [];
    const args = [];
    const runId = asText(options.runId || options.run_id);
    const taskId = asText(options.taskId || options.task_id);
    const sessionId = asText(options.sessionId || options.session_id);
    const kind = asText(options.kind);
    if (runId) {
      clauses.push("run_id = ?");
      args.push(runId);
    }
    if (taskId) {
      clauses.push("task_id = ?");
      args.push(taskId);
    }
    if (sessionId) {
      clauses.push("session_id = ?");
      args.push(sessionId);
    }
    if (kind) {
      clauses.push("kind = ?");
      args.push(kind);
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = prepare(
      entry,
      `SELECT *
         FROM artifacts
         ${whereSql}
        ORDER BY created_at ASC, artifact_id ASC`,
    ).all(...args);
    return rows.map((row) => ({
      artifactId: row.artifact_id,
      runId: row.run_id || null,
      rootRunId: row.root_run_id || null,
      taskId: row.task_id || null,
      sessionId: row.session_id || null,
      executionId: row.execution_id || null,
      nodeId: row.node_id || null,
      kind: row.kind || null,
      path: row.path || null,
      summary: row.summary || null,
      sourceEventId: row.source_event_id || null,
      metadata: parseJsonText(row.metadata_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  });
}

export function listTaskTraceEventsFromStateLedger(options = {}) {
  return withLedger(options, (entry) => {
    const clauses = [];
    const args = [];
    const runId = asText(options.runId || options.run_id);
    const taskId = asText(options.taskId || options.task_id);
    const sessionId = asText(options.sessionId || options.session_id);
    const agentId = asText(options.agentId || options.agent_id);
    const traceId = asText(options.traceId || options.trace_id);
    if (runId) {
      clauses.push("run_id = ?");
      args.push(runId);
    }
    if (taskId) {
      clauses.push("task_id = ?");
      args.push(taskId);
    }
    if (sessionId) {
      clauses.push("session_id = ?");
      args.push(sessionId);
    }
    if (agentId) {
      clauses.push("agent_id = ?");
      args.push(agentId);
    }
    if (traceId) {
      clauses.push("trace_id = ?");
      args.push(traceId);
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = prepare(
      entry,
      `SELECT *
         FROM task_trace_events
         ${whereSql}
        ORDER BY timestamp ASC, event_id ASC`,
    ).all(...args);
    return rows.map((row) => ({
      eventId: row.event_id,
      taskId: row.task_id,
      taskTitle: row.task_title || null,
      workflowId: row.workflow_id || null,
      workflowName: row.workflow_name || null,
      runId: row.run_id || null,
      status: row.status || null,
      nodeId: row.node_id || null,
      nodeType: row.node_type || null,
      nodeLabel: row.node_label || null,
      eventType: row.event_type,
      summary: row.summary || null,
      error: row.error_text || null,
      durationMs: Number(row.duration_ms || 0) || null,
      branch: row.branch || null,
      prNumber: row.pr_number || null,
      prUrl: row.pr_url || null,
      workspaceId: row.workspace_id || null,
      sessionId: row.session_id || null,
      sessionType: row.session_type || null,
      agentId: row.agent_id || null,
      traceId: row.trace_id || null,
      spanId: row.span_id || null,
      parentSpanId: row.parent_span_id || null,
      benchmarkHint: parseJsonText(row.benchmark_hint_json),
      meta: parseJsonText(row.meta_json),
      payload: parseJsonText(row.payload_json),
      timestamp: row.timestamp,
    }));
  });
}

export function getSessionActivityFromStateLedger(sessionId, options = {}) {
  return withLedger(options, (entry) => {
    const normalizedSessionId = asText(sessionId);
    if (!normalizedSessionId) return null;
    const row = prepare(
      entry,
      `SELECT *
         FROM session_activity
        WHERE session_id = ?`,
    ).get(normalizedSessionId);
    if (!row) return null;
    return mapSessionActivityRow(row);
  });
}

export function listSessionActivitiesFromStateLedger(options = {}) {
  return withLedger(options, (entry) => {
    const clauses = [];
    const args = [];
    const workspaceId = asText(options.workspaceId || options.workspace_id);
    const sessionType = asText(options.sessionType || options.session_type || options.type);
    const agentId = asText(options.agentId || options.agent_id);
    const status = asText(options.status || options.latestStatus || options.latest_status);
    const limit = Math.max(1, Math.min(5000, asInteger(options.limit) || 1000));
    if (workspaceId) {
      clauses.push("workspace_id = ?");
      args.push(workspaceId);
    }
    if (sessionType) {
      clauses.push("session_type = ?");
      args.push(sessionType);
    }
    if (agentId) {
      clauses.push("agent_id = ?");
      args.push(agentId);
    }
    if (status) {
      clauses.push("latest_status = ?");
      args.push(status);
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = prepare(
      entry,
      `SELECT *
         FROM session_activity
         ${whereSql}
        ORDER BY updated_at DESC, session_id DESC
        LIMIT ?`,
    ).all(...args, limit);
    return rows.map((row) => mapSessionActivityRow(row)).filter(Boolean);
  });
}

export function getAgentActivityFromStateLedger(agentId, options = {}) {
  return withLedger(options, (entry) => {
    const normalizedAgentId = asText(agentId);
    if (!normalizedAgentId) return null;
    const row = prepare(
      entry,
      `SELECT *
         FROM agent_activity
        WHERE agent_id = ?`,
    ).get(normalizedAgentId);
    if (!row) return null;
    return {
      agentId: row.agent_id,
      workspaceId: row.workspace_id || null,
      latestTaskId: row.latest_task_id || null,
      latestTaskTitle: row.latest_task_title || null,
      latestSessionId: row.latest_session_id || null,
      latestRunId: row.latest_run_id || null,
      latestWorkflowId: row.latest_workflow_id || null,
      latestWorkflowName: row.latest_workflow_name || null,
      latestEventType: row.latest_event_type || null,
      latestStatus: row.latest_status || null,
      traceId: row.trace_id || null,
      lastSpanId: row.last_span_id || null,
      parentSpanId: row.parent_span_id || null,
      lastErrorText: row.last_error_text || null,
      lastSummary: row.last_summary || null,
      firstSeenAt: row.first_seen_at || null,
      updatedAt: row.updated_at,
      eventCount: Number(row.event_count || 0) || 0,
      document: parseJsonText(row.document_json),
    };
  });
}

export function appendPromotedStrategyToStateLedger(record = {}, options = {}) {
  return withLedger(options, (entry) => {
    const normalized = normalizePromotedStrategyRecord(record);
    runTransaction(entry, () => {
      prepare(
        entry,
        `INSERT INTO promoted_strategy_events (
           event_id, strategy_id, workflow_id, run_id, task_id, session_id,
           scope, scope_id, category, decision, status, verification_status,
           confidence, recommendation, rationale, knowledge_hash, payload_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO UPDATE SET
           status = excluded.status,
           verification_status = excluded.verification_status,
           confidence = excluded.confidence,
           recommendation = excluded.recommendation,
           rationale = excluded.rationale,
           knowledge_hash = excluded.knowledge_hash,
           payload_json = excluded.payload_json,
           created_at = excluded.created_at`,
      ).run(
        normalized.eventId,
        normalized.strategyId,
        normalized.workflowId,
        normalized.runId,
        normalized.taskId,
        normalized.sessionId,
        normalized.scope,
        normalized.scopeId,
        normalized.category,
        normalized.decision,
        normalized.status,
        normalized.verificationStatus,
        normalized.confidence,
        normalized.recommendation,
        normalized.rationale,
        normalized.knowledgeHash,
        toJsonText(normalized.document),
        normalized.promotedAt,
      );

      prepare(
        entry,
        `INSERT INTO promoted_strategies (
           strategy_id, workflow_id, run_id, task_id, session_id, team_id, workspace_id,
           scope, scope_level, category, decision, status, verification_status, confidence,
           recommendation, rationale, knowledge_hash, knowledge_registry_path, tags_json,
           evidence_json, provenance_json, benchmark_json, metrics_json, evaluation_json,
           knowledge_json, promoted_at, updated_at, document_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(strategy_id) DO UPDATE SET
           workflow_id = excluded.workflow_id,
           run_id = excluded.run_id,
           task_id = excluded.task_id,
           session_id = excluded.session_id,
           team_id = excluded.team_id,
           workspace_id = excluded.workspace_id,
           scope = excluded.scope,
           scope_level = excluded.scope_level,
           category = excluded.category,
           decision = excluded.decision,
           status = excluded.status,
           verification_status = excluded.verification_status,
           confidence = excluded.confidence,
           recommendation = excluded.recommendation,
           rationale = excluded.rationale,
           knowledge_hash = excluded.knowledge_hash,
           knowledge_registry_path = excluded.knowledge_registry_path,
           tags_json = excluded.tags_json,
           evidence_json = excluded.evidence_json,
           provenance_json = excluded.provenance_json,
           benchmark_json = excluded.benchmark_json,
           metrics_json = excluded.metrics_json,
           evaluation_json = excluded.evaluation_json,
           knowledge_json = excluded.knowledge_json,
           promoted_at = excluded.promoted_at,
           updated_at = excluded.updated_at,
           document_json = excluded.document_json`,
      ).run(
        normalized.strategyId,
        normalized.workflowId,
        normalized.runId,
        normalized.taskId,
        normalized.sessionId,
        normalized.teamId,
        normalized.workspaceId,
        normalized.scope,
        normalized.scopeLevel,
        normalized.category,
        normalized.decision,
        normalized.status,
        normalized.verificationStatus,
        normalized.confidence,
        normalized.recommendation,
        normalized.rationale,
        normalized.knowledgeHash,
        normalized.knowledgeRegistryPath,
        toJsonText(normalized.tags),
        toJsonText(normalized.evidence),
        toJsonText(normalized.provenance),
        toJsonText(normalized.benchmark),
        toJsonText(normalized.metrics),
        toJsonText(normalized.evaluation),
        toJsonText(normalized.knowledge),
        normalized.promotedAt,
        normalized.updatedAt,
        toJsonText(normalized.document),
      );
    });
    return {
      path: entry.path,
      strategyId: normalized.strategyId,
      eventId: normalized.eventId,
    };
  });
}

export function getPromotedStrategyFromStateLedger(strategyId, options = {}) {
  return withLedger(options, (entry) => {
    const normalizedStrategyId = asText(strategyId);
    if (!normalizedStrategyId) return null;
    const row = prepare(
      entry,
      `SELECT *
         FROM promoted_strategies
        WHERE strategy_id = ?`,
    ).get(normalizedStrategyId);
    if (!row) return null;
    return {
      strategyId: row.strategy_id,
      workflowId: row.workflow_id || null,
      runId: row.run_id || null,
      taskId: row.task_id || null,
      sessionId: row.session_id || null,
      teamId: row.team_id || null,
      workspaceId: row.workspace_id || null,
      scope: row.scope || null,
      scopeLevel: row.scope_level || null,
      category: row.category || null,
      decision: row.decision || null,
      status: row.status || null,
      verificationStatus: row.verification_status || null,
      confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : null,
      recommendation: row.recommendation || null,
      rationale: row.rationale || null,
      knowledgeHash: row.knowledge_hash || null,
      knowledgeRegistryPath: row.knowledge_registry_path || null,
      tags: parseJsonText(row.tags_json) || [],
      evidence: parseJsonText(row.evidence_json) || [],
      provenance: parseJsonText(row.provenance_json) || [],
      benchmark: parseJsonText(row.benchmark_json),
      metrics: parseJsonText(row.metrics_json),
      evaluation: parseJsonText(row.evaluation_json),
      knowledge: parseJsonText(row.knowledge_json),
      promotedAt: row.promoted_at,
      updatedAt: row.updated_at,
      document: parseJsonText(row.document_json),
    };
  });
}

export function listPromotedStrategiesFromStateLedger(options = {}) {
  return withLedger(options, (entry) => {
    const clauses = [];
    const args = [];
    const workflowId = asText(options.workflowId || options.workflow_id);
    const runId = asText(options.runId || options.run_id);
    const taskId = asText(options.taskId || options.task_id);
    const sessionId = asText(options.sessionId || options.session_id);
    const decision = asText(options.decision);
    const status = asText(options.status);
    if (workflowId) {
      clauses.push("workflow_id = ?");
      args.push(workflowId);
    }
    if (runId) {
      clauses.push("run_id = ?");
      args.push(runId);
    }
    if (taskId) {
      clauses.push("task_id = ?");
      args.push(taskId);
    }
    if (sessionId) {
      clauses.push("session_id = ?");
      args.push(sessionId);
    }
    if (decision) {
      clauses.push("decision = ?");
      args.push(decision);
    }
    if (status) {
      clauses.push("status = ?");
      args.push(status);
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = prepare(
      entry,
      `SELECT *
         FROM promoted_strategies
         ${whereSql}
        ORDER BY updated_at DESC, strategy_id ASC`,
    ).all(...args);
    return rows.map((row) => ({
      strategyId: row.strategy_id,
      workflowId: row.workflow_id || null,
      runId: row.run_id || null,
      category: row.category || null,
      decision: row.decision || null,
      status: row.status || null,
      verificationStatus: row.verification_status || null,
      confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : null,
      recommendation: row.recommendation || null,
      rationale: row.rationale || null,
      knowledgeHash: row.knowledge_hash || null,
      promotedAt: row.promoted_at,
      updatedAt: row.updated_at,
      document: parseJsonText(row.document_json),
    }));
  });
}

export function listPromotedStrategyEventsFromStateLedger(options = {}) {
  return withLedger(options, (entry) => {
    const clauses = [];
    const args = [];
    const strategyId = asText(options.strategyId || options.strategy_id);
    const workflowId = asText(options.workflowId || options.workflow_id);
    const runId = asText(options.runId || options.run_id);
    const taskId = asText(options.taskId || options.task_id);
    const sessionId = asText(options.sessionId || options.session_id);
    if (strategyId) {
      clauses.push("strategy_id = ?");
      args.push(strategyId);
    }
    if (workflowId) {
      clauses.push("workflow_id = ?");
      args.push(workflowId);
    }
    if (runId) {
      clauses.push("run_id = ?");
      args.push(runId);
    }
    if (taskId) {
      clauses.push("task_id = ?");
      args.push(taskId);
    }
    if (sessionId) {
      clauses.push("session_id = ?");
      args.push(sessionId);
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = prepare(
      entry,
      `SELECT *
         FROM promoted_strategy_events
         ${whereSql}
        ORDER BY created_at ASC, event_id ASC`,
    ).all(...args);
    return rows.map((row) => ({
      eventId: row.event_id,
      strategyId: row.strategy_id,
      workflowId: row.workflow_id || null,
      runId: row.run_id || null,
      taskId: row.task_id || null,
      sessionId: row.session_id || null,
      scope: row.scope || null,
      scopeId: row.scope_id || null,
      category: row.category || null,
      decision: row.decision || null,
      status: row.status || null,
      verificationStatus: row.verification_status || null,
      confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : null,
      recommendation: row.recommendation || null,
      rationale: row.rationale || null,
      knowledgeHash: row.knowledge_hash || null,
      payload: parseJsonText(row.payload_json),
      createdAt: row.created_at,
    }));
  });
}

export function appendKnowledgeEntryToStateLedger(record = {}, options = {}) {
  return withLedger(options, (entry) => {
    const normalized = normalizeKnowledgeEntryRecord(record);
    prepare(
      entry,
      `INSERT INTO knowledge_entries (
         entry_hash, content, scope, scope_level, scope_id, agent_id, agent_type,
         category, task_ref, timestamp, team_id, workspace_id, session_id, run_id,
         workflow_id, strategy_id, confidence, verification_status, verified_at,
         provenance_json, evidence_json, tags_json, search_text, document_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entry_hash) DO UPDATE SET
         content = excluded.content,
         scope = excluded.scope,
         scope_level = excluded.scope_level,
         scope_id = excluded.scope_id,
         agent_id = excluded.agent_id,
         agent_type = excluded.agent_type,
         category = excluded.category,
         task_ref = excluded.task_ref,
         timestamp = excluded.timestamp,
         team_id = excluded.team_id,
         workspace_id = excluded.workspace_id,
         session_id = excluded.session_id,
         run_id = excluded.run_id,
         workflow_id = excluded.workflow_id,
         strategy_id = excluded.strategy_id,
         confidence = excluded.confidence,
         verification_status = excluded.verification_status,
         verified_at = excluded.verified_at,
         provenance_json = excluded.provenance_json,
         evidence_json = excluded.evidence_json,
         tags_json = excluded.tags_json,
         search_text = excluded.search_text,
         document_json = excluded.document_json`,
    ).run(
      normalized.entryHash,
      normalized.content,
      normalized.scope,
      normalized.scopeLevel,
      normalized.scopeId,
      normalized.agentId,
      normalized.agentType,
      normalized.category,
      normalized.taskRef,
      normalized.timestamp,
      normalized.teamId,
      normalized.workspaceId,
      normalized.sessionId,
      normalized.runId,
      normalized.workflowId,
      normalized.strategyId,
      normalized.confidence,
      normalized.verificationStatus,
      normalized.verifiedAt,
      toJsonText(normalized.provenance),
      toJsonText(normalized.evidence),
      toJsonText(normalized.tags),
      normalized.searchText,
      toJsonText(normalized.document),
    );
    return {
      path: entry.path,
      entryHash: normalized.entryHash,
    };
  });
}

export function listKnowledgeEntriesFromStateLedger(options = {}) {
  return withLedger(options, (entry) => {
    const clauses = [];
    const args = [];
    const teamId = asText(options.teamId || options.team_id);
    const workspaceId = asText(options.workspaceId || options.workspace_id);
    const sessionId = asText(options.sessionId || options.session_id);
    const runId = asText(options.runId || options.run_id);
    const scopeLevel = asText(options.scopeLevel || options.scope_level);
    const scope = asText(options.scope);
    const workflowId = asText(options.workflowId || options.workflow_id);
    const strategyId = asText(options.strategyId || options.strategy_id);
    const taskRef = asText(options.taskRef || options.task_ref);
    const entryHash = asText(options.entryHash || options.entry_hash || options.hash);
    if (entryHash) {
      clauses.push("entry_hash = ?");
      args.push(entryHash);
    }
    if (scopeLevel) {
      clauses.push("scope_level = ?");
      args.push(scopeLevel);
    }
    if (scope) {
      clauses.push("scope = ?");
      args.push(scope);
    }
    if (workflowId) {
      clauses.push("workflow_id = ?");
      args.push(workflowId);
    }
    if (strategyId) {
      clauses.push("strategy_id = ?");
      args.push(strategyId);
    }
    if (taskRef) {
      clauses.push("task_ref = ?");
      args.push(taskRef);
    }
    const visibilityClauses = [];
    if (teamId) visibilityClauses.push("(scope_level = 'team' AND team_id = ?)");
    if (workspaceId) visibilityClauses.push("(scope_level = 'workspace' AND workspace_id = ?)");
    if (sessionId) visibilityClauses.push("(scope_level = 'session' AND session_id = ?)");
    if (runId) visibilityClauses.push("(scope_level = 'run' AND run_id = ?)");
    if (visibilityClauses.length > 0 && !scopeLevel && !entryHash) {
      clauses.push(`(${visibilityClauses.join(" OR ")})`);
      if (teamId) args.push(teamId);
      if (workspaceId) args.push(workspaceId);
      if (sessionId) args.push(sessionId);
      if (runId) args.push(runId);
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(5000, Number(options.limit) || 5000));
    const rows = prepare(
      entry,
      `SELECT *
         FROM knowledge_entries
         ${whereSql}
        ORDER BY timestamp DESC, entry_hash ASC
        LIMIT ?`,
    ).all(...args, limit);
    return rows.map((row) => ({
      hash: row.entry_hash,
      entryHash: row.entry_hash,
      content: row.content,
      scope: row.scope || null,
      scopeLevel: row.scope_level || "workspace",
      scopeId: row.scope_id || null,
      agentId: row.agent_id || "unknown",
      agentType: row.agent_type || "codex",
      category: row.category || "pattern",
      taskRef: row.task_ref || null,
      timestamp: row.timestamp,
      teamId: row.team_id || null,
      workspaceId: row.workspace_id || null,
      sessionId: row.session_id || null,
      runId: row.run_id || null,
      workflowId: row.workflow_id || null,
      strategyId: row.strategy_id || null,
      confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : null,
      verificationStatus: row.verification_status || null,
      verifiedAt: row.verified_at || null,
      provenance: parseJsonText(row.provenance_json) || [],
      evidence: parseJsonText(row.evidence_json) || [],
      tags: parseJsonText(row.tags_json) || [],
      document: parseJsonText(row.document_json),
    }));
  });
}

function uniqueTextList(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    const text = asText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function toAuditTimestamp(...values) {
  for (const value of values) {
    const text = asText(value);
    if (text) return text;
  }
  return null;
}

function summarizeAuditEvent(event = {}) {
  const type = String(event.auditType || "").trim();
  if (type === "task_trace") {
    return asText(event.summary)
      || asText(event.error)
      || `${event.eventType || "task.trace"} for ${event.taskId || "task"}`;
  }
  if (type === "workflow_event") {
    return asText(event.summary)
      || asText(event.error)
      || `${event.eventType || "workflow.event"} for ${event.runId || "run"}`;
  }
  if (type === "task_claim") {
    return `${event.action || "claim"}${event.instanceId ? ` by ${event.instanceId}` : ""}`;
  }
  if (type === "tool_call") {
    const toolLabel = asText(event.toolName || event.toolId) || "tool";
    return asText(event.summary)
      || (event.status ? `${toolLabel} ${event.status}` : toolLabel);
  }
  if (type === "artifact") {
    return asText(event.summary)
      || asText(event.path)
      || asText(event.kind)
      || "artifact recorded";
  }
  if (type === "operator_action") {
    return asText(event.actionType)
      || asText(event.targetId)
      || "operator action";
  }
  if (type === "promoted_strategy") {
    return asText(event.recommendation)
      || asText(event.strategyId)
      || "promoted strategy";
  }
  return asText(event.summary) || asText(event.eventType) || type || "audit event";
}

function normalizeAuditEventEnvelope(record = {}, extras = {}) {
  const timestamp = toAuditTimestamp(
    extras.timestamp,
    record.timestamp,
    record.createdAt,
    record.updatedAt,
    record.startedAt,
    record.completedAt,
  );
  const auditType = asText(extras.auditType) || "audit_event";
  return {
    auditId: asText(extras.auditId)
      || asText(record.eventId)
      || asText(record.callId)
      || asText(record.artifactId)
      || asText(record.actionId)
      || asText(record.strategyId)
      || `${auditType}:${timestamp || "unknown"}`,
    auditType,
    timestamp,
    sortTimestamp: timestamp || "1970-01-01T00:00:00.000Z",
    taskId: asText(extras.taskId) || asText(record.taskId),
    runId: asText(extras.runId) || asText(record.runId),
    sessionId: asText(extras.sessionId) || asText(record.sessionId),
    agentId: asText(extras.agentId) || asText(record.agentId),
    workflowId: asText(extras.workflowId) || asText(record.workflowId),
    status: asText(extras.status) || asText(record.status),
    eventType: asText(extras.eventType) || asText(record.eventType) || asText(record.actionType),
    summary: summarizeAuditEvent({ ...record, ...extras, auditType }),
    record,
  };
}

function sortAuditEvents(events = [], direction = "desc") {
  const multiplier = String(direction || "").trim().toLowerCase() === "asc" ? 1 : -1;
  return [...(Array.isArray(events) ? events : [])].sort((left, right) => {
    const leftTs = Date.parse(left?.sortTimestamp || left?.timestamp || "") || 0;
    const rightTs = Date.parse(right?.sortTimestamp || right?.timestamp || "") || 0;
    if (leftTs !== rightTs) return (leftTs - rightTs) * multiplier;
    return String(left?.auditId || "").localeCompare(String(right?.auditId || "")) * multiplier;
  });
}

export function listAuditEventsFromStateLedger(options = {}) {
  const taskId = asText(options.taskId || options.task_id);
  const runId = asText(options.runId || options.run_id);
  const sessionId = asText(options.sessionId || options.session_id);
  const agentId = asText(options.agentId || options.agent_id);
  const strategyId = asText(options.strategyId || options.strategy_id);
  const includeWorkflowEvents = options.includeWorkflowEvents !== false;
  const events = [];

  if (includeWorkflowEvents) {
    const runIds = runId
      ? [runId]
      : (taskId
          ? listWorkflowRunsFromStateLedger(options)
              .filter((run) => asText(run?.taskId) === taskId)
              .map((run) => run.runId)
          : []);
    for (const workflowRunId of uniqueTextList(runIds)) {
      const workflowEvents = listWorkflowEventsFromStateLedger(workflowRunId, options);
      for (const event of workflowEvents) {
        events.push(normalizeAuditEventEnvelope(event, {
          auditType: "workflow_event",
          auditId: event.eventId || `${workflowRunId}:${event.seq || event.timestamp || "event"}`,
        }));
      }
    }
  }

  for (const event of listTaskTraceEventsFromStateLedger({
    ...options,
    ...(taskId ? { taskId } : {}),
    ...(runId ? { runId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(agentId ? { agentId } : {}),
  })) {
    events.push(normalizeAuditEventEnvelope(event, {
      auditType: "task_trace",
      auditId: event.eventId,
    }));
  }

  const taskClaimEvents = listTaskClaimEventsFromStateLedger(taskId || null, options)
    .filter((event) => !runId || asText(event?.run_id || event?.runId) === runId)
    .filter((event) => !sessionId || asText(event?.session_id || event?.sessionId) === sessionId);
  for (const event of taskClaimEvents) {
    events.push(normalizeAuditEventEnvelope(event, {
      auditType: "task_claim",
      auditId: asText(event?.event_id || event?.eventId) || `${taskId || event?.task_id || event?.taskId}:claim:${event?.timestamp || ""}`,
      taskId: event?.task_id || event?.taskId,
      runId: event?.run_id || event?.runId,
      sessionId: event?.session_id || event?.sessionId,
      status: event?.status || event?.action,
      timestamp: event?.timestamp,
      eventType: event?.action,
      agentId: event?.agent_id || event?.agentId,
    }));
  }

  for (const call of listToolCallsFromStateLedger({
    ...options,
    ...(taskId ? { taskId } : {}),
    ...(runId ? { runId } : {}),
    ...(sessionId ? { sessionId } : {}),
  })) {
    events.push(normalizeAuditEventEnvelope(call, {
      auditType: "tool_call",
      auditId: call.callId,
      timestamp: call.startedAt || call.completedAt || call.updatedAt,
    }));
  }

  for (const artifact of listArtifactsFromStateLedger({
    ...options,
    ...(taskId ? { taskId } : {}),
    ...(runId ? { runId } : {}),
    ...(sessionId ? { sessionId } : {}),
  })) {
    events.push(normalizeAuditEventEnvelope(artifact, {
      auditType: "artifact",
      auditId: artifact.artifactId,
      timestamp: artifact.createdAt || artifact.updatedAt,
    }));
  }

  const operatorActions = listOperatorActionsFromStateLedger({
    ...options,
    ...(taskId ? { taskId } : {}),
    ...(runId ? { runId } : {}),
    ...(sessionId ? { sessionId } : {}),
  }).filter((action) => !agentId || asText(action?.actorId) === agentId);
  for (const action of operatorActions) {
    events.push(normalizeAuditEventEnvelope(action, {
      auditType: "operator_action",
      auditId: action.actionId,
      agentId: action.actorType === "agent" ? action.actorId : null,
      timestamp: action.createdAt || action.updatedAt,
    }));
  }

  for (const event of listPromotedStrategyEventsFromStateLedger({
    ...options,
    ...(strategyId ? { strategyId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(runId ? { runId } : {}),
    ...(sessionId ? { sessionId } : {}),
  })) {
    events.push(normalizeAuditEventEnvelope(event, {
      auditType: "promoted_strategy",
      auditId: event.eventId,
      timestamp: event.createdAt,
    }));
  }

  const normalizedSearch = asText(options.search)?.toLowerCase() || "";
  let sorted = sortAuditEvents(events, options.direction || "desc");
  if (normalizedSearch) {
    sorted = sorted.filter((event) => {
      const haystack = [
        event.auditType,
        event.taskId,
        event.runId,
        event.sessionId,
        event.agentId,
        event.workflowId,
        event.status,
        event.eventType,
        event.summary,
        toJsonText(event.record),
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(normalizedSearch);
    });
  }
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.trunc(Number(options.limit))) : null;
  return limit ? sorted.slice(0, limit) : sorted;
}

export function getTaskAuditBundleFromStateLedger(taskId, options = {}) {
  const normalizedTaskId = asText(taskId);
  if (!normalizedTaskId) return null;
  const task = getTaskSnapshotFromStateLedger(normalizedTaskId, options);
  const taskTopology = getTaskTopologyFromStateLedger(normalizedTaskId, options);
  const claim = getActiveTaskClaimFromStateLedger(normalizedTaskId, options);
  const claimEvents = listTaskClaimEventsFromStateLedger(normalizedTaskId, options);
  const workflowRuns = listWorkflowRunsFromStateLedger(options)
    .filter((run) => asText(run?.taskId) === normalizedTaskId);
  const taskTraceEvents = listTaskTraceEventsFromStateLedger({ ...options, taskId: normalizedTaskId });
  const toolCalls = listToolCallsFromStateLedger({ ...options, taskId: normalizedTaskId });
  const artifacts = listArtifactsFromStateLedger({ ...options, taskId: normalizedTaskId });
  const operatorActions = listOperatorActionsFromStateLedger({ ...options, taskId: normalizedTaskId });
  const promotedStrategies = listPromotedStrategiesFromStateLedger({ ...options, taskId: normalizedTaskId });
  const promotedStrategyEvents = listPromotedStrategyEventsFromStateLedger({ ...options, taskId: normalizedTaskId });
  const sessionIds = uniqueTextList([
    task?.sessionId,
    task?.primarySessionId,
    ...taskTraceEvents.map((event) => event.sessionId),
    ...workflowRuns.map((run) => run.sessionId),
    ...toolCalls.map((call) => call.sessionId),
    ...artifacts.map((artifact) => artifact.sessionId),
    ...operatorActions.map((action) => action.sessionId),
    ...promotedStrategyEvents.map((event) => event.sessionId),
  ]);
  const agentIds = uniqueTextList([
    task?.agentId,
    ...taskTraceEvents.map((event) => event.agentId),
  ]);
  const sessionActivity = sessionIds[0] ? getSessionActivityFromStateLedger(sessionIds[0], options) : null;
  const agentActivity = agentIds[0] ? getAgentActivityFromStateLedger(agentIds[0], options) : null;
  const auditEvents = listAuditEventsFromStateLedger({ ...options, taskId: normalizedTaskId });
  return {
    taskId: normalizedTaskId,
    task,
    taskTopology,
    claim,
    claimEvents,
    workflowRuns,
    taskTraceEvents,
    toolCalls,
    artifacts,
    operatorActions,
    promotedStrategies,
    promotedStrategyEvents,
    sessionIds,
    agentIds,
    sessionActivity,
    agentActivity,
    auditEvents,
    summary: {
      eventCount: auditEvents.length,
      runCount: workflowRuns.length,
      claimEventCount: claimEvents.length,
      taskTraceCount: taskTraceEvents.length,
      toolCallCount: toolCalls.length,
      artifactCount: artifacts.length,
      operatorActionCount: operatorActions.length,
      promotedStrategyCount: promotedStrategies.length,
      latestEventAt: auditEvents[0]?.timestamp || null,
      latestRunId: workflowRuns.at(-1)?.runId || null,
      latestSessionId: sessionIds[0] || null,
      latestAgentId: agentIds[0] || null,
      delegationDepth: taskTopology?.delegationDepth ?? task?.topology?.delegationDepth ?? 0,
    },
  };
}

export function getRunAuditBundleFromStateLedger(runId, options = {}) {
  const normalizedRunId = asText(runId);
  if (!normalizedRunId) return null;
  const run = getWorkflowRunFromStateLedger(normalizedRunId, options);
  if (!run) return null;
  const workflowEvents = listWorkflowEventsFromStateLedger(normalizedRunId, options);
  const taskId = asText(run?.taskId);
  const taskTraceEvents = listTaskTraceEventsFromStateLedger({ ...options, runId: normalizedRunId });
  const toolCalls = listToolCallsFromStateLedger({ ...options, runId: normalizedRunId });
  const artifacts = listArtifactsFromStateLedger({ ...options, runId: normalizedRunId });
  const promotedStrategies = listPromotedStrategiesFromStateLedger({
    ...options,
    runId: normalizedRunId,
    ...(taskId ? { taskId } : {}),
    ...(run?.workflowId ? { workflowId: run.workflowId } : {}),
  });
  const promotedStrategyEvents = listPromotedStrategyEventsFromStateLedger({
    ...options,
    runId: normalizedRunId,
    ...(taskId ? { taskId } : {}),
    ...(run?.workflowId ? { workflowId: run.workflowId } : {}),
  });
  const sessionIds = uniqueTextList([
    run?.sessionId,
    ...taskTraceEvents.map((event) => event.sessionId),
    ...toolCalls.map((call) => call.sessionId),
    ...artifacts.map((artifact) => artifact.sessionId),
    ...promotedStrategyEvents.map((event) => event.sessionId),
  ]);
  const agentIds = uniqueTextList([
    run?.agentId,
    ...taskTraceEvents.map((event) => event.agentId),
  ]);
  const sessionActivity = sessionIds[0] ? getSessionActivityFromStateLedger(sessionIds[0], options) : null;
  const agentActivity = agentIds[0] ? getAgentActivityFromStateLedger(agentIds[0], options) : null;
  const auditEvents = listAuditEventsFromStateLedger({
    ...options,
    runId: normalizedRunId,
    ...(taskId ? { taskId } : {}),
  });
  return {
    runId: normalizedRunId,
    run,
    workflowEvents,
    taskTraceEvents,
    toolCalls,
    artifacts,
    promotedStrategies,
    promotedStrategyEvents,
    sessionIds,
    agentIds,
    sessionActivity,
    agentActivity,
    auditEvents,
    summary: {
      eventCount: auditEvents.length,
      workflowEventCount: workflowEvents.length,
      taskTraceCount: taskTraceEvents.length,
      toolCallCount: toolCalls.length,
      artifactCount: artifacts.length,
      promotedStrategyCount: promotedStrategies.length,
      latestEventAt: auditEvents[0]?.timestamp || null,
      latestSessionId: sessionIds[0] || null,
      latestAgentId: agentIds[0] || null,
      taskId,
      workflowId: run?.workflowId || null,
    },
  };
}

export function listTaskAuditSummariesFromStateLedger(options = {}) {
  const normalizedSearch = asText(options.search)?.toLowerCase() || "";
  const taskSnapshots = listTaskSnapshotsFromStateLedger(options);
  const snapshotMap = new Map(
    taskSnapshots
      .filter((task) => asText(task?.id))
      .map((task) => [asText(task.id), task]),
  );
  const discoveredTaskIds = uniqueTextList([
    ...taskSnapshots.map((task) => task?.id),
    ...listWorkflowTaskRunEntriesFromStateLedger(options).map((entry) => entry?.taskId),
    ...listTaskTraceEventsFromStateLedger(options).map((entry) => entry?.taskId),
  ]);
  let summaries = discoveredTaskIds.map((taskId) => {
    const task = snapshotMap.get(taskId) || null;
    const bundle = getTaskAuditBundleFromStateLedger(taskId, {
      ...options,
      limit: options.eventLimit || 100,
    });
    return {
      taskId: taskId || null,
      title: task?.title || bundle?.taskTraceEvents?.at(-1)?.taskTitle || null,
      status: task?.status || bundle?.workflowRuns?.at(-1)?.status || null,
      updatedAt: task?.updatedAt || task?.updated_at || bundle?.summary?.latestEventAt || null,
      summary: bundle?.summary || null,
      sessionIds: bundle?.sessionIds || [],
      agentIds: bundle?.agentIds || [],
    };
  }).filter((entry) => entry.taskId);
  if (normalizedSearch) {
    summaries = summaries.filter((entry) => {
      const haystack = [
        entry?.taskId,
        entry?.title,
        entry?.status,
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(normalizedSearch);
    });
  }
  summaries.sort((left, right) => {
    const leftTs = Date.parse(left?.updatedAt || left?.summary?.latestEventAt || "") || 0;
    const rightTs = Date.parse(right?.updatedAt || right?.summary?.latestEventAt || "") || 0;
    if (leftTs !== rightTs) return rightTs - leftTs;
    return String(left?.taskId || "").localeCompare(String(right?.taskId || ""));
  });
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.trunc(Number(options.limit))) : null;
  return limit ? summaries.slice(0, limit) : summaries;
}

export function upsertStateLedgerKeyValue(record = {}, options = {}) {
  return withLedger(options, (entry) => {
    const scope = asText(record.scope || "global") || "global";
    const scopeId = asText(record.scopeId || record.scope_id || "default") || "default";
    const keyName = asText(record.key || record.keyName || record.key_name || "");
    if (!keyName) {
      throw new Error(`${TAG} key_values key is required`);
    }
    const updatedAt = normalizeTimestamp(record.updatedAt || record.updated_at);
    const value = Object.prototype.hasOwnProperty.call(record, "value") ? record.value : record.value_json;
    prepare(
      entry,
      `INSERT INTO key_values (
         scope, scope_id, key_name, value_json, value_type, source,
         run_id, task_id, session_id, metadata_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, scope_id, key_name) DO UPDATE SET
         value_json = excluded.value_json,
         value_type = excluded.value_type,
         source = excluded.source,
         run_id = excluded.run_id,
         task_id = excluded.task_id,
         session_id = excluded.session_id,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
    ).run(
      scope,
      scopeId,
      keyName,
      toJsonText(value),
      inferValueType(value),
      asText(record.source),
      asText(record.runId || record.run_id),
      asText(record.taskId || record.task_id),
      asText(record.sessionId || record.session_id),
      toJsonText(record.metadata ?? null),
      updatedAt,
    );
    return {
      path: entry.path,
      scope,
      scopeId,
      keyName,
      updatedAt,
    };
  });
}

export function getStateLedgerKeyValue(scope, scopeId, keyName, options = {}) {
  return withLedger(options, (entry) => {
    const normalizedScope = asText(scope || "global") || "global";
    const normalizedScopeId = asText(scopeId || "default") || "default";
    const normalizedKey = asText(keyName);
    if (!normalizedKey) return null;
    const row = prepare(
      entry,
      `SELECT *
         FROM key_values
        WHERE scope = ?
          AND scope_id = ?
          AND key_name = ?`,
    ).get(normalizedScope, normalizedScopeId, normalizedKey);
    if (!row) return null;
    return {
      scope: row.scope,
      scopeId: row.scope_id,
      key: row.key_name,
      value: parseJsonText(row.value_json),
      valueType: row.value_type || null,
      source: row.source || null,
      runId: row.run_id || null,
      taskId: row.task_id || null,
      sessionId: row.session_id || null,
      metadata: parseJsonText(row.metadata_json),
      updatedAt: row.updated_at,
    };
  });
}

export function appendOperatorActionToStateLedger(record = {}, options = {}) {
  return withLedger(options, (entry) => {
    const createdAt = normalizeTimestamp(record.createdAt || record.created_at);
    const actionId = asText(
      record.actionId
        || record.action_id
        || `${record.actionType || record.action_type || "action"}:${createdAt}:${record.targetId || record.target_id || ""}`,
    );
    if (!actionId) {
      throw new Error(`${TAG} operator action id is required`);
    }
    prepare(
      entry,
      `INSERT INTO operator_actions (
         action_id, action_type, actor_id, actor_type, scope, scope_id, target_id,
         run_id, task_id, session_id, status, request_json, result_json, metadata_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(action_id) DO UPDATE SET
         status = excluded.status,
         result_json = excluded.result_json,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
    ).run(
      actionId,
      asText(record.actionType || record.action_type) || "action",
      asText(record.actorId || record.actor_id),
      asText(record.actorType || record.actor_type),
      asText(record.scope),
      asText(record.scopeId || record.scope_id),
      asText(record.targetId || record.target_id),
      asText(record.runId || record.run_id),
      asText(record.taskId || record.task_id),
      asText(record.sessionId || record.session_id),
      asText(record.status || "completed"),
      toJsonText(record.request ?? null),
      toJsonText(record.result ?? null),
      toJsonText(record.metadata ?? null),
      createdAt,
      normalizeTimestamp(record.updatedAt || record.updated_at || createdAt),
    );
    return { path: entry.path, actionId };
  });
}

export function listOperatorActionsFromStateLedger(options = {}) {
  return withLedger(options, (entry) => {
    const clauses = [];
    const args = [];
    const actionId = asText(options.actionId || options.action_id);
    const actionType = asText(options.actionType || options.action_type);
    const scope = asText(options.scope);
    const scopeId = asText(options.scopeId || options.scope_id);
    const taskId = asText(options.taskId || options.task_id);
    const runId = asText(options.runId || options.run_id);
    const sessionId = asText(options.sessionId || options.session_id);
    const actorId = asText(options.actorId || options.actor_id);
    const targetId = asText(options.targetId || options.target_id);
    const status = asText(options.status);
    if (actionId) {
      clauses.push("action_id = ?");
      args.push(actionId);
    }
    if (actionType) {
      clauses.push("action_type = ?");
      args.push(actionType);
    }
    if (scope) {
      clauses.push("scope = ?");
      args.push(scope);
    }
    if (scopeId) {
      clauses.push("scope_id = ?");
      args.push(scopeId);
    }
    if (taskId) {
      clauses.push("task_id = ?");
      args.push(taskId);
    }
    if (runId) {
      clauses.push("run_id = ?");
      args.push(runId);
    }
    if (sessionId) {
      clauses.push("session_id = ?");
      args.push(sessionId);
    }
    if (actorId) {
      clauses.push("actor_id = ?");
      args.push(actorId);
    }
    if (targetId) {
      clauses.push("target_id = ?");
      args.push(targetId);
    }
    if (status) {
      clauses.push("status = ?");
      args.push(status);
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = prepare(
      entry,
      `SELECT *
         FROM operator_actions
         ${whereSql}
        ORDER BY created_at ASC, action_id ASC`,
    ).all(...args);
    return rows.map((row) => ({
      actionId: row.action_id,
      actionType: row.action_type,
      actorId: row.actor_id || null,
      actorType: row.actor_type || null,
      scope: row.scope || null,
      scopeId: row.scope_id || null,
      targetId: row.target_id || null,
      runId: row.run_id || null,
      taskId: row.task_id || null,
      sessionId: row.session_id || null,
      status: row.status || null,
      request: parseJsonText(row.request_json),
      result: parseJsonText(row.result_json),
      metadata: parseJsonText(row.metadata_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  });
}

export function upsertApprovalRequestToStateLedger(request = {}, options = {}) {
  return withLedger(options, (entry) => {
    const requestId = asText(request.requestId || request.id);
    if (!requestId) {
      throw new Error(`${TAG} approval request id is required`);
    }
    const requestedAt = normalizeTimestamp(request.requestedAt || request.createdAt || request.updatedAt);
    const updatedAt = normalizeTimestamp(request.updatedAt || requestedAt);
    const status = asText(request.status || "pending") || "pending";
    prepare(
      entry,
      `INSERT INTO operator_actions (
         action_id, action_type, actor_id, actor_type, scope, scope_id, target_id,
         run_id, task_id, session_id, status, request_json, result_json, metadata_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(action_id) DO UPDATE SET
         actor_id = excluded.actor_id,
         actor_type = excluded.actor_type,
         scope = excluded.scope,
         scope_id = excluded.scope_id,
         target_id = excluded.target_id,
         run_id = excluded.run_id,
         task_id = excluded.task_id,
         session_id = excluded.session_id,
         status = excluded.status,
         request_json = excluded.request_json,
         result_json = excluded.result_json,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
    ).run(
      requestId,
      "approval_request",
      asText(request.requestedBy || request.actorId || request.actor_id),
      "approval",
      asText(request.scopeType || request.scope_type),
      asText(request.scopeId || request.scope_id),
      requestId,
      asText(request.runId || request.run_id),
      asText(request.taskId || request.task_id),
      asText(request.sessionId || request.session_id),
      status,
      toJsonText(request),
      toJsonText(request.resolution ?? null),
      toJsonText({
        queue: "approval",
        scopeType: asText(request.scopeType || request.scope_type),
        scopeId: asText(request.scopeId || request.scope_id),
      }),
      requestedAt,
      updatedAt,
    );
    return { path: entry.path, requestId };
  });
}

function hydrateApprovalRequestFromOperatorAction(row = {}) {
  const request = parseJsonText(row.request_json);
  const resolution = parseJsonText(row.result_json);
  const base = request && typeof request === "object" ? request : {};
  const hydrated = {
    ...base,
    requestId: asText(base.requestId || row.action_id),
    scopeType: asText(base.scopeType || row.scope),
    scopeId: asText(base.scopeId || row.scope_id),
    runId: asText(base.runId || row.run_id),
    taskId: asText(base.taskId || row.task_id),
    sessionId: asText(base.sessionId || row.session_id),
    requestedBy: asText(base.requestedBy || row.actor_id),
    status: asText(base.status || row.status || "pending") || "pending",
    requestedAt: normalizeTimestamp(base.requestedAt || row.created_at),
    updatedAt: normalizeTimestamp(base.updatedAt || row.updated_at || row.created_at),
    resolution: base.resolution && typeof base.resolution === "object"
      ? base.resolution
      : (resolution && typeof resolution === "object" ? resolution : null),
  };
  if (!Array.isArray(hydrated.history)) {
    hydrated.history = [];
  }
  return hydrated;
}

export function getApprovalRequestFromStateLedger(requestId, options = {}) {
  return withLedger(options, (entry) => {
    const normalizedRequestId = asText(requestId);
    if (!normalizedRequestId) return null;
    const row = prepare(
      entry,
      `SELECT *
         FROM operator_actions
        WHERE action_type = 'approval_request'
          AND action_id = ?`,
    ).get(normalizedRequestId);
    return row ? hydrateApprovalRequestFromOperatorAction(row) : null;
  });
}

export function getApprovalRequestByScopeFromStateLedger(scopeType, scopeId, options = {}) {
  return withLedger(options, (entry) => {
    const normalizedScopeType = asText(scopeType);
    const normalizedScopeId = asText(scopeId);
    if (!normalizedScopeType || !normalizedScopeId) return null;
    const row = prepare(
      entry,
      `SELECT *
         FROM operator_actions
        WHERE action_type = 'approval_request'
          AND scope = ?
          AND scope_id = ?`,
    ).get(normalizedScopeType, normalizedScopeId);
    return row ? hydrateApprovalRequestFromOperatorAction(row) : null;
  });
}

export function listApprovalRequestsFromStateLedger(options = {}) {
  return withLedger(options, (entry) => {
    const clauses = ["action_type = 'approval_request'"];
    const args = [];
    const scopeType = asText(options.scopeType || options.scope_type);
    const status = asText(options.status);
    const includeResolved = options.includeResolved === true;
    const requestId = asText(options.requestId || options.request_id);
    const runId = asText(options.runId || options.run_id);
    const taskId = asText(options.taskId || options.task_id);
    const limit = Number.isFinite(Number(options.limit))
      ? Math.max(1, Math.min(500, Math.trunc(Number(options.limit))))
      : 100;
    if (requestId) {
      clauses.push("action_id = ?");
      args.push(requestId);
    }
    if (scopeType) {
      clauses.push("scope = ?");
      args.push(scopeType);
    }
    if (status) {
      clauses.push("status = ?");
      args.push(status);
    } else if (!includeResolved) {
      clauses.push("status = 'pending'");
    }
    if (runId) {
      clauses.push("run_id = ?");
      args.push(runId);
    }
    if (taskId) {
      clauses.push("task_id = ?");
      args.push(taskId);
    }
    const rows = prepare(
      entry,
      `SELECT *
         FROM operator_actions
        WHERE ${clauses.join(" AND ")}
        ORDER BY updated_at DESC, action_id DESC
        LIMIT ?`,
    ).all(...args, limit);
    return rows.map((row) => hydrateApprovalRequestFromOperatorAction(row)).filter(Boolean);
  });
}

export function appendArtifactRecordToStateLedger(record = {}, options = {}) {
  return withLedger(options, (entry) => {
    const createdAt = normalizeTimestamp(record.createdAt || record.created_at);
    const artifactId = asText(
      record.artifactId
        || record.artifact_id
        || `${record.runId || record.run_id || "artifact"}:${sanitizeKeyPart(record.kind || "artifact")}:${sanitizeKeyPart(record.path || createdAt)}`,
    );
    if (!artifactId) {
      throw new Error(`${TAG} artifact id is required`);
    }
    prepare(
      entry,
      `INSERT INTO artifacts (
         artifact_id, run_id, root_run_id, task_id, session_id, execution_id, node_id,
         kind, path, summary, source_event_id, metadata_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(artifact_id) DO UPDATE SET
         kind = excluded.kind,
         path = excluded.path,
         summary = excluded.summary,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
    ).run(
      artifactId,
      asText(record.runId || record.run_id),
      asText(record.rootRunId || record.root_run_id),
      asText(record.taskId || record.task_id),
      asText(record.sessionId || record.session_id),
      asText(record.executionId || record.execution_id),
      asText(record.nodeId || record.node_id),
      asText(record.kind || "artifact") || "artifact",
      asText(record.path),
      asText(record.summary),
      asText(record.sourceEventId || record.source_event_id),
      toJsonText(record.metadata ?? null),
      createdAt,
      normalizeTimestamp(record.updatedAt || record.updated_at || createdAt),
    );
    return { path: entry.path, artifactId };
  });
}

export function getStateLedgerInfo(options = {}) {
  return withLedger(options, (entry) => {
    const schemaVersion = prepare(entry, "PRAGMA user_version").get()?.user_version ?? 0;
    const tables = prepare(
      entry,
      `SELECT name
         FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
        ORDER BY name ASC`,
    ).all().map((row) => row.name);
    return {
      path: entry.path,
      schemaVersion: Number(schemaVersion || 0),
      tables,
    };
  });
}

export function resetStateLedgerCache() {
  for (const entry of _stateLedgerCache.values()) {
    try {
      entry.db.close();
    } catch {
      /* best effort */
    }
  }
  _stateLedgerCache.clear();
}
