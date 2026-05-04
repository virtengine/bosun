# Bosun Internal Agent Harness Adoption Plan Continued

Date: 2026-04-03
Companion to: `bosun/_docs/2026-04-02-bosun-internal-agent-harness-adoption-plan.md`
Scope: turn the adoption plan into 10 large execution waves with explicit file ownership, donor references, language decisions, and implementation prompts that can be handed directly to an engineer or coding agent.

## Implementation Framing

This continuation is intentionally execution-heavy.

The primary rule is:

Bosun must end with one internal agent harness, not multiple partially shared runtimes.

That means:

- TUI, chat engine, workflow engine, web UI, and Telegram must all talk to the same session manager and harness runtime.
- Provider-specific behavior must live behind one provider kernel.
- Tool execution must flow through one orchestrator.
- Observability must be first-class and Bosun-native.
- Rust should be used only for the hot path after the `.mjs` architecture is stable.

The donor repositories are reference inputs only:

- `opencode-dev/opencode-dev`
- `codex-main`
- `openclaude`
- `pi-mono-main`

Bosun is the destination system and final source of truth.

## Two-Agent Queue-Safe Delivery Table For Steps 1 To 5

Use this table when you are pushing five tasks into two separate agent queues and cannot control exact start order. The intended operating model is:

- Agent 1 owns the implementation track.
- Agent 2 owns the audit/consolidation track.
- Both agents can be queued immediately.
- Agent 2's task for each step must be written so it can safely do one of two things:
  - continue with consolidation if Agent 1's artifacts already exist
  - stop after producing an audit gap list, required files/contracts list, and validation checklist if Agent 1's artifacts are not ready yet
- After Steps 1 to 5 are queued this way, use Step 11 and Step 12 as the explicit convergence phases where both agents reconcile and close gaps.

| Step | Agent 1 queue item | Agent 2 queue item | Queue-safe rule |
| --- | --- | --- | --- |
| Step 1: Harness architecture and module boundaries | Implement the canonical harness runtime boundaries, finalize `internal-harness-runtime.mjs` composition, normalize `agent/harness/*`, define runtime/event/config contracts, and demote `primary-agent.mjs` / `agent-pool.mjs` toward facade status. | Audit harness boundary ownership, prepare `module-boundaries.md`, identify any remaining lifecycle ambiguity, draft required tests/contracts, and if Agent 1 artifacts already exist, finish the cleanup and validation. | Agent 2 must not invent alternate architecture. If contracts are missing, it outputs a gap list and boundary checklist only. |
| Step 2: Provider kernel and provider registry | Consolidate `provider-kernel.mjs`, `provider-registry.mjs`, `provider-session.mjs`, and normalize provider-driver contracts across all target providers. | Audit provider ownership, prepare provider-boundary docs/tests, verify shell and surface callers should delegate into the provider kernel, and if Agent 1 artifacts already exist, complete auth/catalog/capability normalization cleanup. | Agent 2 must not add a parallel provider path. If kernel artifacts are incomplete, it outputs a provider-gap matrix and validation checklist only. |
| Step 3: Session, thread, and subagent graph | Make `session-manager.mjs`, `thread-registry.mjs`, `subagent-control.mjs`, and replay semantics authoritative; move lifecycle ownership out of `primary-agent.mjs` / `agent-pool.mjs`. | Audit lifecycle ownership, prepare session/thread/subagent boundary docs/tests, verify replay/resume/lineage expectations, and if Agent 1 artifacts already exist, complete snapshot/lineage/replay tightening. | Agent 2 must not create a second lifecycle model. If canonical session artifacts are incomplete, it outputs a lifecycle-gap report and lineage contract checklist only. |
| Step 4: Tool orchestrator and permission system | Consolidate `tool-orchestrator.mjs`, `tool-registry.mjs`, `tool-approval-manager.mjs`, and centralize approval, retry, network, sandbox, and truncation policy. | Audit tool-policy ownership, prepare tool-boundary docs/tests, verify workflow and surfaces are not bypassing the orchestrator, and if Agent 1 artifacts already exist, finish retry/ledger/approval integration cleanup. | Agent 2 must not preserve workflow-local or surface-local policy as authoritative. If orchestrator artifacts are incomplete, it outputs a tool-policy gap report and verification checklist only. |
| Step 5: Observability spine and durable projections | Lock the canonical event schema, align telemetry/ledger/event-bus persistence, and define the projection/replay model. | Audit observability ownership, prepare event/projection boundary docs/tests, verify replay and live-view requirements, and if Agent 1 artifacts already exist, finish projection/replay/metrics cleanup. | Agent 2 must not introduce competing event schemas. If canonical event artifacts are incomplete, it outputs an observability-gap report and projection checklist only. |

## Step 1: Lock The Canonical Harness Architecture And Module Boundaries

**What this step must accomplish**

Define and lock the canonical Bosun harness architecture before more code is migrated. This step is about making runtime boundaries explicit and enforced so later work does not continue to leak logic across `primary-agent.mjs`, `agent-pool.mjs`, `shell/*`, workflow internals, server endpoints, and UI adapters. This is not greenfield work anymore. Bosun already has partial harness, provider, session, and tool modules. The required outcome is to consolidate those partial seams into one clearly owned architecture and stop treating the older monoliths as acceptable places for new logic.

**Primary Bosun files to create or rewrite**

- Keep and expand:
  - `bosun/agent/internal-harness-runtime.mjs`
  - `bosun/agent/internal-harness-control-plane.mjs`
  - `bosun/agent/internal-harness-profile.mjs`
  - `bosun/agent/provider-kernel.mjs`
- Keep, complete, and normalize:
  - `bosun/agent/harness/agent-loop.mjs`
  - `bosun/agent/harness/turn-runner.mjs`
  - `bosun/agent/harness/tool-runner.mjs`
  - `bosun/agent/harness/steering-queue.mjs`
  - `bosun/agent/harness/followup-queue.mjs`
  - `bosun/agent/harness/session-state.mjs`
  - `bosun/agent/harness/message-normalizer.mjs`
  - `bosun/agent/session-manager.mjs`
  - `bosun/agent/thread-registry.mjs`
- Create if missing:
  - `bosun/agent/harness/run-contract.mjs`
  - `bosun/agent/harness/event-contract.mjs`
  - `bosun/agent/harness/runtime-config.mjs`
  - `bosun/agent/harness/module-boundaries.md`
- Convert into compatibility entrypoints only:
  - `bosun/agent/primary-agent.mjs`
  - `bosun/agent/agent-pool.mjs`

**Architecture boundaries that must be locked in this step**

- `internal-harness-runtime.mjs`:
  - composition root for harness execution
  - constructs runtime config, session manager, provider kernel, and tool orchestrator dependencies
  - owns no provider-specific branching beyond delegating into provider interfaces
- `internal-harness-control-plane.mjs`:
  - owns run metadata, lineage IDs, state transitions, and durable control-plane coordination
  - does not own UI or workflow-specific branching
- `internal-harness-profile.mjs`:
  - compiles Bosun settings, provider defaults, tool policy defaults, and feature flags into a stable runtime profile
  - must be the only place where high-level harness profiles are interpreted
- `provider-kernel.mjs`:
  - exposes the normalized provider interface only
  - must not absorb workflow, TUI, Telegram, or tool-policy concerns
- `session-manager.mjs` and `thread-registry.mjs`:
  - own session lifecycle and thread lineage
  - must not be bypassed by surfaces or workflow nodes
- `harness/agent-loop.mjs` and `harness/turn-runner.mjs`:
  - own per-turn orchestration semantics
  - must not become a second control plane
- `primary-agent.mjs` and `agent-pool.mjs`:
  - remain temporary facades and compatibility layers only
  - no new long-term orchestration logic may be added here

**Best donor references**

- `pi-mono-main/packages/agent/src/agent-loop.ts`
- `pi-mono-main/packages/agent/src/agent.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/session/processor.ts`
- `openclaude/src/utils/task/framework.ts`

**Language decision**

- Implement all orchestration and contracts in `.mjs`.
- Do not introduce Rust in this step.
- Prefer small, composable modules over another large coordinating file.
- Treat this step as an architecture freeze for boundaries, not as a feature-expansion step.

**Implementation prompt**

Consolidate and finish the canonical Bosun harness skeleton and make it the only architectural direction for the rest of the project. Start by auditing the existing harness-adjacent modules under `bosun/agent/` and `bosun/agent/harness/` and explicitly assign ownership for run contracts, session state, event contracts, runtime configuration, turn orchestration, steering, follow-up handling, and thread lineage. Do not treat the existing partial files as proof that the architecture is already settled. Tighten the seams until there is one obvious place for each responsibility. `internal-harness-runtime.mjs` must become the composition root for harness execution. `internal-harness-control-plane.mjs` must own lifecycle metadata and control-plane transitions. `internal-harness-profile.mjs` must produce the stable runtime profile consumed by the harness. `provider-kernel.mjs` must remain a normalized dependency of the runtime instead of a surface-owned concern. `session-manager.mjs` and `thread-registry.mjs` must own all session and lineage semantics. `agent-loop.mjs`, `turn-runner.mjs`, `tool-runner.mjs`, `steering-queue.mjs`, and `followup-queue.mjs` must become the canonical per-turn execution machinery.

While doing this, aggressively remove ambiguity from `primary-agent.mjs` and `agent-pool.mjs`. They may continue to exist during migration, but only as compatibility entrypoints that delegate into the canonical harness. No new business logic, session lifecycle logic, provider branching, or orchestration policy should be added to them. If necessary, introduce explicit guard comments and thin forwarding functions so future work cannot easily regress into the old structure.

Define a stable harness run contract that supports initial prompt, continue, retry, steer, follow-up, abort, and resume. Define a stable session-state contract that every later subsystem can consume. Define a stable internal event vocabulary that later powers workflow execution, TUI rendering, Telegram actions, server APIs, provider telemetry, approval flows, and subagent control. Add a lightweight architecture note in `bosun/agent/harness/module-boundaries.md` that states which modules are allowed to depend on which contracts and which modules are prohibited from owning lifecycle logic. Preserve current external behavior while making the internal architecture materially stricter. This step is complete only when Bosun has one clean harness spine that later steps can extend without re-opening the architecture question.

**Required sub-deliverables**

- A written run contract with explicit lifecycle verbs and required metadata fields.
- A written event contract with required event names, ID relationships, and minimal payload shape.
- A runtime-config contract that clearly separates:
  - profile-derived defaults
  - provider selection inputs
  - tool policy inputs
  - surface/channel metadata
