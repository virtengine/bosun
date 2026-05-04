import { describe, expect, it } from "vitest";

import { buildChatTurnGroups } from "../ui/modules/chat-turn-groups.js";

describe("chat turn grouping", () => {
  it("collapses older completed turns and preserves hidden trace counts", () => {
    const groups = buildChatTurnGroups([
      {
        id: "user-1",
        role: "user",
        content: "Review the provider session flow.",
        turnIndex: 0,
      },
      {
        id: "tool-1",
        type: "tool_call",
        content: 'rg -n "messageHistory" agent/provider-session.mjs',
        turnIndex: 0,
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "I found the continuation history path.",
        turnIndex: 0,
      },
      {
        id: "user-2",
        role: "user",
        content: "Apply the fix.",
        turnIndex: 1,
      },
      {
        id: "assistant-2",
        role: "assistant",
        content: "Implementing the patch now.",
        turnIndex: 1,
      },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      turnIndex: 0,
      collapsedByDefault: true,
      collapsedLabel: "3 previous messages",
      hiddenToolCount: 1,
      hiddenTraceCount: 1,
      contextShredded: true,
    });
    expect(groups[0].preview).toEqual([
      expect.objectContaining({ role: "user", text: "Review the provider session flow." }),
      expect.objectContaining({ role: "assistant", text: "I found the continuation history path." }),
    ]);
    expect(groups[1]).toMatchObject({
      turnIndex: 1,
      collapsedByDefault: false,
      isLatest: true,
    });
  });
});
