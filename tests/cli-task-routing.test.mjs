import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("cli task routing", () => {
  const cliSource = readFileSync(resolve(process.cwd(), "cli.mjs"), "utf8");

  it("applies --config-dir env overrides before task routing", () => {
    const envSetupIndex = cliSource.indexOf(
      "const earlyConfigDirArg = getArgValue(\"--config-dir\")",
    );
    const taskRoutingIndex = cliSource.indexOf("const taskFlagIndex = args.indexOf(\"--task\")");

    expect(envSetupIndex).toBeGreaterThan(-1);
    expect(taskRoutingIndex).toBeGreaterThan(-1);
    expect(envSetupIndex).toBeLessThan(taskRoutingIndex);
    expect(cliSource).toContain("const resolvedConfigDirArg = resolve(earlyConfigDirArg)");
    expect(cliSource).toContain("process.env.BOSUN_DIR = resolvedConfigDirArg");
    expect(cliSource).toContain("process.env.BOSUN_HOME = resolvedConfigDirArg");
  });

  it("supports task subcommand routing when global flags precede task", () => {
    expect(cliSource).toContain("args[0]?.startsWith(\"--\")");
    expect(cliSource).toContain("args.indexOf(\"task\")");
    expect(cliSource).toContain("const commandStartIndex = taskCommandIndex >= 0 ? taskCommandIndex : taskFlagIndex");
    expect(cliSource).toContain("const taskArgs = args.slice(commandStartIndex + 1)");
  });

  it("routes audit subcommands before global help handling", () => {
    const auditRoutingIndex = cliSource.indexOf("const auditFlagIndex = args.indexOf(\"--audit\")");
    const helpRoutingIndex = cliSource.indexOf("// Handle --help");

    expect(auditRoutingIndex).toBeGreaterThan(-1);
    expect(helpRoutingIndex).toBeGreaterThan(-1);
    expect(auditRoutingIndex).toBeLessThan(helpRoutingIndex);
    expect(cliSource).toContain("args.indexOf(\"audit\")");
    expect(cliSource).toContain("const auditArgs = args.slice(commandStartIndex + 1)");
    expect(cliSource).toContain("const { runAuditCli } = await import(\"./lib/codebase-audit.mjs\")");
    expect(cliSource).toContain("const { exitCode } = await runAuditCli(auditArgs)");
    expect(cliSource).toContain("process.exit(exitCode)");
  });
});
