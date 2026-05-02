import type {
  ChatMessage,
  MessageContent,
  ReasoningConfig,
  ReasoningEvent,
  TextContent,
  UsageStats,
} from "../shared/llm";
import type { CodexConversationKind, PaperContextRef } from "../shared/types";
import {
  ZOTERO_MCP_SAFE_READ_TOOL_NAMES,
  ZOTERO_MCP_SERVER_NAME,
  registerScopedZoteroMcpScope,
  setActiveZoteroMcpScope,
} from "../agent/mcp/server";
import {
  buildLegacyCodexAppServerChatInput,
  prepareCodexAppServerChatTurn,
} from "../utils/codexAppServerInput";
import {
  extractCodexAppServerThreadId,
  extractCodexAppServerTurnId,
  getOrCreateCodexAppServerProcess,
  isCodexAppServerThreadStartInstructionsUnsupportedError,
  resolveCodexAppServerBinaryPath,
  resolveCodexAppServerReasoningParams,
  resolveCodexAppServerTurnInputWithFallback,
  waitForCodexAppServerTurnCompletion,
  type CodexAppServerAgentMessageDeltaEvent,
  type CodexAppServerItemEvent,
  type CodexAppServerProcess,
} from "../utils/codexAppServerProcess";
import {
  getCodexConversationSummary,
  upsertCodexConversationSummary,
} from "./store";
import { isCodexZoteroMcpToolsEnabled } from "./prefs";
import { getCodexProfileSignature } from "./constants";
import {
  assertRequiredCodexZoteroMcpToolsReady,
  buildCodexZoteroMcpThreadConfig,
  preflightCodexZoteroMcpServer,
  readCodexNativeMcpSetupStatus,
  type CodexNativeMcpSetupStatus,
} from "./mcpSetup";

export const CODEX_APP_SERVER_NATIVE_PROCESS_KEY = "codex_app_server_native";
const CODEX_APP_SERVER_SERVICE_NAME = "llm_for_zotero";

export type CodexNativeConversationScope = {
  profileSignature?: string;
  conversationKey: number;
  libraryID: number;
  kind: CodexConversationKind;
  paperItemID?: number;
  activeItemId?: number;
  activeContextItemId?: number;
  libraryName?: string;
  paperTitle?: string;
  paperContext?: PaperContextRef;
  title?: string;
};

export type CodexNativeStoreHooks = {
  loadProviderSessionId?: () => Promise<string | undefined>;
  persistProviderSessionId?: (threadId: string) => Promise<void>;
};

export type CodexNativeTurnResult = {
  text: string;
  threadId: string;
  resumed: boolean;
  diagnostics?: CodexNativeDiagnostics;
};

export type CodexNativeApprovalRequest = {
  method: string;
  params: unknown;
};

export type CodexNativeApprovalDecision = {
  approved: boolean;
  error?: string;
};

type NativeThreadResolution = {
  threadId: string;
  resumed: boolean;
  developerInstructionsAccepted: boolean;
  threadSource?: string;
};

export type CodexNativeDiagnostics = {
  threadId: string;
  threadSource?: string;
  profileSignature: string;
  libraryID: number;
  libraryName?: string;
  mcpServerName?: string;
  mcpReady: boolean;
  mcpToolNames: string[];
  historyVerified?: boolean;
};

const CODEX_APP_SERVER_APPROVAL_REQUEST_METHODS = [
  "tool/requestUserInput",
  "approval/request",
  "approval/requested",
  "turn/approval/request",
];

const UNSAFE_ZOTERO_MCP_APPROVAL_MARKERS = [
  "zotero_confirm_action",
  "apply_tags",
  "edit_current_note",
  "file_io",
  "import_identifiers",
  "manage_attachments",
  "merge_items",
  "move_to_collection",
  "run_command",
  "trash_items",
  "update_metadata",
];

function normalizeNonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function serializeApprovalPayload(value: unknown): string {
  try {
    return JSON.stringify(value).toLowerCase();
  } catch {
    return String(value || "").toLowerCase();
  }
}

