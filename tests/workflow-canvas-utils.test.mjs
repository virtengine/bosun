import { describe, expect, it } from "vitest";
import {
  buildDraftFlowchartMap,
  buildDraftFlowchartMetadata,
  buildCollapsedGraph,
  convertSelectionToSubworkflow,
  createHistoryState,
  createNodeGroup,
  hydrateCanvasEdges,
  moveWorkflowGroupByDelta,
  parseGraphSnapshot,
  pushHistorySnapshot,
  redoHistory,
  searchNodeTypes,
  serializeGraphSnapshot,
  toggleWorkflowGroupCollapsed,
  undoHistory,
  validateCanvasEdgePorts,
  canUpdateCanvasEdgePortMapping,
} from "../ui/tabs/workflow-canvas-utils.mjs";

function makeNode(id, x = 0, y = 0) {
  return {
    id,
    type: "action.run_command",
    label: id,
    position: { x, y },
    config: {},
    outputs: ["default"],
  };
}

describe("workflow canvas node search", () => {
  const nodeTypeFixtures = [
    {
      type: "action.run_agent",
      category: "action",
      description: "Runs an agent task with configured profile",
      outputs: ["result"],
      schema: {
        properties: {
          agentProfileId: { type: "string" },
          prompt: { type: "string" },
        },
      },
    },
    {
      type: "agent.configure_profile",
      category: "agent",
      description: "Configure agent execution profile and defaults",
      outputs: ["profile"],
      schema: {
        properties: {
          model: { type: "string" },
        },
      },
    },
    {
      type: "notify.telegram",
      category: "notify",
      description: "Send a Telegram notification",
      outputs: ["sent"],
      schema: {
        properties: {
          message: { type: "string" },
        },
      },
    },
  ];

  it("matches fuzzy partial name queries", () => {
    const results = searchNodeTypes(nodeTypeFixtures, "agent", 10);
    const types = results.map((item) => item.type);
    expect(types).toContain("action.run_agent");
    expect(types).toContain("agent.configure_profile");
  });

  it("matches by category and description", () => {
    const categoryResults = searchNodeTypes(nodeTypeFixtures, "notify", 10);
    expect(categoryResults[0]?.type).toBe("notify.telegram");

    const descriptionResults = searchNodeTypes(nodeTypeFixtures, "telegram notification", 10);
    expect(descriptionResults[0]?.type).toBe("notify.telegram");
  });

  it("returns all registered node types when query is empty", () => {
    const results = searchNodeTypes(nodeTypeFixtures, "", 10);
    expect(results.length).toBe(nodeTypeFixtures.length);
  });

  it("finds custom nodes through fuzzy query and keeps custom metadata", () => {
    const customFixtures = [
      ...nodeTypeFixtures,
      {
        type: "custom.my_notifier",
        category: "custom",
        description: "Custom node: my notifier",
        inputs: ["message"],
        outputs: ["success", "error"],
        badge: "custom",
        isCustom: true,
      },
    ];
    const results = searchNodeTypes(customFixtures, "my notifier");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].type).toBe("custom.my_notifier");
    expect(results[0].isCustom).toBe(true);
    expect(results[0].badge).toBe("custom");
  });
});

