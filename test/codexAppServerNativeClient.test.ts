import { assert } from "chai";
import {
  resolveSafeCodexNativeApprovalRequest,
  runCodexAppServerNativeTurn,
} from "../src/codexAppServer/nativeClient";
import { destroyCachedCodexAppServerProcess } from "../src/utils/codexAppServerProcess";
import { ZOTERO_MCP_SCOPE_HEADER } from "../src/agent/mcp/server";

describe("Codex app-server native client", function () {
  const originalChromeUtils = (globalThis as typeof globalThis & {
    ChromeUtils?: unknown;
  }).ChromeUtils;
  const originalToolkit = (globalThis as typeof globalThis & {
    ztoolkit?: unknown;
  }).ztoolkit;
  const originalFetch = (globalThis as typeof globalThis & {
    fetch?: typeof fetch;
  }).fetch;
  const originalCodexPath = globalThis.process?.env?.CODEX_PATH;
  const originalZotero = globalThis.Zotero;

  class MockStdout {
    private pending: Array<(value: string) => void> = [];
    private queue: string[] = [];

    readString(): Promise<string> {
      if (this.queue.length) {
        return Promise.resolve(this.queue.shift() || "");
      }
      return new Promise((resolve) => {
        this.pending.push(resolve);
      });
    }

    push(value: string) {
      const next = this.pending.shift();
      if (next) {
        next(value);
        return;
      }
      this.queue.push(value);
    }
  }

  function installMcpPreflightFetch(toolNames = ["query_library", "read_library"]) {
    (
      globalThis as typeof globalThis & { fetch: typeof fetch }
    ).fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body || "{}")) as {
        id?: string | number;
        method?: string;
      };
      if (payload.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              protocolVersion: "2025-06-18",
              serverInfo: { name: "llm-for-zotero", version: "1.0.0" },
              capabilities: { tools: {} },
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (payload.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      if (payload.method === "tools/list") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              tools: toolNames.map((name) => ({
                name,
                description: name,
                inputSchema: { type: "object" },
              })),
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response("unexpected MCP preflight request", { status: 500 });
    }) as typeof fetch;
  }

  beforeEach(function () {
    (
      globalThis as typeof globalThis & { ztoolkit: { log: () => void } }
    ).ztoolkit = { log: () => undefined };
    installMcpPreflightFetch();
  });

  afterEach(function () {
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
    (
      globalThis as typeof globalThis & { ztoolkit?: unknown }
    ).ztoolkit = originalToolkit;
    (
      globalThis as typeof globalThis & { fetch?: typeof fetch }
    ).fetch = originalFetch;
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
    destroyCachedCodexAppServerProcess("native-client-test");
    destroyCachedCodexAppServerProcess("native-client-resume-test");
  });

  it("auto-approves only Zotero read-only MCP approval prompts", function () {
    assert.deepEqual(
      resolveSafeCodexNativeApprovalRequest({
        method: "tool/requestUserInput",
        params: {
          serverName: "llm_for_zotero_profile_1234",
          toolName: "query_library",
          questions: [{ header: "Allow", question: "Use query_library?" }],
        },
      }),
      { approved: true },
    );
    assert.isNull(
      resolveSafeCodexNativeApprovalRequest({
        method: "tool/requestUserInput",
        params: {
          serverName: "llm_for_zotero_profile_1234",
          toolName: "zotero_confirm_action",
        },
      }),
    );
    assert.isNull(
      resolveSafeCodexNativeApprovalRequest({
        method: "tool/requestUserInput",
        params: {
          serverName: "unrelated_mcp",
          toolName: "query_library",
        },
      }),
    );
  });

  it("starts persistent native threads and injects legacy UI history once", async function () {
    const stdout = new MockStdout();
    const methods: string[] = [];
    let threadStartParams: Record<string, unknown> | null = null;
    let mcpServerName = "";
    let injectedItems: unknown = null;
    let turnInput: unknown = null;
    let persistedThreadId = "";
    const prefStore = new Map<string, unknown>();

    if (globalThis.process?.env) {
      globalThis.process.env.CODEX_PATH = "/mock/codex";
    }
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      ...(originalZotero || {}),
      isWin: true,
      Profile: { dir: "/tmp/zotero-native-client-profile-a" },
      Prefs: {
        get: (key: string) => {
          if (key === "httpServer.port") return 23119;
          return prefStore.get(key);
        },
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
    (
      globalThis as typeof globalThis & { ztoolkit: { log: () => void } }
    ).ztoolkit = { log: () => undefined };
    (
      globalThis as typeof globalThis & {
        ChromeUtils?: {
          importESModule: (
            path: string,
          ) => { Subprocess: { call: () => Promise<unknown> } };
        };
      }
    ).ChromeUtils = {
      importESModule: () => ({
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
                    params?: Record<string, unknown> & { input?: unknown };
                  };
                  if (!message.method || message.method === "initialized") {
                    continue;
                  }
                  methods.push(message.method);
                  if (message.method === "initialize") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "config/value/write") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "config/mcpServer/reload") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "config/read") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { mcp_servers: mcpServerName ? { [mcpServerName]: { url: "http://127.0.0.1:23119/llm-for-zotero/mcp" } } : {} } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "mcpServerStatus/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { servers: [{ name: mcpServerName, status: "ready", tools: [{ name: "query_library" }, { name: "read_library" }] }] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "skills/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { skills: [] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "plugin/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { plugins: [] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "thread/start") {
                    threadStartParams = message.params || null;
                    const config = (threadStartParams?.config || {}) as {
                      mcp_servers?: Record<string, unknown>;
                    };
                    mcpServerName = Object.keys(config.mcp_servers || {})[0] || "";
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-native-1", source: "appServer" } } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "thread/name/set") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "thread/inject_items") {
                    injectedItems = message.params?.items ?? null;
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "turn/start") {
                    turnInput = message.params?.input ?? null;
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { turn: { id: "turn-1" } } })}\n`,
                    );
                    queueMicrotask(() => {
                      stdout.push(
                        `${JSON.stringify({ method: "item/agentMessage/delta", params: { turnId: "turn-1", delta: "Hello native" } })}\n`,
                      );
                      stdout.push(
                        `${JSON.stringify({ method: "turn/completed", params: { turnId: "turn-1", status: "completed" } })}\n`,
                      );
                    });
                  }
                  if (message.method === "thread/read") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-native-1" }, turns: [{ id: "turn-1" }] } })}\n`,
                    );
                    continue;
                  }
                }
              },
            },
            kill: () => undefined,
          }),
        },
      }),
    };

    const result = await runCodexAppServerNativeTurn({
      processKey: "native-client-test",
      codexPath: "/mock/codex",
      scope: {
        conversationKey: 6_000_000_001,
        libraryID: 1,
        kind: "global",
        title: "Latest question",
      },
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "Document Context:\nImportant paper context." },
        { role: "user", content: "Earlier question." },
        { role: "assistant", content: "Earlier answer." },
        { role: "user", content: "Latest question." },
      ],
      hooks: {
        loadProviderSessionId: async () => undefined,
        persistProviderSessionId: async (threadId) => {
          persistedThreadId = threadId;
        },
      },
    });

    assert.equal(result.text, "Hello native");
    assert.equal(result.threadId, "thread-native-1");
    assert.equal(persistedThreadId, "thread-native-1");
    assert.includeMembers(methods, [
      "initialize",
      "thread/start",
      "thread/name/set",
      "mcpServerStatus/list",
      "thread/inject_items",
      "turn/start",
      "thread/read",
    ]);
    assert.notInclude(methods, "config/value/write");
    assert.notInclude(methods, "config/mcpServer/reload");
    assert.equal(threadStartParams?.ephemeral, false);
    assert.equal(threadStartParams?.persistExtendedHistory, true);
    assert.equal(threadStartParams?.serviceName, "llm_for_zotero");
    assert.notProperty(threadStartParams || {}, "dynamicTools");
    assert.isString(threadStartParams?.developerInstructions);
    assert.include(
      String(threadStartParams?.developerInstructions || ""),
      "Zotero environment for this turn",
    );
    assert.include(
      String(threadStartParams?.developerInstructions || ""),
      "Important paper context.",
    );
    assert.include(
      String(threadStartParams?.developerInstructions || ""),
      "Do not inspect local Zotero profile folders",
    );
    const threadConfig = threadStartParams?.config as Record<string, any>;
    assert.deepEqual(threadConfig.features, { shell_tool: false });
    const servers = threadConfig.mcp_servers as Record<string, any>;
    assert.lengthOf(Object.keys(servers), 1);
    assert.match(Object.keys(servers)[0], /^llm_for_zotero_profile_/);
    const serverConfig = servers[Object.keys(servers)[0]];
    assert.equal(serverConfig.required, true);
    assert.equal(
      serverConfig.url,
      "http://127.0.0.1:23119/llm-for-zotero/mcp",
    );
    assert.include(serverConfig.http_headers.Authorization, "Bearer ");
    assert.isString(serverConfig.http_headers[ZOTERO_MCP_SCOPE_HEADER]);
    assert.include(serverConfig.enabled_tools, "query_library");
    assert.include(serverConfig.enabled_tools, "read_library");
    assert.deepEqual(injectedItems, [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Earlier question." }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Earlier answer." }],
      },
    ]);
    assert.isArray(turnInput);
    const textInput = (turnInput as Array<Record<string, unknown>>).find(
      (part) => part.type === "text",
    );
    assert.equal(String(textInput?.text || ""), "Latest question.");
    assert.notInclude(
      String(textInput?.text || ""),
      "Zotero context for this turn",
    );
    assert.notInclude(
      String(textInput?.text || ""),
      "Zotero environment for this turn",
    );
    assert.equal(result.diagnostics?.mcpReady, true);
    assert.equal(result.diagnostics?.historyVerified, true);
    assert.equal(result.diagnostics?.mcpServerName, Object.keys(servers)[0]);
  });

  it("resumes stored native threads without reinjecting mirrored history", async function () {
    const stdout = new MockStdout();
    const methods: string[] = [];
    let resumeParams: Record<string, unknown> | null = null;
    let mcpServerName = "";
    let turnInput: unknown = null;
    let injectCalled = false;
    const prefStore = new Map<string, unknown>();

    if (globalThis.process?.env) {
      globalThis.process.env.CODEX_PATH = "/mock/codex";
    }
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      ...(originalZotero || {}),
      isWin: true,
      Profile: { dir: "/tmp/zotero-native-client-profile-b" },
      Prefs: {
        get: (key: string) => {
          if (key === "httpServer.port") return 23119;
          return prefStore.get(key);
        },
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
    (
      globalThis as typeof globalThis & {
        ChromeUtils?: {
          importESModule: (
            path: string,
          ) => { Subprocess: { call: () => Promise<unknown> } };
        };
      }
    ).ChromeUtils = {
      importESModule: () => ({
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
                    params?: Record<string, unknown> & { input?: unknown };
                  };
                  if (!message.method || message.method === "initialized") {
                    continue;
                  }
                  methods.push(message.method);
                  if (message.method === "initialize") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "config/value/write") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "config/mcpServer/reload") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "config/read") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { mcp_servers: mcpServerName ? { [mcpServerName]: { url: "http://127.0.0.1:23119/llm-for-zotero/mcp" } } : {} } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "mcpServerStatus/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { servers: [{ name: mcpServerName, status: "ready", tools: [{ name: "query_library" }, { name: "read_library" }] }] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "skills/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { skills: [] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "plugin/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { plugins: [] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "thread/resume") {
                    resumeParams = message.params || null;
                    const config = (resumeParams?.config || {}) as {
                      mcp_servers?: Record<string, unknown>;
                    };
                    mcpServerName = Object.keys(config.mcp_servers || {})[0] || "";
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-native-1", source: "appServer" } } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "thread/inject_items") {
                    injectCalled = true;
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "turn/start") {
                    turnInput = message.params?.input ?? null;
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { turn: { id: "turn-2" } } })}\n`,
                    );
                    queueMicrotask(() => {
                      stdout.push(
                        `${JSON.stringify({ method: "item/agentMessage/delta", params: { turnId: "turn-2", delta: "Resumed" } })}\n`,
                      );
                      stdout.push(
                        `${JSON.stringify({ method: "turn/completed", params: { turnId: "turn-2", status: "completed" } })}\n`,
                      );
                    });
                  }
                  if (message.method === "thread/read") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-native-1" }, turns: [{ id: "turn-2" }] } })}\n`,
                    );
                    continue;
                  }
                }
              },
            },
            kill: () => undefined,
          }),
        },
      }),
    };

    const result = await runCodexAppServerNativeTurn({
      processKey: "native-client-resume-test",
      codexPath: "/mock/codex",
      scope: {
        conversationKey: 6_000_000_001,
        libraryID: 1,
        kind: "global",
      },
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "Document Context:\nFresh context." },
        { role: "user", content: "Earlier question." },
        { role: "assistant", content: "Earlier answer." },
        { role: "user", content: "Follow-up question." },
      ],
      hooks: {
        loadProviderSessionId: async () => "thread-native-1",
        persistProviderSessionId: async () => {
          assert.fail("resume should not persist a new thread id");
        },
      },
    });

    assert.equal(result.text, "Resumed");
    assert.equal(result.resumed, true);
    assert.equal(resumeParams?.threadId, "thread-native-1");
    assert.equal(resumeParams?.model, "gpt-5.4");
    assert.equal(resumeParams?.persistExtendedHistory, true);
    assert.notProperty(resumeParams || {}, "serviceName");
    assert.isString(resumeParams?.developerInstructions);
    assert.include(
      String(resumeParams?.developerInstructions || ""),
      "Zotero environment for this turn",
    );
    assert.include(
      String(resumeParams?.developerInstructions || ""),
      "Fresh context.",
    );
    const resumeConfig = resumeParams?.config as Record<string, any>;
    assert.deepEqual(resumeConfig.features, { shell_tool: false });
    const servers = resumeConfig.mcp_servers as Record<string, any>;
    assert.lengthOf(Object.keys(servers), 1);
    assert.equal(servers[Object.keys(servers)[0]].required, true);
    assert.includeMembers(methods, [
      "initialize",
      "thread/resume",
      "mcpServerStatus/list",
      "turn/start",
      "thread/read",
    ]);
    assert.notInclude(methods, "config/value/write");
    assert.notInclude(methods, "config/mcpServer/reload");
    assert.notInclude(methods, "thread/start");
    assert.isFalse(injectCalled);
    const textInput = (turnInput as Array<Record<string, unknown>>).find(
      (part) => part.type === "text",
    );
    const text = String(textInput?.text || "");
    assert.equal(text, "Follow-up question.");
    assert.notInclude(text, "Zotero environment for this turn");
    assert.notInclude(text, "Fresh context.");
    assert.notInclude(text, "Earlier question.");
    assert.equal(result.diagnostics?.historyVerified, true);
  });

  it("aborts native turns before model generation when required MCP tools are missing", async function () {
    const stdout = new MockStdout();
    const methods: string[] = [];
    let mcpServerName = "";
    const prefStore = new Map<string, unknown>();
    installMcpPreflightFetch(["query_library"]);

    if (globalThis.process?.env) {
      globalThis.process.env.CODEX_PATH = "/mock/codex";
    }
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      ...(originalZotero || {}),
      isWin: true,
      Profile: { dir: "/tmp/zotero-native-client-profile-missing-mcp" },
      Prefs: {
        get: (key: string) => {
          if (key === "httpServer.port") return 23119;
          return prefStore.get(key);
        },
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
    (
      globalThis as typeof globalThis & {
        ChromeUtils?: {
          importESModule: (
            path: string,
          ) => { Subprocess: { call: () => Promise<unknown> } };
        };
      }
    ).ChromeUtils = {
      importESModule: () => ({
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
                    params?: Record<string, unknown>;
                  };
                  if (!message.method || message.method === "initialized") {
                    continue;
                  }
                  methods.push(message.method);
                  if (message.method === "initialize") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "thread/start") {
                    const config = (message.params?.config || {}) as {
                      mcp_servers?: Record<string, unknown>;
                    };
                    mcpServerName = Object.keys(config.mcp_servers || {})[0] || "";
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-native-missing", source: "appServer" } } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "thread/name/set") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "config/read") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { mcp_servers: { [mcpServerName]: { url: "http://127.0.0.1:23119/llm-for-zotero/mcp" } } } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "mcpServerStatus/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { servers: [{ name: mcpServerName, status: "ready", tools: [{ name: "query_library" }] }] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "skills/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { skills: [] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "plugin/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { plugins: [] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "turn/start") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, error: { code: -32000, message: "turn/start should not run" } })}\n`,
                    );
                    continue;
                  }
                  throw new Error(`unexpected method ${message.method}`);
                }
              },
            },
            kill: () => undefined,
          }),
        },
      }),
    };

    let errorMessage = "";
    try {
      await runCodexAppServerNativeTurn({
        processKey: "native-client-missing-mcp-test",
        codexPath: "/mock/codex",
        scope: {
          conversationKey: 6_000_000_002,
          libraryID: 1,
          kind: "global",
          title: "Count papers",
        },
        model: "gpt-5.4",
        messages: [{ role: "user", content: "How many papers?" }],
        hooks: {
          loadProviderSessionId: async () => undefined,
          persistProviderSessionId: async () => undefined,
        },
      });
      assert.fail("expected missing MCP tools to abort the turn");
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      destroyCachedCodexAppServerProcess("native-client-missing-mcp-test");
    }

    assert.include(errorMessage, "Zotero MCP setup failed");
    assert.include(errorMessage, "missing required tools: read_library");
    assert.notInclude(methods, "turn/start");
  });
});
