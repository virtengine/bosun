/**
 * task-assessment.mjs — Codex/Copilot SDK-powered task lifecycle assessment.
 *
 * Provides intelligent decision-making for task lifecycle events:
 *   1. Should we merge this PR?
 *   2. Should we reprompt the same agent session?
 *   3. Should we start a new session (same agent)?
 *   4. Should we start a completely new attempt (different agent)?
 *   5. What EXACTLY should the prompt say?
 *
 * Unlike merge-strategy.mjs (which only runs post-completion), this module
 * provides continuous assessment throughout the task lifecycle — including
 * during rebase failures, idle detection, and post-merge downstream effects.
 *
 * Decisions are structured JSON with dynamic prompt generation.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

// ── Valid lifecycle actions ──────────────────────────────────────────────────

const VALID_ACTIONS = new Set([
  "merge", // PR is ready — merge when CI passes
  "reprompt_same", // Send follow-up to the SAME agent session
  "reprompt_new_session", // Kill current session, start fresh session (same attempt)
  "new_attempt", // Abandon attempt entirely, start fresh attempt with new agent
  "wait", // Wait N seconds then re-assess
  "manual_review", // Escalate to human
  "close_and_replan", // Close PR, move task back to todo for replanning
  "accept_with_debt", // Accept partial outcome and record explicit debt items
  "split_task", // Split oversized/failing scope into actionable child tasks
  "escalate_to_replan", // Escalate the task back to planner/replan lane
  "noop", // No action needed
]);

function normalizeUpstreamRef(value) {
  const raw = String(value || "").trim();
  if (!raw) return "origin/main";
  return raw.replace(/^refs\/remotes\//i, "").replace(/^remotes\//i, "");
}

// ── Dedup / rate limiting ───────────────────────────────────────────────────

/** @type {Map<string, number>} taskId → last assessment timestamp */
const assessmentDedup = new Map();
const ASSESSMENT_COOLDOWN_MS = 5 * 60 * 1000; // 5 min per task

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * @typedef {object} TaskAssessmentContext
 * @property {string}   taskId            - Task UUID
 * @property {string}   taskTitle         - Task title
 * @property {string}   [taskDescription] - Task description
 * @property {string}   attemptId         - Attempt UUID
 * @property {string}   shortId           - Short ID for logging
 * @property {string}   trigger           - What triggered the assessment
 *   ("rebase_failed", "idle_detected", "pr_merged_downstream", "agent_completed",
 *    "agent_failed", "ci_failed", "conflict_detected", "manual_request")
 * @property {string}   [branch]          - Branch name
 * @property {string}   [upstreamBranch]  - Target/base branch
 * @property {string}   [agentLastMessage] - Last message from agent
 * @property {string}   [agentType]       - "codex" or "copilot"
 * @property {number}   [attemptCount]    - Number of attempts so far
 * @property {number}   [sessionRetries]  - Number of session retries
 * @property {number}   [prNumber]        - PR number if exists
 * @property {string}   [prState]         - PR state
 * @property {string}   [ciStatus]        - CI status
 * @property {string}   [rebaseError]     - Error message from failed rebase
 * @property {string[]} [conflictFiles]   - List of conflicted files
 * @property {string}   [diffStat]        - Git diff stats
 * @property {number}   [commitsAhead]    - Commits ahead of upstream
 * @property {number}   [commitsBehind]   - Commits behind upstream
 * @property {number}   [taskAgeHours]    - How old the task is in hours
 * @property {string[]} [acceptanceCriteria] - Task acceptance criteria checklist
 * @property {Array<string|{id?: string, title?: string, description?: string, status?: string, blocking?: boolean, required?: boolean, satisfied?: boolean}>} [successCriteria]
 * @property {{status?: string, summary?: string, completionRatio?: number, completedCriteriaCount?: number, totalCriteriaCount?: number}} [goalProgress]
 * @property {{status?: string, blocked?: boolean, approvalPending?: boolean, violations?: Array<object>}} [constraintState]
 * @property {{status?: string, budgetTokens?: number, inputTokens?: number, outputTokens?: number, totalTokens?: number, remainingTokens?: number, approvalRequired?: boolean}} [tokenBudget]
 * @property {{successCriteria?: Array<object>, goalProgress?: object, constraintState?: object, tokenBudget?: object}} [objectiveFrame]
 * @property {object}   [previousDecisions] - History of past decisions for this task
 */

/**
 * @typedef {object} TaskAssessmentDecision
 * @property {boolean} success    - Whether assessment completed
 * @property {string}  action     - One of VALID_ACTIONS
 * @property {string}  [prompt]   - Dynamic prompt to send (for reprompt_same/reprompt_new_session)
 * @property {string}  [reason]   - Explanation for the decision
 * @property {number}  [waitSeconds] - For "wait" action
 * @property {string}  [agentType]   - Preferred agent for new_attempt ("codex" | "copilot")
 * @property {Array<{type?: string, severity?: string, description?: string, criterion?: string}>} [debtItems]
 * @property {Array<{title: string, description?: string, acceptance_criteria?: string[], priority?: string, tags?: string[]}>} [splitTasks]
 * @property {{successCriteria: Array<object>, goalProgress: object | null, constraintState: object | null, tokenBudget: object | null, blocked: boolean}} [objectiveFrame]
 * @property {string}  rawOutput  - Raw SDK output for audit
 */

