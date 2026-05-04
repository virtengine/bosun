import { describe, expect, it } from "vitest";

import {
  classifySessionRequestError,
  formatSessionFreshnessTimestamp,
  getSessionHistoryState,
  getSessionManualRetryState,
  getSessionListState,
  getSessionLifecycleState,
  getSessionRecencyTimestamp,
  getSessionRuntimeState,
  buildSessionApiPath,
  createSessionLoadMeta,
  getSessionRetryDelayMs,
  markSessionLoadFailure,
  markSessionLoadSuccess,
  resetSessionRetryMeta,
  resolveSessionWorkspaceHint,
  shouldFallbackToAllSessions,
} from "../ui/modules/session-api.js";

describe("session api workspace routing", () => {
  it("preserves workspace=all in session detail paths", () => {
    const path = buildSessionApiPath("abc123", "", { workspace: "all" });
    expect(path).toBe("/api/sessions/abc123?workspace=all");
  });

  it("normalizes wildcard workspace hints to all", () => {
    const path = buildSessionApiPath("abc123", "message", { workspace: "*" });
    expect(path).toBe("/api/sessions/abc123/message?workspace=all");
  });

  it("falls back to all when session metadata is absent", () => {
    expect(resolveSessionWorkspaceHint(null, "all")).toBe("all");
  });

  it("formats freshness labels with relative and absolute timestamps", () => {
    const label = formatSessionFreshnessTimestamp("2026-01-02T00:00:00.000Z", {
      formatRelative: () => "2m ago",
      formatDate: () => "Jan 2, 2026, 12:00 AM",
    });
    expect(label).toBe("2m ago (Jan 2, 2026, 12:00 AM)");
    expect(formatSessionFreshnessTimestamp(null)).toBe("unknown");
  });

  it("disables manual retry while retry backoff is active", () => {
    const now = Date.UTC(2026, 0, 2, 0, 0, 0);
    const pendingRetry = createSessionLoadMeta({
      stale: true,
      retryAttempt: 2,
      maxAttempts: 5,
      nextRetryAt: new Date(now + 5000).toISOString(),
    });
    expect(getSessionManualRetryState(pendingRetry, { now })).toEqual(
      expect.objectContaining({
        disabled: true,
        label: "Retry in 5s",
        reason: "Manual retry is disabled while automatic backoff is active.",
        retrySeconds: 5,
        backoffActive: true,
      }),
    );

    const exhaustedRetry = createSessionLoadMeta({
      stale: true,
      retryAttempt: 5,
      retriesExhausted: true,
      maxAttempts: 5,
      nextRetryAt: null,
    });
    expect(getSessionManualRetryState(exhaustedRetry, { now })).toEqual(
      expect.objectContaining({
        disabled: false,
        label: "Retry now",
        reason: "",
        retrySeconds: 0,
        backoffActive: false,
      }),
    );
  });
});

describe("session api stale/retry metadata", () => {
  it("computes bounded retry backoff delays", () => {
    const meta = createSessionLoadMeta({
      baseDelayMs: 1000,
      maxDelayMs: 5000,
      backoffMultiplier: 2,
      maxAttempts: 5,
    });
    expect(getSessionRetryDelayMs(1, meta)).toBe(1000);
    expect(getSessionRetryDelayMs(2, meta)).toBe(2000);
    expect(getSessionRetryDelayMs(3, meta)).toBe(4000);
    expect(getSessionRetryDelayMs(4, meta)).toBe(5000);
    expect(getSessionRetryDelayMs(5, meta)).toBe(5000);
  });

  it("marks stale after failures and stops scheduling when attempts are exhausted", () => {
    const now = Date.UTC(2026, 0, 2, 0, 0, 0);
    let meta = createSessionLoadMeta({
      maxAttempts: 2,
      baseDelayMs: 1000,
      maxDelayMs: 5000,
      backoffMultiplier: 2,
    });

    meta = markSessionLoadFailure(meta, now);
    expect(meta.stale).toBe(true);
    expect(meta.retryAttempt).toBe(1);
    expect(meta.retriesExhausted).toBe(false);
    expect(meta.nextRetryAt).toBe(new Date(now + 1000).toISOString());

    meta = markSessionLoadFailure(meta, now + 1000);
    expect(meta.retryAttempt).toBe(2);
    expect(meta.retriesExhausted).toBe(false);
    expect(meta.nextRetryAt).toBe(new Date(now + 3000).toISOString());

    meta = markSessionLoadFailure(meta, now + 3000);
    expect(meta.retryAttempt).toBe(3);
    expect(meta.retriesExhausted).toBe(true);
    expect(meta.nextRetryAt).toBe(null);
  });

  it("resets stale retry counters on success and manual reset", () => {
    const now = Date.UTC(2026, 0, 2, 0, 0, 0);
    let meta = createSessionLoadMeta();
    meta = markSessionLoadFailure(meta, now, {
      staleReason: {
        code: "request_failed",
        message: "Gateway timeout",
      },
    });
    meta = markSessionLoadFailure(meta, now + 1000);
    expect(meta.stale).toBe(true);
    expect(meta.retryAttempt).toBeGreaterThan(0);
    expect(meta.staleReasonCode).toBe("request_failed");
    expect(meta.staleReasonLabel).toBe("Refresh request failed");
    expect(meta.staleReason).toBe("Gateway timeout");
    expect(meta.lastFailureAt).toBe(new Date(now).toISOString());

    const successMeta = markSessionLoadSuccess(meta, now + 2000);
    expect(successMeta.stale).toBe(false);
    expect(successMeta.retryAttempt).toBe(0);
    expect(successMeta.retriesExhausted).toBe(false);
    expect(successMeta.lastSuccessAt).toBe(new Date(now + 2000).toISOString());
    expect(successMeta.staleReason).toBe(null);
    expect(successMeta.staleReasonCode).toBe(null);
    expect(successMeta.staleReasonLabel).toBe(null);
    expect(successMeta.staleReasonMeta).toBe(null);

    const resetMeta = resetSessionRetryMeta(markSessionLoadFailure(successMeta, now + 3000));
    expect(resetMeta.retryAttempt).toBe(0);
    expect(resetMeta.nextRetryAt).toBe(null);
    expect(resetMeta.retriesExhausted).toBe(false);
  });
});


