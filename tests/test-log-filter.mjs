const ORIGINAL_CONSOLE = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

const SUPPRESSED_PREFIXES = [
  /^╔/u,
  /^║/u,
  /^╚/u,
  /^\[archiver\]/i,
  /^\[agent-prompts\]/i,
  /^\[config\]/i,
  /^\[kanban\]/i,
  /^\[monitor(?:[^\]]*)?\]/i,
  /^\[session-tracker\]/i,
  /^\[sharedstatemanager\]/i,
  /^\[task-store\]/i,
  /^\[telegram-bot\]/i,
  /^\[telegram-ui\]/i,
  /^\[ui\]/i,
  /^\[workspace-manager\]/i,
  /^\[workflow-engine\]/i,
  /^\[workflow-nodes\]/i,
  /^\[workflows\]/i,
];

function shouldVerboseTestLogs() {
  const value = String(process.env.BOSUN_TEST_VERBOSE_LOGS || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

function shouldSuppress(args) {
  if (shouldVerboseTestLogs()) return false;
  if (!args || args.length === 0) return false;
  const message = args.map((arg) => String(arg)).join(" ");
  return SUPPRESSED_PREFIXES.some((pattern) => pattern.test(message));
}

export function installTestLogFilter() {
  if (globalThis.__bosunTestLogFilterInstalled) return;
  globalThis.__bosunTestLogFilterInstalled = true;

  console.log = (...args) => {
    if (shouldSuppress(args)) return;
    ORIGINAL_CONSOLE.log(...args);
  };

  console.warn = (...args) => {
    if (shouldSuppress(args)) return;
    ORIGINAL_CONSOLE.warn(...args);
  };

  console.error = (...args) => {
    if (shouldSuppress(args)) return;
    ORIGINAL_CONSOLE.error(...args);
  };
}