// ── Prompt builder ──────────────────────────────────────────────────────────

/**
 * Build the assessment prompt based on the trigger and context.
 */
function buildAssessmentPrompt(ctx) {
  const parts = [];

  parts.push(`# Task Lifecycle Assessment

You are an expert autonomous engineering orchestrator. You must decide the BEST next action
for a task based on the context below. Your goal is to maximize task completion rate while
minimizing wasted compute.

## Trigger
**Event:** ${ctx.trigger}
**Timestamp:** ${new Date().toISOString()}

## Task Context`);

  if (ctx.taskTitle) parts.push(`**Task:** ${ctx.taskTitle}`);
  if (ctx.taskDescription) {
    parts.push(`**Description:** ${ctx.taskDescription.slice(0, 3000)}`);
  }
  if (Array.isArray(ctx.acceptanceCriteria) && ctx.acceptanceCriteria.length) {
    parts.push(
      [
        "## Acceptance Criteria",
        ...ctx.acceptanceCriteria
          .slice(0, 20)
          .map((criterion) => `- ${String(criterion || "").trim()}`)
          .filter((line) => line !== "-"),
      ].join("\n"),
    );
  }
  const objectiveFrame = normalizeObjectiveFrame(ctx.objectiveFrame || ctx, {
    acceptanceCriteria: ctx.acceptanceCriteria,
    successCriteria: ctx.successCriteria,
    goalProgress: ctx.goalProgress,
    constraintState: ctx.constraintState,
    tokenBudget: ctx.tokenBudget,
  });
  if (Array.isArray(objectiveFrame?.successCriteria) && objectiveFrame.successCriteria.length) {
    parts.push(
      [
        "## Explicit Success Criteria",
        ...objectiveFrame.successCriteria
          .slice(0, 20)
          .map((criterion) => {
            const status = criterion.status ? ` [${criterion.status}]` : "";
            const blocking = criterion.blocking ? " (blocking)" : "";
            const details = criterion.description ? ` - ${criterion.description}` : "";
            return `- ${criterion.title}${status}${blocking}${details}`;
          }),
      ].join("\n"),
    );
  }
  if (objectiveFrame?.goalProgress) {
    parts.push(
      [
        "## Goal Progress",
        `- Status: ${objectiveFrame.goalProgress.status || "unknown"}`,
        `- Completion: ${objectiveFrame.goalProgress.completedCriteriaCount ?? 0}/${objectiveFrame.goalProgress.totalCriteriaCount ?? 0}`,
        objectiveFrame.goalProgress.completionRatio != null
          ? `- Completion ratio: ${Math.round(objectiveFrame.goalProgress.completionRatio * 100)}%`
          : "",
        objectiveFrame.goalProgress.summary ? `- Summary: ${objectiveFrame.goalProgress.summary}` : "",
      ].filter(Boolean).join("\n"),
    );
  }
  if (objectiveFrame?.constraintState) {
    parts.push(
      [
        "## Constraints",
        `- Status: ${objectiveFrame.constraintState.status || "unknown"}`,
        `- Blocked: ${objectiveFrame.constraintState.blocked === true ? "yes" : "no"}`,
        `- Violations: ${objectiveFrame.constraintState.violationCount || 0} (${objectiveFrame.constraintState.blockingViolationCount || 0} blocking)`,
        ...objectiveFrame.constraintState.violations
          .slice(0, 10)
          .map((violation) => `- ${violation.constraintId}: ${violation.message || violation.type || "constraint violation"}`),
      ].join("\n"),
    );
  }
  if (objectiveFrame?.tokenBudget) {
    parts.push(
      [
        "## Token Budget",
        `- Status: ${objectiveFrame.tokenBudget.status || "unknown"}`,
        objectiveFrame.tokenBudget.budgetTokens != null ? `- Budget tokens: ${objectiveFrame.tokenBudget.budgetTokens}` : "",
        `- Used tokens: ${objectiveFrame.tokenBudget.totalTokens || 0}`,
        objectiveFrame.tokenBudget.remainingTokens != null ? `- Remaining tokens: ${objectiveFrame.tokenBudget.remainingTokens}` : "",
        objectiveFrame.tokenBudget.utilizationRatio != null
          ? `- Utilization: ${Math.round(objectiveFrame.tokenBudget.utilizationRatio * 100)}%`
          : "",
      ].filter(Boolean).join("\n"),
    );
  }
  if (ctx.branch) parts.push(`**Branch:** ${ctx.branch}`);
  if (ctx.upstreamBranch)
    parts.push(`**Upstream/Base:** ${ctx.upstreamBranch}`);
  if (ctx.agentType) parts.push(`**Agent:** ${ctx.agentType}`);
  if (ctx.attemptCount != null)
    parts.push(`**Attempt #:** ${ctx.attemptCount}`);
  if (ctx.sessionRetries != null)
    parts.push(`**Session Retries:** ${ctx.sessionRetries}`);
  if (ctx.taskAgeHours != null)
    parts.push(`**Task Age:** ${ctx.taskAgeHours.toFixed(1)}h`);

  // Trigger-specific context
  if (ctx.trigger === "rebase_failed" && ctx.rebaseError) {
    parts.push(`
## Rebase Failure Details
\`\`\`
${ctx.rebaseError.slice(0, 4000)}
\`\`\``);
    if (ctx.conflictFiles?.length) {
      parts.push(`
### Conflicted Files
${ctx.conflictFiles.map((f) => `- ${f}`).join("\n")}`);
    }
  }

  if (ctx.trigger === "pr_merged_downstream") {
    parts.push(`
## Downstream Impact
A PR was just merged into the upstream branch (${ctx.upstreamBranch}).
This task's branch needs to be rebased to incorporate the changes.
The rebase ${ctx.rebaseError ? "FAILED" : "has not been attempted yet"}.`);
  }

  // Agent's last message
  if (ctx.agentLastMessage) {
    parts.push(`
## Agent's Last Message
\`\`\`
${ctx.agentLastMessage.slice(0, 6000)}
\`\`\``);
  }

  // PR details
  if (ctx.prNumber) {
    parts.push(`
## Pull Request
- PR #${ctx.prNumber}
- State: ${ctx.prState || "unknown"}
- CI: ${ctx.ciStatus || "unknown"}`);
  }

  // Diff context
  if (ctx.commitsAhead != null || ctx.commitsBehind != null) {
    parts.push(`
## Branch Status
- Commits ahead: ${ctx.commitsAhead ?? "unknown"}
- Commits behind: ${ctx.commitsBehind ?? "unknown"}`);
  }

  if (ctx.diffStat) {
    parts.push(`
### Diff Stats
\`\`\`
${ctx.diffStat.slice(0, 2000)}
\`\`\``);
  }

  // Decision history
  if (ctx.previousDecisions) {
    const history = JSON.stringify(ctx.previousDecisions, null, 2).slice(
      0,
      1500,
    );
    parts.push(`
## Previous Decisions
\`\`\`json
${history}
\`\`\``);
  }

  // Decision framework — adapted per trigger
  parts.push(`
## Decision Rules

Choose ONE action based on the trigger "${ctx.trigger}":

### Actions Available

1. **merge** — The PR is ready to merge. Agent completed the work, CI passing or expected to pass.
   Generate: \`{ "action": "merge", "reason": "..." }\`

2. **reprompt_same** — Send a SPECIFIC follow-up message to the same agent session.
   The agent is still running and can receive messages. Use when:
   - Small fix needed (lint error, missing test, typo)
   - Rebase conflict on files the agent can resolve
   - Agent needs to push their changes
   Generate: \`{ "action": "reprompt_same", "prompt": "SPECIFIC instructions for the agent...", "reason": "..." }\`

3. **reprompt_new_session** — Kill current session, start fresh with the same task.
   Use when:
   - Agent's context window is exhausted
   - Agent is stuck in a loop
   - Session has accumulated too many errors
   - Rebase failed and agent needs a clean start to resolve
   Generate: \`{ "action": "reprompt_new_session", "prompt": "SPECIFIC task instructions for fresh session...", "reason": "..." }\`

4. **new_attempt** — Completely fresh attempt, potentially different agent type.
   Use when:
   - Multiple session retries have failed (>2)
   - Agent consistently misunderstands the task
   - Need to switch between Codex and Copilot
   Generate: \`{ "action": "new_attempt", "reason": "...", "agentType": "codex"|"copilot" }\`

5. **wait** — Re-assess after N seconds.
   Use when: CI running, rebase in progress, agent actively working.
   Generate: \`{ "action": "wait", "waitSeconds": 300, "reason": "..." }\`

6. **manual_review** — Escalate to human.
   Use when: Security-sensitive changes, complex conflicts, repeated failures.
   Generate: \`{ "action": "manual_review", "reason": "..." }\`

7. **close_and_replan** — Close PR, move task back to backlog for replanning.
   Use when: Approach is fundamentally wrong, task needs rethinking.
   Generate: \`{ "action": "close_and_replan", "reason": "..." }\`

8. **accept_with_debt** — Mark task as acceptable but incomplete.
   Use when: Core objective is met but explicit gaps remain that should be tracked.
   Generate: \`{ "action": "accept_with_debt", "reason": "...", "debtItems": [{"type":"missing_functionality","severity":"medium","description":"..."}] }\`

9. **split_task** — Split into smaller sub-tasks and re-queue.
   Use when: Scope is too broad or repeated failures indicate decomposition is needed.
   Generate: \`{ "action": "split_task", "reason": "...", "splitTasks": [{"title":"...", "description":"...", "acceptance_criteria":["..."], "priority":"medium", "tags":["split"]}] }\`

10. **escalate_to_replan** — Escalate to planning lane for DAG-level changes.
   Use when: Local retries are exhausted and task needs a larger plan revision.
   Generate: \`{ "action": "escalate_to_replan", "reason": "..." }\`

11. **noop** — No action needed.
   Generate: \`{ "action": "noop", "reason": "..." }\`

### CRITICAL Rules for Prompt Generation

When generating prompts (for reprompt_same or reprompt_new_session), the prompt MUST:
- Be SPECIFIC — include file names, error messages, exact instructions
- Include the task context — the agent may have lost context
- For rebase failures: instruct the agent to resolve specific conflicts
- For CI failures: paste the error output and tell the agent what to fix
- NEVER be generic like "please fix the issues" — that wastes compute time

## Response Format

Respond with ONLY a JSON object:

\`\`\`json
{
  "action": "reprompt_same",
  "prompt": "The merge with origin/staging failed with conflicts in go.sum and pnpm-lock.yaml. Run 'git checkout --theirs go.sum pnpm-lock.yaml && git add go.sum pnpm-lock.yaml && git merge --continue' to resolve. Then run tests and push.",
  "reason": "Merge conflict on auto-resolvable lock files. Agent can fix in current session."
}
\`\`\`

RESPOND WITH ONLY THE JSON OBJECT.`);

  return parts.join("\n");
}

