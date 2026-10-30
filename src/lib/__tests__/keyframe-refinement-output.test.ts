// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fitKeyframeRefinementOutput } from "@/lib/keyframe-refinement-output";
import { probeMedia } from "@/lib/media-probe";

const require = createRequire(import.meta.url);
const ffmpeg = require("ffmpeg-static") as string;
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(width: number, height: number) {
  const directory = await mkdtemp(join(tmpdir(), "clipforge-refinement-output-"));
  directories.push(directory);
  const sourcePath = join(directory, "source.png"), outputPath = join(directory, "limited.png");
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const value = x < width / 2 ? (y < height / 2 ? 16 : 70) : (y < height / 2 ? 130 : 215);
    rgba.set([value, value, value, 255], (y * width + x) * 4);
  }
  const bytes = execFileSync(ffmpeg, [
    "-v", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${width}x${height}`,
    "-i", "pipe:0", "-frames:v", "1", "-c:v", "png", "-pix_fmt", "rgba", "-f", "image2pipe", "pipe:1",
  ], { input: rgba, maxBuffer: rgba.length + 1024 * 1024 });
  await writeFile(sourcePath, bytes);
  return { sourcePath, outputPath, bytes };
}

function decode(path: string, width: number, height: number): Buffer {
  return execFileSync(ffmpeg, [
    "-v", "error", "-i", path, "-frames:v", "1", "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1",
  ], { maxBuffer: width * height * 4 + 1024 * 1024 });
}

describe("refinement output resolution", () => {
  it.each([
    { width: 1440, height: 2560, target: { width: 720, height: 1280 } },
    { width: 3840, height: 2160, target: { width: 1920, height: 1080 } },
    { width: 1500, height: 1500, target: { width: 720, height: 720 } },
  ])("caps actual provider dimensions at $target.width × $target.height", async ({ width, height, target }) => {
    const f = await fixture(width, height);
    expect(await fitKeyframeRefinementOutput({ ...f, target })).toBe(f.outputPath);
    const result = await probeMedia(f.outputPath);
    expect({ width: result.width, height: result.height }).toEqual(target);
    expect(result.videoCodec).toBe("png");
    expect(await readFile(f.sourcePath)).toEqual(f.bytes);
  });

  it("fits both bounds while preserving the complete image and natural tonal range", async () => {
    const f = await fixture(1401, 2101);
    await fitKeyframeRefinementOutput({ ...f, target: { width: 720, height: 1280 } });
    const { width, height } = await probeMedia(f.outputPath);
    expect(width).toBe(720);
    expect(height).toBe(1079);
    expect(Math.abs(width / height - 1401 / 2101)).toBeLessThan(1 / height);
    const rgba = decode(f.outputPath, width, height);
    const corner = (x: number, y: number) => [...rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
    expect(corner(0, 0)).toEqual([16, 16, 16, 255]);
    expect(corner(width - 1, 0)).toEqual([130, 130, 130, 255]);
    expect(corner(0, height - 1)).toEqual([70, 70, 70, 255]);
    expect(corner(width - 1, height - 1)).toEqual([215, 215, 215, 255]);
    for (let index = 0; index < rgba.length; index += 4) {
      if (rgba[index] < 16 || rgba[index] > 215 || rgba[index] !== rgba[index + 1] || rgba[index] !== rgba[index + 2]) {
        throw new Error("Resizing changed neutral tones or introduced edge overshoot.");
      }
    }
  });

  it("returns an undersized image unchanged without creating an enlarged copy", async () => {
    const f = await fixture(320, 180);
    expect(await fitKeyframeRefinementOutput({ ...f, target: { width: 1280, height: 720 } })).toBe(f.sourcePath);
    expect(await readFile(f.sourcePath)).toEqual(f.bytes);
    await expect(stat(f.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsafe targets and refuses to overwrite the source or an existing result", async () => {
    const f = await fixture(40, 40);
    for (const target of [{ width: 0, height: 720 }, { width: 10.5, height: 20 }, { width: 8192, height: 8192 }]) {
      await expect(fitKeyframeRefinementOutput({ ...f, target })).rejects.toThrow("dimensions");
    }
    const target = { width: 20, height: 20 };
    await expect(fitKeyframeRefinementOutput({ ...f, outputPath: f.sourcePath, target })).rejects.toThrow("overwrite");
    await fitKeyframeRefinementOutput({ ...f, target });
    const result = await readFile(f.outputPath);
    await expect(fitKeyframeRefinementOutput({ ...f, target })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(f.outputPath)).toEqual(result);
    expect(await readFile(f.sourcePath)).toEqual(f.bytes);
  });
});
