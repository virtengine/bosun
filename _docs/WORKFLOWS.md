# Bosun Workflows

Bosun workflows are DAGs (directed acyclic graphs) of nodes that automate orchestration tasks such as PR handling, anomaly response, task planning, and health checks. Workflows are editable in the Telegram miniapp UI and stored as JSON on disk.

**Where Workflows Live**

- Definitions: `.bosun/workflows/*.json`
- Run history index: `.bosun/workflow-runs/index.json`
- Full run logs: `.bosun/workflow-runs/<runId>.json`
- Migration state: `.bosun/workflow-migration.json`

**How To Create Or Install**

- UI: Telegram miniapp → Workflows tab → Create Workflow or install a template.
- API: `POST /api/workflows/save` to create or update JSON definitions.
- File-based: drop a workflow JSON file into `.bosun/workflows/`.
- Templates: `POST /api/workflows/install-template` or use the UI install button.

## Research Evidence Sidecar Workflow

Bosun's scientific research path can run an evidence-backed workflow without changing the native context indexer. The manual `research-agent` flow now supports a sidecar-aware mode that:

- Keeps Bosun as the orchestrator and verification loop owner.
- Builds a structured evidence bundle through `workflow/research-evidence-sidecar.mjs`.
- Accepts optional local text corpora via `corpusPaths`.
- Optionally delegates to an external in-house sidecar command through a JSON stdin/stdout contract.
- Writes raw evidence artifacts to `.bosun/research-evidence/`.
- Promotes only reviewed findings into `.bosun/shared-knowledge/REVIEWED_RESEARCH.md` after the verifier returns `VERDICT: CORRECT`.

Important boundary: the Bosun-native `workspace/context-indexer.mjs` remains unchanged and PDFs stay excluded from that index. If PDF-derived evidence is needed, extract text or notes for the sidecar corpus instead of widening the context indexer.

## State Ledger Contract

Bosun now dual-writes workflow, task, and claim state into a SQLite ledger at `.bosun/.cache/state-ledger.sqlite` while keeping the existing JSON and JSONL stores authoritative for runtime continuity.

- `workflow/execution-ledger.mjs` mirrors run metadata and execution events into the ledger.
- `task/task-claims.mjs` mirrors claim snapshots and claim audit events into the ledger.
- `task/task-store.mjs` mirrors current task snapshots, including deletes, into the ledger.
- Read models may hydrate from the SQLite ledger when file-backed state is missing or truncated.

Important boundary: phase 1 ledger adoption is for auditability, replay, analytics, and self-improvement inputs. Bosun must continue to execute correctly if the SQLite mirror is unavailable.

## Planner Proof Contract

Planner-heavy workflows now expose structured proof surfaces in run detail and task-linked workflow summaries.

- `plannerTimeline` captures planner lifecycle events such as initialization, reasoning steps, attachments, completion, and blocked stages.
- `proofBundle.summary` reports planner, decision, evidence, and artifact counts.
- `proofBundle.decisions` aggregates planner decisions plus issue-advisor guidance and retry-policy outcomes.
- `proofBundle.evidence` and `proofBundle.artifacts` capture completion evidence, artifact pointers, and proof attachments for downstream review.
- `server/ui-server.mjs` includes these proof surfaces in workflow run payloads consumed by the Mini App and hosted UI.

Operators should treat these surfaces as the canonical review payload for planner workflows instead of reconstructing proof from raw logs.

## RepoMirror Projection Contract

Bosun can project shared kanban state into a RepoMirror repository layout when RepoMirror is explicitly enabled in Settings.

- `KANBAN_BACKEND=repo-mirror` is valid only when `REPO_MIRROR_ENABLED=true`, `REPO_MIRROR_REPO_PATH` is set, and `REPO_MIRROR_SYNC_MODE=projection`.
- Projected artifacts are written under `.repo-mirror/`, including task state, run summaries, and collaboration messages.
- The internal Bosun task store remains authoritative for task creation, status changes, comments, claims, and workflow liveness.
- RepoMirror is intended for cross-user visibility and collaboration, not for replacing `task/task-claims.mjs`, shared-state coordination, or fleet heartbeats.