// ── JSON extraction (shared pattern with merge-strategy.mjs) ────────────────

function extractDecisionJson(raw) {
  if (!raw || typeof raw !== "string") return null;

  const seenStrings = new Set();

  const hasAction = (value) =>
    value &&
    typeof value === "object" &&
    typeof value.action === "string";

  const tryParseJson = (text) => {
    if (typeof text !== "string") return null;
    const trimmed = text.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  };

  const collectJsonObjectCandidates = (text) => {
    if (typeof text !== "string") return [];
    const candidates = [];
    for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = start; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (ch === "\\") {
            escaped = true;
            continue;
          }
          if (ch === "\"") {
            inString = false;
          }
          continue;
        }
        if (ch === "\"") {
          inString = true;
          continue;
        }
        if (ch === "{") {
          depth += 1;
          continue;
        }
        if (ch === "}") {
          depth -= 1;
          if (depth === 0) {
            candidates.push(text.slice(start, i + 1));
            break;
          }
        }
      }
    }
    return candidates;
  };

  const buildEnvelopeCandidates = (value) => {
    const candidates = [];
    if (value == null) return candidates;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) candidates.push(trimmed);
      return candidates;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        candidates.push(...buildEnvelopeCandidates(entry));
      }
      return candidates;
    }
    if (typeof value === "object") {
      const nestedKeys = [
        "finalResponse",
        "output",
        "text",
        "message",
        "content",
        "response",
        "result",
        "data",
        "value",
      ];
      for (const key of nestedKeys) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          candidates.push(...buildEnvelopeCandidates(value[key]));
        }
      }
      if (Array.isArray(value.items)) {
        for (const item of value.items) {
          if (!item || typeof item !== "object") continue;
          if (typeof item.text === "string") candidates.push(item.text);
          if (typeof item.content === "string") candidates.push(item.content);
          if (typeof item.message === "string") candidates.push(item.message);
          if (Array.isArray(item.content)) {
            for (const part of item.content) {
              if (!part || typeof part !== "object") continue;
              if (typeof part.text === "string") candidates.push(part.text);
              if (typeof part.content === "string") candidates.push(part.content);
              if (typeof part.value === "string") candidates.push(part.value);
            }
          }
        }
      }
    }
    return candidates;
  };

  const inspect = (value) => {
    if (value == null) return null;
    if (hasAction(value)) return value;

    if (Array.isArray(value)) {
      for (const item of value) {
        const parsed = inspect(item);
        if (parsed) return parsed;
      }
      return null;
    }

    if (typeof value === "object") {
      const candidates = buildEnvelopeCandidates(value);
      for (const candidate of candidates) {
        const parsed = inspect(candidate);
        if (parsed) return parsed;
      }
      return null;
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed || seenStrings.has(trimmed)) return null;
      seenStrings.add(trimmed);

      const directParsed = tryParseJson(trimmed);
      if (directParsed) {
        const decision = inspect(directParsed);
        if (decision) return decision;
      }

      let fenceCursor = 0;
      while (fenceCursor < trimmed.length) {
        const open = trimmed.indexOf("```", fenceCursor);
        if (open === -1) break;
        const headerEnd = trimmed.indexOf("\n", open + 3);
        if (headerEnd === -1) break;
        const close = trimmed.indexOf("```", headerEnd + 1);
        if (close === -1) break;
        const fenced = trimmed.slice(headerEnd + 1, close).trim();
        if (fenced && !seenStrings.has(fenced)) {
          seenStrings.add(fenced);
          const parsedFence = tryParseJson(fenced);
          if (parsedFence) {
            const decision = inspect(parsedFence);
            if (decision) return decision;
          }
        }
        fenceCursor = close + 3;
      }

      for (const candidate of collectJsonObjectCandidates(trimmed)) {
        if (!candidate || seenStrings.has(candidate)) continue;
        seenStrings.add(candidate);
        const parsedCandidate = tryParseJson(candidate);
        if (parsedCandidate) {
          const decision = inspect(parsedCandidate);
          if (decision) return decision;
        }
      }
    }
    return null;
  };

  return inspect(raw);
}

