import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { TuiWsBridge, buildTuiHttpUrl, resolveWebSocketProtocol } from "../tui/lib/ws-bridge.mjs";

describe("tui websocket bridge", () => {
  let tempDir = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    delete process.env.BOSUN_TUI_INSECURE_TLS;
  });

  it("disables tls verification for private wss endpoints", () => {
    tempDir = mkdtempSync(join(tmpdir(), "bosun-ws-bridge-"));
    const calls = [];

    class FakeWebSocket {
      static OPEN = 1;

      constructor(url, options) {
        calls.push({ url, options });
        this.readyState = 0;
      }

      close() {}
      send() {}
    }

    const bridge = new TuiWsBridge({
      host: "192.168.0.183",
      port: 4400,
      configDir: tempDir,
      protocol: "wss",
      apiKey: "remote-secret",
      WebSocketImpl: FakeWebSocket,
    });

    bridge.connect();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("wss://192.168.0.183:4400/ws");
    expect(calls[0].options.headers["x-api-key"]).toBe("remote-secret");
    expect(calls[0].options.rejectUnauthorized).toBe(false);
  });

  it("keeps tls verification enabled for public wss endpoints", () => {
    tempDir = mkdtempSync(join(tmpdir(), "bosun-ws-bridge-"));
    const calls = [];

    class FakeWebSocket {
      static OPEN = 1;

      constructor(url, options) {
        calls.push({ url, options });
        this.readyState = 0;
      }

      close() {}
      send() {}
    }

    const bridge = new TuiWsBridge({
      host: "example.com",
      port: 443,
      configDir: tempDir,
      protocol: "wss",
      apiKey: "remote-secret",
      WebSocketImpl: FakeWebSocket,
    });

    bridge.connect();

    expect(calls).toHaveLength(1);
    expect(calls[0].options.rejectUnauthorized).toBe(true);
  });

  it("normalizes sessions:update snapshots to arrays", () => {
    const bridge = new TuiWsBridge({ host: "127.0.0.1", port: 3080 });
    const listener = vi.fn();

    bridge.on("sessions:update", listener);
    bridge._handleMessage({
      type: "sessions:update",
      payload: [{ id: "session-1", status: "active" }],
    });

    bridge._handleMessage({
      type: "sessions:update",
      payload: {
        sessions: [{ id: "session-2", status: "completed" }],
      },
    });

    expect(listener).toHaveBeenNthCalledWith(1, [{ id: "session-1", status: "active" }]);
    expect(listener).toHaveBeenNthCalledWith(2, [{ id: "session-2", status: "completed" }]);
  });

  it("infers wss from the persisted UI instance lock", () => {
    const configDir = mkdtempSync(join(tmpdir(), "bosun-tui-lock-"));
    try {
      const cacheDir = join(configDir, ".cache");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, "ui-server.instance.lock.json"), JSON.stringify({ protocol: "https" }), "utf8");

      expect(resolveWebSocketProtocol({ configDir })).toBe("wss");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("builds HTTP URLs that match the websocket host and protocol", () => {
    expect(buildTuiHttpUrl({ host: "127.0.0.1", port: 3080, path: "/api/tasks/create" })).toBe(
      "http://127.0.0.1:3080/api/tasks/create",
    );
    expect(buildTuiHttpUrl({ host: "example.com", port: 443, path: "api/tasks/create", protocol: "wss" })).toBe(
      "https://example.com/api/tasks/create",
    );
  });

  it("posts task creation requests with the shared bearer token", async () => {
    const requests = [];
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push({
          url: req.url,
          method: req.method,
          headers: req.headers,
          body,
        });
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, data: { id: "task-1", title: "Demo" } }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const bridge = new TuiWsBridge({ host: "127.0.0.1", port, configDir: "C:/tmp/missing" });
    const originalEnv = process.env.BOSUN_UI_TOKEN;
    process.env.BOSUN_UI_TOKEN = "1234567890123456789012345678901234567890123456789012345678901234";

    try {
      const created = await bridge.createTask({ title: "Demo", priority: "high" });
      expect(created).toEqual({ id: "task-1", title: "Demo" });
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe("/api/tasks/create");
      expect(requests[0].method).toBe("POST");
      expect(requests[0].headers.authorization).toBe(
        "Bearer 1234567890123456789012345678901234567890123456789012345678901234",
      );
      expect(requests[0].body).toBe(JSON.stringify({ title: "Demo", priority: "high" }));
    } finally {
      if (originalEnv === undefined) {
        delete process.env.BOSUN_UI_TOKEN;
      } else {
        process.env.BOSUN_UI_TOKEN = originalEnv;
      }
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
