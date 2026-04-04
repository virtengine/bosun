# Native Adapter Comparison: Bosun vs Claude Code, Codex CLI, OpenCode

**Last updated:** 2026  
**Scope:** Deep technical comparison of HTTP layer, context management, session/thread
lifecycle, tool execution, memory/state persistence, token/cost accounting, and
stream-event model across four AI coding-assistant runtimes.

**Files involved:**
- Bosun: `shell/openai-native-adapter.mjs` (new), `agent/providers/*.mjs`, `agent/provider-kernel.mjs`
- Claude Code: `claude-src/` (TypeScript, Anthropic SDK)
- Codex CLI: `codex-main/` (Rust, native HTTP)
- OpenCode: `opencode-dev/` (TypeScript + Vercel AI SDK)

---

## 1. Architecture Summary

| Aspect | Bosun Native | Claude Code | Codex CLI (Rust) | OpenCode |
|--------|-------------|-------------|------------------|----------|
| Language | JavaScript/ESM | TypeScript | Rust | TypeScript |
| HTTP client | `fetch()` native | `@anthropic-ai/sdk` | `reqwest` (Rust) | Vercel AI SDK `streamText` |
| Primary API | Responses API + Chat Completions | Anthropic Messages API | OpenAI Responses API | Multi-provider via AI SDK |
| Multi-provider? | ✅ All OpenAI-compat + Azure | ❌ Anthropic only | ❌ OpenAI only | ✅ Pluggable |
| Provider config | Bosun `agent/providers/*.mjs` driver files | Hard-coded Anthropic client | CLI flags / env vars | `~/Library/…/opencode/config.json` |
| Session ownership | In-process `Map<sessionId, …>` | Client-side JSONL transcript | SQLite + in-memory thread | SQLite relational DB |

---

## 2. HTTP Layer & API Compatibility

### 2.1 Bosun Native (`shell/openai-native-adapter.mjs`)

- **Two-mode SSE parser** (`parseSseStream`): handles `event: …` + `data: …` line pairs
  for Responses API _and_ bare `data: …` lines for Chat Completions. Single
  `ReadableStream` reader, accumulate-and-split on `"\n"`.
- **Responses API path** (default): `POST {endpoint}/openai/deployments/{deployment}/responses?api-version=…`
  — consumes `response.output_text.delta`, `response.function_call_arguments.delta`,
  `response.output_item.done`, `response.completed`.
- **Chat Completions path**: detected via `providerConfig.apiStyle = "chat-completions"`.
  Consumes `choices[].delta.content`, `choices[].delta.tool_calls[]`, final
  `usage` in `stream_options.include_usage`.
- **Azure detection**: based on `.azure.com` in `endpoint` or non-empty `deployment`.
  Azure uses `api-key` header; OpenAI uses `Authorization: Bearer`.
- **Idle timeout guard**: per-stream `AbortController` restarted on each SSE chunk.
  Default 10 minutes. Prevents indefinitely stalled connections.
- **Single `fetch()` per turn**: no retry logic, no jitter, no incremental back-off.
  ⚠️ **Gap: no automatic retry on 429/503.**

### 2.2 Claude Code

- Uses `@anthropic-ai/sdk`'s `messages.stream()` which wraps the Anthropic HTTP endpoint.
- **No multi-provider support** — tightly bound to `api.anthropic.com`.
- Custom extended thinking block handling: `thinking` content blocks are collected
  separately and not shown in main text but surfaced to token budget.
- Streaming via SDK's `.on("text", …)` event callbacks, not a raw SSE reader.
- **Retry logic**: the Anthropic SDK has built-in exponential back-off on 429 and
  transient 5xx errors (configurable `maxRetries`).

### 2.3 Codex CLI (Rust)

- 100% native Rust HTTP via `reqwest` with `stream = true`.
- Parses SSE manually with a `SseParser` struct reading `event: …` / `data: …` pairs —
  architecturally identical to Bosun's `parseSseStream`.
