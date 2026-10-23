/** Grid resolution is independent of the global single-shot image settings. */
export type StoryboardGridResolution = "standard" | "2k" | "4k";
export const DEFAULT_STORYBOARD_GRID_RESOLUTION: StoryboardGridResolution = "4k";

export interface StoryboardGridResolutionInfo {
  requested: StoryboardGridResolution;
  gridWidth: number;
  gridHeight: number;
  minCellWidth: number;
  minCellHeight: number;
  maxCellWidth: number;
  maxCellHeight: number;
  limited: boolean;
}

export function normalizeStoryboardGridResolution(value: unknown): StoryboardGridResolution {
  return value === "standard" || value === "2k" || value === "4k"
    ? value : DEFAULT_STORYBOARD_GRID_RESOLUTION;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Keep the canvas ratio exact and both sides /16, within GPT Image 2's limits. */
export function storyboardGridTargetDimensions(
  width: number,
  height: number,
  resolution: StoryboardGridResolution,
): { width: number; height: number } {
  if (resolution === "standard") return { width, height };
  const maxSide = resolution === "4k" ? 3840 : 2048;
  const maxPixels = 8_294_400;
  const divisor = gcd(width, height);
  const a = width / divisor, b = height / divisor;
  const widthStep = 16 / gcd(a, 16), heightStep = 16 / gcd(b, 16);
  const step = widthStep * heightStep / gcd(widthStep, heightStep);
  const baseWidth = a * step, baseHeight = b * step;
  const multiple = Math.floor(Math.min(
    maxSide / Math.max(baseWidth, baseHeight),
    Math.sqrt(maxPixels / (baseWidth * baseHeight)),
  ));
  if (multiple >= 1) return { width: baseWidth * multiple, height: baseHeight * multiple };
  // Unusual custom ratios may have no exact /16 pair within the size limits.
  const scale = Math.min(maxSide / Math.max(width, height), Math.sqrt(maxPixels / width / height));
  return {
    width: Math.max(16, Math.floor(width * scale / 16) * 16),
    height: Math.max(16, Math.floor(height * scale / 16) * 16),
  };
}

/** Only adapters with a known high-resolution image contract receive larger dimensions. */
function supportsHighResolution(provider: string, model: string): boolean {
  if (provider === "openai") return model.startsWith("gpt-image-2");
  if (provider === "atlas-cloud") return /gpt-image-2|nano-banana|seedream/i.test(model);
  if (provider === "fal-ai") return /gpt-image-2|seedream/i.test(model);
  if (provider === "volcengine") return /seedream/i.test(model);
  return false;
}

/** A grid always buys one image; opt-in dimensions never affect ordinary shot generation. */
export function withStoryboardGridResolution(
  options: Record<string, unknown>,
  resolution: StoryboardGridResolution,
  provider: string,
  model: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...options, count: 1 };
  // Do not let an options-level value bypass the top-level grid selection.
  delete result.imageResolution;
  const extra = options.extra && typeof options.extra === "object" && !Array.isArray(options.extra)
    ? { ...(options.extra as Record<string, unknown>) } : undefined;
  if (extra) {
    for (const key of ["count", "n", "num_images"]) delete extra[key];
    result.extra = extra;
  }
  if (resolution === "standard" || !supportsHighResolution(provider, model)) return result;
  const dimensions = storyboardGridTargetDimensions(options.width as number, options.height as number, resolution);
  // Provider extras are merged last. A stale custom size must not silently undo
  // the selected resolution or buy several full grids when only the first is used.
  if (extra) for (const key of ["width", "height", "size", "image_size", "resolution", "aspect_ratio"]) delete extra[key];
  return { ...result, ...dimensions, imageResolution: resolution, ...(extra && { extra }) };
}
