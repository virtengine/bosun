function adapterErrorText(err) {
  const message = String(err?.message || err || "");
  const code = String(err?.code || "");
  return `${code} ${message}`.trim();
}

function isSessionScopedAdapterError(err) {
  const text = adapterErrorText(err).toLowerCase();
  if (!text) return false;
  return (
    /\b(session|thread|conversation|context)\b.*\b(not found|expired|invalid|closed|corrupt)\b/.test(text)
    || /\bfailed to resume session\b/.test(text)
    || /\bsession does not exist\b/.test(text)
  );
}

function isInfrastructureAdapterError(err) {
  const text = adapterErrorText(err).toLowerCase();
  if (!text) return false;
  return (
    /\bagent_timeout\b/.test(text)
    || /\bcodex exec exited with code\b/.test(text)
    || /\btransport channel closed\b/.test(text)
    || /\bstream disconnected\b/.test(text)
    || /\brate limit|too many requests|429\b/.test(text)
    || /\bservice unavailable|temporarily unavailable|overloaded\b/.test(text)
    || /\bcannot find module\b/.test(text)
    || /\bsdk not available|failed to load sdk\b/.test(text)
    || /\beconnreset|econnrefused|etimedout|network error\b/.test(text)
    || /\bsegfault|crash|killed\b/.test(text)
  );
}

function createFailurePolicy(options = {}) {
  return {
    failoverConsecutiveInfraErrors: Math.max(
      1,
      Number(options.failoverConsecutiveInfraErrors || process.env.PRIMARY_AGENT_FAILOVER_CONSECUTIVE_INFRA_ERRORS) || 3,
    ),
    failoverErrorWindowMs: Math.max(
      10_000,
      Number(options.failoverErrorWindowMs || process.env.PRIMARY_AGENT_FAILOVER_ERROR_WINDOW_MS) || 10 * 60 * 1000,
    ),
    recoveryRetryAttempts: Number.isFinite(Number(options.recoveryRetryAttempts))
      ? Math.max(0, Number(options.recoveryRetryAttempts))
      : (() => {
          const parsed = Number(process.env.PRIMARY_AGENT_RECOVERY_RETRY_ATTEMPTS);
          return Number.isFinite(parsed) ? Math.max(0, parsed) : 1;
        })(),
  };
}

