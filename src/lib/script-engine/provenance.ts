/** Only non-secret generation identifiers belong in persisted script history. */
export interface ScriptGenerationMetadata {
  version: 1;
  operation: "commerce-script" | "premium-product-cg-script" | "topic-script" | "translation";
  provider: string;
  model: string;
  generatedAt: string;
}

export function scriptGenerationMetadata(
  config: { provider?: unknown; model: string },
  operation: ScriptGenerationMetadata["operation"],
  generatedAt = new Date(),
): ScriptGenerationMetadata {
  // Deliberately pick fields instead of spreading config: it also contains API
  // keys, custom endpoint URLs, and potentially other credentials.
  return {
    version: 1,
    operation,
    provider: typeof config.provider === "string" && config.provider.trim()
      ? config.provider.trim()
      : "openai-compatible",
    model: config.model,
    generatedAt: generatedAt.toISOString(),
  };
}