- Strongly typed event enum: `ResponseOutputItemAdded`, `ResponseOutputItemDone`,
  `ResponseOutputTextDelta`, `ResponseFunctionCallArgumentsDelta`, `ResponseCompleted`.
- Uses `tokio` async runtime; each stream is a `tokio::task` with cancel token.
- **Has retry**: custom `RetryClient` wraps `reqwest` with a configurable retry
  policy (delay, max attempts). Applied to all API calls, not just streaming.

### 2.4 OpenCode

- Delegates HTTP to Vercel AI SDK `streamText(…)` — it handles all provider-specific
  request formatting, SSE parsing, and error normalization via "provider" plugins.
- This means OpenCode does **not** own the SSE parsing path at all — the AI SDK does.
- Result: very concise provider integration (a few lines per provider) but full
  dependency on AI SDK's release cycle.
- **No custom retry policy** visible in app code — defers to AI SDK defaults.

---

## 3. Context & Conversation History Management

This is the most important capability gap between Bosun and the reference tools.

### 3.1 Bosun Native

- **In-memory `Map<sessionId, { messages[] }>`**: each history entry is a typed
  object (`"user_message"`, `"assistant_message"`, `"function_call"`,
  `"function_call_output"`).
- History converts on the fly to Responses API `input[]` (via
  `historyEntryToResponsesInput`) or Chat messages (via `historyEntryToChatMessage`)
  before each API call.
- **No compaction or trimming.** History grows unboundedly for multi-turn sessions.
  When context window fills, the API returns a `max_tokens` error — the adapter
  emits `session.warn` but does not recover.
- **No persistence.** History is lost on process restart. ⚠️ **Critical gap.**

### 3.2 Claude Code — Compaction System

Claude Code has the most sophisticated context management of the four:

| Strategy | Trigger | Action |
|----------|---------|--------|
| `manual` | Explicit `/compact` slash command | User-initiated summarisation |
| `proactive` | Token count > soft threshold | Background summarisation run |
| `PTL` (pre-tool limit) | Approaching context limit before a tool call | Summarise before tool turn |
| `head_truncation` | Emergency: PTL failed and still over limit | Drop oldest messages |
| `minimal` | Only system + last user message survive | Last resort |

Implementation: `compact/compact.ts` calls Claude's own Messages API with a
summarisation meta-prompt to produce a condensed "checkpoint" that replaces the
head of the transcript. The JSONL transcript on disk tracks all full turns plus
compaction checkpoints.

**Token budget module** (`token-budget.ts`): tracks rolling input + output token
counts per turn, estimates remaining budget, signals when compaction is needed.

### 3.3 Codex CLI — Rollback Trimming

- `ContextManager` struct tracks turns and total token count.
- When the model returns `context_length_exceeded`, it **trims from the head**:
  removes the oldest assistant+tool+user turn group and retries the same request.
- Up to 3 rollback attempts; if still failing, surfaces error to user.
- No summarisation — purely truncative. Less quality-preserving than Claude Code
  but simpler and does not require an extra API call.

### 3.4 OpenCode — Overflow Detection

- `Session.run()` wraps `streamText`. When the AI SDK throws a context-overflow
  error, it triggers an automatic compaction via a "session summary" call.
- The session summary is written back to the SQLite `messages` table as a role
  `"summary"` message, replacing the trimmed segment.
- **Fork support**: each message row has `parent_id`; branching a session creates
  a new head referencing the same parent, enabling cheap conversation branches
  without copying history.

---

## 4. Session & Thread Persistence

| Feature | Bosun Native | Claude Code | Codex CLI | OpenCode |
|---------|-------------|-------------|-----------|----------|
| Persistence backend | None (in-memory only) | JSONL on disk | SQLite + JSONL | SQLite |
| List past sessions | ❌ | ✅ `~/.claude/projects/…` | ✅ via DB | ✅ |
| Resume after restart | ❌ | ✅ | ✅ | ✅ |
| Session branching/fork | ❌ | ❌ | ❌ | ✅ `parent_id` |
| Export transcript | ❌ | ✅ JSONL | ✅ JSONL export | ✅ via SQLite |
| Server-side thread (Responses API) | ❌ `previous_response_id` not used | N/A | ❌ (sends full `input[]`) | N/A |

