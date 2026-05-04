const PRIORITY_VALUES = new Set(["low", "medium", "high", "critical"]);
const STATUS_VALUES = new Set(["draft", "todo", "inprogress", "inreview", "blocked", "done", "cancelled"]);
const ACTION_VALUES = new Set(["split_task", "escalate_to_replan", "refine_in_place", "noop"]);
const REPLAN_MODE_VALUES = new Set(["replan", "decompose"]);

function toText(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

export function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )];
}

function normalizeParagraph(value, fallback = "") {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  return text || fallback;
}

function normalizeAcceptanceCriteria(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .slice(0, 12);
}

function normalizePriority(value, fallback = "medium") {
  const normalized = String(value || "").trim().toLowerCase();
  return PRIORITY_VALUES.has(normalized) ? normalized : fallback;
}

function normalizeStatus(value, fallback = null) {
  const normalized = String(value || "").trim().toLowerCase();
  return STATUS_VALUES.has(normalized) ? normalized : fallback;
}

export function normalizeTaskPlanningMode(value, fallback = "replan") {
  const normalized = String(value || "").trim().toLowerCase();
  return REPLAN_MODE_VALUES.has(normalized) ? normalized : fallback;
}

function normalizeTaskSubproposal(entry, index = 0, options = {}) {
  const fallbackPriority = normalizePriority(options.parentTask?.priority || "medium");
  const fallbackTag = options.mode === "decompose" ? "decompose" : "replan";
  const source = entry && typeof entry === "object" ? entry : {};
  const title =
    toText(source.title)
    || toText(source.name)
    || `Subtask ${index + 1}`;
  const description = normalizeParagraph(source.description || source.summary || source.details || "", title);
  const acceptanceCriteria = normalizeAcceptanceCriteria(
    source.acceptanceCriteria || source.acceptance_criteria || source.criteria || [],
  );
  const dependsOnIndexes = [...new Set(
    (Array.isArray(source.dependsOnIndexes) ? source.dependsOnIndexes : source.depends_on_indexes)
      ? (source.dependsOnIndexes || source.depends_on_indexes)
        .map((value) => Number.parseInt(String(value), 10))
        .filter((value) => Number.isInteger(value) && value >= 0)
      : [],
  )];
  return {
    title,
    description,
    acceptanceCriteria,
    priority: normalizePriority(source.priority, fallbackPriority),
    tags: uniqueStrings(source.tags || [fallbackTag]),
    dependsOnIndexes,
    dependsOnTaskIds: uniqueStrings(source.dependsOnTaskIds || source.depends_on_task_ids || source.dependsOn || []),
    storyPoints: Number.isFinite(Number(source.storyPoints)) ? Number(source.storyPoints) : null,
    sprintId: toText(source.sprintId || source.sprint_id || ""),
    currentPlanStep: normalizeParagraph(source.currentPlanStep || source.current_plan_step || "", ""),
  };
}

function normalizeParentTaskPatch(value, options = {}) {
  const source = value && typeof value === "object" ? value : {};
  const patch = {};
  const title = toText(source.title);
  const description = normalizeParagraph(source.description || "", "");
  const blockedReason = normalizeParagraph(source.blockedReason || source.blocked_reason || "", "");
  const priority = normalizePriority(source.priority, "");
  const status = normalizeStatus(source.status, null);
  if (title) patch.title = title;
  if (description) patch.description = description;
  if (priority) patch.priority = priority;
  if (status) patch.status = status;
  if (blockedReason) patch.blockedReason = blockedReason;
  const tags = uniqueStrings(source.tags || []);
  if (tags.length > 0) patch.tags = tags;
  if (!patch.status && patch.blockedReason) {
    patch.status = normalizeStatus(options.defaultBlockedStatus || "blocked", "blocked");
  }
  return patch;
}

