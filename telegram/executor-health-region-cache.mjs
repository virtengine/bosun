export function createExecutorHealthRegionCache(options = {}) {
  const ttlMs = Math.max(1000, Number(options.ttlMs || "30000") || 30000);
  const defaultLoader =
    typeof options.loadExecutorRegionStatus === "function"
      ? options.loadExecutorRegionStatus
      : async () => null;
  const safeDetach =
    typeof options.safeDetach === "function"
      ? options.safeDetach
      : (_label, taskOrPromise) => {
          Promise.resolve(
            typeof taskOrPromise === "function" ? taskOrPromise() : taskOrPromise,
          ).catch(() => {});
        };

  let cache = {
    value: null,
    expiresAt: 0,
    inFlight: null,
  };

  function reset() {
    cache = {
      value: null,
      expiresAt: 0,
      inFlight: null,
    };
  }

  function refresh(loader = defaultLoader) {
    if (cache.inFlight) {
      return cache.inFlight;
    }

    const pending = Promise.resolve()
      .then(() => loader())
      .then((value) => {
        cache.value = value;
        cache.expiresAt = Date.now() + ttlMs;
        return value;
      })
      .finally(() => {
        if (cache.inFlight === pending) {
          cache.inFlight = null;
        }
      });

    cache.inFlight = pending;
    return pending;
  }

  async function getCachedStatus(options = {}) {
    const forceRefresh = options.forceRefresh === true;
    const loader =
      typeof options.loader === "function" ? options.loader : defaultLoader;
    const now = Date.now();

    if (!forceRefresh && cache.value && cache.expiresAt > now) {
      return cache.value;
    }

    if (!forceRefresh && cache.value) {
      safeDetach("health-region-refresh", refresh(loader));
      return cache.value;
    }

    return refresh(loader);
  }

  return {
    getCachedStatus,
    refresh,
    reset,
  };
}