Important boundary: projection mode is the only supported RepoMirror sync mode in this rollout.

## Self-Improvement Contract

Bosun self-improvement is now workflow-native rather than a separate subsystem.

- `action.evaluate_run` benchmarks a workflow run, records durable evaluation history, and emits promotion candidates.
- `action.promote_strategy` persists verified strategies and baselines into shared knowledge when the evaluator recommends promotion or a workflow explicitly forces it.
- The reliability template uses recent-run evaluation and promotion gates to preserve good patterns and surface regressions.
- Shared knowledge entries must retain provenance back to the evaluated run and workflow before they can influence future planning.

Important boundary: self-improvement recommendations are evidence-gated. Bosun should not automatically mutate production strategy based only on one unreviewed run.

**Workflow Definition (JSON)**
Minimum example:

```json
{
  "name": "Hello Workflow",
  "description": "Logs a hello message",
  "category": "custom",
  "enabled": true,
  "nodes": [
    {
      "id": "trigger",
      "type": "trigger.manual",
      "label": "Manual",
      "config": {},
      "position": { "x": 100, "y": 80 }
    },
    {
      "id": "log",
      "type": "notify.log",
      "label": "Log",
      "config": { "message": "Hello from workflow" },
      "position": { "x": 100, "y": 220 }
    }
  ],
  "edges": [
    {
      "id": "trigger->log",
      "source": "trigger",
      "target": "log",
      "sourcePort": "default"
    }
  ],
  "variables": {}
}
```

Core fields:
| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Optional for create; generated on save |
| `name` | string | Display name |
| `description` | string | Optional |
| `category` | string | Free-form grouping |
| `enabled` | boolean | Disabled workflows do not run |
| `trigger` | string | Optional summary for UI |
| `nodes` | array | Workflow nodes |
| `edges` | array | Connections between nodes |
| `variables` | object | Workflow-level defaults |
| `metadata` | object | Versioning, author, timestamps |

Node fields:
| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Unique node ID |
| `type` | string | Node type from registry |
| `label` | string | UI label |
| `config` | object | Node-specific config |
| `position` | object | `{x,y}` for canvas layout |
| `outputs` | array | Named output ports |

Edge fields:
| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Unique edge ID |
| `source` | string | Source node ID |
| `target` | string | Target node ID |
| `sourcePort` | string | Output port name |
| `condition` | string | Expression gate for the edge |

**Templating And Expressions**

- Template values inside config strings use `{{variable}}` syntax.
- You can reference node outputs in templates with `{{nodeId.field}}`.
- Edge conditions use JS expressions with `$output`, `$data`, `$status`, `$ctx`.

Example condition:

```js
$output?.success === true && $data?.priority === "high";
```

**Execution Model**

- Entry nodes are any nodes without incoming edges.
- Nodes run in parallel when dependencies are satisfied.
- Retries: `node.config.maxRetries` or `node.config.retryable = false` to disable.
- Error handling: `node.config.continueOnError = true` allows workflow to keep running.
- Run logs are persisted to `.bosun/workflow-runs/`.

**Run Persistence & Auto-Resume**

- Active run state is written to disk at `.bosun/workflow-runs/<runId>.json` after every node completion.
- On `ui-server.mjs` restart, in-progress runs whose state is recoverable are automatically resumed from the last successful node.
- The run index (`.bosun/workflow-runs/index.json`) is updated atomically so a crash cannot corrupt it.

**Flow-Level Retry**

