import {
  buildHarnessProviderSdkPath,
  buildHarnessThreadPath,
} from "../ui/modules/harness-client.js";
import { requestJsonApi } from "../lib/request-json-api.mjs";

function appendWorkspace(path, workspace = "all") {
  if (!workspace) return path;
  return `${path}${path.includes("?") ? "&" : "?"}workspace=${encodeURIComponent(workspace)}`;
}

export async function requestTelegramJsonApi(base, path, options = {}) {
  return requestJsonApi(base, path, options);
}

export function createTelegramHarnessApiClient(request) {
  if (typeof request !== "function") {
    throw new Error("createTelegramHarnessApiClient requires a request function");
  }

  return {
    async createSession(body = {}) {
      return request("/api/sessions/create", {
        method: "POST",
        body,
      });
    },
    async getSession(sessionId, options = {}) {
      const query = new URLSearchParams();
      query.set("workspace", String(options.workspace || "all"));
      if (options.full !== false) query.set("full", "1");
      if (options.limit != null) query.set("limit", String(options.limit));
      if (options.offset != null) query.set("offset", String(options.offset));
      return request(`/api/sessions/${encodeURIComponent(sessionId)}?${query.toString()}`);
    },
    async sendSessionMessage(sessionId, body = {}, workspace = "all") {
      return request(appendWorkspace(`/api/sessions/${encodeURIComponent(sessionId)}/message`, workspace), {
        method: "POST",
        body,
      });
    },
    async stopSession(sessionId, workspace = "all") {
      return request(appendWorkspace(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, workspace), {
        method: "POST",
      });
    },
    async deleteSession(sessionId, workspace = "all") {
      return request(appendWorkspace(`/api/sessions/${encodeURIComponent(sessionId)}/delete`, workspace), {
        method: "POST",
      });
    },
    async getProviderSelection() {
      return request(buildHarnessProviderSdkPath());
    },
    async setProviderSelection(sdk) {
      return request(buildHarnessProviderSdkPath(), {
        method: "POST",
        body: { sdk },
      });
    },
    async listThreads() {
      return request(buildHarnessThreadPath());
    },
    async clearThreads() {
      return request(buildHarnessThreadPath("", "reset"), {
        method: "POST",
      });
    },
    async invalidateThread(taskKey) {
      return request(buildHarnessThreadPath(taskKey, "invalidate"), {
        method: "POST",
      });
    },
    async getSurface(view = "all", limit = 25) {
      const query = new URLSearchParams();
      query.set("view", String(view || "all"));
      query.set("limit", String(limit));
      return request(`/api/harness/surface?${query.toString()}`);
    },
    async getLogs(lines = 30) {
      const count = Math.max(10, Math.min(Number(lines) || 30, 100));
      return request(`/api/logs?lines=${count}`);
    },
  };
}

export function createTelegramWorkspaceApiClient(request) {
  if (typeof request !== "function") {
    throw new Error("createTelegramWorkspaceApiClient requires a request function");
  }

  return {
    async listTaskAttemptSummaries(host, options = {}) {
      return request(host, "/api/task-attempts/summary", {
        method: "POST",
        body: { archived: options.archived === true },
      });
    },
    async listSessions(host, workspaceId) {
      return request(
        host,
        `/api/sessions?workspace_id=${encodeURIComponent(String(workspaceId || ""))}`,
      );
    },
    async createSession(host, workspaceId) {
      return request(host, "/api/sessions", {
        method: "POST",
        body: { workspace_id: workspaceId },
      });
    },
    async queueSessionMessage(host, sessionId, body = {}) {
      return request(host, `/api/sessions/${encodeURIComponent(String(sessionId || ""))}/queue`, {
        method: "POST",
        body,
      });
    },
    async sendFollowUp(host, sessionId, body = {}) {
      return request(host, `/api/sessions/${encodeURIComponent(String(sessionId || ""))}/follow-up`, {
        method: "POST",
        body,
      });
    },
  };
}
