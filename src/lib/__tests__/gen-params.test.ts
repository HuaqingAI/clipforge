import { describe, expect, it } from "vitest";
import { buildVideoOptions, DEFAULT_VIDEO_PARAMS, RESOLUTION_OPTIONS, videoSize } from "@/lib/gen-params";

describe("video resolution parameters", () => {
  it.each([false, true])("preserves an explicit audio setting of %s", (audioEnabled) => {
    expect(buildVideoOptions({ ...DEFAULT_VIDEO_PARAMS, audioEnabled }).audioEnabled).toBe(audioEnabled);
    expect(buildVideoOptions(DEFAULT_VIDEO_PARAMS)).not.toHaveProperty("audioEnabled");
  });
  it.each([
    ["16:9", { width: 854, height: 480 }],
    ["9:16", { width: 480, height: 854 }],
    ["1:1", { width: 480, height: 480 }],
  ] as const)("preserves 480p as the short side for %s", (aspectRatio, size) => {
    expect(videoSize("480p", aspectRatio)).toEqual(size);
    expect(buildVideoOptions({ aspectRatio, resolution: "480p", duration: 4 })).toEqual({ ...size, duration: 4 });
  });

  it("makes 480p selectable while retaining the existing default tier", () => {
    expect(RESOLUTION_OPTIONS.map((option) => option.value)).toEqual(["480p", "720p", "1080p"]);
    expect(DEFAULT_VIDEO_PARAMS.resolution).toBe("720p");
    expect(videoSize("720p", "9:16")).toEqual({ width: 720, height: 1280 });
    expect(videoSize("1080p", "16:9")).toEqual({ width: 1920, height: 1080 });
  });
});