export function normalizeTaskReplanProposal(rawProposal = {}, options = {}) {
  const source = rawProposal && typeof rawProposal === "object" ? rawProposal : {};
  const parentTask = options.parentTask && typeof options.parentTask === "object" ? options.parentTask : {};
  const mode = normalizeTaskPlanningMode(source.mode || source.planningMode || source.intent || options.mode || "replan");
  const subtasks = (Array.isArray(source.subtasks) ? source.subtasks : [])
    .slice(0, 8)
    .map((entry, index) => normalizeTaskSubproposal(entry, index, { parentTask, mode }))
    .filter((entry) => entry.title);
  const dependencyPatches = (Array.isArray(source.dependencyPatches) ? source.dependencyPatches : [])
    .map((entry) => ({
      taskId: toText(entry?.taskId || entry?.id || ""),
      dependsOnTaskIds: uniqueStrings(entry?.dependsOnTaskIds || entry?.depends_on_task_ids || entry?.dependsOn || []),
    }))
    .filter((entry) => entry.taskId && entry.dependsOnTaskIds.length > 0);
  return {
    mode,
    summary: normalizeParagraph(source.summary || source.goal || "", "Task replan proposal generated."),
    planReasoning: normalizeParagraph(source.planReasoning || source.plan_reasoning || source.reasoning || "", ""),
    currentPlanStep: normalizeParagraph(source.currentPlanStep || source.current_plan_step || "", ""),
    stopReason: normalizeParagraph(source.stopReason || source.stop_reason || "", ""),
    recommendedAction: ACTION_VALUES.has(String(source.recommendedAction || source.recommended_action || "").trim())
      ? String(source.recommendedAction || source.recommended_action).trim()
      : (subtasks.length > 0 ? "split_task" : "refine_in_place"),
    subtasks,
    dependencyPatches,
    parentTaskPatch: normalizeParentTaskPatch(source.parentTaskPatch || source.parent_task_patch || {}, {
      defaultBlockedStatus: subtasks.length > 0 ? "blocked" : "todo",
    }),
    notes: (Array.isArray(source.notes) ? source.notes : [])
      .map((entry) => normalizeParagraph(entry || "", ""))
      .filter(Boolean)
      .slice(0, 12),
  };
}

function tryParseJson(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function collectJsonObjectCandidates(text) {
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
        if (ch === "\"") inString = false;
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
}

function buildEnvelopeCandidates(value) {
  const candidates = [];
  if (value == null) return candidates;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) candidates.push(trimmed);
    return candidates;
  }
  if (Array.isArray(value)) {
    for (const entry of value) candidates.push(...buildEnvelopeCandidates(entry));
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
}

export function extractTaskReplanProposal(value) {
  const seenStrings = new Set();
  const looksLikeProposal = (candidate) => (
    candidate
    && typeof candidate === "object"
    && (
      Object.prototype.hasOwnProperty.call(candidate, "subtasks")
      || Object.prototype.hasOwnProperty.call(candidate, "summary")
      || Object.prototype.hasOwnProperty.call(candidate, "recommendedAction")
      || Object.prototype.hasOwnProperty.call(candidate, "recommended_action")
      || Object.prototype.hasOwnProperty.call(candidate, "parentTaskPatch")
      || Object.prototype.hasOwnProperty.call(candidate, "parent_task_patch")
    )
  );

  const inspect = (candidate) => {
    if (candidate == null) return null;
    if (looksLikeProposal(candidate)) return candidate;
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const parsed = inspect(item);
        if (parsed) return parsed;
      }
      return null;
    }
    if (typeof candidate === "object") {
      const nestedCandidates = buildEnvelopeCandidates(candidate);
      for (const nested of nestedCandidates) {
        const parsed = inspect(nested);
        if (parsed) return parsed;
      }
      return null;
    }
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (!trimmed || seenStrings.has(trimmed)) return null;
      seenStrings.add(trimmed);
      const direct = tryParseJson(trimmed);
      if (direct) {
        const parsed = inspect(direct);
        if (parsed) return parsed;
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
            const parsed = inspect(parsedFence);
            if (parsed) return parsed;
          }
        }
        fenceCursor = close + 3;
      }
      for (const rawObject of collectJsonObjectCandidates(trimmed)) {
        if (!rawObject || seenStrings.has(rawObject)) continue;
        seenStrings.add(rawObject);
        const parsedObject = tryParseJson(rawObject);
        if (parsedObject) {
          const parsed = inspect(parsedObject);
          if (parsed) return parsed;
        }
      }
    }
    return null;
  };

  return inspect(value);
}

