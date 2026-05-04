# Bosun In-House Adoption Analysis

> Date: 2026-03-31
> Scope: local repos in `virtengine-gh` assessed for direct adoption into Bosun, including copy-and-refactor paths into `.mjs`

## Executive Summary

Bosun already has the beginnings of the right architecture: a SQLite-backed state ledger, a context indexer, shared knowledge primitives, multi-backend kanban support, workflow execution, and a settings-driven UI/server model.

The highest-leverage move is not to bolt on more point features. It is to make Bosun's own runtime state model authoritative and SQL-first, then layer graph knowledge, DAG visualization, subconscious guidance, and stronger project-management projections on top of that substrate.

If we do this well, Bosun becomes:

- the operational source of truth for tasks, runs, claims, sessions, artifacts, and audit records
- a graph-aware repo intelligence system instead of a JSON-log-driven orchestrator
- a multi-surface control plane with first-class IDE, desktop, web, Telegram, and computer-use pathways

## Current Bosun Baseline

Bosun already exposes the foundation needed for this migration:

- `lib/state-ledger-sqlite.mjs` already provides WAL-backed SQLite storage for workflow runs/events and is the correct nucleus for a broader SQL runtime store.
- `workspace/context-indexer.mjs` already builds a local SQLite index of files and symbols under `.bosun/context-index`.
- `workspace/shared-knowledge.mjs` already supports append-only knowledge capture, but its persistent registry is still JSON-based and too lightweight for long-term system memory.
- `kanban/kanban-adapter.mjs` already supports `internal`, `github`, `jira`, and optional `repo-mirror` backends, which means Bosun already understands projection-style task backends.
- `ui/modules/settings-schema.js` already gives us an off-by-default settings plane for new subsystems.
- `bosun/.bosun/library.json` already contains a Linear MCP entry, so Linear is present as a tool capability but not as a first-class Bosun task backend.

## What To Lift From Each Project

| Source | Best thing to steal | Bosun fit |
|---|---|---|
| Linear / Jira / Atlassian | disciplined issue/project workflows, backlog hygiene, roadmap posture, planning UX | external tracker projection and long-term planning mode |
| Chorus-main | task DAGs, session lifecycle, worker observability, proposal approval flow, live role/status dashboards | Bosun workflow graph UI, task/session observability, reviewable planning |
| Devika | planner -> researcher -> coder decomposition | Bosun research and implementation workflow templates, not runtime architecture |
| Cline | IDE-native workflow, command/file approval UX, checkpoints, browser loop, add-context flows | Bosun VS Code plugin, task snapshots, IDE-side execution visibility |
| temm1e-main | finite-context budgeting, blueprint memory, long-running agent posture, browser/CDP pragmatism | Bosun memory tiers, reusable execution recipes, smarter context rebuilds |
| claude-subconscious-main | background "whisper" agent pattern | Bosun subconscious guidance daemon and pre-run briefings |
| UFO | DAG-based multi-device orchestration, capability profiles, computer-use across platforms | Bosun computer-use/device-agent layer and safe orchestration model |
| Corbell-main | codebase graph + embeddings + PRD/spec decomposition backed by SQLite | Bosun knowledge graph and repo intelligence service |
| airweave-main | connector/sync/retrieval layer | Bosun context ingestion and retrieval abstraction |
| agentfs-main | SQL-first auditability, reproducibility, single durable runtime store | Bosun authoritative SQL state model and event/file audit strategy |

## Recommended Architecture Direction

### 1. Make SQL the source of truth

This is the most important shift.

Bosun should stop treating JSON files and comment-derived state as primary records. Logs, transcripts, raw tool payloads, and external issue comments can remain as append-only artifacts, but every record that the UI or runtime depends on should be keyed and queryable in SQLite first.

Target Bosun modules:

- `lib/state-ledger-sqlite.mjs`
- `task/task-store.mjs`
- `task/task-claims.mjs`
- `workspace/execution-journal.mjs`
- `workspace/shared-knowledge.mjs`
- `server/ui-server.mjs`

What to copy in spirit from AgentFS:

- a normalized SQL schema for files/state/tool calls/events
- reproducible snapshots and replay-friendly audit trails
- one durable local store per Bosun root, with explicit projection/export layers

What Bosun should do differently:

- do not replace git worktrees or filesystem writes with a virtual FS
- do not force all file content into SQLite blobs
- do keep SQL authoritative for metadata, identity, claims, task state, artifacts, and UI queries

Concrete result:

- UI reads SQL views, not scattered JSON files
- agent claims, heartbeats, retries, PR links, artifacts, comments, graph nodes, and memory entries are SQL records
- raw log files become referenced evidence, not primary storage

### 2. Build a real knowledge graph for repos and workspaces

Bosun already has `workspace/context-indexer.mjs`, but it is closer to a symbol/file index than a structured knowledge system.

