import { getRuntimePlatformInfo } from "./runtimePlatform";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

type NotificationHandler = (params: unknown) => void;

export class CodexAppServerProcess {
  private proc: unknown;
  private nextId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private readLoopPromise: Promise<void> | null = null;
  private lineBuffer = "";
  private destroyed = false;

  private constructor(proc: unknown) {
    this.proc = proc;
  }

  static async spawn(): Promise<CodexAppServerProcess> {
    const CU = (globalThis as any).ChromeUtils;
    let Subprocess: any;
    if (CU?.importESModule) {
      try {
        const mod = CU.importESModule("resource://gre/modules/Subprocess.sys.mjs");
        Subprocess = mod.Subprocess || mod.default || mod;
      } catch { /* fallback */ }
    }
    if (!Subprocess?.call && CU?.import) {
      try {
        const mod = CU.import("resource://gre/modules/Subprocess.jsm");
        Subprocess = mod.Subprocess || mod;
      } catch { /* fallback */ }
    }
    if (!Subprocess?.call) {
      throw new Error("Subprocess module not available in this Zotero environment");
    }

    const info = getRuntimePlatformInfo();

    // On Windows, npm shims are batch scripts that can't be exec'd directly.
    // Run via the shell instead (cmd.exe /c codex app-server), same as runCommand.ts.
    // On macOS/Linux, resolve the absolute binary path and exec directly.
    let command: string;
    let args: string[];
    if (info.platform === "windows") {
      command = info.shellPath;
      args = [info.shellFlag, "codex app-server"];
    } else {
      const binary = await resolveCodexBinary();
      command = binary;
      args = ["app-server"];
    }

    let proc: any;
    try {
      proc = await Subprocess.call({
        command,
        arguments: args,
      });
    } catch (err) {
      throw new Error(
        `Failed to spawn codex app-server (command: ${command} ${args.join(" ")}): ${err instanceof Error ? err.message : JSON.stringify(err)}`,
      );
    }

    const instance = new CodexAppServerProcess(proc);
    instance.startReadLoop();
    await instance.initialize();
    return instance;
  }

  private startReadLoop(): void {
    const proc = this.proc as any;
    this.readLoopPromise = (async () => {
      while (!this.destroyed) {
        let chunk: string;
        try {
          chunk = await proc.stdout.readString();
        } catch {
          break;
        }
        if (!chunk) break;
        this.lineBuffer += chunk;
        const lines = this.lineBuffer.split("\n");
        this.lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            this.handleMessage(JSON.parse(trimmed));
          } catch {
            Zotero.debug?.(`[llm-for-zotero] codex app-server: failed to parse line: ${trimmed}`);
          }
        }
      }
      // Reject all pending requests on pipe close
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error("codex app-server process closed unexpectedly"));
      }
      this.pendingRequests.clear();
    })();
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if ("id" in msg && msg.id !== null && msg.id !== undefined) {
      const id = msg.id as number;
      const pending = this.pendingRequests.get(id);
      if (!pending) return;
      this.pendingRequests.delete(id);
      if ("error" in msg) {
        pending.reject(new Error(String((msg.error as any)?.message ?? msg.error)));
      } else {
        pending.resolve(msg.result);
      }
    } else if (typeof msg.method === "string") {
      const handlers = this.notificationHandlers.get(msg.method);
      if (handlers) {
        for (const handler of handlers) {
          try { handler(msg.params); } catch { /* ignore */ }
        }
      }
    }
  }

  sendRequest(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pendingRequests.set(id, { resolve, reject });
      const msg = JSON.stringify({ method, id, params }) + "\n";
      try {
        (this.proc as any).stdin.write(msg);
      } catch (err) {
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  sendNotification(method: string, params?: unknown): void {
    const msg = JSON.stringify({ method, params }) + "\n";
    try {
      (this.proc as any).stdin.write(msg);
    } catch { /* ignore if process is gone */ }
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => {
      this.notificationHandlers.get(method)?.delete(handler);
    };
  }

  private async initialize(): Promise<void> {
    await this.sendRequest("initialize", {
      clientInfo: { name: "llm-for-zotero", version: "1.0" },
    });
    this.sendNotification("initialized");
  }

  destroy(): void {
    this.destroyed = true;
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error("CodexAppServerProcess destroyed"));
    }
    this.pendingRequests.clear();
    try { (this.proc as any).kill(); } catch { /* ignore */ }
  }
}

