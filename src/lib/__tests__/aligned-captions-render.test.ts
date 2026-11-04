// @vitest-environment node
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffmpegBin } from "@/lib/ffmpeg-path";
import { ffmpegFilterFileArgs } from "@/lib/ffmpeg-filter-file";
import { escapeSubtitlesPath } from "@/lib/video-composer/composer";
import { ALIGNED_CAPTION_FONT_RELATIVE_PATH, buildAlignedCaptionsAss } from "@/lib/video-composer/aligned-captions";

const run = promisify(execFile);
const width = 576;
const height = 1024;
const frameBytes = width * height * 3;

function ink(frame: Buffer, xStart = 0, xEnd = width) {
  const result = { yellow: 0, white: 0, left: width, right: 0, yellowLeft: width, yellowRight: 0 };
  for (let y = 650; y < 800; y++) {
    for (let x = xStart; x < xEnd; x++) {
      const offset = (y * width + x) * 3;
      const [r, g, b] = [frame[offset], frame[offset + 1], frame[offset + 2]];
      const yellow = r > 180 && g > 160 && b < 80;
      const white = r > 180 && g > 180 && b > 180;
      if (yellow) {
        result.yellow++;
        result.yellowLeft = Math.min(result.yellowLeft, x);
        result.yellowRight = Math.max(result.yellowRight, x);
      } else if (white) result.white++;
      if (yellow || white) {
        result.left = Math.min(result.left, x);
        result.right = Math.max(result.right, x);
      }
    }
  }
  return result;
}

describe("Komika Axis actual libass output", () => {
  let directory: string;
  beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "clipforge-aligned-caption-")); });
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  async function frames(ass: string, sampleFrames: number[]) {
    const assPath = join(directory, "captions.ass");
    const graphPath = join(directory, "captions.filter.txt");
    await writeFile(assPath, ass, "utf8");
    const fontDir = dirname(resolve(ALIGNED_CAPTION_FONT_RELATIVE_PATH));
    const selection = sampleFrames.map(frame => `eq(n,${frame})`).join("+");
    await writeFile(graphPath, `[0:v]subtitles='${escapeSubtitlesPath(assPath)}':fontsdir='${escapeSubtitlesPath(fontDir)}',select='${selection}'[samples]`, "utf8");
    const { stdout, stderr } = await run(ffmpegBin(), [
      "-v", "verbose", "-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:r=30:d=2`,
      ...await ffmpegFilterFileArgs(graphPath), "-map", "[samples]", "-fps_mode", "vfr",
      "-frames:v", String(sampleFrames.length), "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
    ], { encoding: "buffer", maxBuffer: frameBytes * sampleFrames.length + 100_000, timeout: 20_000 });
    expect(stderr.toString()).toMatch(/fontselect: \(Komika Axis, 400, 0\) -> KomikaAxis/);
    expect(stdout.length).toBe(frameBytes * sampleFrames.length);
    return sampleFrames.map((_, index) => stdout.subarray(index * frameBytes, (index + 1) * frameBytes));
  }

  it("shows the phrase together and restores each previous word to white on actual decoded frames", async () => {
    const ass = buildAlignedCaptionsAss([{
      text: "KEEP FEET WARM", startTime: 0, endTime: 2,
      words: ["KEEP", "FEET", "WARM"].map((text, index) => ({ text, startSec: 0.5 + index * 0.3, endSec: 0.7 + index * 0.3 })),
    }]);
    const [before, first, second, third, after] = await frames(ass, [6, 18, 27, 36, 54]);
    const all = [first, second, third].map(frame => ink(frame));
    expect(ink(before).yellow + ink(before).white).toBe(0);
    expect(ink(after).yellow + ink(after).white).toBe(0);
    for (const frame of all) {
      expect(frame.yellow).toBeGreaterThan(150);
      expect(frame.white).toBeGreaterThan(300);
      expect(frame.left).toBeGreaterThan(24);
      expect(frame.right).toBeLessThan(width - 24);
    }
    expect(all[1].yellowLeft).toBeGreaterThan(all[0].yellowRight);
    expect(all[2].yellowLeft).toBeGreaterThan(all[1].yellowRight);
    const firstWordLater = ink(third, all[0].yellowLeft, all[0].yellowRight + 1);
    expect(firstWordLater.yellow).toBe(0);
    expect(firstWordLater.white).toBeGreaterThan(150);
    const sums = all.map(frame => frame.white + frame.yellow);
    expect(Math.max(...sums) / Math.min(...sums)).toBeLessThan(1.1);
  }, 25_000);

  it("fits a word substantially wider than the frame without cropping", async () => {
    const text = "SUPERWATERPROOFMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM";
    const ass = buildAlignedCaptionsAss([{
      text, startTime: 0, endTime: 2, words: [{ text, startSec: 0.5, endSec: 1.5 }],
    }]);
    const [frame] = await frames(ass, [24]);
    const bounds = ink(frame);
    expect(bounds.yellow).toBeGreaterThan(250);
    expect(bounds.left).toBeGreaterThan(24);
    expect(bounds.right).toBeLessThan(width - 24);
  }, 25_000);
});
