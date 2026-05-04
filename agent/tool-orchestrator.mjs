/**
 * Canonical architecture note:
 * Tool registration, execution routing, approvals, retry policy, network
 * policy, sandbox policy, and truncation semantics are owned here. Surface
 * wrappers may adapt transport or UX, but they must not co-own tool-control
 * rules outside this orchestrator contract.
 */

import { resolveRepoRoot } from "../config/repo-root.mjs";
import { getAgentToolConfig, getEffectiveTools, listAvailableTools } from "./agent-tool-config.mjs";
import { createBuiltinToolDefinitions } from "./tool-builtin-catalog.mjs";
import { createToolApprovalManager } from "./tool-approval-manager.mjs";
import { buildToolPolicyContract } from "./tool-contract.mjs";
import { createToolExecutionLedger } from "./tool-execution-ledger.mjs";
import { createToolNetworkPolicy } from "./tool-network-policy.mjs";
import { buildToolExecutionEnvelope } from "./tool-runtime-context.mjs";
import { createToolRegistry } from "./tool-registry.mjs";
import {
  getToolRetryDelayMs,
  resolveToolRetryPolicy,
  shouldRetryToolExecution,
} from "./tool-retry-policy.mjs";
import {
  materializeTruncatedToolOutput,
  truncateToolOutput,
} from "./tool-output-truncation.mjs";
import {
  getBosunHotPathStatus,
  truncateWithBosunHotPathExec,
} from "../lib/hot-path-runtime.mjs";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function normalizeToolNameSet(values) {
  return new Set(
    (Array.isArray(values) ? values : [values])
      .map((entry) => toTrimmedString(entry).toLowerCase())
      .filter(Boolean),
  );
}

function resolveContextToolPolicy(context = {}) {
  const contract = context.subagentContract && typeof context.subagentContract === "object"
    ? context.subagentContract
    : {};
  const contractToolPolicy = contract.toolPolicy && typeof contract.toolPolicy === "object"
    ? contract.toolPolicy
    : {};
  const toolPolicy = context.toolPolicy && typeof context.toolPolicy === "object"
    ? context.toolPolicy
    : {};
  return {
    allowedTools: [
      ...(Array.isArray(context.allowedTools) ? context.allowedTools : []),
      ...(Array.isArray(toolPolicy.allowedTools) ? toolPolicy.allowedTools : []),
      ...(Array.isArray(contractToolPolicy.allowedTools) ? contractToolPolicy.allowedTools : []),
    ],
    deniedTools: [
      ...(Array.isArray(context.deniedTools) ? context.deniedTools : []),
      ...(Array.isArray(toolPolicy.deniedTools) ? toolPolicy.deniedTools : []),
      ...(Array.isArray(contractToolPolicy.deniedTools) ? contractToolPolicy.deniedTools : []),
    ],
  };
}

function isToolAllowedForContext(toolName, context = {}) {
  const normalized = toTrimmedString(toolName).toLowerCase();
  if (!normalized) return false;
  const policy = resolveContextToolPolicy(context);
  const allowed = normalizeToolNameSet(policy.allowedTools);
  const denied = normalizeToolNameSet(policy.deniedTools);
  if (denied.has(normalized)) return false;
  if (allowed.size > 0) return allowed.has(normalized);
  return true;
}

function buildToolError(message, detail = {}) {
  const error = new Error(message);
  for (const [key, value] of Object.entries(detail || {})) {
    error[key] = value;
  }
  return error;
}

