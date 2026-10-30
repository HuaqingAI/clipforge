// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertKeyframeFocusPatchPrepared,
  composeKeyframeFocusPatch,
  planKeyframeFocusPatch,
  prepareKeyframeFocusPatch,
} from "@/lib/keyframe-focus-patch";

const require = createRequire(import.meta.url);
const ffmpeg = require("ffmpeg-static") as string;
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

function png(rgba: Buffer, width: number, height: number): Buffer {
  return execFileSync(ffmpeg, ["-v", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${width}x${height}`, "-i", "pipe:0", "-frames:v", "1", "-pix_fmt", "rgba", "-f", "image2pipe", "-c:v", "png", "pipe:1"], { input: rgba });
}

function decode(bytes: Buffer, size?: { width: number; height: number }): Buffer {
  return execFileSync(ffmpeg, ["-v", "error", "-i", "pipe:0", "-frames:v", "1", ...(size ? ["-vf", `scale=${size.width}:${size.height}:flags=lanczos`] : []), "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"], { input: bytes });
}

const pixel = (rgba: Buffer, width: number, x: number, y: number) => rgba.subarray((y * width + x) * 4, (y * width + x + 1) * 4);

async function fixture(width = 30, height = 30) {
  const directory = await mkdtemp(join(tmpdir(), "clipforge-focus-patch-"));
  directories.push(directory);
  const sourcePath = join(directory, "source.png"), sourceCopyPath = join(directory, "snapshot.png"), cropPath = join(directory, "crop.png");
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    rgba.set([x * 7 % 256, y * 9 % 256, (x + y) * 5 % 256, 80 + (x * 3 + y) % 176], (y * width + x) * 4);
  }
  await writeFile(sourcePath, png(rgba, width, height));
  return { directory, sourcePath, sourceCopyPath, cropPath, rgba, width, height };
}

describe("focus patch geometry", () => {
  it("expands a full-width bottom strip without cutting either selected corner", () => {
    const geometry = planKeyframeFocusPatch(938, 1677, { x: 0, y: 0.83, width: 1, height: 0.17 });
    expect(geometry.selection).toEqual({ x: 0, y: 1391, width: 938, height: 286 });
    expect(geometry.context.x).toBe(0);
    expect(geometry.context.width).toBe(938);
    expect(geometry.context.y).toBeLessThanOrEqual(geometry.selection.y);
    expect(geometry.context.y + geometry.context.height).toBe(1677);
    expect(geometry.context.width / geometry.context.height).toBeLessThanOrEqual(3);
  });

  it.each([
    { x: 0, y: 0, width: 0.1, height: 0.6 },
    { x: 0.9, y: 0.4, width: 0.1, height: 0.6 },
    { x: 0.2, y: 0, width: 0.6, height: 0.02 },
    { x: 0.2, y: 0.98, width: 0.6, height: 0.02 },
    { x: 0.255, y: 0.315, width: 0.125, height: 0.225 },
  ])("keeps all four selection corners inside a valid context: %j", region => {
    const { selection, context } = planKeyframeFocusPatch(200, 300, region);
    expect(context.x).toBeLessThanOrEqual(selection.x);
    expect(context.y).toBeLessThanOrEqual(selection.y);
    expect(context.x + context.width).toBeGreaterThanOrEqual(selection.x + selection.width);
    expect(context.y + context.height).toBeGreaterThanOrEqual(selection.y + selection.height);
    expect(context.x).toBeGreaterThanOrEqual(0);
    expect(context.y).toBeGreaterThanOrEqual(0);
    expect(context.x + context.width).toBeLessThanOrEqual(200);
    expect(context.y + context.height).toBeLessThanOrEqual(300);
    expect(context.width / context.height).toBeGreaterThanOrEqual(1 / 3);
    expect(context.width / context.height).toBeLessThanOrEqual(3);
  });

  it("uses floor/ceil pixel coverage and rejects an impossible ratio instead of trimming the selection", () => {
    expect(planKeyframeFocusPatch(13, 7, { x: 0.2, y: 0.4, width: 0.3, height: 0.3 }).selection).toEqual({ x: 2, y: 2, width: 5, height: 3 });
    expect(() => planKeyframeFocusPatch(1000, 100, { x: 0, y: 0.8, width: 1, height: 0.2 })).toThrow("保留完整选区");
  });

  it("rejects unsafe dimensions and malformed region controls before allocating a raster", () => {
    const region = { x: 0, y: 0.8, width: 1, height: 0.2 };
    for (const [width, height] of [[0, 10], [10.1, 10], [8192, 8192]]) expect(() => planKeyframeFocusPatch(width, height, region)).toThrow("尺寸无效");
    expect(() => planKeyframeFocusPatch(30, 30, { ...region, extra: true } as typeof region)).toThrow("归一化矩形");
  });
});

describe("focus patch PNG preparation and exact local composition", () => {
  it("keeps an immutable byte-identical snapshot and extracts exactly the planned context", async () => {
    const f = await fixture();
    const original = await readFile(f.sourcePath);
    const prepared = await prepareKeyframeFocusPatch({ ...f, region: { x: 0, y: 0.8, width: 1, height: 0.2 } });
    expect(await readFile(prepared.sourcePath)).toEqual(original);
    await assertKeyframeFocusPatchPrepared(JSON.parse(JSON.stringify(prepared)));
    const crop = decode(await readFile(prepared.cropPath));
    const { context } = prepared.geometry;
    expect(crop.length).toBe(context.width * context.height * 4);
    for (let y = 0; y < context.height; y++) for (let x = 0; x < context.width; x++) {
      expect(pixel(crop, context.width, x, y)).toEqual(pixel(f.rgba, f.width, x + context.x, y + context.y));
    }
    await expect(prepareKeyframeFocusPatch({ ...f, region: prepared.region })).rejects.toThrow();
  });

  it("maps a differently sized generated patch to context and leaves every outside RGBA byte unchanged", async () => {
    const f = await fixture(40, 40);
    const prepared = await prepareKeyframeFocusPatch({ ...f, region: { x: 0.2, y: 0.55, width: 0.6, height: 0.3 } });
    const patchWidth = 17, patchHeight = 11;
    const patchRgba = Buffer.alloc(patchWidth * patchHeight * 4);
    for (let y = 0; y < patchHeight; y++) for (let x = 0; x < patchWidth; x++) patchRgba.set([90 + x * 5, 150 + y * 5, 230 - x * 3, 255], (y * patchWidth + x) * 4);
    const patchPath = join(f.directory, "generated.png"), outputPath = join(f.directory, "composed.png");
    const patchPng = png(patchRgba, patchWidth, patchHeight);
    await writeFile(patchPath, patchPng);
    const result = await composeKeyframeFocusPatch({ prepared, patchPath, outputPath, featherPixels: 0 });
    expect(result).toEqual({ outputPath, width: 40, height: 40 });
    const outputBytes = await readFile(outputPath), output = decode(outputBytes);
    expect(outputBytes.readUInt32BE(16)).toBe(40);
    expect(outputBytes.readUInt32BE(20)).toBe(40);
    const mapped = decode(patchPng, prepared.geometry.context);
    const { selection, context } = prepared.geometry;
    for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) {
      const selected = x >= selection.x && x < selection.x + selection.width && y >= selection.y && y < selection.y + selection.height;
      expect(pixel(output, f.width, x, y)).toEqual(selected ? pixel(mapped, context.width, x - context.x, y - context.y) : pixel(f.rgba, f.width, x, y));
    }
    expect(await readFile(patchPath)).toEqual(patchPng);
  });

  it.each([
    { x: 0, y: 0.6, width: 1, height: 0.4 },
    { x: 0, y: 0, width: 0.4, height: 1 },
    { x: 0.6, y: 0, width: 0.4, height: 1 },
    { x: 0.2, y: 0.8, width: 0.6, height: 0.2 },
  ])("feathers only inward at internal boundaries and fully replaces selected image-edge pixels: %j", async region => {
    const f = await fixture();
    const prepared = await prepareKeyframeFocusPatch({ ...f, region });
    const patchPath = join(f.directory, "generated.png"), outputPath = join(f.directory, "composed.png");
    const patchColor = Buffer.from([240, 220, 200, 255]);
    await writeFile(patchPath, png(Buffer.concat(Array.from({ length: 9 }, () => patchColor)), 3, 3));
    await composeKeyframeFocusPatch({ prepared, patchPath, outputPath });
    const output = decode(await readFile(outputPath));
    const { selection } = prepared.geometry;
    let blended = 0, edgePixels = 0;
    for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) {
      const selected = x >= selection.x && x < selection.x + selection.width && y >= selection.y && y < selection.y + selection.height;
      if (!selected) expect(pixel(output, 30, x, y)).toEqual(pixel(f.rgba, 30, x, y));
      else if (x === 0 || y === 0 || x === 29 || y === 29) { expect(pixel(output, 30, x, y)).toEqual(patchColor); edgePixels++; }
      else if (!pixel(output, 30, x, y).equals(patchColor)) blended++;
    }
    expect(edgePixels).toBeGreaterThan(0);
    expect(blended).toBeGreaterThan(0);
  });

  it("rejects changed immutable input bytes or altered geometry before composing", async () => {
    const f = await fixture();
    const prepared = await prepareKeyframeFocusPatch({ ...f, region: { x: 0, y: 0.8, width: 1, height: 0.2 } });
    const altered = structuredClone(prepared);
    altered.geometry.context.y--;
    await expect(assertKeyframeFocusPatchPrepared(altered)).rejects.toThrow("上下文尺寸");
    const crop = await readFile(prepared.cropPath);
    await writeFile(prepared.cropPath, Buffer.concat([crop, Buffer.from([0])]));
    await expect(assertKeyframeFocusPatchPrepared(prepared)).rejects.toThrow("快照或裁块已改变");
    await writeFile(prepared.cropPath, crop);
    await writeFile(prepared.sourcePath, Buffer.concat([await readFile(prepared.sourcePath), Buffer.from([0])]));
    await expect(assertKeyframeFocusPatchPrepared(prepared)).rejects.toThrow("快照或裁块已改变");
  });

  it("rejects non-PNG sources, invalid feather, and overwriting immutable inputs", async () => {
    const f = await fixture();
    const prepared = await prepareKeyframeFocusPatch({ ...f, region: { x: 0, y: 0.8, width: 1, height: 0.2 } });
    await expect(composeKeyframeFocusPatch({ prepared, patchPath: prepared.cropPath, outputPath: prepared.sourcePath })).rejects.toThrow("不能覆盖");
    await expect(composeKeyframeFocusPatch({ prepared, patchPath: prepared.cropPath, outputPath: join(f.directory, "x.png"), featherPixels: -1 })).rejects.toThrow("羽化范围");
    const bad = join(f.directory, "not-png.png");
    await writeFile(bad, "not an image");
    await expect(prepareKeyframeFocusPatch({ ...f, sourcePath: bad, sourceCopyPath: join(f.directory, "bad-copy.png"), cropPath: join(f.directory, "bad-crop.png"), region: prepared.region })).rejects.toThrow("有效的 PNG");
  });
});