- A boundary note that states:
  - which modules are permanent core
  - which modules are transitional adapters
  - which modules are forbidden from owning orchestration logic

**Non-goals**

- Do not add new provider implementations here.
- Do not add Rust services here.
- Do not redesign workflows or surface APIs here beyond wiring them toward the harness boundary.
- Do not let this step collapse into broad feature work that leaves architecture ambiguity untouched.

**Validation**

- Add or update focused tests that prove the run contract supports initial prompt, continue, retry, steer, follow-up, abort, and resume.
- Add focused tests that prove `primary-agent.mjs` and `agent-pool.mjs` delegate into the harness instead of owning unique lifecycle behavior.
- Verify the internal event contract is emitted consistently enough for later telemetry and surface projection work.

**Done when**

- The harness runtime has an explicit run contract and session-state contract.
- `internal-harness-runtime.mjs` is the canonical entrypoint for new harness flows.
- `primary-agent.mjs` and `agent-pool.mjs` are no longer treated as the permanent architecture.
- The internal event schema is defined and stable enough for downstream consumers.
- The module-boundary document exists and matches the actual dependency direction in code.
- There is one obvious owner for runtime config, lifecycle control, session state, per-turn execution, and lineage.

## Step 2: Build The Provider Kernel And Central Provider Registry

**What this step must accomplish**

Create and lock one Bosun provider kernel that supports subscription-backed, API-backed, Azure-hosted, local, and OpenAI-compatible providers through one normalized contract. This is not a greenfield provider step anymore. Bosun already contains a provider kernel, registry, auth manager, capability/catalog modules, and concrete provider drivers. The required outcome is to consolidate those pieces into one authoritative provider architecture, remove ambiguity in ownership, and prevent surfaces, workflow code, and shell adapters from continuing to accumulate provider-specific behavior.

**Primary Bosun files to create or rewrite**

- Keep and expand:
  - `bosun/agent/provider-kernel.mjs`
  - `bosun/agent/provider-registry.mjs`
  - `bosun/agent/provider-session.mjs`
- Keep, complete, and normalize:
  - `bosun/agent/provider-capabilities.mjs`
  - `bosun/agent/provider-message-transform.mjs`
  - `bosun/agent/provider-model-catalog.mjs`
  - `bosun/agent/provider-auth-manager.mjs`
  - `bosun/agent/providers/openai-responses.mjs`
  - `bosun/agent/providers/openai-codex-subscription.mjs`
  - `bosun/agent/providers/azure-openai-responses.mjs`
  - `bosun/agent/providers/anthropic-messages.mjs`
  - `bosun/agent/providers/claude-subscription-shim.mjs`
  - `bosun/agent/providers/openai-compatible.mjs`
  - `bosun/agent/providers/ollama.mjs`
  - `bosun/agent/providers/copilot-oauth.mjs`
- Create if missing:
  - `bosun/agent/providers/index.mjs`
  - `bosun/agent/providers/provider-contract.mjs`
  - `bosun/agent/providers/provider-errors.mjs`
  - `bosun/agent/providers/provider-usage-normalizer.mjs`
  - `bosun/agent/providers/provider-stream-normalizer.mjs`
- Prepare to demote:
  - `bosun/shell/codex-shell.mjs`
  - `bosun/shell/claude-shell.mjs`
  - `bosun/shell/opencode-shell.mjs`
  - `bosun/shell/copilot-shell.mjs`
  - `bosun/shell/gemini-shell.mjs`
  - `bosun/shell/opencode-providers.mjs`

**Provider boundaries that must be locked in this step**

- `provider-kernel.mjs`:
  - canonical entrypoint for resolving and running providers
  - owns provider selection, runtime resolution, and normalized session creation
  - must not contain UI-route logic, workflow logic, or tool-policy logic
- `provider-registry.mjs`:
  - authoritative inventory of provider definitions
  - owns selection rules, default-provider resolution, enablement filtering, and capability lookup
  - must not become a transport or auth implementation file
- `provider-session.mjs`:
  - owns the normalized runtime session contract used by the harness
  - must hide provider-specific stream and message quirks behind one interface
- `provider-auth-manager.mjs`:
  - owns provider auth health, credential presence, auth-mode resolution, and validation status
  - must be the only place where provider auth health is interpreted centrally
- `provider-model-catalog.mjs` and `provider-capabilities.mjs`:
  - own normalized model metadata and capability flags
  - must become the shared source for provider/model discovery used by all surfaces
- `provider-message-transform.mjs` plus any stream/usage normalizers:
  - own message, tool-call, stream-event, and usage normalization
  - must prevent transformation logic from leaking into surfaces or shell adapters
- `bosun/agent/providers/*`:
  - own provider-specific quirks only
  - must not own Bosun session semantics, workflow semantics, approval semantics, or surface behavior
- `shell/*` provider adapters:
  - may remain during migration, but only as compatibility callers into the provider kernel
  - no new provider semantics may be added there

**Best donor references**

- `pi-mono-main/packages/ai/src/api-registry.ts`
- `pi-mono-main/packages/ai/src/providers/register-builtins.ts`
- `pi-mono-main/packages/ai/src/providers/openai-codex-responses.ts`
- `pi-mono-main/packages/ai/src/providers/azure-openai-responses.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/provider/provider.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/provider/transform.ts`
- `openclaude/src/services/api/openaiShim.ts`
- `openclaude/src/services/api/providerConfig.js`

**Language decision**

- Provider registry, transforms, auth health, and session normalization stay in `.mjs`.
- No Rust here.
- Keep provider drivers small and declarative where possible.
- Normalize contracts first, then simplify or demote old entrypoints.

**Implementation prompt**

Consolidate and harden Bosun’s provider layer until there is one clearly authoritative provider architecture. Start by auditing the existing kernel, registry, auth, capability, model-catalog, and provider-driver modules and explicitly defining which file owns selection, session construction, auth health, model discovery, capability discovery, message transformation, stream normalization, and usage normalization. Do not assume the current split is already correct just because the files exist. Tighten the seams so there is one obvious place for each concern and no surface, workflow node, or shell adapter needs to understand provider-specific behavior.

`provider-kernel.mjs` must become the only supported path for model interaction. It should resolve providers from the registry, construct normalized provider sessions, and hide provider-specific quirks behind one Bosun contract. `provider-registry.mjs` must become the authoritative source for provider inventory, enablement, default resolution, and selection. `provider-session.mjs` must define the normalized session behavior the harness consumes. `provider-auth-manager.mjs` must own credential and auth-health interpretation. `provider-model-catalog.mjs` and `provider-capabilities.mjs` must expose one shared model and capability surface for TUI, web UI, workflow, and Telegram. `provider-message-transform.mjs` and any related stream/usage normalizers must normalize prompt submission, stream events, tool-call envelopes, usage accounting, and provider errors into one Bosun-native format.

Support ChatGPT subscription-backed Codex flows, OpenAI API, Azure OpenAI Responses, Claude subscription-backed flows, Anthropic API, Ollama, generic OpenAI-compatible local endpoints, and Copilot-style OAuth-backed models. Provider quirks must stay inside `bosun/agent/providers/*`. Shell adapters and UI routes must stop interpreting provider details directly. Reuse the strong registry and built-in-provider shape from `pi-mono-main`, the provider discovery and transform ideas from `opencode`, and the practical shim patterns from `openclaude`, but keep the final implementation Bosun-native. This step is complete only when Bosun has one provider kernel that can grow without turning the codebase back into a collection of shell-owned provider runtimes.

**Required sub-deliverables**

- A written provider contract that defines:
  - provider definition shape
  - normalized session shape
  - normalized message/input shape
  - normalized stream-event shape
  - normalized tool-call envelope
  - normalized usage/cost metadata
  - normalized auth-health metadata
- A registry contract that defines:
  - default-provider resolution
  - provider enablement rules
  - model selection behavior
  - capability lookup behavior
- A provider-boundary note that states:
  - which code may depend on provider-specific modules
  - which code must consume only normalized provider contracts
  - which legacy shell paths are transitional only

**Non-goals**

- Do not redesign session lifecycle ownership here beyond consuming the harness contracts from Step 1.
- Do not add tool-policy logic to provider modules.
- Do not move provider execution into Rust.
- Do not let shell adapters remain a second provider architecture.

**Validation**

- Add or update focused tests proving every supported provider resolves through one registry path.
- Add focused tests proving stream events, usage metadata, auth state, and capability metadata are normalized consistently across providers.
- Add focused tests proving shell adapters and surface callers delegate into the provider kernel instead of implementing their own provider logic.
- Verify Bosun can enumerate enabled providers, default provider, auth health, and model catalogs from one API-ready contract.

**Done when**

- Every provider is registered through one registry.
- Streaming, usage, auth, and model capabilities are normalized.
- Direct provider logic is removed from non-provider modules.
- Bosun has a clean path to support subscription, API, Azure, and local providers in one system.
- The provider-boundary contract exists and matches actual code ownership.
- Shell adapters are clearly transitional and no longer treated as authoritative provider runtimes.

## Step 3: Replace Primary-Agent Ownership With A Real Session, Thread, And Subagent Graph

**What this step must accomplish**

Move lifecycle ownership out of `primary-agent.mjs` and `agent-pool.mjs` and into a real Bosun session and thread control plane with durable lineage, replay, and subagent support. This is not a blank-slate implementation step anymore. Bosun already has `session-manager.mjs`, `thread-registry.mjs`, `subagent-control.mjs`, and `session-replay.mjs` level seams. The required outcome is to make those modules authoritative, close remaining ownership gaps, and stop allowing older runtime files to co-own lifecycle behavior.

**Primary Bosun files to create or rewrite**

- Keep and expand:
  - `bosun/agent/session-manager.mjs`
  - `bosun/agent/provider-session.mjs`
  - `bosun/agent/internal-harness-control-plane.mjs`
- Keep, complete, and normalize:
  - `bosun/agent/thread-registry.mjs`
  - `bosun/agent/subagent-control.mjs`
  - `bosun/agent/session-replay.mjs`
  - `bosun/agent/primary-agent.mjs`
  - `bosun/agent/agent-pool.mjs`
- Create if missing:
  - `bosun/agent/session-snapshot-store.mjs`
  - `bosun/agent/lineage-graph.mjs`
  - `bosun/agent/session-contract.mjs`
  - `bosun/agent/thread-contract.mjs`
  - `bosun/agent/subagent-contract.mjs`
  - `bosun/agent/session-boundaries.md`

**Session and thread boundaries that must be locked in this step**

- `session-manager.mjs`:
  - authoritative owner of session creation, continuation, retry, steer, resume, cancel, completion, and replay attachment
  - must be the only high-level lifecycle entrypoint used by surfaces and workflow code