**Bosun gap**: Bosun has a `workspace/` and `kanban/` subsystem that manages
task-level state in the Kanban board, but the native adapter has no integration
with it. The history `Map` is purely in-process.

**Opportunity**: the existing `task/` module's `archiveTask` and `createTaskContext`
could be the foundation of a per-task session transcript persisted alongside
task artefacts.

---

## 5. Tool Execution

### 5.1 Bosun Native

- `executeToolCalls(toolCalls, execOptions)` uses `Promise.allSettled` for parallel
  execution of all tools in a round.
- Dispatches to `execOptions.toolOrchestrator.executeTool()` or falls back to
  `execOptions.toolRunner.runTool()`.
- On tool error, wraps the exception as a JSON `{ error: "…" }` string returned
  to the model — allowing the LLM to self-correct.
- Max 16 rounds (`MAX_TOOL_ROUNDS`). After that, emits `session.warn` and stops.
- Emits `session.tool.start` / `session.tool.complete` events for UI live updates.
- **No auto-approval UI** built into the adapter. Approval is expected to flow
  via `toolOrchestrator` before the tool call reaches the adapter.

### 5.2 Claude Code

- `StreamingToolExecutor` in `tools/toolOrchestration.ts`:
  - Separates tools into **concurrent** (read-only, safe to parallelise) and
    **serial** (write/destructive, must run in order).
  - Concurrent tools run via `Promise.all` in the same batch.
  - Serial tools run sequentially after concurrent batch completes.
  - Result: better throughput for read-heavy workloads (e.g., search + read file).
- Tool approval prompt with `y/n/always` choices modifies a per-session approval
  set so subsequent calls to the same tool don't re-prompt.
- Hard cap: 5 auto-loops without user confirmation before pausing.

### 5.3 Codex CLI

- `ToolRunner` dispatches via `tokio::spawn` per tool — full async parallel.
- Pending approvals tracked as a `PendingApproval` queue surfaced to the UI (TUI).
- Sandbox escalation: if a tool call requires a privilege not granted at session
  start, it escalates to a new sandbox level (network-on, disk-write, etc.).
- Each tool's execution is wrapped in a `SubprocessExec` that can optionally run
  in a Docker container for full isolation.

### 5.4 OpenCode

- `tools.ts` `runTools(tools, step)` iterates tool calls in a `for` loop — **sequential
  by default**.
- "Doom-loop guard": if the same tool is called with the same arguments more than
  `MAX_CONSECUTIVE_TOOL_CALLS` (default 5) times in a row without generating any
  new text, the loop is terminated with an error surfaced to the user.
  ⚠️ Bosun only has `MAX_TOOL_ROUNDS` (a ceiling, not a loop-detection guard).
- Per-step cost and usage written to SQLite; allows cost breakdown by tool invocation.

---

## 6. Token Counting & Cost Tracking

| Feature | Bosun Native | Claude Code | Codex CLI | OpenCode |
|---------|-------------|-------------|-----------|----------|
| Live token estimation (pre-call) | ❌ | ✅ | ✅ | ✅ |
| Per-turn usage from API | ✅ normalised | ✅ | ✅ struct | ✅ per-step |
| Cumulative session usage | ✅ aggregated in adapter | ✅ rolling | ✅ struct | ✅ SQLite |
| Cost calculation | ❌ | ✅ cost-tracker.ts | ❌ (tokens only) | ✅ rate table |
| Cache token tracking | ✅ `cache_input_tokens` | ✅ `cache_creation_input_tokens` | ❌ not exposed | ❌ not tracked |
| Budget enforcement / hard stop | ❌ | ✅ via token-budget module | ❌ | ❌ |

**Bosun gap**: `provider-usage-normalizer.mjs` normalises `input_tokens`,
`output_tokens`, `cache_input_tokens`, and `costUsd` — but `costUsd` is always
`null` because no price-per-token table exists. A `provider-model-pricing.mjs`
module is needed.

