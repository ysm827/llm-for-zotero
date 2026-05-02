import { assert } from "chai";
import {
  addZoteroMcpToolActivityObserver,
  getOrCreateZoteroMcpBearerToken,
  getZoteroMcpServerUrl,
  registerScopedZoteroMcpScope,
  registerMcpServer,
  setActiveZoteroMcpScope,
  unregisterMcpServer,
  ZOTERO_MCP_ENDPOINT_PATH,
  ZOTERO_MCP_SCOPE_HEADER,
} from "../src/agent/mcp/server";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import type { AgentToolContext, AgentToolDefinition } from "../src/agent/types";

type EndpointReply = [number, string, string];

function createReadTool(name: string): AgentToolDefinition<unknown, unknown> {
  return {
    spec: {
      name,
      description: `Read tool ${name}`,
      inputSchema: { type: "object", additionalProperties: true },
      mutability: "read",
      requiresConfirmation: false,
    },
    validate: (args) => ({ ok: true, value: args ?? {} }),
    execute: async (input) => ({ name, input }),
  };
}

function createWriteTool(name: string): AgentToolDefinition<unknown, unknown> {
  return {
    spec: {
      name,
      description: `Write tool ${name}`,
      inputSchema: { type: "object", additionalProperties: true },
      mutability: "write",
      requiresConfirmation: true,
    },
    validate: (args) => ({ ok: true, value: args ?? {} }),
    execute: async () => ({ ok: true }),
  };
}

async function invokeMcpEndpoint(params: {
  body: Record<string, unknown>;
  token?: string;
  headers?: Record<string, string>;
}): Promise<EndpointReply> {
  const EndpointClass = (
    globalThis.Zotero.Server.Endpoints as Record<string, any>
  )[ZOTERO_MCP_ENDPOINT_PATH];
  assert.isFunction(EndpointClass);
  const endpoint = new EndpointClass();
  return endpoint.init({
    method: "POST",
    data: params.body,
    headers: {
      ...(params.token ? { Authorization: `Bearer ${params.token}` } : {}),
      ...(params.headers || {}),
    },
  });
}

