// @vitest-environment node
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ffmpegBin } from "@/lib/ffmpeg-path";
import { ffmpegFilterFileArgs } from "@/lib/ffmpeg-filter-file";
import { buildComposeInvocation } from "@/lib/video-composer/composer";
import { buildKaraokeAss } from "@/lib/video-composer/karaoke";

const run = promisify(execFile);
const width = 1280;
const height = 720;
const frameBytes = width * height * 3;

function countCaptionColours(frame: Buffer): { yellow: number; white: number } {
  let yellow = 0;
  let white = 0;
  for (let i = 0; i < frame.length; i += 3) {
    const [red, green, blue] = [frame[i], frame[i + 1], frame[i + 2]];
    if (red > 180 && green > 160 && blue < 80) yellow++;
    else if (red > 180 && green > 180 && blue > 180) white++;
  }
  return { yellow, white };
}

describe("estimated English karaoke rendering", () => {
  let directory: string;
  let source: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "clipforge-karaoke-render-"));
    vi.stubEnv("APP_DATA_DIR", directory);
    source = join(directory, "black.mp4");
    await run(ffmpegBin(), ["-v", "error", "-y", "-f", "lavfi", "-i",
      "color=c=black:s=64x64:r=30:d=4", "-c:v", "libx264", "-preset", "ultrafast",
      "-pix_fmt", "yuv420p", source,
    ], { timeout: 15_000 });
  }, 20_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("keeps the English line visible while its estimated words successively turn yellow", async () => {
    const assPath = join(directory, "estimated.ass");
    // No word timestamps or audio input: three equal-length words receive one second each.
    await writeFile(assPath, buildKaraokeAss([
      { text: "KEEP FEET WARM", startTime: 0.5, endTime: 3.5 },
    ], {
      fontName: "Arial", fontSize: 56, playResX: width, playResY: height, marginV: 96,
    }), "utf8");
    const invocation = buildComposeInvocation({
      projectId: "estimated-karaoke-render",
      clips: [{ type: "video", filePath: source, duration: 4, sourceDuration: 4, transition: "direct_concat" }],
      output: { resolution: "720p", aspectRatio: "16:9" },
      subtitle: { texts: [], karaokeAssPath: assPath },
    });
    expect(invocation.filterComplex).toContain("subtitles=");
    // Sample before the line, twice within word one, word two, word three and after the line.
    // Selecting real composed frames also exercises libass and Windows ASS-path escaping.
    const sampledFrames = [6, 18, 39, 48, 78, 114];
    const selection = sampledFrames.map((n) => `eq(n,${n})`).join("+");
    const graphPath = join(directory, "karaoke.filter.txt");
    await writeFile(graphPath, `${invocation.filterComplex};\n${invocation.outputArgs[1]}select='${selection}'[samples]`, "utf8");
    const filterArgs = await ffmpegFilterFileArgs(graphPath);
    const { stdout } = await run(ffmpegBin(), [
      "-v", "error", ...invocation.inputArgs, ...filterArgs, "-map", "[samples]",
      "-fps_mode", "vfr", "-frames:v", String(sampledFrames.length),
      "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
    ], { encoding: "buffer", maxBuffer: frameBytes * sampledFrames.length + 1024, timeout: 30_000 });
    expect(stdout.length).toBe(frameBytes * sampledFrames.length);
    const [before, first, firstHeld, second, third, after] = sampledFrames.map((_, index) =>
      countCaptionColours(stdout.subarray(index * frameBytes, (index + 1) * frameBytes)));

    expect(before).toEqual({ yellow: 0, white: 0 });
    expect(after).toEqual({ yellow: 0, white: 0 });
    expect(first.yellow).toBeGreaterThan(500);
    expect(first.white).toBeGreaterThan(first.yellow);
    expect(firstHeld).toEqual(first); // each word changes as a unit, then holds its colour
    expect(second.yellow).toBeGreaterThan(first.yellow * 1.3);
    expect(second.white).toBeLessThan(first.white * 0.8);
    expect(third.yellow).toBeGreaterThan(second.yellow * 1.2);
    expect(third.white).toBeLessThan(first.white * 0.03);
    // Whole-line visibility is stable; the animation recolours the existing sentence.
    for (const frame of [second, third]) {
      expect(frame.yellow + frame.white).toBeGreaterThan((first.yellow + first.white) * 0.85);
      expect(frame.yellow + frame.white).toBeLessThan((first.yellow + first.white) * 1.15);
    }
  }, 40_000);

  it("wraps a long English sentence inside the portrait frame instead of cropping its words", async () => {
    const portraitWidth = 720;
    const portraitHeight = 1280;
    const assPath = join(directory, "portrait.ass");
    await writeFile(assPath, buildKaraokeAss([
      { text: "These TIDEWE rubber boots are waterproof for wet crossings and muddy approaches.", startTime: 0, endTime: 4 },
    ], { fontName: "Arial" }), "utf8");
    const invocation = buildComposeInvocation({
      projectId: "estimated-karaoke-portrait",
      clips: [{ type: "video", filePath: source, duration: 4, sourceDuration: 4, transition: "direct_concat" }],
      output: { resolution: "720p", aspectRatio: "9:16" },
      subtitle: { texts: [], karaokeAssPath: assPath },
    });
    const graphPath = join(directory, "portrait.filter.txt");
    await writeFile(graphPath, `${invocation.filterComplex};\n${invocation.outputArgs[1]}select='eq(n,30)'[sample]`, "utf8");
    const filterArgs = await ffmpegFilterFileArgs(graphPath);
    const { stdout } = await run(ffmpegBin(), [
      "-v", "error", ...invocation.inputArgs, ...filterArgs, "-map", "[sample]",
      "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
    ], { encoding: "buffer", maxBuffer: frameBytes + 1024, timeout: 30_000 });
    expect(stdout.length).toBe(portraitWidth * portraitHeight * 3);
    let left = portraitWidth;
    let right = 0;
    let top = portraitHeight;
    let bottom = 0;
    let ink = 0;
    for (let i = 0; i < stdout.length; i += 3) {
      if (stdout[i] <= 180 || stdout[i + 1] <= 160) continue;
      const x = (i / 3) % portraitWidth;
      const y = Math.floor(i / 3 / portraitWidth);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      ink++;
    }
    expect(ink).toBeGreaterThan(500);
    expect(left).toBeGreaterThan(24);
    expect(right).toBeLessThan(portraitWidth - 24);
    expect(bottom - top).toBeGreaterThan(35); // multiple visible lines at the default ASS font size
  }, 40_000);
});
