import { describe, expect, it } from "vitest";
import { detectStoryboardGridCells } from "@/lib/storyboard-grid-crop";
import type { GridCell } from "@/lib/storyboard-grid";

type Rgb = readonly [number, number, number];

const WIDTH = 300;
const HEIGHT = 540;
const X_SPLITS = [106, 194];
const Y_SPLITS = [172, 354];
const COLORS: Rgb[] = [
  [133, 71, 54], [62, 115, 78], [54, 77, 139],
  [142, 102, 52], [96, 58, 128], [51, 111, 132],
  [141, 65, 100], [85, 121, 53], [96, 77, 59],
];

function paint(rgb: Uint8Array, x: number, y: number, w: number, h: number, color: Rgb) {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      rgb.set(color, (row * WIDTH + col) * 3);
    }
  }
}

function makeGrid(options: {
  gutter?: number;
  color?: Rgb;
  edgeColor?: Rgb;
  missingVertical?: number;
  missingHorizontal?: number;
} = {}) {
  const gutter = options.gutter ?? 2;
  const color = options.color ?? [255, 255, 255];
  const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
  const xEdges = [0, ...X_SPLITS, WIDTH];
  const yEdges = [0, ...Y_SPLITS, HEIGHT];
  const content: GridCell[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      paint(rgb, xEdges[col], yEdges[row], xEdges[col + 1] - xEdges[col], yEdges[row + 1] - yEdges[row], COLORS[row * 3 + col]);
      const x = xEdges[col] + (col > 0 ? gutter : 0);
      const y = yEdges[row] + (row > 0 ? gutter : 0);
      content.push({ x, y, w: xEdges[col + 1] - x, h: yEdges[row + 1] - y });
    }
  }
  for (const [index, split] of X_SPLITS.entries()) {
    if (index === options.missingVertical) continue;
    paint(rgb, split, 0, gutter, HEIGHT, color);
    if (options.edgeColor && gutter > 2) {
      paint(rgb, split, 0, 1, HEIGHT, options.edgeColor);
      paint(rgb, split + gutter - 1, 0, 1, HEIGHT, options.edgeColor);
    }
  }
  for (const [index, split] of Y_SPLITS.entries()) {
    if (index === options.missingHorizontal) continue;
    paint(rgb, 0, split, WIDTH, gutter, color);
    if (options.edgeColor && gutter > 2) {
      paint(rgb, 0, split, WIDTH, 1, options.edgeColor);
      paint(rgb, 0, split + gutter - 1, WIDTH, 1, options.edgeColor);
    }
  }
  return { rgb, content };
}

function expectContainedCells(cells: GridCell[], content: GridCell[]) {
  expect(cells).toHaveLength(9);
  cells.forEach((cell, index) => {
    const expected = content[index];
    expect(Number.isInteger(cell.x)).toBe(true);
    expect(Number.isInteger(cell.y)).toBe(true);
    expect(Number.isInteger(cell.w)).toBe(true);
    expect(Number.isInteger(cell.h)).toBe(true);
    expect(cell.x).toBeGreaterThan(expected.x);
    expect(cell.y).toBeGreaterThan(expected.y);
    expect(cell.x + cell.w).toBeLessThan(expected.x + expected.w);
    expect(cell.y + cell.h).toBeLessThan(expected.y + expected.h);
    expect(cell.w).toBeGreaterThan(expected.w * 0.85);
    expect(cell.h).toBeGreaterThan(expected.h * 0.85);
  });
}