async function sleep(ms) {
  if (!(ms > 0)) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveToolRootDir(cwd = "") {
  try {
    return toTrimmedString(cwd || resolveRepoRoot() || process.cwd());
  } catch {
    return toTrimmedString(cwd || process.cwd());
  }
}

export function createToolCapabilityManifest(options = {}) {
  const rootDir = resolveToolRootDir(options.cwd);
  const agentProfileId = toTrimmedString(options.agentProfileId);
  const toolState = agentProfileId
    ? getEffectiveTools(rootDir, agentProfileId)
    : getEffectiveTools(rootDir, "__default__");
  const rawCfg = agentProfileId ? getAgentToolConfig(rootDir, agentProfileId) : null;
  const enabledBuiltinTools = (Array.isArray(toolState?.builtinTools) ? toolState.builtinTools : [])
    .filter((tool) => tool?.enabled)
    .map((tool) => ({
      id: toTrimmedString(tool?.id),
      name: toTrimmedString(tool?.name),
      description: toTrimmedString(tool?.description),
    }))
    .filter((tool) => tool.id);
  const enabledMcpServers = Array.isArray(rawCfg?.enabledMcpServers)
    ? rawCfg.enabledMcpServers.map((id) => toTrimmedString(id)).filter(Boolean)
    : [];
  return {
    agentProfileId: agentProfileId || null,
    enabledBuiltinTools,
    enabledMcpServers,
    toolBridge: {
      module: "./voice-tools.mjs",
      function: "executeToolCall(toolName, args, context)",
      quickUse: [
        "node -e \"import('../voice/voice-tools.mjs').then(async m=>{const r=await m.executeToolCall('get_workspace_context', {}, {});console.log(r?.result||r);})\"",
        "node -e \"import('../voice/voice-tools.mjs').then(async m=>{const r=await m.executeToolCall('list_tasks', {limit:10}, {});console.log(r?.result||r);})\"",
      ],
    },
    coreBuiltinTools: createBuiltinToolDefinitions(options)
      .map((tool) => ({
        id: toTrimmedString(tool.id),
        aliases: Array.isArray(tool.aliases) ? tool.aliases.slice() : [],
      }))
      .filter((tool) => tool.id),
  };
}

export function buildToolCapabilityContract(options = {}) {
  const manifest = createToolCapabilityManifest(options);
  return [
    "## Tool Capability Contract",
    "Use enabled tools by default. Do not claim tools are unavailable without first trying them.",
    "Enabled tools JSON:",
    "```json",
    JSON.stringify(manifest, null, 2),
    "```",
    "When uncertain about tool inputs/outputs, call get_admin_help via executeToolCall first.",
  ].join("\n");
}

export function createToolOrchestrator(options = {}) {
  const approvalManager = createToolApprovalManager(options.approvalOptions || {});
  const networkPolicy = createToolNetworkPolicy(options.networkPolicy || {});
  const toolSources = [
    ...(options.includeBuiltinBosunTools === false ? [] : [{
      source: "bosun-builtin",
      definitions: createBuiltinToolDefinitions(options),
    }]),
    ...(Array.isArray(options.toolSources) ? options.toolSources : (options.toolSources ? [options.toolSources] : [])),
  ];
  const registry = options.registry || createToolRegistry(toolSources);
  const orchestrator = {
    listTools(context = {}) {
      const rootDir = resolveToolRootDir(context.cwd || options.cwd);
      const agentProfileId = toTrimmedString(context.agentProfileId || options.agentProfileId);
      const configured = listAvailableTools(rootDir, agentProfileId || "__default__");
      const registryTools = registry.listTools();
      const tools = registryTools.length > 0 ? registryTools : configured;
      return tools.filter((tool) => isToolAllowedForContext(tool?.id || tool?.name || tool, context));
    },
    async execute(toolName, args = {}, context = {}) {
      const executeTool = typeof options.executeTool === "function"
        ? options.executeTool
        : (typeof registry.execute === "function"
            ? registry.execute.bind(registry)
            : null);
      if (typeof executeTool !== "function") {
        throw new Error("Tool orchestrator executeTool hook is not configured");
      }
      const toolDefinition = registry.getTool(toolName) || { id: toTrimmedString(toolName) };
      if (!isToolAllowedForContext(toolDefinition?.id || toolName, context)) {
        throw buildToolError(
          `Tool ${toTrimmedString(toolName) || "unknown"} is not allowed in this subagent contract.`,
          {
            code: "tool_not_allowed",
            toolName: toTrimmedString(toolName) || null,
          },
        );
      }
      const envelope = buildToolExecutionEnvelope(toolName, args, context, {
        cwd: toTrimmedString(options.cwd),
        repoRoot: toTrimmedString(options.repoRoot),
        agentProfileId: toTrimmedString(options.agentProfileId) || null,
      });
      const executionId = toTrimmedString(envelope.executionId);
      const ledger = createToolExecutionLedger({
        onEvent: options.onEvent,
        listeners: [context?.onEvent],
      });
      envelope.policy = buildToolPolicyContract(toolDefinition, envelope, {
        retryPolicy: options.retryPolicy || {},
        truncation: options.truncation || {},
        sandbox: options.sandbox,
      });
      const approvalOutcome = approvalManager.request(toolDefinition, envelope.context, {
        ...options.approvalOptions,
        repoRoot: envelope.context.repoRoot || envelope.context.cwd || options.repoRoot || options.cwd,
        preview: JSON.stringify(args ?? {}),
      });
      const approval = approvalOutcome?.approval || approvalManager.evaluate(toolDefinition, envelope.context);
      if (approval?.requestId) {
        envelope.context.approval = {
          ...(envelope.context.approval && typeof envelope.context.approval === "object" ? envelope.context.approval : {}),
          requestId: approval.requestId,
          state: approval.approvalState || envelope.context.approval?.state || null,
        };
        envelope.context.approvalRequestId = approval.requestId;
        envelope.policy.approval = {
          ...(envelope.policy?.approval && typeof envelope.policy.approval === "object" ? envelope.policy.approval : {}),
          requestId: approval.requestId,
          state: approval.approvalState || null,
          blocked: approval.blocked === true,
        };
      }
      if (approval.blocked) {
        if (approval.approvalState === "denied" || approval.approvalState === "expired") {
          ledger.record("approval_resolved", envelope, {
            approval,
            request: approvalOutcome?.request || null,
            status: approval.approvalState,
            decision: approval.approvalState,
          });
        }
        ledger.record("approval_requested", envelope, {
          approval,
          request: approvalOutcome?.request || null,
        });
        throw buildToolError(
          approval.reason || `Tool ${envelope.toolName} is blocked pending approval.`,
          {
            code: "tool_approval_required",
            approval,
            request: approvalOutcome?.request || null,
            toolName: envelope.toolName,
            executionId,
          },
        );
      }
      if (approval.approvalRequired === true && approval.blocked !== true) {
        ledger.record("approval_resolved", envelope, {
          approval,
          request: approvalOutcome?.request || null,
          status: approval.approvalState || "approved",
          decision: approval.approvalState || "approved",
        });
      }
      const network = networkPolicy.evaluate(toolDefinition, envelope.context, options.networkPolicy || {});
      envelope.policy.network = {
        ...(envelope.policy?.network && typeof envelope.policy.network === "object" ? envelope.policy.network : {}),
        ...network,
      };
      if (network.blocked) {
        ledger.record("tool_execution_error", envelope, {
          error: network.reason,
          network,
        });
        throw buildToolError(
          network.reason || `Network access is blocked for ${envelope.toolName}.`,
          {
            code: "tool_network_blocked",
            network,
            toolName: envelope.toolName,
            executionId,
          },
        );
      }
      const retry = resolveToolRetryPolicy(toolDefinition, envelope.context, options.retryPolicy || {});
      envelope.policy.retry = retry;
      const sandbox = envelope.policy?.sandbox || { mode: envelope.context.sandbox || "inherit" };
      ledger.record("tool_execution_start", envelope, {
        approval,
        network,
        retry,
        sandbox,
        status: "running",
      });
      let attempt = 0;
      let lastError = null;
      while (attempt < retry.maxAttempts) {
        attempt += 1;
        try {
          const result = await executeTool(toolName, args, envelope.context, toolDefinition);
          // These previews are observability-only. Authoritative session compaction
          // runs later in workspace/context-cache.mjs after the full turn is collected.
          const hotPathTruncated = await truncateWithBosunHotPathExec(
            result,
            options.truncation || {},
          );
          const truncated = await materializeTruncatedToolOutput(
            result,
            hotPathTruncated || truncateToolOutput(result, options.truncation || {}),
            options.truncation || {},
          );
          const truncation = {
            truncated: truncated.truncated,
            originalBytes: truncated.originalBytes,
            retainedBytes: truncated.retainedBytes,
          };
          ledger.record("tool_execution_update", envelope, {
            attempt,
            attemptCount: attempt,
            status: "completed",
            approval,
            network,
            retry,
            sandbox,
            hotPath: getBosunHotPathStatus(),
            truncation,
          });
          ledger.record("tool_execution_end", envelope, {
            attempt,
            attemptCount: attempt,
            approval,
            network,
            retry,
            sandbox,
            result: truncated,
            hotPath: getBosunHotPathStatus(),
            truncation,
          });
          return result;
        } catch (error) {
          lastError = error;
          const errorMessage = String(error?.message || error);
          const canRetry = shouldRetryToolExecution(error, attempt, retry);
          ledger.record("tool_execution_update", envelope, {
            attempt,
            attemptCount: attempt,
            status: canRetry ? "retrying" : "failed",
            approval,
            network,
            retry,
            sandbox,
            error: errorMessage,
          });
          if (canRetry) {
            const backoffMs = getToolRetryDelayMs(retry, attempt);
            ledger.record("tool_execution_retry", envelope, {
              attempt,
              nextAttempt: attempt + 1,
              approval,
              network,
              retry,
              sandbox,
              status: "retrying",
              backoffMs,
              error: errorMessage,
            });
            await sleep(backoffMs);
            continue;
          }
          ledger.record("tool_execution_error", envelope, {
            attempt,
            attemptCount: attempt,
            approval,
            network,
            retry,
            sandbox,
            error: errorMessage,
          });
          throw error;
        }
      }
      throw lastError || new Error(`Tool ${envelope.toolName} failed.`);
    },
  };
  orchestrator.executeTool = orchestrator.execute;
  return orchestrator;
}

export default createToolOrchestrator;
