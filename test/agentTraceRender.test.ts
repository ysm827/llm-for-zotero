import { assert } from "chai";
import { buildAgentTraceDisplayItems } from "../src/modules/contextPanel/agentTrace/render";
import type { AgentRunEventRecord } from "../src/agent/types";

describe("agentTrace render", function () {
  it("preserves whitespace when compacting reasoning deltas", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          details: "Let me ",
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          details: "read the paper first.",
        },
        createdAt: 2,
      },
    ];

    const items = buildAgentTraceDisplayItems(events, null);
    const reasoningItem = items.find(
      (item) => item.type === "reasoning",
    );

    assert.deepInclude(reasoningItem, {
      type: "reasoning",
      details: "Let me read the paper first.",
    });
  });
});