describe("detectStoryboardGridCells", () => {
  it.each([1, 2, 3])("keeps every crop inside its own shifted panel with %i px seams", (gutter) => {
    const { rgb, content } = makeGrid({ gutter });
    const cells = detectStoryboardGridCells(rgb, WIDTH, HEIGHT);
    expectContainedCells(cells, content);

    // Check every retained pixel: even a thin neighboring strip poisons an image-to-video reference.
    cells.forEach((cell, index) => {
      const expected = COLORS[index];
      let foreignPixels = 0;
      for (let y = cell.y; y < cell.y + cell.h; y++) {
        for (let x = cell.x; x < cell.x + cell.w; x++) {
          const offset = (y * WIDTH + x) * 3;
          if (rgb[offset] !== expected[0] || rgb[offset + 1] !== expected[1] || rgb[offset + 2] !== expected[2]) foreignPixels++;
        }
      }
      expect(foreignPixels).toBe(0);
    });
  });

  it("excludes thick gutters from the crops", () => {
    const { rgb, content } = makeGrid({ gutter: 10 });
    expectContainedCells(detectStoryboardGridCells(rgb, WIDTH, HEIGHT), content);
  });

  it("recognizes warm off-white gutters with anti-aliased edges", () => {
    const { rgb, content } = makeGrid({
      gutter: 4,
      color: [243, 240, 234],
      edgeColor: [224, 221, 215],
    });
    expectContainedCells(detectStoryboardGridCells(rgb, WIDTH, HEIGHT), content);
  });

  it("does not mistake a partial vertical white object for the real continuous seam", () => {
    const { rgb, content } = makeGrid();
    paint(rgb, 99, 16, 3, 130, [255, 255, 255]);
    expectContainedCells(detectStoryboardGridCells(rgb, WIDTH, HEIGHT), content);
  });

  it("follows column seams that shift between rows", () => {
    const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
    const rowSplits = [[106, 194], [99, 205], [103, 198]];
    const yEdges = [0, ...Y_SPLITS, HEIGHT];
    const content: GridCell[] = [];
    rowSplits.forEach((splits, row) => {
      const xEdges = [0, ...splits, WIDTH];
      for (let col = 0; col < 3; col++) {
        paint(rgb, xEdges[col], yEdges[row], xEdges[col + 1] - xEdges[col], yEdges[row + 1] - yEdges[row], COLORS[row * 3 + col]);
        const x = xEdges[col] + (col > 0 ? 2 : 0);
        const y = yEdges[row] + (row > 0 ? 2 : 0);
        content.push({ x, y, w: xEdges[col + 1] - x, h: yEdges[row + 1] - y });
      }
      splits.forEach((split) => paint(rgb, split, yEdges[row], 2, yEdges[row + 1] - yEdges[row], [255, 255, 255]));
    });
    Y_SPLITS.forEach((split) => paint(rgb, 0, split, WIDTH, 2, [255, 255, 255]));
    expectContainedCells(detectStoryboardGridCells(rgb, WIDTH, HEIGHT), content);
  });

  it.each([
    { missingVertical: 0 },
    { missingVertical: 1 },
    { missingHorizontal: 0 },
    { missingHorizontal: 1 },
  ])("rejects a grid with an absent separating line: %j", (options) => {
    const { rgb } = makeGrid(options);
    expect(() => detectStoryboardGridCells(rgb, WIDTH, HEIGHT)).toThrow();
  });

  it("rejects competing continuous seams instead of guessing a crop", () => {
    const { rgb } = makeGrid();
    paint(rgb, 94, 0, 2, HEIGHT, [255, 255, 255]);
    expect(() => detectStoryboardGridCells(rgb, WIDTH, HEIGHT)).toThrow();
  });

  it("rejects brighter scenery lines competing with slightly degraded real seams", () => {
    const { rgb } = makeGrid();
    const yEdges = [0, ...Y_SPLITS, HEIGHT];
    for (let row = 0; row < 3; row++) {
      // Each true separator still has >90% light support and low enough
      // variation to qualify; its score is lower than the white scene stripe.
      const top = yEdges[row], bottom = yEdges[row + 1];
      for (const split of X_SPLITS) {
        paint(rgb, split, top + 12, 2, Math.floor((bottom - top) * 0.08), [190, 190, 190]);
      }
    }
    paint(rgb, 94, 0, 2, HEIGHT, [255, 255, 255]);
    paint(rgb, 206, 0, 2, HEIGHT, [255, 255, 255]);

    // Picking the brighter pair would make the middle crop cross both true
    // separators and contain strips of its neighboring panels.
    expect(() => detectStoryboardGridCells(rgb, WIDTH, HEIGHT)).toThrow();
  });

  it.each([255, 190])("rejects a uniform %i image without a grid", (value) => {
    const rgb = new Uint8Array(WIDTH * HEIGHT * 3).fill(value);
    expect(() => detectStoryboardGridCells(rgb, WIDTH, HEIGHT)).toThrow();
  });

  it.each([
    [0, HEIGHT], [-1, HEIGHT], [WIDTH, 0], [WIDTH, -1],
    [Number.NaN, HEIGHT], [WIDTH, Number.POSITIVE_INFINITY], [WIDTH + 0.5, HEIGHT],
  ])("rejects invalid image dimensions %s x %s", (width, height) => {
    expect(() => detectStoryboardGridCells(new Uint8Array(WIDTH * HEIGHT * 3), width, height)).toThrow();
  });

  it("rejects a truncated RGB image", () => {
    expect(() => detectStoryboardGridCells(new Uint8Array(WIDTH * HEIGHT * 3 - 1), WIDTH, HEIGHT)).toThrow();
  });
});