- `thread-registry.mjs`:
  - authoritative owner of thread identity, parent-child relationships, root lineage, thread status, and child-thread attachment
  - must not be bypassed by ad hoc thread IDs in other modules
- `subagent-control.mjs`:
  - authoritative owner of subagent spawn records, parent-child linkage, wait semantics, completion propagation, and spawn-state inspection
  - must not become a second session manager
- `session-replay.mjs` and `session-snapshot-store.mjs`:
  - own replay cursors, resumable state, and session snapshots needed for resumption and forensics
  - must not turn replay into a surface-specific feature
- `lineage-graph.mjs`:
  - authoritative query layer for root session, descendants, siblings, spawned subagents, and workflow-linked session trees
  - should be optimized for inspection and projection, not for owning runtime mutation
- `primary-agent.mjs`:
  - transitional facade only
  - may route requests into the session manager, but must not own lifecycle state machines, lineage rules, or replay semantics
- `agent-pool.mjs`:
  - transitional execution launcher and compatibility adapter only
  - must not own the long-term session model, thread graph, or orchestration rules

**Best donor references**

- `codex-main/codex-rs/core/src/agent/control.rs`
- `codex-main/codex-rs/core/src/thread_manager.rs`
- `codex-main/codex-rs/core/src/state/session.rs`
- `openclaude/src/utils/swarm/inProcessRunner.ts`
- `pi-mono-main/packages/coding-agent/src/core/agent-session.ts`

**Language decision**

- Thread and session control stays in `.mjs`.
- Keep persistence simple and Bosun-native.
- No Rust here.
- Prefer durable Bosun IDs and explicit lineage metadata over hidden in-memory coupling.
- Keep mutation ownership narrow so later observability work has one lifecycle source of truth.

**Implementation prompt**

Consolidate and harden Bosun’s session, thread, and subagent control plane until there is one clearly authoritative lifecycle architecture. Start by auditing `session-manager.mjs`, `thread-registry.mjs`, `subagent-control.mjs`, `session-replay.mjs`, `primary-agent.mjs`, and `agent-pool.mjs`. Explicitly define which file owns session creation, session transitions, retry attachment, replay cursors, resumption state, thread identity, child-thread linkage, subagent spawn state, and lifecycle completion. Do not assume the current file split is already correct because the modules exist. Tighten the seams so there is one obvious owner for each lifecycle concern and so later workflow, TUI, Telegram, and server work can use one shared object model.

`session-manager.mjs` must become the single lifecycle entrypoint for creating and controlling sessions. `thread-registry.mjs` must become the authoritative source of thread IDs, root lineage, parent-child relationships, and thread status. `subagent-control.mjs` must handle spawn records, wait semantics, completion propagation, and parent-child joins without creating an alternate lifecycle system. `session-replay.mjs` plus `session-snapshot-store.mjs` must handle replay and resumable state cleanly enough that replay is a property of the control plane, not a one-off feature added by surfaces. `lineage-graph.mjs` must expose queryable lineage views for operators and later telemetry/projector layers. `primary-agent.mjs` and `agent-pool.mjs` may remain temporarily, but only as forwarding layers into the canonical session manager and execution machinery. No new long-term orchestration, retry semantics, or lineage rules may remain in them.

Introduce durable Bosun session IDs, thread IDs, root session/thread IDs, parent-child relationships, lineage depth, replay cursors, and subagent spawn records so workflows, chat, TUI, Telegram, and future channels all operate on the same lifecycle model. Parent sessions must be able to spawn subagents, wait on them, inspect their current state, consume their outputs, and record lineage in the ledger without surface-specific logic. Use Codex-style thread control and `pi-mono` session structuring as donor patterns, but keep the final design Bosun-native and compatible with Bosun’s existing runtime and persistence model. This step is complete only when Bosun can support autonomous parallelism and replayable execution without falling back to a fragmented pool-owned runtime.

**Required sub-deliverables**

- A written session contract that defines:
  - required session identifiers
  - lifecycle states and valid transitions
  - replay/resume metadata
  - relationship to provider sessions and runtime turns
- A written thread contract that defines:
  - thread ID creation rules
  - root lineage rules
  - parent-child attachment rules
  - status semantics
- A written subagent contract that defines:
  - spawn record shape
  - parent/child linkage
  - completion and failure propagation
  - wait and inspection semantics
- A session-boundary note that states:
  - which modules may mutate lifecycle state
  - which modules may only query lifecycle state
  - which legacy files are transitional facades only

**Non-goals**

- Do not add provider-specific behavior here.
- Do not add tool-policy behavior here.
- Do not move lifecycle control into Rust.
- Do not let replay/resume remain a UI-only or workflow-only capability.

**Validation**

- Add or update focused tests that prove all lifecycle transitions route through `session-manager.mjs`.
- Add focused tests that prove thread and subagent lineage are durable and queryable across parent-child relationships.
- Add focused tests that prove `primary-agent.mjs` is a facade and `agent-pool.mjs` no longer owns unique lifecycle semantics.
- Add focused tests that prove replay and resume work from canonical session state instead of ad hoc surface-local state.

**Done when**

- A dedicated session manager owns lifecycle transitions.
- Threads, subagents, lineage, and replay exist as first-class Bosun concepts.
- `primary-agent.mjs` is a facade, not a lifecycle monolith.
- `agent-pool.mjs` no longer owns the long-term session model.
- The session and thread boundary contracts exist and match actual code ownership.
- There is one authoritative path for spawning, replaying, resuming, and inspecting Bosun sessions and subagents.

## Step 4: Build The Unified Tool Orchestrator And Permission System

**What this step must accomplish**

Centralize and lock tool execution, permission checks, approval routing, retries, truncation, and sandbox/network policy in one authoritative Bosun tool layer. This is not a greenfield step anymore. Bosun already has `tool-orchestrator.mjs`, `tool-registry.mjs`, `tool-approval-manager.mjs`, `tool-network-policy.mjs`, `tool-runtime-context.mjs`, and `tool-output-truncation.mjs`, plus a workflow approval queue. The required outcome is to make these modules the only legitimate policy path for tool use and to eliminate ad hoc approval, retry, sandbox, and truncation decisions outside that layer.

**Primary Bosun files to create or rewrite**

- Keep, complete, and normalize:
  - `bosun/agent/tool-orchestrator.mjs`
  - `bosun/agent/tool-registry.mjs`
  - `bosun/agent/tool-approval-manager.mjs`
  - `bosun/agent/tool-runtime-context.mjs`
  - `bosun/agent/tool-network-policy.mjs`
  - `bosun/agent/tool-output-truncation.mjs`
  - `bosun/workflow/approval-queue.mjs`
- Create if missing:
  - `bosun/agent/tool-retry-policy.mjs`
  - `bosun/agent/tool-execution-ledger.mjs`
  - `bosun/agent/tool-contract.mjs`
  - `bosun/agent/tool-policy-boundaries.md`
  - `bosun/agent/tool-event-contract.mjs`
- Integrate with:
  - `bosun/agent/internal-harness-runtime.mjs`
  - `bosun/workflow/approval-queue.mjs`
  - `bosun/server/ui-server.mjs`
  - `bosun/agent/agent-event-bus.mjs`

**Tool and permission boundaries that must be locked in this step**

- `tool-orchestrator.mjs`:
  - canonical entrypoint for all tool execution
  - owns tool lookup, execution routing, lifecycle emission, retry coordination, and final result assembly
  - must be the only place where Bosun decides how a tool run actually executes
- `tool-registry.mjs`:
  - authoritative inventory of available tools and their metadata
  - owns discovery, lookup, capability metadata, and registration shape
  - must not become a policy or transport file
- `tool-approval-manager.mjs`:
  - authoritative owner of approval evaluation, approval request creation, approval lookup, and approval resolution integration
  - must be the only central interpreter of approval state
- `tool-network-policy.mjs`:
  - authoritative owner of network-access policy and network-risk evaluation
  - must not be re-implemented in workflow nodes or surfaces
- `tool-output-truncation.mjs`:
  - authoritative owner of truncation policy and truncation metadata
  - must prevent providers and surfaces from inventing incompatible output clipping behavior
- `tool-retry-policy.mjs`:
  - authoritative owner of retry rules, retry attempt accounting, and backoff semantics
  - must prevent retry logic from leaking into providers, surfaces, or workflows
- `tool-runtime-context.mjs`:
  - authoritative owner of runtime execution envelopes and execution metadata
  - must define how tool runs attach to session IDs, thread IDs, turn IDs, approvals, and provider turns
- `workflow/approval-queue.mjs`:
  - durable approval persistence and shared approval lookup layer
  - must remain integrated with the tool approval manager, not a second approval policy engine
- surfaces, workflow nodes, and provider modules:
  - may request tool execution only through the orchestrator
  - may not implement bespoke approval, retry, network, or truncation policies

**Best donor references**

- `codex-main/codex-rs/core/src/tools/orchestrator.rs`
- `codex-main/codex-rs/core/src/tools/registry.rs`
- `codex-main/codex-rs/core/src/tools/router.rs`
- `codex-main/codex-rs/core/src/tools/parallel.rs`
- `codex-main/codex-rs/core/src/tools/handlers/unified_exec.rs`
- `opencode-dev/opencode-dev/packages/opencode/src/tool/registry.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/tool/task.ts`
- `openclaude/src/utils/permissions/permissions.ts`

**Language decision**

- Policy, approval, and orchestration logic in `.mjs`.
- Reserve Rust for the execution hot path in a later step.
- Keep policy ownership narrow and explicit.
- Treat this step as a tool-control-plane hardening step, not as a generic feature sweep.

**Implementation prompt**

Consolidate and harden Bosun’s tool layer until there is one authoritative tool control plane. Start by auditing `tool-orchestrator.mjs`, `tool-registry.mjs`, `tool-approval-manager.mjs`, `tool-network-policy.mjs`, `tool-runtime-context.mjs`, `tool-output-truncation.mjs`, existing retry behavior, and `workflow/approval-queue.mjs`. Explicitly define which file owns tool registration, execution envelopes, approval evaluation, approval persistence integration, sandbox decisions, network restrictions, retry policy, truncation policy, and structured execution events. Do not assume the current split is already correct because the modules exist. Tighten the seams so later workflow, TUI, Telegram, and server work consume one tool layer rather than reinterpreting policy in multiple places.