export function resolveSafeCodexNativeApprovalRequest(
  request: CodexNativeApprovalRequest,
): CodexNativeApprovalDecision | null {
  if (request.method !== "tool/requestUserInput") return null;
  const serialized = serializeApprovalPayload(request.params);
  const isZoteroMcpRequest =
    serialized.includes(ZOTERO_MCP_SERVER_NAME) ||
    serialized.includes("llm-for-zotero") ||
    serialized.includes("zotero mcp");
  if (!isZoteroMcpRequest) return null;

  const mentionsSafeReadTool = ZOTERO_MCP_SAFE_READ_TOOL_NAMES.some((name) =>
    serialized.includes(name),
  );
  if (!mentionsSafeReadTool) return null;

  const mentionsUnsafeTool = UNSAFE_ZOTERO_MCP_APPROVAL_MARKERS.some((name) =>
    serialized.includes(name),
  );
  if (mentionsUnsafeTool) return null;

  return { approved: true };
}

function extractCodexAppServerThreadSource(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const source = (result as { thread?: unknown }).thread || result;
  if (!source || typeof source !== "object") return undefined;
  const raw = (source as { source?: unknown }).source;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (raw && typeof raw === "object") return JSON.stringify(raw);
  return undefined;
}

function extractSystemText(messages: ChatMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) =>
      typeof message.content === "string" ? message.content.trim() : "",
    )
    .filter(Boolean)
    .join("\n\n");
}

function extractLatestUserText(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content.trim();
    return message.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text || "")
      .join("\n")
      .trim();
  }
  return "";
}

function formatScopeLine(label: string, value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return `- ${label}: ${value}`;
}

function formatPaperContextLine(
  paperContext: PaperContextRef | undefined,
): string | null {
  if (!paperContext) return null;
  const pieces = [
    `itemId=${paperContext.itemId}`,
    `contextItemId=${paperContext.contextItemId}`,
  ];
  if (paperContext.title) pieces.push(`title="${paperContext.title}"`);
  if (paperContext.firstCreator) pieces.push(`firstCreator="${paperContext.firstCreator}"`);
  if (paperContext.year) pieces.push(`year="${paperContext.year}"`);
  if (paperContext.attachmentTitle) {
    pieces.push(`attachmentTitle="${paperContext.attachmentTitle}"`);
  }
  return `- Active paper context: ${pieces.join(", ")}`;
}

function buildZoteroEnvironmentManifest(params: {
  scope: CodexNativeConversationScope;
  mcpEnabled: boolean;
  mcpReady: boolean;
  mcpWarning?: string;
}): string {
  const { scope } = params;
  const lines = [
    "Zotero environment for this turn:",
    formatScopeLine(
      "Chat scope",
      scope.kind === "paper" ? "paper chat" : "library chat",
    ),
    formatScopeLine(
      "Active library",
      scope.libraryName
        ? `${scope.libraryID} (${scope.libraryName})`
        : scope.libraryID,
    ),
  ].filter((line): line is string => Boolean(line));

  if (scope.kind === "paper") {
    lines.push(
      ...[
        formatScopeLine("Active paper item ID", scope.paperItemID),
        formatScopeLine("Active item ID", scope.activeItemId),
        formatScopeLine("Active context item ID", scope.activeContextItemId),
        formatScopeLine("Active paper title", scope.paperTitle),
        formatPaperContextLine(scope.paperContext),
      ].filter((line): line is string => Boolean(line)),
    );
  }

  if (!params.mcpEnabled) {
    lines.push(
      "- Zotero MCP tools: disabled for this turn. Do not claim access to Zotero library or PDF tools unless another tool source is available.",
    );
    return lines.join("\n");
  }

  if (!params.mcpReady) {
    lines.push(
      `- Zotero MCP tools: unavailable for this turn.${params.mcpWarning ? ` ${params.mcpWarning}` : ""}`,
    );
    return lines.join("\n");
  }

  lines.push(
    "- Zotero MCP tools: available. Use them to inspect Zotero data instead of assuming library or paper content is preloaded.",
    "- Critical: use only Zotero MCP tools for Zotero library, profile, item, PDF, and note data. If Zotero MCP tools are unavailable or fail, report the setup error. Do not inspect local Zotero profile folders, zotero.sqlite, WAL files, backups, or other filesystem copies to answer Zotero-library questions.",
    "- Shell and filesystem tools are disabled for Zotero-native chat because they can read the wrong Zotero profile.",
  );
  if (scope.kind === "paper") {
    lines.push(
      "- Paper workflow: use read_library for metadata/notes/attachments, search_paper for targeted evidence, and read_paper/read_attachment/view_pdf_pages for deeper inspection. If a tool call omits IDs, it defaults to the active paper scope above.",
    );
  } else {
    lines.push(
      "- Library workflow: use query_library to discover/search/list items in the active library, then read_library and paper tools on selected item IDs before answering. Do not ask the user to paste the whole library.",
    );
  }
  return lines.join("\n");
}