Corbell is the strongest model here. The right direction is to extend Bosun from:

- files
- symbols

into:

- repos
- workspaces
- services/modules
- files
- symbols
- call edges
- task-to-code edges
- PR-to-file edges
- workflow-to-artifact edges
- document/pattern edges
- optional embedding-backed retrieval edges

Target Bosun modules:

- `workspace/context-indexer.mjs`
- `workspace/shared-knowledge.mjs`
- `infra/library-manager.mjs`
- `workflow/project-detection.mjs`
- `workflow/research-evidence-sidecar.mjs`

Direct copy/refactor candidates:

- Corbell's SQLite graph-store shape
- Corbell's method/call graph approach
- Corbell's PRD/spec decomposition flow
- Airweave's connector -> sync -> index -> retrieve pipeline shape

Recommended Bosun implementation:

- new `workspace/knowledge-store.mjs`
- new `workspace/knowledge-graph-builder.mjs`
- new `workspace/knowledge-query.mjs`
- optional `workspace/embedding-store.mjs`

Important constraint:

- graph building must work locally without any LLM dependency
- embeddings should be optional ranking, never the only retrieval path

### 3. Keep external trackers as projections unless explicitly promoted

Jira is already implemented as a kanban backend. Linear is present only through MCP/library discovery today.

The right model for Bosun is:

- Bosun internal SQL task graph = canonical execution truth
- Jira / Linear / GitHub / RepoMirror = projection or synchronization targets

Do not make external SaaS systems the primary runtime database for Bosun internals. That would repeat the same problem in a different place.

Recommended modes:

- `KANBAN_BACKEND=internal` remains default
- `KANBAN_BACKEND=jira` stays supported
- add `KANBAN_BACKEND=linear` only when Bosun can preserve the same shared-state contract it already has for Jira
- support `*_SYNC_MODE=projection|bidirectional`, defaulting to `projection`

Target Bosun modules:

- `kanban/kanban-adapter.mjs`
- `ui/modules/settings-schema.js`
- `setup.mjs`
- `server/ui-server.mjs`

What to adopt from Linear / Jira / Atlassian:

- stricter planning objects: initiatives, projects, cycles, tasks, milestones
- better long-term roadmap and backlog structure
- clearer separation between execution tasks and planning artifacts
- richer issue metadata surfaced in Bosun UI

What not to copy:

- full Atlassian platform sprawl
- external system as Bosun's runtime truth

### 4. Add first-class DAG and session observability from Chorus and UFO

Chorus and UFO are the clearest evidence that Bosun should make task dependency structure and agent presence visible, not implied.

Bosun already has workflows and execution ledgers, but the operator experience is still too flat.

What to adopt:

- task DAG visualization
- worker/session badges on tasks
- real-time active-agent presence
- explicit claim/verify/review states
- dependency-aware planning and execution views
- device/capability-aware assignment for computer-use agents

Target Bosun modules:

- `workflow/workflow-engine.mjs`
- `workflow/execution-ledger.mjs`
- `task/task-executor.mjs`
- `infra/session-tracker.mjs`
- `ui/`
- `server/ui-server.mjs`

Recommended additions:

- `workflow/task-graph-projection.mjs`
- `infra/agent-presence-store.mjs`
- `ui/components/task-graph.*`
- `ui/components/agent-presence.*`

This should be paired with a "gamified" but operationally useful dashboard:

- active agents
- assigned task nodes
- blocked edges
- stale sessions
- retry hotspots
- artifact counts
- PR status cards

### 5. Add a subconscious guidance layer, but keep it advisory

The best idea in `claude-subconscious-main` is not Letta. It is the pattern:

- background observer
- transcript digestion
- repo reading
- proactive guidance injection

Temm1e adds the missing piece: memory must be fidelity-tiered and budget-aware.

Bosun should introduce a background subsystem that:

- watches session transcripts, diffs, failures, and repeated retries
- creates compact guidance records and reusable blueprints
- injects briefings at session start, task claim time, and failure recovery time

Target Bosun modules:

- `workspace/shared-knowledge.mjs`
- `infra/session-tracker.mjs`
- `agent/agent-hooks.mjs`
- `agent/fleet-coordinator.mjs`
- `workflow/research-evidence-sidecar.mjs`

Recommended additions:

- `workspace/subconscious-store.mjs`
- `workspace/blueprint-store.mjs`
- `workspace/briefing-builder.mjs`

Hard rules:

- off by default
- private local storage, not git
- advisory only; never silently mutate task state or prompts in opaque ways
- every whisper/briefing must be attributable and inspectable in the UI

### 6. Introduce memory tiers instead of one flat knowledge bucket

Bosun's current shared knowledge model is too undifferentiated.

Temm1e's strongest transferable idea is not the branding around lambda memory. It is the tiering model:

- full detail while hot
- compressed summary when cooling
- essence/hash/handle when cold
- recall back to full evidence when needed