function normalizeDebtItems(rawDebtItems) {
  if (!Array.isArray(rawDebtItems)) return [];
  return rawDebtItems
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const type = String(item.type || "").trim();
      const severity = String(item.severity || "").trim().toLowerCase();
      const description = String(
        item.description || item.detail || item.message || "",
      ).trim();
      const criterion = String(item.criterion || "").trim();
      if (!type && !description && !criterion) return null;
      return {
        type: type || "unspecified",
        severity:
          ["critical", "high", "medium", "low"].includes(severity)
            ? severity
            : "medium",
        description,
        criterion,
      };
    })
    .filter(Boolean);
}

function normalizeSplitTasks(rawSplitTasks) {
  if (!Array.isArray(rawSplitTasks)) return [];
  return rawSplitTasks
    .map((task) => {
      if (!task || typeof task !== "object") return null;
      const title = String(task.title || task.name || "").trim();
      if (!title) return null;
      const description = String(task.description || "").trim();
      const priority = String(task.priority || "").trim().toLowerCase();
      const tags = Array.isArray(task.tags)
        ? task.tags
          .map((tag) => String(tag || "").trim())
          .filter(Boolean)
        : [];
      const acceptanceCriteriaRaw =
        task.acceptance_criteria || task.acceptanceCriteria;
      const acceptance_criteria = Array.isArray(acceptanceCriteriaRaw)
        ? acceptanceCriteriaRaw
          .map((criterion) => String(criterion || "").trim())
          .filter(Boolean)
        : [];
      return {
        title,
        description,
        acceptance_criteria,
        priority:
          ["critical", "high", "medium", "low"].includes(priority)
            ? priority
            : undefined,
        tags,
      };
    })
    .filter(Boolean);
}

