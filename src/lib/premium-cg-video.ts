import { LAST_FRAME_SUFFIX } from "@/lib/video-composer/frame-extract";

/**
 * Server-side allowlist for premium-CG video inputs. The browser may choose
 * among project material, but cannot introduce a new visual reference after
 * the script has been approved.
 */
export interface PremiumCgVideoAssetReference {
  shotId: number;
  filePath?: string | null;
  thumbnailPath?: string | null;
  sourceKeyframeUrl?: string | null;
}

export interface PremiumCgVideoReferenceRequest {
  productImages: unknown;
  selectedAssets: readonly PremiumCgVideoAssetReference[];
  shotIds: readonly number[];
  shotId: number;
  imageUrl?: unknown;
  lastImageUrl?: unknown;
  referenceImageUrls?: unknown;
}

export type PremiumCgVideoReferenceResult =
  | {
    ok: true;
    imageUrl: string;
    lastImageUrl?: string;
    referenceImageUrls: string[];
  }
  | {
    ok: false;
    code: "PREMIUM_CG_PRODUCT_REFERENCE_REQUIRED" | "PREMIUM_CG_REFERENCE_INVALID";
  };

const VIDEO_FILE = /\.(?:mp4|webm|mov|m4v)(?:[?#].*)?$/i;

function asUrl(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function uniqueUrls(values: Iterable<string | undefined>): string[] {
  const urls = new Set<string>();
  for (const value of values) {
    if (value) urls.add(value);
  }
  return [...urls];
}

function productUrls(value: unknown): string[] {
  return Array.isArray(value)
    ? uniqueUrls(value.map(asUrl))
    : [];
}

function imageRefs(asset: PremiumCgVideoAssetReference): string[] {
  return uniqueUrls([
    asset.filePath && !VIDEO_FILE.test(asset.filePath) ? asset.filePath : undefined,
    asset.thumbnailPath ?? undefined,
    asset.sourceKeyframeUrl ?? undefined,
  ]);
}

/** A video's extracted last frame is a project-owned continuity reference. */
function tailRef(asset: PremiumCgVideoAssetReference): string | undefined {
  return asset.filePath && VIDEO_FILE.test(asset.filePath)
    ? `${asset.filePath}${LAST_FRAME_SUFFIX}`
    : undefined;
}

function requestedUrl(value: unknown): { valid: true; value?: string } | { valid: false } {
  if (value === undefined || value === null || value === "") return { valid: true };
  const url = asUrl(value);
  return url ? { valid: true, value: url } : { valid: false };
}

function requestedUrlList(value: unknown): { valid: true; values: string[] } | { valid: false } {
  if (value === undefined || value === null) return { valid: true, values: [] };
  if (!Array.isArray(value)) return { valid: false };
  const values: string[] = [];
  for (const item of value) {
    const url = asUrl(item);
    if (!url) return { valid: false };
    values.push(url);
  }
  return { valid: true, values: uniqueUrls(values) };
}

/**
 * Resolves the visual inputs for a premium-CG video request.
 *
 * First-frame and auxiliary references may use product images, the current
 * shot's selected keyframe, or the immediate previous clip's extracted tail.
 * A pinned end frame may only use the immediate next shot's selected keyframe.
 */
export function resolvePremiumCgVideoReferences(
  request: PremiumCgVideoReferenceRequest,
): PremiumCgVideoReferenceResult {
  const products = productUrls(request.productImages);
  if (products.length === 0) return { ok: false, code: "PREMIUM_CG_PRODUCT_REFERENCE_REQUIRED" };

  const index = request.shotIds.indexOf(request.shotId);
  const previousShotId = index > 0 ? request.shotIds[index - 1] : undefined;
  const nextShotId = index >= 0 && index + 1 < request.shotIds.length ? request.shotIds[index + 1] : undefined;
  const currentAssets = request.selectedAssets.filter((asset) => asset.shotId === request.shotId);
  const previousAssets = previousShotId === undefined
    ? []
    : request.selectedAssets.filter((asset) => asset.shotId === previousShotId);
  const nextAssets = nextShotId === undefined
    ? []
    : request.selectedAssets.filter((asset) => asset.shotId === nextShotId);

  const currentKeyframes = uniqueUrls(currentAssets.flatMap(imageRefs));
  const previousTails = uniqueUrls(previousAssets.map(tailRef));
  const nextKeyframes = uniqueUrls(nextAssets.flatMap(imageRefs));
  const allowedImageInputs = new Set([...products, ...currentKeyframes, ...previousTails]);
  const allowedTailInputs = new Set(nextKeyframes);

  const first = requestedUrl(request.imageUrl);
  const last = requestedUrl(request.lastImageUrl);
  const references = requestedUrlList(request.referenceImageUrls);
  if (!first.valid || !last.valid || !references.valid) {
    return { ok: false, code: "PREMIUM_CG_REFERENCE_INVALID" };
  }
  if (first.value && !allowedImageInputs.has(first.value)) {
    return { ok: false, code: "PREMIUM_CG_REFERENCE_INVALID" };
  }
  if (last.value && !allowedTailInputs.has(last.value)) {
    return { ok: false, code: "PREMIUM_CG_REFERENCE_INVALID" };
  }
  if (references.values.some((url) => !allowedImageInputs.has(url))) {
    return { ok: false, code: "PREMIUM_CG_REFERENCE_INVALID" };
  }

  const imageUrl = first.value ?? currentKeyframes[0] ?? products[0];
  return {
    ok: true,
    imageUrl,
    ...(last.value && { lastImageUrl: last.value }),
    referenceImageUrls: references.values,
  };
}