`tool-orchestrator.mjs` must become the sole gateway for tool use across chat, workflow, TUI, and Telegram. `tool-registry.mjs` must be the authoritative source of tool definitions and metadata. `tool-approval-manager.mjs` must own approval creation, lookup, and resolution coordination against the approval queue. `tool-network-policy.mjs`, `tool-retry-policy.mjs`, and `tool-output-truncation.mjs` must own their respective policy domains centrally and prevent policy drift across other modules. `tool-runtime-context.mjs` must define the execution envelope that ties every tool run to session IDs, thread IDs, run IDs, turn IDs, approval IDs, and provider turns. `tool-execution-ledger.mjs` plus `agent-event-bus.mjs` must provide enough structured telemetry that tool runs are fully observable and queryable.

No provider adapter, workflow node, UI route, Telegram path, or surface adapter should make ad hoc approval or retry decisions after this step. Model the tool control plane after Codex’s orchestration discipline, but keep the registry, contracts, and policy modules Bosun-friendly and `.mjs`-native. Approval objects must be visible and resolvable from every surface through one shared state model. Tool executions must emit structured events rich enough to support observability, replay, approval inspection, and operational debugging. This step is complete only when Bosun has one tool layer that every surface trusts and no major execution path bypasses it.

**Required sub-deliverables**

- A written tool contract that defines:
  - tool definition shape
  - execution request shape
  - execution result shape
  - approval metadata fields
  - retry metadata fields
  - truncation metadata fields
  - network/sandbox policy metadata
- A written tool-event contract that defines:
  - start, update, retry, approval, completion, failure, and truncation event types
  - required session/thread/turn/provider references
  - required timestamps and attempt numbers
- A tool-policy boundary note that states:
  - which modules may decide approval policy
  - which modules may decide retry policy
  - which modules may decide truncation policy
  - which callers are forbidden from bypassing the orchestrator

**Non-goals**

- Do not leave provider-specific tool policy in provider drivers.
- Do not let workflow nodes keep custom approval logic once the orchestrator path exists.
- Do not move tool policy logic into Rust in this step.
- Do not allow surface-specific truncation or retry behavior to remain authoritative.

**Validation**

- Add or update focused tests that prove all tool execution routes through `tool-orchestrator.mjs`.
- Add focused tests that prove approval, retry, network, and truncation policies are applied centrally and consistently.
- Add focused tests that prove `workflow/approval-queue.mjs` is used as shared approval state, not as a second policy engine.
- Add focused tests that prove tool events contain the session, thread, approval, and attempt metadata needed for later replay and observability work.

**Done when**

- All tool execution flows through one orchestrator.
- Permission, sandbox, retry, and approval logic are centralized.
- Tool events are emitted consistently and tied to session/thread lineage.
- Workflow and surface code stop bypassing tool policy.
- The tool-policy boundary contract exists and matches actual code ownership.
- There is one authoritative approval and execution path for Bosun tools across every major surface.

## Step 5: Build The Observability Spine And Durable State Projections

**What this step must accomplish**

Make Bosun’s harness fully observable end to end with one canonical event model, one ledger strategy, and one projection system for live and historical views. This is not a greenfield telemetry step anymore. Bosun already has `session-telemetry.mjs`, `live-event-projector.mjs`, `provider-usage-ledger.mjs`, `runtime-metrics.mjs`, `trace-export.mjs`, `workflow/execution-ledger.mjs`, and the SQLite-backed state ledger. The required outcome is to make these pieces operate as one coherent observability spine instead of a collection of useful but only partially unified telemetry surfaces.

**Primary Bosun files to create or rewrite**

- Keep and expand:
  - `bosun/infra/session-telemetry.mjs`
  - `bosun/lib/state-ledger-sqlite.mjs`
  - `bosun/workflow/execution-ledger.mjs`
  - `bosun/agent/agent-event-bus.mjs`
- Keep, complete, and normalize:
  - `bosun/infra/live-event-projector.mjs`
  - `bosun/infra/runtime-metrics.mjs`
  - `bosun/infra/provider-usage-ledger.mjs`
  - `bosun/infra/trace-export.mjs`
- Create if missing:
  - `bosun/infra/session-projection-store.mjs`
  - `bosun/infra/approval-projection-store.mjs`
  - `bosun/infra/subagent-projection-store.mjs`
  - `bosun/infra/replay-reader.mjs`
  - `bosun/infra/event-schema.mjs`
  - `bosun/infra/event-boundaries.md`
  - `bosun/infra/projection-contract.mjs`

**Observability boundaries that must be locked in this step**

- `agent-event-bus.mjs`:
  - canonical real-time ingress and fan-out layer for harness events
  - must not become the only persistence mechanism
  - must emit events conforming to the canonical event schema
- `session-telemetry.mjs`:
  - authoritative coordinator for normalized telemetry ingestion, in-memory summaries, live projector integration, metrics updates, and trace export hooks
  - must not drift into a second event schema
- `workflow/execution-ledger.mjs`:
  - authoritative durable run/event ledger for workflow-linked and harness-linked execution records
  - must align its identifiers and event references with the canonical event schema
- `lib/state-ledger-sqlite.mjs`:
  - durable state and query substrate for ledgers and projections
  - must remain the Bosun-native persistence foundation, not a dumping ground for disconnected telemetry shapes
- `live-event-projector.mjs`:
  - canonical projector for live derived state used by UI/TUI/session inspectors
  - must derive from canonical events rather than inventing a second live-only state model
- `session-projection-store.mjs`, `approval-projection-store.mjs`, `subagent-projection-store.mjs`:
  - authoritative derived-state stores for high-read operational views
  - must be projections of canonical events, not primary mutation owners
- `replay-reader.mjs`:
  - authoritative reader for historical event streams, run ledgers, and replay views
  - must reconstruct history from the same source-of-truth events used by live views
- `trace-export.mjs`, `runtime-metrics.mjs`, and `provider-usage-ledger.mjs`:
  - consumers of canonical events and normalized usage metadata
  - must not require bespoke emitter formats from producers

**Best donor references**

- `codex-main/codex-rs/otel/src/events/session_telemetry.rs`
- `codex-main/codex-rs/exec/src/event_processor_with_jsonl_output.rs`
- `codex-main/codex-rs/core/src/memory_trace.rs`
- `openclaude/src/utils/telemetry/sessionTracing.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/server/event.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/session/projectors.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/sync/index.ts`

**Language decision**

- Schema, projections, and ledger coordination in `.mjs`.
- State store can stay SQLite-backed through existing Bosun primitives.
- Rust buffering comes later.
- Prefer one canonical schema with multiple projections over multiple near-duplicate event streams.
- Keep ephemeral noisy data private and projection-friendly.

**Implementation prompt**

Consolidate and harden Bosun’s observability stack until there is one coherent runtime spine for the internal harness. Start by auditing `agent-event-bus.mjs`, `session-telemetry.mjs`, `live-event-projector.mjs`, `provider-usage-ledger.mjs`, `runtime-metrics.mjs`, `trace-export.mjs`, `workflow/execution-ledger.mjs`, and `lib/state-ledger-sqlite.mjs`. Explicitly define which file owns event-schema normalization, event ingestion, live projection, durable persistence, replay reading, metrics extraction, provider usage accounting, and trace export. Do not assume the current split is already coherent because the modules exist. Tighten the seams so live UI views, TUI dashboards, workflow forensics, replay, usage reports, and operational metrics all consume the same canonical events.

Define a canonical event schema that covers session lifecycle, provider requests and stream chunks, tool executions, approvals, retries, truncation, file mutations, workflow node activity, subagent spawns, subagent completions, Telegram actions, UI interactions, and system health transitions. `agent-event-bus.mjs` must emit and fan out canonical events. `session-telemetry.mjs` must coordinate normalized ingestion and telemetry summarization. `workflow/execution-ledger.mjs` and `state-ledger-sqlite.mjs` must persist identifiers and event relationships in a way that keeps lineage queryable. `live-event-projector.mjs` plus projection stores must produce high-read operational views from canonical events instead of inventing a second state model. `replay-reader.mjs` must reconstruct historical views from the same underlying source. `runtime-metrics.mjs`, `provider-usage-ledger.mjs`, and `trace-export.mjs` must consume canonical events rather than bespoke side channels.

Keep noisy ephemeral data out of git and preserve Bosun’s private runtime-state posture. The goal is not “more logs”; it is an inspection-grade runtime spine that makes Bosun the gold-standard internal agent platform. This step is complete only when operators can inspect a session, thread, workflow-linked run, tool execution, approval chain, and provider-usage story from one source of truth instead of reconstructing state from scattered logs and incompatible data stores.

**Required sub-deliverables**

- A written canonical event schema that defines:
  - required event IDs
  - session/thread/run/turn/provider/approval/subagent references
  - event categories and event-type naming rules
  - timestamp rules
  - payload normalization rules
- A written projection contract that defines:
  - which projections are live-only caches
  - which projections are durable SQLite-backed stores
  - how projections are rebuilt from canonical events
- An observability boundary note that states:
  - which modules may emit canonical events
  - which modules may transform events
  - which modules may persist events
  - which modules are projection consumers only

**Non-goals**

- Do not create multiple competing event schemas for different surfaces.
- Do not let workflow, Telegram, or UI features keep private event formats once the canonical schema exists.
- Do not move telemetry buffering into Rust yet.
- Do not store noisy ephemeral runtime chatter in git-backed state.

**Validation**

- Add or update focused tests that prove live views and replay derive from the same canonical events.
- Add focused tests that prove provider usage, approvals, retries, and subagent activity are queryable through normalized persisted state.
- Add focused tests that prove event IDs and lineage references stay intact across session, workflow, tool, and subagent boundaries.
- Add focused tests that prove projection stores can be rebuilt from persisted events without relying on surface-local state.

**Done when**

- Bosun has one canonical event model for the harness.
- Live views and replay are both backed by the same source-of-truth events.
- Costs, tokens, latency, retries, approvals, and subagent activity are queryable.
- Operators can inspect a complete session/thread history without reconstructing it from scattered logs.
- The observability boundary contract exists and matches actual code ownership.
- Projection stores and replay readers derive from canonical events rather than bespoke side channels.

## Step 6: Rebuild Workflow Execution Around Harness Sessions

**What this step must accomplish**

Make the workflow engine a harness client instead of a separate agent runtime. Bosun’s current workflow engine is already substantial, and `workflow-nodes.mjs` still carries direct execution behavior, approval integration, process/tool dispatch, and workflow-local runtime assumptions. The required outcome is to preserve Bosun’s workflow power while moving runtime ownership behind the canonical harness contracts so workflows orchestrate sessions, tools, approvals, and subagents instead of re-implementing them.

**Primary Bosun files to create or rewrite**

