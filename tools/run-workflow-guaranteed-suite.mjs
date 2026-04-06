import { findPackageRoot, runVitest } from "./vitest-runner.mjs";

const suitePath = "tests/workflow-guaranteed.test.mjs";

function withTemporaryEnv(envOverrides = {}, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(envOverrides)) {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function resolveShardCount() {
  const explicit = Number.parseInt(String(process.env.BOSUN_WORKFLOW_GUARANTEED_SHARDS || ""), 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return process.platform === "win32" ? 8 : 4;
}

function runShard({ shard, totalShards, startDir }) {
  console.log(`[workflow-guaranteed] shard ${shard}/${totalShards}`);
  return withTemporaryEnv({
    BOSUN_WORKFLOW_GUARANTEED_CHILD: "1",
    BOSUN_VITEST_HEAP_MB: process.env.BOSUN_VITEST_HEAP_MB || (process.platform === "win32" ? "8192" : "4096"),
    VITEST_SHARD: String(shard),
    VITEST_TOTAL_SHARDS: String(totalShards),
  }, () => runVitest([
    "run",
    "--config",
    "vitest.config.mjs",
    "--project",
    "isolated",
    suitePath,
  ], { startDir }));
}

function main() {
  const startDir = findPackageRoot({ startDir: process.cwd() }) || process.cwd();
  const totalShards = resolveShardCount();
  for (let shard = 1; shard <= totalShards; shard += 1) {
    const code = runShard({ shard, totalShards, startDir });
    if (code !== 0) {
      process.exit(code);
    }
  }
}

main();