describe("session api request classification", () => {
  it("classifies not-found, transient, and fatal request errors", () => {
    expect(classifySessionRequestError(new Error("Session not found")).key).toBe("not_found");
    expect(classifySessionRequestError(new Error("Request failed (404)")).key).toBe("not_found");
    expect(classifySessionRequestError(new Error("Gateway timeout")).key).toBe("unavailable");
    expect(classifySessionRequestError(new Error("Boom"))).toEqual(
      expect.objectContaining({ key: "fatal", isNotFound: false, isTransient: false }),
    );
  });

  it("falls back to workspace=all only for scoped not-found errors", () => {
    expect(shouldFallbackToAllSessions(new Error("Session not found"), "/a", "/b")).toBe(true);
    expect(shouldFallbackToAllSessions(new Error("Gateway timeout"), "/a", "/b")).toBe(false);
    expect(shouldFallbackToAllSessions(new Error("Session not found"), "/a", "/a")).toBe(false);
  });
});
describe("session api list state", () => {
  it("classifies resilient session list states consistently", () => {
    expect(
      getSessionListState({
        sessions: [],
        error: null,
        loadMeta: createSessionLoadMeta(),
      }),
    ).toEqual(
      expect.objectContaining({
        key: "ready",
        isError: false,
        canRetry: false,
      }),
    );

    expect(
      getSessionListState({
        sessions: [{ id: "s-1" }],
        error: null,
        loadMeta: createSessionLoadMeta({
          stale: true,
          lastSuccessAt: "2026-01-02T00:00:00.000Z",
          staleReason: "Gateway timeout",
        }),
      }),
    ).toEqual(
      expect.objectContaining({
        key: "stale",
        isError: false,
        canRetry: true,
      }),
    );

    expect(
      getSessionListState({
        sessions: [],
        error: "not_found",
        loadMeta: createSessionLoadMeta(),
      }),
    ).toEqual(
      expect.objectContaining({
        key: "not_found",
        isError: true,
        canRetry: true,
      }),
    );

    expect(
      getSessionListState({
        sessions: [],
        error: { key: "unavailable" },
        loadMeta: createSessionLoadMeta(),
      }),
    ).toEqual(
      expect.objectContaining({
        key: "unavailable",
        isError: true,
        canRetry: true,
      }),
    );
  });

});

