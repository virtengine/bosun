import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { followTextFile } from "../lib/log-tail.mjs";

describe("followTextFile", () => {
  const tempDirs = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it("prints the latest lines and follows appended log output", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bosun-log-tail-"));
    tempDirs.push(tempDir);
    const logPath = join(tempDir, "monitor.log");
    writeFileSync(logPath, ["old-1", "old-2", "old-3"].join("\n") + "\n", "utf8");

    const output = new PassThrough();
    const errorStream = new PassThrough();
    let captured = "";
    output.on("data", (chunk) => {
      captured += chunk.toString("utf8");
    });
    errorStream.on("data", (chunk) => {
      captured += chunk.toString("utf8");
    });

    const controller = new AbortController();
    const followPromise = followTextFile(logPath, {
      initialLines: 2,
      pollMs: 25,
      outputStream: output,
      errorStream,
      signal: controller.signal,
    });

    await vi.waitFor(() => {
      expect(captured).toContain("old-2");
      expect(captured).toContain("old-3");
    });
    expect(captured).not.toContain("old-1");

    appendFileSync(logPath, "new-4\nnew-5\n", "utf8");
    await vi.waitFor(() => {
      expect(captured).toContain("new-4");
      expect(captured).toContain("new-5");
    });

    controller.abort();
    await followPromise;
  });
});