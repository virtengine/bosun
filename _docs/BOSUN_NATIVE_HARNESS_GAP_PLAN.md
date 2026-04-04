# Bosun Native Harness — Comprehensive Gap Plan

**Date:** 2026-04-04  
**Scope:** Everything that Claude Code (anthropic), Codex CLI (Rust), and OpenCode (Vercel AI SDK)  
have that Bosun's internal native harness (`shell/openai-native-adapter.mjs` + supporting modules)  
is still missing or only partially implements.  

**Reference implementations:**
- Claude Code: `@anthropic-ai/claude-code`, TypeScript, Anthropic Messages API
- Codex CLI: `@openai/codex-sdk` internal, Rust `reqwest` + `tokio`
- OpenCode: `opencode.ai`, TypeScript, Vercel AI SDK `streamText`

---

## A. Context Shredding — How It Actually Works

**Short answer: it is 100% client-side preprocessing, not an API feature.**

Neither the OpenAI API, Anthropic API, Vercel AI SDK, nor any cloud provider has ever had
a built-in "shred old context" endpoint. The confusion is because the name sounds like it
might be server-side, and the AI SDK docs describe `pruneMessages` as a "utility"
without making it clear that it runs on *your* machine before the HTTP call.

### What "shredding" means in practice

Before Bosun calls the LLM API on turn N, it walks the conversation history and compresses
entries that are old enough to be less useful than their token cost:

```
Turn N-1 (1 turn ago):   Full output kept verbatim  
Turn N-3 (3 turns ago):  Tool output head+tail only (~8K chars)  
Turn N-6 (6 turns ago):  Tiny skeleton — tool name, args preview, total char count  
Turn N-10+ (very old):   "bosun --tool-log 42" retrieval ID only  
```

The full output is written to `.cache/tool-logs/<id>.json` BEFORE any truncation. The
agent can ask for the full text back if needed (`bosun --tool-log 42`). This is a key
difference from naive truncation: **no information is lost, it's archived**.

### Current state in the native harness

| Feature | Module | Status |
|---|---|---|
| `pruneMessages` (inline truncation) | `shell/message-pruner.mjs` | ✅ Wired — called before every API turn in `exec()` |
| AI-assisted summarisation (checkpoint) | `shell/context-compaction.mjs` | ✅ Wired — proactive + pre_tool + overflow |
| Tiered disk-backed compression (shredding) | `workspace/context-cache.mjs` | ⚠️ NOT wired to native adapter — only wired to `codex-shell.mjs` and `claude-shell.mjs` |

**Gap:** `workspace/context-cache.mjs`'s `maybeCompressSessionItems()` is called from the
SDK-backed shells but not from `openai-native-adapter.mjs`. The native adapter uses the
simpler inline truncation from `message-pruner.mjs` (max 8K per tool output). The tiered
age-based compression with disk archival that gives agents `bosun --tool-log` retrieval
is not in the native path.

---

## B. Cache-Read Optimization Patterns

### B.1 How each tool does it

#### Codex CLI (OpenAI Responses API)
- **Pattern: Server-side thread threading via `previous_response_id`.**  
  When a `previous_response_id` is supplied, OpenAI's servers already have the previous
  response's output. Only the new user turn is transmitted. Full prior history is served
  from server cache at the **cached-input token price** (~50% of standard input price).
- **Pattern: Automatic 1024-token prefix caching.**  
  OpenAI caches any prompt prefix ≥ 1024 tokens automatically for ~5 minutes. Codex ensures
  the most stable content (system instructions + tool schemas) is at the head of `input[]`
  so it qualifies for automatic caching.
- **Pattern: `store: true`.**  
  Codex always passes `store: true` for real sessions so the server retains the response
  for the next `previous_response_id` call.

**Bosun status (after Apr 2026 changes):**
- ✅ `previous_response_id` — wired since initial build
- ✅ `store: true` — **newly added** (passed when `isPersistent = true`)
- ✅ `instructions` field — **newly added** (system prompt extracted from `input[]` as stable prefix)
- ⚠️ No telemetry surfacing the cache ratio to the session event stream

#### Claude Code (Anthropic Messages API)
- **Pattern: Explicit `cache_control: { type: "ephemeral" }` on content blocks.**  
  Claude Code adds cache breakpoints at three locations every turn:
  1. The last content block in the system prompt array
  2. The last tool definition in the `tools` array
  3. Every 5th historical user message (as a conversation anchor)
- **Effect:** Anthropic caches all tokens before each breakpoint for 5 minutes (refresh
  on access). A 100K-token system prompt costs full price on turn 1, then ~10% of that
  on turns 2-N as long as the session stays active.
