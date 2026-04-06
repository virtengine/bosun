import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function read(relPath) {
  return readFileSync(resolve(process.cwd(), relPath), "utf8");
}

describe("chat session regressions", () => {
  it("keeps per-session pending attachment drafts and drag overlay in chat tab", () => {
    const source = read("ui/tabs/chat.js");
    expect(source).toContain("pendingAttachmentsBySessionId");
    expect(source).toContain("DRAFT_SESSION_KEY");
    expect(source).toContain("Drop files to attach");
    expect(source).toContain("Files can be dropped anywhere in this chat.");
    expect(source).toContain("onDragEnter=${handleChatDragEnter}");
    expect(source).toContain("sessionApiPath(targetSessionId, \"attachments\")");
  });

  it("routes session list/detail calls through workspace-aware session API paths", () => {
    const source = read("ui/components/session-list.js");
    expect(source).toContain("buildSessionApiPath");
    expect(source).toContain("getSessionHistoryState");
    expect(source).toContain("deleteSessionHistory");
    expect(source).toContain("revealSessionFolder");
    expect(source).toContain("reopenSessionHistory");
    expect(source).toContain("resolveSessionWorkspaceHint");
    expect(source).toContain("sessionPath(id, action = \"\")");
    expect(source).toContain("buildSessionApiPath(id, \"\", { workspace: \"all\" })");
    expect(source).toContain("shouldFallbackToAllSessions");
    expect(source).toContain("getSessionListState");
    expect(source).toContain("sessionsError.value = hasCachedData ? null : nextErrorState;");
    expect(source).toContain("const shouldRetainScopedSelection =");
    expect(source).toContain("previousSessionIds.has(currentSelectedSessionId)");
    expect(source).toContain('workspaceScope !== "all"');
    expect(source).toContain("selectedSessionId.value = selectedSessionStillExists ? currentSelectedSessionId : null;");
    expect(source).toContain("clearUnavailableSelectedSession(targetSessionId);");
    expect(source).toContain("History ready:");
    expect(source).toContain("Reveal folder");
    expect(source).toContain("deleteLabel");
    expect(source).toContain("Open transcript");

    const loadMessagesPattern = /export async function loadSessionMessages[\s\S]*?\n}\n\nfunction normalizePreview/;
    const loadMessagesBlock = loadMessagesPattern.exec(source)?.[0] || "";
    expect(loadMessagesBlock).not.toContain("sessionMessages.value = [];");
    expect(loadMessagesBlock).not.toContain("sessionPagination.value = null;");
    expect(loadMessagesBlock).toContain("const shouldRetryAll = shouldFallbackToAllSessions(err, baseUrl, fallbackUrl);");
    expect(loadMessagesBlock).toContain("res = await fetchSessionAtPath(fallbackUrl, limit, opts.offset);");
    expect(loadMessagesBlock).toContain('return { ok: false, error: errorState.isNotFound ? "not_found" : "unavailable" };');
    expect(source).toContain("const freshCandidates = existing");
    expect(source).toContain("const reuseCheck = reusePath");
    expect(source).toContain("reused: true");
  });

  it("keeps retained selection during list failures and recovers deterministically", () => {
    const source = read("ui/components/session-list.js");
    expect(source).toContain('const currentSelectedSessionId = String(selectedSessionId.value || "").trim();');
    expect(source).toContain('const workspaceScope = String(normalizedFilter.workspace || "active").trim().toLowerCase();');
    expect(source).toContain("const shouldRetainScopedSelection =");
    expect(source).toContain("const selectedSessionStillExists =");
    expect(source).toContain("sessionsError.value = hasCachedData ? null : nextErrorState;");
    expect(source).toContain("const listState = getSessionListState({");
  });

  it("retries inspector full-session fetches against workspace=all when scoped lookups 404", () => {
    const source = read("ui/app.js");
    expect(source).toContain("if (!isSessionTab || !sessionId || !session) {");
    expect(source).toContain("const fallbackSessionPath = buildSessionApiPath(sessionId, \"\", {");
    expect(source).toContain('workspace: "all"');
    expect(source).toContain("const shouldRetryAll = shouldFallbackToAllSessions(");
    expect(source).toContain("res = await apiFetch(fallbackSessionPath, { _silent: true });");
  });

  it("exposes workspace metadata in session summaries for UI routing", () => {
    const source = read("infra/session-tracker.mjs");
    expect(source).toContain("workspaceId: String(s?.metadata?.workspaceId || \"\").trim() || null");
    expect(source).toContain("workspaceDir: String(s?.metadata?.workspaceDir || \"\").trim() || null");
  });

  it("clears sticky thinking state when chat sends fail after optimistic status changes", () => {
    const source = read("ui/tabs/chat.js");
    expect(source).toContain("clearAgentStatus");
    expect(source).toContain("clearAgentStatus(sessionId);");
    expect(source).toContain("clearAgentStatus(newId);");
  });

  it("filters stale empty primary shells from the default session list", () => {
    const source = read("server/ui-server.mjs");
    expect(source).toContain("const staleEmptyPrimaryAgeMs = 30 * 60 * 1000;");
    expect(source).toContain("const staleEmptyPrimarySession =");
    expect(source).toContain("[\"primary\", \"manual\", \"chat\"].includes(normalizedType)");
    expect(source).toContain("turnCount <= 0");
    expect(source).toContain("totalEvents <= 0");
    expect(source).toContain("if (staleEmptyPrimarySession) return true;");
    expect(source).toContain("const syntheticChatFixtureIdentifier = identifiers.some((value) =>");
    expect(source).toContain("chat-(?:idle|stalled|runtime|replay|\\d+)");
  });

  it("clears stale route-selected chat ids once the session list finishes loading", () => {
    const source = read("ui/tabs/chat.js");
    expect(source).toContain("const isLoadingSessionList = sessionsLoading.value === true;");
    expect(source).toContain("const listedRouteSession = (sessionsData.value || []).some(");
    expect(source).toContain("lastAppliedRouteSessionIdRef");
    expect(source).toContain("lastAppliedRouteSessionIdRef.current === routeSessionId");
    expect(source).toContain("setRouteParams({}, { replace: true, skipGuard: true });");
  });

  it("refuses to reuse leaked test shells when creating a new chat session", () => {
    const source = read("ui/components/session-list.js");
    expect(source).toContain("function sessionLooksLikeTestLeak(session)");
    expect(source).toContain("!sessionLooksLikeTestLeak(s)");
    expect(source).toContain("metadata?.hiddenInLists === true");
    expect(source).toContain("null|undefined|\\(null\\)|session|null session");
  });

  it("persists session title edits back into durable session records", () => {
    const source = read("server/routes/harness-sessions.mjs");
    expect(source).toContain('if (action === "rename" && req.method === "POST")');
    expect(source).toContain("upsertSessionRecordToStateLedger({");
    expect(source).toContain("{ ...session.metadata, title }");
    expect(source).toContain("invalidateDurableSessionListCache()");
  });

  it("defines composerBusy before the stop-lock effect reads it", () => {
    const source = read("ui/tabs/chat.js");
    expect(source.indexOf("const composerBusy =")).toBeGreaterThan(-1);
    expect(source.indexOf("// Clear one-shot stop UI lock as soon as the selected agent reports idle.")).toBeGreaterThan(source.indexOf("const composerBusy ="));
  });

  it("queues follow-up chat submits by default while the agent is busy and renders the pending queue", () => {
    const source = read("ui/tabs/chat.js");
    expect(source).toContain('deliveryMode: "queue"');
    expect(source).toContain('if (composerBusy) {');
    expect(source).toContain("handleAddToQueue();");
    expect(source).toContain("Queue message (Enter)");
    expect(source).toContain("Queued Follow-ups");
    expect(source).toContain('primary="Steer with Message"');
    expect(source).toContain('secondary="Alt+Enter"');
  });

  it("binds repo and branch selectors to structured session surface metadata", () => {
    const source = read("ui/components/agent-selector.js");
    const siteSource = read("site/ui/components/agent-selector.js");
    expect(source).toContain("loadSessionBranches");
    expect(source).toContain("updateSessionSurface");
    expect(source).toContain("function SessionRepoPicker(");
    expect(source).toContain("function SessionBranchPicker(");
    expect(source).toContain("function SessionSurfaceOptionPicker(");
    expect(source).toContain('tooltipTitle="Continue in"');
    expect(source).toContain('tooltipTitle="Permissions"');
    expect(source).toContain('fallbackLabel="Local project"');
    expect(source).toContain('fallbackLabel="Default Permissions"');
    expect(source).toContain('requestKey="executionTarget"');
    expect(source).toContain('requestKey="permissionMode"');
    expect(source).toContain('placeholder="Search branches"');
    expect(source).toContain("selectedRepoPath: nextRepoPath");
    expect(source).toContain("branch: nextBranch");
    expect(source).toContain("Create and checkout");
    expect(source).not.toContain("YoloToggle");
    expect(source).not.toContain("ve-yolo-mode");
    expect(siteSource).toContain("loadSessionBranches");
    expect(siteSource).toContain("updateSessionSurface");
    expect(siteSource).toContain("function SessionRepoPicker(");
    expect(siteSource).toContain("function SessionBranchPicker(");
    expect(siteSource).toContain("function SessionSurfaceOptionPicker(");
    expect(siteSource).toContain('placeholder="Search branches"');
    expect(siteSource).not.toContain("YoloToggle");
    expect(siteSource).not.toContain("ve-yolo-mode");
  });

  it("passes session surface state into the chat toolbar and renders repo and branch chips in the header", () => {
    const source = read("ui/tabs/chat.js");
    const siteSource = read("site/ui/tabs/chat.js");
    expect(source).toContain("replaceSessionInList");
    expect(source).toContain("const sessionSurface = activeSession?.surface || null;");
    expect(source).toContain("const sessionRepoLabel = String(");
    expect(source).toContain("const sessionBranchLabel = String(");
    expect(source).toContain('label=${sessionRepoLabel}');
    expect(source).toContain('label=${sessionBranchLabel}');
    expect(source).toContain("<${ChatInputToolbar}");
    expect(source).toContain("sessionSurface=${sessionSurface}");
    expect(source).toContain("sessionWorkspace=${sessionWorkspaceScope}");
    expect(source).toContain("onSessionUpdated=${handleSessionSurfaceUpdated}");
    expect(source).toContain("getSessionHistoryState");
    expect(source).toContain("const sessionHistory = getSessionHistoryState(activeSession);");
    expect(source).toContain("Reveal Folder");
    expect(source).toContain("Delete History");
    expect(source).toContain("Resume Work");
    expect(source).not.toContain("yolo:");
    expect(siteSource).toContain("replaceSessionInList");
    expect(siteSource).toContain("const sessionSurface = activeSession?.surface || null;");
    expect(siteSource).toContain("sessionSurface=${sessionSurface}");
    expect(siteSource).toContain("sessionWorkspace=${sessionWorkspaceScope}");
    expect(siteSource).toContain("onSessionUpdated=${handleSessionSurfaceUpdated}");
    expect(siteSource).toContain("getSessionHistoryState");
    expect(siteSource).toContain("const sessionHistory = getSessionHistoryState(activeSession);");
    expect(siteSource).toContain("Reveal Folder");
    expect(siteSource).toContain("Delete History");
    expect(siteSource).toContain("Resume Work");
    expect(siteSource).not.toContain("yolo:");
  });

  it("adds explicit session-history routes for reveal and delete-history actions", () => {
    const source = read("server/routes/harness-sessions.mjs");
    expect(source).toContain('if (action === "reveal" && req.method === "POST")');
    expect(source).toContain('action === "delete-history"');
    expect(source).toContain("resolveSessionHistoryRevealPath");
    expect(source).toContain("session-history-deleted");
  });

  it("renders a visible context tracker in the chat header and toolbar from structured session surface metrics", () => {
    const source = read("ui/tabs/chat.js");
    const siteSource = read("site/ui/tabs/chat.js");
    expect(source).toContain("function ContextTrackerPanel(");
    expect(source).toContain("const [contextTrackerOpen, setContextTrackerOpen] = useState(false);");
    expect(source).toContain("const sessionContextWindow = sessionSurface?.contextWindow || activeSession?.insights?.contextWindow || null;");
    expect(source).toContain("const sessionContextBreakdown = Array.isArray(sessionSurface?.contextBreakdown)");
    expect(source).toContain("const showContextTracker = Boolean(");
    expect(source).toContain("Context ${summary.percentLabel}");
    expect(source).toContain("reserved for response");
    expect(source).toContain("headroom");
    expect(source).toContain("Compact Conversation");
    expect(source).toContain("contextBreakdown=${sessionContextBreakdown}");
    expect(siteSource).toContain("function ContextTrackerPanel(");
    expect(siteSource).toContain("const [contextTrackerOpen, setContextTrackerOpen] = useState(false);");
    expect(siteSource).toContain("const sessionContextWindow = sessionSurface?.contextWindow || activeSession?.insights?.contextWindow || null;");
    expect(siteSource).toContain("const sessionContextBreakdown = Array.isArray(sessionSurface?.contextBreakdown)");
    expect(siteSource).toContain("const showContextTracker = Boolean(");
    expect(siteSource).toContain("Context ${summary.percentLabel}");
    expect(siteSource).toContain("reserved for response");
    expect(siteSource).toContain("headroom");
    expect(siteSource).toContain("Compact Conversation");
    expect(siteSource).toContain("contextBreakdown=${sessionContextBreakdown}");
  });

  it("shows the inline transcript context tracker and breakdown details in both chat views", () => {
    const source = read("ui/components/chat-view.js");
    const siteSource = read("site/ui/components/chat-view.js");
    expect(source).toContain("function ContextTrackerSummary(");
    expect(source).toContain("const [showContextTracker, setShowContextTracker] = useState(false);");
    expect(source).toContain("const canShowContextTracker = Boolean(");
    expect(source).toContain("Context ${summary.percentLabel} · ${summary.usageLabel}");
    expect(source).toContain("Context breakdown unavailable.");
    expect(source).toContain("compactEvents > 0");
    expect(source).toContain("remainingTokens != null");
    expect(source).toContain("reservedForResponseTokens != null");
    expect(source).toContain("Input ${formatContextMetric(tokenUsage?.inputTokens || 0)}");
    expect(siteSource).toContain("function ContextTrackerSummary(");
    expect(siteSource).toContain("const [showContextTracker, setShowContextTracker] = useState(false);");
    expect(siteSource).toContain("const canShowContextTracker = Boolean(");
    expect(siteSource).toContain("Context ${summary.percentLabel} · ${summary.usageLabel}");
    expect(siteSource).toContain("Context breakdown unavailable.");
    expect(siteSource).toContain("compactEvents > 0");
    expect(siteSource).toContain("remainingTokens != null");
    expect(siteSource).toContain("reservedForResponseTokens != null");
    expect(siteSource).toContain("Input ${formatContextMetric(tokenUsage?.inputTokens || 0)}");
  });

  it("renders inline turn-scoped files changed cards in chat history", () => {
    const source = read("ui/components/chat-view.js");
    const siteSource = read("site/ui/components/chat-view.js");
    expect(source).toContain("function TurnFilesChangedCard(");
    expect(source).toContain('label="Files Changed"');
    expect(source).toContain("const turnSurfaceByIndex = useMemo(() => {");
    expect(source).toContain("const shouldRenderTurnFilesCard =");
    expect(source).toContain("summarizeTurnFileChanges(turn?.fileChanges)");
    expect(source).toContain("turnId=${turnDiffRef.turnId || turn?.id || \"\"}");
    expect(source).toContain("defaultExpandedFiles=${0}");
    expect(source).toContain("hideSummary=${true}");
    expect(siteSource).toContain("function TurnFilesChangedCard(");
    expect(siteSource).toContain('label="Files Changed"');
    expect(siteSource).toContain("const turnSurfaceByIndex = useMemo(() => {");
    expect(siteSource).toContain("const shouldRenderTurnFilesCard =");
    expect(siteSource).toContain("summarizeTurnFileChanges(turn?.fileChanges)");
    expect(siteSource).toContain("turnId=${turnDiffRef.turnId || turn?.id || \"\"}");
    expect(siteSource).toContain("defaultExpandedFiles=${0}");
    expect(siteSource).toContain("hideSummary=${true}");
  });

  it("extends the diff viewer with turn-scoped embedded loading", () => {
    const source = read("ui/components/diff-viewer.js");
    const siteSource = read("site/ui/components/diff-viewer.js");
    expect(source).toContain("turnId = \"\"");
    expect(source).toContain("turnIndex = null");
    expect(source).toContain("embedded = false");
    expect(source).toContain("hideSummary = false");
    expect(source).toContain("defaultExpandedFiles = 2");
    expect(source).toContain("if (normalizedTurnId) params.turnId = normalizedTurnId;");
    expect(source).toContain("if (normalizedTurnIndex != null) params.turnIndex = normalizedTurnIndex;");
    expect(siteSource).toContain("turnId = \"\"");
    expect(siteSource).toContain("turnIndex = null");
    expect(siteSource).toContain("embedded = false");
    expect(siteSource).toContain("hideSummary = false");
    expect(siteSource).toContain("defaultExpandedFiles = 2");
    expect(siteSource).toContain("if (normalizedTurnId) params.turnId = normalizedTurnId;");
    expect(siteSource).toContain("if (normalizedTurnIndex != null) params.turnIndex = normalizedTurnIndex;");
  });

  it("exposes a dedicated session surface update route for repo and branch changes", () => {
    const source = read("server/routes/harness-sessions.mjs");
    expect(source).toContain('if (action === "surface" && req.method === "POST")');
    expect(source).toContain("Selected repo is not available for this session");
    expect(source).toContain('reason: "session-surface-updated"');
    expect(source).toContain("selectedRepoPath: nextRepoPath");
    expect(source).toContain("selectedRepoName: basename(nextRepoPath)");
    expect(source).toContain('label: "Default Permissions"');
    expect(source).toContain('label: "Full access"');
    expect(source).toContain('label: "Local project"');
    expect(source).toContain('label: "Connect Codex web"');
  });

  it("stops hidden comparison sessions before resetting them and exposes executor controls", () => {
    const source = read("ui/tabs/context-compression-lab.js");
    expect(source).toContain("Stop & Reset Sessions");
    expect(source).toContain("stopLabSession(sessionIds.left)");
    expect(source).toContain("stopLabSession(sessionIds.right)");
    expect(source).toContain('label="Executor"');
    expect(source).toContain('label="Model"');
    expect(source).toContain("agent: paneConfigs.left?.agent || undefined");
    expect(source).toContain("agent: paneConfigs.right?.agent || undefined");
    expect(source).toContain('deliveryMode: forcedDeliveryMode || (leftBusy ? "queue" : "auto")');
    expect(source).toContain('deliveryMode: forcedDeliveryMode || (rightBusy ? "queue" : "auto")');
    expect(source).toContain("Queue to Both");
    expect(source).toContain("Steer Both Now");
    expect(source).toContain("Queued Follow-ups");
  });

  it("lets session messages override and persist the executor/model for harness runs", () => {
    const source = read("server/routes/harness-sessions.mjs");
    expect(source).toContain("body?.providerSelection || body?.agent || session?.metadata?.agent");
    expect(source).toContain("refreshedSession.metadata = nextMetadata");
    expect(source).toContain("providerSelection: turnAgent");
    expect(source).toContain("model: turnModel");
  });

  it("records codex lab compression stats against the owning session id and returns usage", () => {
    const source = read("shell/codex-shell.mjs");
    expect(source).toContain("sessionId: persistent ? persistentSessionId : logicalSessionId");
    expect(source).toContain("finalUsage = normalizeProviderUsageMetadata(");
    expect(source).toContain("usage: finalUsage");
  });
});

