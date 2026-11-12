/** Shared script input and historical style labels. TIDEWE owns its generation prompts. */
import type { ProductCategory } from "./templates";
import type { ProductFacts } from "@/lib/tidewe/types";
import { buildTideweScriptPrompt, tideweProfileForInput } from "@/lib/tidewe/prompts";

export type ScriptStyleType =
  | "pain_point"
  | "scene"
  | "comparison"
  | "story"
  | "drama"
  | "reversal"
  | "interview"
  | "unboxing"
  | "product_pov"
  | "talking_head"
  | "tidewe_outdoor"
  | "custom";

/** Display name mapping for script styles */
export const styleNameMap: Record<ScriptStyleType, string> = {
  tidewe_outdoor: "TIDEWE 风格",
  pain_point: "痛点种草",
  scene: "场景安利",
  comparison: "对比测评",
  story: "剧情故事",
  drama: "情景短剧",
  reversal: "反转剧场",
  interview: "街头采访",
  unboxing: "开箱测评",
  product_pov: "物品拟人",
  talking_head: "达人口播",
  custom: "自定义",
};

export interface ScriptGenerationInput {
  productFacts?: ProductFacts;
  copyText?: string;
  sceneDescription?: string;
  count?: number;
  productName: string;
  category: ProductCategory;
  productCategoryHint?: string;
  productDescription?: string;
  styleType: "tidewe_outdoor";
  creativeProfile?: unknown;
  targetDuration?: number;
  productAnalysis?: string;
  targetAudience?: string;
  customRequirements?: string;
  videoMode?: "product_closeup" | "scene_demo";
  character?: { id: string; name: string; appearance: string; voiceStyle?: string };
}
/** Compatibility wrapper for TIDEWE prompt callers. */
export function buildUserPrompt(input: ScriptGenerationInput): string {
  if (!tideweProfileForInput(input)) throw new Error("Only TIDEWE script generation is supported.");
  return buildTideweScriptPrompt(input);
}
export function buildBatchPrompt(input: ScriptGenerationInput, count = 1): string {
  // Historical callers may pass a count; fresh TIDEWE requests always produce one copy.
  void count;
  return buildUserPrompt(input);
}