Bosun should separate:

- execution evidence
- operational lessons
- reusable blueprints
- repo knowledge graph
- transient working context

Recommended SQL tables / logical stores:

- `memory_events`
- `memory_summaries`
- `memory_blueprints`
- `memory_recall_handles`
- `knowledge_nodes`
- `knowledge_edges`

### 7. Build Bosun IDE and computer-use surfaces deliberately

Cline, UFO, and Temm1e all point in the same direction: Bosun should not remain only a Telegram/web control plane.

Two parallel bets make sense:

#### VS Code / IDE Surface

Use Cline as the pattern source for:

- side-panel Bosun task view
- add-file/add-folder/add-problems/add-url context actions
- checkpoint and restore UX
- task history reconstruction
- inline diff and terminal visibility

This should not replace Bosun's server runtime. It should be an IDE client for Bosun.

#### Computer-Use Surface

Use UFO and Temm1e as the pattern source for:

- Windows-first desktop control
- later Linux/Android device agents
- capability profiles per device
- orchestration of computer-use tasks as explicit workflow nodes

Computer-use should be treated as a special execution backend with stronger safety gates.

Target Bosun modules:

- `desktop/`
- `voice/vision-session-state.mjs`
- `agent/agent-custom-tools.mjs`
- `shell/`
- `workflow/workflow-nodes.mjs`

### 8. Use Airweave ideas for ingestion and retrieval, not for full stack replacement

Airweave's useful idea is the retrieval layer pattern:

- connectors
- sync jobs
- normalized entities
- retrieval API
- agent-facing SDK/MCP exposure

Bosun should adopt that shape for:

- Jira
- Linear
- GitHub
- docs/RFCs/ADRs
- local repo graph
- session artifacts
- optional browser captures

But Bosun should not copy:

- the full FastAPI + Temporal + Redis + Vespa stack

Bosun's lightweight version can stay local-first and SQLite-first until scale proves otherwise.

## Copy / Refactor Priority

### Direct copy-and-refactor candidates

These are worth actively porting into `.mjs` designs:

- AgentFS storage schema concepts
- Corbell graph-store and code-graph concepts
- Chorus task/session lifecycle and DAG/operator concepts
- Claude Subconscious background guidance pattern
- Cline checkpoint/history/context UX patterns

### Selective borrowing only

- UFO orchestration model and capability profiles
- Temm1e memory tiering and blueprint concepts
- Airweave connector/retrieval architecture

### Mostly reference, not code

- Devika overall architecture
- Atlassian/Linear homepage-level UX and planning inspiration

## Proposed New Settings

All new subsystems should be opt-in:

```bash
BOSUN_SQL_RUNTIME_ENABLED=true
BOSUN_SQL_UI_SOURCE_OF_TRUTH=true

BOSUN_KNOWLEDGE_GRAPH_ENABLED=false
BOSUN_EMBEDDINGS_ENABLED=false
BOSUN_BLUEPRINT_MEMORY_ENABLED=false
BOSUN_SUBCONSCIOUS_ENABLED=false

BOSUN_LINEAR_ENABLED=false
BOSUN_LINEAR_SYNC_MODE=projection

BOSUN_COMPUTER_USE_ENABLED=false
BOSUN_DEVICE_AGENT_ENABLED=false
```

## Recommended Implementation Order

### Phase 1: SQL consolidation

- extend `lib/state-ledger-sqlite.mjs` into a broader runtime store
- migrate task/session/artifact/audit reads in UI server to SQL-backed views
- demote JSON files to evidence/artifact roles only

### Phase 2: knowledge graph

- extend `workspace/context-indexer.mjs`
- add graph tables, graph builder, and query layer
- link tasks/runs/artifacts to code graph nodes

### Phase 3: tracker projection layer

- keep Jira solid
- add Linear as a proper projection/backend only if required
- build roadmap/project/cycle abstractions above raw issue trackers

### Phase 4: DAG and presence UI

- render task graphs and execution graphs in UI
- add session/worker badges, blocked-state views, and artifact cards

### Phase 5: subconscious + blueprint memory

- background summarization and whisper system
- inspectable briefings and reusable recipes

### Phase 6: IDE + computer-use

- Bosun VS Code extension/client
- Windows-first device agent backend
- computer-use workflow nodes with hard safety gates

## Bottom Line

If we only borrow one thing, it should be AgentFS/Corbell-style SQL-and-graph rigor.

If we borrow two things, add Chorus/UFO-style DAG and agent observability.

If we borrow three things, add Cline/Claude-Subconscious/Temm1e-style IDE memory and subconscious guidance.

That gives Bosun a coherent architecture:

- SQL for truth
- graph for knowledge
- DAG for execution
- projections for Jira/Linear/GitHub
- subconscious memory for guidance
- IDE/computer-use surfaces for control

That is a much stronger direction than continuing to add isolated JSON-based features around the existing runtime.