function prefixUserContentWithContext(
  content: MessageContent,
  context: string,
): MessageContent {
  const prefix = context.trim();
  if (!prefix) return content;
  const textPrefix = `Zotero context for this turn:\n${prefix}\n\nUser request:\n`;
  if (typeof content === "string") {
    return `${textPrefix}${content}`;
  }
  let didPrefix = false;
  const nextParts = content.map((part) => {
    if (didPrefix || part.type !== "text") return part;
    didPrefix = true;
    return {
      ...part,
      text: `${textPrefix}${part.text || ""}`,
    } satisfies TextContent;
  });
  if (didPrefix) return nextParts;
  return [{ type: "text", text: prefix }, ...content];
}

function buildNativeMessages(params: {
  messages: ChatMessage[];
  includeVisibleHistory: boolean;
  zoteroEnvironmentText?: string;
  prefixLatestUserWithContext?: boolean;
}): ChatMessage[] {
  const systemText = [
    extractSystemText(params.messages),
    params.zoteroEnvironmentText || "",
  ]
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join("\n\n");
  const visibleMessages = params.messages.filter(
    (message) => message.role !== "system",
  );
  let latestUserIndex = -1;
  for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
    if (visibleMessages[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }

  if (latestUserIndex < 0) {
    return [
      {
        role: "user",
        content: systemText || "",
      },
    ];
  }

  const history = params.includeVisibleHistory
    ? visibleMessages.slice(0, latestUserIndex)
    : [];
  const latestUser = visibleMessages[latestUserIndex]!;
  if (!params.prefixLatestUserWithContext) {
    return [
      ...(systemText
        ? [{ role: "system" as const, content: systemText }]
        : []),
      ...history,
      latestUser,
    ];
  }
  return [
    ...history,
    {
      ...latestUser,
      content: prefixUserContentWithContext(latestUser.content, systemText),
    },
  ];
}

async function loadStoredProviderSessionId(params: {
  conversationKey: number;
  hooks?: CodexNativeStoreHooks;
}): Promise<string> {
  if (params.hooks?.loadProviderSessionId) {
    return normalizeNonEmptyString(await params.hooks.loadProviderSessionId());
  }
  const summary = await getCodexConversationSummary(params.conversationKey);
  return normalizeNonEmptyString(summary?.providerSessionId);
}

async function persistProviderSessionId(params: {
  scope: CodexNativeConversationScope;
  threadId: string;
  model: string;
  effort?: string;
  hooks?: CodexNativeStoreHooks;
}): Promise<void> {
  await params.hooks?.persistProviderSessionId?.(params.threadId);
  if (params.hooks?.persistProviderSessionId) return;
  await upsertCodexConversationSummary({
    conversationKey: params.scope.conversationKey,
    libraryID: params.scope.libraryID,
    kind: params.scope.kind,
    paperItemID: params.scope.paperItemID,
    title: params.scope.title,
    providerSessionId: params.threadId,
    model: params.model,
    effort: params.effort,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

async function startNativeThread(params: {
  proc: CodexAppServerProcess;
  model: string;
  developerInstructions?: string;
  config?: Record<string, unknown>;
}): Promise<{
  threadId: string;
  developerInstructionsAccepted: boolean;
  threadSource?: string;
}> {
  const threadStartParams: Record<string, unknown> = {
    model: params.model,
    ephemeral: false,
    persistExtendedHistory: true,
    approvalPolicy: "never",
    serviceName: CODEX_APP_SERVER_SERVICE_NAME,
    ...(params.config ? { config: params.config } : {}),
    ...(params.developerInstructions
      ? { developerInstructions: params.developerInstructions }
      : {}),
  };
  let developerInstructionsAccepted = true;
  let threadResult: unknown;
  try {
    threadResult = await params.proc.sendRequest("thread/start", threadStartParams);
  } catch (error) {
    if (
      !params.developerInstructions ||
      !isCodexAppServerThreadStartInstructionsUnsupportedError(error)
    ) {
      throw error;
    }
    const fallbackParams = { ...threadStartParams };
    delete fallbackParams.developerInstructions;
    developerInstructionsAccepted = false;
    ztoolkit.log(
      "Codex app-server native: thread/start developerInstructions unsupported; using visible context fallback",
    );
    threadResult = await params.proc.sendRequest("thread/start", fallbackParams);
  }
  const threadId = extractCodexAppServerThreadId(threadResult);
  if (!threadId) {
    throw new Error("Codex app-server did not return a thread ID");
  }
  return {
    threadId,
    developerInstructionsAccepted,
    threadSource: extractCodexAppServerThreadSource(threadResult),
  };
}

async function resumeNativeThread(params: {
  proc: CodexAppServerProcess;
  threadId: string;
  model: string;
  developerInstructions?: string;
  config?: Record<string, unknown>;
}): Promise<{
  threadId: string;
  developerInstructionsAccepted: boolean;
  threadSource?: string;
}> {
  const threadResumeParams: Record<string, unknown> = {
    threadId: params.threadId,
    model: params.model,
    persistExtendedHistory: true,
    ...(params.config ? { config: params.config } : {}),
    ...(params.developerInstructions
      ? { developerInstructions: params.developerInstructions }
      : {}),
  };
  let developerInstructionsAccepted = true;
  let threadResult: unknown;
  try {
    threadResult = await params.proc.sendRequest(
      "thread/resume",
      threadResumeParams,
    );
  } catch (error) {
    if (
      !params.developerInstructions ||
      !isCodexAppServerThreadStartInstructionsUnsupportedError(error)
    ) {
      throw error;
    }
    const fallbackParams = { ...threadResumeParams };
    delete fallbackParams.developerInstructions;
    developerInstructionsAccepted = false;
    ztoolkit.log(
      "Codex app-server native: thread/resume developerInstructions unsupported; using visible context fallback",
    );
    threadResult = await params.proc.sendRequest(
      "thread/resume",
      fallbackParams,
    );
  }
  const threadId = extractCodexAppServerThreadId(threadResult);
  if (!threadId) {
    throw new Error("Codex app-server did not return a thread ID");
  }
  return {
    threadId,
    developerInstructionsAccepted,
    threadSource: extractCodexAppServerThreadSource(threadResult),
  };
}

async function resolveNativeThread(params: {
  proc: CodexAppServerProcess;
  scope: CodexNativeConversationScope;
  model: string;
  effort?: string;
  developerInstructions?: string;
  config?: Record<string, unknown>;
  hooks?: CodexNativeStoreHooks;
}): Promise<NativeThreadResolution> {
  const storedThreadId = await loadStoredProviderSessionId({
    conversationKey: params.scope.conversationKey,
    hooks: params.hooks,
  });
  if (storedThreadId) {
    try {
      const resumedThread = await resumeNativeThread({
        proc: params.proc,
        threadId: storedThreadId,
        model: params.model,
        developerInstructions: params.developerInstructions,
        config: params.config,
      });
      return { ...resumedThread, resumed: true };
    } catch (error) {
      ztoolkit.log(
        "Codex app-server native: thread/resume failed; starting a new persistent thread",
        error,
      );
    }
  }

  const thread = await startNativeThread({
    proc: params.proc,
    model: params.model,
    developerInstructions: params.developerInstructions,
    config: params.config,
  });
  await persistProviderSessionId({
    scope: params.scope,
    threadId: thread.threadId,
    model: params.model,
    effort: params.effort,
    hooks: params.hooks,
  });
  return { ...thread, resumed: false };
}

async function setNativeThreadName(params: {
  proc: CodexAppServerProcess;
  threadId: string;
  name?: string;
}): Promise<void> {
  const name = normalizeNonEmptyString(params.name).slice(0, 120);
  if (!name) return;
  try {
    await params.proc.sendRequest("thread/name/set", {
      threadId: params.threadId,
      name,
    });
  } catch (error) {
    ztoolkit.log("Codex app-server native: failed to sync thread title", error);
  }
}

function registerNativeApprovalRequestHandlers(params: {
  proc: CodexAppServerProcess;
  onApprovalRequest?: (
    request: CodexNativeApprovalRequest,
  ) => unknown | Promise<unknown>;
}): () => void {
  const disposers = CODEX_APP_SERVER_APPROVAL_REQUEST_METHODS.map((method) =>
    params.proc.onRequest(method, async (rawParams) => {
      if (params.onApprovalRequest) {
        return params.onApprovalRequest({ method, params: rawParams });
      }
      const safeDecision = resolveSafeCodexNativeApprovalRequest({
        method,
        params: rawParams,
      });
      if (safeDecision) return safeDecision;
      return {
        approved: false,
        error:
          "Zotero has not enabled native Codex app-server approval UI yet.",
      };
    }),
  );
  return () => {
    for (const dispose of disposers) dispose();
  };
}

export async function listCodexAppServerModels(params: {
  codexPath?: string;
  includeHidden?: boolean;
  processKey?: string;
} = {}): Promise<unknown> {
  const codexPath = resolveCodexAppServerBinaryPath(params.codexPath);
  const proc = await getOrCreateCodexAppServerProcess(
    params.processKey || CODEX_APP_SERVER_NATIVE_PROCESS_KEY,
    { codexPath },
  );
  return proc.sendRequest("model/list", {
    includeHidden: params.includeHidden === true,
  });
}

export async function forkCodexAppServerThread(params: {
  threadId: string;
  codexPath?: string;
  processKey?: string;
}): Promise<string> {
  const codexPath = resolveCodexAppServerBinaryPath(params.codexPath);
  const proc = await getOrCreateCodexAppServerProcess(
    params.processKey || CODEX_APP_SERVER_NATIVE_PROCESS_KEY,
    { codexPath },
  );
  const result = await proc.sendRequest("thread/fork", {
    threadId: params.threadId,
  });
  const threadId = extractCodexAppServerThreadId(result);
  if (!threadId) throw new Error("Codex app-server did not return a thread ID");
  return threadId;
}

export async function archiveCodexAppServerThread(params: {
  threadId: string;
  codexPath?: string;
  processKey?: string;
}): Promise<void> {
  const codexPath = resolveCodexAppServerBinaryPath(params.codexPath);
  const proc = await getOrCreateCodexAppServerProcess(
    params.processKey || CODEX_APP_SERVER_NATIVE_PROCESS_KEY,
    { codexPath },
  );
  await proc.sendRequest("thread/archive", { threadId: params.threadId });
}

export async function setCodexAppServerThreadName(params: {
  threadId: string;
  name: string;
  codexPath?: string;
  processKey?: string;
}): Promise<void> {
  const name = params.name.trim();
  if (!name) return;
  const codexPath = resolveCodexAppServerBinaryPath(params.codexPath);
  const proc = await getOrCreateCodexAppServerProcess(
    params.processKey || CODEX_APP_SERVER_NATIVE_PROCESS_KEY,
    { codexPath },
  );
  await proc.sendRequest("thread/name/set", {
    threadId: params.threadId,
    name: name.slice(0, 120),
  });
}

export async function compactCodexAppServerThread(params: {
  threadId: string;
  codexPath?: string;
  processKey?: string;
}): Promise<void> {
  const codexPath = resolveCodexAppServerBinaryPath(params.codexPath);
  const proc = await getOrCreateCodexAppServerProcess(
    params.processKey || CODEX_APP_SERVER_NATIVE_PROCESS_KEY,
    { codexPath },
  );
  await proc.sendRequest("thread/compact/start", {
    threadId: params.threadId,
  });
}

async function verifyCodexAppServerThreadHistory(params: {
  proc: CodexAppServerProcess;
  threadId: string;
}): Promise<boolean> {
  try {
    await params.proc.sendRequest("thread/read", {
      threadId: params.threadId,
      includeTurns: true,
    });
    return true;
  } catch (error) {
    ztoolkit.log(
      "Codex app-server native: thread/read verification failed",
      error,
    );
    return false;
  }
}

function buildNativeDiagnostics(params: {
  thread: NativeThreadResolution;
  profileSignature: string;
  scope: CodexNativeConversationScope;
  mcpServerName?: string;
  mcpReady: boolean;
  mcpStatus?: CodexNativeMcpSetupStatus;
  historyVerified?: boolean;
}): CodexNativeDiagnostics {
  return {
    threadId: params.thread.threadId,
    threadSource: params.thread.threadSource,
    profileSignature: params.profileSignature,
    libraryID: params.scope.libraryID,
    libraryName: params.scope.libraryName,
    mcpServerName: params.mcpServerName,
    mcpReady: params.mcpReady,
    mcpToolNames: params.mcpStatus?.toolNames || [],
    historyVerified: params.historyVerified,
  };
}

export async function runCodexAppServerNativeTurn(params: {
  scope: CodexNativeConversationScope;
  model: string;
  messages: ChatMessage[];
  reasoning?: ReasoningConfig;
  signal?: AbortSignal;
  codexPath?: string;
  processKey?: string;
  hooks?: CodexNativeStoreHooks;
  onDelta?: (delta: string) => void;
  onAgentMessageDelta?: (
    event: CodexAppServerAgentMessageDeltaEvent,
  ) => void;
  onReasoning?: (event: ReasoningEvent) => void;
  onUsage?: (usage: UsageStats) => void;
  onItemStarted?: (event: CodexAppServerItemEvent) => void;
  onItemCompleted?: (event: CodexAppServerItemEvent) => void;
  onTurnCompleted?: (event: { turnId: string; status?: string }) => void;
  onMcpSetupWarning?: (message: string) => void;
  onDiagnostics?: (diagnostics: CodexNativeDiagnostics) => void;
  onApprovalRequest?: (
    request: CodexNativeApprovalRequest,
  ) => unknown | Promise<unknown>;
}): Promise<CodexNativeTurnResult> {
  const codexPath = resolveCodexAppServerBinaryPath(params.codexPath);
  const processKey = params.processKey || CODEX_APP_SERVER_NATIVE_PROCESS_KEY;
  const proc = await getOrCreateCodexAppServerProcess(processKey, {
    codexPath,
  });
  return proc.runTurnExclusive(async () => {
    const unregisterApprovalHandlers = registerNativeApprovalRequestHandlers({
      proc,
      onApprovalRequest: params.onApprovalRequest,
    });
    const mcpEnabled = isCodexZoteroMcpToolsEnabled();
    const profileSignature =
      normalizeNonEmptyString(params.scope.profileSignature) ||
      getCodexProfileSignature();
    const latestUserText = extractLatestUserText(params.messages);
    const scopedMcp = mcpEnabled
      ? registerScopedZoteroMcpScope({
          ...params.scope,
          profileSignature,
          userText: latestUserText,
        })
      : null;
    const mcpThreadConfig = scopedMcp
      ? buildCodexZoteroMcpThreadConfig({
          profileSignature,
          scopeToken: scopedMcp.token,
          required: true,
        })
      : null;
    const threadConfig = mcpThreadConfig?.config || {
      features: {
        shell_tool: false,
      },
    };
    let mcpReady = !mcpEnabled;
    let mcpWarning = "";
    let mcpStatus: CodexNativeMcpSetupStatus | undefined;
    const clearMcpScope = mcpEnabled
      ? setActiveZoteroMcpScope({
          ...params.scope,
          profileSignature,
          userText: latestUserText,
        })
      : () => undefined;
    try {
      const reasoningParams = resolveCodexAppServerReasoningParams(
        params.reasoning,
        params.model,
      );
      const optimisticMcpReady = mcpEnabled;
      const plainNativeMessages = buildNativeMessages({
        messages: params.messages,
        includeVisibleHistory: true,
        zoteroEnvironmentText: buildZoteroEnvironmentManifest({
          scope: { ...params.scope, profileSignature },
          mcpEnabled,
          mcpReady: optimisticMcpReady,
          mcpWarning,
        }),
      });
      const plainPreparedTurn =
        await prepareCodexAppServerChatTurn(plainNativeMessages);
      if (mcpEnabled && mcpThreadConfig && scopedMcp) {
        try {
          mcpStatus = await preflightCodexZoteroMcpServer({
            serverName: mcpThreadConfig.serverName,
            scopeToken: scopedMcp.token,
            required: true,
          });
          assertRequiredCodexZoteroMcpToolsReady(mcpStatus);
          mcpReady = true;
        } catch (error) {
          mcpReady = false;
          mcpWarning = `Zotero MCP setup failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
          params.onMcpSetupWarning?.(mcpWarning);
          ztoolkit.log(
            "Codex app-server native: Zotero MCP preflight failed",
            error,
          );
          throw new Error(mcpWarning);
        }
      }
      const thread = await resolveNativeThread({
        proc,
        scope: { ...params.scope, profileSignature },
        model: params.model,
        effort: reasoningParams.effort,
        developerInstructions: plainPreparedTurn.developerInstructions,
        config: threadConfig,
        hooks: params.hooks,
      });
      if (!thread.resumed) {
        await setNativeThreadName({
          proc,
          threadId: thread.threadId,
          name: params.scope.title,
        });
      }
      if (mcpEnabled && mcpThreadConfig) {
        try {
          const appServerMcpStatus = await readCodexNativeMcpSetupStatus({
            proc,
            serverName: mcpThreadConfig.serverName,
          });
          if (appServerMcpStatus.connected === true) {
            mcpStatus = appServerMcpStatus;
          } else {
            ztoolkit.log(
              "Codex app-server native: per-thread MCP passed preflight but is absent from mcpServerStatus/list",
              appServerMcpStatus,
            );
          }
        } catch (error) {
          ztoolkit.log(
            "Codex app-server native: MCP diagnostics status lookup failed",
            error,
          );
        }
      }
      params.onDiagnostics?.(
        buildNativeDiagnostics({
          thread,
          profileSignature,
          scope: params.scope,
          mcpServerName: mcpThreadConfig?.serverName,
          mcpReady,
          mcpStatus,
        }),
      );
      const nativeMessages = buildNativeMessages({
        messages: params.messages,
        includeVisibleHistory: true,
        zoteroEnvironmentText: buildZoteroEnvironmentManifest({
          scope: { ...params.scope, profileSignature },
          mcpEnabled,
          mcpReady,
          mcpWarning,
        }),
        prefixLatestUserWithContext: !thread.developerInstructionsAccepted,
      });
      const preparedTurn = thread.developerInstructionsAccepted
        ? plainPreparedTurn
        : await prepareCodexAppServerChatTurn(nativeMessages);
      const input = await resolveCodexAppServerTurnInputWithFallback({
        proc,
        threadId: thread.threadId,
        historyItemsToInject: thread.resumed ? [] : preparedTurn.historyItemsToInject,
        turnInput: preparedTurn.turnInput,
        legacyInputFactory: () => buildLegacyCodexAppServerChatInput(nativeMessages),
        logContext: "native",
      });
      const turnResult = await proc.sendRequest("turn/start", {
        threadId: thread.threadId,
        input,
        model: params.model,
        approvalPolicy: "never",
        ...reasoningParams,
      });
      const turnId = extractCodexAppServerTurnId(turnResult);
      if (!turnId) {
        throw new Error("Codex app-server did not return a turn ID");
      }
      const text = await waitForCodexAppServerTurnCompletion({
        proc,
        threadId: thread.threadId,
        turnId,
        onTextDelta: params.onDelta,
        onAgentMessageDelta: params.onAgentMessageDelta,
        onReasoning: params.onReasoning,
        onUsage: params.onUsage,
        onItemStarted: params.onItemStarted,
        onItemCompleted: params.onItemCompleted,
        onTurnCompleted: params.onTurnCompleted,
        signal: params.signal,
        interruptOnAbort: true,
        cacheKey: processKey,
        processOptions: { codexPath },
      });
      const historyVerified = await verifyCodexAppServerThreadHistory({
        proc,
        threadId: thread.threadId,
      });
      const diagnostics = buildNativeDiagnostics({
        thread,
        profileSignature,
        scope: params.scope,
        mcpServerName: mcpThreadConfig?.serverName,
        mcpReady,
        mcpStatus,
        historyVerified,
      });
      params.onDiagnostics?.(diagnostics);
      return {
        text,
        threadId: thread.threadId,
        resumed: thread.resumed,
        diagnostics,
      };
    } finally {
      scopedMcp?.clear();
      clearMcpScope();
      unregisterApprovalHandlers();
    }
  });
}
