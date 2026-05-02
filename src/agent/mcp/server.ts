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
  type McpToolDefinition,
  type McpToolsListResult,
} from "./protocol";

export const ZOTERO_MCP_SERVER_NAME = "llm_for_zotero";
export const ZOTERO_MCP_ENDPOINT_PATH = "/llm-for-zotero/mcp";
export const ZOTERO_MCP_AUTH_HEADER = "Authorization";
export const ZOTERO_MCP_SCOPE_HEADER = "X-LLM-For-Zotero-Scope";
export const ZOTERO_MCP_TOKEN_PREF_KEY = `${config.prefsPrefix}.codexZoteroMcpBearerToken`;

const SERVER_VERSION = "1.0.0";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_ZOTERO_HTTP_PORT = 23119;
const PENDING_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const SCOPED_MCP_SCOPE_TTL_MS = 2 * 60 * 60 * 1000;
const CONFIRM_TOOL_NAME = "zotero_confirm_action";
export const ZOTERO_MCP_SAFE_READ_TOOL_NAMES = [
  "query_library",
  "read_library",
  "read_paper",
  "search_paper",
  "search_literature_online",
  "read_attachment",
  "view_pdf_pages",
] as const;
const CURATED_READ_TOOL_NAMES = new Set<string>(
  ZOTERO_MCP_SAFE_READ_TOOL_NAMES,
);
const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
} as const;
const CONFIRM_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: false,
} as const;
const MCP_SCOPE_ARG_NAMES = new Set([
  "libraryID",
  "libraryId",
  "activeItemId",
  "activeItemID",
  "activeContextItemId",
  "activeContextItemID",
]);