---

## 7. Stream Event Model

### 7.1 Bosun Native Events

Events emitted via `execOptions.onEvent(…)`:

| Event | When |
|-------|------|
| `session.turn.start` | Before first API call in a turn |
| `session.stream.start` | First `response.created` or first SSE token |
| `session.stream.delta` | Each text delta |
| `session.stream.complete` | Stream closed |
| `session.tool.start` | Before each tool execution |
| `session.tool.complete` | After each tool execution |
| `session.warn` | `max_tokens` or `max_tool_rounds` hit |
| `session.turn.error` | Exception during turn |
| `session.turn.complete` | End of full turn including tool loop |

The `onEvent` callback is purely fire-and-forget with no back-pressure. Events
flow to `primary-agent.mjs` → `agent-event-bus.mjs` → UI SSE bridge.

### 7.2 Claude Code

Produces typed event stream via SDK callbacks:
`text`, `inputJson`, `toolUse`, `toolResult`, `message`, `usage`.
Events serialised to `EventEmitter` calls, UI subscribed via `Emitter.on(…)`.

### 7.3 Codex CLI

Produces Rust enum `AgentEvent` variants dispatched via `tokio::sync::mpsc` channel
to the TUI. Variants include `AssistantMessage`, `ToolCall`, `ToolCallOutput`,
`UsageUpdate`, `Error`. Strongly typed with no string event names.

### 7.4 OpenCode

Produces typed `StreamEvent` objects emitted via `EventEmitter` from the AI SDK.
UI subscribes via SSE endpoint (`GET /api/session/{id}/events`).
Events include `text-delta`, `tool-call`, `tool-result`, `step-finish`, `error`.

---

## 8. Error Handling & Recovery

| Feature | Bosun Native | Claude Code | Codex CLI | OpenCode |
|---------|-------------|-------------|-----------|----------|
| Network retry (429/503) | ❌ surface error | ✅ SDK handles | ✅ `RetryClient` | ✅ AI SDK handles |
| Context-overflow recovery | ❌ `session.warn` only | ✅ compaction | ✅ head rollback | ✅ auto-compact |
| Partial turn rollback on error | ✅ removes last entries | ✅ transcript checkpoint | ✅ state rollback | ❌ |
| Tool error → model self-correct | ✅ JSON `{error:…}` returned | ✅ | ✅ | ✅ |
| Doom-loop detection | ❌ (`MAX_TOOL_ROUNDS` only) | ❌ | ❌ | ✅ |
| Abort/cancel support | ✅ `AbortController` + idle timer | ✅ | ✅ cancel token | ✅ |
| Bad credential error message | Generic API error string | Custom error class | Typed enum | SDK error |

---

## 9. Auth & Credential Management

### 9.1 Bosun Native

`resolveCredentials(execOptions)` priority chain:

1. `execOptions.providerConfig.apiKey` (runtime override — not yet populated)
2. `execOptions.env.AZURE_OPENAI_API_KEY` (from `applyBoundCredentialEnv`)
3. `execOptions.env.OPENAI_API_KEY`
4. `process.env.*` fallback

**Known gap**: `provider-kernel.mjs` currently does **not** thread the resolved
env (from `applyBoundCredentialEnv`) into `execOptions.env` before calling
`targetAdapter.exec()`. Auth bindings (`authBindings.apiKeyEnv = "MY_CUSTOM_KEY"`)
therefore have no effect unless `MY_CUSTOM_KEY` in `process.env` happens to match
one of the canonical keys. See Phase 2 remediation below.

### 9.2 Reference tools

All three reference tools use a flat env-var model with well-documented canonical
names (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). None support dynamic credential
re-binding mid-session. Bosun's `authBindings` system is actually more flexible
than any reference implementation — it just needs the kernel integration fixed.

---

## 10. Memory & State Persistence

