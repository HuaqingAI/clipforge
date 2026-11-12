/** TIDEWE script generation and shared LLM JSON completion helpers. */
import OpenAI from "openai";
import type { ScriptGenerationInput } from "./prompts";
import type { Shot } from "@/lib/db/schema";
import { createLLMClient, withLLMErrors, LLMRequestError, jsonModeParams } from "@/lib/llm-error";
import { stripThinkBlocks } from "@/lib/llm-clean";
import type { TideweCopyDocument } from "@/lib/tidewe/types";
import { generateTideweScripts, type TideweCompletion } from "@/lib/tidewe/generator";
import { tideweProfileForInput } from "@/lib/tidewe/prompts";

export interface LLMConfig {
  /** API base URL (any OpenAI-compatible endpoint) */
  baseUrl: string;
  /** API key */
  apiKey: string;
  /** Text model name */
  model: string;
  /** Vision model name (used for product image analysis; falls back to model if not specified) */
  visionModel?: string;
}

/** Script generation input parameters */
export interface ScriptInput extends ScriptGenerationInput {
  /** LLM configuration */
  llmConfig: LLMConfig;
}

/** Generated script result */
export interface GeneratedScript {
  copyDocument?: TideweCopyDocument;
  /** Script title */
  title: string;
  /** Script style */
  styleType: string;
  /** Total duration (seconds) */
  totalDuration: number;
  /** Shot list */
  shots: Shot[];
}

/** Streaming output callbacks */
export interface StreamCallbacks {
  /** Fired when a text token is received */
  onToken?: (token: string) => void;
  /** Fired when generation is complete */
  onComplete?: (scripts: GeneratedScript[]) => void;
  /** Fired when an error occurs */
  onError?: (error: Error) => void;
}

export function reasoningParams(
  baseUrl: string,
): { reasoning_effort?: "low"; enable_thinking?: boolean; thinking?: { type: "disabled" } } {
  const url = baseUrl || "";
  if (/pollinations\.ai/i.test(url)) return { reasoning_effort: "low" };
  if (/dashscope|siliconflow/i.test(url)) return { enable_thinking: false };
  if (/bigmodel\.cn/i.test(url)) return { thinking: { type: "disabled" } };
  return {};
}

export function extractJSON(text: string): string {
  text = stripThinkBlocks(text);
  // Try stripping markdown code block markers
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // Try finding the first { or [ to locate the JSON
  const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    return jsonMatch[1].trim();
  }

  return text.trim();
}

/** Parse the first response directly; only transport failures use the shared client's retries. */
export async function completeOnce<T>(
  client: OpenAI,
  params: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, "stream">,
  cfg: { baseUrl?: string; apiKey?: string; model?: string },
  parse: (content: string) => T,
): Promise<T> {
  const response = await withLLMErrors(() => client.chat.completions.create(params), cfg);
  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("LLM 未返回有效内容");
  return parse(content);
}

/**
 * Non-streaming chat call with ONE parse-driven retry ("repair first, then re-ask" — the last
 * rung of the JSON-robustness ladder): when the reply survives transport but fails to parse — bad JSON,
 * missing shots — the model gets its own output back plus the parse error and one chance to fix
 * it. Network/HTTP retries stay inside the SDK client; LLMRequestError parse failures are
 * capability verdicts ("this model can't write scripts"), not format slips, so they never retry.
 * Exported for reuse by other JSON-shaped call sites (judge panel).
 */
export async function completeWithJsonRetry<T>(
  client: OpenAI,
  params: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, "stream">,
  cfg: { baseUrl?: string; apiKey?: string; model?: string },
  parse: (content: string) => T,
): Promise<T> {
  let messages = params.messages;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await withLLMErrors(
      () => client.chat.completions.create({ ...params, messages }),
      cfg,
    );
    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("LLM 未返回有效内容");
    try {
      return parse(content);
    } catch (err) {
      if (err instanceof LLMRequestError) throw err;
      lastErr = err;
      if (attempt === 0) {
        const detail = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        messages = [
          ...messages,
          { role: "assistant", content },
          {
            role: "user",
            content: `你上一次的输出无法解析（错误：${detail}）。请严格按之前的要求重新输出完整、合法的 JSON，只输出 JSON 本身，禁止任何解释文字或 markdown 代码块。`,
          },
        ];
      }
    }
  }
  throw lastErr;
}

/** One completion returns the full TIDEWE copy and storyboard. */
export async function generateScript(input: ScriptInput): Promise<GeneratedScript[]> {
  if (!tideweProfileForInput(input)) throw new Error("Only TIDEWE script generation is supported.");
  const client = createLLMClient(input.llmConfig);
  const complete: TideweCompletion = (system, prompt, parse) => completeOnce(client, {
    model: input.llmConfig.model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
    temperature: 0.65, max_tokens: 16000, ...reasoningParams(input.llmConfig.baseUrl), ...jsonModeParams(input.llmConfig.baseUrl),
  }, input.llmConfig, parse);
  return generateTideweScripts({ ...input, count: 1 }, complete);
}
export async function generateSingleScript(input: ScriptInput): Promise<GeneratedScript> {
  return (await generateScript({ ...input, count: 1 }))[0];
}
export function generateScriptStream(input: ScriptInput, callbacks: StreamCallbacks): AbortController {
  const abortController = new AbortController();
  void (async () => {
    try {
      const scripts = await generateScript(input);
      if (!abortController.signal.aborted) {
        callbacks.onToken?.(JSON.stringify({ scripts }));
        callbacks.onComplete?.(scripts);
      }
    } catch (error) {
      if (!abortController.signal.aborted) callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  })();
  return abortController;
}
export function createScriptStream(input: ScriptInput): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try { controller.enqueue(encoder.encode(JSON.stringify({ scripts: await generateScript(input) }))); controller.close(); }
      catch (error) { controller.error(error); }
    },
  });
}
