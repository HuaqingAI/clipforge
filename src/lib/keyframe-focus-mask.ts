import { deflateSync } from "node:zlib";
import { isKeyframeFocusRegion, type KeyframeFocusRegion } from "@/lib/keyframe-refinement";

/** Reject misspelled region controls instead of silently editing a different area. */
export function validKeyframeFocusRegion(value: unknown): value is KeyframeFocusRegion {
  return isKeyframeFocusRegion(value)
    && Object.keys(value).length === 4
    && Object.keys(value).every((key) => ["x", "y", "width", "height"].includes(key));
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return result;
}

/** Native edit mask: alpha 0 inside the selected rectangle, alpha 255 elsewhere. */
export function buildKeyframeFocusMask(width: number, height: number, region: KeyframeFocusRegion): Buffer {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 16_777_216) {
    throw new Error("区域重绘源图尺寸无效或超过 1600 万像素，请先使用较小的 PNG 关键帧。");
  }
  if (!validKeyframeFocusRegion(region)) throw new Error("区域重绘需要有效的归一化矩形。");
  const left = Math.floor(region.x * width), top = Math.floor(region.y * height);
  const right = Math.min(width, Math.ceil((region.x + region.width) * width));
  const bottom = Math.min(height, Math.ceil((region.y + region.height) * height));
  const stride = width * 4 + 1;
  const rows = Buffer.alloc(stride * height, 255);
  for (let y = 0; y < height; y++) {
    rows[y * stride] = 0; // PNG filter: none.
    if (y >= top && y < bottom) {
      for (let x = left; x < right; x++) rows[y * stride + 1 + x * 4 + 3] = 0;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 8-bit channels.
  header[9] = 6; // RGBA, not grayscale or RGB.
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