function summarizeTaskForContext(task = {}) {
  return {
    id: toText(task.id),
    title: toText(task.title),
    description: normalizeParagraph(task.description || "", ""),
    status: toText(task.status || "todo"),
    priority: normalizePriority(task.priority || "medium"),
    tags: uniqueStrings(task.tags || task.meta?.tags || []),
    dependencyTaskIds: uniqueStrings([
      ...(Array.isArray(task.dependencyTaskIds) ? task.dependencyTaskIds : []),
      ...(Array.isArray(task.dependsOn) ? task.dependsOn : []),
    ]),
    childTaskIds: uniqueStrings(task.childTaskIds || []),
    sprintId: toText(task.sprintId || task.meta?.sprintId || ""),
    epicId: toText(task.epicId || task.meta?.epicId || ""),
    blockedReason: normalizeParagraph(task.blockedReason || task.meta?.blockedReason || "", ""),
  };
}

function hasBatchTag(task = {}) {
  const tags = uniqueStrings(task.tags || task.meta?.tags || []).map((value) => value.toLowerCase());
  return tags.some((tag) => ["batch", "sweep", "research", "audit", "migration"].includes(tag));
}

export function buildTaskReplanContext(task = {}, options = {}) {
  const mode = normalizeTaskPlanningMode(options.mode || "replan");
  const childTasks = Array.isArray(options.childTasks) ? options.childTasks : [];
  const relatedTasks = Array.isArray(options.relatedTasks) ? options.relatedTasks : [];
  const workflowRuns = Array.isArray(task.workflowRuns) ? task.workflowRuns : [];
  const timeline = Array.isArray(task.timeline) ? task.timeline : [];
  const auditSummary = options.auditSummary && typeof options.auditSummary === "object"
    ? options.auditSummary
    : {};
  return {
    mode,
    parentTask: summarizeTaskForContext(task),
    childTasks: childTasks.slice(0, 12).map(summarizeTaskForContext),
    relatedTasks: relatedTasks.slice(0, 16).map(summarizeTaskForContext),
    workflowRuns: workflowRuns.slice(0, 8).map((entry) => ({
      runId: toText(entry.runId || entry.id || ""),
      workflowId: toText(entry.workflowId || ""),
      status: toText(entry.status || ""),
      outcome: toText(entry.outcome || ""),
      summary: normalizeParagraph(entry.summary || "", ""),
    })),
    recentTimeline: timeline.slice(-10).map((entry) => ({
      type: toText(entry?.type || ""),
      status: toText(entry?.status || ""),
      source: toText(entry?.source || ""),
      message: normalizeParagraph(entry?.message || "", ""),
    })),
    auditSummary: {
      eventCount: Number(auditSummary.eventCount || 0),
      artifactCount: Number(auditSummary.artifactCount || 0),
      toolCallCount: Number(auditSummary.toolCallCount || 0),
      operatorActionCount: Number(auditSummary.operatorActionCount || 0),
      workflowRunCount: Number(auditSummary.workflowRunCount || 0),
    },
  };
}

function normalizeProtocolEntry(entry = {}) {
  const tags = uniqueStrings(entry.tags || []);
  return {
    id: toText(entry.id || ""),
    title: normalizeParagraph(entry.title || "", "Operational Protocol"),
    description: normalizeParagraph(entry.description || "", ""),
    tags,
    important: entry.important === true,
    content: normalizeParagraph(entry.content || "", ""),
    sourceKind: "runtime-protocol",
    sourcePath: `runtime://${toText(entry.id || "protocol") || "protocol"}`,
    trusted: true,
    trustState: "trusted",
    trustReason: "runtime-protocol",
    catalogOnly: false,
  };
}