- Rewrite heavily:
  - `bosun/workflow/workflow-engine.mjs`
  - `bosun/workflow/workflow-nodes.mjs`
  - `bosun/workflow/workflow-contract.mjs`
  - `bosun/workflow/execution-ledger.mjs`
- Create:
  - `bosun/workflow/harness-session-node.mjs`
  - `bosun/workflow/harness-tool-node.mjs`
  - `bosun/workflow/harness-approval-node.mjs`
  - `bosun/workflow/harness-subagent-node.mjs`
  - `bosun/workflow/harness-output-contract.mjs`
  - `bosun/workflow/workflow-harness-boundaries.md`

**Workflow boundaries that must be locked in this step**

- `workflow-engine.mjs`:
  - owns graph execution, node scheduling, graph traversal, retrying workflow structure, and run bookkeeping
  - must not own private agent lifecycle semantics, provider routing, or tool policy
- `workflow-nodes.mjs`:
  - transitional registry/composition layer for workflow node types
  - must stop embedding workflow-private runtime semantics for agent sessions, tool policy, and approvals
  - should increasingly delegate to harness-specific node modules
- `workflow-contract.mjs`:
  - authoritative source for workflow-level configuration and behavioral constraints
  - must define how workflows request harness-backed behavior, not how they implement it internally
- `execution-ledger.mjs`:
  - durable workflow-run ledger aligned with harness session/thread/run identifiers
  - must preserve lineage between workflow runs and harness-created sessions/subagents
- `harness-session-node.mjs`:
  - canonical workflow node for starting, steering, awaiting, and resuming harness sessions
  - must not reimplement session lifecycle logic
- `harness-tool-node.mjs`:
  - canonical workflow node for tool invocation through the tool orchestrator
  - must not carry workflow-only approval or retry semantics
- `harness-approval-node.mjs`:
  - canonical workflow node for waiting on or resolving approvals through shared approval state
  - must not become a second approval policy engine
- `harness-subagent-node.mjs`:
  - canonical workflow node for spawning and observing subagents through the session/subagent control plane
  - must not implement its own lineage model
- workflow templates and higher-level workflow services:
  - may compose harness-backed nodes
  - may not bypass harness lifecycle, provider, tool, or approval contracts

**Best donor references**

- `opencode-dev/opencode-dev/packages/opencode/src/session/processor.ts`
- `codex-main/codex-rs/core/src/agent/control.rs`
- `openclaude/src/utils/swarm/inProcessRunner.ts`
- `pi-mono-main/packages/coding-agent/src/core/agent-session.ts`

**Language decision**

- Keep workflow composition in `.mjs`.
- Do not split workflow semantics into native code.
- Preserve Bosun’s declarative workflow model, but move runtime ownership out of workflow-local code paths.
- Treat this step as a runtime-unification step, not a workflow-feature expansion step.

**Implementation prompt**

Refactor Bosun workflows so they invoke the harness session manager, provider kernel, tool orchestrator, approval system, and subagent control plane instead of carrying parallel runtime semantics inside workflow-specific code paths. Start by auditing `workflow-engine.mjs`, `workflow-nodes.mjs`, `workflow-contract.mjs`, `execution-ledger.mjs`, and the existing workflow node/action/approval helpers. Explicitly identify every place workflow code currently performs private agent routing, provider selection, approval interpretation, tool invocation, subagent spawning, or lifecycle bookkeeping. Move those responsibilities behind harness-backed node modules and canonical runtime contracts.

`workflow-engine.mjs` must remain the graph scheduler and orchestration coordinator, but it must stop acting like a second agent runtime. `workflow-nodes.mjs` should become a registry/composition layer that increasingly delegates to `harness-session-node.mjs`, `harness-tool-node.mjs`, `harness-approval-node.mjs`, and `harness-subagent-node.mjs`. `workflow-contract.mjs` must express workflow constraints and requested behavior in a way that maps onto harness contracts. `execution-ledger.mjs` must persist workflow-linked run state using the same session, thread, approval, tool, and lineage identifiers used elsewhere in Bosun. A workflow-triggered session must look identical to an interactive session in the event stream and ledger except for workflow metadata and parent lineage.

Workflow nodes must be able to create sessions, steer active sessions, spawn subagents, await outputs, handle approvals, inspect telemetry, and persist lineage using the same runtime contracts as chat, TUI, Telegram, and the web UI. Remove workflow-only provider handling and workflow-only agent control logic. Remove workflow-local approval policy when the shared approval system already exists. Remove workflow-private tool routing when the shared orchestrator exists. This step is complete only when workflows are clearly an orchestration layer over the harness instead of a second implementation that happens to reuse some agent modules.

**Required sub-deliverables**

- A written workflow-to-harness boundary note that defines:
  - which responsibilities remain in the workflow engine
  - which responsibilities must always be delegated to the harness
  - which legacy workflow helpers are transitional only
- A harness-output contract that defines:
  - how workflow nodes request structured outputs
  - how sessions/tool runs/subagents expose outputs back to workflows
  - how approval waits and resumptions are represented
- A workflow lineage contract that defines:
  - how workflow run IDs relate to session IDs, thread IDs, approval IDs, and subagent spawn IDs
  - how parent-child relationships are persisted in the ledger

**Non-goals**

- Do not turn workflows into a second provider or session runtime.
- Do not keep workflow-only approval or retry semantics when a shared harness path exists.
- Do not move declarative workflow composition into Rust.
- Do not collapse Bosun’s workflow model into hardcoded imperative flows.

**Validation**

- Add or update focused tests that prove workflow session nodes route through the canonical session manager.
- Add focused tests that prove workflow tool and approval nodes route through the shared orchestrator and approval system.
- Add focused tests that prove workflow-linked sessions and subagents appear in the same lineage graph and observability spine as interactive sessions.
- Add focused tests that prove structured outputs returned to workflows are sourced from harness contracts rather than bespoke node-local parsing.

**Done when**

- Workflow nodes call the harness instead of internal private agent code.
- Workflow sessions share the same session manager, tool layer, and event model as interactive sessions.
- Workflow lineage is visible in the thread graph and ledger.
- Structured workflow outputs are sourced from harness contracts, not bespoke parsing scattered through the engine.
- The workflow-to-harness boundary contract exists and matches actual code ownership.
- Workflow execution is clearly an orchestration layer over the harness, not a second runtime.

## Step 7: Unify TUI, Web UI, Chat Engine, And Telegram On One Harness API

**What this step must accomplish**

Convert every Bosun user surface into a client of the same session, approval, telemetry, provider, and control APIs. This is not a cosmetic API cleanup. Bosun’s server, TUI, UI modules, and Telegram bot already expose substantial surface-specific behavior, and at least some of those paths still talk directly to `primary-agent.mjs`, `agent-pool.mjs`, or other non-canonical runtime seams. The required outcome is to make every user-facing surface consume one harness API layer and one projection model so Bosun behaves like one product instead of several stitched-together agent entrypoints.

**Primary Bosun files to create or rewrite**

- Rewrite heavily:
  - `bosun/server/ui-server.mjs`
  - `bosun/bosun-tui.mjs`
  - `bosun/tui/app.mjs`
  - `bosun/telegram/telegram-bot.mjs`
  - `bosun/ui/modules/session-api.js`
  - `bosun/ui/modules/agent-events.js`
  - `bosun/ui/modules/streaming.js`
- Create:
  - `bosun/server/routes/harness-sessions.mjs`
  - `bosun/server/routes/harness-providers.mjs`
  - `bosun/server/routes/harness-approvals.mjs`
  - `bosun/server/routes/harness-events.mjs`
  - `bosun/server/routes/harness-subagents.mjs`
  - `bosun/tui/screens/harness-sessions.mjs`
  - `bosun/tui/screens/harness-telemetry.mjs`
  - `bosun/tui/screens/harness-approvals.mjs`
  - `bosun/tui/screens/harness-subagents.mjs`
  - `bosun/server/routes/harness-surface-boundaries.md`

**Surface boundaries that must be locked in this step**

- `server/ui-server.mjs`:
  - transitional HTTP/WebSocket composition root for Bosun surface delivery
  - must stop owning broad inline harness business logic and instead delegate to dedicated route modules
  - should become a server shell, not the long-term API brain
- `server/routes/harness-sessions.mjs`:
  - canonical session-control API for create, continue, steer, retry, resume, cancel, inspect, and list
  - must source state from the session manager and canonical projections
- `server/routes/harness-providers.mjs`:
  - canonical provider inventory/auth/model/capability API
  - must source data from the provider kernel, auth manager, and model catalog
- `server/routes/harness-approvals.mjs`:
  - canonical approval list/detail/resolve API
  - must source state from the shared approval system and projection stores
- `server/routes/harness-events.mjs`:
  - canonical live event and stream API
  - must source data from the canonical event spine and live projections
- `server/routes/harness-subagents.mjs`:
  - canonical API for subagent trees, lineage inspection, spawn-state inspection, and child-session status
  - must source data from the session/subagent/lineage control plane
- `bosun-tui.mjs` and `tui/app.mjs`:
  - TUI bootstrap and composition only
  - must not contain alternate session, approval, provider, or event semantics
- `tui/screens/*` and new harness screens:
  - must render canonical API/projection data
  - must not maintain private lifecycle state machines that diverge from the harness
- `ui/modules/session-api.js`, `ui/modules/agent-events.js`, `ui/modules/streaming.js`:
  - canonical browser-facing access layer for session APIs and live event streams
  - must consume normalized server contracts and stop papering over inconsistent backend state
- `telegram/telegram-bot.mjs`:
  - must become a channel adapter over the same harness APIs
  - must stop talking directly to `primary-agent.mjs`, `agent-pool.mjs`, or other transitional runtime seams for long-term behavior
- chat engine and any other user-facing control surfaces:
  - may compose the canonical API layer
  - may not keep bespoke session IDs, retry semantics, approval semantics, or provider routing

**Best donor references**

- `codex-main/codex-rs/tui/src/multi_agents.rs`
- `codex-main/codex-rs/tui/src/chatwidget.rs`
- `codex-main/codex-rs/tui/src/streaming/controller.rs`
- `opencode-dev/opencode-dev/packages/opencode/src/server/routes/session.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/server/routes/event.ts`
- `openclaude/src/bridge/bridgeMain.ts`
- `openclaude/src/QueryEngine.ts`

**Language decision**

- All surface integration remains in `.mjs` and existing frontend modules.
- No Rust here.
- Favor dedicated route modules and shared API clients over adding more logic to giant surface entry files.
- Treat this step as a surface-boundary unification step, not a UI redesign step.

**Implementation prompt**