function clampRatio(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(1, Number(parsed.toFixed(3))));
}

function normalizeSuccessCriteria(rawCriteria, fallbackAcceptanceCriteria = []) {
  const source = Array.isArray(rawCriteria)
    ? rawCriteria
    : (Array.isArray(fallbackAcceptanceCriteria) ? fallbackAcceptanceCriteria : []);
  return source
    .map((entry, index) => {
      if (typeof entry === "string") {
        const title = entry.trim();
        if (!title) return null;
        return {
          id: `criterion-${index + 1}`,
          title,
          description: "",
          status: "pending",
          blocking: true,
        };
      }
      if (!entry || typeof entry !== "object") return null;
      const id = String(entry.id || entry.criterionId || entry.key || `criterion-${index + 1}`).trim();
      const title = String(entry.title || entry.name || entry.criterion || "").trim();
      const description = String(entry.description || entry.detail || entry.summary || "").trim();
      const rawStatus = String(entry.status || "").trim().toLowerCase();
      const status = ["pending", "in_progress", "partial", "satisfied", "failed", "waived", "blocked"].includes(rawStatus)
        ? rawStatus
        : (entry.satisfied === true ? "satisfied" : "pending");
      const blocking = entry.blocking === true || entry.required === true || entry.optional === false;
      if (!id && !title && !description) return null;
      return {
        id: id || `criterion-${index + 1}`,
        title: title || description || id || `criterion-${index + 1}`,
        description,
        status,
        blocking,
      };
    })
    .filter(Boolean);
}

function normalizeConstraintViolations(rawViolations) {
  if (!Array.isArray(rawViolations)) return [];
  return rawViolations
    .map((entry, index) => {
      if (!entry || typeof entry !== "object") return null;
      const constraintId = String(entry.constraintId || entry.ruleId || entry.id || `constraint-${index + 1}`).trim();
      const type = String(entry.type || entry.kind || "").trim().toLowerCase();
      const severity = String(entry.severity || "").trim().toLowerCase();
      const message = String(entry.message || entry.reason || entry.description || "").trim();
      const status = String(entry.status || "").trim().toLowerCase();
      const blocking = entry.blocking === true || entry.blocked === true;
      if (!constraintId && !type && !message) return null;
      return {
        constraintId: constraintId || `constraint-${index + 1}`,
        type: type || "constraint",
        severity: ["critical", "high", "medium", "low", "warning", "error"].includes(severity) ? severity : (blocking ? "error" : "warning"),
        status: ["open", "resolved", "waived", "warning", "blocked"].includes(status) ? status : (blocking ? "blocked" : "open"),
        message,
        blocking,
      };
    })
    .filter(Boolean);
}

function normalizeConstraintState(rawConstraintState) {
  if (!rawConstraintState) return null;
  const source = Array.isArray(rawConstraintState)
    ? { violations: rawConstraintState }
    : (typeof rawConstraintState === "object" ? rawConstraintState : null);
  if (!source) return null;
  const violations = normalizeConstraintViolations(
    source.violations || source.items || source.constraintViolations,
  );
  const blockingViolationCount = violations.filter((entry) => entry.blocking === true).length;
  const violationCount = violations.length;
  const blocked = source.blocked === true || blockingViolationCount > 0;
  const approvalPending = source.approvalPending === true || String(source.approvalState || "").trim().toLowerCase() === "pending";
  const rawStatus = String(source.status || "").trim().toLowerCase();
  const status = rawStatus || (blocked ? "blocked" : (violationCount > 0 ? "warning" : "ok"));
  if (violationCount === 0 && !blocked && !approvalPending && !status) return null;
  return {
    status,
    blocked,
    approvalPending,
    violationCount,
    blockingViolationCount,
    violations,
  };
}

