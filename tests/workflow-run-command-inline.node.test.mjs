import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createRequire } from "node:module";
import { Console as NodeConsole } from "node:console";
import { EventEmitter } from "node:events";
import { format as formatConsoleArgs } from "node:util";

const sourcePath = resolve(process.cwd(), "workflow", "workflow-nodes", "actions.mjs");
const actionsSource = readFileSync(sourcePath, "utf8");

function extractFunction(functionName) {
  const asyncSignature = `async function ${functionName}(`;
  const syncSignature = `function ${functionName}(`;
  const startIndex = actionsSource.indexOf(asyncSignature) >= 0
    ? actionsSource.indexOf(asyncSignature)
    : actionsSource.indexOf(syncSignature);
  assert.notEqual(startIndex, -1, `missing function: ${functionName}`);

  let parenDepth = 0;
  let openBraceIndex = -1;
  for (let i = startIndex; i < actionsSource.length; i += 1) {
    const ch = actionsSource[i];
    if (ch === "(") {
      parenDepth += 1;
      continue;
    }
    if (ch === ")") {
      parenDepth -= 1;
      continue;
    }
    if (ch === "{" && parenDepth === 0) {
      openBraceIndex = i;
      break;
    }
  }
  assert.notEqual(openBraceIndex, -1, `missing opening brace: ${functionName}`);

  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplate = false;
  let escaped = false;

  for (let i = openBraceIndex; i < actionsSource.length; i += 1) {
    const ch = actionsSource[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (inSingleQuote) {
      if (ch === "'") inSingleQuote = false;
      continue;
    }
    if (inDoubleQuote) {
      if (ch === "\"") inDoubleQuote = false;
      continue;
    }
    if (inTemplate) {
      if (ch === "`") inTemplate = false;
      continue;
    }
    if (ch === "'") {
      inSingleQuote = true;
      continue;
    }
    if (ch === "\"") {
      inDoubleQuote = true;
      continue;
    }
    if (ch === "`") {
      inTemplate = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return actionsSource.slice(startIndex, i + 1);
      }
    }
  }

  throw new Error(`unable to extract function: ${functionName}`);
}

function loadInlineHelpers() {
  const scriptSource = [
    "const process = globalThis.__testProcess;",
    "const setTimeout = globalThis.__testSetTimeout;",
    "const clearTimeout = globalThis.__testClearTimeout;",
    "const setInterval = globalThis.__testSetInterval;",
    "const clearInterval = globalThis.__testClearInterval;",
    "const Buffer = globalThis.__testBuffer;",
    "const console = globalThis.__testConsole;",
    "const NodeConsole = globalThis.__testNodeConsole;",
    "const EventEmitter = globalThis.__testEventEmitter;",
    "const formatConsoleArgs = globalThis.__testFormatConsoleArgs;",
    "const isUnresolvedTemplateToken = globalThis.__testIsUnresolvedTemplateToken;",
    extractFunction("resolveWorkflowCwdValue"),
    extractFunction("detectInlineNodeExecutionSpec"),
    extractFunction("runInlineNodeExecution"),
    "result = { detectInlineNodeExecutionSpec, runInlineNodeExecution };",
  ].join("\n\n");

  const processStub = {
    argv: [process.execPath],
    env: { ...process.env },
    execPath: process.execPath,
    cwd: () => process.cwd(),
    chdir: (nextCwd) => process.chdir(nextCwd),
    stdout: Object.assign(new EventEmitter(), {
      write(chunk) {
        void chunk;
        return true;
      },
    }),
    stderr: Object.assign(new EventEmitter(), {
      write(chunk) {
        void chunk;
        return true;
      },
    }),
    exit(code = 0) {
      const error = new Error(`process.exit(${code})`);
      error.code = code;
      throw error;
    },
  };

  const context = {
    createRequire,
    resolve,
    dirname,
    globalThis: {
      __testProcess: processStub,
      __testSetTimeout: setTimeout,
      __testClearTimeout: clearTimeout,
      __testSetInterval: setInterval,
      __testClearInterval: clearInterval,
      __testBuffer: Buffer,
      __testConsole: console,
      __testNodeConsole: NodeConsole,
      __testEventEmitter: EventEmitter,
      __testFormatConsoleArgs: formatConsoleArgs,
      __testIsUnresolvedTemplateToken: (value) =>
        typeof value === "string" && /\{\{.*\}\}/.test(value),
      console,
    },
    result: null,
  };

  vm.createContext(context);
  new vm.Script(scriptSource).runInContext(context);
  return context.result;
}

