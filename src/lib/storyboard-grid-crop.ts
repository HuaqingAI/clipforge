import { execFile } from "child_process";
import { promisify } from "util";
import { ffmpegBin } from "@/lib/ffmpeg-path";
import type { GridCell } from "@/lib/storyboard-grid";

const execFileAsync = promisify(execFile);
const LAYOUT_ERROR = "无法可靠识别九宫格的分隔线，未替换分镜关键帧。请重新生成具有清晰、连续白色分隔线的 3×3 分镜图。";

export class StoryboardGridLayoutError extends Error {
  constructor() {
    super(LAYOUT_ERROR);
    this.name = "StoryboardGridLayoutError";
  }
}

interface Gutter { start: number; end: number }

/**
 * Locate continuous light, neutral gutters, rather than assuming the model put
 * them at exact thirds. Search only around the two expected splits: furniture,
 * window frames and other bright objects elsewhere are not layout evidence.
 */
export function detectStoryboardGridCells(rgb: Uint8Array, width: number, height: number): GridCell[] {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 18 || height < 18
    || rgb.length !== width * height * 3) throw new StoryboardGridLayoutError();

  function gutters(axis: "x" | "y", spanStart: number, spanEnd: number): Gutter[] {
    const length = axis === "x" ? width : height;
    const cellSize = length / 3;
    // Ignore the outermost pixels, where generated frames can have decorations.
    const margin = Math.max(1, Math.floor((spanEnd - spanStart) * 0.02));
    const from = spanStart + margin;
    const to = spanEnd - margin;
    const sampleCount = to - from;
    const pixelOffset = (position: number, along: number) => axis === "x"
      ? (along * width + position) * 3 : (position * width + along) * 3;

    return [1, 2].map((split) => {
      const expected = cellSize * split;
      const searchStart = Math.max(1, Math.floor(expected - cellSize * 0.24));
      const searchEnd = Math.min(length - 1, Math.ceil(expected + cellSize * 0.24));
      const lines: number[] = [];
      for (let position = searchStart; position < searchEnd; position++) {
        let light = 0, sum = 0, sumSquares = 0;
        for (let along = from; along < to; along++) {
          const offset = pixelOffset(position, along);
          const r = rgb[offset], g = rgb[offset + 1], b = rgb[offset + 2];
          const value = (r + g + b) / 3;
          sum += value;
          sumSquares += value * value;
          if (Math.min(r, g, b) >= 200 && Math.max(r, g, b) - Math.min(r, g, b) <= 38) {
            light++;
          }
        }
        const support = light / sampleCount;
        const mean = sum / sampleCount;
        const deviation = Math.sqrt(Math.max(0, sumSquares / sampleCount - mean * mean));
        // Keep slightly interrupted seams as competing evidence too. Discarding
        // one could make a cleaner scene line look like the only valid divider.
        if (support < 0.9 || deviation > 22) continue;
        lines.push(position);
      }

      const runs: Gutter[] = [];
      for (const position of lines) {
        const previous = runs.at(-1);
        if (previous && previous.end === position) {
          previous.end++;
        } else runs.push({ start: position, end: position + 1 });
      }
      const candidates = runs.filter((run) => {
        // Broad white scenery is not a hairline gutter. A real gutter must also
        // separate visible content on both sides, not just be a bright stripe.
        if (run.end - run.start > Math.max(3, cellSize * 0.12)
          || run.start === searchStart || run.end === searchEnd) return false;
        let contrast = 0;
        const center = Math.floor((run.start + run.end - 1) / 2);
        const left = Math.max(0, run.start - 2);
        const right = Math.min(length - 1, run.end + 1);
        for (let along = from; along < to; along++) {
          const midOffset = pixelOffset(center, along);
          const leftOffset = pixelOffset(left, along);
          const rightOffset = pixelOffset(right, along);
          let difference = 0;
          for (let channel = 0; channel < 3; channel++) {
            difference += Math.abs(rgb[midOffset + channel] - rgb[leftOffset + channel])
              + Math.abs(rgb[midOffset + channel] - rgb[rightOffset + channel]);
          }
          contrast += difference / 6;
        }
        return contrast / sampleCount >= 8;
      });
      // A window frame can be brighter than the actual generated gutter. Never
      // resolve competing layout evidence by brightness or proximity to thirds.
      if (candidates.length !== 1) throw new StoryboardGridLayoutError();
      return candidates[0];
    });
  }

  const horizontal = gutters("y", 0, width);
  const rowBounds = [0, ...horizontal.map((gutter) => gutter.end)];
  const rowEnds = [...horizontal.map((gutter) => gutter.start), height];
  const cells: GridCell[] = [];
  for (let row = 0; row < 3; row++) {
    const top = rowBounds[row], bottom = rowEnds[row];
    const vertical = gutters("x", top, bottom);
    const colBounds = [0, ...vertical.map((gutter) => gutter.end)];
    const colEnds = [...vertical.map((gutter) => gutter.start), width];
    for (let col = 0; col < 3; col++) {
      const left = colBounds[col], right = colEnds[col];
      // Inset the ACTUAL cell and round inward. This also removes antialiasing
      // along a gutter without importing even one pixel from a neighboring shot.
      const dx = Math.max(1, Math.ceil((right - left) * 0.02));
      const dy = Math.max(1, Math.ceil((bottom - top) * 0.02));
      const w = right - left - dx * 2, h = bottom - top - dy * 2;
      if (w < 2 || h < 2) throw new StoryboardGridLayoutError();
      cells.push({ x: left + dx, y: top + dy, w, h });
    }
  }
  return cells;
}

/** Decode once; keep hairline seams at native resolution (no lossy rescaling). */
export async function readStoryboardGridCells(path: string, width: number, height: number): Promise<GridCell[]> {
  const byteLength = width * height * 3;
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > 192 * 1024 * 1024) throw new StoryboardGridLayoutError();
  const { stdout } = await execFileAsync(ffmpegBin(), [
    "-v", "error", "-i", path, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
  ], { encoding: "buffer", maxBuffer: byteLength + 1024, timeout: 30_000 });
  return detectStoryboardGridCells(stdout, width, height);
}
