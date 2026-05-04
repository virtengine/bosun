import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright";

const repoRoot = process.cwd();
const serverEntry = resolve(repoRoot, "server", "playwright-ui-server.mjs");
const routerSource = readFileSync(resolve(repoRoot, "ui", "modules", "router.js"), "utf8");
const requestedEnvPort = process.env.PLAYWRIGHT_UI_PORT ? Number(process.env.PLAYWRIGHT_UI_PORT) : undefined;
const externalBlockPattern = /(telegram\.org|umami\.is|cloud\.umami|fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|unpkg\.com)/;
const ROUTE_NAVIGATION_TIMEOUT_MS = 8000;
const UI_SETTLE_TIMEOUT_MS = 1000;
const ROUTE_SETTLE_EXTRA_MS = 150;
const ROUTE_ASSERT_TIMEOUT_MS = 12000;
const UI_QUERY_TIMEOUT_MS = 250;
const REPRESENTATIVE_SMOKE_PATHS = [
  "/tasks",
  "/workflows",
  "/settings",
];

function debugLog(message) {
  process.stderr.write(`[portal-smoke] ${message}\n`);
}

function extractTabRoutes(source) {
  const block = source.match(/export const TAB_CONFIG = \[([\s\S]*?)\n\];/);
  if (!block) {
    throw new Error("Could not locate TAB_CONFIG in ui/modules/router.js");
  }

  const ids = [...block[1].matchAll(/\bid:\s*"([^"]+)"/g)].map((match) => match[1]);
  const routes = ids.map((id) => ({
    path: id === "dashboard" ? "/" : `/${id}`,
    label: id === "dashboard" ? "Dashboard" : id,
  }));

  if (ids.includes("dashboard")) {
    routes.unshift({ path: "/dashboard", label: "Dashboard alias" });
  }

  return routes;
}

function extractParameterizedRoutes(source) {
  const routes = [];

  if (/if \(tab === "tasks"\)/.test(source)) {
    routes.push({ path: "/tasks/task-test-001", label: "Task detail" });
  }
  if (/if \(tab === "chat"\)/.test(source)) {
    routes.push({ path: "/chat/session-test-001", label: "Chat session" });
  }
  if (/if \(tab === "workflows"\)/.test(source)) {
    routes.push(
      { path: "/workflows/wf-test-001", label: "Workflow detail" },
      { path: "/workflows/runs", label: "Workflow runs" },
      { path: "/workflows/runs/run-001", label: "Workflow run detail" },
    );
  }

  return routes;
}

const discoveredRoutes = [...new Map(
  [...extractTabRoutes(routerSource), ...extractParameterizedRoutes(routerSource)]
    .map((route) => [route.path, route]),
).values()];

function selectRepresentativeRoutes(routes) {
  const byPath = new Map((Array.isArray(routes) ? routes : []).map((route) => [route.path, route]));
  const missing = REPRESENTATIVE_SMOKE_PATHS.filter((path) => !byPath.has(path));
  if (missing.length > 0) {
    throw new Error(`Representative smoke routes missing from router extraction: ${missing.join(", ")}`);
  }
  return REPRESENTATIVE_SMOKE_PATHS.map((path) => byPath.get(path));
}

const routesUnderTest = selectRepresentativeRoutes(discoveredRoutes);

function createErrorCollectors(page) {
  const state = {
    runtimeErrors: [],
    consoleErrors: [],
    assetFailures: [],
    loadedAssets: new Set(),
  };
  const criticalConsolePattern = /syntaxerror|referenceerror|typeerror|failed to load app modules|native import failed|primary cdn failed|\[taberrorboundary\]/i;

  page.on("pageerror", (error) => {
    state.runtimeErrors.push(error?.stack || error?.message || String(error));
  });

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (criticalConsolePattern.test(text)) {
      state.consoleErrors.push(text);
    }
  });

  page.on("requestfailed", (request) => {
    const url = request.url();
    if (!url.startsWith(page.__smokeBaseUrl)) return;
    if (!/\.(?:js|mjs|css|png|svg|ico|woff2?|ttf)(?:$|\?)/i.test(url)) return;
    state.assetFailures.push(`${request.method()} ${url} :: ${request.failure()?.errorText || "request failed"}`);
  });

  page.on("response", (response) => {
    const url = response.url();
    if (!url.startsWith(page.__smokeBaseUrl)) return;
    if (!/\.(?:js|mjs|css|png|svg|ico|woff2?|ttf)(?:$|\?)/i.test(url)) return;
    if (response.status() >= 400) {
      state.assetFailures.push(`${response.status()} ${url}`);
      return;
    }
    state.loadedAssets.add(new URL(url).pathname);
  });

  return state;
}