- **Pattern: `anthropic-beta: prompt-caching-2024-07-31` beta header** on early versions;
  now the standard API.

**Bosun status (after Apr 2026 changes):**
- ✅ System prompt `cache_control` on system message — **newly added** (activated by `promptCaching: true`)
- ✅ Last-tool `cache_control` — **newly added** (activated by `promptCaching: true`)
- ✅ History breakpoints — **newly added** (`injectHistoryCacheBreakpoints`, activated by `promptCaching: true`)
- ⚠️ `promptCaching` flag must be set by caller; no auto-detect based on model name
- ⚠️ `cache_creation_input_tokens` not separately tracked in usage normalizer

#### OpenCode (Vercel AI SDK)
- **Pattern: Defers entirely to AI SDK provider plugins.**  
  OpenCode's HTTP layer is the AI SDK's `streamText`; it doesn't write any cache headers
  or `cache_control` markers itself.
- The Anthropic provider in AI SDK 4.x added `cacheControl` support, but OpenCode doesn't
  explicitly opt into it for Anthropic messages — it relies on whatever the SDK defaults to.
- **Implicit caching only** — no explicit breakpoints, no tool-schema caching.

**Gap vs Bosun:** Bosun's explicit cache_control injection is actually *more sophisticated*
than OpenCode's approach once `promptCaching` is enabled.

### B.2 What's still missing in cache efficiency

| Gap | Priority | Notes |
|---|---|---|
| Auto-detect `promptCaching` from model name | Medium | Identify `claude-*`, `anthropic/*` routes and flip the flag automatically |
| Surface `cacheHitRatio` in `session.turn.complete` event | Medium | `cacheInputTokens / inputTokens` × 100 — valuable for cost dashboards |
| `cache_creation_input_tokens` separate field in usage normalizer | Low | Currently merged into `inputTokens`; Anthropic bills these differently |
| Warm-up call to prime server cache at session start | Low | Send a no-op "hello" request to pre-cache the system prompt on turn 0 |

---

## C. The Full Gap Register

### C.1 Session Persistence (CRITICAL)

**What others do:**
- Codex CLI: `~/.codex/sessions/<thread_id>.sqlite` — every turn persisted atomically
- Claude Code: JSONL transcript file per session at `~/.claude/projects/<id>/<session>.jsonl`
- OpenCode: Full SQLite DB with `conversations`, `messages`, `tool_calls`, `usage` tables

**Bosun native adapter:**
- Pure in-memory `Map<sessionId, session>`. Lost on process restart, redeploy, or crash.
- No cross-restart resumption. No session listing. No session browsing.

**Files to build:**
```
shell/session-store.mjs          — persistence driver (SQLite via `better-sqlite3` or JSONL)
shell/session-resume.mjs         — resume from persisted session state into openai-native-adapter
shell/session-list.mjs           — list/search/delete stored sessions
```

**Key design choices:**
- Use JSONL append-only (crash-safe, no dependency) as default; SQLite as opt-in for indexing
- Store: `session_id`, `model`, `messages[]` (full history), `created_at`, `updated_at`, `usage_total`
- The native adapter's `ensureSession()` should attempt to load from store before creating fresh

---

### C.2 MCP (Model Context Protocol) Integration (HIGH)

**What others do:**
- Claude Code: Full MCP client — discovers servers via `~/.claude/claude_desktop_config.json`,
  connects over stdio/SSE, exposes their tools as native tool definitions
- Codex CLI: MCP client baked into SDK — connects to servers defined in Codex config  
- OpenCode: Multiple MCP servers configured per project in `opencode.json`

**Why it matters:** MCP servers provide: filesystem access, web search, GitHub, Jira,
database queries, shell execution — all as typed tool definitions. Without MCP, the agent
only has the tools Bosun explicitly defines. With MCP, it inherits a growing ecosystem.

**Bosun status:** Zero MCP client support in the native adapter.  
Note: Bosun has `native/` directory that may have MCP stubs — needs audit.

**Files to build:**
```
shell/mcp-client.mjs             — MCP transport (stdio + SSE), tool schema fetch/cache
shell/mcp-registry.mjs           — server discovery from config files
agent/mcp-tool-adapter.mjs       — normalize MCP tool definitions → Bosun tool format
```

---

### C.3 Structured / Typed Output (MEDIUM)

**What others do:**
- Codex CLI: `schema` parameter → full JSON Schema passed to `response_format: { type: "json_schema" }`
  → guarantees well-typed output; validated client-side against the schema
