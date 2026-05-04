import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function read(relPath) {
  return readFileSync(resolve(process.cwd(), relPath), "utf8");
}

const sessionListFiles = [
  "ui/components/session-list.js",
  "site/ui/components/session-list.js",
];

const chatFiles = [
  "ui/tabs/chat.js",
  "site/ui/tabs/chat.js",
];

const appFiles = [
  "ui/app.js",
  "site/ui/app.js",
];

for (const relPath of sessionListFiles) {
  describe(`session list runtime/lifecycle labels (${relPath})`, () => {
    const source = read(relPath);

    it("renders explicit lifecycle and runtime labels", () => {
      expect(source).toContain("Lifecycle:");
      expect(source).toContain("Runtime:");
      expect(source).toContain("getSessionLifecycleState");
      expect(source).toContain("getSessionRuntimeState");
      expect(source).toContain("getSessionRecencyTimestamp");
    });

    it("distinguishes in-progress filters from lifecycle/runtime display", () => {
      expect(source).toContain("In Progress (${activeCount})");
      expect(source).toContain("In Progress");
      expect(source).not.toContain("Lifecycle Active");
    });
  });
}

for (const relPath of chatFiles) {
  describe(`chat session header labels (${relPath})`, () => {
    const source = read(relPath);

    it("replaces ambiguous status text with explicit lifecycle/runtime labels", () => {
      expect(source).toContain("Lifecycle:");
      expect(source).toContain("Runtime:");
      expect(source).toContain("getSessionLifecycleState");
      expect(source).toContain("getSessionRuntimeState");
      expect(source).not.toContain("const sessionMeta = [activeSession?.type, activeSession?.status]");
    });
  });
}

for (const relPath of appFiles) {
  describe(`session inspector labels (${relPath})`, () => {
    const source = read(relPath);

    it("shows lifecycle/runtime/freshness separately in the inspector and rail", () => {
      expect(source).toContain("Lifecycle");
      expect(source).toContain("Runtime");
      expect(source).toContain("Freshness");
      expect(source).toContain("live runtime");
      expect(source).toContain("getSessionRuntimeState");
      expect(source).toContain("getSessionLifecycleState");
      expect(source).toContain("getSessionRecencyTimestamp");
    });

    it("scopes rail runtime counts and auto-selection to the current session type", () => {
      expect(source).toContain("function filterSessionsByType");
      expect(source).toContain("const allSessions = sessionsData.value || [];");
      expect(source).toContain("const sessions = filterSessionsByType(allSessions, sessionType);");
      expect(source).toContain("defaultType=${sessionType}");
      expect(source).not.toContain("const sessions = sessionsData.value || [];");
      expect(source).not.toContain("defaultType=\"primary\"");
      expect(source).not.toContain("loadSessions({ type: sessionType })");
      expect(source).not.toContain("selectedSessionId.value = next.id");
    });
  });
}