Refactor Bosun’s interactive surfaces so they all consume the same harness APIs and projection contracts. Start by auditing `server/ui-server.mjs`, `bosun-tui.mjs`, `tui/app.mjs`, `telegram/telegram-bot.mjs`, and the browser-side `ui/modules/*` session/stream/event helpers. Identify every place surface code currently owns session mutation, retry behavior, provider branching, approval interpretation, event filtering, or local state stitching that should instead come from the harness API and canonical projections. Move those responsibilities into dedicated harness route modules and shared client modules.

The web server must expose canonical session, event, provider, approval, and subagent endpoints through dedicated `server/routes/harness-*.mjs` modules. `ui-server.mjs` should become a composition shell that wires those routes and streams together instead of remaining a giant file that mixes transport, state, and business logic. The TUI must render the same live session state, approvals, telemetry, subagent trees, and workflow-linked runs that the web UI and chat engine see, and it must do so from canonical APIs/projections rather than custom local state assembly. The browser-facing modules in `ui/modules/` must be the normalized client layer over those APIs and event streams. Telegram must be able to start runs, steer sessions, inspect status, and resolve approvals using the same server-side contracts rather than channel-specific shortcuts or direct coupling to `primary-agent.mjs` and `agent-pool.mjs`.

Remove any surface-owned retry logic, provider branching, approval semantics, or local session-state mutation that bypasses the session manager and the shared runtime contracts. By the end of this step, a session started from Telegram must be inspectable in the TUI and web UI with the same identifiers, same timeline, same provider state, same approval state, and same lineage data. A workflow-linked session must look like the same object everywhere. This step is complete only when Bosun’s surfaces are all recognizably clients of one internal harness rather than owners of partially duplicated runtime behavior.

**Required sub-deliverables**

- A surface-boundary note that defines:
  - which responsibilities stay in transport/bootstrap files
  - which responsibilities move into dedicated harness route modules
  - which state must come from canonical projections only
- A canonical surface API contract that defines:
  - session endpoints and stream semantics
  - provider inventory/auth endpoints
  - approval query and resolution endpoints
  - subagent and lineage inspection endpoints
- A TUI/UI client contract that defines:
  - which API modules are authoritative
  - how live event subscriptions are normalized
  - how surfaces reconcile initial snapshots with incremental event streams

**Non-goals**

- Do not redesign Bosun’s visual UX in this step unless required by the API migration.
- Do not let Telegram remain a direct caller into transitional `primary-agent` or `agent-pool` seams.
- Do not let `ui-server.mjs` keep growing as a monolith once route modules exist.
- Do not create separate surface-only session or approval identifiers.

**Validation**

- Add or update focused tests that prove every major surface calls the same canonical harness APIs.
- Add focused tests that prove session IDs, approval IDs, provider IDs, and subagent IDs remain consistent across server, TUI, web UI, chat, and Telegram views.
- Add focused tests that prove surface state is reconstructed from canonical snapshots plus events rather than private local mutation rules.
- Add focused tests that prove Telegram-initiated and workflow-initiated sessions are inspectable through the same APIs as interactive UI sessions.

**Done when**

- Every surface reads from and writes to one harness API layer.
- Session IDs, approval IDs, and subagent IDs are consistent across channels.
- Surface state is projected from canonical runtime events, not custom local mutations.
- Bosun behaves like one product instead of several stitched-together agent entrypoints.
- The surface-boundary contract exists and matches actual code ownership.
- `ui-server.mjs` is no longer the de facto owner of cross-surface harness business logic.

## Step 8: Demote Shell Adapters Into Thin Compatibility Shims

**What this step must accomplish**

Stop treating shell wrappers as primary runtime implementations and reduce them to compatibility layers over the new provider kernel, session manager, tool orchestrator, and observability spine. This is not a theoretical cleanup step. Bosun’s shell adapters are still large, stateful, and runtime-heavy, and some of them directly own persistent session behavior, streaming coordination, provider selection, or session-state persistence. The required outcome is to make shell code operationally small enough that Bosun can reason about one runtime instead of many.

**Primary Bosun files to create or rewrite**

- Rewrite heavily:
  - `bosun/shell/codex-shell.mjs`
  - `bosun/shell/claude-shell.mjs`
  - `bosun/shell/opencode-shell.mjs`
  - `bosun/shell/copilot-shell.mjs`
  - `bosun/shell/gemini-shell.mjs`
  - `bosun/shell/opencode-providers.mjs`
  - `bosun/shell/shell-session-compat.mjs`
- Verify integration with:
  - `bosun/agent/provider-kernel.mjs`
  - `bosun/agent/provider-registry.mjs`
  - `bosun/agent/session-manager.mjs`
  - `bosun/agent/tool-orchestrator.mjs`
  - `bosun/agent/agent-event-bus.mjs`
  - `bosun/infra/session-telemetry.mjs`
  - `bosun/agent/subagent-control.mjs`

**Shell boundaries that must be locked in this step**

- `shell-session-compat.mjs`:
  - canonical compatibility bridge between legacy shell entrypoints and the canonical session manager
  - should absorb the minimum required adapter bookkeeping and no long-term business logic beyond compatibility mediation
- `codex-shell.mjs`, `claude-shell.mjs`, `opencode-shell.mjs`, `copilot-shell.mjs`, `gemini-shell.mjs`:
  - transitional compatibility adapters only
  - may translate SDK/CLI-specific transport details into Bosun contracts
  - must not remain owners of session lifecycle, provider policy, tool policy, approval logic, or observability semantics
- `opencode-providers.mjs`:
  - transitional discovery helper only if still needed for OpenCode-specific compatibility
  - must not remain a parallel provider inventory outside the provider registry
- shell adapters collectively:
  - may preserve entrypoint parity and SDK/CLI transport integration
  - may not keep private runtime identifiers, private approval semantics, or private event schemas
- `provider-kernel.mjs`, `session-manager.mjs`, `tool-orchestrator.mjs`, `agent-event-bus.mjs`, and `session-telemetry.mjs`:
  - remain the authoritative owners of provider resolution, lifecycle, tool policy, event emission, and telemetry
  - shell adapters must delegate into these layers rather than competing with them

**Best donor references**

- `openclaude/src/services/api/codexShim.js`
- `openclaude/src/services/api/openaiShim.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/provider/provider.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/server/routes/provider.ts`

**Language decision**

- Keep shell compatibility in `.mjs`.
- Do not port shell shims to Rust.
- Preserve user-facing parity while shrinking runtime ownership.
- Treat this step as an adapter demotion step, not as a place to keep SDK-specific architecture.

**Implementation prompt**

Collapse the current shell adapters into thin compatibility shims that translate legacy SDK/CLI-oriented flows into the canonical Bosun harness contracts. Start by auditing `codex-shell.mjs`, `claude-shell.mjs`, `opencode-shell.mjs`, `copilot-shell.mjs`, `gemini-shell.mjs`, `opencode-providers.mjs`, and `shell-session-compat.mjs`. Explicitly identify which parts of those files still own persistent session state, transport retry behavior, provider discovery, tool-event mapping, stream-event normalization, state-file persistence, or long-lived lifecycle coordination. Move every responsibility that belongs to the provider kernel, session manager, tool orchestrator, approval system, or observability spine out of the shell modules and behind canonical contracts.

`shell-session-compat.mjs` should become the narrow bridge that preserves legacy shell-oriented entrypoint semantics while delegating into the canonical session manager. Subscription-backed Codex or Claude behavior should resolve through the provider kernel, not shell-local lifecycle logic. Tool execution should route into the Bosun tool orchestrator. Session lifecycle should route into the session manager. Event emission and stream reporting should route into the observability spine. If a shell adapter still needs to deal with SDK-specific streaming, session IDs, transport bootstrapping, or command invocation, that logic should end at the compatibility boundary and immediately translate into Bosun-native identifiers and events.

Existing user-facing entrypoints may remain temporarily to preserve parity, but they must not remain independent runtime owners. Remove duplicated semantics aggressively while keeping external behavior stable. `opencode-providers.mjs` should either be folded into the provider registry path or clearly demoted to a compatibility discovery shim with no architectural authority. This step is complete only when shell-specific code is small, predictable, and obviously subordinate to the canonical harness architecture.

**Required sub-deliverables**

- A shell-boundary note that defines:
  - which responsibilities remain in shell adapters
  - which responsibilities must always be delegated to canonical harness modules
  - which shell modules are transitional only
- A compatibility contract that defines:
  - how legacy shell entrypoints map to canonical session IDs and thread IDs
  - how shell-originated stream events map to canonical event types
  - how shell adapter errors map to normalized provider/session/tool errors
- A migration table that lists, for each shell adapter:
  - what runtime ownership it had before
  - what canonical Bosun module now owns that responsibility

**Non-goals**

- Do not keep shell-local provider catalogs authoritative once the provider registry exists.
- Do not keep shell-local session state machines authoritative once the session manager exists.
- Do not move shell shims to Rust.
- Do not preserve duplicate event or approval semantics just to avoid refactoring adapters.

**Validation**

- Add or update focused tests that prove shell entrypoints delegate session ownership into `session-manager.mjs`.
- Add focused tests that prove provider selection and auth behavior route through the provider kernel rather than shell-local logic.
- Add focused tests that prove shell-originated tool calls and stream events enter the canonical orchestrator and observability spine with normalized IDs.
- Add focused tests that prove legacy entrypoints still work while the shell modules have materially less internal runtime authority.

**Done when**

- Shell modules are wrappers over canonical Bosun contracts.
- Subscription and provider behavior are not duplicated in shell code.
- Legacy entrypoints still function while using the new runtime under the hood.
- Shell modules become low-risk migration shims instead of architectural anchors.
- The shell-boundary contract exists and matches actual code ownership.
- `shell-session-compat.mjs` is the obvious compatibility bridge and the rest of `shell/*` is visibly demoted.

## Step 9: Port The Hot Path To Rust For Exec, Stream, And Telemetry Performance

**What this step must accomplish**

Introduce and harden Rust only where Bosun genuinely needs it: process lifecycle, high-frequency stream handling, buffering, cancellation, and telemetry throughput. This is not a hypothetical future step anymore. Bosun already has native crates under `bosun/native/` and a JavaScript bridge in `bosun/lib/hot-path-runtime.mjs`. The required outcome is to turn that existing native work into a narrow, production-grade hot-path boundary and prevent Rust scope creep into orchestration, provider, workflow, or UI concerns.

**Primary Bosun files to create or rewrite**