export type ZoteroMcpActiveScope = {
  profileSignature?: string;
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

type McpHttpResponse = {
  status: number;
  contentType: string;
  body: string;
};

type PendingMcpConfirmation = {
  createdAt: number;
  execution: Extract<PreparedToolExecution, { kind: "confirmation" }>;
};

const pendingConfirmations = new Map<string, PendingMcpConfirmation>();
const scopedZoteroMcpScopes = new Map<
  string,
  { createdAt: number; expiresAt: number; scope: ZoteroMcpActiveScope }
>();
let activeZoteroMcpScope: ZoteroMcpActiveScope | null = null;

export type ZoteroMcpToolActivityEvent = {
  requestId: string;
  phase: "started" | "completed";
  toolName: string;
  toolLabel?: string;
  serverName: string;
  arguments?: unknown;
  ok?: boolean;
  error?: string;
  profileSignature?: string;
  conversationKey?: number;
  libraryID?: number;
  kind?: "global" | "paper";
  timestamp: number;
};

type ZoteroMcpToolActivityObserver = (
  event: ZoteroMcpToolActivityEvent,
) => void;

const zoteroMcpToolActivityObservers = new Set<ZoteroMcpToolActivityObserver>();

export function addZoteroMcpToolActivityObserver(
  observer: ZoteroMcpToolActivityObserver,
): () => void {
  zoteroMcpToolActivityObservers.add(observer);
  return () => {
    zoteroMcpToolActivityObservers.delete(observer);
  };
}

function emitZoteroMcpToolActivity(event: ZoteroMcpToolActivityEvent): void {
  for (const observer of zoteroMcpToolActivityObservers) {
    try {
      observer(event);
    } catch {
      /* observer errors must not affect MCP tool execution */
    }
  }
}

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

function normalizeServerNamePart(value: unknown): string {
  const normalized = normalizeText(value, 128)
    ?.replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return normalized || "";
}

export function getZoteroMcpServerName(profileSignature?: string): string {
  const suffix = normalizeServerNamePart(profileSignature);
  return suffix
    ? `${ZOTERO_MCP_SERVER_NAME}_${suffix}`
    : ZOTERO_MCP_SERVER_NAME;
}

export function buildZoteroMcpConfigValue(
  params: {
    scopeToken?: string;
    required?: boolean;
  } = {},
): Record<string, unknown> {
  const token = getOrCreateZoteroMcpBearerToken();
  const scopeToken = normalizeText(params.scopeToken, 256);
  return {
    url: getZoteroMcpServerUrl(),
    ...(params.required ? { required: true } : {}),
    http_headers: {
      [ZOTERO_MCP_AUTH_HEADER]: `Bearer ${token}`,
      ...(scopeToken ? { [ZOTERO_MCP_SCOPE_HEADER]: scopeToken } : {}),
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
    profileSignature: normalizeText(scope.profileSignature, 128),
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

function pruneExpiredScopedMcpScopes(): void {
  const now = Date.now();
  for (const [token, entry] of scopedZoteroMcpScopes) {
    if (entry.expiresAt <= now) scopedZoteroMcpScopes.delete(token);
  }
}

export function registerScopedZoteroMcpScope(
  scope: ZoteroMcpActiveScope,
  options: { ttlMs?: number; token?: string } = {},
): { token: string; clear: () => void } {
  pruneExpiredScopedMcpScopes();
  const token = normalizeText(options.token, 256) || generateToken();
  const ttlMs =
    Number.isFinite(options.ttlMs) && Number(options.ttlMs) > 0
      ? Math.floor(Number(options.ttlMs))
      : SCOPED_MCP_SCOPE_TTL_MS;
  scopedZoteroMcpScopes.set(token, {
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    scope: normalizeActiveScope(scope),
  });
  return {
    token,
    clear: () => {
      scopedZoteroMcpScopes.delete(token);
    },
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
    protocolVersion: MCP_PROTOCOL_VERSION,
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
    title: "Confirm Zotero Action",
    description:
      "Execute or deny a Zotero MCP action that previously returned confirmation_required.",
    annotations: CONFIRM_TOOL_ANNOTATIONS,
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
  const tools: McpToolDefinition[] = toolRegistry
    .listTools()
    .filter(
      (tool) =>
        CURATED_READ_TOOL_NAMES.has(tool.name) && tool.mutability === "read",
    )
    .map(({ name, description, inputSchema }) => ({
      name,
      title: name
        .split("_")
        .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
        .join(" "),
      description: decorateMcpToolDescription(description),
      inputSchema: decorateMcpToolSchema(inputSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    }));
  tools.push(createConfirmToolDefinition());
  return { tools };
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasJsonRpcId(request: JsonRpcRequest): boolean {
  return Object.prototype.hasOwnProperty.call(request, "id");
}

function makeJsonRpcHttpResponse(body: unknown): McpHttpResponse {
  return {
    status: 200,
    contentType: "application/json",
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

function makeJsonRpcNotificationResponse(): McpHttpResponse {
  return {
    status: 202,
    contentType: "text/plain",
    body: "",
  };
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
  return `${description}\n\nZotero MCP scope: omit libraryID, activeItemId, and activeContextItemId to use the current Codex Zotero chat scope. Use query_library to discover Zotero items, read_library for structured item state, search_paper for evidence retrieval, and read_paper/read_attachment/view_pdf_pages for deeper inspection. For counting questions, prefer query_library totalCount/returnedCount/limited metadata instead of hand-counting listed results.`;
}

function decorateMcpToolSchema(inputSchema: object): object {
  if (
    !inputSchema ||
    typeof inputSchema !== "object" ||
    Array.isArray(inputSchema)
  ) {
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

function resolveScopedMcpScope(
  headers: Record<string, string> | undefined,
): ZoteroMcpActiveScope | null {
  const token = getHeader(headers, ZOTERO_MCP_SCOPE_HEADER).trim();
  if (!token) return activeZoteroMcpScope;
  pruneExpiredScopedMcpScopes();
  const entry = scopedZoteroMcpScopes.get(token);
  if (!entry) {
    throw new Error(
      "Zotero MCP scope token is invalid or expired. Start a new Codex turn from Zotero so tools bind to the current profile and library.",
    );
  }
  return entry.scope;
}

function resolveMcpToolActivityScope(
  headers: Record<string, string> | undefined,
): ZoteroMcpActiveScope | null {
  try {
    return resolveScopedMcpScope(headers);
  } catch {
    return null;
  }
}

function formatMcpToolActivityRequestId(
  id: string | number | null | undefined,
): string {
  if (typeof id === "string" && id.trim()) return `jsonrpc:${id.trim()}`;
  if (typeof id === "number" && Number.isFinite(id)) return `jsonrpc:${id}`;
  return `mcp:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

function getMcpToolPresentationLabel(
  deps: McpServerDeps,
  toolName: string,
): string | undefined {
  const label = deps.toolRegistry
    .getTool(toolName)
    ?.presentation?.label?.trim();
  return label || undefined;
}

function buildMcpToolActivityEvent(params: {
  id: string | number | null | undefined;
  phase: "started" | "completed";
  toolName: string;
  toolLabel?: string;
  args?: unknown;
  ok?: boolean;
  error?: string;
  headers?: Record<string, string>;
}): ZoteroMcpToolActivityEvent {
  const scope = resolveMcpToolActivityScope(params.headers);
  return {
    requestId: formatMcpToolActivityRequestId(params.id),
    phase: params.phase,
    toolName: params.toolName,
    toolLabel: params.toolLabel,
    serverName: ZOTERO_MCP_SERVER_NAME,
    arguments: params.args,
    ok: params.ok,
    error: params.error,
    profileSignature: scope?.profileSignature,
    conversationKey: scope?.conversationKey,
    libraryID: scope?.libraryID,
    kind: scope?.kind,
    timestamp: Date.now(),
  };
}

function createToolContext(
  rawArgs: unknown,
  headers?: Record<string, string>,
): AgentToolContext {
  const scopeArgs = extractMcpScopeArgs(rawArgs);
  const scope = resolveScopedMcpScope(headers);
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
    libraryID: scopeArgs.libraryID || scope?.libraryID || 0,
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
  headers?: Record<string, string>,
  id?: string | number | null,
): Promise<McpToolCallResult> {
  pruneExpiredConfirmations();
  const { name, arguments: rawArgs } = params;

  if (name === CONFIRM_TOOL_NAME) {
    return handleConfirmTool(rawArgs);
  }

  const scopeArgs = extractMcpScopeArgs(rawArgs);
  const toolLabel = getMcpToolPresentationLabel(deps, name);
  emitZoteroMcpToolActivity(
    buildMcpToolActivityEvent({
      id,
      phase: "started",
      toolName: name,
      toolLabel,
      args: scopeArgs.toolArgs,
      headers,
    }),
  );

  const completeActivity = (result: { ok: boolean; error?: string }) => {
    emitZoteroMcpToolActivity(
      buildMcpToolActivityEvent({
        id,
        phase: "completed",
        toolName: name,
        toolLabel,
        args: scopeArgs.toolArgs,
        ok: result.ok,
        error: result.error,
        headers,
      }),
    );
  };

  const tool = deps.toolRegistry.getTool(name);
  if (
    !tool ||
    !CURATED_READ_TOOL_NAMES.has(name) ||
    tool.spec.mutability !== "read"
  ) {
    completeActivity({ ok: false, error: "Tool unavailable in native mode" });
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

  try {
    const prepared = await deps.toolRegistry.prepareExecution(
      {
        id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        name,
        arguments: scopeArgs.toolArgs,
      },
      createToolContext(rawArgs, headers),
    );

    if (prepared.kind === "confirmation") {
      const result = formatConfirmationRequired(prepared);
      completeActivity({ ok: !result.isError });
      return result;
    }
    const result = formatToolResult(prepared.execution);
    completeActivity({ ok: !result.isError });
    return result;
  } catch (error) {
    completeActivity({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function handleRequest(
  body: string,
  deps: McpServerDeps,
  headers?: Record<string, string>,
): Promise<McpHttpResponse> {
  let request: JsonRpcRequest;

  try {
    const parsed = JSON.parse(body);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.jsonrpc !== "2.0" ||
      typeof parsed.method !== "string"
    ) {
      return makeJsonRpcHttpResponse(
        makeError(
          null,
          RPC_ERRORS.INVALID_REQUEST.code,
          RPC_ERRORS.INVALID_REQUEST.message,
        ),
      );
    }
    request = parsed as JsonRpcRequest;
  } catch {
    return makeJsonRpcHttpResponse(
      makeError(
        null,
        RPC_ERRORS.PARSE_ERROR.code,
        RPC_ERRORS.PARSE_ERROR.message,
      ),
    );
  }

  const { id, method, params } = request;
  const isNotification = !hasJsonRpcId(request);

  try {
    if (method === MCP_METHODS.INITIALIZE) {
      const result = await handleInitialize();
      return makeJsonRpcHttpResponse(makeResult(id ?? null, result));
    }

    if (method === MCP_METHODS.INITIALIZED) {
      return makeJsonRpcNotificationResponse();
    }

    if (method === MCP_METHODS.TOOLS_LIST) {
      const result = handleToolsList(deps.toolRegistry);
      return makeJsonRpcHttpResponse(makeResult(id ?? null, result));
    }

    if (method === MCP_METHODS.TOOLS_CALL) {
      if (
        !params ||
        typeof params !== "object" ||
        typeof (params as McpToolCallParams).name !== "string"
      ) {
        return makeJsonRpcHttpResponse(
          makeError(
            id ?? null,
            RPC_ERRORS.INVALID_PARAMS.code,
            "tools/call requires { name, arguments }",
          ),
        );
      }
      const result = await handleToolsCall(
        params as McpToolCallParams,
        deps,
        headers,
        id ?? null,
      );
      return makeJsonRpcHttpResponse(makeResult(id ?? null, result));
    }

    if (isNotification) {
      return makeJsonRpcNotificationResponse();
    }

    return makeJsonRpcHttpResponse(
      makeError(
        id ?? null,
        RPC_ERRORS.METHOD_NOT_FOUND.code,
        `Unknown method: ${method}`,
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isNotification) {
      (
        globalThis as typeof globalThis & {
          ztoolkit?: { log?: (...args: unknown[]) => void };
        }
      ).ztoolkit?.log?.("Zotero MCP notification failed", method, error);
      return makeJsonRpcNotificationResponse();
    }
    return makeJsonRpcHttpResponse(
      makeError(
        id ?? null,
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

      const response = await handleRequest(body, capturedDeps, options.headers);
      return [response.status, response.contentType, response.body];
    };
  }

  Zotero.Server.Endpoints[ZOTERO_MCP_ENDPOINT_PATH] = McpEndpoint;
}

/**
 * Removes the MCP endpoint from Zotero's server (call on plugin shutdown).
 */
export function unregisterMcpServer(): void {
  pendingConfirmations.clear();
  scopedZoteroMcpScopes.clear();
  delete Zotero.Server.Endpoints[ZOTERO_MCP_ENDPOINT_PATH];
}