- OpenCode (AI SDK): `generateObject()` / `z.object(...)` → Zod schema → JSON mode
- Claude Code: Explicit JSON extraction via tool calls with a single `submit_result` tool

**Bosun status:** No `response_format` support. All output is free-form text.

**Action:** Add `pc.responseFormat` / `execOptions.responseFormat` → include in request body.  
For `json_schema` mode, validate the parsed JSON against the schema and surface schema
errors as `session.warn` events with structured diff.

---

### C.4 Multi-Modal Inputs — Images / Files (MEDIUM)

**What others do:**
- Claude Code: Image content blocks in user messages (`{ type: "image", source: { type: "base64", ... } }`)
- Codex CLI: Supports image URL inputs in the Responses API `input[]`
- OpenCode (AI SDK): `DataContent` image attachments via AI SDK message parts

**Bosun status:** All user messages are `.text` strings only. No support for images,
file attachments, or structured content blocks.

**Files to build:**
```
shell/content-builder.mjs        — build multi-part content arrays (text + image + file)
```

**Change:** `historyEntryToResponsesInput` / `historyEntryToChatMessage` need to handle
`entry.content[]` arrays when present, not just `entry.text` strings.

---

### C.5 Hard Cost Budget Enforcement (MEDIUM)

**What others do:**
- Claude Code: `maxCost` option → throws `BudgetExceededError` when cumulative session
  cost exceeds the limit. Checked after every `response.completed` event.
- Codex CLI: `--max-tokens` / `--budget` flags → abort session on exceeded threshold

**Bosun status:** Cost is TRACKED (`aggregatedUsage.costUsd`) but never ENFORCED.
A runaway agent can spend unlimited funds in a single session.

**Action:** In `exec()`, after each turn, check:
```js
if (maxCostUsd && aggregatedUsage.costUsd > maxCostUsd) {
  throw new BudgetExceededError(`Session cost $${aggregatedUsage.costUsd.toFixed(4)} exceeded limit $${maxCostUsd}`);
}
```
Expose `maxCostUsd` via `execOptions.maxCostUsd` and emit `session.budget.exceeded` event
before throwing so callers can surface it in the UI.

---

### C.6 Live Token Budget Surfacing (MEDIUM)

**What others do:**
- Claude Code: Emits `usage` events with `input_tokens`, `output_tokens`, `cache_creation_tokens`,
  `cache_read_tokens` after every response. TUI shows a live cost meter.
- Codex CLI: Context window percentage shown in status line during agentic runs
- OpenCode: Token/cost overlay in the UI

**Bosun status:** `session.turn.complete` emits `usage` and `tokenBudget` — these exist.  
Gap: The %used, cache hit ratio, and session cumulative cost are not emitted mid-stream.

**Action:** Emit `session.budget.update` between tool rounds with:
```js
{ usedTokens, contextWindow, usedPct, cacheHitPct, cumulativeCostUsd }
```

---

### C.7 Mid-Turn Interruption and Steering (MEDIUM)

**What others do:**
- Claude Code: `type: "user"` message with `parent_tool_use_id: null` can be injected
  mid-stream via the Agent SDK's streaming input API. The model receives it as an
  interrupt and can course-correct without the current tool round completing.
- Codex CLI: `/interrupt` command during a stream → clean abort with partial output retained
- OpenCode: `interrupt()` method on the stream handle

**Bosun status:** `abortController.abort()` cancels the entire turn. There's no way to
inject a correction mid-stream. The session is left in a broken state after abort.

**Action required:**
1. After abort, don't pop the last `user_message` from history — keep it with a flag `aborted: true`
2. On next `exec()` call with the same session, detect the aborted state and insert a
   synthetic assistant message `"(previous turn was interrupted)"` to keep the history valid
3. Future: implement streaming input queue for real mid-stream inject

---

### C.8 `/resume`, `/undo`, `/clear` Slash Commands (LOW-MEDIUM)

**What others do:**
- Claude Code: `/undo` removes the last assistant turn from history
- Claude Code: `/clear` wipes session history but keeps the system prompt
- OpenCode: Full conversation management UI

**Bosun status:** Only `/compact` is implemented. No undo/clear/resume.

**Actions:**
- `/undo` → pop last 2 entries (user_message + assistant_message) from session
- `/clear` → reset `session.messages = []`, keep `session.model` and `session.lastResponseId = null`
- `/resume <session_id>` → load from session store (requires C.1)
- `/status` → emit current `tokenBudget`, `compactionCount`, `model`, `cumulativeCost`

---

