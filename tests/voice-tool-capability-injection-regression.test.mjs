import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("voice tool capability injection regressions", () => {
  it("injects runtime tool capability prompt into /api/voice/token instructions", () => {
    const source = readFileSync(resolve(process.cwd(), "server/ui-server.mjs"), "utf8");
    expect(source).toContain("buildVoiceToolCapabilityPrompt");
    expect(source).toContain("voiceToolCapabilityPrompt: capabilityPrompt");
    // SDK mode should use full resolved instructions from createEphemeralToken
    expect(source).toContain("tokenData.instructions");
    expect(source).toContain("Available tools JSON (name + input schema):");
  });

  it("keeps voice built-in tool id mapping aligned to runtime tools", () => {
    const source = readFileSync(resolve(process.cwd(), "server/ui-server.mjs"), "utf8");
    expect(source).toContain('"run-command": ["run_command", "run_workspace_command", "bosun_slash_command"]');
    expect(source).toContain('"delegate-task": ["delegate_to_agent", "ask_agent_context", "poll_background_session", "set_agent_mode"]');
    expect(source).toContain('"vision-analysis": ["query_live_view"]');
  });

  it("does not strict-allowlist voice runtime tools from builtin ids alone", () => {
    const source = readFileSync(resolve(process.cwd(), "server/ui-server.mjs"), "utf8");
    expect(source).toContain("const hasRuntimeAllowlist = Boolean(");
    expect(source).toContain("if (enabledNames && enabledNames.size > 0 && hasRuntimeAllowlist)");
  });

  it("preserves voice-agent context fields in session-scoped instructions", () => {
    const source = readFileSync(resolve(process.cwd(), "voice/voice-relay.mjs"), "utf8");
    expect(source).toContain("voiceToolCapabilityPrompt");
    expect(source).toContain("voiceAgentInstructions");
    expect(source).toContain("Active voice agent id:");
  });

  it("injects tool capability contracts for primary and workflow agents", () => {
    const primary = readFileSync(resolve(process.cwd(), "agent/primary-agent.mjs"), "utf8");
    const orchestrator = readFileSync(resolve(process.cwd(), "agent/tool-orchestrator.mjs"), "utf8");
    const workflow = readFileSync(resolve(process.cwd(), "workflow/workflow-nodes/definitions.mjs"), "utf8");
    expect(primary).toContain("buildToolCapabilityContract");
    expect(primary).toContain("buildPrimaryToolCapabilityContract");
    expect(orchestrator).toContain("## Tool Capability Contract");
    expect(orchestrator).toContain("Enabled tools JSON:");
    expect(workflow).toContain("buildWorkflowAgentToolContract");
    expect(workflow).toContain("## Tool Capability Contract");
    expect(workflow).toContain("prefer targeted read/view calls with explicit line ranges");
    expect(workflow).toContain("retry as separate single-purpose commands");
  });
});
