/**
 * workflow-nodes.mjs — Public built-in workflow node entrypoint
 *
 * This file is intentionally a composition shell. It loads the modular
 * built-in registrars and re-exports the public workflow-node helpers without
 * re-owning harness runtime behavior.
 */

import { listNodeTypes } from "./workflow-engine.mjs";
import {
  ensureCustomWorkflowNodesLoaded,
  startCustomNodeDiscovery,
} from "./workflow-nodes/custom-loader.mjs";
import "./workflow-nodes/definitions.mjs";
import "./workflow-contract.mjs";
import "./workflow-nodes/agent.mjs";
import "./workflow-nodes/triggers.mjs";
import "./workflow-nodes/conditions.mjs";
import "./workflow-nodes/actions.mjs";
import "./workflow-nodes/meetings.mjs";
import "./workflow-nodes/validation.mjs";
import "./workflow-nodes/transforms.mjs";
import "./workflow-nodes/notifications.mjs";
import "./workflow-nodes/flow.mjs";
import "./workflow-nodes/loop.mjs";

export { registerNodeType, getNodeType, listNodeTypes, unregisterNodeType } from "./workflow-engine.mjs";
export {
  buildTaskContextBlock,
  evaluateTaskAssignedTriggerConfig,
  getBuiltinNodeDefinition,
  listBuiltinNodeDefinitions,
} from "./workflow-nodes/definitions.mjs";
export {
  CALIBRATED_MAX_RISK_WITHOUT_HUMAN,
  normalizePlannerAreaKey,
} from "./workflow-nodes/agent.mjs";
export {
  buildWorkflowDraftFlowchart,
  normalizeWorkflowFlowchartMetadata,
} from "./workflow-serializer.mjs";
export { classifyAcquireWorktreeFailure } from "./workflow-nodes/actions.mjs";
export {
  CUSTOM_NODE_DIR_NAME,
  ensureCustomWorkflowNodesLoaded,
  getCustomNodeDir,
  inspectCustomWorkflowNodePlugins,
  scaffoldCustomNodeFile,
  startCustomNodeDiscovery,
  stopCustomNodeDiscovery,
} from "./workflow-nodes/custom-loader.mjs";

let customLoadPromise = null;
let customDiscoveryStarted = false;

export async function ensureWorkflowNodeTypesLoaded(options = {}) {
  if (!customLoadPromise || options.forceReload) {
    customLoadPromise = ensureCustomWorkflowNodesLoaded(options);
  }
  await customLoadPromise;
  if (!customDiscoveryStarted) {
    startCustomNodeDiscovery(options);
    customDiscoveryStarted = true;
  }
  return listNodeTypes();
}
