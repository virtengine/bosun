import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHarnessAgentService } from "../agent/harness-agent-service.mjs";
import { loadConfig } from "../config/config.mjs";
import {
  BUILTIN_WORKFLOWS,
  createConfiguredPipeline,
  listWorkflowDefinitions,
  resolveWorkflowDefinition,
  runConfiguredWorkflow as runPipelineConfiguredWorkflow,
} from "./pipeline.mjs";

function normalizeWorkflowDefinition(name, definition = {}, config = {}) {
  const resolved = resolveWorkflowDefinition(name, {
    ...(config.workflows || {}),
    [name]: definition,
  });
  return resolved?.definition || null;
}

function listConfiguredWorkflows(config = {}) {
  return listWorkflowDefinitions(config.workflows || {}).map((entry) => {
    const definition = entry?.definition || {};
    const rawAgents = Array.isArray(definition.stages) && definition.stages.length > 0
      ? definition.stages
      : Array.isArray(definition.agents)
        ? definition.agents
        : [];
    return {
      id: definition.id || entry?.name,
      name: definition.name || entry?.name,
      type: definition.type || "sequential",
      description: definition.description || "",
      source: entry?.source || "unknown",
      agents: rawAgents.map((agent, index) => {
        if (typeof agent === "string") {
          return { id: agent, name: agent, role: agent, sdk: null };
        }
        return {
          id: agent?.id || agent?.name || `agent-${index + 1}`,
          name: agent?.name || agent?.id || `agent-${index + 1}`,
          role: agent?.stage || agent?.role || null,
          sdk: agent?.sdk || agent?.executor || null,
        };
      }),
    };
  });
}

function buildConsensus(result) {
  const votes = new Map();
  for (const output of result.outputs || []) {
    const text = String(output.summary || output.output || "").trim();
    if (!text) continue;
    votes.set(text, (votes.get(text) || 0) + 1);
  }
  let winner = null;
  for (const [text, count] of votes.entries()) {
    if (!winner || count > winner.count) winner = { text, count };
  }
  return winner;
}

function createWorkflowAgentPool(options = {}) {
  if (options.dryRun === true) {
    return {
      getPoolSdkName,
      async execWithRetry(prompt, execOptions = {}) {
        const sdk = execOptions.sdk || getPoolSdkName() || "codex";
        return {
          success: true,
          output: `[${sdk}] ${String(prompt).split("\n")[0]}`,
          sdk,
          attempts: 1,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      },
      async continueSession(sessionId, prompt, execOptions = {}) {
        const sdk = execOptions.sdk || getPoolSdkName() || "codex";
        return {
          success: true,
          output: `[${sdk}] continued ${String(prompt).split("\n")[0]}`,
          sdk,
          threadId: sessionId || null,
          attempts: 1,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      },
    };
  }
  const harnessAgentService = createHarnessAgentService({
    agentPool: options.agentPool || options.services?.agentPool || {},
  });
  return {
    continueSession: harnessAgentService.continueSession,
    execWithRetry: harnessAgentService.execWithRetry,
    getPoolSdkName: harnessAgentService.getPoolSdkName,
    killSession: harnessAgentService.killSession,
  };
}

async function runConfiguredWorkflow(name, input, options = {}) {
  const config = options.config || loadConfig();
  const result = await runPipelineConfiguredWorkflow(name, input, {
    workflows: config.workflows || {},
    services: {
      agentPool: options.services?.agentPool || createWorkflowAgentPool(options),
    },
    runOptions: options.runOptions || {},
  });

  const resolved = resolveWorkflowDefinition(name, config.workflows || {});
  const workflow = resolved?.definition || { id: name, name, type: "sequential" };
  const status = result.success ? "success" : "failed";
  return {
    ...result,
    status,
    workflow: {
      id: workflow.id || name,
      name: workflow.name || name,
      type: workflow.type || "sequential",
    },
    consensus:
      String(workflow.id || name) === "consensus-vote" ? buildConsensus(result) : undefined,
  };
}

function loadWorkflowInputFromFile(pathValue) {
  const fullPath = resolve(pathValue);
  const raw = readFileSync(fullPath, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function createWorkflowInstance(definition, options = {}) {
  return createConfiguredPipeline(definition, {
    services: {
      agentPool: options.services?.agentPool || createWorkflowAgentPool(options),
    },
    hub: options.hub,
    createHub: options.createHub,
    hubOptions: options.hubOptions,
  });
}

export {
  BUILTIN_WORKFLOWS,
  normalizeWorkflowDefinition,
  listConfiguredWorkflows,
  loadWorkflowInputFromFile,
  createWorkflowInstance,
  runConfiguredWorkflow,
};
export default {
  BUILTIN_WORKFLOWS,
  normalizeWorkflowDefinition,
  listConfiguredWorkflows,
  loadWorkflowInputFromFile,
  createWorkflowInstance,
  runConfiguredWorkflow,
};
