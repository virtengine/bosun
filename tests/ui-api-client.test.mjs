import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MODULES = [
  { label: "app ui", path: "../ui/modules/api.js" },
  { label: "site ui", path: "../site/ui/modules/api.js" },
];

const originalGlobals = {
  fetch: globalThis.fetch,
  location: globalThis.location,
  dispatchEvent: globalThis.dispatchEvent,
  CustomEvent: globalThis.CustomEvent,
  Telegram: globalThis.Telegram,
};

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

function restoreGlobal(name, value) {
  if (typeof value === "undefined") {
    delete globalThis[name];
    return;
  }
  setGlobal(name, value);
}

function createJsonResponse(data) {
  return {
    ok: true,
    json: async () => data,
  };
}

async function loadApiModule(relativePath) {
  vi.resetModules();
  const href = new URL(relativePath, import.meta.url).href;
  return import(`${href}?t=${Date.now()}-${Math.random()}`);
}

describe.each(MODULES)("$label api client", ({ path }) => {
  beforeEach(() => {
    setGlobal("location", new URL("http://localhost/dashboard"));
    setGlobal("dispatchEvent", vi.fn(() => true));
    setGlobal("CustomEvent", class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    });
    setGlobal("Telegram", undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreGlobal("fetch", originalGlobals.fetch);
    restoreGlobal("location", originalGlobals.location);
    restoreGlobal("dispatchEvent", originalGlobals.dispatchEvent);
    restoreGlobal("CustomEvent", originalGlobals.CustomEvent);
    restoreGlobal("Telegram", originalGlobals.Telegram);
  });

  it("limits concurrent GET dispatches to six requests", async () => {
    let active = 0;
    let maxActive = 0;
    const pendingResolvers = [];

    setGlobal("fetch", vi.fn((requestPath) => new Promise((resolve) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      pendingResolvers.push(() => {
        active -= 1;
        resolve(createJsonResponse({ ok: true, requestPath }));
      });
    })));

    const { apiFetch } = await loadApiModule(path);
    const requests = Array.from({ length: 7 }, (_, index) =>
      apiFetch(`/api/test-${index}`, { _silent: true }),
    );

    await vi.waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledTimes(6);
    });
    expect(maxActive).toBe(6);

    const firstBatch = pendingResolvers.splice(0, pendingResolvers.length);
    for (const release of firstBatch) {
      release();
    }

    await vi.waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledTimes(7);
    });

    const secondBatch = pendingResolvers.splice(0, pendingResolvers.length);
    for (const release of secondBatch) {
      release();
    }

    await Promise.all(requests);
    expect(maxActive).toBe(6);
  });

  it("dedupes matching inflight GET requests", async () => {
    let resolveFetch;
    setGlobal("fetch", vi.fn(() => new Promise((resolve) => {
      resolveFetch = () => resolve(createJsonResponse({ ok: true }));
    })));

    const { apiFetch } = await loadApiModule(path);
    const first = apiFetch("/api/status", { _silent: true });
    const second = apiFetch("/api/status", { _silent: true });

    expect(first).toBe(second);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    resolveFetch();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
  });
});
