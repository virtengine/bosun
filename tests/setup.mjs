import "./warning-filter.mjs";
import { afterEach } from "vitest";
import { resetStateLedgerCache } from "../lib/state-ledger-sqlite.mjs";
import "./runtime-bootstrap.mjs";
import { installTestLogFilter } from "./test-log-filter.mjs";

installTestLogFilter();

afterEach(() => {
  const debugCleanup = process.env.BOSUN_TEST_HARNESS_DEBUG_CLEANUP === "1";
  const startedAt = debugCleanup ? Date.now() : 0;
  resetStateLedgerCache();
  if (debugCleanup) {
    const memory = typeof process.memoryUsage === "function"
      ? process.memoryUsage()
      : null;
    const activeHandles = typeof process._getActiveHandles === "function"
      ? process._getActiveHandles().map((handle) => handle?.constructor?.name || typeof handle)
      : [];
    const activeRequests = typeof process._getActiveRequests === "function"
      ? process._getActiveRequests().map((request) => request?.constructor?.name || typeof request)
      : [];
    const activeResources = typeof process.getActiveResourcesInfo === "function"
      ? process.getActiveResourcesInfo()
      : [];
    console.error(`[tests/setup] resetStateLedgerCache +${Date.now() - startedAt}ms`);
    if (memory) {
      const heapUsedMb = Math.round((memory.heapUsed / (1024 * 1024)) * 10) / 10;
      const heapTotalMb = Math.round((memory.heapTotal / (1024 * 1024)) * 10) / 10;
      const rssMb = Math.round((memory.rss / (1024 * 1024)) * 10) / 10;
      console.error(`[tests/setup] memory rss=${rssMb}MB heapUsed=${heapUsedMb}MB heapTotal=${heapTotalMb}MB`);
    }
    console.error(`[tests/setup] activeHandles=${activeHandles.join(",")}`);
    console.error(`[tests/setup] activeRequests=${activeRequests.join(",")}`);
    console.error(`[tests/setup] activeResources=${activeResources.join(",")}`);
  }
});
