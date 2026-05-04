import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutorHealthRegionCache } from "../telegram/executor-health-region-cache.mjs";

describe("telegram health region cache", () => {
  let healthCache;

  beforeEach(() => {
    healthCache = createExecutorHealthRegionCache();
  });

  it("deduplicates concurrent region refreshes and reuses the cached result", async () => {
    const loader = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return {
        active_region: "us",
        override: null,
        sweden_available: true,
      };
    });

    const [first, second] = await Promise.all([
      healthCache.getCachedStatus({ loader }),
      healthCache.getCachedStatus({ loader }),
    ]);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);

    const cached = await healthCache.getCachedStatus({
      loader: vi.fn(async () => ({
        active_region: "sweden",
        override: "manual",
        sweden_available: true,
      })),
    });

    expect(cached).toEqual(first);
  });
});
