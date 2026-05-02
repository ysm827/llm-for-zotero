import {
  buildZoteroMcpConfigValue,
  getZoteroMcpAllowedToolNames,
  getZoteroMcpServerUrl,
  ZOTERO_MCP_SERVER_NAME,
} from "../agent/mcp/server";
import {
  getOrCreateCodexAppServerProcess,
  resolveCodexAppServerBinaryPath,
  type CodexAppServerProcess,
} from "../utils/codexAppServerProcess";

const DEFAULT_CODEX_APP_SERVER_NATIVE_PROCESS_KEY = "codex_app_server_native";

export type CodexNativeMcpSetupStatus = {
  enabled: boolean;
  serverName: string;
  serverUrl: string;
  configured: boolean;
  connected: boolean | null;
  toolNames: string[];
  config?: unknown;
  mcpStatus?: unknown;
  skills?: unknown;
  plugins?: unknown;
  errors: string[];
};

type SetupParams = {
  codexPath?: string;
  processKey?: string;
  proc?: CodexAppServerProcess;
};

async function resolveProcess(
  params: SetupParams,
): Promise<CodexAppServerProcess> {
  if (params.proc) return params.proc;
  const codexPath = resolveCodexAppServerBinaryPath(params.codexPath);
  return getOrCreateCodexAppServerProcess(
    params.processKey || DEFAULT_CODEX_APP_SERVER_NATIVE_PROCESS_KEY,
    { codexPath },
  );
}

async function sendOptional(
  proc: CodexAppServerProcess,
  method: string,
  params?: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await proc.sendRequest(method, params) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function collectToolNames(value: unknown, names = new Set<string>()): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectToolNames(entry, names);
    return Array.from(names);
  }
  if (!value || typeof value !== "object") return Array.from(names);
  const record = value as Record<string, unknown>;
  const type = normalizeString(record.type).toLowerCase();
  const name = normalizeString(record.name);
  if (name && (!type || type.includes("tool") || record.inputSchema)) {
    names.add(name);
  }
  for (const nested of Object.values(record)) {
    if (nested && typeof nested === "object") collectToolNames(nested, names);
  }
  return Array.from(names);
}

function objectContainsServerName(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(objectContainsServerName);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  for (const key of ["name", "serverName", "id"]) {
    if (normalizeString(record[key]) === ZOTERO_MCP_SERVER_NAME) return true;
  }
  return Object.values(record).some(objectContainsServerName);
}

function objectContainsServerUrl(value: unknown): boolean {
  const url = getZoteroMcpServerUrl();
  if (Array.isArray(value)) return value.some(objectContainsServerUrl);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (Object.values(record).some((entry) => normalizeString(entry) === url)) {
    return true;
  }
  return Object.values(record).some(objectContainsServerUrl);
}

function resolveConnected(mcpStatus: unknown): boolean | null {
  if (!mcpStatus) return null;
  if (!objectContainsServerName(mcpStatus)) return false;
  const serialized = JSON.stringify(mcpStatus).toLowerCase();
  if (
    serialized.includes('"status":"failed"') ||
    serialized.includes('"status":"error"') ||
    serialized.includes('"authstatus":"error"')
  ) {
    return false;
  }
  return true;
}

export async function readCodexNativeMcpSetupStatus(
  params: SetupParams = {},
): Promise<CodexNativeMcpSetupStatus> {
  const proc = await resolveProcess(params);
  const errors: string[] = [];

  const [configResult, statusResult, skillsResult, pluginsResult] =
    await Promise.all([
      sendOptional(proc, "config/read"),
      sendOptional(proc, "mcpServerStatus/list", {
        detail: "toolsAndAuthOnly",
        limit: 100,
      }),
      sendOptional(proc, "skills/list", { cwds: [] }),
      sendOptional(proc, "plugin/list", { limit: 100 }),
    ]);

  for (const result of [
    configResult,
    statusResult,
    skillsResult,
    pluginsResult,
  ]) {
    if (!result.ok) errors.push(result.error);
  }

  const configValue = configResult.ok ? configResult.value : undefined;
  const mcpStatus = statusResult.ok ? statusResult.value : undefined;
  return {
    enabled: true,
    serverName: ZOTERO_MCP_SERVER_NAME,
    serverUrl: getZoteroMcpServerUrl(),
    configured:
      objectContainsServerName(configValue) ||
      objectContainsServerUrl(configValue),
    connected: resolveConnected(mcpStatus),
    toolNames: collectToolNames(mcpStatus).filter((name) =>
      getZoteroMcpAllowedToolNames().includes(name),
    ),
    config: configValue,
    mcpStatus,
    skills: skillsResult.ok ? skillsResult.value : undefined,
    plugins: pluginsResult.ok ? pluginsResult.value : undefined,
    errors,
  };
}

export async function installOrUpdateCodexZoteroMcpConfig(
  params: SetupParams = {},
): Promise<CodexNativeMcpSetupStatus> {
  const proc = await resolveProcess(params);
  const value = buildZoteroMcpConfigValue();
  const dottedKeyPath = `mcp_servers.${ZOTERO_MCP_SERVER_NAME}`;
  const arrayKeyPath = ["mcp_servers", ZOTERO_MCP_SERVER_NAME];
  const writeAttempts = [
    { keyPath: dottedKeyPath, mergeStrategy: "upsert", value },
    { keyPath: dottedKeyPath, mergeStrategy: "replace", value },
    { keyPath: arrayKeyPath, value },
    { key: dottedKeyPath, value },
    { path: arrayKeyPath, value },
  ];
  const errors: string[] = [];
  let wroteConfig = false;
  for (const attempt of writeAttempts) {
    const result = await sendOptional(proc, "config/value/write", attempt);
    if (result.ok) {
      wroteConfig = true;
      break;
    }
    errors.push(result.error);
  }
  if (!wroteConfig) {
    throw new Error(`Failed to write Codex MCP config: ${errors.join("; ")}`);
  }

  const reload = await sendOptional(proc, "config/mcpServer/reload", {});
  if (!reload.ok) {
    ztoolkit.log("Codex app-server MCP reload failed", reload.error);
  }

  return readCodexNativeMcpSetupStatus({ ...params, proc });
}

export async function ensureCodexZoteroMcpConfig(
  params: SetupParams = {},
): Promise<void> {
  await installOrUpdateCodexZoteroMcpConfig(params);
}
