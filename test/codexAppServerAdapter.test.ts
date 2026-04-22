import { assert } from "chai";
import {
  CodexAppServerAdapter,
  shouldResetCodexAppServerThreadOnError,
} from "../src/agent/model/codexAppServer";
import type { AgentRuntimeRequest } from "../src/agent/types";
import { destroyCachedCodexAppServerProcess } from "../src/utils/codexAppServerProcess";

class MockStdout {
  private queue: string[] = [];
  private resolvers: Array<(chunk: string) => void> = [];

  readString(): Promise<string> {
    if (this.queue.length) {
      return Promise.resolve(this.queue.shift() || "");
    }
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  push(chunk: string): void {
    const resolve = this.resolvers.shift();
    if (resolve) {
      resolve(chunk);
      return;
    }
    this.queue.push(chunk);
  }
}

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

  it("advertises tool-calling support for agent runtime requests", function () {
    const adapter = new CodexAppServerAdapter("codex_app_server");
    const request = makeRequest();

    assert.isTrue(adapter.supportsTools(request));
    assert.isTrue(adapter.getCapabilities(request).toolCalls);
  });

  it("advertises multimodal support for non-text-only models", function () {
    const adapter = new CodexAppServerAdapter("codex_app_server");
    const request = makeRequest();

    assert.isTrue(adapter.getCapabilities(request).multimodal);
    assert.isTrue(adapter.getCapabilities(request).reasoning);
  });

  it("keeps thread state for recoverable adapter errors", function () {
    assert.isFalse(
      shouldResetCodexAppServerThreadOnError(
        new Error("Turn ended with status: failed"),
      ),
    );
  });

  it("resets thread state when the app-server session becomes unusable", function () {
    const abortError = new Error("Aborted");
    (abortError as Error & { name?: string }).name = "AbortError";
    assert.isTrue(shouldResetCodexAppServerThreadOnError(abortError));
    assert.isTrue(
      shouldResetCodexAppServerThreadOnError(
        new Error(
          "Timed out waiting for codex app-server turn completion after 60000ms",
        ),
      ),
    );
    assert.isTrue(
      shouldResetCodexAppServerThreadOnError(
        new Error("codex app-server process closed unexpectedly"),
      ),
    );
  });