| Feature | Bosun Native | Claude Code | Codex CLI | OpenCode |
|---------|-------------|-------------|-----------|----------|
| Agent memory file | ❌ | ✅ `CLAUDE.md` markdown | ❌ | ✅ session summary |
| Workspace context injection | ✅ via `getSystemPrompt()` | ✅ `/init` reads codebase | ✅ at startup | ✅ `project-files` tool |
| Per-project memory | ✅ `bosun.config.json` prompts | ✅ `CLAUDE.md` per-repo | ❌ | ✅ project config |
| Cross-session recall | ❌ | ✅ via `CLAUDE.md` manual | ❌ | ⚠️ limited via summary |
| Shared workspace state | ✅ `workspace/shared-workspaces.json` | ❌ | ❌ | ❌ |

---

## 11. Performance & Concurrency

### 11.1 Bosun Native

- Single-process Node.js. Multiple adapters (codex-sdk, openai-native, codex-sdk
  for Claude) can run in parallel via the `shell-adapter-registry` singleton.
- `_busySet` prevents concurrent turns on the **same sessionId** — different
  sessions run fully concurrently.
- `Promise.allSettled` for tool calls: good enough for most tool sets.
- No streaming back-pressure handling — fast producers can fill `buffer` in
  `parseSseStream` indefinitely. In practice this is fine because the API
  controls the rate.

### 11.2 Reference tools

- **Claude Code**: single-session CLI — one concurrent request at a time by design.
- **Codex CLI**: `tokio` async — multiple sessions can run on the same process
  on separate tasks (e.g., fleet mode). Bounded via permit semaphore.
- **OpenCode**: `bun` server, HTTP-based multi-session. One `Session.run()` per
  client connection but coordinator limits concurrent sessions.

---

## 12. Gap Register — What Bosun Native Is Missing

Listed in order of priority for a production-grade native adapter.

### Priority 1 — Critical Gaps

| Gap | Impact | Remediation |
|-----|--------|-------------|
| **No context compaction** | Turns fail silently when context fills; user must restart | Add `compactSessionHistory(sessionId)` using a summarisation pass; trigger at `max_tokens` warn |
| **No auth-binding thread-through** | `authBindings` in harness executor config is silently ignored for native adapter | In `provider-kernel.mjs`, pass `resolvedEnv` from `buildSessionConfig` into `execOptions.env` |
| **No 429/503 retry** | Transient rate-limit errors surface as failures | Add a simple `retryFetch` wrapper with exponential back-off (3 attempts, 1s/2s/4s) |

### Priority 2 — High-Impact Improvements

| Gap | Impact | Remediation |
|-----|--------|-------------|
| **No session persistence** | Conversation history lost on restart; no session resume | Serialise `session.messages` to `task/` artefact store or `~/.bosun/sessions/` JSONL |
| **No cost tracking** | Cannot report cost to Kanban card or usage gauge | Add `agent/providers/provider-model-pricing.mjs` with per-model USD rates |
| **No doom-loop detection** | Model can call same tool N times with same args burning tokens | Count consecutive identical tool calls; abort if > 5 |
| **Previous-response-id threading** | Context sent in full every turn (expensive and slower) | For Responses API sessions, send `previous_response_id` instead of full `input[]` after turn 1 |

### Priority 3 — Quality-of-Life

| Gap | Impact | Remediation |
|-----|--------|-------------|
| **No live token estimate** | Cannot show "X tokens remaining" in UI before request | Count tokens client-side using `tiktoken-lite` or estimate by character length |
| **No concurrent+serial tool batching** | All tool calls parallelised — unsafe for write tools | Tag tools `parallel: false` in Bosun tool catalog; run serial tools after parallel batch completes |
| **No approval checkpoint** | Tools execute immediately without approval UX at adapter level | Expose `execOptions.requireApproval` callback; adapter calls it before each tool round |
| **No reasoning token tracking** | `o3`, `o4-mini` reasoning tokens not separately tracked | Parse `usage.output_tokens_details.reasoning_tokens` from Responses API completion |
| **No chat history size limit** | `session.messages` is unbounded | Cap at `MAX_HISTORY_MESSAGES` (e.g., 200); evict oldest but keep tool pairs intact |