- Any workflow can be retried from the UI or Telegram without re-running already-passing nodes.
- Manual retry: click **Retry** on a failed run in the Workflows tab → re-enters the DAG from the first failed node.
- Auto-retry: set `workflow.config.autoRetry = true` and `workflow.config.maxAutoRetries` (default 2). Failed runs are automatically re-queued by the engine.
- Node-level `maxRetries` still applies independently within each run attempt.

**Built-in Node Types**
Triggers: `trigger.manual`, `trigger.task_low`, `trigger.schedule`, `trigger.event`, `trigger.webhook`, `trigger.pr_event`, `trigger.task_assigned`, `trigger.anomaly`, `trigger.scheduled_once`, `trigger.meeting.wake_phrase`
Conditions: `condition.expression`, `condition.task_has_tag`, `condition.file_exists`, `condition.switch`
Actions: `action.run_agent`, `action.run_command`, `action.create_task`, `action.update_task_status`, `action.git_operations`, `action.create_pr`, `action.write_file`, `action.read_file`, `action.set_variable`, `action.delay`, `action.continue_session`, `action.restart_agent`, `action.bosun_cli`, `action.handle_rate_limit`, `action.ask_user`, `action.analyze_errors`, `action.refresh_worktree`, `action.execute_workflow`
Meeting: `meeting.start`, `meeting.send`, `meeting.transcript`, `meeting.vision`, `meeting.finalize`
Validations: `validation.screenshot`, `validation.model_review`, `validation.tests`, `validation.build`, `validation.lint`
Transforms: `transform.json_parse`, `transform.template`, `transform.aggregate`
Notify: `notify.log`, `notify.telegram`, `notify.webhook_out`
Agent: `agent.select_profile`, `agent.run_planner`, `agent.evidence_collect`
Loop: `loop.for_each`

**Subworkflow Chaining Pattern**

Use `action.execute_workflow` when one workflow should hand off to another:

```json
{
  "type": "action.execute_workflow",
  "config": {
    "workflowId": "{{childWorkflowId}}",
    "mode": "sync",
    "inheritContext": true,
    "includeKeys": ["meetingSessionId", "wakePhrase"],
    "input": {
      "sessionTitle": "{{sessionTitle}}",
      "transcript": "{{meeting-transcript.transcript}}"
    },
    "outputVariable": "childWorkflowResult",
    "failOnChildError": false
  }
}
```

Meeting chain example: `meeting.start` -> `meeting.send` -> `meeting.vision` -> `meeting.transcript` -> `trigger.meeting.wake_phrase`/guard (`condition.expression`) -> `action.execute_workflow` -> `meeting.finalize`.

The authoritative list is exposed by `GET /api/workflows/node-types` and registered in `workflow-nodes.mjs`.

**Services And Requirements**

- `notify.telegram` requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
- Kanban actions require a configured kanban adapter and `VK_*` settings.
- `action.run_agent` and `action.continue_session` use the agent pool configured in the UI server.
- `action.run_command` executes on the host running `ui-server.mjs`.
- `action.ask_user` posts a question and stores `_pendingQuestion` in context for UI polling.

**Workflow API Endpoints**

- `GET /api/workflows` list workflows
- `GET /api/workflows/:id` full workflow definition
- `POST /api/workflows/save` create or update a workflow
- `DELETE /api/workflows/:id` delete a workflow
- `POST /api/workflows/:id/execute` run a workflow manually
- `GET /api/workflows/runs` list recent run summaries
- `GET /api/workflows/:id/runs` list run summaries for one workflow
- `GET /api/workflows/node-types` list registered node types
- `GET /api/workflows/templates` list templates
- `POST /api/workflows/install-template` install a template

**Run History Files**

- `index.json` contains a rolling list of recent run summaries.
- `<runId>.json` contains node outputs, logs, and errors for a single run.

**Workflow Migration Guard**
Bosun can migrate legacy modules into workflows with a safety guard.

- Config file: `.bosun/workflow-migration.json`
- Modes: `legacy`, `shadow`, `workflow`
- Implemented in `workflow-migration.mjs`