  it("forwards app-server reasoning events into the shared reasoning callback", async function () {
    const originalChromeUtils = (globalThis as typeof globalThis & {
      ChromeUtils?: unknown;
    }).ChromeUtils;
    const originalCodexPath = globalThis.process?.env?.CODEX_PATH;
    const stdout = new MockStdout();
    const processKey = "codex_app_server_reasoning_test";

    try {
      if (globalThis.process?.env) {
        globalThis.process.env.CODEX_PATH = "/mock/codex";
      }

      (
        globalThis as typeof globalThis & {
          ChromeUtils?: {
            importESModule: (
              path: string,
            ) => { Subprocess: { call: () => Promise<unknown> } };
          };
        }
      ).ChromeUtils = {
        importESModule: (path: string) => {
          assert.include(path, "Subprocess");
          return {
            Subprocess: {
              call: async () => ({
                stdout,
                stdin: {
                  write: (chunk: string) => {
                    for (const line of chunk.split("\n")) {
                      if (!line.trim()) continue;
                      const message = JSON.parse(line) as {
                        id?: number;
                        method?: string;
                      };
                      if (message.method === "initialize") {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: {} })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "thread/start") {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: { id: "thread-1" } })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "turn/start") {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: { id: "turn-1" } })}\n`,
                        );
                        setTimeout(() => {
                          stdout.push(
                            `${JSON.stringify({ method: "item/reasoning/summaryTextDelta", params: { itemId: "reasoning-1", delta: "Reviewing the request." } })}\n`,
                          );
                          stdout.push(
                            `${JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "Done." } })}\n`,
                          );
                          stdout.push(
                            `${JSON.stringify({ method: "turn/completed", params: { turnId: "turn-1", status: "completed" } })}\n`,
                          );
                        }, 0);
                      }
                    }
                  },
                },
                kill: () => undefined,
              }),
            },
          };
        },
      };

      const adapter = new CodexAppServerAdapter(processKey);
      const reasoning: string[] = [];
      const chunks: string[] = [];
      const step = await adapter.runStep({
        request: makeRequest(),
        messages: [{ role: "user", content: "Summarize this note." }],
        tools: [],
        onTextDelta: async (delta) => {
          chunks.push(delta);
        },
        onReasoning: async (event) => {
          if (event.summary) {
            reasoning.push(event.summary);
          }
        },
      });

      assert.equal(step.kind, "final");
      assert.equal(step.text, "Done.");
      assert.deepEqual(chunks, ["Done."]);
      assert.deepEqual(reasoning, ["Reviewing the request."]);
    } finally {
      destroyCachedCodexAppServerProcess(processKey);
      if (globalThis.process?.env) {
        if (typeof originalCodexPath === "string") {
          globalThis.process.env.CODEX_PATH = originalCodexPath;
        } else {
          delete globalThis.process.env.CODEX_PATH;
        }
      }
      (
        globalThis as typeof globalThis & { ChromeUtils?: unknown }
      ).ChromeUtils = originalChromeUtils;
    }
  });

  it("forwards app-server token deltas into the shared usage callback", async function () {
    const originalChromeUtils = (globalThis as typeof globalThis & {
      ChromeUtils?: unknown;
    }).ChromeUtils;
    const originalCodexPath = globalThis.process?.env?.CODEX_PATH;
    const stdout = new MockStdout();
    const processKey = "codex_app_server_usage_test";

    try {
      if (globalThis.process?.env) {
        globalThis.process.env.CODEX_PATH = "/mock/codex";
      }

      (
        globalThis as typeof globalThis & {
          ChromeUtils?: {
            importESModule: (
              path: string,
            ) => { Subprocess: { call: () => Promise<unknown> } };
          };
        }
      ).ChromeUtils = {
        importESModule: (path: string) => {
          assert.include(path, "Subprocess");
          return {
            Subprocess: {
              call: async () => ({
                stdout,
                stdin: {
                  write: (chunk: string) => {
                    for (const line of chunk.split("\n")) {
                      if (!line.trim()) continue;
                      const message = JSON.parse(line) as {
                        id?: number;
                        method?: string;
                      };
                      if (message.method === "initialize") {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: {} })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "thread/start") {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: { id: "thread-1" } })}\n`,
                        );
                        continue;
                      }
                      if (message.method === "turn/start") {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: { id: "turn-1" } })}\n`,
                        );
                        setTimeout(() => {
                          stdout.push(
                            `${JSON.stringify({ method: "thread/tokenUsage/updated", params: { tokenUsage: { last: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } } } })}\n`,
                          );
                          stdout.push(
                            `${JSON.stringify({ method: "thread/tokenUsage/updated", params: { tokenUsage: { last: { inputTokens: 10, outputTokens: 6, totalTokens: 16 } } } })}\n`,
                          );
                          stdout.push(
                            `${JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "Done." } })}\n`,
                          );
                          stdout.push(
                            `${JSON.stringify({ method: "turn/completed", params: { turnId: "turn-1", status: "completed" } })}\n`,
                          );
                        }, 0);
                      }
                    }
                  },
                },
                kill: () => undefined,
              }),
            },
          };
        },
      };

      const adapter = new CodexAppServerAdapter(processKey);
      const usage: Array<{
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      }> = [];
      const step = await adapter.runStep({
        request: makeRequest(),
        messages: [{ role: "user", content: "Summarize this note." }],
        tools: [],
        onUsage: async (event) => {
          usage.push(event);
        },
      });

      assert.equal(step.kind, "final");
      assert.equal(step.text, "Done.");
      assert.deepEqual(usage, [
        {
          promptTokens: 10,
          completionTokens: 4,
          totalTokens: 14,
        },
        {
          promptTokens: 0,
          completionTokens: 2,
          totalTokens: 2,
        },
      ]);
    } finally {
      destroyCachedCodexAppServerProcess(processKey);
      if (globalThis.process?.env) {
        if (typeof originalCodexPath === "string") {
          globalThis.process.env.CODEX_PATH = originalCodexPath;
        } else {
          delete globalThis.process.env.CODEX_PATH;
        }
      }
      (
        globalThis as typeof globalThis & { ChromeUtils?: unknown }
      ).ChromeUtils = originalChromeUtils;
    }
  });
});
