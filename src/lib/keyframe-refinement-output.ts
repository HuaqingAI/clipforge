import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { ffmpegBin } from "@/lib/ffmpeg-path";
import { probeMedia } from "@/lib/media-probe";

const execFileAsync = promisify(execFile);
const MAX_PIXELS = 16_777_216;

function assertDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 1 || height < 1 || width * height > MAX_PIXELS) {
    throw new Error("Invalid refinement image dimensions.");
  }
}

/** Fit the saved image inside its output limit without cropping, enlargement or sharpening. */
export async function fitKeyframeRefinementOutput(input: {
  sourcePath: string;
  outputPath: string;
  target: { width: number; height: number };
}): Promise<string> {
  assertDimensions(input.target.width, input.target.height);
  if (resolve(input.sourcePath) === resolve(input.outputPath)) {
    throw new Error("Refinement output must not overwrite its source image.");
  }
  const source = await probeMedia(input.sourcePath);
  if (source.duration > 0) throw new Error("Refinement output must be a still image.");
  assertDimensions(source.width, source.height);
  const scale = Math.min(1, input.target.width / source.width, input.target.height / source.height);
  if (scale === 1) return input.sourcePath;

  const width = Math.max(1, Math.floor(source.width * scale));
  const height = Math.max(1, Math.floor(source.height * scale));
  const { stdout } = await execFileAsync(ffmpegBin(), [
    "-nostdin", "-v", "error", "-noautorotate", "-i", input.sourcePath,
    "-frames:v", "1", "-vf", `scale=${width}:${height}:flags=area`,
    "-c:v", "png", "-pix_fmt", "rgba", "-f", "image2pipe", "pipe:1",
  ], { encoding: "buffer", timeout: 60_000, maxBuffer: width * height * 4 + 1024 * 1024 });
  await mkdir(dirname(input.outputPath), { recursive: true });
  await writeFile(input.outputPath, stdout, { flag: "wx" });
  return input.outputPath;
}
