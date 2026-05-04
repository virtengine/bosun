import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "server",
  // Match only the e2e/smoke/inspect spec files. Excluding the
  // `playwright-ui-server.mjs` web server file is required — otherwise
  // Playwright's loader imports it as a test, which executes its top-level
  // `app.listen(4444)` and collides with the webServer started below
  // (EADDRINUSE :::4444). See _docs/INTERNAL_HARNESS_RELEASE_SIGNOFF.md.
  testMatch: /playwright-ui-(e2e|smoke|inspect)\.mjs$/,
  timeout: 30000,
  webServer: {
    command: "node server/playwright-ui-server.mjs",
    url: "http://localhost:4444",
    reuseExistingServer: true,
    timeout: 30000,
  },
  use: {
    baseURL: "http://localhost:4444",
    headless: true,
    ignoreHTTPSErrors: true,
  },
  reporter: "list",
});
