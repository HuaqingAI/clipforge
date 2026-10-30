import { describe, expect, it } from "vitest";
import { keyframeRefinementTargetDimensions, type KeyframeRefinementResolution } from "@/lib/keyframe-refinement";

describe("refinement HD canvas geometry", () => {
  it.each([
    { resolution: "720p", portrait: { width: 720, height: 1280 }, square: { width: 720, height: 720 } },
    { resolution: "1080p", portrait: { width: 1080, height: 1920 }, square: { width: 1080, height: 1080 } },
  ] as const)("uses the expected $resolution canvas in either orientation and for square sources", ({ resolution, portrait, square }) => {
    expect(keyframeRefinementTargetDimensions(2160, 3840, resolution)).toEqual(portrait);
    expect(keyframeRefinementTargetDimensions(3840, 2160, resolution)).toEqual({ width: portrait.height, height: portrait.width });
    expect(keyframeRefinementTargetDimensions(2048, 2048, resolution)).toEqual(square);
  });

  it.each([
    { resolution: "720p", shortLimit: 720, longLimit: 1280 },
    { resolution: "1080p", shortLimit: 1080, longLimit: 1920 },
  ] satisfies { resolution: KeyframeRefinementResolution; shortLimit: number; longLimit: number }[])("keeps custom source ratios inside both $resolution bounds without wasting the available canvas", ({ resolution, shortLimit, longLimit }) => {
    const sources = [[938, 1677], [1677, 938], [1001, 1000], [1000, 1001], [3271, 1217], [1217, 3271], [4023, 3007], [3007, 4023], [3, 2], [2, 3]];
    for (const [sourceWidth, sourceHeight] of sources) {
      const output = keyframeRefinementTargetDimensions(sourceWidth, sourceHeight, resolution);
      const short = Math.min(output.width, output.height), long = Math.max(output.width, output.height);
      expect(Number.isSafeInteger(output.width) && Number.isSafeInteger(output.height)).toBe(true);
      expect(short).toBeGreaterThan(0);
      expect(short).toBeLessThanOrEqual(shortLimit);
      expect(long).toBeLessThanOrEqual(longLimit);
      expect(short === shortLimit || long === longLimit).toBe(true);
      expect(output.width * output.height).toBeLessThanOrEqual(shortLimit * longLimit);
      // Integer raster dimensions may deviate from the original ratio by at most one pixel.
      const ratioErrorPixels = Math.min(
        Math.abs(output.width - output.height * sourceWidth / sourceHeight),
        Math.abs(output.height - output.width * sourceHeight / sourceWidth),
      );
      expect(ratioErrorPixels).toBeLessThanOrEqual(1);
      expect(Math.sign(output.width - output.height)).toBe(Math.sign(sourceWidth - sourceHeight));
    }
  });
});
