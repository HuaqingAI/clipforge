import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { ffmpegBin } from "@/lib/ffmpeg-path";
import { validKeyframeFocusRegion } from "@/lib/keyframe-focus-mask";
import type { KeyframeFocusRegion } from "@/lib/keyframe-refinement";

const execFileAsync = promisify(execFile);
const MAX_PIXELS = 16_777_216;
const MAX_RAW_BYTES = MAX_PIXELS * 4;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface KeyframeFocusPixelRect { x: number; y: number; width: number; height: number }

export interface KeyframeFocusPatchGeometry {
  width: number;
  height: number;
  selection: KeyframeFocusPixelRect;
  context: KeyframeFocusPixelRect;
}

/** Serializable preparation evidence; paths name immutable files, never reference-image data. */
export interface PreparedKeyframeFocusPatch {
  version: 1;
  sourcePath: string;
  cropPath: string;
  sourceHash: string;
  cropHash: string;
  region: KeyframeFocusRegion;
  geometry: KeyframeFocusPatchGeometry;
}

function assertDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS) {
    throw new Error("区域重绘图片尺寸无效或超过 1600 万像素。");
  }
}

/** Expand around the complete selection; never trim selected corners to satisfy a model ratio. */
export function planKeyframeFocusPatch(width: number, height: number, region: KeyframeFocusRegion): KeyframeFocusPatchGeometry {
  assertDimensions(width, height);
  if (!validKeyframeFocusRegion(region)) throw new Error("区域重绘需要有效的归一化矩形。");
  const x = Math.floor(region.x * width), y = Math.floor(region.y * height);
  const right = Math.min(width, Math.ceil((region.x + region.width) * width));
  const bottom = Math.min(height, Math.ceil((region.y + region.height) * height));
  const selection = { x, y, width: right - x, height: bottom - y };
  const padding = Math.max(8, Math.ceil(Math.min(selection.width, selection.height) * 0.1));
  let contextWidth = Math.min(width, selection.width + padding * 2);
  let contextHeight = Math.min(height, selection.height + padding * 2);
  if (contextWidth > contextHeight * 3) {
    contextHeight = Math.min(height, Math.ceil(contextWidth / 3));
    contextWidth = Math.min(contextWidth, contextHeight * 3);
  }
  if (contextHeight > contextWidth * 3) {
    contextWidth = Math.min(width, Math.ceil(contextHeight / 3));
    contextHeight = Math.min(contextHeight, contextWidth * 3);
  }
  if (contextWidth < selection.width || contextHeight < selection.height) {
    throw new Error("原图无法在保留完整选区的同时满足 1:3 至 3:1 的裁块比例。");
  }
  const context = {
    x: Math.max(0, Math.min(width - contextWidth, Math.floor(x + (selection.width - contextWidth) / 2))),
    y: Math.max(0, Math.min(height - contextHeight, Math.floor(y + (selection.height - contextHeight) / 2))),
    width: contextWidth,
    height: contextHeight,
  };
  return { width, height, selection, context };
}

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("区域重绘首版只支持有效的 PNG 图片。");
  }
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assertDimensions(width, height);
  return { width, height };
}

async function decodeRgba(path: string, width: number, height: number, resize = false): Promise<Buffer> {
  assertDimensions(width, height);
  const { stdout } = await execFileAsync(ffmpegBin(), [
    "-nostdin", "-v", "error", "-i", path, "-frames:v", "1",
    ...(resize ? ["-vf", `scale=${width}:${height}:flags=lanczos`] : []),
    "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1",
  ], { encoding: "buffer", timeout: 60_000, maxBuffer: Math.min(MAX_RAW_BYTES, width * height * 4) + 1024 * 1024 });
  if (stdout.length !== width * height * 4) throw new Error("区域重绘图片解码尺寸与计划不一致。");
  return stdout;
}

