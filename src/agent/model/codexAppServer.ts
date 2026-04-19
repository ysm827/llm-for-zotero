import type {
  AgentModelCapabilities,
  AgentRuntimeRequest,
  AgentModelStep,
} from "../types";
import type { AgentModelAdapter, AgentStepParams } from "./adapter";
import type { AgentModelMessage } from "../types";
import {
  getOrCreateCodexAppServerProcess,
  waitForCodexAppServerTurnCompletion,
} from "../../utils/codexAppServerProcess";

function extractLatestUserText(messages: AgentModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      const textParts = msg.content
        .filter((p: unknown) => (p as any)?.type === "text")
        .map((p: unknown) => (p as any).text as string);
      if (textParts.length > 0) return textParts.join("\n");
    }
  }
  return "";
}

export class CodexAppServerAdapter implements AgentModelAdapter {
  private threadId: string | null = null;
  private processKey: string;

  constructor(processKey = "default") {
    this.processKey = processKey;
  }

  getCapabilities(_request: AgentRuntimeRequest): AgentModelCapabilities {
    return {
      streaming: true,
      toolCalls: false,
      multimodal: false,
      fileInputs: false,
      reasoning: false,
    };
  }

  supportsTools(_request: AgentRuntimeRequest): boolean {
    // AgentRuntime uses this as a coarse "can enter the agent loop" gate.
    // The app-server transport does not expose local plugin tool calls, but it
    // still needs to run turns through runStep() instead of forcing fallback.
    return true;
  }

  async runStep(params: AgentStepParams): Promise<AgentModelStep> {
    const request = params.request;
    const proc = await getOrCreateCodexAppServerProcess(this.processKey);

    if (!this.threadId) {
      const threadResp = await proc.sendRequest("thread/start", {
        model: request.model,
        approvalPolicy: "never",
      }) as { thread: { id: string } };
      this.threadId = threadResp.thread.id;
    }

    const userText = extractLatestUserText(params.messages);

    const turnResp = await proc.sendRequest("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: userText }],
    }) as { turn: { id: string } };
    const turnId = turnResp.turn.id;

    const text = await waitForCodexAppServerTurnCompletion({
      proc,
      turnId,
      onTextDelta: params.onTextDelta,
      signal: params.signal,
    });

    const assistantMessage = { role: "assistant" as const, content: text };
    return { kind: "final", text, assistantMessage };
  }
}
