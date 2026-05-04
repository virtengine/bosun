export function createStickyMenuStateManager(options = {}) {
  const callbackActionDedupeMs = Math.max(
    150,
    Number(options.callbackActionDedupeMs || "1200") || 1200,
  );
  const stickyMenuBumpMs = Math.max(
    0,
    Number(options.stickyMenuBumpMs || "600") || 600,
  );
  const setTimeoutImpl =
    typeof options.setTimeoutImpl === "function"
      ? options.setTimeoutImpl
      : setTimeout;
  const clearTimeoutImpl =
    typeof options.clearTimeoutImpl === "function"
      ? options.clearTimeoutImpl
      : clearTimeout;
  const onResetChat =
    typeof options.onResetChat === "function" ? options.onResetChat : () => {};
  const onBump = typeof options.onBump === "function" ? options.onBump : null;
  const logStructured =
    typeof options.logStructured === "function"
      ? options.logStructured
      : () => {};

  const stickyMenuState = new Map();
  const stickyMenuTimers = new Map();
  const stickyMenuDiagnostics = new Map();
  const callbackActionDeduper = new Map();
  let stickyMenuSessionCounter = 0;

  function normalizeChatId(chatId) {
    return String(chatId || "");
  }

  function getState(chatId) {
    const key = normalizeChatId(chatId);
    return key ? stickyMenuState.get(key) || null : null;
  }

  function deleteState(chatId) {
    const key = normalizeChatId(chatId);
    if (!key) return false;
    return stickyMenuState.delete(key);
  }

  function resetAll() {
    for (const timer of stickyMenuTimers.values()) {
      clearTimeoutImpl(timer);
    }
    stickyMenuTimers.clear();
    stickyMenuState.clear();
    stickyMenuDiagnostics.clear();
    callbackActionDeduper.clear();
    stickyMenuSessionCounter = 0;
  }

  function setState(chatId, patch) {
    const key = normalizeChatId(chatId);
    if (!key) return null;
    const now = Date.now();
    const current = stickyMenuState.get(key) || {};
    const next = { ...current, ...patch };
    const rotatesSession = Boolean(
      next.enabled &&
        (!current.enabled ||
          !current.sessionId ||
          patch?.sessionReset === true ||
          (patch?.messageId != null &&
            String(patch.messageId) !== String(current.messageId || ""))),
    );
    if (rotatesSession) {
      stickyMenuSessionCounter += 1;
      next.sessionId = `sticky-${now.toString(36)}-${stickyMenuSessionCounter.toString(36)}`;
      next.sessionStartedAtMs = now;
    } else if (next.enabled) {
      next.sessionId = current.sessionId || next.sessionId || null;
      next.sessionStartedAtMs =
        current.sessionStartedAtMs || next.sessionStartedAtMs || now;
    }
    delete next.sessionReset;
    next.updatedAtMs = now;
    stickyMenuState.set(key, next);
    const currentDiag =
      stickyMenuDiagnostics.get(key) || { recoveryCount: 0, resetCount: 0 };
    stickyMenuDiagnostics.set(key, {
      ...currentDiag,
      chatId: key,
      lastSessionId: next.sessionId || currentDiag.lastSessionId || null,
      lastSessionStartedAtMs:
        next.sessionStartedAtMs || currentDiag.lastSessionStartedAtMs || null,
      lastSessionUpdatedAtMs: now,
      lastMode: next.mode || currentDiag.lastMode || null,
      lastScreenId: next.screenId || currentDiag.lastScreenId || null,
      lastMessageId: next.messageId || currentDiag.lastMessageId || null,
    });
    return next;
  }

  function getLeaseAgeMs(state, now = Date.now()) {
    const startedAtMs = Number(state?.sessionStartedAtMs || 0);
    if (!startedAtMs) return null;
    return Math.max(0, now - startedAtMs);
  }

  function getDiagnostics(chatId, now = Date.now()) {
    const key = normalizeChatId(chatId);
    const state = stickyMenuState.get(key) || null;
    const history = stickyMenuDiagnostics.get(key) || {};
    const startedAtMs =
      state?.sessionStartedAtMs || history.lastSessionStartedAtMs || null;
    return {
      chatId: key,
      enabled: Boolean(state?.enabled),
      mode: state?.mode || history.lastMode || null,
      screenId: state?.screenId || history.lastScreenId || null,
      messageId: state?.messageId || history.lastMessageId || null,
      sessionId: state?.sessionId || history.lastSessionId || null,
      leaseAgeMs: startedAtMs ? Math.max(0, now - startedAtMs) : null,
      updatedAgeMs: state?.updatedAtMs ? Math.max(0, now - state.updatedAtMs) : null,
      recoveryCount: history.recoveryCount || 0,
      lastRecovery: history.lastRecovery || null,
      lastDedupe: history.lastDedupe || null,
      resetCount: history.resetCount || 0,
      lastReset: history.lastReset || null,
    };
  }

  function clearTimer(chatId) {
    const key = normalizeChatId(chatId);
    const timer = stickyMenuTimers.get(key);
    if (timer) {
      clearTimeoutImpl(timer);
      stickyMenuTimers.delete(key);
    }
  }

  function clearCallbackActionDeduperForChat(chatId) {
    const prefix = `${normalizeChatId(chatId)}|`;
    for (const key of callbackActionDeduper.keys()) {
      if (key.startsWith(prefix)) {
        callbackActionDeduper.delete(key);
      }
    }
  }

  function resetContext(chatId, options = {}) {
    const key = normalizeChatId(chatId);
    if (!key) {
      return { applied: false, reason: String(options.reason || "operator") };
    }
    const now = Date.now();
    const before = getDiagnostics(key, now);
    clearTimer(key);
    stickyMenuState.delete(key);
    clearCallbackActionDeduperForChat(key);
    onResetChat(key);
    const currentDiag =
      stickyMenuDiagnostics.get(key) || { recoveryCount: 0, resetCount: 0 };
    const reset = {
      applied: Boolean(before.sessionId || before.messageId || before.lastDedupe),
      reason: String(options.reason || "operator"),
      atMs: now,
      previousSessionId: before.sessionId || null,
      previousLeaseAgeMs: before.leaseAgeMs,
      previousMode: before.mode || null,
      previousMessageId: before.messageId || null,
    };
    stickyMenuDiagnostics.set(key, {
      ...currentDiag,
      chatId: key,
      resetCount: (currentDiag.resetCount || 0) + 1,
      lastReset: reset,
    });
    return {
      ...reset,
      diagnostics: getDiagnostics(key, now),
    };
  }

  function isInteractive(chatId) {
    return getState(chatId)?.mode === "interactive";
  }

  function isMenuCallbackData(data) {
    return typeof data === "string" && (data.startsWith("ui:") || data.startsWith("cb:"));
  }

  function shouldRecoverStickyFromCallback(query) {
    const data = String(query?.data || "");
    if (!isMenuCallbackData(data)) return false;
    const messageId = query?.message?.message_id;
    const chatId = normalizeChatId(query?.message?.chat?.id);
    if (!chatId || !messageId) return false;
    const current = stickyMenuState.get(chatId);
    if (current?.enabled && current?.messageId) return false;
    return true;
  }

  function recoverContextFromCallback(query, reason = "callback") {
    if (!shouldRecoverStickyFromCallback(query)) {
      return {
        recovered: false,
        diagnostics: getDiagnostics(query?.message?.chat?.id || ""),
      };
    }
    const chatId = normalizeChatId(query.message.chat.id);
    const messageId = query.message.message_id;
    const data = String(query.data || "");
    const now = Date.now();
    const prev = stickyMenuState.get(chatId) || {};
    const screenId = prev.screenId || "home";
    const params = prev.params || {};
    const mode =
      data === "cb:dismiss" || data === "ui:cancel" ? "interactive" : "menu";
    const nextState = setState(chatId, {
      enabled: true,
      messageId,
      screenId,
      params,
      mode,
      restoreScreenId: prev.restoreScreenId || screenId,
      restoreParams: prev.restoreParams || params,
    });
    const currentDiag =
      stickyMenuDiagnostics.get(chatId) || { recoveryCount: 0, resetCount: 0 };
    const recovery = {
      reason,
      atMs: now,
      data,
      messageId,
      mode,
      sessionId: nextState?.sessionId || null,
      leaseAgeMs: getLeaseAgeMs(nextState, now),
    };
    stickyMenuDiagnostics.set(chatId, {
      ...currentDiag,
      chatId,
      recoveryCount: (currentDiag.recoveryCount || 0) + 1,
      lastRecovery: recovery,
    });
    logStructured("sticky_menu.context_recovered", {
      reason,
      chatId,
      messageId,
      mode,
      data,
      sessionId: recovery.sessionId,
      leaseAgeMs: recovery.leaseAgeMs,
    });
    return {
      recovered: true,
      diagnostics: getDiagnostics(chatId, now),
    };
  }

  function pruneCallbackActionDeduper(now = Date.now()) {
    for (const [key, entry] of callbackActionDeduper.entries()) {
      if (!entry || now - entry.atMs > callbackActionDedupeMs) {
        callbackActionDeduper.delete(key);
      }
    }
  }

  function dedupeCallbackAction({
    chatId,
    fromId,
    messageId,
    data,
    callbackId,
  }) {
    if (!isMenuCallbackData(data)) return { duplicate: false };
    const now = Date.now();
    const keyChatId = normalizeChatId(chatId);
    pruneCallbackActionDeduper(now);
    const key = [
      keyChatId,
      String(fromId || ""),
      String(messageId || ""),
      String(data || ""),
    ].join("|");
    const prev = callbackActionDeduper.get(key);
    callbackActionDeduper.set(key, {
      atMs: now,
      callbackId: String(callbackId || ""),
    });
    const ageMs = prev ? now - prev.atMs : null;
    const duplicate = Boolean(
      prev &&
        String(prev.callbackId || "") !== String(callbackId || "") &&
        ageMs <= callbackActionDedupeMs,
    );
    const diagnostics = getDiagnostics(keyChatId, now);
    const dedupe = {
      duplicate,
      decision: duplicate ? "deduped" : "accepted",
      key,
      ageMs,
      data: String(data || ""),
      callbackId: String(callbackId || ""),
      messageId: String(messageId || ""),
      fromId: String(fromId || ""),
      sessionId: diagnostics.sessionId || null,
      leaseAgeMs: diagnostics.leaseAgeMs,
    };
    const currentDiag =
      stickyMenuDiagnostics.get(keyChatId) || { recoveryCount: 0, resetCount: 0 };
    stickyMenuDiagnostics.set(keyChatId, {
      ...currentDiag,
      chatId: keyChatId,
      lastDedupe: dedupe,
    });
    return dedupe;
  }

  function getRestoreTarget(chatId) {
    const state = getState(chatId) || {};
    return {
      screenId: state.restoreScreenId || state.screenId || "home",
      params: state.restoreParams || state.params || {},
    };
  }

  function isMessage(chatId, messageId) {
    if (!chatId || !messageId) return false;
    const state = getState(chatId);
    if (!state?.enabled || !state?.messageId) return false;
    return String(state.messageId) === String(messageId);
  }

  function isStaleMessage(chatId, messageId) {
    if (!chatId || !messageId) return false;
    const state = getState(chatId);
    if (!state?.enabled || !state?.messageId) return false;
    return String(state.messageId) !== String(messageId);
  }

  function ensureEnabled(chatId, messageId, screenId, params) {
    const state = getState(chatId);
    if (state?.enabled) return true;
    if (!messageId) return false;
    setState(chatId, {
      enabled: true,
      messageId,
      screenId: screenId || state?.screenId || "home",
      params: params || state?.params || {},
      mode: "menu",
      restoreScreenId: null,
      restoreParams: null,
    });
    return true;
  }

  function scheduleBump(chatId, lastMessageId) {
    const key = normalizeChatId(chatId);
    const state = stickyMenuState.get(key);
    if (!state?.enabled || !state?.screenId || state.mode === "interactive") return;
    if (lastMessageId && state.messageId && lastMessageId === state.messageId) return;
    clearTimer(key);
    const timer = setTimeoutImpl(() => {
      stickyMenuTimers.delete(key);
      Promise.resolve(onBump ? onBump(key) : null).catch(() => {});
    }, stickyMenuBumpMs);
    stickyMenuTimers.set(key, timer);
  }

  return {
    clearTimer,
    dedupeCallbackAction,
    deleteState,
    ensureEnabled,
    getDiagnostics,
    getRestoreTarget,
    getState,
    isInteractive,
    isMessage,
    isStaleMessage,
    recoverContextFromCallback,
    resetAll,
    resetContext,
    scheduleBump,
    setState,
  };
}