function normalizeTokenBudget(rawTokenBudget) {
  if (!rawTokenBudget || typeof rawTokenBudget !== "object") return null;
  const budgetTokens = Number(rawTokenBudget.budgetTokens ?? rawTokenBudget.limitTokens ?? rawTokenBudget.maxTokens);
  const inputTokens = Number(rawTokenBudget.inputTokens ?? 0);
  const outputTokens = Number(rawTokenBudget.outputTokens ?? 0);
  const totalTokens = Number(
    rawTokenBudget.totalTokens
    ?? ((Number.isFinite(inputTokens) ? inputTokens : 0) + (Number.isFinite(outputTokens) ? outputTokens : 0)),
  );
  const reservedTokens = Number(rawTokenBudget.reservedTokens ?? 0);
  const effectiveTotal = Number.isFinite(totalTokens) ? totalTokens : 0;
  const effectiveReserved = Number.isFinite(reservedTokens) ? reservedTokens : 0;
  const effectiveBudget = Number.isFinite(budgetTokens) ? budgetTokens : null;
  const remainingTokens = Number(
    rawTokenBudget.remainingTokens
    ?? (effectiveBudget != null ? effectiveBudget - effectiveTotal - effectiveReserved : NaN),
  );
  const nearLimitThresholdTokens = Number(rawTokenBudget.nearLimitThresholdTokens ?? rawTokenBudget.warningTokens);
  const utilizationRatio = effectiveBudget && effectiveBudget > 0
    ? clampRatio((effectiveTotal + effectiveReserved) / effectiveBudget)
    : null;
  const exceeded = effectiveBudget != null ? (effectiveTotal + effectiveReserved) > effectiveBudget : false;
  const nearLimit = !exceeded && effectiveBudget != null
    ? (
        (Number.isFinite(nearLimitThresholdTokens) && Number.isFinite(remainingTokens) && remainingTokens <= nearLimitThresholdTokens)
        || ((utilizationRatio ?? 0) >= 0.9)
      )
    : false;
  const rawStatus = String(rawTokenBudget.status || "").trim().toLowerCase();
  const status = rawStatus || (exceeded ? "exceeded" : (nearLimit ? "near_limit" : "ok"));
  if (!Number.isFinite(effectiveTotal) && effectiveBudget == null && !rawStatus) return null;
  return {
    status,
    budgetTokens: effectiveBudget,
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    totalTokens: effectiveTotal,
    reservedTokens: effectiveReserved,
    remainingTokens: Number.isFinite(remainingTokens) ? remainingTokens : null,
    utilizationRatio,
    nearLimit,
    exceeded,
    approvalRequired: rawTokenBudget.approvalRequired === true,
  };
}

function normalizeGoalProgress(rawGoalProgress, successCriteria = []) {
  const source = rawGoalProgress && typeof rawGoalProgress === "object" ? rawGoalProgress : {};
  const completedCriteriaCount = Number.isFinite(Number(source.completedCriteriaCount))
    ? Number(source.completedCriteriaCount)
    : successCriteria.filter((entry) => ["satisfied", "waived"].includes(entry.status)).length;
  const totalCriteriaCount = Number.isFinite(Number(source.totalCriteriaCount))
    ? Number(source.totalCriteriaCount)
    : successCriteria.length;
  const completionRatio = clampRatio(
    source.completionRatio
    ?? (totalCriteriaCount > 0 ? completedCriteriaCount / totalCriteriaCount : null),
  );
  const rawStatus = String(source.status || "").trim().toLowerCase();
  const status = rawStatus || (
    completionRatio === 1 ? "satisfied"
      : completionRatio != null && completionRatio > 0 ? "partial"
        : totalCriteriaCount > 0 ? "pending"
          : "pending"
  );
  if (!status && totalCriteriaCount === 0 && !String(source.summary || "").trim()) return null;
  return {
    status,
    summary: String(source.summary || "").trim() || "",
    completedCriteriaCount,
    totalCriteriaCount,
    completionRatio,
  };
}

function normalizeObjectiveFrame(rawObjectiveFrame, fallback = {}) {
  const source = rawObjectiveFrame && typeof rawObjectiveFrame === "object" ? rawObjectiveFrame : {};
  const successCriteria = normalizeSuccessCriteria(
    source.successCriteria || source.criteria || fallback.successCriteria,
    fallback.acceptanceCriteria,
  );
  const goalProgress = normalizeGoalProgress(source.goalProgress || fallback.goalProgress, successCriteria);
  const constraintState = normalizeConstraintState(source.constraintState || source.constraints || fallback.constraintState);
  const tokenBudget = normalizeTokenBudget(source.tokenBudget || fallback.tokenBudget);
  const blocked = constraintState?.blocked === true
    || constraintState?.approvalPending === true
    || tokenBudget?.status === "exceeded";
  if (successCriteria.length === 0 && !goalProgress && !constraintState && !tokenBudget) return null;
  return {
    successCriteria,
    goalProgress,
    constraintState,
    tokenBudget,
    blocked,
  };
}

// ── Main assessment function ────────────────────────────────────────────────

/**
 * Assess a task and return a structured lifecycle decision.
 *
 * @param {TaskAssessmentContext} ctx
 * @param {object} opts
 * @param {function} opts.execCodex - Primary agent prompt executor
 * @param {number}   [opts.timeoutMs] - Timeout for SDK call
 * @param {string}   [opts.logDir] - Directory for audit logs
 * @param {function} [opts.onTelegram] - Telegram notification callback
 * @returns {Promise<TaskAssessmentDecision>}
 */
