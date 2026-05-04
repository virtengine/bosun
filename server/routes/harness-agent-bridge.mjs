function normalizeHarnessAgentBridgeArgs(fn, args = []) {
  if (!Array.isArray(args)) return [];
  if (fn !== "execWithRetry" && fn !== "launchOrResumeThread") {
    return args;
  }
  const index = fn === "execWithRetry" ? 1 : 3;
  const options = args[index] && typeof args[index] === "object"
    ? { ...args[index] }
    : {};
  if (!String(options.taskKey || "").trim()) {
    options.taskKey =
      String(
        options.slotMeta?.taskKey ||
        options.taskId ||
        options.linkedTaskId ||
        options.targetTaskKey ||
        options.workflowRunId ||
        options.workflowId ||
        "",
      ).trim() || null;
  }
  const normalizedArgs = [...args];
  normalizedArgs[index] = options;
  return normalizedArgs;
}

export async function executeHarnessBridgeServiceCall(method, args, deps = {}) {
  const {
    harnessAgentService,
    sendWorkflowTelegramMessage,
    getKanbanAdapter,
  } = deps;
  const [svc, fn] = String(method || "").split(".");
  switch (svc) {
    case "harnessAgent":
    case "agentPool": {
      const normalizedArgs = normalizeHarnessAgentBridgeArgs(fn, args);
      if (fn === "launchEphemeralThread") {
        return {
          handled: true,
          result: await harnessAgentService.launchEphemeralThread(...normalizedArgs),
        };
      }
      if (fn === "launchOrResumeThread") {
        return {
          handled: true,
          result: await harnessAgentService.launchOrResumeThread(...normalizedArgs),
        };
      }
      if (fn === "execWithRetry") {
        return {
          handled: true,
          result: await harnessAgentService.execWithRetry(normalizedArgs[0], normalizedArgs[1] || {}),
        };
      }
      if (fn === "continueSession") {
        const [sessionId, prompt, opts = {}] = normalizedArgs;
        return {
          handled: true,
          result: await harnessAgentService.continueSession(sessionId, prompt, opts),
        };
      }
      if (fn === "killSession") {
        try {
          return {
            handled: true,
            result: await harnessAgentService.killSession(args?.[0]),
          };
        } catch {
          return { handled: true, result: false };
        }
      }
      return { handled: false, result: undefined };
    }
    case "telegram":
      if (fn === "sendMessage") {
        return {
          handled: true,
          result: sendWorkflowTelegramMessage(args?.[0], args?.[1], args?.[2] || {}),
        };
      }
      return { handled: false, result: undefined };
    case "kanban": {
      const adapter = getKanbanAdapter?.();
      if (!adapter) throw new Error("Kanban adapter not available");
      if (fn === "createTask") return { handled: true, result: adapter.createTask?.(...args) };
      if (fn === "updateTaskStatus") return { handled: true, result: adapter.updateTaskStatus?.(...args) };
      if (fn === "listTasks") return { handled: true, result: adapter.listTasks?.(...args) };
      if (fn === "getTask") return { handled: true, result: adapter.getTask?.(...args) };
      return { handled: false, result: undefined };
    }
    default:
      return { handled: false, result: undefined };
  }
}

export function createWorkflowAgentPoolService(deps = {}) {
  const { harnessAgentService } = deps;
  return {
    launchEphemeralThread: (...args) => harnessAgentService.launchEphemeralThread(...args),
    launchOrResumeThread: (...args) => harnessAgentService.launchOrResumeThread(...args),
    continueSession: (...args) => harnessAgentService.continueSession(...args),
    execWithRetry: (...args) => harnessAgentService.execWithRetry(...args),
    async killSession(sessionId) {
      if (!sessionId) return false;
      try {
        return await harnessAgentService.killSession(sessionId);
      } catch {
        return false;
      }
    },
  };
}

export async function resolveInteractiveSessionExecutor(deps = {}) {
  const { uiDeps = {}, harnessAgentService } = deps;
  return typeof uiDeps.execPrimaryPrompt === "function"
    ? uiDeps.execPrimaryPrompt
    : harnessAgentService.runInteractivePrompt.bind(harnessAgentService);
}

export async function resolveBackgroundPromptExecutor(deps = {}) {
  const { uiDeps = {}, harnessAgentService } = deps;
  if (typeof uiDeps.execBackgroundPrompt === "function") return uiDeps.execBackgroundPrompt;
  if (typeof uiDeps.execPooledPrompt === "function") return uiDeps.execPooledPrompt;
  if (typeof uiDeps.execPrimaryPrompt === "function") return uiDeps.execPrimaryPrompt;
  return harnessAgentService.runBackgroundPrompt.bind(harnessAgentService);
}
