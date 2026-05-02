/**
 * MCP (Model Context Protocol) server for the llm-for-zotero plugin.
 *
 * Registers a JSON-RPC 2.0 endpoint on Zotero's built-in HTTP server at
 * "/llm-for-zotero/mcp". The endpoint is intended for local Codex app-server
 * use and requires a bearer token.
 */

import { config } from "../../../package.json";
import type { PaperContextRef } from "../../shared/types";
import type { AgentToolRegistry } from "../tools/registry";
import type { ZoteroGateway } from "../services/zoteroGateway";
import type {
  AgentRuntimeRequest,
  AgentToolContext,
  PreparedToolExecution,
} from "../types";
import {
  MCP_METHODS,
  RPC_ERRORS,
  makeError,
  makeResult,
  type JsonRpcRequest,
  type McpServerInfo,
  type McpToolCallParams,
  type McpToolCallResult,
  type McpToolsListResult,
} from "./protocol";

export const ZOTERO_MCP_SERVER_NAME = "llm_for_zotero";
export const ZOTERO_MCP_ENDPOINT_PATH = "/llm-for-zotero/mcp";
export const ZOTERO_MCP_AUTH_HEADER = "Authorization";
export const ZOTERO_MCP_TOKEN_PREF_KEY = `${config.prefsPrefix}.codexZoteroMcpBearerToken`;

const SERVER_VERSION = "1.0.0";
const DEFAULT_ZOTERO_HTTP_PORT = 23119;
const PENDING_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const CONFIRM_TOOL_NAME = "zotero_confirm_action";
const CURATED_READ_TOOL_NAMES = new Set([
  "query_library",
  "read_library",
  "read_paper",
  "search_paper",
  "search_literature_online",
  "read_attachment",
  "view_pdf_pages",
]);
const MCP_SCOPE_ARG_NAMES = new Set([
  "libraryID",
  "libraryId",
  "activeItemId",
  "activeItemID",
  "activeContextItemId",
  "activeContextItemID",
]);

export type ZoteroMcpActiveScope = {
  conversationKey?: number;
  libraryID?: number;
  kind?: "global" | "paper";
  paperItemID?: number;
  activeItemId?: number;
  activeContextItemId?: number;
  libraryName?: string;
  title?: string;
  userText?: string;
  paperContext?: PaperContextRef;
};

type McpServerDeps = {
  toolRegistry: AgentToolRegistry;
  zoteroGateway: ZoteroGateway;
};

type EndpointOptions = {
  method: string;
  data: unknown;
  headers?: Record<string, string>;
};

type PendingMcpConfirmation = {
  createdAt: number;
  execution: Extract<PreparedToolExecution, { kind: "confirmation" }>;
};

const pendingConfirmations = new Map<string, PendingMcpConfirmation>();
let activeZoteroMcpScope: ZoteroMcpActiveScope | null = null;