export async function assessTask(ctx, opts) {
  const tag = `assessment(${ctx.shortId})`;

  // ── Dedup check ─────────────────────────────────────────────
  const lastRun = assessmentDedup.get(ctx.taskId);
  if (lastRun && Date.now() - lastRun < ASSESSMENT_COOLDOWN_MS) {
    console.log(
      `[${tag}] skipping — assessed ${Math.round((Date.now() - lastRun) / 1000)}s ago`,
    );
    return { success: false, action: "noop", reason: "dedup", rawOutput: "" };
  }
  assessmentDedup.set(ctx.taskId, Date.now());

  const timeoutMs = opts.timeoutMs || 5 * 60 * 1000;
  const fallbackObjectiveFrame = normalizeObjectiveFrame(ctx.objectiveFrame || ctx, {
    acceptanceCriteria: ctx.acceptanceCriteria,
    successCriteria: ctx.successCriteria,
    goalProgress: ctx.goalProgress,
    constraintState: ctx.constraintState,
    tokenBudget: ctx.tokenBudget,
  });

  try {
    // ── Build prompt ──────────────────────────────────────────
    const prompt = buildAssessmentPrompt(ctx);

    // ── Execute via primary agent SDK ─────────────────────────
    console.log(`[${tag}] running assessment (trigger: ${ctx.trigger})`);
    const result = await opts.execCodex(prompt, { timeoutMs });

    const rawOutput = result?.finalResponse || result || "";
    const rawStr =
      typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput);

    // ── Parse decision ────────────────────────────────────────
    const decision = extractDecisionJson(rawStr);

    if (!decision || !VALID_ACTIONS.has(decision.action)) {
      console.warn(
        `[${tag}] invalid/missing action in response — defaulting to manual_review`,
      );

      // Write audit log
      await writeAuditLog(opts.logDir, ctx, rawStr, {
        action: "manual_review",
        reason: "parse_failure",
      });

      return {
        success: false,
        action: "manual_review",
        reason: `Could not parse assessment response: ${rawStr.slice(0, 200)}`,
        rawOutput: rawStr,
      };
    }

    const result_ = {
      success: true,
      action: decision.action,
      prompt: decision.prompt || decision.message || undefined,
      reason: decision.reason || undefined,
      waitSeconds: decision.waitSeconds || decision.seconds || undefined,
      agentType: decision.agentType || undefined,
      debtItems: normalizeDebtItems(decision.debtItems || decision.debt_items),
      splitTasks: normalizeSplitTasks(decision.splitTasks || decision.subTasks || decision.sub_tasks),
      objectiveFrame: normalizeObjectiveFrame(decision.objectiveFrame || decision.evaluationFrame || decision, {
        acceptanceCriteria: ctx.acceptanceCriteria,
        successCriteria: ctx.successCriteria,
        goalProgress: ctx.goalProgress,
        constraintState: ctx.constraintState,
        tokenBudget: ctx.tokenBudget,
      }) || fallbackObjectiveFrame,
      rawOutput: rawStr,
    };

    // ── Audit log ─────────────────────────────────────────────
    await writeAuditLog(opts.logDir, ctx, rawStr, result_);

    // ── Telegram notification ─────────────────────────────────
    if (opts.onTelegram) {
      const emoji =
        {
          merge: ":check:",
          reprompt_same: ":chat:",
          reprompt_new_session: ":refresh:",
          new_attempt: ":star:",
          wait: ":clock:",
          manual_review: ":eye:",
          close_and_replan: ":ban:",
          accept_with_debt: ":memo:",
          split_task: ":split:",
          escalate_to_replan: ":warning:",
          noop: ":dot:",
        }[decision.action] || ":help:";
      opts.onTelegram(
        `${emoji} Assessment [${ctx.shortId}] ${ctx.trigger}: **${decision.action}**\n${decision.reason || ""}`.slice(
          0,
          500,
        ),
      );
    }

    console.log(
      `[${tag}] decision: ${decision.action} — ${(decision.reason || "").slice(0, 100)}`,
    );
    return result_;
  } catch (err) {
    console.warn(`[${tag}] assessment error: ${err.message || err}`);
    return {
      success: false,
      action: "noop",
      reason: `Assessment error: ${err.message || err}`,
      rawOutput: "",
    };
  }
}

// ── Quick assessment (no SDK call) ──────────────────────────────────────────

/**
 * Fast heuristic-based assessment for common scenarios that don't need SDK.
 * Returns a decision if the scenario is clear-cut, or null if SDK is needed.
 *
 * @param {TaskAssessmentContext} ctx
 * @returns {TaskAssessmentDecision | null}
 */