---

## 13. What Bosun Does Better

Despite the gaps, Bosun's native adapter has advantages none of the reference tools share:

1. **Multi-provider** — single adapter handles Azure, OpenAI, Ollama, vLLM, and
   any OpenAI-compatible endpoint. Reference tools are each single-provider.

2. **Harness auth bindings** — `authBindings.apiKeyEnv` lets users map their own
   env-var name to the canonical API key, with no code change. More flexible than
   any reference tool.

3. **Bosun event bus** — `onEvent` callbacks integrate directly with the
   `agent-event-bus`, Kanban card updates, Telegram notifications, and the Mini
   App UI in a single pipeline. Reference tools each have isolated UIs.

4. **Provider driver model** — `agent/providers/*.mjs` files cleanly separate
   per-provider config (endpoint patterns, model catalog, auth heuristics) from
   the HTTP execution layer. Adding a new provider is 50 lines, not 500.

5. **Fleet coordination** — agent pool, workspace assignments, and task routing
   layers (`infra/monitor.mjs`, `agent/agent-pool.mjs`) are upstream of the
   adapter. All of this works with the native adapter today.

6. **No subprocess spawn** — codex-sdk and OpenCode both require spawning external
   processes. The native adapter has zero process overhead.

---

## 14. Recommended Roadmap

### Phase 1 (now — working baseline)
- ✅ SSE parsing for Responses API + Chat Completions 
- ✅ Tool call loop with parallel execution
- ✅ Per-session in-memory history
- ✅ Azure + OpenAI + compatible endpoint routing
- ✅ Auth headers (api-key / Bearer)
- ✅ Stream event emission for UI

### Phase 2 (auth + reliability)
- Thread `resolvedEnv` from `provider-kernel.mjs` into `execOptions.env`
- Add `retryFetch` with 3-attempt exponential back-off
- Add doom-loop detection (same tool + same args, N consecutive)

### Phase 3 (context management)
- On `max_tokens` warn: trigger automatic summarisation using a cheap model call
- Add `MAX_HISTORY_MESSAGES` cap
- Optionally use `previous_response_id` for Responses API turns

### Phase 4 (persistence + cost)
- Serialise session history to JSONL in `task/` artefacts
- Add `provider-model-pricing.mjs` (GPT-4o, o3, o4-mini, Claude rates)
- Record per-turn cost to Kanban card `usageMetadata`

### Phase 5 (advanced)
- Concurrent + serial tool batching (classify tools as `parallel: true/false`)
- Client-side token estimation with lightweight tokeniser
- Approval checkpoint callback before tool round

---

## 15. File Reference

| File | Role |
|------|------|
| [shell/openai-native-adapter.mjs](../shell/openai-native-adapter.mjs) | The native adapter (~930 lines) |
| [shell/shell-adapter-registry.mjs](../shell/shell-adapter-registry.mjs) | Registers `"openai-native"` entry |
| [agent/providers/openai-responses.mjs](../agent/providers/openai-responses.mjs) | Driver: `adapterId: "openai-native"` |
| [agent/providers/azure-openai-responses.mjs](../agent/providers/azure-openai-responses.mjs) | Driver: `adapterId: "openai-native"` |
| [agent/providers/openai-compatible.mjs](../agent/providers/openai-compatible.mjs) | Driver: `adapterId: "openai-native"` |
| [agent/providers/ollama.mjs](../agent/providers/ollama.mjs) | Driver: `adapterId: "openai-native"` |
| [agent/provider-registry.mjs](../agent/provider-registry.mjs) | Fallback chain updated for `openai-native` |
| [agent/providers/provider-usage-normalizer.mjs](../agent/providers/provider-usage-normalizer.mjs) | Normalises API usage objects |
| [agent/provider-kernel.mjs](../agent/provider-kernel.mjs) | Routes exec calls; Phase 2 will thread `resolvedEnv` here |