async function encodePng(rgba: Buffer, width: number, height: number): Promise<Buffer> {
  assertDimensions(width, height);
  if (rgba.length !== width * height * 4) throw new Error("区域重绘 RGBA 数据长度无效。");
  const operation = execFileAsync(ffmpegBin(), [
    "-v", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${width}x${height}`,
    "-framerate", "1", "-i", "pipe:0", "-frames:v", "1", "-c:v", "png", "-pix_fmt", "rgba", "-f", "image2pipe", "pipe:1",
  ], { encoding: "buffer", timeout: 60_000, maxBuffer: Math.min(MAX_RAW_BYTES, rgba.length) + 1024 * 1024 });
  // execFile's promisified result retains its child, so no temporary raw image is needed.
  operation.child.stdin?.on("error", () => { /* The process rejection carries the encoder failure. */ });
  operation.child.stdin?.end(rgba);
  return (await operation).stdout;
}

function cropRgba(source: Buffer, sourceWidth: number, rect: KeyframeFocusPixelRect): Buffer {
  const output = Buffer.alloc(rect.width * rect.height * 4);
  for (let row = 0; row < rect.height; row++) {
    const start = ((row + rect.y) * sourceWidth + rect.x) * 4;
    source.copy(output, row * rect.width * 4, start, start + rect.width * 4);
  }
  return output;
}

export async function prepareKeyframeFocusPatch(input: {
  sourcePath: string;
  region: KeyframeFocusRegion;
  sourceCopyPath: string;
  cropPath: string;
}): Promise<PreparedKeyframeFocusPatch> {
  const sourcePath = resolve(input.sourcePath), sourceCopyPath = resolve(input.sourceCopyPath), cropPath = resolve(input.cropPath);
  if (new Set([sourcePath, sourceCopyPath, cropPath]).size !== 3) throw new Error("区域重绘源图、快照和裁块必须使用不同路径。");
  const sourceBytes = await readFile(sourcePath);
  const { width, height } = pngDimensions(sourceBytes);
  const geometry = planKeyframeFocusPatch(width, height, input.region);
  await mkdir(dirname(sourceCopyPath), { recursive: true });
  await mkdir(dirname(cropPath), { recursive: true });
  await copyFile(sourcePath, sourceCopyPath, constants.COPYFILE_EXCL);
  const snapshot = await readFile(sourceCopyPath);
  if (!snapshot.equals(sourceBytes)) throw new Error("区域重绘准备期间源图发生变化。");
  const sourceRgba = await decodeRgba(sourceCopyPath, width, height);
  const cropBytes = await encodePng(cropRgba(sourceRgba, width, geometry.context), geometry.context.width, geometry.context.height);
  await writeFile(cropPath, cropBytes, { flag: "wx" });
  return { version: 1, sourcePath: sourceCopyPath, cropPath, sourceHash: hash(snapshot), cropHash: hash(cropBytes), region: { ...input.region }, geometry };
}

/** Recheck snapshots before submission and again before every local composition/recovery. */
export async function assertKeyframeFocusPatchPrepared(prepared: PreparedKeyframeFocusPatch): Promise<void> {
  if (!prepared || prepared.version !== 1 || typeof prepared.sourcePath !== "string" || typeof prepared.cropPath !== "string"
    || resolve(prepared.sourcePath) === resolve(prepared.cropPath) || !/^[a-f0-9]{64}$/.test(prepared.sourceHash ?? "")
    || !/^[a-f0-9]{64}$/.test(prepared.cropHash ?? "") || !prepared.geometry) {
    throw new Error("区域重绘准备记录无效。");
  }
  const [source, crop] = await Promise.all([readFile(prepared.sourcePath), readFile(prepared.cropPath)]);
  if (hash(source) !== prepared.sourceHash || hash(crop) !== prepared.cropHash) throw new Error("区域重绘源图快照或裁块已改变。");
  const { width, height } = pngDimensions(source);
  const geometry = planKeyframeFocusPatch(width, height, prepared.region);
  if (JSON.stringify(geometry) !== JSON.stringify(prepared.geometry)) throw new Error("区域重绘选区或上下文尺寸与准备记录不一致。");
  const cropSize = pngDimensions(crop);
  if (cropSize.width !== geometry.context.width || cropSize.height !== geometry.context.height) throw new Error("区域重绘裁块尺寸与准备记录不一致。");
}

/** Blend only inward from internal boundaries; an image-edge pixel always receives the full patch. */
function patchWeight(x: number, y: number, geometry: KeyframeFocusPatchGeometry, feather: number): number {
  if (!feather) return 1;
  const { selection, width, height } = geometry;
  if (x === 0 || y === 0 || x === width - 1 || y === height - 1) return 1;
  let distance = Number.POSITIVE_INFINITY;
  if (selection.x > 0) distance = Math.min(distance, x - selection.x);
  if (selection.y > 0) distance = Math.min(distance, y - selection.y);
  if (selection.x + selection.width < width) distance = Math.min(distance, selection.x + selection.width - 1 - x);
  if (selection.y + selection.height < height) distance = Math.min(distance, selection.y + selection.height - 1 - y);
  return Math.min(1, (distance + 1) / feather);
}

export async function composeKeyframeFocusPatch(input: {
  prepared: PreparedKeyframeFocusPatch;
  patchPath: string;
  outputPath: string;
  featherPixels?: number;
}): Promise<{ outputPath: string; width: number; height: number }> {
  const feather = input.featherPixels ?? 8;
  if (!Number.isSafeInteger(feather) || feather < 0 || feather > 64) throw new Error("区域重绘羽化范围必须是 0 至 64 像素的整数。");
  await assertKeyframeFocusPatchPrepared(input.prepared);
  const { sourcePath, cropPath, geometry } = input.prepared;
  const outputPath = resolve(input.outputPath), patchPath = resolve(input.patchPath);
  if ([sourcePath, cropPath, patchPath].some(path => resolve(path) === outputPath)) throw new Error("区域重绘成品不能覆盖源图、裁块或模型原始返回图。");
  // Reject oversized/non-PNG patches before starting an image decoder.
  pngDimensions(await readFile(patchPath));
  const { width, height, selection, context } = geometry;
  const source = await decodeRgba(sourcePath, width, height);
  const patch = await decodeRgba(patchPath, context.width, context.height, true);
  const output = Buffer.from(source);
  for (let y = selection.y; y < selection.y + selection.height; y++) {
    for (let x = selection.x; x < selection.x + selection.width; x++) {
      const targetOffset = (y * width + x) * 4;
      const patchOffset = ((y - context.y) * context.width + x - context.x) * 4;
      const weight = patchWeight(x, y, geometry, feather);
      if (weight === 1) patch.copy(output, targetOffset, patchOffset, patchOffset + 4);
      else for (let channel = 0; channel < 4; channel++) {
        output[targetOffset + channel] = Math.round(source[targetOffset + channel] * (1 - weight) + patch[patchOffset + channel] * weight);
      }
    }
  }
  const png = await encodePng(output, width, height);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, png, { flag: "wx" });
  return { outputPath, width, height };
}