export function buildTaskReplanOperationalProtocols(context = {}, options = {}) {
  const parentTask = context?.parentTask && typeof context.parentTask === "object" ? context.parentTask : {};
  const childTasks = Array.isArray(context?.childTasks) ? context.childTasks : [];
  const relatedTasks = Array.isArray(context?.relatedTasks) ? context.relatedTasks : [];
  const workflowRuns = Array.isArray(context?.workflowRuns) ? context.workflowRuns : [];
  const recentTimeline = Array.isArray(context?.recentTimeline) ? context.recentTimeline : [];
  const auditSummary = context?.auditSummary && typeof context.auditSummary === "object" ? context.auditSummary : {};
  const tags = uniqueStrings([
    ...(Array.isArray(options.labels) ? options.labels : []),
    ...(Array.isArray(parentTask.tags) ? parentTask.tags : []),
  ]).map((value) => value.toLowerCase());

  const protocols = [];
  const mode = normalizeTaskPlanningMode(context?.mode || options.mode || "replan");
  const broadTask =
    childTasks.length === 0
    && (
      String(parentTask.description || "").length >= 180
      || relatedTasks.length >= 2
      || workflowRuns.some((run) => ["failed", "blocked"].includes(String(run?.status || "").toLowerCase()))
      || hasBatchTag(parentTask)
    );
  if (mode === "decompose" || broadTask) {
    protocols.push(normalizeProtocolEntry({
      id: "runtime-task-decomposition",
      title: "Task Decomposition Protocol",
      description: "Split broad or blocked work into executable child steps before pushing forward.",
      tags: ["task", "decompose", "replan", "planning"],
      important: true,
      content: [
        "# Skill: Task Decomposition Protocol",
        "",
        `- Parent Task: ${toText(parentTask.title || parentTask.id || "current task")}`,
        `- Trigger: ${mode === "decompose" ? "explicit decomposition request" : "broad or blocked task shape detected"}`,
        `- Child Tasks Present: ${childTasks.length}`,
        `- Related Tasks Considered: ${relatedTasks.length}`,
        "- Runtime Primitive: create 2-6 executable subtasks, wire dependencies explicitly, and block the parent when execution should flow through the child graph.",
        "- Stop Rule: stop expanding once the next agent-facing step is concrete and independently verifiable.",
      ].join("\n"),
    }));
  }

  const contextSignal =
    workflowRuns.length > 0
    || recentTimeline.length >= 3
    || Number(auditSummary.eventCount || 0) >= 4
    || Number(auditSummary.toolCallCount || 0) >= 4;
  if (contextSignal) {
    protocols.push(normalizeProtocolEntry({
      id: "runtime-context-preservation",
      title: "Context Preservation Protocol",
      description: "Preserve the current run state so long patch cycles can resume cleanly.",
      tags: ["context", "resume", "checkpoint", "notes"],
      important: true,
      content: [
        "# Skill: Context Preservation Protocol",
        "",
        `- Workflow Runs In Context: ${workflowRuns.length}`,
        `- Timeline Events Tracked: ${recentTimeline.length}`,
        `- Audit Summary: events=${Number(auditSummary.eventCount || 0)}, artifacts=${Number(auditSummary.artifactCount || 0)}, toolCalls=${Number(auditSummary.toolCallCount || 0)}`,
        "- Runtime Primitive: record the current plan step, explicit stop reason, and the smallest next action before handing off or retrying.",
        "- Resume Rule: keep operator-facing notes short, concrete, and tied to the current task graph rather than free-form narration.",
      ].join("\n"),
    }));
  }

  const batchSignal =
    hasBatchTag(parentTask)
    || tags.some((tag) => ["batch", "sweep", "research", "audit"].includes(tag))
    || childTasks.length + relatedTasks.length >= 4;
  if (batchSignal) {
    protocols.push(normalizeProtocolEntry({
      id: "runtime-batch-ledger",
      title: "Batch Ledger Protocol",
      description: "Track multi-item progress explicitly during sweeps, audits, and long task batches.",
      tags: ["batch", "ledger", "research", "audit", "tracking"],
      important: true,
      content: [
        "# Skill: Batch Ledger Protocol",
        "",
        `- Child Tasks Tracked: ${childTasks.length}`,
        `- Related Tasks Tracked: ${relatedTasks.length}`,
        "- Runtime Primitive: maintain an explicit done / next / blocked ledger for each item instead of relying on one rolling summary.",
        "- Reporting Rule: when the batch is partial, say exactly which items are complete, which remain, and what blocker pattern is repeating.",
      ].join("\n"),
    }));
  }

  return protocols;
}

