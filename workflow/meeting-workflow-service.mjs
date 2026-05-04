import { createHash, randomUUID } from "node:crypto";
import { getSessionTracker } from "../infra/session-tracker.mjs";
import { createHarnessAgentService } from "../agent/harness-agent-service.mjs";
import {
  analyzeVisionFrame as analyzeVisionFrameDefault,
  isVoiceAvailable as isVoiceAvailableDefault,
  getVoiceConfig as getVoiceConfigDefault,
  getRealtimeConnectionInfo as getRealtimeConnectionInfoDefault,
} from "../voice/voice-relay.mjs";

const MAX_TRANSCRIPT_PAGE_SIZE = 500;
const DEFAULT_TRANSCRIPT_PAGE_SIZE = 100;
const MAX_VISION_FRAME_BYTES = Math.max(
  128_000,
  Number.parseInt(process.env.VISION_FRAME_MAX_BYTES || "", 10) || 2_000_000,
);
const DEFAULT_VISION_ANALYSIS_INTERVAL_MS = Math.min(
  30_000,
  Math.max(
    500,
    Number.parseInt(process.env.VISION_ANALYSIS_INTERVAL_MS || "", 10) || 1500,
  ),
);
const INACTIVE_MEETING_STATUSES = new Set([
  "paused",
  "archived",
  "completed",
  "failed",
  "cancelled",
]);
const ALLOWED_STOP_STATUSES = new Set([
  "active",
  "paused",
  "completed",
  "archived",
  "failed",
  "cancelled",
]);

const meetingVisionStateCache = new Map();

export class MeetingWorkflowServiceError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "MeetingWorkflowServiceError";
    this.code = String(code || "MEETING_WORKFLOW_ERROR");
    if (details !== undefined) this.details = details;
  }
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeNonEmptyString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function requireNonEmptyString(value, fieldName) {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    throw new MeetingWorkflowServiceError(
      "MEETING_VALIDATION_ERROR",
      `${fieldName} is required`,
      { field: fieldName },
    );
  }
  return normalized;
}

function normalizePositiveInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeSource(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "camera") return "camera";
  if (normalized === "screen" || normalized === "display") return "screen";
  return "screen";
}

function parseVisionFrameDataUrl(dataUrl) {
  const raw = String(dataUrl || "").trim();
  const match = raw.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) {
    throw new MeetingWorkflowServiceError(
      "MEETING_FRAME_INVALID",
      "frameDataUrl must be a base64 image data URL (jpeg/png/webp)",
    );
  }

  const base64Data = String(match[2] || "");
  const approxBytes = Math.floor((base64Data.length * 3) / 4);
  if (approxBytes <= 0) {
    throw new MeetingWorkflowServiceError(
      "MEETING_FRAME_INVALID",
      "frameDataUrl was empty",
    );
  }
  if (approxBytes > MAX_VISION_FRAME_BYTES) {
    throw new MeetingWorkflowServiceError(
      "MEETING_FRAME_TOO_LARGE",
      `frameDataUrl too large (${approxBytes} bytes > ${MAX_VISION_FRAME_BYTES} bytes limit)`,
      { approxBytes, maxBytes: MAX_VISION_FRAME_BYTES },
    );
  }

  return { raw, base64Data };
}

function getVisionState(sessionId, stateCache) {
  if (!stateCache.has(sessionId)) {
    stateCache.set(sessionId, {
      lastFrameHash: null,
      lastReceiptAt: 0,
      lastAnalyzedHash: null,
      lastAnalyzedAt: 0,
      lastSummary: "",
      inFlight: null,
    });
  }
  return stateCache.get(sessionId);
}

function summarizeSession(session) {
  if (!session) return null;
  return {
    id: session.id || session.taskId || null,
    taskId: session.taskId || session.id || null,
    type: session.type || "primary",
    status: session.status || "active",
    createdAt: session.createdAt || null,
    lastActiveAt: session.lastActiveAt || null,
    metadata: session.metadata || {},
    messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
  };
}

function extractResultText(result) {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  return String(
    result.finalResponse
      || result.text
      || result.message
      || "",
  );
}