### C.9 Extended Thinking Budget Control (LOW-MEDIUM)

**What others do:**
- Claude Code: `thinkingBudgetTokens` → sets `"thinking": { "type": "enabled", "budget_tokens": N }`
  in the Anthropic Messages API request. Explicit control over how much Claude "thinks"
  before responding — higher budget = better reasoning, higher cost.
- Codex CLI: `reasoning.effort` → `"low" | "medium" | "high"` (already partial in Bosun)

**Bosun status:**
- `reasoningEffort` field (low/medium/high) → supported in both `buildResponsesRequest`
  and `buildChatRequest` ✅
- Anthropic `thinking.budget_tokens` integer → NOT supported. Falls through to effort string only.

**Action:** When `pc.thinkingBudget` (a number) is set and the provider path goes through
an Anthropic-compatible endpoint, emit `thinking: { type: "enabled", budget_tokens: N }`
instead of the effort string.

---

### C.10 `onStepFinish` Callback (LOW)

**What the AI SDK does:**
The Vercel AI SDK's `streamText()` fires `onStepFinish(stepResult)` after every
complete tool-call round (LLM response + tool execution). `stepResult` includes:
`text`, `toolCalls`, `toolResults`, `finishReason`, `usage`, `isContinued`.

**Bosun status:** Has `onEvent` callbacks (`session.turn.start`, `session.stream.delta`,
`session.stream.complete`), but no unified "step is done" event that packages all of
`turnResult + toolResults` together.

**Action:** After each tool-call round completes and tool results are appended, emit:
```js
onEvent?.({ type: "session.step.finish", sessionId, stepNumber: roundCount,
  text: finalText, toolCalls: turnResult.toolCalls, toolResults,
  stopReason, usage: turnResult.usage, isContinued: hasMoreRounds })
```

---

### C.11 Auto-Detect `promptCaching` from Model Name (LOW)

**Current state:** `promptCaching` must be explicitly set by the caller.  
**Desired:** Automatically enable when the model is an Anthropic model:

```js
function shouldEnablePromptCaching(providerConfig, execOptions) {
  const pc = providerConfig ?? {};
  if (pc.promptCaching != null) return Boolean(pc.promptCaching);
  const model = String(pc.model || execOptions?.model || "").toLowerCase();
  return model.startsWith("claude-") || String(pc.provider || "").toLowerCase() === "anthropic";
}
```

---

### C.12 Native Anthropic Messages API Adapter (LOW — STRATEGIC)

**What this means:** Currently the native adapter speaks OpenAI format only. Claude
requests must go through an OpenAI-compatible proxy (OpenRouter, Azure AI Studio, etc.)
which adds latency and loses Anthropic-specific features.

**What's missing by using a proxy:**
- Native `thinking` blocks with proper block streaming
- `cache_creation_input_tokens` vs `cache_read_input_tokens` separation
- Streaming event model (`content_block_start`, `content_block_delta`, etc.)
- Extended thinking with explicit `thinking` content type

**Files to build:**
```
shell/anthropic-native-adapter.mjs   — native Anthropic Messages API adapter
                                       (mirrors openai-native-adapter structure)
shell/shell-adapter-registry.mjs     — route claude-* models to anthropic adapter
```

---

### C.13 Tiered Disk-Backed Shredding in Native Adapter (LOW)

**Current:** `message-pruner.mjs` truncates old tool outputs to 8K chars inline.  
**Missing:** The tiered age-based compression with disk archival from `workspace/context-cache.mjs`.

**The difference:**
- `message-pruner`: uniform 8K cap on all non-tail outputs → information is silently lost
- `context-cache`: Tier 0 (full) → Tier 1 (light) → Tier 2 (moderate) → Tier 3 (skeleton + disk ID)
  → full output archived, agent can retrieve with `bosun --tool-log <id>`

**Action:** Wire `maybeCompressSessionItems()` into the native adapter's pre-send path,
called alongside (or replacing) the pure `pruneMessages` `truncateOutputs` step.

---

### C.14 Parallel Sub-Agent Spawning (FUTURE)

**What Claude Code does:**
- `mcp__claude__task` tool with `description` → spawns a sub-agent with its own context
- Sub-agent runs to completion; parent receives final output as a tool result
- Enables: parallel file editing, independent research subtasks, code review + implementation

**What Codex does:**
- `launch_agent` tool → subprocess with its own context and tool set

**Bosun status:** No sub-agent spawning. Every agent call is single-threaded sequential.

**Note:** Bosun has `agent/fleet-coordinator.mjs` — this may be the foundation.  
This is a FUTURE item; requires the session store (C.1) and MCP client (C.2) first.

