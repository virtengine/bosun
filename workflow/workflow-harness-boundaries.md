# Workflow To Harness Boundaries

Workflow ownership:

- `workflow-engine.mjs` owns graph scheduling, traversal, retries of workflow structure, checkpoints, and run bookkeeping.
- `workflow/delegation-runtime.mjs` owns delegation watchdog interpretation plus delegation audit/transition-state normalization shared by the scheduler and workflow action modules.
- `workflow/workflow-nodes.mjs` is the public composition shell that loads the modular registrars under `workflow/workflow-nodes/*.mjs` and re-exports workflow-node helpers. It must not become a second runtime owner.
- `workflow-contract.mjs` defines workflow-to-harness requests and lineage expectations.
- `execution-ledger.mjs` persists workflow lineage using the same run/session/thread/approval identifiers as the harness.

Harness ownership:

- Session lifecycle, replay, and lineage live in `agent/session-manager.mjs` and `agent/thread-registry.mjs`.
- Tool execution and tool policy live in `agent/tool-orchestrator.mjs`.
- Approval interpretation lives in the shared tool approval layer and durable approval queue.
- Subagent lineage lives in `agent/subagent-control.mjs`.

Transitional helpers:

- `workflow/action-approval.mjs` remains transitional only until all risky action gating is represented as harness-backed approvals.
- `workflow/workflow-nodes/actions.mjs` remains the modular action registrar, but workflow-linked session/tool/subagent behavior inside it must continue delegating through `harness-session-node.mjs`, `harness-tool-node.mjs`, and `harness-subagent-node.mjs`.
- `workflow/workflow-nodes/agent.mjs` and `workflow/workflow-nodes/validation.mjs` may prepare prompts and evidence, but they should launch workflow-owned agent execution through `agent/harness-agent-service.mjs` rather than owning direct pool branching.
- workflow-specific node helpers may prepare prompts and data, but they may not own provider routing, session lifecycle, or tool policy.