function buildVoiceSummary({
  isVoiceAvailable,
  getVoiceConfig,
  getRealtimeConnectionInfo,
}) {
  try {
    const availability = isVoiceAvailable();
    const config = getVoiceConfig();
    const connectionInfo = availability?.tier === 1
      ? getRealtimeConnectionInfo()
      : null;

    return {
      available: Boolean(availability?.available),
      tier: availability?.tier ?? null,
      provider: availability?.provider || config?.provider || null,
      reason: availability?.reason || null,
      config: {
        provider: config?.provider || null,
        model: config?.model || null,
        visionModel: config?.visionModel || null,
        voiceId: config?.voiceId || null,
        turnDetection: config?.turnDetection || null,
        fallbackMode: config?.fallbackMode || null,
        delegateExecutor: config?.delegateExecutor || null,
        enabled: config?.enabled !== false,
      },
      connectionInfo,
    };
  } catch (err) {
    return {
      available: false,
      tier: null,
      provider: null,
      reason: `voice_config_unavailable: ${err?.message || err}`,
      config: null,
      connectionInfo: null,
    };
  }
}

function ensureSessionTrackerShape(sessionTracker) {
  const requiredMethods = [
    "getSessionById",
    "createSession",
    "recordEvent",
    "getSessionMessages",
    "updateSessionStatus",
  ];
  for (const method of requiredMethods) {
    if (typeof sessionTracker?.[method] !== "function") {
      throw new MeetingWorkflowServiceError(
        "MEETING_DEPENDENCY_ERROR",
        `sessionTracker missing required method: ${method}`,
      );
    }
  }
}

function buildMeetingMetadata(opts, getPrimaryAgentName, getAgentMode) {
  const metadata = {
    source: "workflow-meeting",
    agent: normalizeNonEmptyString(opts.agent) || normalizeNonEmptyString(getPrimaryAgentName()),
    mode: normalizeNonEmptyString(opts.mode) || normalizeNonEmptyString(getAgentMode()),
    model: normalizeNonEmptyString(opts.model),
  };

  if (opts.metadata && typeof opts.metadata === "object" && !Array.isArray(opts.metadata)) {
    return { ...opts.metadata, ...metadata };
  }
  return metadata;
}

