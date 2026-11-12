import { normalizeOpenAIBaseUrl } from "@/lib/openai-config";

export const HTH_VIDEO_MODEL = "MiniMax-H3";
export const HTH_VIDEO_MIN_DURATION = 4;
export const HTH_VIDEO_MAX_DURATION = 15;
export const HTH_VIDEO_DURATIONS = Array.from({ length: 12 }, (_, index) => index + HTH_VIDEO_MIN_DURATION);
export const HTH_VIDEO_RESOLUTIONS = ["768P", "2K"];
export const HTH_VIDEO_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];

/** Legacy 720p/1080p settings use H3's standard tier; 2K/4K request its 2K tier. */
export function hthVideoResolution(width: number, height: number): "768P" | "2K" {
  return Math.min(width, height) > 1080 ? "2K" : "768P";
}

/** Native Hailuo routes sit beside /v1; retain a gateway's optional path prefix. */
export function normalizeHTHVideoBaseUrl(baseUrl?: string): string {
  const base = normalizeOpenAIBaseUrl(baseUrl);
  try {
    const url = new URL(base);
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v[12]$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return base.replace(/\/v[12]$/, "");
  }
}
