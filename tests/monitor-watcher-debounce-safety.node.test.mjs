import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const src = readFileSync(resolve(process.cwd(), "infra/monitor.mjs"), "utf8");

test("watcher debounce timers use safeSetTimeout wrappers", () => {
  assert.match(src, /watcherDebounce = safeSetTimeout\("watcher-file-change-debounce"/);
  assert.match(src, /envWatcherDebounce = safeSetTimeout\("env-reload-debounce"/);
  assert.match(src, /ENV_RELOAD_DELAY_MS/);
  assert.match(src, /Number\(process\.env\.ENV_RELOAD_DELAY_MS \|\| "5000"\)/);
  assert.doesNotMatch(src, /watcherDebounce = setTimeout\(/);
  assert.doesNotMatch(src, /envWatcherDebounce = setTimeout\(/);
});

test("self restart quiet period defaults to 180 seconds and preserves a 90-second floor", () => {
  assert.match(
    src,
    /const SELF_RESTART_QUIET_MS = Math\.max\(\s*90_000,\s*Number\(process\.env\.SELF_RESTART_QUIET_MS \|\| "180000"\),/s,
  );
});
