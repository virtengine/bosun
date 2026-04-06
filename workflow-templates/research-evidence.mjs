import { edge, node, resetLayout } from "./_helpers.mjs";

resetLayout();

export const RESEARCH_EVIDENCE_AGENT_TEMPLATE = {
  id: "template-research-evidence-agent",
  name: "Research Evidence Agent",
  description:
    "Evidence-backed research workflow that keeps Bosun as orchestrator, " +
    "uses a local PDF-capable scientific evidence sidecar for grounded context, and " +
    "only promotes reviewed findings into shared knowledge after verification.",
  category: "research",
  enabled: true,
  trigger: "trigger.manual",
  variables: {
    repoRoot: ".",
    problem: "",
    domain: "computer-science",
    maxIterations: 10,
    searchLiterature: true,
    researchToolBundleId: "scientific-evidence",
    evidenceMode: "answer",
    maxEvidenceSources: 6,
    corpusPaths: [],
    includeRuntimeLogEvidence: true,
    runtimeLogPaths: [],
    promoteReviewedFindings: true,
    sidecarCommand: "",
    _previousFeedback: "",
    currentDraft: "",
    iterationCount: 0,
  },
  nodes: [
    node("trigger", "trigger.manual", "Start Evidence Research", {}, { x: 420, y: 60 }),

    node("should-search", "condition.expression", "Search Literature?", {
      expression: "Boolean($data?.searchLiterature !== false)",
    }, { x: 420, y: 180, outputs: ["yes", "no"] }),

    node("literature-search", "action.web_search", "Search Literature", {
      query: "{{problem}} {{domain}} peer reviewed evidence",
      maxResults: 6,
      engine: "fetch",
    }, { x: 200, y: 340 }),

    node("run-evidence-sidecar", "action.run_command", "Build Evidence Bundle", {
      command: "node",
      args: ["workflow/research-evidence-sidecar.mjs", "run"],
      cwd: "{{repoRoot}}",
      parseJson: true,
      failOnError: false,
      timeoutMs: 300000,
      env: {
        BOSUN_RESEARCH_SIDECAR_INPUT:
          "{{({ problem: $data.problem, domain: $data.domain, researchToolBundleId: $data.researchToolBundleId, evidenceMode: $data.evidenceMode, maxEvidenceSources: $data.maxEvidenceSources, corpusPaths: $data.corpusPaths, includeRuntimeLogEvidence: $data.includeRuntimeLogEvidence, runtimeLogPaths: $data.runtimeLogPaths, searchLiterature: $data.searchLiterature, literatureResults: $ctx.getNodeOutput('literature-search')?.results || [], repoRoot: $data.repoRoot, triggerSource: $data.triggerSource || 'manual', sidecarCommand: $data.sidecarCommand || '' })}}",
      },
    }, { x: 420, y: 500 }),

    node("evidence-ready", "condition.expression", "Evidence Ready?", {
      expression:
        "$ctx.getNodeOutput('run-evidence-sidecar')?.success === true && " +
        "Boolean($ctx.getNodeOutput('run-evidence-sidecar')?.output?.artifactPath)",
    }, { x: 420, y: 660, outputs: ["yes", "no"] }),

    node("evidence-failed-log", "notify.log", "Evidence Sidecar Failed", {
      message:
        "Research evidence sidecar failed for {{problem}}.\n" +
        "Output: {{$ctx.getNodeOutput('run-evidence-sidecar')?.output || ''}}",
      level: "error",
    }, { x: 760, y: 820 }),

    node("evidence-failed-end", "flow.end", "End Research (Evidence Failure)", {
      status: "failed",
      message: "Evidence sidecar failed to prepare a research bundle.",
      output: {
        problem: "{{problem}}",
        domain: "{{domain}}",
      },
    }, { x: 760, y: 980 }),

    node("generate-solution", "action.run_agent", "Generate Solution", {
      prompt: `# Evidence-Backed Research Generation

## Research Problem
{{problem}}

## Domain
{{domain}}

## Evidence Mode
{{evidenceMode}}

## Evidence Summary
{{run-evidence-sidecar.output.bundle.summary}}

## Research Tool Bundle
{{run-evidence-sidecar.output.toolBundleBrief}}

## Review Hints
{{run-evidence-sidecar.output.bundle.reviewHints}}

## Uncertainty Summary
{{run-evidence-sidecar.output.bundle.uncertaintySummary}}

## Evidence Bundle
{{run-evidence-sidecar.output.evidenceBrief}}

## Artifact
{{run-evidence-sidecar.output.artifactPath}}

## Previous Critical Feedback
{{_previousFeedback}}

## Instructions
You are Bosun's research generation phase.
Produce a rigorous candidate answer grounded in the supplied evidence.
Use citation keys such as [E1], [E2] inline whenever you rely on an evidence item.
Prefer the named research tool bundle and its recommended MCP/native evidence capabilities before making unsupported claims.
Do not invent claims not supported by the evidence bundle.
If the evidence is insufficient, say exactly what remains uncertain.

Return sections in this order:
1. Claim
2. Evidence Synthesis
3. Limitations
4. Final Answer`,
      sdk: "auto",
      timeoutMs: 1800000,
      failOnError: false,
    }, { x: 160, y: 820 }),

    node("store-generated-draft", "action.set_variable", "Store Draft", {
      key: "currentDraft",
      value: "{{generate-solution.output}}",
    }, { x: 160, y: 980 }),

    node("increment-iteration", "action.set_variable", "Increment Iteration", {
      key: "iterationCount",
      value: "Number($data?.iterationCount || 0) + 1",
      isExpression: true,
    }, { x: 160, y: 1140 }),

    node("iteration-budget", "condition.expression", "Iteration Budget Available?", {
      expression: "Number($data?.iterationCount || 0) <= Number($data?.maxIterations || 1)",
    }, { x: 160, y: 1300, outputs: ["yes", "no"] }),

    node("iteration-limit-log", "notify.log", "Iteration Limit Reached", {
      message:
        "Evidence-backed research stopped after {{iterationCount}} verification cycle(s) " +
        "for {{problem}} without a correct verdict.",
      level: "warn",
    }, { x: 20, y: 1460 }),

    node("iteration-limit-end", "flow.end", "End Research (Iteration Limit)", {
      status: "failed",
      message: "Research did not converge before maxIterations was reached.",
      output: {
        problem: "{{problem}}",
        domain: "{{domain}}",
        iterationCount: "{{iterationCount}}",
        artifactPath: "{{run-evidence-sidecar.output.artifactPath}}",
      },
    }, { x: 20, y: 1620 }),

    node("verify-solution", "action.run_agent", "Verify Solution", {
      prompt: `# Independent Evidence Verification

## Problem
{{problem}}

## Candidate Solution
{{currentDraft}}

## Evidence Summary
{{run-evidence-sidecar.output.bundle.summary}}

## Research Tool Bundle
{{run-evidence-sidecar.output.toolBundleBrief}}

## Evidence Bundle
{{run-evidence-sidecar.output.evidenceBrief}}

## Review Hints
{{run-evidence-sidecar.output.bundle.reviewHints}}

## Instructions
You are the independent verifier.
Assess whether the candidate answer is fully supported by the evidence bundle.
Check citation usage, factual consistency, unsupported leaps, and contradictions.

Return exactly one verdict:
- VERDICT: CORRECT
- VERDICT: MINOR
- VERDICT: CRITICAL

Then explain:
1. Whether the cited evidence is sufficient
2. Specific flaws or missing support
3. Whether the answer is safe to preserve as reviewed knowledge`,
      sdk: "auto",
      timeoutMs: 900000,
      failOnError: false,
    }, { x: 420, y: 1460 }),

    node("parse-verdict", "transform.llm_parse", "Parse Verdict", {
      input: "verify-solution",
      field: "output",
      patterns: {
        verdict: "VERDICT:\\s*(CORRECT|MINOR|CRITICAL)",
      },
      keywords: {
        severity: ["correct", "minor", "critical"],
      },
      outputPort: "verdict",
    }, { x: 420, y: 1620 }),

    node("revise-solution", "action.continue_session", "Revise Solution", {
      prompt: `The verifier found correctable issues in your evidence-backed answer.

## Current Draft
{{currentDraft}}

## Verifier Feedback
{{verify-solution.output}}

## Evidence Summary
{{run-evidence-sidecar.output.bundle.summary}}

## Research Tool Bundle
{{run-evidence-sidecar.output.toolBundleBrief}}

## Evidence Bundle
{{run-evidence-sidecar.output.evidenceBrief}}

## Review Hints
{{run-evidence-sidecar.output.bundle.reviewHints}}

Revise the answer to address every issue while remaining grounded in the supplied evidence.
Keep or improve inline citation keys like [E1].`,
      strategy: "refine",
      timeoutMs: 900000,
    }, { x: 420, y: 1780 }),

    node("store-revised-draft", "action.set_variable", "Store Revised Draft", {
      key: "currentDraft",
      value: "{{revise-solution.output}}",
    }, { x: 420, y: 1940 }),

    node("critical-log", "notify.log", "Critical Flaw Detected", {
      message:
        "Critical flaw detected in evidence-backed answer for {{problem}}.\n" +
        "{{verify-solution.output}}",
      level: "warn",
    }, { x: 760, y: 1780 }),

    node("store-critical-feedback", "action.set_variable", "Store Critical Feedback", {
      key: "_previousFeedback",
      value:
        "Previous answer was critically flawed. Avoid the failed path and address this feedback:\n{{verify-solution.output}}",
    }, { x: 760, y: 1940 }),

    node("build-promotion-candidate", "action.run_command", "Build Reviewed Finding", {
      command: "node",
      args: ["workflow/research-evidence-sidecar.mjs", "promote"],
      cwd: "{{repoRoot}}",
      parseJson: true,
      failOnError: false,
      timeoutMs: 120000,
      env: {
        BOSUN_RESEARCH_SIDECAR_INPUT:
          "{{({ verdict: 'correct', problem: $data.problem, domain: $data.domain, finalAnswer: $data.currentDraft, verifierOutput: $ctx.getNodeOutput('verify-solution')?.output || '', artifactPath: $ctx.getNodeOutput('run-evidence-sidecar')?.output?.artifactPath || '', evidenceMode: $data.evidenceMode, bundle: $ctx.getNodeOutput('run-evidence-sidecar')?.output?.bundle || null })}}",
      },
    }, { x: 1080, y: 1620 }),

    node("should-promote", "condition.expression", "Promote Reviewed Finding?", {
      expression:
        "Boolean($data?.promoteReviewedFindings !== false) && " +
        "$ctx.getNodeOutput('build-promotion-candidate')?.output?.promote === true",
    }, { x: 1080, y: 1780, outputs: ["yes", "no"] }),

    node("persist-reviewed-finding", "action.persist_memory", "Persist Reviewed Finding", {
      content: "{{build-promotion-candidate.output.content}}",
      scope: "{{build-promotion-candidate.output.scope}}",
      category: "{{build-promotion-candidate.output.category}}",
      scopeLevel: "workspace",
      tags: "{{build-promotion-candidate.output.tags}}",
      repoRoot: "{{repoRoot}}",
      targetFile: ".bosun/shared-knowledge/REVIEWED_RESEARCH.md",
      registryFile: ".cache/bosun/reviewed-research-memory.json",
      agentId: "research-evidence-workflow",
      agentType: "workflow",
      workspaceId: "{{workspaceId}}",
      runId: "{{runId}}",
      taskId: "{{taskId}}",
    }, { x: 1080, y: 1940 }),

    node("persist-reviewed-finding-ok", "condition.expression", "Reviewed Finding Stored?", {
      expression: "$ctx.getNodeOutput('persist-reviewed-finding')?.success === true",
    }, { x: 1080, y: 2100, outputs: ["yes", "no"] }),

    node("persist-reviewed-finding-log", "notify.log", "Reviewed Finding Stored", {
      message:
        "Stored reviewed research finding for {{problem}} at " +
        "{{persist-reviewed-finding.registryPath}}.",
      level: "info",
    }, { x: 900, y: 2260 }),

    node("persist-reviewed-finding-warning", "notify.log", "Knowledge Promotion Skipped", {
      message:
        "Reviewed finding promotion did not persist for {{problem}}.\n" +
        "Reason: {{$ctx.getNodeOutput('persist-reviewed-finding')?.reason || $ctx.getNodeOutput('persist-reviewed-finding')?.error || 'not requested'}}",
      level: "warn",
    }, { x: 1260, y: 2260 }),

    node("promotion-skip-log", "notify.log", "Promotion Not Requested", {
      message:
        "Reviewed knowledge promotion skipped for {{problem}}. " +
        "Evidence artifact remains at {{run-evidence-sidecar.output.artifactPath}}.",
      level: "info",
    }, { x: 1440, y: 1940 }),

    node("output-result", "notify.log", "Verified Research Complete", {
      message:
        "Evidence-backed research complete for {{problem}}.\n" +
        "Artifact: {{run-evidence-sidecar.output.artifactPath}}\n" +
        "Answer:\n{{currentDraft}}",
      level: "info",
    }, { x: 1080, y: 2420 }),

    node("end-success", "flow.end", "End Research (Success)", {
      status: "completed",
      message: "Evidence-backed research converged to a reviewed answer.",
      output: {
        verdict: "correct",
        problem: "{{problem}}",
        domain: "{{domain}}",
        iterationCount: "{{iterationCount}}",
        artifactPath: "{{run-evidence-sidecar.output.artifactPath}}",
        citations: "{{run-evidence-sidecar.output.bundle.citations}}",
        researchToolBundleId: "{{run-evidence-sidecar.output.researchToolBundle.id}}",
        recommendedMcpServers: "{{run-evidence-sidecar.output.researchToolBundle.recommendedServerIds}}",
      },
    }, { x: 1080, y: 2580 }),
  ],
  edges: [
    edge("trigger", "should-search"),
    edge("should-search", "literature-search", { condition: "$output?.result === true", port: "yes" }),
    edge("should-search", "run-evidence-sidecar", { condition: "$output?.result !== true", port: "no" }),
    edge("literature-search", "run-evidence-sidecar"),
    edge("run-evidence-sidecar", "evidence-ready"),
    edge("evidence-ready", "generate-solution", { condition: "$output?.result === true", port: "yes" }),
    edge("evidence-ready", "evidence-failed-log", { condition: "$output?.result !== true", port: "no" }),
    edge("evidence-failed-log", "evidence-failed-end"),
    edge("generate-solution", "store-generated-draft"),
    edge("store-generated-draft", "increment-iteration"),
    edge("increment-iteration", "iteration-budget"),
    edge("iteration-budget", "verify-solution", { condition: "$output?.result === true", port: "yes" }),
    edge("iteration-budget", "iteration-limit-log", { condition: "$output?.result !== true", port: "no" }),
    edge("iteration-limit-log", "iteration-limit-end"),
    edge("verify-solution", "parse-verdict"),
    edge("parse-verdict", "build-promotion-candidate", { port: "correct" }),
    edge("parse-verdict", "revise-solution", { port: "minor" }),
    edge("parse-verdict", "critical-log", { port: "critical" }),
    edge("revise-solution", "store-revised-draft"),
    edge("store-revised-draft", "increment-iteration", { backEdge: true, maxIterations: 50 }),
    edge("critical-log", "store-critical-feedback"),
    edge("store-critical-feedback", "generate-solution", { backEdge: true, maxIterations: 50 }),
    edge("build-promotion-candidate", "should-promote"),
    edge("should-promote", "persist-reviewed-finding", { condition: "$output?.result === true", port: "yes" }),
    edge("should-promote", "promotion-skip-log", { condition: "$output?.result !== true", port: "no" }),
    edge("persist-reviewed-finding", "persist-reviewed-finding-ok"),
    edge("persist-reviewed-finding-ok", "persist-reviewed-finding-log", { condition: "$output?.result === true", port: "yes" }),
    edge("persist-reviewed-finding-ok", "persist-reviewed-finding-warning", { condition: "$output?.result !== true", port: "no" }),
    edge("persist-reviewed-finding-log", "output-result"),
    edge("persist-reviewed-finding-warning", "output-result"),
    edge("promotion-skip-log", "output-result"),
    edge("output-result", "end-success"),
  ],
  metadata: {
    createdAt: "2026-03-31T00:00:00.000Z",
    version: 1,
    author: "bosun",
    tags: ["research", "evidence-sidecar", "verification-loop", "scientific-evidence", "research-tools"],
  },
};

export const templates = [RESEARCH_EVIDENCE_AGENT_TEMPLATE];

export default templates;