describe("workflow canvas history", () => {
  it("undo/redo traverses add-delete graph changes", () => {
    const nodeA = makeNode("node-a", 10, 20);
    const edge = { id: "edge-a", source: "node-a", target: "node-b", sourcePort: "default" };

    let history = createHistoryState([], []);

    history = pushHistorySnapshot(history, [nodeA], [], 50);
    expect(parseGraphSnapshot(history.present).nodes.map((node) => node.id)).toEqual(["node-a"]);

    history = pushHistorySnapshot(history, [nodeA, makeNode("node-b", 200, 20)], [edge], 50);
    expect(parseGraphSnapshot(history.present).edges.map((item) => item.id)).toEqual(["edge-a"]);

    history = pushHistorySnapshot(history, [nodeA], [], 50);
    expect(parseGraphSnapshot(history.present).nodes.map((node) => node.id)).toEqual(["node-a"]);
    expect(parseGraphSnapshot(history.present).edges).toEqual([]);

    const undo1 = undoHistory(history);
    expect(undo1.snapshot.nodes.map((node) => node.id)).toEqual(["node-a", "node-b"]);
    expect(undo1.snapshot.edges.map((item) => item.id)).toEqual(["edge-a"]);

    const redo1 = redoHistory(undo1.history, 50);
    expect(redo1.snapshot.nodes.map((node) => node.id)).toEqual(["node-a"]);
    expect(redo1.snapshot.edges).toEqual([]);
  });

  it("enforces history depth limit of 50", () => {
    let history = createHistoryState([], []);
    for (let index = 1; index <= 80; index += 1) {
      history = pushHistorySnapshot(history, [makeNode(`node-${index}`, index, index)], [], 50);
    }
    expect(history.past.length).toBe(50);
  });

  it("does not grow history when a snapshot is unchanged", () => {
    let history = createHistoryState([], []);
    history = pushHistorySnapshot(history, [makeNode("node-a", 10, 20)], [], 50);
    const beforeRepeat = history;
    const repeated = pushHistorySnapshot(history, [makeNode("node-a", 10, 20)], [], 50);
    expect(repeated).toBe(beforeRepeat);
    expect(repeated.past.length).toBe(1);
  });

  it("snapshot serialization round-trips node and edge data", () => {
    const nodes = [makeNode("n1", 40, 80)];
    const edges = [{ id: "e1", source: "n1", target: "n2", condition: "ok" }];

    const snapshot = serializeGraphSnapshot(nodes, edges);
    const parsed = parseGraphSnapshot(snapshot);

    expect(parsed.nodes).toEqual(nodes);
    expect(parsed.edges).toEqual([
      {
        id: "e1",
        source: "n1",
        target: "n2",
        condition: "ok",
        sourcePort: "default",
        targetPort: "default",
        sourcePortType: "Any",
        targetPortType: "Any",
      },
    ]);
  });

  it("snapshot serialization preserves mixed legacy and explicit edge ports", () => {
    const nodes = [makeNode("n1", 40, 80), makeNode("n2", 140, 80), makeNode("n3", 240, 80)];
    const edges = [
      { id: "legacy-edge", source: "n1", target: "n2" },
      {
        id: "explicit-edge",
        source: "n2",
        target: "n3",
        sourcePort: "success",
        targetPort: "payload",
        sourcePortType: "JSON",
        targetPortType: "JSON",
      },
    ];

    const snapshot = serializeGraphSnapshot(nodes, edges);
    const parsed = parseGraphSnapshot(snapshot);

    expect(parsed.edges).toEqual([
      {
        id: "legacy-edge",
        source: "n1",
        target: "n2",
        sourcePort: "default",
        targetPort: "default",
        sourcePortType: "Any",
        targetPortType: "Any",
      },
      {
        id: "explicit-edge",
        source: "n2",
        target: "n3",
        sourcePort: "success",
        targetPort: "payload",
        sourcePortType: "JSON",
        targetPortType: "JSON",
      },
    ]);
  });

  it("parses legacy edge aliases into explicit default port bindings", () => {
    const parsed = parseGraphSnapshot(JSON.stringify({
      nodes: [makeNode("n1", 10, 20), makeNode("n2", 30, 40)],
      edges: [
        { id: "legacy-edge", source: "n1", target: "n2", fromPort: "success" },
        { id: "legacy-default", source: "n2", target: "n1" },
      ],
    }));

    expect(parsed.edges).toEqual([
      {
        id: "legacy-edge",
        source: "n1",
        target: "n2",
        sourcePort: "success",
        targetPort: "default",
        sourcePortType: "Any",
        targetPortType: "Any",
      },
      {
        id: "legacy-default",
        source: "n2",
        target: "n1",
        sourcePort: "default",
        targetPort: "default",
        sourcePortType: "Any",
        targetPortType: "Any",
      },
    ]);
  });

  it("preserves configured branch ports even when stored outputPorts only contain default", () => {
    const nodes = [
      {
        id: "condition",
        type: "condition.expression",
        label: "Condition",
        position: { x: 0, y: 0 },
        config: {},
        outputs: ["yes", "no"],
        outputPorts: [{ name: "default", label: "default", type: "Boolean" }],
      },
      {
        id: "next",
        type: "action.run_command",
        label: "Next",
        position: { x: 120, y: 0 },
        config: {},
        inputs: ["default"],
      },
    ];

    const issues = validateCanvasEdgePorts(nodes, [{
      id: "condition->next",
      source: "condition",
      target: "next",
      sourcePort: "yes",
      targetPort: "default",
    }], []);

    expect(issues).toEqual([]);
  });

  it("undo/redo restores node move, edge creation, and config edits", () => {
    const nodeA = makeNode("node-a", 20, 40);
    const nodeB = makeNode("node-b", 280, 40);
    let history = createHistoryState([nodeA, nodeB], []);

    history = pushHistorySnapshot(
      history,
      [
        { ...nodeA, position: { x: 140, y: 120 } },
        nodeB,
      ],
      [],
      50,
    );

    history = pushHistorySnapshot(
      history,
      [
        { ...nodeA, position: { x: 140, y: 120 } },
        nodeB,
      ],
      [{ id: "edge-a-b", source: "node-a", target: "node-b", sourcePort: "default" }],
      50,
    );

    history = pushHistorySnapshot(
      history,
      [
        { ...nodeA, position: { x: 140, y: 120 }, config: { prompt: "hello" } },
        nodeB,
      ],
      [{ id: "edge-a-b", source: "node-a", target: "node-b", sourcePort: "default" }],
      50,
    );

    const undoConfig = undoHistory(history);
    expect(undoConfig.snapshot.nodes[0].config || {}).toEqual({});
    expect(undoConfig.snapshot.edges).toHaveLength(1);

    const undoEdge = undoHistory(undoConfig.history);
    expect(undoEdge.snapshot.edges).toHaveLength(0);
    expect(undoEdge.snapshot.nodes[0].position).toEqual({ x: 140, y: 120 });

    const undoMove = undoHistory(undoEdge.history);
    expect(undoMove.snapshot.nodes[0].position).toEqual({ x: 20, y: 40 });

    const redoMove = redoHistory(undoMove.history, 50);
    expect(redoMove.snapshot.nodes[0].position).toEqual({ x: 140, y: 120 });

    const redoEdge = redoHistory(redoMove.history, 50);
    expect(redoEdge.snapshot.edges).toHaveLength(1);

    const redoConfig = redoHistory(redoEdge.history, 50);
    expect(redoConfig.snapshot.nodes[0].config).toEqual({ prompt: "hello" });
  });

  it("snapshot serialization round-trips groups alongside nodes and edges", () => {
    const nodes = [makeNode("n1", 40, 80)];
    const edges = [{ id: "e1", source: "n1", target: "n2", condition: "ok" }];
    const groups = [{ id: "group-1", label: "Group 1", color: "#60a5fa", nodeIds: ["n1"], collapsed: false }];

    const snapshot = serializeGraphSnapshot(nodes, edges, groups);
    const parsed = parseGraphSnapshot(snapshot);

    expect(parsed.nodes).toEqual(nodes);
    expect(parsed.edges).toEqual([
      {
        id: "e1",
        source: "n1",
        target: "n2",
        condition: "ok",
        sourcePort: "default",
        targetPort: "default",
        sourcePortType: "Any",
        targetPortType: "Any",
      },
    ]);
    expect(parsed.groups).toEqual(groups);
  });

  it("builds a draft flowchart map that keeps grouped design steps linked to runtime nodes", () => {
    const nodes = [makeNode("start", 20, 40), makeNode("fetch", 240, 40), makeNode("notify", 460, 40)];
    const edges = [
      { id: "edge-1", source: "start", target: "fetch" },
      { id: "edge-2", source: "fetch", target: "notify" },
    ];
    const groups = [{ id: "group-a", label: "Research", color: "#60a5fa", nodeIds: ["start", "fetch"], collapsed: false }];

    const flowchart = buildDraftFlowchartMap({ nodes, edges, groups });

    expect(flowchart.steps).toEqual([
      expect.objectContaining({
        id: "group:group-a",
        label: "Research",
        runtimeNodeIds: ["start", "fetch"],
        runtimeNodeCount: 2,
      }),
      expect.objectContaining({
        id: "node:notify",
        runtimeNodeIds: ["notify"],
        runtimeNodeCount: 1,
      }),
    ]);
    expect(flowchart.runtimeNodeToStepId).toEqual({
      start: "group:group-a",
      fetch: "group:group-a",
      notify: "node:notify",
    });
    expect(flowchart.links).toEqual([
      expect.objectContaining({
        sourceStepId: "group:group-a",
        targetStepId: "node:notify",
        edgeIds: ["edge-2"],
      }),
    ]);
  });

  it("normalizes saved draft flowchart metadata and supplements missing runtime bindings", () => {
    const nodes = [makeNode("n1", 20, 40), makeNode("n2", 240, 40)];
    const edges = [{ id: "edge-n1-n2", source: "n1", target: "n2" }];
    const metadata = buildDraftFlowchartMetadata({
      nodes,
      edges,
      metadata: {
        flowchart: {
          version: 1,
          source: "user",
          steps: [{ id: "plan-step", label: "Start", runtimeNodeIds: ["n1"] }],
          links: [],
        },
      },
    });

    const flowchart = buildDraftFlowchartMap({ nodes, edges, metadata: { flowchart: metadata } });

    expect(flowchart.steps).toEqual([
      expect.objectContaining({ id: "plan-step", runtimeNodeIds: ["n1"] }),
      expect.objectContaining({ id: "node:n2", runtimeNodeIds: ["n2"] }),
    ]);
    expect(flowchart.links).toEqual([
      expect.objectContaining({ sourceStepId: "plan-step", targetStepId: "node:n2" }),
    ]);
  });

  it("creates groups, collapses them into a proxy node, and moves children together", () => {
    const graph = {
      nodes: [makeNode("a", 20, 40), makeNode("b", 280, 40), makeNode("c", 560, 40)],
      edges: [
        { id: "edge-a-b", source: "a", target: "b", sourcePort: "default" },
        { id: "edge-b-c", source: "b", target: "c", sourcePort: "default" },
      ],
      groups: [],
    };

    const created = createNodeGroup(graph, ["a", "b"], { id: "group-ab", label: "Core", color: "#8b5cf6" });
    expect(created.groups).toHaveLength(1);
    expect(created.groups[0]).toMatchObject({
      id: "group-ab",
      label: "Core",
      color: "#8b5cf6",
      nodeIds: ["a", "b"],
      collapsed: false,
    });

    const collapsed = toggleWorkflowGroupCollapsed(created, "group-ab", true);
    expect(collapsed.groups[0].collapsed).toBe(true);

    const collapsedGraph = buildCollapsedGraph(collapsed);
    expect(collapsedGraph.visibleNodes.map((node) => node.id)).toEqual(["c", "group-ab"]);
    expect(collapsedGraph.visibleEdges).toEqual([
      expect.objectContaining({ source: "group-ab", target: "c", originalEdgeIds: ["edge-b-c"] }),
    ]);

    const moved = moveWorkflowGroupByDelta(collapsed, "group-ab", 120, 50);
    expect(moved.nodes.find((node) => node.id === "a")?.position).toEqual({ x: 140, y: 90 });
    expect(moved.nodes.find((node) => node.id === "b")?.position).toEqual({ x: 400, y: 90 });
  });

  it("extracts selected nodes into a child workflow and rewrites downstream references", () => {
    const parentWorkflow = {
      id: "parent-workflow",
      name: "Parent Workflow",
      nodes: [
        makeNode("source", 20, 40),
        { ...makeNode("transform", 260, 40), config: { prompt: "{{source.output}}" } },
        { ...makeNode("summarize", 500, 40), config: { value: "{{transform.result}}" } },
        { ...makeNode("publish", 780, 40), config: { message: "{{summarize.result}}" } },
      ],
      edges: [
        { id: "edge-source-transform", source: "source", target: "transform", sourcePort: "default" },
        { id: "edge-transform-summarize", source: "transform", target: "summarize", sourcePort: "default" },
        { id: "edge-summarize-publish", source: "summarize", target: "publish", sourcePort: "default" },
      ],
      groups: [],
      variables: {},
    };

    const converted = convertSelectionToSubworkflow(parentWorkflow, ["transform", "summarize"], {
      childWorkflowId: "child-workflow",
      childName: "Child Workflow",
      executeNodeId: "execute-child",
    });

    expect(converted.childWorkflow.id).toBe("child-workflow");
    expect(converted.childWorkflow.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining(["workflow-call", "transform", "summarize", "workflow-end"]),
    );
    expect(converted.childWorkflow.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "workflow-call", target: "transform" }),
        expect.objectContaining({ source: "transform", target: "summarize" }),
        expect.objectContaining({ source: "summarize", target: "workflow-end" }),
      ]),
    );

    const executeNode = converted.parentWorkflow.nodes.find((node) => node.id === "execute-child");
    expect(executeNode).toMatchObject({
      type: "action.execute_workflow",
      config: {
        workflowId: "child-workflow",
        mode: "sync",
        input: { source: "{{source}}" },
      },
    });
    expect(converted.parentWorkflow.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "source", target: "execute-child" }),
        expect.objectContaining({ source: "execute-child", target: "publish" }),
      ]),
    );
    expect(converted.parentWorkflow.nodes.find((node) => node.id === "publish")?.config?.message)
      .toBe("{{execute-child.output.nodeOutputs.summarize.result}}");
  });
  it("hydrates legacy and explicit edge port bindings from runtime node metadata", () => {
    const nodeTypes = [
      {
        type: "test.router",
        ports: {
          outputs: [
            { name: "default", label: "Default", type: "Any" },
            { name: "success", label: "Success", type: "JSON" },
          ],
        },
      },
      {
        type: "test.consumer",
        ports: {
          inputs: [
            { name: "default", label: "Default", type: "Any" },
            { name: "payload", label: "Payload", type: "JSON" },
          ],
        },
      },
    ];
    const nodes = [
      { id: "source", type: "test.router", label: "Source", config: {} },
      { id: "target", type: "test.consumer", label: "Target", config: {} },
    ];
    const edges = [
      { id: "legacy", source: "source", target: "target" },
      { id: "explicit", source: "source", target: "target", sourcePort: "success", targetPort: "payload" },
    ];

    const hydrated = hydrateCanvasEdges(nodes, edges, nodeTypes);

    expect(hydrated).toEqual([
      expect.objectContaining({
        id: "legacy",
        sourcePort: "default",
        targetPort: "default",
        sourcePortType: "Any",
        targetPortType: "Any",
      }),
      expect.objectContaining({
        id: "explicit",
        sourcePort: "success",
        targetPort: "payload",
        sourcePortType: "JSON",
        targetPortType: "JSON",
      }),
    ]);
  });

  it("reports clear validation errors for invalid explicit edge bindings", () => {
    const nodeTypes = [
      {
        type: "test.router",
        ports: {
          outputs: [{ name: "success", label: "Success", type: "JSON" }],
        },
      },
      {
        type: "test.consumer",
        ports: {
          inputs: [{ name: "count", label: "Count", type: "Number" }],
        },
      },
    ];
    const nodes = [
      { id: "source", type: "test.router", label: "Source", config: {} },
      { id: "target", type: "test.consumer", label: "Target", config: {} },
    ];

    const issues = validateCanvasEdgePorts(nodes, [
      {
        id: "bad-edge",
        source: "source",
        target: "target",
        sourcePort: "missing-output",
        targetPort: "missing-input",
      },
    ], nodeTypes);

    expect(issues).toHaveLength(2);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        edgeId: "bad-edge",
        sourcePort: "missing-output",
        targetPort: "missing-input",
        severity: "error",
        message: expect.stringContaining("Unknown source port \"missing-output\""),
      }),
      expect.objectContaining({
        edgeId: "bad-edge",
        sourcePort: "missing-output",
        targetPort: "missing-input",
        severity: "error",
        message: expect.stringContaining("Unknown target port \"missing-input\""),
      }),
    ]));
  });
  it("allows repairing stale explicit bindings one side at a time", () => {
    const nodeTypes = [
      {
        type: "test.router",
        ports: {
          outputs: [
            { name: "default", label: "Default", type: "Any" },
            { name: "success", label: "Success", type: "JSON" },
          ],
        },
      },
      {
        type: "test.consumer",
        ports: {
          inputs: [
            { name: "default", label: "Default", type: "Any" },
            { name: "payload", label: "Payload", type: "JSON" },
          ],
        },
      },
    ];
    const nodes = [
      { id: "source", type: "test.router", label: "Source", config: {} },
      { id: "target", type: "test.consumer", label: "Target", config: {} },
    ];
    const staleEdge = {
      id: "stale-edge",
      source: "source",
      target: "target",
      sourcePort: "missing-output",
      targetPort: "missing-input",
    };

    const repairSource = canUpdateCanvasEdgePortMapping(staleEdge, { sourcePort: "success" }, nodes, nodeTypes);
    expect(repairSource.allowed).toBe(true);
    expect(repairSource.blockingIssue).toBeNull();
    expect(repairSource.validation.requestedSourcePortName).toBe("success");
    expect(repairSource.validation.requestedTargetPortName).toBe("missing-input");

    const repairTarget = canUpdateCanvasEdgePortMapping(staleEdge, { targetPort: "payload" }, nodes, nodeTypes);
    expect(repairTarget.allowed).toBe(true);
    expect(repairTarget.blockingIssue).toBeNull();
    expect(repairTarget.validation.requestedSourcePortName).toBe("missing-output");
    expect(repairTarget.validation.requestedTargetPortName).toBe("payload");

    const invalidSource = canUpdateCanvasEdgePortMapping(staleEdge, { sourcePort: "still-missing" }, nodes, nodeTypes);
    expect(invalidSource.allowed).toBe(false);
    expect(invalidSource.blockingIssue).toEqual(expect.objectContaining({
      code: "unknown-output-port",
      message: expect.stringContaining("Unknown source port \"still-missing\""),
    }));

    const invalidTarget = canUpdateCanvasEdgePortMapping(staleEdge, { targetPort: "still-missing" }, nodes, nodeTypes);
    expect(invalidTarget.allowed).toBe(false);
    expect(invalidTarget.blockingIssue).toEqual(expect.objectContaining({
      code: "unknown-input-port",
      message: expect.stringContaining("Unknown target port \"still-missing\""),
    }));
  });

});