test("action.run_command includes Windows EPERM inline node fallback", () => {
  assert.match(actionsSource, /Command spawn hit EPERM; retrying inline Node execution/);
  assert.match(actionsSource, /const inlineSpec = detectInlineNodeExecutionSpec\(spawnCommand, spawnArgs, spawnInput\);/);
  assert.match(actionsSource, /stdout = await runInlineNodeExecution\(spawnCommand, spawnArgs,/);
});

test("detectInlineNodeExecutionSpec recognizes node -e and stdin transports", () => {
  const { detectInlineNodeExecutionSpec } = loadInlineHelpers();

  assert.equal(
    JSON.stringify(
      detectInlineNodeExecutionSpec(process.execPath, ["-e", "console.log('ok')", "task-1"], null),
    ),
    JSON.stringify({ mode: "eval", script: "console.log('ok')", argv: ["task-1"] }),
  );

  assert.equal(
    JSON.stringify(
      detectInlineNodeExecutionSpec(process.execPath, ["-", "task-2"], "console.log('stdin')"),
    ),
    JSON.stringify({ mode: "stdin", script: "console.log('stdin')", argv: ["task-2"] }),
  );
});

test("runInlineNodeExecution executes inline node scripts without spawning child processes", async () => {
  const { runInlineNodeExecution } = loadInlineHelpers();
  const cwd = mkdtempSync(join(tmpdir(), "wf-inline-node-"));
  try {
    const stdout = await runInlineNodeExecution(process.execPath, ["-e", [
      "process.stdout.write(JSON.stringify({",
      "  cwd: process.cwd(),",
      "  env: process.env.BOSUN_INLINE_FLAG,",
      "  argv: process.argv.slice(1)",
      "}));",
    ].join("\n")], {
      cwd,
      env: { BOSUN_INLINE_FLAG: "present" },
      stdio: "pipe",
      timeout: 5000,
    });

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.cwd, cwd);
    assert.equal(parsed.env, "present");
    assert.deepEqual(parsed.argv, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runInlineNodeExecution temporarily routes globalThis.console through the inline proxy", async () => {
  const { runInlineNodeExecution } = loadInlineHelpers();
  const cwd = mkdtempSync(join(tmpdir(), "wf-inline-node-global-console-"));
  const originalGlobalConsole = globalThis.console;
  try {
    globalThis.console = {
      error() {
        throw new Error("host global console should be replaced during inline execution");
      },
    };

    const stdout = await runInlineNodeExecution(process.execPath, ["-e", [
      "globalThis.console.error('inline stderr still works');",
      "process.stdout.write(JSON.stringify({ ok: true }));",
    ].join("\n")], {
      cwd,
      stdio: "pipe",
      timeout: 5000,
    });

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
  } finally {
    globalThis.console = originalGlobalConsole;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runInlineNodeExecution isolates inline scripts from a broken host Console stream contract", async () => {
  const { runInlineNodeExecution } = loadInlineHelpers();
  const cwd = mkdtempSync(join(tmpdir(), "wf-inline-node-broken-console-"));
  const originalGlobalConsole = globalThis.console;
  try {
    const badStdout = { write() { return true; } };
    const badStderr = { write() { return true; } };
    globalThis.console = new NodeConsole({
      stdout: badStdout,
      stderr: badStderr,
      colorMode: false,
    });

    assert.throws(
      () => globalThis.console.error("host console should still be broken outside inline execution"),
      /removeListener is not a function/,
    );

    const stdout = await runInlineNodeExecution(process.execPath, ["-e", [
      "console.error('inline console should not inherit broken host streams');",
      "process.stdout.write(JSON.stringify({ ok: true }));",
    ].join("\n")], {
      cwd,
      stdio: "pipe",
      timeout: 5000,
    });

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
  } finally {
    globalThis.console = originalGlobalConsole;
    rmSync(cwd, { recursive: true, force: true });
  }
});
