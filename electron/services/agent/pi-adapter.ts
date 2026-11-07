import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import type { Model, Usage } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import { apiBase, type AgentRunOptions, type AgentRunResult } from "./loop.ts";

/** Compatibility candidate. Business persistence stays outside the runtime. */
export async function runPiAgent(
  options: AgentRunOptions,
): Promise<AgentRunResult> {
  const { config, onEvent } = options;
  const result: AgentRunResult = {
    stopReason: "done",
    error: "",
    turns: 0,
    tokens: 0,
    text: "",
  };
  if (options.signal?.aborted) return { ...result, stopReason: "aborted" };
  const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const model: Model<"openai-completions"> = {
    id: config.model,
    name: config.model,
    api: "openai-completions",
    provider: "openai",
    baseUrl: apiBase(config.api_url),
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    compat: {
      supportsDeveloperRole: false,
      supportsStore: false,
      maxTokensField: "max_tokens",
    },
  };
  const messages: AgentMessage[] = (options.history || []).map((m) =>
    m.role === "user"
      ? { role: "user", content: m.content, timestamp: Date.now() }
      : {
          role: "assistant",
          content: [{ type: "text", text: m.content }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage,
          stopReason: "stop",
          timestamp: Date.now(),
        },
  );
  const repeats = new Map<string, number>();
  let lastError = "",
    errorCount = 0,
    lastPublish = 0;
  const agent = new Agent({
    initialState: {
      systemPrompt: options.system,
      model,
      messages,
      tools: options.tools.map((tool) => ({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: tool.parameters as TSchema,
        execute: async (_id, args, signal) => {
          if (signal?.aborted) throw new Error("任务已取消");
          const key = tool.name + JSON.stringify(args),
            count = (repeats.get(key) || 0) + 1;
          repeats.set(key, count);
          if (count > 3) throw new Error("相同工具调用重复过多，已暂停");
          const text = await tool.execute(args, signal);
          return {
            content: [
              {
                type: "text" as const,
                text: text.slice(0, tool.maxOutput || 6000),
              },
            ],
            details: undefined,
          };
        },
      })),
    },
    toolExecution: "sequential",
    identity: { attribution: null },
    streamFn: (_model, context, streamOptions) =>
      stream(model, context, {
        ...streamOptions,
        apiKey: config.api_key,
        signal: AbortSignal.any([
          ...(streamOptions?.signal ? [streamOptions.signal] : []),
          AbortSignal.timeout(120000),
        ]),
        toolChoice: options.tools.length
          ? options.toolChoice || "auto"
          : undefined,
      }),
    prepareRequest: ({ context }) => {
      if (
        JSON.stringify(context).length > (options.maxContextChars || 120000)
      ) {
        result.stopReason = "max_turns";
        result.error = "上下文达到预算，请续接对话";
        agent.abort();
      }
    },
    finishTurn: ({ message, toolResults }) => {
      if (message.role === "assistant" && message.stopReason === "error") {
        result.stopReason = "error";
        result.error = message.errorMessage || "模型请求失败";
      }
      if (errorCount >= 3) {
        result.stopReason = "error";
        result.error = lastError;
        return { action: "end" };
      }
      if (
        options.stopAfterToolSuccess &&
        toolResults.some(
          (r) => r.toolName === options.stopAfterToolSuccess && !r.isError,
        )
      )
        return { action: "end" };
      if (result.turns >= (options.maxTurns || 14) && toolResults.length) {
        result.stopReason = "max_turns";
        return { action: "end" };
      }
    },
  });
  agent.subscribe((event) => {
    if (event.type === "turn_start") {
      result.turns++;
      result.text = "";
      onEvent?.({ type: "turn", index: result.turns });
    }
    if (event.type === "message_update" && event.message.role === "assistant") {
      result.text = event.message.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      if (Date.now() - lastPublish > 80) {
        onEvent?.({ type: "text", text: result.text });
        lastPublish = Date.now();
      }
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      result.text = event.message.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      result.tokens += event.message.usage.totalTokens;
      onEvent?.({ type: "text", text: result.text });
      if (event.message.stopReason === "error") {
        result.stopReason = "error";
        result.error = event.message.errorMessage || "模型请求失败";
      }
    }
    if (event.type === "tool_execution_start")
      onEvent?.({ type: "tool_call", name: event.toolName, args: event.args });
    if (event.type === "tool_execution_end") {
      const text = event.result.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      if (event.isError) {
        errorCount = text === lastError ? errorCount + 1 : 1;
        lastError = text;
      } else {
        lastError = "";
        errorCount = 0;
      }
      onEvent?.({
        type: "tool_result",
        name: event.toolName,
        text,
        isError: event.isError,
        ms: event.durationMs,
      });
    }
  });
  const abort = () => agent.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    await agent.prompt(options.user);
  } catch (e) {
    result.stopReason = "error";
    result.error = (e as Error).message;
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
  if (options.signal?.aborted) result.stopReason = "aborted";
  return result;
}