export function createQueryEngine(options = {}) {
  const failureState = new Map();
  const policy = createFailurePolicy(options);

  function clearAdapterFailureState(adapterName) {
    if (!adapterName) return;
    failureState.delete(adapterName);
  }

  function noteAdapterFailure(adapterName, err) {
    const now = Date.now();
    const infrastructure = isInfrastructureAdapterError(err);
    const previous = failureState.get(adapterName) || {
      streak: 0,
      lastAt: 0,
      lastError: "",
      infrastructure: false,
    };

    const next = {
      streak: 0,
      lastAt: now,
      lastError: adapterErrorText(err),
      infrastructure,
    };

    if (infrastructure) {
      const withinWindow =
        now - Number(previous.lastAt || 0) <= policy.failoverErrorWindowMs;
      next.streak =
        withinWindow && previous.infrastructure ? previous.streak + 1 : 1;
    }

    failureState.set(adapterName, next);
    return {
      ...next,
      allowFailover:
        infrastructure && next.streak >= policy.failoverConsecutiveInfraErrors,
    };
  }

  async function executeTurn(request = {}) {
    const adapters = request.adapters && typeof request.adapters === "object"
      ? request.adapters
      : {};
    const initialAdapterName = String(request.initialAdapterName || "").trim();
    const fallbackOrder = Array.isArray(request.fallbackOrder) ? request.fallbackOrder : [];
    const maxFailoverAttempts = Math.max(0, Number(request.maxFailoverAttempts) || 0);
    const recoveryRetryAttempts = Number.isFinite(Number(request.recoveryRetryAttempts))
      ? Math.max(0, Number(request.recoveryRetryAttempts))
      : policy.recoveryRetryAttempts;

    if (!initialAdapterName || !adapters[initialAdapterName]) {
      throw new Error("Query engine requires a valid initial adapter");
    }
    if (typeof request.executeAdapterTurn !== "function") {
      throw new Error("Query engine requires an executeAdapterTurn hook");
    }

    const adaptersToTry = [initialAdapterName];
    for (const name of fallbackOrder) {
      if (name !== initialAdapterName && adapters[name]) {
        if (typeof request.includeAdapter === "function" && !request.includeAdapter(name, adapters[name])) {
          continue;
        }
        adaptersToTry.push(name);
      }
    }

    let lastError = null;
    const maxAdaptersToTry = Math.min(adaptersToTry.length, maxFailoverAttempts + 1);

    for (let attempt = 0; attempt < maxAdaptersToTry; attempt += 1) {
      const adapterName = adaptersToTry[attempt];
      const adapter = adapters[adapterName];
      if (!adapter) continue;

      if (typeof request.prepareAdapter === "function") {
        try {
          await request.prepareAdapter({
            adapterName,
            adapter,
            attempt,
            previousAdapterName: attempt > 0 ? adaptersToTry[attempt - 1] : null,
            lastError,
          });
        } catch (prepareErr) {
          lastError = prepareErr;
          continue;
        }
      }

      try {
        const result = await request.executeAdapterTurn({
          adapterName,
          adapter,
          attempt,
          recovered: false,
          retry: 0,
        });
        clearAdapterFailureState(adapterName);
        if (typeof request.onSuccess === "function") {
          request.onSuccess({ adapterName, adapter, attempt, result, recovered: false });
        }
        return { ok: true, adapterName, result, recovered: false };
      } catch (err) {
        lastError = err;
        const isPrimaryAttempt = attempt === 0;
        if (typeof request.onFailure === "function") {
          request.onFailure({ adapterName, adapter, attempt, error: err });
        }

        if (
          isPrimaryAttempt &&
          recoveryRetryAttempts > 0 &&
          (isSessionScopedAdapterError(err) || isInfrastructureAdapterError(err))
        ) {
          for (let retry = 1; retry <= recoveryRetryAttempts; retry += 1) {
            if (typeof request.onRecoveryAttempt === "function") {
              request.onRecoveryAttempt({ adapterName, adapter, retry, maxRetries: recoveryRetryAttempts, error: lastError });
            }
            try {
              if (typeof request.recoverAdapter === "function") {
                await request.recoverAdapter({ adapterName, adapter, retry, maxRetries: recoveryRetryAttempts, error: lastError });
              }
              const result = await request.executeAdapterTurn({
                adapterName,
                adapter,
                attempt,
                recovered: true,
                retry,
              });
              clearAdapterFailureState(adapterName);
              if (typeof request.onRecoverySuccess === "function") {
                request.onRecoverySuccess({ adapterName, adapter, retry, maxRetries: recoveryRetryAttempts, result });
              }
              if (typeof request.onSuccess === "function") {
                request.onSuccess({ adapterName, adapter, attempt, result, recovered: true, retry });
              }
              return { ok: true, adapterName, result, recovered: true, retry };
            } catch (retryErr) {
              lastError = retryErr;
              if (typeof request.onRecoveryFailure === "function") {
                request.onRecoveryFailure({ adapterName, adapter, retry, maxRetries: recoveryRetryAttempts, error: retryErr });
              }
            }
          }
        }

        const currentFailureState = noteAdapterFailure(adapterName, lastError);
        const shouldBlockPrimaryFailover =
          isPrimaryAttempt && !currentFailureState.allowFailover;

        if (shouldBlockPrimaryFailover) {
          const waitReason = currentFailureState.infrastructure
            ? `holding failover until ${policy.failoverConsecutiveInfraErrors} consecutive infrastructure failures (${currentFailureState.streak}/${policy.failoverConsecutiveInfraErrors})`
            : "error classified as session-scoped/non-infrastructure";
          if (typeof request.onFailoverSuppressed === "function") {
            request.onFailoverSuppressed({
              adapterName,
              adapter,
              attempt,
              error: lastError,
              waitReason,
              failureState: currentFailureState,
            });
          }
          return {
            ok: false,
            suppressed: true,
            adapterName,
            error: lastError,
            waitReason,
            failureState: currentFailureState,
          };
        }

        if (attempt < maxAdaptersToTry - 1 && typeof request.onFailover === "function") {
          request.onFailover({
            fromAdapterName: adapterName,
            toAdapterName: adaptersToTry[attempt + 1],
            attempt,
            error: lastError,
          });
        }
      }
    }

    if (typeof request.onExhausted === "function") {
      request.onExhausted({ error: lastError, isTimeout: String(lastError?.message || "").startsWith("AGENT_TIMEOUT") });
    }
    return {
      ok: false,
      exhausted: true,
      error: lastError,
      isTimeout: String(lastError?.message || "").startsWith("AGENT_TIMEOUT"),
    };
  }

  return {
    policy,
    clearAdapterFailureState,
    noteAdapterFailure,
    executeTurn,
  };
}

export default createQueryEngine;