describe("Zotero MCP server", function () {
  const originalZotero = globalThis.Zotero;
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
      Libraries: {
        userLibraryID: 1,
      },
      Items: {
        get: () => null,
      },
      Server: {
        Endpoints: {},
      },
    } as unknown as typeof Zotero;
  });

  afterEach(function () {
    unregisterMcpServer();
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("uses Zotero's configured HTTP port and rejects unauthenticated calls", async function () {
    const registry = new AgentToolRegistry();
    registry.register(createReadTool("query_library"));
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });

    assert.equal(
      getZoteroMcpServerUrl(),
      "http://127.0.0.1:24680/llm-for-zotero/mcp",
    );

    const unauthorized = await invokeMcpEndpoint({
      body: { jsonrpc: "2.0", id: 1, method: "initialize" },
    });
    assert.equal(unauthorized[0], 401);

    const token = getOrCreateZoteroMcpBearerToken();
    const authorized = await invokeMcpEndpoint({
      token,
      body: { jsonrpc: "2.0", id: 2, method: "initialize" },
    });
    assert.equal(authorized[0], 200);
    const payload = JSON.parse(authorized[2]);
    assert.equal(payload.result.serverInfo.name, "llm-for-zotero");
    assert.equal(payload.result.protocolVersion, "2025-06-18");
  });

  it("lists only curated read tools plus the confirmation tool", async function () {
    const registry = new AgentToolRegistry();
    registry.register(createReadTool("query_library"));
    registry.register(createWriteTool("apply_tags"));
    registry.register(createReadTool("not_curated_read_tool"));
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });

    const response = await invokeMcpEndpoint({
      token: getOrCreateZoteroMcpBearerToken(),
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    const payload = JSON.parse(response[2]);
    const names = payload.result.tools.map(
      (tool: { name: string }) => tool.name,
    );
    assert.deepEqual(names.sort(), ["query_library", "zotero_confirm_action"]);
    const queryTool = payload.result.tools.find(
      (tool: { name: string }) => tool.name === "query_library",
    );
    assert.deepEqual(queryTool.annotations, {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    });
    assert.equal(queryTool.inputSchema.properties.libraryID.type, "number");
    assert.equal(queryTool.inputSchema.properties.activeItemId.type, "number");
    assert.equal(
      queryTool.inputSchema.properties.activeContextItemId.type,
      "number",
    );
    const confirmTool = payload.result.tools.find(
      (tool: { name: string }) => tool.name === "zotero_confirm_action",
    );
    assert.deepEqual(confirmTool.annotations, {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    });
  });

  it("accepts the MCP initialized notification without a JSON-RPC response", async function () {
    const registry = new AgentToolRegistry();
    registry.register(createReadTool("query_library"));
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });

    const response = await invokeMcpEndpoint({
      token: getOrCreateZoteroMcpBearerToken(),
      body: {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
    });

    assert.equal(response[0], 202);
    assert.equal(response[2], "");
  });

  it("executes curated read tools through the tool registry", async function () {
    const registry = new AgentToolRegistry();
    registry.register(createReadTool("query_library"));
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });

    const response = await invokeMcpEndpoint({
      token: getOrCreateZoteroMcpBearerToken(),
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "query_library",
          arguments: { entity: "items" },
        },
      },
    });
    const payload = JSON.parse(response[2]);
    const content = JSON.parse(payload.result.content[0].text);
    assert.equal(content.ok, true);
    assert.deepEqual(content.result, {
      name: "query_library",
      input: { entity: "items" },
    });
  });

  it("emits exact MCP tool activity for native Codex trace fallback", async function () {
    const registry = new AgentToolRegistry();
    registry.register(createReadTool("read_library"));
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });
    const scoped = registerScopedZoteroMcpScope(
      {
        profileSignature: "profile-dev",
        conversationKey: 789,
        libraryID: 7,
        kind: "paper",
        activeItemId: 77,
      },
      { token: "activity-scope-token" },
    );
    const events: Array<{
      requestId: string;
      phase: "started" | "completed";
      toolName: string;
      arguments?: unknown;
      conversationKey?: number;
      libraryID?: number;
    }> = [];
    const unregister = addZoteroMcpToolActivityObserver((event) => {
      events.push(event);
    });

    try {
      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
        body: {
          jsonrpc: "2.0",
          id: "tool-call-1",
          method: "tools/call",
          params: {
            name: "read_library",
            arguments: { sections: ["metadata"], libraryID: 999 },
          },
        },
      });
      assert.equal(response[0], 200);
    } finally {
      unregister();
      scoped.clear();
    }

    assert.deepEqual(
      events.map((event) => ({
        requestId: event.requestId,
        phase: event.phase,
        toolName: event.toolName,
        arguments: event.arguments,
        conversationKey: event.conversationKey,
        libraryID: event.libraryID,
      })),
      [
        {
          requestId: "jsonrpc:tool-call-1",
          phase: "started",
          toolName: "read_library",
          arguments: { sections: ["metadata"] },
          conversationKey: 789,
          libraryID: 7,
        },
        {
          requestId: "jsonrpc:tool-call-1",
          phase: "completed",
          toolName: "read_library",
          arguments: { sections: ["metadata"] },
          conversationKey: 789,
          libraryID: 7,
        },
      ],
    );
  });

  it("uses explicit MCP scope args as context defaults without passing them to validators", async function () {
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "query_library",
        description: "Query library",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "read",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      execute: async (input, context: AgentToolContext) => ({
        input,
        request: {
          libraryID: context.request.libraryID,
          activeItemId: context.request.activeItemId,
        },
      }),
    });
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });

    const response = await invokeMcpEndpoint({
      token: getOrCreateZoteroMcpBearerToken(),
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "query_library",
          arguments: {
            entity: "items",
            mode: "list",
            libraryID: 42,
            activeItemId: 99,
          },
        },
      },
    });
    const payload = JSON.parse(response[2]);
    const content = JSON.parse(payload.result.content[0].text);
    assert.equal(content.ok, true);
    assert.deepEqual(content.result.input, {
      entity: "items",
      mode: "list",
    });
    assert.deepEqual(content.result.request, {
      libraryID: 42,
      activeItemId: 99,
    });
  });

  it("defaults MCP tool context to the active Codex Zotero scope", async function () {
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "read_paper",
        description: "Read paper",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "read",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      execute: async (_input, context: AgentToolContext) => ({
        request: {
          conversationKey: context.request.conversationKey,
          libraryID: context.request.libraryID,
          activeItemId: context.request.activeItemId,
          selectedPaperContexts: context.request.selectedPaperContexts,
        },
      }),
    });
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });

    const clearScope = setActiveZoteroMcpScope({
      conversationKey: 123,
      libraryID: 7,
      kind: "paper",
      paperItemID: 55,
      activeItemId: 55,
      activeContextItemId: 66,
      paperContext: {
        itemId: 55,
        contextItemId: 66,
        title: "Scoped Paper",
        firstCreator: "Ng",
        year: "2026",
      },
    });
    try {
      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "read_paper",
            arguments: {},
          },
        },
      });
      const payload = JSON.parse(response[2]);
      const content = JSON.parse(payload.result.content[0].text);
      assert.equal(content.ok, true);
      assert.deepEqual(content.result.request, {
        conversationKey: 123,
        libraryID: 7,
        activeItemId: 55,
        selectedPaperContexts: [
          {
            itemId: 55,
            contextItemId: 66,
            title: "Scoped Paper",
            firstCreator: "Ng",
            year: "2026",
          },
        ],
      });
    } finally {
      clearScope();
    }
  });

  it("binds MCP tool context from the scoped header before the legacy active scope", async function () {
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "query_library",
        description: "Query library",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "read",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      execute: async (_input, context: AgentToolContext) => ({
        request: {
          conversationKey: context.request.conversationKey,
          libraryID: context.request.libraryID,
          activeItemId: context.request.activeItemId,
        },
      }),
    });
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });

    const clearLegacyScope = setActiveZoteroMcpScope({
      profileSignature: "profile-main",
      conversationKey: 1,
      libraryID: 999,
      kind: "global",
      activeItemId: 999,
    });
    const scoped = registerScopedZoteroMcpScope(
      {
        profileSignature: "profile-dev",
        conversationKey: 456,
        libraryID: 7,
        kind: "global",
        activeItemId: 77,
        libraryName: "Development Library",
      },
      { token: "scoped-test-token" },
    );
    try {
      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "query_library",
            arguments: { entity: "items", mode: "list" },
          },
        },
      });
      const payload = JSON.parse(response[2]);
      const content = JSON.parse(payload.result.content[0].text);
      assert.equal(content.ok, true);
      assert.deepEqual(content.result.request, {
        conversationKey: 456,
        libraryID: 7,
        activeItemId: 77,
      });
    } finally {
      scoped.clear();
      clearLegacyScope();
    }
  });

  it("returns confirmation_required and executes only via zotero_confirm_action", async function () {
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "read_attachment",
        description: "Read attachment",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "read",
        requiresConfirmation: true,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      createPendingAction: async () => ({
        toolName: "read_attachment",
        title: "Attachment",
        confirmLabel: "Send",
        cancelLabel: "Cancel",
        fields: [],
      }),
      execute: async (input) => ({ delivered: true, input }),
    });
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });

    const token = getOrCreateZoteroMcpBearerToken();
    const first = await invokeMcpEndpoint({
      token,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "read_attachment",
          arguments: { attachFile: true },
        },
      },
    });
    const firstPayload = JSON.parse(first[2]);
    const pending = JSON.parse(firstPayload.result.content[0].text);
    assert.equal(pending.type, "confirmation_required");
    assert.isString(pending.requestId);

    const second = await invokeMcpEndpoint({
      token,
      body: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "zotero_confirm_action",
          arguments: {
            requestId: pending.requestId,
            approved: true,
          },
        },
      },
    });
    const secondPayload = JSON.parse(second[2]);
    const content = JSON.parse(secondPayload.result.content[0].text);
    assert.equal(content.ok, true);
    assert.deepEqual(content.result, {
      delivered: true,
      input: { attachFile: true },
    });
  });
});