export function buildTaskReplanPrompt(context = {}) {
  const mode = normalizeTaskPlanningMode(context?.mode || "replan");
  const serialized = JSON.stringify(context, null, 2);
  const plannerTitle = mode === "decompose"
    ? "You are Bosun's task decomposition planner."
    : "You are Bosun's task graph replanner.";
  const plannerGoal = mode === "decompose"
    ? "Given one existing task plus its current child/dependency graph, produce a concrete decomposition proposal that expands the task into a planner-owned child graph Bosun can apply immediately."
    : "Given one parent task plus its current child/dependency graph, produce a concrete replan proposal that Bosun can apply immediately.";
  return [
    plannerTitle,
    plannerGoal,
    "",
    "Return exactly one JSON object and no prose outside the JSON.",
    "The JSON object must use this shape:",
    "{",
    `  "mode": "${mode}",`,
    '  "summary": "one paragraph summary",',
    '  "planReasoning": "why this graph should change",',
    '  "currentPlanStep": "what the operator should do next",',
    '  "stopReason": "why you stopped expanding",',
    '  "recommendedAction": "split_task" | "escalate_to_replan" | "refine_in_place" | "noop",',
    '  "parentTaskPatch": {',
    '    "title": "optional refined parent title",',
    '    "description": "optional refined parent description",',
    '    "status": "optional task status",',
    '    "blockedReason": "optional blocked reason",',
    '    "priority": "optional priority",',
    '    "tags": ["optional", "tags"]',
    "  },",
    '  "subtasks": [',
    "    {",
    '      "title": "required",',
    '      "description": "required",',
    '      "acceptanceCriteria": ["specific checks"],',
    '      "priority": "low|medium|high|critical",',
    '      "tags": ["optional", "tags"],',
    '      "dependsOnIndexes": [0],',
    '      "dependsOnTaskIds": ["EXISTING-TASK-ID"],',
    '      "storyPoints": 1,',
    '      "sprintId": "optional-sprint-id",',
    '      "currentPlanStep": "optional per-subtask step" ',
    "    }",
    "  ],",
    '  "dependencyPatches": [',
    '    { "taskId": "existing-task-id", "dependsOnTaskIds": ["other-existing-or-parent-generated-task-id"] }',
    "  ],",
    '  "notes": ["optional operator notes"]',
    "}",
    "",
    "Rules:",
    "- Keep subtasks executable by one agent each.",
    "- Use dependsOnIndexes only to reference earlier subtasks in this same proposal.",
    "- Use dependencyPatches only to append missing dependencies to existing tasks.",
    "- If the task should not split, return an empty subtasks array and explain why.",
    "- Prefer 2-6 subtasks when splitting. Never exceed 8 subtasks.",
    "- Preserve Bosun's existing graph unless there is a concrete reason to change it.",
    ...(mode === "decompose"
      ? [
          "- This is an explicit decomposition request for an existing task, so bias toward creating child subtasks directly under the parent task.",
          "- When you create subtasks, set parentTaskPatch.status to blocked unless the parent should remain runnable for a specific reason.",
          "- Use parentTaskPatch.blockedReason to explain that execution should flow through the decomposed child graph.",
        ]
      : []),
    "",
    "Task context JSON:",
    "```json",
    serialized,
    "```",
  ].join("\n");
}
