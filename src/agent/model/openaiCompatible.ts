import { usesMaxCompletionTokens } from "../../utils/apiHelpers";
import {
  buildReasoningPayload,
  postWithReasoningFallback,
  resolveRequestAuthState,
} from "../../utils/llmClient";
import { normalizeMaxTokens, normalizeTemperature } from "../../utils/normalization";
import { resolveProviderTransportEndpoint } from "../../utils/providerTransport";
import type {
  AgentModelCapabilities,
  AgentModelMessage,
  AgentModelStep,
  AgentRuntimeRequest,
  AgentToolCall,
} from "../types";
import type { AgentModelAdapter, AgentStepParams } from "./adapter";
import { isMultimodalRequestSupported } from "./messageBuilder";
import {
  buildOpenAIFunctionTools,
  createFallbackToolCallId,
  parseToolCallArguments,
} from "./shared";

type ChatCompletionChoice = {
  message?: {
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    thinking?: string | null;
    tool_calls?: Array<{
      id?: string;
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
  };
};

function isToolCapableApiBase(request: AgentRuntimeRequest): boolean {
  const apiBase = (request.apiBase || "").trim();
  if (!apiBase) return false;
  if (request.authMode === "codex_auth") return false;
  return true;
}

function buildMessagesPayload(messages: AgentModelMessage[]) {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.tool_call_id,
        name: message.name,
      };
    }
    return {
      role: message.role,
      content:
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type !== "file_ref")
              .map((part) =>
                part.type === "text"
                  ? part
                  : {
                      type: "image_url" as const,
                      image_url: part.image_url,
                    },
              ),
      ...(message.role === "assistant" &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length
        ? {
            tool_calls: message.tool_calls.map((call: AgentToolCall) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments ?? {}),
              },
            })),
          }
        : {}),
    };
  });
}

function normalizeToolCalls(
  toolCalls:
    | Array<{
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>
    | undefined,
): AgentToolCall[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .map((call, index) => {
      const name = call?.function?.name?.trim();
      if (!name) return null;
      return {
        id: call?.id?.trim() || createFallbackToolCallId("tool", index),
        name,
        arguments: parseToolCallArguments(call?.function?.arguments),
      };
    })
    .filter((call): call is AgentToolCall => Boolean(call));
}

export class OpenAIChatCompatAgentAdapter implements AgentModelAdapter {
  getCapabilities(request: AgentRuntimeRequest): AgentModelCapabilities {
    return {
      streaming: false,
      toolCalls: isToolCapableApiBase(request),
      multimodal: isMultimodalRequestSupported(request),
      fileInputs: false,
      reasoning: true,
    };
  }

  supportsTools(request: AgentRuntimeRequest): boolean {
    return this.getCapabilities(request).toolCalls;
  }

  async runStep(params: AgentStepParams): Promise<AgentModelStep> {
    const request = params.request;
    const auth = await resolveRequestAuthState({
      authMode: request.authMode || "api_key",
      apiKey: request.apiKey || "",
      signal: params.signal,
    });
    const url = resolveProviderTransportEndpoint({
      protocol: "openai_chat_compat",
      apiBase: request.apiBase || "",
    });
    const response = await postWithReasoningFallback({
      url,
      auth,
      modelName: request.model,
      initialReasoning: request.reasoning,
      buildPayload: (reasoningOverride) => {
        const reasoningPayload = buildReasoningPayload(
          reasoningOverride,
          false,
          request.model,
          request.apiBase,
        );
        return {
          model: request.model,
          messages: buildMessagesPayload(params.messages),
          tools: buildOpenAIFunctionTools(params.tools),
          tool_choice: "auto",
          ...(usesMaxCompletionTokens(request.model || "")
            ? {
                max_completion_tokens: normalizeMaxTokens(
                  request.advanced?.maxTokens,
                ),
              }
            : {
                max_tokens: normalizeMaxTokens(request.advanced?.maxTokens),
              }),
          ...reasoningPayload.extra,
          ...(reasoningPayload.omitTemperature
            ? {}
            : {
                temperature: normalizeTemperature(request.advanced?.temperature),
              }),
        };
      },
      signal: params.signal,
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `${response.status} ${response.statusText} - ${errorText}`,
      );
    }
    const data = (await response.json()) as { choices?: ChatCompletionChoice[] };
    const message = data.choices?.[0]?.message;
    const reasoningText =
      message?.reasoning_content ||
      message?.reasoning ||
      message?.thinking ||
      "";
    if (reasoningText && params.onReasoning) {
      await params.onReasoning({ details: reasoningText });
    }
    const toolCalls = normalizeToolCalls(message?.tool_calls);
    if (toolCalls.length) {
      return {
        kind: "tool_calls",
        calls: toolCalls,
        assistantMessage: {
          role: "assistant",
          content: typeof message?.content === "string" ? message.content : "",
          tool_calls: toolCalls,
        },
      };
    }
    return {
      kind: "final",
      text: typeof message?.content === "string" ? message.content : "",
      assistantMessage: {
        role: "assistant",
        content: typeof message?.content === "string" ? message.content : "",
      },
    };
  }
}

export { OpenAIChatCompatAgentAdapter as OpenAICompatibleAgentAdapter };