- Keep, complete, and harden:
  - `bosun/native/bosun-unified-exec/Cargo.toml`
  - `bosun/native/bosun-unified-exec/src/main.rs`
  - `bosun/native/bosun-unified-exec/src/process_manager.rs`
  - `bosun/native/bosun-unified-exec/src/head_tail_buffer.rs`
  - `bosun/native/bosun-unified-exec/src/async_watcher.rs`
  - `bosun/native/bosun-unified-exec/src/tool_orchestrator.rs`
  - `bosun/native/bosun-telemetry/Cargo.toml`
  - `bosun/native/bosun-telemetry/src/main.rs`
  - `bosun/native/bosun-telemetry/src/session_telemetry.rs`
  - `bosun/native/bosun-telemetry/src/metrics.rs`
  - `bosun/native/bosun-telemetry/src/export.rs`
- Keep and refine:
  - `bosun/lib/hot-path-runtime.mjs`
- Integrate with:
  - `bosun/agent/tool-orchestrator.mjs`
  - `bosun/agent/agent-pool.mjs`
  - `bosun/infra/session-telemetry.mjs`
  - `bosun/server/ui-server.mjs`
  - `bosun/workflow/workflow-engine.mjs`
  - `bosun/agent/agent-event-bus.mjs`
  - `bosun/infra/runtime-metrics.mjs`
  - `bosun/infra/provider-usage-ledger.mjs`

**Native hot-path boundaries that must be locked in this step**

- `bosun/lib/hot-path-runtime.mjs`:
  - canonical Node-side bridge to native services
  - owns capability detection, transport selection, fallbacks, and normalized request/response mapping
  - must prevent native implementation details from leaking throughout the codebase
- `bosun/native/bosun-unified-exec/*`:
  - owns subprocess lifecycle, stream buffering, truncation helpers, async watchers, cancellation responsiveness, and high-frequency exec-side orchestration
  - must not absorb provider logic, workflow semantics, settings resolution, approval policy, or UI concerns
- `bosun/native/bosun-telemetry/*`:
  - owns high-frequency telemetry ingestion, aggregation, metrics extraction, and export acceleration
  - must not become a second business-logic layer or alternative event schema
- Node `.mjs` control-plane modules:
  - remain authoritative owners of session management, provider selection, workflow composition, approval policy, event semantics, and surface APIs
  - may call into native services only for hot-path execution and telemetry acceleration
- `agent-pool.mjs` and any other hot-path callers:
  - may use native services for throughput and buffering
  - must not rely on native code as a substitute for unresolved architecture problems in higher layers

**Best donor references**

- `codex-main/codex-rs/core/src/unified_exec/process_manager.rs`
- `codex-main/codex-rs/core/src/unified_exec/head_tail_buffer.rs`
- `codex-main/codex-rs/core/src/unified_exec/async_watcher.rs`
- `codex-main/codex-rs/core/src/tools/orchestrator.rs`
- `codex-main/codex-rs/otel/src/events/session_telemetry.rs`
- `codex-main/codex-rs/exec/src/event_processor_with_jsonl_output.rs`

**Language decision**

- Rust is required here for the hot path.
- Node `.mjs` remains the control plane.
- Do not move provider logic, workflow composition, settings, or UI rendering into Rust.
- Treat Rust as a surgical acceleration layer, not as Bosun’s new architectural center.
- Measure every native boundary with clear performance and correctness evidence.

**Implementation prompt**

Harden Bosun’s existing native hot-path work into a narrow, production-grade acceleration layer. Start by auditing `bosun/native/bosun-unified-exec/*`, `bosun/native/bosun-telemetry/*`, and `bosun/lib/hot-path-runtime.mjs`, then trace every current caller from `tool-orchestrator.mjs`, `agent-pool.mjs`, `session-telemetry.mjs`, `agent-event-bus.mjs`, `runtime-metrics.mjs`, `ui-server.mjs`, and `workflow-engine.mjs`. Explicitly define which responsibilities belong in Rust and which must remain in `.mjs`. Do not treat native code as a place to hide architectural ambiguity from earlier steps.

`bosun-unified-exec` must own the genuine execution hot path: long-lived subprocess management, high-frequency stream fan-out, cancellation responsiveness, truncation buffers, async file/process watchers, and backpressure-safe execution under parallel load. `bosun-telemetry` must own high-frequency telemetry ingestion, metrics aggregation, and export acceleration where Node would otherwise become the bottleneck. `hot-path-runtime.mjs` must become the narrow, explicit bridge that exposes native capabilities to the rest of Bosun while preserving safe fallbacks and normalized interfaces. Provider logic, workflow composition, settings resolution, approvals, event-schema ownership, and surface APIs must stay in `.mjs`.

This step is not a rewrite of Bosun; it is a surgical acceleration of the already-canonical architecture. Acceptance requires measurable improvement in throughput, cancellation correctness, stability under load, and live-stream responsiveness. It also requires proof that native integration did not spread business logic into the Rust layer or create a second control plane. This step is complete only when the native services are clearly bounded, operationally valuable, and optional enough that Bosun still has an understandable `.mjs` control plane.

**Required sub-deliverables**

- A native-boundary note that defines:
  - which responsibilities live in `bosun-unified-exec`
  - which responsibilities live in `bosun-telemetry`
  - which responsibilities are forbidden in Rust
- A bridge contract for `hot-path-runtime.mjs` that defines:
  - request/response protocol shape
  - fallback behavior when native services are unavailable
  - capability/status reporting for operators
- A benchmark and load-validation contract that defines:
  - throughput metrics
  - cancellation latency metrics
  - stream responsiveness metrics
  - telemetry ingestion/export metrics
  - failure-injection scenarios

**Non-goals**

- Do not move provider selection, workflow composition, settings, approvals, or UI rendering into Rust.
- Do not let native crates define a competing event schema or session model.
- Do not treat Rust as the first fix for problems caused by poor ownership in `.mjs`.
- Do not require native services for basic Bosun correctness if a safe fallback is possible.

**Validation**

- Add or update focused tests that prove Node-side callers use `hot-path-runtime.mjs` instead of depending directly on native implementation details.
- Add focused tests that prove native execution improves buffering, truncation, and cancellation behavior under concurrency.
- Add focused tests that prove telemetry ingestion/export remains schema-compatible with the canonical observability spine.
- Add benchmark/load evidence showing Bosun remains responsive with multiple concurrent sessions, tools, and streams while using the native hot path.

**Done when**

- Process and stream hot paths run through native services.
- Node remains the orchestrator and source of business logic.
- Backpressure, buffering, cancellation, and telemetry export are materially improved.
- Load tests show Bosun stays responsive with multiple concurrent sessions and tool runs.
- The native-boundary contract exists and matches actual code ownership.
- Rust remains a narrow acceleration layer instead of expanding into a second Bosun architecture.

## Step 10: Execute Migration, Parity Validation, Benchmarks, And Cutover

**What this step must accomplish**

Finish the adoption by proving parity, migrating surfaces and workflows fully, benchmarking the new runtime, and removing old architectural ownership. This is not a placeholder “final polish” step. Bosun already has a large test suite, an existing `bench/` area, and many transitional modules that can easily remain accidental owners if cutover is not made explicit. The required outcome is to prove the harness is production-usable, demote old runtime owners decisively, and document a controlled rollout path across every major Bosun surface.

**Primary Bosun files to create or rewrite**

- Finalize and simplify:
  - `bosun/agent/primary-agent.mjs`
  - `bosun/agent/agent-pool.mjs`
  - `bosun/shell/codex-shell.mjs`
  - `bosun/shell/claude-shell.mjs`
  - `bosun/shell/opencode-shell.mjs`
  - `bosun/server/ui-server.mjs`
  - `bosun/workflow/workflow-engine.mjs`
  - `bosun/telegram/telegram-bot.mjs`
- Create validation and benchmark assets:
  - `bosun/bench/harness-parity-bench.mjs`
  - `bosun/bench/harness-load-bench.mjs`
  - `bosun/tests/harness-runtime.test.mjs`
  - `bosun/tests/provider-kernel.test.mjs`
  - `bosun/tests/session-manager.test.mjs`
  - `bosun/tests/tool-orchestrator.test.mjs`
  - `bosun/tests/harness-surface-integration.test.mjs`
  - `bosun/_docs/INTERNAL_HARNESS_ROLLOUT_RUNBOOK.md`

**Cutover and validation boundaries that must be locked in this step**

- `primary-agent.mjs`, `agent-pool.mjs`, shell adapters, `ui-server.mjs`, `workflow-engine.mjs`, and `telegram-bot.mjs`:
  - may remain as transitional entrypoints where needed
  - must no longer own semantics that diverge from the canonical harness
  - must be auditable as wrappers/composition layers rather than hidden runtime owners
- `bench/harness-parity-bench.mjs` and `bench/harness-load-bench.mjs`:
  - authoritative benchmark entrypoints for parity and load evidence related to the internal harness
  - must measure canonical harness paths, not obsolete code paths
- targeted harness tests:
  - must verify canonical ownership for provider, session, tool, workflow, and surface integration behavior
  - must not merely assert backwards compatibility while leaving old ownership intact
- `INTERNAL_HARNESS_ROLLOUT_RUNBOOK.md`:
  - authoritative operational rollout/cutover document
  - must define enablement stages, fallback paths, success criteria, and stop rules
- overall migration rule:
  - compatibility wrappers may survive temporarily
  - divergent logic may not
  - there must be one source of truth for runtime behavior

**Best donor references**

- `codex-main` load-oriented exec and telemetry discipline
- `opencode-dev` event/session parity patterns
- `openclaude` transport reliability and runtime bridging ideas
- `pi-mono-main` provider/agent cohesion patterns

**Language decision**

- Validation harnesses in `.mjs`.
- Rust already landed only where needed from Step 9.
- Use existing Bosun test and bench infrastructure where possible instead of inventing a second validation framework.
- Treat this step as proof and cutover, not as another architecture design pass.

**Implementation prompt**

Complete the Bosun internal harness migration by removing the old architecture as the source of truth and proving the new system is production-usable. Start by auditing every transitional owner that earlier steps demoted in theory: `primary-agent.mjs`, `agent-pool.mjs`, the shell adapters, `ui-server.mjs`, `workflow-engine.mjs`, and `telegram-bot.mjs`. Verify that each one now delegates into canonical harness modules and identify any remaining divergent behavior. Remove or isolate that divergence until compatibility wrappers are obviously subordinate to the harness.

Use Bosun’s existing test and benchmark infrastructure to add targeted proof, not just broad smoke coverage. Add or extend tests for session control, provider normalization, tool orchestration, approval flows, workflow integration, observability continuity, and multi-surface parity. Add benchmark tooling for session throughput, stream latency, approval latency, tool-exec overhead, cancellation responsiveness, projection freshness, and concurrent subagent execution. Make sure the benchmark paths exercise the canonical harness and not stale compatibility flows.