export function quickAssess(ctx) {
  const objectiveFrame = normalizeObjectiveFrame(ctx.objectiveFrame || ctx, {
    acceptanceCriteria: ctx.acceptanceCriteria,
    successCriteria: ctx.successCriteria,
    goalProgress: ctx.goalProgress,
    constraintState: ctx.constraintState,
    tokenBudget: ctx.tokenBudget,
  });
  if (objectiveFrame?.constraintState?.blocked === true || objectiveFrame?.constraintState?.approvalPending === true) {
    return {
      success: true,
      action: "manual_review",
      reason: "Task is currently blocked by explicit execution constraints or pending approval",
      objectiveFrame,
      rawOutput: "quick_assess:constraint_blocked",
    };
  }
  if (objectiveFrame?.tokenBudget?.status === "exceeded") {
    return {
      success: true,
      action: "manual_review",
      reason: "Token budget exceeded - approval or scope reduction is required before continuing",
      objectiveFrame,
      rawOutput: "quick_assess:token_budget_exceeded",
    };
  }

  // ── Rebase failed on only auto-resolvable files ──────────
  if (ctx.trigger === "rebase_failed" && ctx.conflictFiles?.length) {
    const lockPatterns = [
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
      "go.sum",
      "CHANGELOG.md",
      "coverage.txt",
      "results.txt",
    ];
    const lockExts = [".lock"];
    const allAutoResolvable = ctx.conflictFiles.every((f) => {
      const name = f.split("/").pop();
      return (
        lockPatterns.includes(name) ||
        lockExts.some((ext) => name.endsWith(ext))
      );
    });

    if (allAutoResolvable) {
      const theirsFiles = ctx.conflictFiles.filter((f) => {
        const name = f.split("/").pop();
        return !["CHANGELOG.md", "coverage.txt", "results.txt"].includes(name);
      });
      const oursFiles = ctx.conflictFiles.filter((f) => {
        const name = f.split("/").pop();
        return ["CHANGELOG.md", "coverage.txt", "results.txt"].includes(name);
      });

      const instructions = [];
      if (theirsFiles.length) {
        instructions.push(
          `git checkout --theirs ${theirsFiles.join(" ")} && git add ${theirsFiles.join(" ")}`,
        );
      }
      if (oursFiles.length) {
        instructions.push(
          `git checkout --ours ${oursFiles.join(" ")} && git add ${oursFiles.join(" ")}`,
        );
      }

      return {
        success: true,
        action: "reprompt_same",
        prompt: `Merge with ${ctx.upstreamBranch || "upstream"} failed with conflicts in auto-resolvable files. Run:\n${instructions.join("\n")}\nThen run: git merge --continue\nAfter that, run tests and push.`,
        reason: `All ${ctx.conflictFiles.length} conflicted files are auto-resolvable (lock files/generated)`,
        rawOutput: "quick_assess:auto_resolvable_conflicts",
      };
    }
  }

  // ── Too many attempts — escalate ─────────────────────────
  if (ctx.attemptCount != null && ctx.attemptCount >= 4) {
    return {
      success: true,
      action: "manual_review",
      reason: `Task has had ${ctx.attemptCount} attempts — escalating to human review`,
      rawOutput: "quick_assess:max_attempts",
    };
  }

  // ── Too many session retries — try new attempt ───────────
  if (ctx.sessionRetries != null && ctx.sessionRetries >= 3) {
    return {
      success: true,
      action: "new_attempt",
      reason: `${ctx.sessionRetries} session retries exhausted — starting fresh attempt with alternate agent`,
      agentType: ctx.agentType === "codex" ? "copilot" : "codex",
      rawOutput: "quick_assess:session_retries_exhausted",
    };
  }

  // ── PR merged downstream — always merge-refresh first ───────────
  if (ctx.trigger === "pr_merged_downstream" && !ctx.rebaseError) {
    const upstreamRef = normalizeUpstreamRef(ctx.upstreamBranch);
    return {
      success: true,
      action: "reprompt_same",
      prompt: `A PR was just merged into your upstream branch (${upstreamRef}). Please rebase your branch onto the latest upstream changes: git fetch origin && git rebase ${upstreamRef}. Resolve any conflicts, continue the rebase, then run tests and push.`,
      reason: "Upstream branch updated — agent should refresh via rebase",
      rawOutput: "quick_assess:downstream_rebase",
    };
  }

  // No quick assessment possible — caller should use full SDK assessment
  return null;
}

// ── Audit logging ───────────────────────────────────────────────────────────

async function writeAuditLog(logDir, ctx, rawOutput, decision) {
  if (!logDir) return;

  try {
    await mkdir(logDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const shortId = ctx.shortId || ctx.taskId?.substring(0, 8) || "unknown";
    const filename = `assessment-${shortId}-${ctx.trigger}-${timestamp}.log`;

    const content = [
      `Task Assessment Audit Log`,
      `========================`,
      `Timestamp: ${new Date().toISOString()}`,
      `Task: ${ctx.taskTitle || "unknown"} (${ctx.taskId || "unknown"})`,
      `Attempt: ${ctx.attemptId || "unknown"} (${ctx.shortId || "unknown"})`,
      `Trigger: ${ctx.trigger}`,
      `Branch: ${ctx.branch || "unknown"}`,
      `Upstream: ${ctx.upstreamBranch || "unknown"}`,
      `Agent: ${ctx.agentType || "unknown"}`,
      ``,
      `Decision:`,
      `  Action: ${decision.action}`,
      `  Reason: ${decision.reason || "none"}`,
      decision.prompt ? `  Prompt: ${decision.prompt.slice(0, 500)}` : "",
      ``,
      `Raw Output:`,
      `${rawOutput}`,
    ]
      .filter(Boolean)
      .join("\n");

    await writeFile(resolve(logDir, filename), content, "utf8");
  } catch {
    /* best-effort audit logging */
  }
}

// ── Exports ─────────────────────────────────────────────────────────────────

export function resetAssessmentDedup() {
  assessmentDedup.clear();
}

export { VALID_ACTIONS, buildAssessmentPrompt, extractDecisionJson };
