import "./warning-filter.mjs";
import { spawnSync } from "node:child_process";
import { _resetSingleton } from "../infra/session-tracker.mjs";
import { ensureTestRuntimeSandbox } from "../infra/test-runtime.mjs";
import { installTestRuntimeGuards } from "../infra/test-runtime-guards.mjs";
import { _resetRuntimeAccumulatorForTests } from "../infra/runtime-accumulator.mjs";
import { installTestLogFilter } from "./test-log-filter.mjs";

function detectChildSpawnBlocked() {
  if (
    process.platform === "win32"
    && /[\\/]\.codex[\\/]\.sandbox[\\/]/i.test(process.cwd())
  ) {
    return true;
  }
  try {
    const result = spawnSync(process.execPath, ["-e", "console.log('spawn-check')"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const errorCode = result?.error?.code;
    return errorCode === "EPERM" || errorCode === "EACCES";
  } catch (error) {
    return error?.code === "EPERM" || error?.code === "EACCES";
  }
}

export function bootstrapTestRuntime() {
  const sandbox = ensureTestRuntimeSandbox({ force: true });
  process.env.BOSUN_TEST_CHILD_SPAWN_BLOCKED = detectChildSpawnBlocked() ? "1" : "0";
  installTestLogFilter();
  installTestRuntimeGuards();
  _resetSingleton({ persistDir: null });
  // Redirect the session accumulator to the test sandbox so tests never
  // write synthetic sessions into the real workspace .cache directory.
  // Store the sandbox cacheDir in an env var so that any bare
  // _resetRuntimeAccumulatorForTests() call (without args) also lands in
  // the sandbox rather than the real .cache folder.
  if (sandbox?.cacheDir) {
    process.env.BOSUN_TEST_CACHE_DIR = sandbox.cacheDir;
    _resetRuntimeAccumulatorForTests({ cacheDir: sandbox.cacheDir });
  }
}

bootstrapTestRuntime();