function getZoteroPrefs(): {
  get?: (key: string, global?: boolean) => unknown;
  set?: (key: string, value: unknown, global?: boolean) => void;
} | null {
  return (
    (
      Zotero as unknown as
        | {
            Prefs?: {
              get?: (key: string, global?: boolean) => unknown;
              set?: (key: string, value: unknown, global?: boolean) => void;
            };
          }
        | undefined
    )?.Prefs || null
  );
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function getOrCreateZoteroMcpBearerToken(): string {
  const prefs = getZoteroPrefs();
  const existing = prefs?.get?.(ZOTERO_MCP_TOKEN_PREF_KEY, true);
  if (typeof existing === "string" && existing.trim().length >= 32) {
    return existing.trim();
  }
  const token = generateToken();
  prefs?.set?.(ZOTERO_MCP_TOKEN_PREF_KEY, token, true);
  return token;
}

export function resetZoteroMcpBearerToken(): string {
  const token = generateToken();
  getZoteroPrefs()?.set?.(ZOTERO_MCP_TOKEN_PREF_KEY, token, true);
  return token;
}

export function getZoteroHttpPort(): number {
  const raw = (
    Zotero as unknown as {
      Prefs?: { get?: (key: string, global?: boolean) => unknown };
    }
  )?.Prefs?.get?.("httpServer.port");
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_ZOTERO_HTTP_PORT;
}

export function getZoteroMcpServerUrl(): string {
  return `http://127.0.0.1:${getZoteroHttpPort()}${ZOTERO_MCP_ENDPOINT_PATH}`;
}

export function getZoteroMcpAllowedToolNames(): string[] {
  return [...Array.from(CURATED_READ_TOOL_NAMES), CONFIRM_TOOL_NAME];
}

export function buildZoteroMcpConfigValue(): Record<string, unknown> {
  const token = getOrCreateZoteroMcpBearerToken();
  return {
    url: getZoteroMcpServerUrl(),
    http_headers: {
      [ZOTERO_MCP_AUTH_HEADER]: `Bearer ${token}`,
    },
    enabled_tools: getZoteroMcpAllowedToolNames(),
  };
}

function normalizePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function normalizeText(value: unknown, maxLength = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function normalizePaperContext(
  value: PaperContextRef | undefined,
): PaperContextRef | undefined {
  if (!value) return undefined;
  const itemId = normalizePositiveInt(value.itemId);
  const contextItemId = normalizePositiveInt(value.contextItemId);
  if (!itemId || !contextItemId) return undefined;
  return {
    itemId,
    contextItemId,
    title: normalizeText(value.title) || `Paper ${itemId}`,
    attachmentTitle: normalizeText(value.attachmentTitle),
    citationKey: normalizeText(value.citationKey),
    firstCreator: normalizeText(value.firstCreator),
    year: normalizeText(value.year, 32),
    mineruCacheDir: normalizeText(value.mineruCacheDir, 1024),
  };
}

function normalizeActiveScope(
  scope: ZoteroMcpActiveScope,
): ZoteroMcpActiveScope {
  const paperContext = normalizePaperContext(scope.paperContext);
  const paperItemID =
    normalizePositiveInt(scope.paperItemID) || paperContext?.itemId;
  const activeContextItemId =
    normalizePositiveInt(scope.activeContextItemId) ||
    paperContext?.contextItemId;
  return {
    conversationKey: normalizePositiveInt(scope.conversationKey),
    libraryID: normalizePositiveInt(scope.libraryID),
    kind: scope.kind === "paper" ? "paper" : "global",
    paperItemID,
    activeItemId:
      normalizePositiveInt(scope.activeItemId) || paperItemID || undefined,
    activeContextItemId,
    libraryName: normalizeText(scope.libraryName),
    title: normalizeText(scope.title),
    userText: normalizeText(scope.userText, 4000),
    paperContext,
  };
}

export function setActiveZoteroMcpScope(
  scope: ZoteroMcpActiveScope,
): () => void {
  const normalized = normalizeActiveScope(scope);
  activeZoteroMcpScope = normalized;
  return () => {
    if (activeZoteroMcpScope === normalized) activeZoteroMcpScope = null;
  };
}

export function getActiveZoteroMcpScope(): ZoteroMcpActiveScope | null {
  return activeZoteroMcpScope ? { ...activeZoteroMcpScope } : null;
}

function resolveDefaultLibraryId(): number {
  return (
    (Zotero as unknown as { Libraries?: { userLibraryID?: number } }).Libraries
      ?.userLibraryID || 1
  );
}

function getHeader(
  headers: Record<string, string> | undefined,
  name: string,
): string {
  if (!headers) return "";
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return String(value || "");
  }
  return "";
}

function isAuthorized(headers: Record<string, string> | undefined): boolean {
  const expected = getOrCreateZoteroMcpBearerToken();
  const authorization = getHeader(headers, ZOTERO_MCP_AUTH_HEADER);
  return authorization.trim() === `Bearer ${expected}`;
}

async function handleInitialize(): Promise<McpServerInfo> {
  return {
    protocolVersion: "2024-11-05",
    serverInfo: {
      name: "llm-for-zotero",
      version: SERVER_VERSION,
    },
    capabilities: {
      tools: {},
    },
  };
}

function createConfirmToolDefinition() {
  return {
    name: CONFIRM_TOOL_NAME,
    description:
      "Execute or deny a Zotero MCP action that previously returned confirmation_required.",
    inputSchema: {
      type: "object",
      required: ["requestId", "approved"],
      additionalProperties: false,
      properties: {
        requestId: {
          type: "string",
          description: "The requestId from a confirmation_required result.",
        },
        approved: {
          type: "boolean",
          description: "Set true to execute the action or false to deny it.",
        },
        data: {
          description:
            "Optional edited confirmation data for tools that support it.",
        },
      },
    },
  };
}

function handleToolsList(toolRegistry: AgentToolRegistry): McpToolsListResult {
  const tools = toolRegistry
    .listTools()
    .filter(
      (tool) =>
        CURATED_READ_TOOL_NAMES.has(tool.name) && tool.mutability === "read",
    )
    .map(({ name, description, inputSchema }) => ({
      name,
      description: decorateMcpToolDescription(description),
      inputSchema: decorateMcpToolSchema(inputSchema),
    }));
  tools.push(createConfirmToolDefinition());
  return { tools };
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function extractMcpScopeArgs(rawArgs: unknown): {
  toolArgs: Record<string, unknown>;
  libraryID?: number;
  activeItemId?: number;
  activeContextItemId?: number;
} {
  const args = normalizeRecord(rawArgs);
  const toolArgs = { ...args };
  for (const key of MCP_SCOPE_ARG_NAMES) delete toolArgs[key];
  return {
    toolArgs,
    libraryID: normalizePositiveInt(args.libraryID ?? args.libraryId),
    activeItemId: normalizePositiveInt(args.activeItemId ?? args.activeItemID),
    activeContextItemId: normalizePositiveInt(
      args.activeContextItemId ?? args.activeContextItemID,
    ),
  };
}

function decorateMcpToolDescription(description: string): string {
  return `${description}\n\nZotero MCP scope: omit libraryID, activeItemId, and activeContextItemId to use the current Codex Zotero chat scope. Use query_library to discover Zotero items, read_library for structured item state, search_paper for evidence retrieval, and read_paper/read_attachment/view_pdf_pages for deeper inspection.`;
}

function decorateMcpToolSchema(inputSchema: object): object {
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    return inputSchema;
  }
  const record = inputSchema as Record<string, unknown>;
  const rawProperties = normalizeRecord(record.properties);
  return {
    ...record,
    properties: {
      ...rawProperties,
      libraryID: {
        type: "number",
        description:
          "Optional Zotero library ID. Omit to use the active library for the current Codex Zotero chat.",
      },
      activeItemId: {
        type: "number",
        description:
          "Optional active Zotero parent item ID. Omit to use the active paper/item for the current Codex Zotero chat.",
      },
      activeContextItemId: {
        type: "number",
        description:
          "Optional active Zotero attachment/context item ID. Omit to use the active paper attachment for the current Codex Zotero chat.",
      },
    },
  };
}

function resolveScopePaperContext(
  scope: ZoteroMcpActiveScope | null,
): PaperContextRef | undefined {
  if (!scope) return undefined;
  const paperContext = normalizePaperContext(scope.paperContext);
  if (paperContext) return paperContext;
  const itemId = normalizePositiveInt(scope.paperItemID || scope.activeItemId);
  const contextItemId = normalizePositiveInt(scope.activeContextItemId);
  if (!itemId || !contextItemId) return undefined;
  return {
    itemId,
    contextItemId,
    title: normalizeText(scope.title) || `Paper ${itemId}`,
  };
}

function createToolContext(rawArgs: unknown): AgentToolContext {
  const scopeArgs = extractMcpScopeArgs(rawArgs);
  const scope = activeZoteroMcpScope;
  const activeItemId =
    scopeArgs.activeItemId ||
    scope?.activeItemId ||
    scope?.paperItemID ||
    undefined;
  const activeContextItemId =
    scopeArgs.activeContextItemId || scope?.activeContextItemId || undefined;
  const itemLookupId = activeItemId || activeContextItemId;
  const item = itemLookupId
    ? (
        Zotero as unknown as {
          Items?: { get?: (id: number) => Zotero.Item | false | null };
        }
      ).Items?.get?.(itemLookupId) || null
    : null;
  const paperContext = resolveScopePaperContext(scope);
  const request: AgentRuntimeRequest = {
    conversationKey: scope?.conversationKey || 0,
    mode: "agent",
    userText:
      normalizeText(
        normalizeRecord(rawArgs).question || normalizeRecord(rawArgs).text,
        4000,
      ) ||
      scope?.userText ||
      "",
    activeItemId,
    libraryID:
      scopeArgs.libraryID || scope?.libraryID || resolveDefaultLibraryId(),
    model: "codex-app-server",
    selectedPaperContexts: paperContext ? [paperContext] : undefined,
    fullTextPaperContexts: paperContext ? [paperContext] : undefined,
  };
  return {
    request,
    item,
    currentAnswerText: "",
    modelName: "codex-app-server",
    modelProviderLabel: "Codex",
  };
}

function pruneExpiredConfirmations(): void {
  const cutoff = Date.now() - PENDING_CONFIRMATION_TTL_MS;
  for (const [requestId, entry] of pendingConfirmations) {
    if (entry.createdAt < cutoff) pendingConfirmations.delete(requestId);
  }
}

function formatToolResult(
  execution: Extract<PreparedToolExecution, { kind: "result" }>["execution"],
): McpToolCallResult {
  const { result } = execution;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: result.ok,
            result: result.content,
            artifacts: result.artifacts,
          },
          null,
          2,
        ),
      },
    ],
    ...(result.ok ? {} : { isError: true }),
  };
}

