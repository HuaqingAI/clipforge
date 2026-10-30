import { OPENAI_FOCUS_MASK_MODELS } from "./openai-image-capabilities";

/** Single-shot image repair keeps the storyboard crop as the composition anchor. */
export type KeyframeRepairIssue = "hands" | "anatomy" | "duplicates" | "product" | "integration" | "details";
export type KeyframeRefinementResolution = "720p" | "1080p";
export const DEFAULT_KEYFRAME_REFINEMENT_RESOLUTION: KeyframeRefinementResolution = "720p";

export function isKeyframeRefinementResolution(value: unknown): value is KeyframeRefinementResolution {
  return value === "720p" || value === "1080p";
}

/** Fit the source ratio inside the selected HD canvas, including square/custom sources. */
export function keyframeRefinementTargetDimensions(width: number, height: number, resolution: KeyframeRefinementResolution): { width: number; height: number } {
  const shortSide = resolution === "1080p" ? 1080 : 720;
  const longSide = resolution === "1080p" ? 1920 : 1280;
  const scale = Math.min(shortSide / Math.min(width, height), longSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Adapters round to legal model canvases; saved output is capped separately. */
export function keyframeRefinementProviderOptions(width: number, height: number, resolution: KeyframeRefinementResolution, provider: string, model: string): Record<string, unknown> {
  return { ...keyframeRefinementTargetDimensions(width, height, resolution), count: 1,
    // This enables OpenAI's legal /16 canvas handling instead of its 1536px default clamp.
    // The nearest valid 1080p portrait request is 1152x2048, then saved as 1080x1920.
    ...(provider === "openai" && model.startsWith("gpt-image-2") && { imageResolution: "2k" }) };
}

/** User-selected rectangle in the complete source image, using normalized coordinates. */
export interface KeyframeFocusRegion { x: number; y: number; width: number; height: number }

export function isKeyframeFocusRegion(value: unknown): value is KeyframeFocusRegion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const region = value as KeyframeFocusRegion;
  return [region.x, region.y, region.width, region.height].every((number) => typeof number === "number" && Number.isFinite(number))
    && region.x >= 0 && region.y >= 0 && region.width >= 0.01 && region.height >= 0.01
    && region.x + region.width <= 1 + 1e-9 && region.y + region.height <= 1 + 1e-9
    && region.width * region.height < 0.95;
}

/** Only expose native mask edits for the adapters/models whose request contract supports them. */
export function supportsKeyframeFocusMask(provider: string, model: string): boolean {
  return provider === "openai" && OPENAI_FOCUS_MASK_MODELS.includes(model);
}

export const KEYFRAME_REPAIR_ISSUES: readonly { id: KeyframeRepairIssue; label: { zh: string; en: string } }[] = [
  { id: "hands", label: { zh: "手部、掌向与手腕", en: "Hands, orientation and wrists" } },
  { id: "anatomy", label: { zh: "肢体与人体结构", en: "Anatomy and limbs" } },
  { id: "duplicates", label: { zh: "重复物体与多余部件", en: "Duplicate objects and extra parts" } },
  { id: "product", label: { zh: "商品结构与细节", en: "Product structure and details" } },
  { id: "integration", label: { zh: "人物与环境融合、景深修复", en: "Subject integration and depth of field" } },
  { id: "details", label: { zh: "清晰度与画面细节", en: "Clarity and image details" } },
];

export interface KeyframeRefinementCandidate {
  id: string;
  shotId: number;
  filePath: string;
  sourceKeyframeUrl: string | null;
  derivedFromAssetId: string | null;
  selected: boolean;
  prompt?: string | null;
  model?: string | null;
}

export interface KeyframeRefinementResolutionInfo {
  requested: KeyframeRefinementResolution | "2k" | "4k";
  width: number;
  height: number;
  limited: boolean;
  processingMode?: "crop_composite_v1";
  preservesSourceDimensions?: boolean;
  requestedPatchTarget?: { width: number; height: number };
  actualPatchWidth?: number;
  actualPatchHeight?: number;
}
