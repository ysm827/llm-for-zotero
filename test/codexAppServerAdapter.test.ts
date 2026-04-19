import { assert } from "chai";
import { CodexAppServerAdapter } from "../src/agent/model/codexAppServer";
import type { AgentRuntimeRequest } from "../src/agent/types";

describe("CodexAppServerAdapter", function () {
  function makeRequest(
    overrides: Partial<AgentRuntimeRequest> = {},
  ): AgentRuntimeRequest {
    return {
      conversationKey: 1,
      mode: "agent",
      userText: "test",
      model: "gpt-5.4",
      apiBase: "https://chatgpt.com/backend-api/codex/responses",
      authMode: "codex_app_server",
      ...overrides,
    };
  }

  it("enters the agent runtime without advertising plugin tool calls", function () {
    const adapter = new CodexAppServerAdapter("codex_app_server");
    const request = makeRequest();

    assert.isTrue(adapter.supportsTools(request));
    assert.isFalse(adapter.getCapabilities(request).toolCalls);
  });
});