export function createMeetingWorkflowService(dependencies = {}) {
  const deps = normalizeObject(dependencies);
  const sessionTracker = deps.sessionTracker || getSessionTracker();
  ensureSessionTrackerShape(sessionTracker);
  const agentRuntime =
    deps.agentRuntime && typeof deps.agentRuntime === "object"
      ? deps.agentRuntime
      : createHarnessAgentService();

  const runInteractivePrompt =
    typeof deps.runInteractivePrompt === "function"
      ? deps.runInteractivePrompt
      : typeof deps.execPrimaryPrompt === "function"
        ? deps.execPrimaryPrompt
      : agentRuntime.runInteractivePrompt?.bind(agentRuntime);
  const analyzeVisionFrame = deps.analyzeVisionFrame || analyzeVisionFrameDefault;
  const isVoiceAvailable = deps.isVoiceAvailable || isVoiceAvailableDefault;
  const getVoiceConfig = deps.getVoiceConfig || getVoiceConfigDefault;
  const getRealtimeConnectionInfo =
    deps.getRealtimeConnectionInfo || getRealtimeConnectionInfoDefault;
  const getPrimaryAgentName =
    typeof deps.getPrimaryAgentName === "function"
      ? deps.getPrimaryAgentName
      : agentRuntime.getPrimaryAgentName?.bind(agentRuntime);
  const getAgentMode =
    typeof deps.getAgentMode === "function"
      ? deps.getAgentMode
      : agentRuntime.getAgentMode?.bind(agentRuntime);
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const createMessageId = typeof deps.createMessageId === "function"
    ? deps.createMessageId
    : () => `msg-${now()}-${randomUUID().slice(0, 8)}`;
  const stateCache = deps.visionStateCache instanceof Map
    ? deps.visionStateCache
    : meetingVisionStateCache;

  if (typeof runInteractivePrompt !== "function") {
    throw new MeetingWorkflowServiceError(
      "MEETING_DEPENDENCY_ERROR",
      "runInteractivePrompt dependency must be a function",
    );
  }
  if (typeof analyzeVisionFrame !== "function") {
    throw new MeetingWorkflowServiceError(
      "MEETING_DEPENDENCY_ERROR",
      "analyzeVisionFrame dependency must be a function",
    );
  }

  function ensureMeetingSession(sessionId, opts = {}) {
    const meetingId = requireNonEmptyString(sessionId, "sessionId");
    const existing = sessionTracker.getSessionById(meetingId);
    if (existing) return { session: existing, created: false };

    const created = sessionTracker.createSession({
      id: meetingId,
      type: normalizeNonEmptyString(opts.type) || "primary",
      metadata: buildMeetingMetadata(opts, getPrimaryAgentName, getAgentMode),
      maxMessages: opts.maxMessages,
    });
    return { session: created, created: true };
  }

  async function startMeeting(opts = {}) {
    const options = normalizeObject(opts);
    const providedSessionId = normalizeNonEmptyString(options.sessionId || options.id);
    const sessionId = providedSessionId || `meeting-${now()}-${randomUUID().slice(0, 8)}`;
    const ensured = ensureMeetingSession(sessionId, options);

    if (options.activate === true) {
      sessionTracker.updateSessionStatus(sessionId, "active");
    }

    const session = sessionTracker.getSessionById(sessionId) || ensured.session;
    return {
      sessionId,
      created: ensured.created,
      session: summarizeSession(session),
      voice: buildVoiceSummary({
        isVoiceAvailable,
        getVoiceConfig,
        getRealtimeConnectionInfo,
      }),
    };
  }

  async function sendMeetingMessage(sessionId, content, opts = {}) {
    const options = normalizeObject(opts);
    const meetingId = requireNonEmptyString(sessionId, "sessionId");
    const message = requireNonEmptyString(content, "content");

    const ensureIfMissing = options.createIfMissing !== false;
    let session = sessionTracker.getSessionById(meetingId);
    if (!session && ensureIfMissing) {
      session = ensureMeetingSession(meetingId, options).session;
    }
    if (!session) {
      throw new MeetingWorkflowServiceError(
        "MEETING_SESSION_NOT_FOUND",
        `Session not found: ${meetingId}`,
      );
    }

    const status = String(session.status || "active").trim().toLowerCase();
    if (INACTIVE_MEETING_STATUSES.has(status) && options.allowInactive !== true) {
      throw new MeetingWorkflowServiceError(
        "MEETING_SESSION_INACTIVE",
        `Session is ${status}`,
        { sessionId: meetingId, status },
      );
    }

    const messageId = String(createMessageId());
    const observedEvents = [];
    const upstreamOnEvent = typeof options.onEvent === "function" ? options.onEvent : null;

    const onEvent = (err, event) => {
      const payload = event || err;
      if (!payload) return;
      observedEvents.push(payload);

      try {
        if (typeof payload === "string") {
          sessionTracker.recordEvent(meetingId, {
            role: "system",
            type: "system",
            content: payload,
            timestamp: new Date(now()).toISOString(),
          });
        } else {
          sessionTracker.recordEvent(meetingId, payload);
        }
      } catch {
        // best effort only; dispatch should continue
      }

      if (upstreamOnEvent) {
        try {
          upstreamOnEvent(err, event);
        } catch {
          // avoid user callback errors bubbling into active dispatch
        }
      }
    };

    try {
      const result = await runInteractivePrompt(message, {
        sessionId: meetingId,
        scope: `meeting:${meetingId}`,
        sessionType: String(session.type || "primary"),
        mode: normalizeNonEmptyString(options.mode) || undefined,
        model: normalizeNonEmptyString(options.model) || undefined,
        persistent: options.persistent !== false,
        sendRawEvents: options.sendRawEvents !== false,
        attachments: Array.isArray(options.attachments) ? options.attachments : undefined,
        attachmentsAppended: options.attachmentsAppended === true,
        timeoutMs: normalizePositiveInt(
          options.timeoutMs,
          undefined,
          1000,
          4 * 60 * 60 * 1000,
        ),
        cwd: normalizeNonEmptyString(options.cwd) || undefined,
        abortController: options.abortController,
        onEvent,
      });

      return {
        ok: true,
        sessionId: meetingId,
        messageId,
        status: "sent",
        responseText: extractResultText(result),
        adapter: result?.adapter || null,
        threadId: result?.threadId || result?.sessionId || meetingId,
        usage: result?.usage || null,
        observedEventCount: observedEvents.length,
        resultMetadata: {
          hasItems: Array.isArray(result?.items) && result.items.length > 0,
          hasRawResult: Boolean(result),
        },
      };
    } catch (err) {
      const messageText = err?.message || String(err);
      try {
        sessionTracker.recordEvent(meetingId, {
          role: "system",
          type: "error",
          content: `Agent error: ${messageText}`,
          timestamp: new Date(now()).toISOString(),
        });
      } catch {
        // best effort only
      }
      throw new MeetingWorkflowServiceError(
        "MEETING_MESSAGE_DISPATCH_FAILED",
        `Failed to send meeting message: ${messageText}`,
        { sessionId: meetingId },
      );
    }
  }

  async function fetchMeetingTranscript(sessionId, opts = {}) {
    const options = normalizeObject(opts);
    const meetingId = requireNonEmptyString(sessionId, "sessionId");
    const session = sessionTracker.getSessionMessages(meetingId);
    if (!session) {
      throw new MeetingWorkflowServiceError(
        "MEETING_SESSION_NOT_FOUND",
        `Session not found: ${meetingId}`,
      );
    }

    const pageSize = normalizePositiveInt(
      options.limit ?? options.pageSize,
      DEFAULT_TRANSCRIPT_PAGE_SIZE,
      1,
      MAX_TRANSCRIPT_PAGE_SIZE,
    );
    const requestedPage = normalizePositiveInt(options.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const messages = Array.isArray(session.messages) ? session.messages : [];
    const totalMessages = messages.length;
    const totalPages = totalMessages === 0 ? 0 : Math.ceil(totalMessages / pageSize);
    const page = totalPages === 0 ? 1 : Math.min(requestedPage, totalPages);
    const start = totalPages === 0 ? 0 : (page - 1) * pageSize;
    const end = Math.min(totalMessages, start + pageSize);

    return {
      sessionId: meetingId,
      status: String(session.status || "unknown"),
      sessionType: String(session.type || "primary"),
      metadata: session.metadata || {},
      createdAt: session.createdAt || null,
      lastActiveAt: session.lastActiveAt || null,
      totalMessages,
      page,
      pageSize,
      totalPages,
      hasNextPage: totalPages > 0 && page < totalPages,
      hasPreviousPage: totalPages > 0 && page > 1,
      messages: messages.slice(start, end),
    };
  }

  async function analyzeMeetingFrame(sessionId, frameDataUrl, opts = {}) {
    const options = normalizeObject(opts);
    const meetingId = requireNonEmptyString(sessionId, "sessionId");
    const parsedFrame = parseVisionFrameDataUrl(frameDataUrl);
    const source = normalizeSource(options.source);
    const forceAnalyze = options.forceAnalyze === true;
    const minIntervalMs = normalizePositiveInt(
      options.minIntervalMs,
      DEFAULT_VISION_ANALYSIS_INTERVAL_MS,
      300,
      30_000,
    );
    const width = Number.isFinite(Number(options.width)) ? Number(options.width) : null;
    const height = Number.isFinite(Number(options.height)) ? Number(options.height) : null;

    const state = getVisionState(meetingId, stateCache);
    const frameHash = createHash("sha1").update(parsedFrame.base64Data).digest("hex");
    const currentNow = now();

    state.lastFrameHash = frameHash;
    state.lastReceiptAt = currentNow;

    if (!forceAnalyze && state.inFlight) {
      return {
        ok: true,
        sessionId: meetingId,
        analyzed: false,
        skipped: true,
        reason: "analysis_in_progress",
        summary: state.lastSummary || undefined,
      };
    }

    if (!forceAnalyze && frameHash === state.lastAnalyzedHash) {
      return {
        ok: true,
        sessionId: meetingId,
        analyzed: false,
        skipped: true,
        reason: "duplicate_frame",
        summary: state.lastSummary || undefined,
      };
    }

    if (!forceAnalyze && currentNow - state.lastAnalyzedAt < minIntervalMs) {
      return {
        ok: true,
        sessionId: meetingId,
        analyzed: false,
        skipped: true,
        reason: "throttled",
        summary: state.lastSummary || undefined,
      };
    }

    const pending = analyzeVisionFrame(parsedFrame.raw, {
      source,
      context: {
        sessionId: meetingId,
        executor: normalizeNonEmptyString(options.executor) || undefined,
        mode: normalizeNonEmptyString(options.mode) || undefined,
        model: normalizeNonEmptyString(options.model) || undefined,
      },
      prompt: normalizeNonEmptyString(options.prompt) || undefined,
      model: normalizeNonEmptyString(options.visionModel) || undefined,
    });
    state.inFlight = pending;

    let analysis;
    try {
      analysis = await pending;
    } catch (err) {
      throw new MeetingWorkflowServiceError(
        "MEETING_VISION_ANALYSIS_FAILED",
        `Vision analysis failed: ${err?.message || err}`,
        { sessionId: meetingId },
      );
    } finally {
      if (state.inFlight === pending) state.inFlight = null;
    }

    const summary = normalizeNonEmptyString(analysis?.summary);
    if (!summary) {
      throw new MeetingWorkflowServiceError(
        "MEETING_VISION_ANALYSIS_FAILED",
        "Vision analysis returned an empty summary",
        { sessionId: meetingId },
      );
    }

    const session = sessionTracker.getSessionById(meetingId)
      || ensureMeetingSession(meetingId, options).session;
    const dimension = width && height ? ` (${width}x${height})` : "";
    sessionTracker.recordEvent(session.id || meetingId, {
      role: "system",
      type: "vision_summary",
      content: `[Vision ${source}${dimension}] ${summary}`,
      timestamp: new Date(now()).toISOString(),
      meta: {
        source,
        provider: normalizeNonEmptyString(analysis?.provider) || undefined,
        model: normalizeNonEmptyString(analysis?.model) || undefined,
      },
    });

    state.lastAnalyzedHash = frameHash;
    state.lastAnalyzedAt = now();
    state.lastSummary = summary;

    return {
      ok: true,
      sessionId: meetingId,
      analyzed: true,
      skipped: false,
      summary,
      provider: normalizeNonEmptyString(analysis?.provider),
      model: normalizeNonEmptyString(analysis?.model),
      frameHash,
    };
  }

  async function stopMeeting(sessionId, opts = {}) {
    const options = normalizeObject(opts);
    const meetingId = requireNonEmptyString(sessionId, "sessionId");
    const session = sessionTracker.getSessionById(meetingId);
    if (!session) {
      throw new MeetingWorkflowServiceError(
        "MEETING_SESSION_NOT_FOUND",
        `Session not found: ${meetingId}`,
      );
    }

    const status = normalizeNonEmptyString(options.status || "completed")?.toLowerCase();
    if (!status || !ALLOWED_STOP_STATUSES.has(status)) {
      throw new MeetingWorkflowServiceError(
        "MEETING_VALIDATION_ERROR",
        `status must be one of: ${Array.from(ALLOWED_STOP_STATUSES).join(", ")}`,
      );
    }

    sessionTracker.updateSessionStatus(meetingId, status);

    const note = normalizeNonEmptyString(options.note);
    if (note) {
      sessionTracker.recordEvent(meetingId, {
        role: "system",
        type: "system",
        content: note,
        timestamp: new Date(now()).toISOString(),
      });
    }

    if (status !== "active" && status !== "paused") {
      stateCache.delete(meetingId);
    }

    const updatedSession = sessionTracker.getSessionById(meetingId);
    return {
      ok: true,
      sessionId: meetingId,
      status,
      session: summarizeSession(updatedSession),
    };
  }

  return {
    startMeeting,
    sendMeetingMessage,
    fetchMeetingTranscript,
    analyzeMeetingFrame,
    stopMeeting,
  };
}