Produce `INTERNAL_HARNESS_ROLLOUT_RUNBOOK.md` as the operational cutover document for enabling the harness progressively across chat, workflow, TUI, web UI, and Telegram. The runbook must define rollout phases, feature flags or enablement toggles where relevant, fallback procedures, operator checks, metrics to watch, and explicit stop rules if parity or stability regresses. Make cutover explicit: old paths may remain as wrappers where needed for compatibility, but they must not own logic that diverges from the harness. This step is complete only when Bosun can credibly treat the internal harness as the gold-standard runtime for autonomous work across all major product surfaces.

**Required sub-deliverables**

- A cutover matrix that lists, for each transitional file:
  - whether it remains as a wrapper
  - which canonical harness modules it delegates to
  - what divergent behavior was removed
- A parity test plan that covers:
  - interactive sessions
  - workflow-triggered sessions
  - approvals
  - provider switching
  - subagent lineage
  - TUI/web UI/Telegram consistency
- A benchmark plan that covers:
  - throughput
  - latency
  - cancellation responsiveness
  - projection freshness
  - concurrent execution resilience
- A rollout runbook that covers:
  - phased enablement
  - fallback and rollback
  - operator verification steps
  - success and stop criteria

**Non-goals**

- Do not leave “temporary” divergent runtime behavior in compatibility wrappers.
- Do not rely on anecdotal manual testing instead of explicit parity and benchmark evidence.
- Do not reopen foundational architecture debates that earlier steps were meant to settle.
- Do not declare cutover complete if only one surface is fully migrated.

**Validation**

- Add or update focused tests that prove old runtime owners are wrappers only and no longer authoritative.
- Add focused parity tests across chat, workflow, TUI, web UI, and Telegram for the same session/approval/subagent objects.
- Add benchmark evidence showing canonical harness throughput, latency, and resilience at or above the prior baseline.
- Verify the rollout runbook is specific enough for an operator to enable the harness progressively without source spelunking.

**Done when**

- Old runtime owners are demoted to compatibility layers only.
- Parity tests pass across chat, workflow, TUI, web UI, and Telegram.
- Benchmark evidence exists for throughput, latency, and resilience.
- A rollout runbook exists and Bosun can adopt the new harness incrementally but decisively.
- The cutover matrix and rollout runbook exist and match actual code ownership.
- Bosun can point to one canonical harness as the runtime source of truth across all major product surfaces.

## Step 11: Dual-Agent Consolidation And Gap Closure

**What this step must accomplish**

Converge the output of both queued agents after Steps 1 to 10 have run. This is the first explicit merge-and-reconcile phase. Its job is to close all gaps between the implementation track and the audit/consolidation track so Bosun does not carry forward duplicated work, contradictory docs, mismatched contracts, or partially demoted transitional owners.

**Primary Bosun files to create or rewrite**

- Finalize across prior work:
  - `bosun/agent/primary-agent.mjs`
  - `bosun/agent/agent-pool.mjs`
  - `bosun/agent/provider-kernel.mjs`
  - `bosun/agent/session-manager.mjs`
  - `bosun/agent/tool-orchestrator.mjs`
  - `bosun/agent/agent-event-bus.mjs`
  - `bosun/workflow/workflow-engine.mjs`
  - `bosun/server/ui-server.mjs`
  - `bosun/telegram/telegram-bot.mjs`
  - `bosun/shell/shell-session-compat.mjs`
- Create:
  - `bosun/_docs/INTERNAL_HARNESS_CONSOLIDATION_MATRIX.md`
  - `bosun/_docs/INTERNAL_HARNESS_GAP_REGISTER.md`

**How the two agents should split this step**

- Agent 1:
  - merge implementation-side changes
  - remove remaining divergent runtime ownership
  - make final code-level reconciliation decisions
- Agent 2:
  - compare implementation against all boundary contracts, runbooks, parity plans, and gap reports
  - produce the consolidation matrix and explicit unresolved-gap register
  - validate that no second architecture survived the migration

**Implementation prompt**

Run a full convergence pass across the work produced in Steps 1 to 10. Treat every earlier queue-safe audit report, gap list, boundary note, and validation checklist as a required reconciliation input. Produce `INTERNAL_HARNESS_CONSOLIDATION_MATRIX.md` listing each major runtime area, its canonical owner, any surviving compatibility wrapper, and the reason that wrapper still exists. Produce `INTERNAL_HARNESS_GAP_REGISTER.md` listing any unresolved ownership, parity, performance, or observability gaps that still block calling the harness complete. Agent 1 should remove code-level divergence wherever possible. Agent 2 should verify that the resulting architecture matches the documented contracts and that no module family still behaves like a shadow control plane. This step is complete only when Bosun has one coherent post-merge architecture and any remaining gaps are explicit, bounded, and intentionally deferred.

**Done when**

- A consolidation matrix exists and maps all major runtime responsibilities to canonical owners.
- A gap register exists and contains only explicit, bounded residual work.
- No major transitional file still behaves as a hidden owner without being called out.
- Both agents have converged on one architecture story instead of two partially different implementations.

## Step 12: Dual-Agent Final Hardening, Signoff, And Launch Readiness

**What this step must accomplish**

Use both agents for the final readiness pass after consolidation is complete. This is the proof-and-signoff phase. Its job is to confirm that Bosun can actually adopt the internal harness as the in-house gold standard with clear release evidence, clear operator guidance, and clear rejection criteria if the system is not ready.

**Primary Bosun files to create or rewrite**

- Final validation assets:
  - `bosun/bench/harness-parity-bench.mjs`
  - `bosun/bench/harness-load-bench.mjs`
  - `bosun/tests/harness-runtime.test.mjs`
  - `bosun/tests/provider-kernel.test.mjs`
  - `bosun/tests/session-manager.test.mjs`
  - `bosun/tests/tool-orchestrator.test.mjs`
  - `bosun/tests/harness-surface-integration.test.mjs`
  - `bosun/_docs/INTERNAL_HARNESS_ROLLOUT_RUNBOOK.md`
  - `bosun/_docs/INTERNAL_HARNESS_RELEASE_SIGNOFF.md`

**How the two agents should split this step**

- Agent 1:
  - close the remaining code/test/benchmark blockers
  - finalize rollout toggles, wrappers, and migration-safe defaults
- Agent 2:
  - validate parity evidence, benchmark evidence, and rollout readiness
  - author the final release signoff with explicit go/no-go criteria

**Implementation prompt**

Execute the final launch-readiness pass for the Bosun internal harness. Agent 1 should finish any remaining code, test, benchmark, and rollout-safe default work needed to make the harness actually deployable. Agent 2 should independently validate parity, performance, and operational readiness and then produce `INTERNAL_HARNESS_RELEASE_SIGNOFF.md` containing a go/no-go decision, required evidence links, unresolved risks, fallback plan, and operator signoff checklist. The rollout runbook must be complete enough for progressive enablement across chat, workflow, TUI, web UI, and Telegram. This step is complete only when Bosun has explicit evidence for parity, resilience, and operator readiness and can either proceed with confidence or block release with concrete reasons.

**Done when**

- Release signoff exists with explicit go/no-go criteria.
- Parity, performance, and rollout evidence are all linked and reviewable.
- Operator guidance exists for enabling, monitoring, and rolling back the harness.
- Bosun can either ship the harness confidently or block launch with explicit evidence-backed reasons.

## Final Delivery Standard

This section is the acceptance contract for the entire migration. Bosun should not treat the internal harness as “done” because the code compiles, because a few happy paths work, or because the old entrypoints still appear functional. The harness is done only when Bosun has one clearly dominant runtime architecture and the old owners have been reduced to thin, auditable compatibility layers.

**Architectural acceptance standard**

- One Bosun-native runtime contract owns sessions, turns, tools, approvals, retries, resume/replay, and subagents.
- One provider kernel owns provider resolution, auth health, capability discovery, model catalogs, normalized streams, and usage accounting.
- One session/thread/subagent control plane owns lineage, replayability, and parent-child execution graphs.
- One tool control plane owns registration, execution routing, approvals, retry policy, network policy, sandbox policy, and truncation semantics.
- One observability spine owns canonical events, durable ledgers, live projections, replay readers, metrics, and provider-usage accounting.
- One set of APIs is used by TUI, chat engine, workflow engine, web UI, and Telegram.
- One optional Rust hot path exists for performance-critical execution and telemetry only, with Node `.mjs` remaining the control plane.

**Ownership acceptance standard**

- `primary-agent.mjs` is not a hidden lifecycle owner.
- `agent-pool.mjs` is not a hidden orchestration owner.
- `workflow-engine.mjs` is not a second agent runtime.
- `ui-server.mjs` is not the long-term owner of cross-surface harness business logic.
- `telegram-bot.mjs` is not a direct long-term controller of transitional runtime seams.
- `shell/*` is not a parallel provider/session/tool architecture.
- Any compatibility wrapper that remains can be explained in one sentence and mapped directly to canonical harness modules.

**Operational acceptance standard**

- A session started from any supported surface can be inspected from every other major surface using the same canonical identifiers.
- A provider-selected run, approval, tool execution, retry, and subagent spawn all appear in the same lineage and observability system.
- Replay and live views are backed by the same canonical event source.
- Provider switching, approval resolution, workflow-linked execution, and subagent control all operate through the same contracts as interactive sessions.
- Backpressure, buffering, cancellation, and telemetry throughput are proven under load, not assumed.

**Validation acceptance standard**

- Parity tests exist across chat, workflow, TUI, web UI, and Telegram.
- Benchmark evidence exists for throughput, latency, resilience, cancellation responsiveness, and projection freshness.
- Rollout documentation exists and is specific enough for an operator to enable the harness progressively without source spelunking.
- Transitional files have a cutover matrix showing what they used to own, what now owns that responsibility, and whether they are still required.

**Explicit failure conditions**

Bosun should not declare the internal harness complete if any of the following remain true:

- more than one module family still owns session lifecycle semantics
- approval or tool policy still differs by surface
- provider behavior still depends on shell-local logic
- workflow execution still bypasses canonical harness contracts
- live UI/TUI state and replay history do not come from the same event source
- Rust has started absorbing business logic that belongs in `.mjs`
- compatibility wrappers still contain unique runtime behavior that the canonical harness does not own

That is the target state required for Bosun to become the in-house first-class internal agent harness rather than a collection of partially connected agent integrations.
