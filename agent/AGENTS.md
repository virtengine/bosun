# Agent Module Guide

## Scope
Agent runtime components: prompt composition, executor lifecycle, hooks, autofix, and fleet coordination.

## Start Files
- `agent/primary-agent.mjs` - primary executor routing.
- `agent/agent-launcher.mjs` - SDK/thread launcher, slot scheduling, and retry transport.
- `agent/agent-pool.mjs` - compatibility facade for legacy pool/thread entrypoints.
- `agent/agent-prompts.mjs` - prompt resolution and template mapping.
- `agent/agent-hooks.mjs` + `agent/hook-profiles.mjs` - hook framework.
- `agent/autofix.mjs` - automated recovery rules.
- `agent/fleet-coordinator.mjs` - multi-workstation coordination.

## Common Task Routing
- Prompt/task context issues -> `agent-prompts.mjs`, `task/task-context.mjs`, `workflow-templates/`.
- Executor failures/retries -> `agent-launcher.mjs`, `agent-pool.mjs`, `shell/`, `infra/monitor.mjs`.
- Hook behavior -> `agent-hooks.mjs`, `hook-profiles.mjs`, `agent-hook-bridge.mjs`.
- Work report/log analysis -> `agent-work-report.mjs`, `agent-work-analyzer.mjs`.

## Tests
- Focused: `npm test -- tests/agent-*.test.mjs tests/agent-*.node.test.mjs tests/autofix.test.mjs`
- Full: `npm test`
