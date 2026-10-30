// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { buildKeyframeFocusMask, validKeyframeFocusRegion } from "@/lib/keyframe-focus-mask";

const require = createRequire(import.meta.url);
const ffmpeg = require("ffmpeg-static") as string;

function decode(bytes: Buffer) {
  return execFileSync(ffmpeg, ["-v", "error", "-i", "pipe:0", "-frames:v", "1", "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"], { input: bytes });
}

describe("native keyframe focus masks", () => {
  it("encodes a source-sized PNG with a transparent edit rectangle and opaque surroundings", () => {
    const mask = buildKeyframeFocusMask(100, 80, { x: 0.1, y: 0.6, width: 0.7, height: 0.4 });
    expect(mask.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(mask.readUInt32BE(16)).toBe(100);
    expect(mask.readUInt32BE(20)).toBe(80);
    expect(mask[25]).toBe(6);
    const rgba = decode(mask);
    expect(rgba.length).toBe(100 * 80 * 4);
    for (let y = 0; y < 80; y++) for (let x = 0; x < 100; x++) {
      const pixel = rgba.subarray((y * 100 + x) * 4, (y * 100 + x + 1) * 4);
      expect([...pixel]).toEqual([255, 255, 255, x >= 10 && x < 80 && y >= 48 ? 0 : 255]);
    }
  });

  it("covers fractional boundary pixels while keeping the original image dimensions", () => {
    const rgba = decode(buildKeyframeFocusMask(13, 7, { x: 0.2, y: 0.4, width: 0.3, height: 0.3 }));
    expect(rgba.length).toBe(13 * 7 * 4);
    const alpha = (x: number, y: number) => rgba[(y * 13 + x) * 4 + 3];
    expect(alpha(2, 2)).toBe(0);
    expect(alpha(6, 4)).toBe(0);
    expect(alpha(1, 2)).toBe(255);
    expect(alpha(7, 4)).toBe(255);
    expect(alpha(6, 5)).toBe(255);
  });

  it.each([null, {}, { x: 0, y: 0, width: 0.5, height: 0.5, feather: 0.1 }, { x: -0.1, y: 0, width: 0.5, height: 0.5 }, { x: 0.8, y: 0, width: 0.5, height: 0.5 }, { x: 0, y: 0, width: 1, height: 1 }])("rejects invalid or unknown region controls: %j", (region) => {
    expect(validKeyframeFocusRegion(region)).toBe(false);
  });

  it("rejects invalid dimensions before allocating a raster", () => {
    const region = { x: 0, y: 0.5, width: 1, height: 0.5 };
    for (const [width, height] of [[0, 10], [10.1, 10], [100_000, 100_000]]) {
      expect(() => buildKeyframeFocusMask(width, height, region)).toThrow("尺寸无效");
    }
  });
});