async function blockExternals(page) {
  await page.route(externalBlockPattern, (route) => route.abort());
}

async function resolveSmokePort() {
  if (Number.isInteger(requestedEnvPort) && requestedEnvPort > 0) {
    return requestedEnvPort;
  }

  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to determine free smoke test port.")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

async function readBootResult(page) {
  const bootText = await page.locator("#boot-loader").textContent({ timeout: UI_QUERY_TIMEOUT_MS }).catch(() => "");
  const text = String(bootText || "");
  return {
    bootText: text,
    bootFailed: /failed to load app modules|authentication expired/i.test(text),
  };
}

async function readTabErrorText(page) {
  const text = await page.locator(".tab-error-boundary").first().textContent({ timeout: UI_QUERY_TIMEOUT_MS }).catch(() => "");
  return String(text || "").trim();
}

async function waitForUiSettled(page, extraMs = ROUTE_SETTLE_EXTRA_MS) {
  await page.waitForLoadState("networkidle", { timeout: UI_SETTLE_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(extraMs);
}

async function withTimeout(label, timeoutMs, work) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} exceeded ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function assertTasksDagViewActivated(page) {
  await page.getByRole("button", { name: /DAG/i }).click();
  await page.waitForTimeout(1000);

  const bodyText = await page.locator("body").textContent().catch(() => "");
  const text = String(bodyText || "");
  const hasDagMarker = text.includes("DAG VIEW")
    || text.includes("Planning controls")
    || text.includes("No DAG nodes available for this view yet.")
    || text.includes("No DAG data was returned from DAG endpoints.");

  assert.equal(
    hasDagMarker,
    true,
    `Expected Tasks DAG view to activate, but the page did not show a DAG-only marker.\n${text}`,
  );
}

async function verifyRouteLoads(browser, route, baseUrl) {
  debugLog(`route:start ${route.path}`);
  const context = await browser.newContext();
  const page = await context.newPage();
  page.__smokeBaseUrl = baseUrl;
  const errors = createErrorCollectors(page);
  try {
    await withTimeout(`route ${route.path}`, ROUTE_ASSERT_TIMEOUT_MS, async () => {
      await blockExternals(page);
      await page.goto(`${baseUrl}${route.path}`, {
        waitUntil: "domcontentloaded",
        timeout: ROUTE_NAVIGATION_TIMEOUT_MS,
      });
      await waitForUiSettled(page);

      const boot = await readBootResult(page);
      const tabErrorText = await readTabErrorText(page);

      assert.equal(boot.bootFailed, false, `Boot loader surfaced an error on ${route.path}:\n${boot.bootText}`);
      assert.equal(errors.loadedAssets.has("/app.js"), true, `Expected /app.js to load for ${route.path}`);
      assert.equal(tabErrorText, "", `Render error boundary appeared on ${route.path}:\n${tabErrorText}`);
      assert.deepEqual(errors.runtimeErrors, [], `Runtime JS errors on ${route.path}:\n${errors.runtimeErrors.join("\n")}`);
      assert.deepEqual(errors.consoleErrors, [], `Console errors on ${route.path}:\n${errors.consoleErrors.join("\n")}`);
      assert.deepEqual(errors.assetFailures, [], `Critical local asset failures on ${route.path}:\n${errors.assetFailures.join("\n")}`);
    });
    debugLog(`route:ok ${route.path}`);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function waitForHttpReady(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function waitForChildExit(child, timeoutMs = 10000) {
  if (child?.exitCode !== null || child?.killed) return;
  const exitPromise = once(child, "exit").catch(() => {});
  const timeoutPromise = new Promise((resolve) => setTimeout(resolve, timeoutMs));
  await Promise.race([exitPromise, timeoutPromise]);
}

async function forceTerminateChild(child) {
  if (child?.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], () => resolve());
    });
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* best-effort */
  }
}

async function startPortalServer() {
  const port = await resolveSmokePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  debugLog(`server:start ${baseUrl}`);
  const serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PLAYWRIGHT_UI_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  serverProcess.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  if (serverProcess.stdout) {
    // Drain stdout to avoid filling the pipe buffer and hanging the test.
    serverProcess.stdout.resume();
  }

  try {
    await waitForHttpReady(baseUrl);
  } catch (error) {
    serverProcess.kill();
    await waitForChildExit(serverProcess, 3000);
    await forceTerminateChild(serverProcess);
    await waitForChildExit(serverProcess, 3000);
    throw new Error(`Failed to start portal test server: ${error.message}\n${stderr}`);
  }
  debugLog(`server:ready ${baseUrl}`);
  return { serverProcess, baseUrl };
}

async function stopPortalServer(serverProcess) {
  if (!serverProcess) return;
  debugLog("server:stop");
  serverProcess.kill();
  await waitForChildExit(serverProcess, 3000);
  await forceTerminateChild(serverProcess);
  await waitForChildExit(serverProcess, 3000);
}

async function withPortalServer(run) {
  const { serverProcess, baseUrl } = await startPortalServer();
  try {
    return await run({ baseUrl });
  } finally {
    await stopPortalServer(serverProcess);
  }
}

test("boots a bounded representative portal route set without JS load failures", { timeout: 120000 }, async () => {
  await withPortalServer(async ({ baseUrl }) => {
    debugLog("test:boot-routes:start");
    const browser = await chromium.launch({ headless: true });
    try {
      for (const route of routesUnderTest) {
        await verifyRouteLoads(browser, route, baseUrl);
      }
    } finally {
      await browser.close();
      debugLog("test:boot-routes:done");
    }
  });
});

test("catches Tasks DAG subview failures after the route boots", { timeout: 60000 }, async () => {
  await withPortalServer(async ({ baseUrl }) => {
    debugLog("test:dag:start");
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.__smokeBaseUrl = baseUrl;
    const errors = createErrorCollectors(page);
    try {
      await blockExternals(page);
      await page.goto(`${baseUrl}/tasks`, {
        waitUntil: "domcontentloaded",
        timeout: ROUTE_NAVIGATION_TIMEOUT_MS,
      });
      debugLog("test:dag:tasks-loaded");
      await waitForUiSettled(page);

      const boot = await readBootResult(page);
      assert.equal(boot.bootFailed, false, `Boot loader surfaced an error on /tasks:\n${boot.bootText}`);
      assert.equal(errors.loadedAssets.has("/app.js"), true, "Expected /app.js to load for /tasks");

      await assertTasksDagViewActivated(page);
      debugLog("test:dag:activated");

      const tabErrorText = await readTabErrorText(page);
      assert.equal(tabErrorText, "", `Render error boundary appeared on Tasks DAG view:\n${tabErrorText}`);
      assert.deepEqual(errors.runtimeErrors, [], `Runtime JS errors on Tasks DAG view:\n${errors.runtimeErrors.join("\n")}`);
      assert.deepEqual(errors.consoleErrors, [], `Console errors on Tasks DAG view:\n${errors.consoleErrors.join("\n")}`);
      assert.deepEqual(errors.assetFailures, [], `Critical local asset failures on Tasks DAG view:\n${errors.assetFailures.join("\n")}`);
    } finally {
      await page.close().catch(() => {});
      await browser.close().catch(() => {});
      debugLog("test:dag:done");
    }
  });
});

test("exposes isolated browser-worker and multimodal fallback APIs for Playwright validation", { timeout: 30000 }, async () => {
  await withPortalServer(async ({ baseUrl }) => {
    const createResponse = await fetch(`${baseUrl}/api/playwright/browser-workers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "playwright-browser-session",
        parentSessionId: "playwright-parent-session",
        rootSessionId: "playwright-root-session",
        requestedCapabilities: ["playwright.navigate", "playwright.screenshot"],
        fallback: {
          summary: "Settings page shows an integrations panel with a missing icon.",
          source: "playwright-ui",
          width: 1280,
          height: 720,
        },
      }),
    });
    assert.equal(createResponse.ok, true);
    const created = await createResponse.json();
    assert.equal(created.ok, true);
    assert.equal(created.worker.sessionId, "playwright-browser-session");
    assert.equal(created.worker.parentSessionId, "playwright-parent-session");
    assert.match(created.worker.profileDir, /\.bosun[\\/]\.cache[\\/]browser-workers[\\/]/);
    assert.match(created.fallback.summary, /missing icon/i);

    const listResponse = await fetch(`${baseUrl}/api/playwright/browser-workers?sessionId=playwright-browser-session`);
    assert.equal(listResponse.ok, true);
    const listed = await listResponse.json();
    assert.equal(listed.total, 1);
    assert.equal(listed.workers[0].workerId, created.worker.workerId);

    const releaseResponse = await fetch(`${baseUrl}/api/playwright/browser-workers/playwright-browser-session`, {
      method: "DELETE",
    });
    assert.equal(releaseResponse.ok, true);
    const released = await releaseResponse.json();
    assert.equal(released.ok, true);
    assert.equal(released.released, true);
    assert.equal(released.worker.status, "released");
  });
});
