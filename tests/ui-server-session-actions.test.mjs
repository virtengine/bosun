import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { skipLocallyForSpeed } from "./test-speed-gates.mjs";

const ENV_KEYS = [
  "BOSUN_ENV_NO_OVERRIDE",
  "TELEGRAM_UI_TLS_DISABLE",
  "TELEGRAM_UI_ALLOW_UNSAFE",
  "TELEGRAM_UI_TUNNEL",
  "NODE_TLS_REJECT_UNAUTHORIZED",
];

describe("ui-server session actions", () => {
  let envSnapshot = {};

  beforeEach(() => {
    envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.BOSUN_ENV_NO_OVERRIDE = "1";
    process.env.TELEGRAM_UI_TLS_DISABLE = "true";
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "true";
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
  });

  afterEach(async () => {
    const mod = await import("../server/ui-server.mjs");
    mod.stopTelegramUiServer();
    for (const key of ENV_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key];
    }
  });

  it.skipIf(skipLocallyForSpeed)("pauses and resumes a session through the HTTP session routes", async () => {
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: 0,
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;
    const baseUrl = String(mod.getTelegramUiUrl() || `http://127.0.0.1:${port}`).trim();
    if (baseUrl.startsWith("https://")) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }
    const apiUrl = (path) => new URL(path, `${baseUrl}/`).toString();

    const created = await fetch(apiUrl("/api/sessions/create"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "manual",
        prompt: "pause route regression",
      }),
    }).then((response) => response.json());

    expect(created.ok).toBe(true);
    const sessionId = created.session?.id;
    expect(sessionId).toBeTruthy();

    const pauseResponse = await fetch(
      apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/pause?workspace=all`),
      { method: "POST" },
    ).then((response) => response.json());
    expect(pauseResponse.ok).toBe(true);

    const pausedSession = await fetch(
      apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}?workspace=all&full=1`),
    ).then((response) => response.json());
    expect(pausedSession.session?.status).toBe("paused");

    const resumeResponse = await fetch(
      apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/resume?workspace=all`),
      { method: "POST" },
    ).then((response) => response.json());
    expect(resumeResponse.ok).toBe(true);

    const resumedSession = await fetch(
      apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}?workspace=all&full=1`),
    ).then((response) => response.json());
    expect(resumedSession.session?.status).toBe("active");
  }, 15000);

  it.skipIf(skipLocallyForSpeed)("renames sessions through the HTTP session route", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../server/ui-server.mjs");
    const { _resetSingleton, getSessionTracker } = await import("../infra/session-tracker.mjs");
    _resetSingleton({ persistDir: null });
    const server = await mod.startTelegramUiServer({
      port: 0,
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;
    const baseUrl = String(mod.getTelegramUiUrl() || `http://127.0.0.1:${port}`).trim();
    const apiUrl = (path) => new URL(path, `${baseUrl}/`).toString();
    const tracker = getSessionTracker();
    const sessionId = `rename-http-${Date.now()}`;
    tracker.createSession({
      id: sessionId,
      type: "primary",
      metadata: {
        title: "Before Rename",
        workspaceId: "ws-main",
      },
    });

    const beforeDetail = await fetch(
      apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}?workspace=all&full=1`),
    ).then((response) => response.json());

    expect(beforeDetail.session?.title).toBe("Before Rename");

    const renameResponse = await fetch(
      apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/rename?workspace=all`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "After Rename" }),
      },
    ).then((response) => response.json());

    expect(renameResponse.ok).toBe(true);

    const detailResponse = await fetch(
      apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}?workspace=all&full=1`),
    ).then((response) => response.json());

    expect(detailResponse.session?.title).toBe("After Rename");
    expect(detailResponse.session?.taskTitle).toBe("After Rename");
    expect(detailResponse.session?.metadata?.title).toBe("After Rename");
  }, 15000);

  it.skipIf(skipLocallyForSpeed)("keeps workspace-less null fixture shells out of the default session list", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../server/ui-server.mjs");
    const { _resetSingleton, getSessionTracker } = await import("../infra/session-tracker.mjs");
    _resetSingleton({ persistDir: null });
    const server = await mod.startTelegramUiServer({
      port: 0,
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;
    const baseUrl = String(mod.getTelegramUiUrl() || `http://127.0.0.1:${port}`).trim();
    const apiUrl = (path) => new URL(path, `${baseUrl}/`).toString();
    const tracker = getSessionTracker();

    tracker.createSession({
      id: "null",
      type: "primary",
      metadata: {},
    });
    tracker.createSession({
      id: "primary-real-session",
      type: "primary",
      metadata: {
        title: "Visible Session",
        workspaceId: "ws-main",
      },
    });

    const listResponse = await fetch(apiUrl("/api/sessions")).then((response) => response.json());
    expect(listResponse.ok).toBe(true);
    expect(listResponse.sessions.some((session) => session.id === "null")).toBe(false);
    expect(listResponse.sessions.some((session) => session.id === "primary-real-session")).toBe(true);

    const hiddenResponse = await fetch(apiUrl("/api/sessions?includeHidden=1")).then((response) => response.json());
    expect(hiddenResponse.ok).toBe(true);
    expect(hiddenResponse.sessions.some((session) => session.id === "null")).toBe(true);
  }, 15000);

  it.skipIf(skipLocallyForSpeed)("stores hidden compression metadata and serves session-scoped shredding drilldown routes", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../server/ui-server.mjs");
    const { _resetSingleton, getSessionTracker } = await import("../infra/session-tracker.mjs");
    const { clearShreddingStats, recordShreddingEvent } = await import("../workspace/context-cache.mjs");
    _resetSingleton({ persistDir: null });
    clearShreddingStats();
    const server = await mod.startTelegramUiServer({
      port: 0,
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;
    const baseUrl = String(mod.getTelegramUiUrl() || `http://127.0.0.1:${port}`).trim();
    const apiUrl = (path) => new URL(path, `${baseUrl}/`).toString();
    const tracker = getSessionTracker();

    const created = await fetch(apiUrl("/api/sessions/create"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "primary",
        title: "Compression Lab Left",
        hidden: true,
        hiddenInLists: true,
        source: "context-compression-lab",
        contextCompressionMode: "forced",
      }),
    }).then((response) => response.json());

    expect(created.ok).toBe(true);
    expect(created.session?.metadata).toEqual(expect.objectContaining({
      title: "Compression Lab Left",
      hidden: true,
      hiddenInLists: true,
      source: "context-compression-lab",
      contextCompressionMode: "forced",
    }));

    const sessionId = created.session?.id;
    tracker.recordEvent(sessionId, {
      id: "assistant-compacted-1",
      role: "assistant",
      content: "[Agent: summarized output]",
      timestamp: new Date().toISOString(),
      _compressed: "agent_tier1",
      meta: {
        usage: {
          inputTokens: 140,
          outputTokens: 28,
          totalTokens: 168,
          cacheInputTokens: 21,
        },
      },
    });
    recordShreddingEvent({
      sessionId,
      messageId: "assistant-compacted-1",
      stage: "message_compaction",
      decision: "compressed",
      originalChars: 480,
      compressedChars: 120,
      savedChars: 360,
      savedPct: 75,
      compressionKind: "agent_tier1",
      beforePreview: "Original assistant reasoning before compaction",
      afterPreview: "Compacted assistant reasoning",
    });

    const summaryResponse = await fetch(
      apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/context-compression?workspace=all`),
    ).then((response) => response.json());
    expect(summaryResponse.ok).toBe(true);
    expect(summaryResponse.metrics).toEqual(expect.objectContaining({
      compressionMode: "forced",
      compactEvents: 1,
      tokenUsage: expect.objectContaining({
        totalTokens: 168,
        cacheInputTokens: 21,
      }),
    }));
    expect(summaryResponse.recentEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId,
        messageId: "assistant-compacted-1",
        compressionKind: "agent_tier1",
      }),
    ]));

    const eventsResponse = await fetch(
      apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/shredding-events?workspace=all`),
    ).then((response) => response.json());
    expect(eventsResponse.ok).toBe(true);
    expect(eventsResponse.events).toEqual([
      expect.objectContaining({
        sessionId,
        messageId: "assistant-compacted-1",
        stage: "message_compaction",
      }),
    ]);

    const detailResponse = await fetch(
      apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/shredding-message/${encodeURIComponent("assistant-compacted-1")}?workspace=all`),
    ).then((response) => response.json());
    expect(detailResponse.ok).toBe(true);
    expect(detailResponse.message).toEqual(expect.objectContaining({
      id: "assistant-compacted-1",
      content: "[Agent: summarized output]",
    }));
    expect(detailResponse.before).toContain("Original assistant reasoning before compaction");
    expect(detailResponse.after).toContain("Compacted assistant reasoning");
  }, 15000);

  it("archives a live session by aborting the active turn and persisting terminal state", async () => {
    const { tryHandleHarnessSessionRoutes } = await import("../server/routes/harness-sessions.mjs");
    const { createSessionTracker } = await import("../infra/session-tracker.mjs");
    const tracker = createSessionTracker({ persistDir: null });
    const sessionId = "archive-live-session";
    tracker.createSession({
      id: sessionId,
      type: "primary",
      metadata: { workspaceId: "ws-main", title: "Archive Me" },
    });

    const controller = new AbortController();
    const ledgerUpserts = [];
    const res = {};

    await tryHandleHarnessSessionRoutes({
      req: { method: "POST" },
      res,
      path: `/api/sessions/${encodeURIComponent(sessionId)}/archive`,
      url: new URL(`http://localhost/api/sessions/${encodeURIComponent(sessionId)}/archive?workspace=all`),
      deps: {
        jsonResponse: (target, status, payload) => {
          target.statusCode = status;
          target.body = payload;
        },
        getBosunSessionManager: () => ({ listSessions: () => [], snapshot: () => ({ activeSessions: 0 }) }),
        getSessionTracker: () => tracker,
        mergeTrackerAndLedgerSessions: () => [],
        shouldHideSessionFromDefaultList: () => false,
        sessionMatchesWorkspaceContext: () => true,
        normalizeCandidatePath: (value) => value,
        repoRoot: process.cwd(),
        getPrimaryAgentName: () => "Codex",
        getAgentMode: () => "agent",
        broadcastUiEvent: () => {},
        broadcastSessionsSnapshot: () => {},
        sessionRunAbortControllers: new Map([[sessionId, controller]]),
        readJsonBody: async () => ({}),
        resolveSessionWorkspaceDir: () => process.cwd(),
        resolveInteractiveSessionExecutor: async () => null,
        readMultipartForm: async () => ({ files: [] }),
        sanitizePathSegment: (value) => value,
        ATTACHMENTS_ROOT: process.cwd(),
        extname: () => "",
        basename: (value) => value,
        randomBytes: (size) => Buffer.alloc(size, 1),
        writeFileSync: () => {},
        relative: () => "",
        MIME_TYPES: {},
        resolveAttachmentUrl: () => "",
        getSessionActivityFromStateLedger: () => null,
        normalizeLedgerSessionDocument: (value) => value,
        mergeSessionRecords: (trackerSession, ledgerSession) => trackerSession || ledgerSession || null,
        listDurableSessionsFromLedger: () => [],
        resolveUiStateLedgerOptions: () => ({}),
        upsertSessionRecordToStateLedger: (payload) => {
          ledgerUpserts.push(payload);
          return payload;
        },
        invalidateDurableSessionListCache: () => {},
        deleteSessionRecordFromStateLedger: () => {},
        resolveSessionWorktreePath: () => process.cwd(),
        existsSync: () => false,
        collectDiffStats: async () => null,
        getCompactDiffSummary: async () => null,
        getRecentCommits: async () => [],
        resolveActiveWorkspaceExecutionContext: () => null,
        resolveWorkspaceContextFromRequest: () => ({ workspaceId: "all" }),
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(controller.signal.aborted).toBe(true);
    expect(tracker.getSession(sessionId)?.status).toBe("archived");
    expect(ledgerUpserts).toHaveLength(1);
    expect(ledgerUpserts[0]).toEqual(expect.objectContaining({
      status: "archived",
      lifecycleStatus: "archived",
      runtimeState: "archived",
      runtimeIsLive: false,
    }));
  });

  it("deletes a live session by aborting the active turn and retiring the tracker entry", async () => {
    const { tryHandleHarnessSessionRoutes } = await import("../server/routes/harness-sessions.mjs");
    const { createSessionTracker } = await import("../infra/session-tracker.mjs");
    const tracker = createSessionTracker({ persistDir: null });
    const sessionId = "delete-live-session";
    tracker.createSession({
      id: sessionId,
      type: "primary",
      metadata: { workspaceId: "ws-main", title: "Delete Me" },
    });

    const controller = new AbortController();
    const deletedIds = [];
    const res = {};

    await tryHandleHarnessSessionRoutes({
      req: { method: "POST" },
      res,
      path: `/api/sessions/${encodeURIComponent(sessionId)}/delete`,
      url: new URL(`http://localhost/api/sessions/${encodeURIComponent(sessionId)}/delete?workspace=all`),
      deps: {
        jsonResponse: (target, status, payload) => {
          target.statusCode = status;
          target.body = payload;
        },
        getBosunSessionManager: () => ({ listSessions: () => [], snapshot: () => ({ activeSessions: 0 }) }),
        getSessionTracker: () => tracker,
        mergeTrackerAndLedgerSessions: () => [],
        shouldHideSessionFromDefaultList: () => false,
        sessionMatchesWorkspaceContext: () => true,
        normalizeCandidatePath: (value) => value,
        repoRoot: process.cwd(),
        getPrimaryAgentName: () => "Codex",
        getAgentMode: () => "agent",
        broadcastUiEvent: () => {},
        broadcastSessionsSnapshot: () => {},
        sessionRunAbortControllers: new Map([[sessionId, controller]]),
        readJsonBody: async () => ({}),
        resolveSessionWorkspaceDir: () => process.cwd(),
        resolveInteractiveSessionExecutor: async () => null,
        readMultipartForm: async () => ({ files: [] }),
        sanitizePathSegment: (value) => value,
        ATTACHMENTS_ROOT: process.cwd(),
        extname: () => "",
        basename: (value) => value,
        randomBytes: (size) => Buffer.alloc(size, 1),
        writeFileSync: () => {},
        relative: () => "",
        MIME_TYPES: {},
        resolveAttachmentUrl: () => "",
        getSessionActivityFromStateLedger: () => null,
        normalizeLedgerSessionDocument: (value) => value,
        mergeSessionRecords: (trackerSession, ledgerSession) => trackerSession || ledgerSession || null,
        listDurableSessionsFromLedger: () => [],
        resolveUiStateLedgerOptions: () => ({}),
        upsertSessionRecordToStateLedger: (payload) => payload,
        invalidateDurableSessionListCache: () => {},
        deleteSessionRecordFromStateLedger: (id) => {
          deletedIds.push(id);
        },
        resolveSessionWorktreePath: () => process.cwd(),
        existsSync: () => false,
        collectDiffStats: async () => null,
        getCompactDiffSummary: async () => null,
        getRecentCommits: async () => [],
        resolveActiveWorkspaceExecutionContext: () => null,
        resolveWorkspaceContextFromRequest: () => ({ workspaceId: "all" }),
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(controller.signal.aborted).toBe(true);
    expect(tracker.getSession(sessionId)).toBeNull();
    expect(deletedIds).toEqual([sessionId]);

    tracker.recordEvent(sessionId, {
      role: "assistant",
      type: "agent_message",
      content: "late event after delete should be ignored",
      timestamp: new Date().toISOString(),
    });
    expect(tracker.getSession(sessionId)).toBeNull();
  });

  it("reveals a session folder through the HTTP reveal route", async () => {
    const { tryHandleHarnessSessionRoutes } = await import("../server/routes/harness-sessions.mjs");
    const { createSessionTracker } = await import("../infra/session-tracker.mjs");
    const tracker = createSessionTracker({ persistDir: null });
    const sessionId = "reveal-session-folder";
    tracker.createSession({
      id: sessionId,
      type: "primary",
      metadata: {
        workspaceId: "ws-main",
        workspaceDir: "C:/repo/worktree-alpha",
        title: "Reveal Me",
      },
    });

    const revealedPaths = [];
    const res = {};

    await tryHandleHarnessSessionRoutes({
      req: { method: "POST" },
      res,
      path: `/api/sessions/${encodeURIComponent(sessionId)}/reveal`,
      url: new URL(`http://localhost/api/sessions/${encodeURIComponent(sessionId)}/reveal?workspace=all`),
      deps: {
        jsonResponse: (target, status, payload) => {
          target.statusCode = status;
          target.body = payload;
        },
        getBosunSessionManager: () => ({ listSessions: () => [], snapshot: () => ({ activeSessions: 0 }) }),
        getSessionTracker: () => tracker,
        mergeTrackerAndLedgerSessions: () => [],
        shouldHideSessionFromDefaultList: () => false,
        sessionMatchesWorkspaceContext: () => true,
        normalizeCandidatePath: (value) => value,
        repoRoot: process.cwd(),
        getPrimaryAgentName: () => "Codex",
        getAgentMode: () => "agent",
        broadcastUiEvent: () => {},
        broadcastSessionsSnapshot: () => {},
        sessionRunAbortControllers: new Map(),
        readJsonBody: async () => ({}),
        resolveSessionWorkspaceDir: () => process.cwd(),
        resolveInteractiveSessionExecutor: async () => null,
        readMultipartForm: async () => ({ files: [] }),
        sanitizePathSegment: (value) => value,
        ATTACHMENTS_ROOT: process.cwd(),
        extname: () => "",
        basename: (value) => value,
        randomBytes: (size) => Buffer.alloc(size, 1),
        writeFileSync: () => {},
        relative: () => "",
        MIME_TYPES: {},
        resolveAttachmentUrl: () => "",
        getSessionActivityFromStateLedger: () => null,
        normalizeLedgerSessionDocument: (value) => value,
        mergeSessionRecords: (trackerSession, ledgerSession) => trackerSession || ledgerSession || null,
        listDurableSessionsFromLedger: () => [],
        resolveUiStateLedgerOptions: () => ({}),
        upsertSessionRecordToStateLedger: (payload) => payload,
        invalidateDurableSessionListCache: () => {},
        deleteSessionRecordFromStateLedger: () => {},
        resolveSessionWorktreePath: async () => "C:/repo/worktree-alpha",
        existsSync: () => true,
        revealPathInShell: async (targetPath) => {
          revealedPaths.push(targetPath);
          return true;
        },
        collectDiffStats: async () => null,
        getCompactDiffSummary: async () => null,
        getRecentCommits: async () => [],
        resolveActiveWorkspaceExecutionContext: () => null,
        resolveWorkspaceContextFromRequest: () => ({ workspaceId: "all" }),
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, path: "C:/repo/worktree-alpha" });
    expect(revealedPaths).toEqual(["C:/repo/worktree-alpha"]);
  });

  it("supports delete-history as a dedicated session-history route", async () => {
    const { tryHandleHarnessSessionRoutes } = await import("../server/routes/harness-sessions.mjs");
    const { createSessionTracker } = await import("../infra/session-tracker.mjs");
    const tracker = createSessionTracker({ persistDir: null });
    const sessionId = "delete-session-history";
    tracker.createSession({
      id: sessionId,
      type: "primary",
      metadata: { workspaceId: "ws-main", title: "Delete History" },
    });

    const deletedIds = [];
    const res = {};

    await tryHandleHarnessSessionRoutes({
      req: { method: "POST" },
      res,
      path: `/api/sessions/${encodeURIComponent(sessionId)}/delete-history`,
      url: new URL(`http://localhost/api/sessions/${encodeURIComponent(sessionId)}/delete-history?workspace=all`),
      deps: {
        jsonResponse: (target, status, payload) => {
          target.statusCode = status;
          target.body = payload;
        },
        getBosunSessionManager: () => ({ listSessions: () => [], snapshot: () => ({ activeSessions: 0 }) }),
        getSessionTracker: () => tracker,
        mergeTrackerAndLedgerSessions: () => [],
        shouldHideSessionFromDefaultList: () => false,
        sessionMatchesWorkspaceContext: () => true,
        normalizeCandidatePath: (value) => value,
        repoRoot: process.cwd(),
        getPrimaryAgentName: () => "Codex",
        getAgentMode: () => "agent",
        broadcastUiEvent: () => {},
        broadcastSessionsSnapshot: () => {},
        sessionRunAbortControllers: new Map(),
        readJsonBody: async () => ({}),
        resolveSessionWorkspaceDir: () => process.cwd(),
        resolveInteractiveSessionExecutor: async () => null,
        readMultipartForm: async () => ({ files: [] }),
        sanitizePathSegment: (value) => value,
        ATTACHMENTS_ROOT: process.cwd(),
        extname: () => "",
        basename: (value) => value,
        randomBytes: (size) => Buffer.alloc(size, 1),
        writeFileSync: () => {},
        relative: () => "",
        MIME_TYPES: {},
        resolveAttachmentUrl: () => "",
        getSessionActivityFromStateLedger: () => null,
        normalizeLedgerSessionDocument: (value) => value,
        mergeSessionRecords: (trackerSession, ledgerSession) => trackerSession || ledgerSession || null,
        listDurableSessionsFromLedger: () => [],
        resolveUiStateLedgerOptions: () => ({}),
        upsertSessionRecordToStateLedger: (payload) => payload,
        invalidateDurableSessionListCache: () => {},
        deleteSessionRecordFromStateLedger: (id) => {
          deletedIds.push(id);
        },
        resolveSessionWorktreePath: async () => null,
        existsSync: () => false,
        collectDiffStats: async () => null,
        getCompactDiffSummary: async () => null,
        getRecentCommits: async () => [],
        resolveActiveWorkspaceExecutionContext: () => null,
        resolveWorkspaceContextFromRequest: () => ({ workspaceId: "all" }),
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(tracker.getSession(sessionId)).toBeNull();
    expect(deletedIds).toEqual([sessionId]);
  });
});