---

### C.15 Computer Use / Browser Tool (FUTURE)

- Anthropic's `computer_use` tools
- Playwright integration for browser automation  
- Not in scope until foundation items (C.1 through C.5) are solid

---

## D. Implementation Priority Queue

### Tier 1 — Do Next (High Impact, Manageable Scope)

| # | Item | Module | Effort |
|---|---|---|---|
| D.1 | Session persistence (JSONL, no deps) | `shell/session-store.mjs` | Medium |
| D.2 | Auto-detect `promptCaching` from model | `openai-native-adapter.mjs` | Small |
| D.3 | Hard cost budget enforcement | `openai-native-adapter.mjs` | Small |
| D.4 | `session.step.finish` event | `openai-native-adapter.mjs` | Small |
| D.5 | `/undo`, `/clear`, `/status` slash commands | `openai-native-adapter.mjs` | Small |
| D.6 | Surface `cacheHitPct` in usage events | `openai-native-adapter.mjs` | Small |

### Tier 2 — High Value, More Work

| # | Item | Module | Effort |
|---|---|---|---|
| D.7 | MCP client (stdio transport) | `shell/mcp-client.mjs` | Large |
| D.8 | Structured output / `response_format` | `openai-native-adapter.mjs` + builder | Medium |
| D.9 | Session resume from disk | `shell/session-resume.mjs` | Medium |
| D.10 | Wire tiered shredding to native adapter | `openai-native-adapter.mjs` | Small (wiring only) |
| D.11 | Anthropic `thinking.budget_tokens` | `openai-native-adapter.mjs` | Small |
| D.12 | Clean interrupt-with-partial-retain | `openai-native-adapter.mjs` | Medium |

### Tier 3 — Strategic / Future

| # | Item | Effort |
|---|---|---|
| D.13 | Native Anthropic Messages API adapter | Large |
| D.14 | Multi-modal (image) inputs | Medium |
| D.15 | Sub-agent spawning | Large |
| D.16 | Computer use / browser tool | XL |
| D.17 | OTEL tracing | Medium |

---

## E. What Bosun Native Harness ALREADY Has (vs Others)

This is the "we're actually ahead" register — capabilities that are NOT in Claude Code, Codex, or OpenCode:

| Capability | Notes |
|---|---|
| **5-strategy context compaction** | proactive / pre_tool / rollback / head_truncate / minimal — Claude Code has 3; Codex has 1 |
| **`previous_response_id` threading** | Codex has it; Claude Code doesn't (it's OpenAI-only) |
| **Doom-loop detection** | Tool call patterns recognized; no equivalent in Claude Code or OpenCode |
| **Tool-call repair** | AI SDK pattern but implemented natively — Claude Code doesn't repair broken tool calls |
| **Smooth streaming** | word/line/regex chunking with back-pressure — Claude Code's streaming is raw byte chunks |
| **Stop conditions + prepareStep** | Step-level model/tool overrides — not in Claude Code; is in AI SDK but OpenCode doesn't expose it |
| **Per-provider pricing at estimate time** | 80 model entries with cache math; others hard-code or omit |
| **Multi-provider in one adapter** | OpenAI + Azure + any OAI-compat in a single adapter; Codex is OpenAI-only, Claude Code is Anthropic-only |
| **Message pruner (reasoning strip)** | Removes old reasoning tokens from non-tail turns; Codex and Claude Code don't do this |

---

## F. Quick-Reference: Cache-Read Activation Guide

```js
// OpenAI / Azure (Responses API) — automatic after Apr 2026 changes:
{
  providerConfig: {
    model: "gpt-4.1",
    systemPrompt: "You are a senior engineer...",  // → emitted as instructions= field
    // store: true is added automatically when the session has a sessionId
  }
}

// Anthropic / OpenRouter Claude (Chat Completions path):
{
  providerConfig: {
    model: "claude-3-7-sonnet-20250219",
    systemPrompt: "You are a senior engineer...",
    promptCaching: true,  // enables cache_control on system/tools/history
  }
}

// Check cache efficiency in session.turn.complete:
onEvent: (ev) => {
  if (ev.type === "session.turn.complete") {
    const { inputTokens, cacheInputTokens } = ev.usage ?? {};
    const hitPct = inputTokens > 0 ? ((cacheInputTokens / inputTokens) * 100).toFixed(1) : "0";
    console.log(`Cache hit: ${hitPct}% (${cacheInputTokens}/${inputTokens} input tokens)`);
  }
}
```