describe("session lifecycle/runtime metadata", () => {
  it("keeps lifecycle state separate from live runtime state", () => {
    expect(
      getSessionLifecycleState({
        status: "idle",
        lifecycleStatus: "active",
      }),
    ).toEqual(
      expect.objectContaining({
        key: "active",
        label: "Active",
        isActive: true,
      }),
    );

    expect(
      getSessionRuntimeState({
        status: "idle",
        lifecycleStatus: "active",
        runtimeState: "running",
      }),
    ).toEqual(
      expect.objectContaining({
        key: "running",
        label: "Running",
        isLive: true,
        isStale: false,
        source: "runtime",
      }),
    );
  });

  it("falls back to session recency when runtime state is missing", () => {
    const now = Date.UTC(2026, 0, 2, 0, 5, 0);

    expect(
      getSessionRuntimeState(
        {
          lifecycleStatus: "active",
          lastActiveAt: new Date(now - 45_000).toISOString(),
        },
        { now },
      ),
    ).toEqual(
      expect.objectContaining({
        key: "recent",
        label: "Recent",
        isLive: false,
        isStale: false,
        source: "recency",
      }),
    );

    expect(
      getSessionRuntimeState(
        {
          lifecycleStatus: "active",
          lastActiveAt: new Date(now - 11 * 60_000).toISOString(),
        },
        { now },
      ),
    ).toEqual(
      expect.objectContaining({
        key: "stale",
        label: "Stale",
        isLive: false,
        isStale: true,
        source: "recency",
      }),
    );
  });

  it("treats no-output task sessions as non-live runtime state", () => {
    expect(
      getSessionRuntimeState({
        lifecycleStatus: "active",
        status: "no_output",
        runtimeState: "no_output",
        turnCount: 0,
        lastActiveAt: "2026-03-31T19:24:37.199Z",
      }),
    ).toEqual(
      expect.objectContaining({
        key: "no_output",
        label: "No Output",
        isLive: false,
        isStale: false,
        source: "runtime",
      }),
    );
  });

  it("downgrades runtime-active sessions to recency when they are not live", () => {
    const now = Date.UTC(2026, 3, 2, 6, 0, 0);

    expect(
      getSessionRuntimeState(
        {
          lifecycleStatus: "active",
          status: "active",
          runtimeState: "active",
          runtimeIsLive: false,
          lastActiveAt: new Date(now - 30_000).toISOString(),
        },
        { now },
      ),
    ).toEqual(
      expect.objectContaining({
        key: "recent",
        source: "runtime",
        isLive: false,
      }),
    );

    expect(
      getSessionRuntimeState(
        {
          lifecycleStatus: "active",
          status: "active",
          runtimeState: "active",
          runtimeIsLive: false,
          lastActiveAt: new Date(now - 12 * 60_000).toISOString(),
        },
        { now },
      ),
    ).toEqual(
      expect.objectContaining({
        key: "stale",
        source: "runtime",
        isLive: false,
        isStale: true,
      }),
    );
  });

  it("derives explicit history metadata for cold-reopen and folder actions", () => {
    expect(
      getSessionHistoryState({
        lifecycleStatus: "archived",
        status: "archived",
        metadata: {
          selectedRepoPath: "/repo/worktree-alpha",
        },
      }),
    ).toEqual(
      expect.objectContaining({
        key: "archived",
        label: "Archived history",
        isHistoric: true,
        canResumeWork: true,
        canRevealFolder: true,
        folderPath: "/repo/worktree-alpha",
        deleteLabel: "Delete history",
      }),
    );

    expect(
      getSessionHistoryState({
        lifecycleStatus: "completed",
        status: "completed",
        runtimeState: "stopped",
      }),
    ).toEqual(
      expect.objectContaining({
        key: "historic",
        label: "Cold reopen ready",
        isHistoric: true,
        canResumeWork: false,
        reopenLabel: "Reopen transcript",
      }),
    );
  });

  it("downgrades persisted running snapshots when the runtime is no longer live", () => {
    const now = Date.UTC(2026, 3, 2, 0, 5, 0);

    expect(
      getSessionRuntimeState(
        {
          lifecycleStatus: "active",
          status: "active",
          runtimeState: "running",
          runtimeIsLive: false,
          lastActiveAt: new Date(now - 45_000).toISOString(),
        },
        { now },
      ),
    ).toEqual(
      expect.objectContaining({
        key: "recent",
        label: "Recent",
        isLive: false,
        source: "runtime",
      }),
    );

    expect(
      getSessionRuntimeState(
        {
          lifecycleStatus: "active",
          status: "active",
          runtimeState: "running",
          runtimeIsLive: false,
          lastActiveAt: new Date(now - 11 * 60_000).toISOString(),
        },
        { now },
      ),
    ).toEqual(
      expect.objectContaining({
        key: "stale",
        label: "Stale",
        isLive: false,
        isStale: true,
        source: "runtime",
      }),
    );
  });

  it("reports non-live runtime for terminal lifecycle states", () => {
    expect(
      getSessionRuntimeState({
        lifecycleStatus: "completed",
        status: "completed",
        lastActiveAt: "2026-01-02T00:00:00.000Z",
      }),
    ).toEqual(
      expect.objectContaining({
        key: "stopped",
        label: "Not live",
        isLive: false,
        source: "lifecycle",
      }),
    );
  });

  it("prefers terminal lifecycle over stale running runtime snapshots", () => {
    expect(
      getSessionRuntimeState({
        lifecycleStatus: "completed",
        status: "completed",
        runtimeState: "running",
        runtimeIsLive: false,
        lastActiveAt: "2026-04-01T10:57:15.110Z",
      }),
    ).toEqual(
      expect.objectContaining({
        key: "stopped",
        label: "Not live",
        isLive: false,
        source: "lifecycle",
      }),
    );
  });

  it("uses lastActiveAt before updatedAt and createdAt for session recency", () => {
    expect(
      getSessionRecencyTimestamp({
        createdAt: "2026-01-01T23:59:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        lastActiveAt: "2026-01-02T00:01:00.000Z",
      }),
    ).toBe("2026-01-02T00:01:00.000Z");

    expect(
      getSessionRecencyTimestamp({
        createdAt: "2026-01-01T23:59:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
    ).toBe("2026-01-02T00:00:00.000Z");
  });
});
