import { assert } from "chai";
import {
  installOrUpdateCodexZoteroMcpConfig,
  readCodexNativeMcpSetupStatus,
} from "../src/codexAppServer/mcpSetup";
import type { CodexAppServerProcess } from "../src/utils/codexAppServerProcess";

describe("Codex app-server MCP setup", function () {
  const originalZotero = globalThis.Zotero;
  const originalToolkit = (globalThis as typeof globalThis & { ztoolkit?: any })
    .ztoolkit;
  const prefStore = new Map<string, unknown>();

  beforeEach(function () {
    prefStore.clear();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: (key: string) => {
          if (key === "httpServer.port") return 24680;
          return prefStore.get(key);
        },
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as unknown as typeof Zotero;
    (
      globalThis as typeof globalThis & { ztoolkit: { log: () => void } }
    ).ztoolkit = {
      log: () => {},
    };
  });

  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
  });

  it("writes the Zotero MCP server config and reloads Codex MCP servers", async function () {
    const calls: Array<{ method: string; params: unknown }> = [];
    const proc = {
      sendRequest: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        if (method === "config/value/write") return {};
        if (method === "config/mcpServer/reload") return {};
        if (method === "config/read") {
          return {
            mcp_servers: {
              llm_for_zotero: {
                url: "http://127.0.0.1:24680/llm-for-zotero/mcp",
              },
            },
          };
        }
        if (method === "mcpServerStatus/list") {
          return {
            servers: [
              {
                name: "llm_for_zotero",
                status: "ready",
                tools: [{ name: "query_library" }],
              },
            ],
          };
        }
        if (method === "skills/list") return { skills: [] };
        if (method === "plugin/list") return { plugins: [] };
        throw new Error(`unexpected method ${method}`);
      },
    } as unknown as CodexAppServerProcess;

    const status = await installOrUpdateCodexZoteroMcpConfig({ proc });

    const writeCall = calls.find(
      (call) => call.method === "config/value/write",
    );
    assert.isOk(writeCall);
    assert.deepInclude(writeCall?.params as Record<string, unknown>, {
      keyPath: "mcp_servers.llm_for_zotero",
      mergeStrategy: "upsert",
    });
    const value = (writeCall?.params as { value?: Record<string, unknown> })
      .value;
    assert.equal(value?.url, "http://127.0.0.1:24680/llm-for-zotero/mcp");
    assert.deepEqual(value?.enabled_tools, [
      "query_library",
      "read_library",
      "read_paper",
      "search_paper",
      "search_literature_online",
      "read_attachment",
      "view_pdf_pages",
      "zotero_confirm_action",
    ]);
    assert.deepEqual(value?.http_headers, {
      Authorization: `Bearer ${prefStore.get(
        "extensions.zotero.llmforzotero.codexZoteroMcpBearerToken",
      )}`,
    });
    assert.include(
      calls.map((call) => call.method),
      "config/mcpServer/reload",
    );
    assert.equal(status.configured, true);
    assert.equal(status.connected, true);
    assert.deepEqual(status.toolNames, ["query_library"]);
  });

  it("falls back to legacy config write shapes when dotted keyPath is unsupported", async function () {
    const calls: Array<{ method: string; params: unknown }> = [];
    const proc = {
      sendRequest: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        if (method === "config/value/write") {
          const record = params as Record<string, unknown>;
          if (record.key === "mcp_servers.llm_for_zotero") return {};
          throw new Error("legacy server does not support dotted keyPath");
        }
        if (method === "config/mcpServer/reload") return {};
        if (method === "config/read") {
          return {
            mcp_servers: {
              llm_for_zotero: {
                url: "http://127.0.0.1:24680/llm-for-zotero/mcp",
              },
            },
          };
        }
        if (method === "mcpServerStatus/list") {
          return {
            servers: [
              {
                name: "llm_for_zotero",
                status: "ready",
                tools: [{ name: "query_library" }],
              },
            ],
          };
        }
        if (method === "skills/list") return { skills: [] };
        if (method === "plugin/list") return { plugins: [] };
        throw new Error(`unexpected method ${method}`);
      },
    } as unknown as CodexAppServerProcess;

    const status = await installOrUpdateCodexZoteroMcpConfig({ proc });

    const writeCalls = calls.filter(
      (call) => call.method === "config/value/write",
    );
    assert.deepEqual(
      writeCalls.map((call) => Object.keys(call.params as Record<string, unknown>)[0]),
      ["keyPath", "keyPath", "keyPath", "key"],
    );
    assert.equal(status.configured, true);
  });

  it("reports setup status without requiring config write", async function () {
    const proc = {
      sendRequest: async (method: string) => {
        if (method === "config/read") {
          return {
            mcp_servers: {
              llm_for_zotero: {
                url: "http://127.0.0.1:24680/llm-for-zotero/mcp",
              },
            },
          };
        }
        if (method === "mcpServerStatus/list") {
          return {
            servers: [
              {
                name: "llm_for_zotero",
                status: "ready",
                tools: [
                  { name: "query_library" },
                  { name: "not_a_zotero_tool" },
                ],
              },
            ],
          };
        }
        if (method === "skills/list") return { skills: [{ name: "skill-a" }] };
        if (method === "plugin/list") return { plugins: [] };
        throw new Error(`unexpected method ${method}`);
      },
    } as unknown as CodexAppServerProcess;

    const status = await readCodexNativeMcpSetupStatus({ proc });

    assert.equal(status.configured, true);
    assert.equal(status.connected, true);
    assert.deepEqual(status.toolNames, ["query_library"]);
    assert.deepEqual(status.errors, []);
  });
});
