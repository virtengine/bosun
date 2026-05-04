import { afterEach, describe, expect, it, vi } from "vitest";

import * as providersModule from "../shell/opencode-providers.mjs";

const {
  discoverProviders,
  getProviderModels,
  invalidateCache,
} = providersModule;

afterEach(() => {
  vi.restoreAllMocks();
  invalidateCache();
});

describe("opencode-providers", () => {
  it("delegates provider discovery into the agent-owned registry snapshot", async () => {
    vi.spyOn(process, "cwd").mockReturnValue("");

    const snapshot = await discoverProviders({ force: true });
    expect(Array.isArray(snapshot.providers)).toBe(true);
    expect(Array.isArray(snapshot.connectedIds)).toBe(true);
    expect(snapshot.providers.every((entry) => entry.source === "registry")).toBe(true);

    const models = await getProviderModels("openai-compatible", { force: true });
    expect(Array.isArray(models)).toBe(true);
    expect(models.every((entry) => entry.providerID === "openai-compatible")).toBe(true);
  }, 15000);
});
