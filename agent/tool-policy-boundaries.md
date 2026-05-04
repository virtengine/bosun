# Tool Policy Boundaries

`tool-orchestrator.mjs` is the sole execution gateway for Bosun tool calls.

Authoritative ownership:

- `tool-orchestrator.mjs`: tool lookup, routing, lifecycle emission, retry coordination, and final result assembly
- `tool-registry.mjs`: tool inventory and registration metadata only
- `tool-approval-manager.mjs`: approval evaluation, request creation, and approval-queue integration
- `tool-network-policy.mjs`: network policy evaluation
- `tool-runtime-context.mjs`: canonical execution envelope and lineage metadata
- `tool-output-truncation.mjs`: truncation policy and truncation metadata
- `tool-retry-policy.mjs`: retry accounting and backoff semantics
- `tool-event-contract.mjs` and `tool-execution-ledger.mjs`: normalized tool events for observability and lineage
- `workflow/approval-queue.mjs`: durable approval persistence and shared lookup only

Non-authoritative callers:

- workflow nodes, surfaces, shells, and providers may supply tool metadata or runtime context
- workflow nodes, surfaces, shells, and providers may not decide approval, retry, network, sandbox, or truncation outcomes outside the tool layer
- direct approval resolution endpoints may remain as persistence adapters while the tool layer continues to own policy interpretation