**Built-in Templates**

Templates are installed via the UI (Workflows → Templates) or `POST /api/workflows/install-template` with `{ "templateId": "<id>" }`.

_GitHub Automation_
| Template | ID | Description |
| --- | --- | --- |
| PR Merge Strategy | `template-pr-merge-strategy` | Validates and merges PRs using configurable strategy (squash/merge/rebase). |
| PR Triage & Labels | `template-pr-triage` | Auto-labels new PRs by type, size, and touched paths. |
| PR Conflict Resolver | `template-pr-conflict-resolver` | Resolves merge conflicts on open PRs. :alert: **Superseded for bosun-managed repos** — use the Bosun PR Watchdog instead. |
| Stale PR Reaper | `template-stale-pr-reaper` | Closes or warns PRs that have been open beyond a stale threshold. |
| **Bosun PR Watchdog** | `template-bosun-pr-watchdog` | **(New)** Scheduled CI poller for bosun-attached PRs. Makes a single `gh` API call per cycle to classify all open bosun PRs, labels CI failures / conflicts with `bosun-needs-fix`, sends merge candidates through a mandatory review gate (checks diff stats to prevent destructive merges), then merges. Never touches external-contributor PRs. Default interval: 5 min. Set `enabled: false` to disable. |

_Agent Automation_
| Template | ID | Description |
| --- | --- | --- |
| Meeting Orchestrator + Subworkflow Chain | `template-meeting-subworkflow-chain` | Advanced meeting/session flow with `meeting.start/send/vision/transcript/finalize`, wake-phrase trigger + transcript guard, and chained child workflow execution via `action.execute_workflow`. |

_Reliability & Ops_
| Template | ID | Description |
| --- | --- | --- |
| Error Recovery | `template-error-recovery` | Triggered on anomaly events; runs an agent to diagnose and attempt auto-fix. |
| Anomaly Watchdog | `template-anomaly-watchdog` | Scheduled monitor; summarises anomalies and pages Telegram. |
| Workspace Hygiene | `template-workspace-hygiene` | Cleans stale branches, expired worktrees, and log files on a schedule. |
| Health Check | `template-health-check` | Periodic build + test ping; alerts on failure. |
| Task Finalization Guard | `template-task-finalization-guard` | Closes tasks that are marked done but whose PRs never merged. |

_Planning & Reporting_
| Template | ID | Description |
| --- | --- | --- |
| Task Planner | `template-task-planner` | Agent-driven task backlog generation from a goal prompt. |
| Task Replenish (Scheduled) | `template-task-replenish` | Keeps the backlog above a minimum count; runs on a cron. |
| Nightly Report | `template-nightly-report` | Generates a markdown agent-work summary and posts to Telegram. |
| Sprint Retrospective | `template-sprint-retro` | End-of-sprint retro: summarises completed tasks, PRs, and blockers. |

_CI/CD_
| Template | ID | Description |
| --- | --- | --- |
| Build & Deploy | `template-build-deploy` | Triggered on PR merge; runs build + deploy pipeline and notifies. |
| Release Pipeline | `template-release-pipeline` | Full semver release: changelog, version bump, tag, and publish. |
| Canary Deploy | `template-canary-deploy` | Deploys to canary environment, runs smoke tests, and promotes or rolls back. |

---

**Troubleshooting**

- No nodes in UI: verify `/api/workflows/:id` returns `workflow.nodes`.
- Runs show `0s`: durations under one second are rounded.
- No Telegram notifications: check `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
- Run stuck after restart: check `.bosun/workflow-runs/index.json` — if a run entry shows `status: "running"` but the server is idle, use the UI Retry button to re-enter from the last known node.
- PR Conflict Resolver not triggering on bosun PRs: this template is deprecated for bosun-managed repos. Install the Bosun PR Watchdog (`template-bosun-pr-watchdog`) instead.