function formatConfirmationRequired(
  execution: Extract<PreparedToolExecution, { kind: "confirmation" }>,
): McpToolCallResult {
  pendingConfirmations.set(execution.requestId, {
    createdAt: Date.now(),
    execution,
  });
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            type: "confirmation_required",
            requestId: execution.requestId,
            action: execution.action,
            instructions: `Call ${CONFIRM_TOOL_NAME} with this requestId and approved:true to execute, or approved:false to deny.`,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleConfirmTool(rawArgs: unknown): Promise<McpToolCallResult> {
  pruneExpiredConfirmations();
  const args = normalizeRecord(rawArgs);
  const requestId =
    typeof args.requestId === "string" ? args.requestId.trim() : "";
  if (!requestId) {
    return {
      content: [
        { type: "text", text: "zotero_confirm_action requires requestId" },
      ],
      isError: true,
    };
  }
  const pending = pendingConfirmations.get(requestId);
  if (!pending) {
    return {
      content: [
        {
          type: "text",
          text: `No pending Zotero MCP confirmation found for ${requestId}`,
        },
      ],
      isError: true,
    };
  }
  pendingConfirmations.delete(requestId);
  const approved = args.approved === true;
  const execution = approved
    ? await pending.execution.execute(args.data)
    : pending.execution.deny(args.data);
  return formatToolResult(execution);
}

async function handleToolsCall(
  params: McpToolCallParams,
  deps: McpServerDeps,
): Promise<McpToolCallResult> {
  pruneExpiredConfirmations();
  const { name, arguments: rawArgs } = params;

  if (name === CONFIRM_TOOL_NAME) {
    return handleConfirmTool(rawArgs);
  }

  const tool = deps.toolRegistry.getTool(name);
  if (
    !tool ||
    !CURATED_READ_TOOL_NAMES.has(name) ||
    tool.spec.mutability !== "read"
  ) {
    return {
      content: [
        {
          type: "text",
          text: `Zotero MCP tool is not available in Codex native mode: ${name}`,
        },
      ],
      isError: true,
    };
  }

  const prepared = await deps.toolRegistry.prepareExecution(
    {
      id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      name,
      arguments: extractMcpScopeArgs(rawArgs).toolArgs,
    },
    createToolContext(rawArgs),
  );

  if (prepared.kind === "confirmation") {
    return formatConfirmationRequired(prepared);
  }
  return formatToolResult(prepared.execution);
}

async function handleRequest(
  body: string,
  deps: McpServerDeps,
): Promise<string> {
  let request: JsonRpcRequest;

  try {
    const parsed = JSON.parse(body);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.jsonrpc !== "2.0" ||
      typeof parsed.method !== "string"
    ) {
      return JSON.stringify(
        makeError(
          null,
          RPC_ERRORS.INVALID_REQUEST.code,
          RPC_ERRORS.INVALID_REQUEST.message,
        ),
      );
    }
    request = parsed as JsonRpcRequest;
  } catch {
    return JSON.stringify(
      makeError(
        null,
        RPC_ERRORS.PARSE_ERROR.code,
        RPC_ERRORS.PARSE_ERROR.message,
      ),
    );
  }

  const { id, method, params } = request;

  try {
    if (method === MCP_METHODS.INITIALIZE) {
      const result = await handleInitialize();
      return JSON.stringify(makeResult(id, result));
    }

    if (method === MCP_METHODS.TOOLS_LIST) {
      const result = handleToolsList(deps.toolRegistry);
      return JSON.stringify(makeResult(id, result));
    }

    if (method === MCP_METHODS.TOOLS_CALL) {
      if (
        !params ||
        typeof params !== "object" ||
        typeof (params as McpToolCallParams).name !== "string"
      ) {
        return JSON.stringify(
          makeError(
            id,
            RPC_ERRORS.INVALID_PARAMS.code,
            "tools/call requires { name, arguments }",
          ),
        );
      }
      const result = await handleToolsCall(params as McpToolCallParams, deps);
      return JSON.stringify(makeResult(id, result));
    }

    return JSON.stringify(
      makeError(
        id,
        RPC_ERRORS.METHOD_NOT_FOUND.code,
        `Unknown method: ${method}`,
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify(
      makeError(
        id,
        RPC_ERRORS.INTERNAL_ERROR.code,
        `Internal error: ${message}`,
      ),
    );
  }
}

/**
 * Registers the MCP endpoint on Zotero's built-in HTTP server.
 * Call this after the agent subsystem is initialized.
 */
export function registerMcpServer(deps: McpServerDeps): void {
  const capturedDeps = deps;

  class McpEndpoint {
    supportedMethods = ["POST"];
    supportedDataTypes = ["application/json"];

    init = async (
      options: EndpointOptions,
    ): Promise<[number, string, string]> => {
      if (!isAuthorized(options.headers)) {
        return [
          401,
          "application/json",
          JSON.stringify({ error: "unauthorized" }),
        ];
      }
      const body =
        typeof options.data === "string"
          ? options.data
          : JSON.stringify(options.data);

      const responseBody = await handleRequest(body, capturedDeps);
      return [200, "application/json", responseBody];
    };
  }

  Zotero.Server.Endpoints[ZOTERO_MCP_ENDPOINT_PATH] = McpEndpoint;
}

/**
 * Removes the MCP endpoint from Zotero's server (call on plugin shutdown).
 */
export function unregisterMcpServer(): void {
  pendingConfirmations.clear();
  delete Zotero.Server.Endpoints[ZOTERO_MCP_ENDPOINT_PATH];
}