export function waitForCodexAppServerTurnCompletion(params: {
  proc: CodexAppServerProcess;
  turnId: string;
  onTextDelta?: (delta: string) => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<string> {
  const { proc, turnId, onTextDelta, signal } = params;
  return new Promise((resolve, reject) => {
    let accumulated = "";
    let settled = false;

    function settle(fn: () => void) {
      if (settled) return;
      settled = true;
      unsubDelta();
      unsubCompleted();
      fn();
    }

    // item/agentMessage/delta has no turnId — only one turn is active at a time
    const unsubDelta = proc.onNotification(
      "item/agentMessage/delta",
      (rawParams: unknown) => {
        const notification = rawParams as { delta?: string };
        const delta = notification.delta ?? "";
        if (!delta) return;
        accumulated += delta;
        try {
          onTextDelta?.(delta);
        } catch {
          // Ignore downstream consumer errors so the transport can finish cleanly.
        }
      },
    );

    const unsubCompleted = proc.onNotification(
      "turn/completed",
      (rawParams: unknown) => {
        const notification = rawParams as {
          turn?: { id?: string; status?: string };
          turnId?: string;
          status?: string;
        };
        const completedTurnId =
          typeof notification.turn?.id === "string"
            ? notification.turn.id
            : typeof notification.turnId === "string"
              ? notification.turnId
              : "";
        if (completedTurnId !== turnId) return;
        const status =
          typeof notification.turn?.status === "string"
            ? notification.turn.status
            : typeof notification.status === "string"
              ? notification.status
              : undefined;
        if (status === "completed") {
          settle(() => resolve(accumulated));
          return;
        }
        settle(() =>
          reject(
            new Error(`Turn ended with status: ${status ?? "unknown"}`),
          ),
        );
      },
    );

    signal?.addEventListener("abort", () => {
      settle(() => reject(new DOMException("Aborted", "AbortError")));
    });
  });
}

async function resolveCodexBinary(): Promise<string> {
  const info = getRuntimePlatformInfo();
  const env = (globalThis as any).process?.env ?? {};

  // 1. CODEX_PATH env var
  if (env.CODEX_PATH?.trim()) return env.CODEX_PATH.trim();

  // 2. Locate via `which`/`where` using shell
  const CU = (globalThis as any).ChromeUtils;
  let Subprocess: any;
  if (CU?.importESModule) {
    try {
      const mod = CU.importESModule("resource://gre/modules/Subprocess.sys.mjs");
      Subprocess = mod.Subprocess || mod.default || mod;
    } catch { /* fallback */ }
  }
  if (!Subprocess?.call && CU?.import) {
    try {
      const mod = CU.import("resource://gre/modules/Subprocess.jsm");
      Subprocess = mod.Subprocess || mod;
    } catch { /* fallback */ }
  }

  if (Subprocess?.call) {
    try {
      const lookupCmd = info.platform === "windows" ? "where codex" : "which codex";
      const proc = await Subprocess.call({
        command: info.shellPath,
        arguments: [info.shellFlag, lookupCmd],
      });
      let out = "";
      try {
        while (true) {
          const chunk = await proc.stdout.readString();
          if (!chunk) break;
          out += chunk;
        }
      } catch { /* ignore */ }
      await proc.wait();
      const found = out.trim().split("\n")[0]?.trim();
      if (found) return found;
    } catch { /* continue to fallback */ }
  }

  // 3. Common install paths
  const candidates = info.platform === "windows"
    ? [
        `${env.USERPROFILE ?? "C:\\Users\\User"}\\.cargo\\bin\\codex.exe`,
        "C:\\Program Files\\codex\\codex.exe",
      ]
    : [
        `${env.HOME ?? "~"}/.cargo/bin/codex`,
        "/usr/local/bin/codex",
        "/usr/bin/codex",
      ];

  const IOUtils = (globalThis as any).IOUtils;
  if (IOUtils?.exists) {
    for (const candidate of candidates) {
      try {
        if (await IOUtils.exists(candidate)) return candidate;
      } catch { /* continue */ }
    }
  }

  throw new Error(
    'codex binary not found. Install Codex CLI (https://github.com/openai/codex) and ensure it is on your PATH, ' +
    'or set the CODEX_PATH environment variable to the absolute path of the codex executable.',
  );
}

// Per-auth-mode singleton processes
const processCache = new Map<string, Promise<CodexAppServerProcess>>();

export async function getOrCreateCodexAppServerProcess(
  cacheKey: string,
): Promise<CodexAppServerProcess> {
  const existing = processCache.get(cacheKey);
  if (existing) {
    return existing.catch(() => {
      processCache.delete(cacheKey);
      return getOrCreateCodexAppServerProcess(cacheKey);
    });
  }
  const promise = CodexAppServerProcess.spawn();
  processCache.set(cacheKey, promise);
  promise.catch(() => processCache.delete(cacheKey));
  return promise;
}
