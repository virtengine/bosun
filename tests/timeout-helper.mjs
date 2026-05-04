/**
 * Centralized platform-aware timeout helper.
 *
 * Instead of per-file `const TIMEOUT = process.platform === 'win32' ? X : Y`,
 * use:
 *   import { testTimeout, PLATFORM_MULTIPLIER } from "./timeout-helper.mjs";
 *   vi.setConfig({ testTimeout: testTimeout(10_000) });
 *
 * The multiplier accounts for Windows filesystem/process scheduling overhead
 * and can be tuned via BOSUN_TEST_TIMEOUT_MULTIPLIER env var.
 */

const DEFAULT_MULTIPLIER_WIN32 = 5;
const DEFAULT_MULTIPLIER_OTHER = 1;

/**
 * Platform timeout multiplier. On Windows defaults to 5x, elsewhere 1x.
 * Override with BOSUN_TEST_TIMEOUT_MULTIPLIER env var.
 */
export const PLATFORM_MULTIPLIER = (() => {
  const env = Number.parseFloat(process.env.BOSUN_TEST_TIMEOUT_MULTIPLIER);
  if (Number.isFinite(env) && env > 0) return env;
  return process.platform === "win32"
    ? DEFAULT_MULTIPLIER_WIN32
    : DEFAULT_MULTIPLIER_OTHER;
})();

/**
 * Return a platform-adjusted timeout value.
 * @param {number} baseMs - The baseline timeout assuming a fast Linux runner.
 * @returns {number} Adjusted timeout in milliseconds.
 */
export function testTimeout(baseMs) {
  return Math.ceil(baseMs * PLATFORM_MULTIPLIER);
}
