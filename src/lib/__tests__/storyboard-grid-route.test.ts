// @vitest-environment node
import { execFileSync } from "child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { createRequire } from "module";
import { tmpdir } from "os";
import { join } from "path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { probeMedia } from "@/lib/media-probe";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
import { POST } from "@/app/api/project/[id]/storyboard-grid/route";

const require = createRequire(import.meta.url);
const sqlite = new Database(":memory:");
const db = drizzle(sqlite, { schema });
const projectId = "grid-reference-project";
const scriptId = "grid-reference-script";
const productPaths = ["product-front.png", "product-side.png"]
  .map((name) => `/api/files/${projectId}/${name}`);
const presenterPath = `/api/files/${projectId}/presenter.png`;
const fetchMock = vi.fn<typeof fetch>();
let directory: string;
let gridBase64: string;
let productBytes: Buffer[];
let presenterBytes: Buffer;
const originalShots: schema.Shot[] = [1, 2].map((shotId) => ({
  shotId, type: "demo", duration: 3, description: `Product demonstration ${shotId}`,
  camera: "static", visualSource: "ai_generate", transition: "direct_concat", voiceover: "",
}));

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "clipforge-grid-reference-"));
  vi.stubEnv("APP_DATA_DIR", directory);
  vi.stubEnv("FFMPEG_PATH", require("ffmpeg-static") as string);
  vi.stubEnv("FFPROBE_PATH", (require("@ffprobe-installer/ffprobe") as { path: string }).path);
  state.db = db;
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  db.insert(schema.projects).values({
    id: projectId,
    name: "Previously uploaded product photos",
    productImages: productPaths,
  }).run();
  db.insert(schema.scripts).values({
    id: scriptId,
    projectId,
    styleType: "scene",
    shots: originalShots,
  }).run();
  const uploads = join(directory, "uploads", projectId);
  await mkdir(uploads, { recursive: true });
  for (const [name, color] of [["product-front.png", "red"], ["product-side.png", "blue"], ["presenter.png", "green"]]) {
    execFileSync(process.env.FFMPEG_PATH!, [
      "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=90x162`,
      "-frames:v", "1", join(uploads, name),
    ]);
  }
  execFileSync(process.env.FFMPEG_PATH!, ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=90x162:d=0.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(uploads, "existing-video.mp4")]);
  productBytes = await Promise.all(["product-front.png", "product-side.png"].map((name) => readFile(join(uploads, name))));
  presenterBytes = await readFile(join(uploads, "presenter.png"));
  gridBase64 = productBytes[0].toString("base64");
}, 20_000);

beforeEach(async () => {
  await rm(join(directory, "storyboard-grids", `${projectId}.json`), { force: true });
  db.update(schema.scripts).set({ shots: originalShots }).where(eq(schema.scripts.id, scriptId)).run();
  db.delete(schema.assets).run();
  db.insert(schema.assets).values({
    id: "previous-take",
    projectId,
    shotId: 1,
    type: "ai_generated",
    filePath: "/api/files/previous.png",
    selected: true,
    status: "done",
  }).run();
  fetchMock.mockReset();
  // Only the external provider response is replaced; local image conversion,
  // provider multipart construction, persistence, FFmpeg cropping and DB writes run normally.
  fetchMock.mockImplementation(async (input) => {
    expect(String(input)).toMatch(/^https:\/\/image-provider\.test\/v1\/images\/(edits|generations)$/);
    return Response.json({ created: 123, data: [{ b64_json: gridBase64 }] });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  sqlite.close();
  await rm(directory, { recursive: true, force: true });
});

async function generate(references: Record<string, unknown>, expectedRequests = 1) {
  const response = await POST(new NextRequest(`http://localhost/api/project/${projectId}/storyboard-grid`, {
    method: "POST",
    body: JSON.stringify({
      scriptId,
      provider: "openai",
      model: "gpt-image-2",
      apiKey: "test-key",
      baseUrl: "https://image-provider.test/v1",
      ...references,
    }),
  }), { params: Promise.resolve({ id: projectId }) });
  const result = await response.json();
  expect(result).not.toHaveProperty("error");
  expect(response.status).toBe(200);
  expect(result).toMatchObject({ count: 2, cells: [{ shotId: 1 }, { shotId: 2 }] });
  expect(fetchMock).toHaveBeenCalledTimes(expectedRequests);
  return result as { gridPath: string; cells: { shotId: number; filePath: string }[]; count: number; reused: boolean };
}

async function assertUploadedImages(expected: Buffer[]) {
  const [url, request] = fetchMock.mock.calls[0];
  expect(url).toBe("https://image-provider.test/v1/images/edits");
  expect(request?.method).toBe("POST");
  expect(request?.headers).toMatchObject({ Authorization: "Bearer test-key" });
  expect(request?.body).toBeInstanceOf(FormData);
  const form = request!.body as FormData;
  const images = form.getAll("image[]") as File[];
  expect(images).toHaveLength(expected.length);
  for (let i = 0; i < images.length; i++) {
    expect(images[i].type).toBe("image/png");
    expect(Buffer.from(await images[i].arrayBuffer())).toEqual(expected[i]);
  }
  return form;
}

describe("storyboard grid uploaded product references", () => {
  it("sends both existing local product photos as ordered multipart images and saves usable shot crops", async () => {
    const result = await generate({ productImageUrls: productPaths });
    const form = await assertUploadedImages(productBytes);
    expect(form.get("prompt")).toContain("第 1 张参考图是商品实拍图");
    expect(form.get("prompt")).toContain("第 2 张参考图是商品实拍图");
    expect(await readFile(join(directory, "uploads", result.gridPath.replace("/api/files/", ""))))
      .toEqual(productBytes[0]);
    const saved = db.select().from(schema.assets).all();
    expect(saved.find((asset) => asset.id === "previous-take")?.selected).toBe(false);
    expect(saved.filter((asset) => asset.selected)).toHaveLength(2);
    for (const cell of result.cells) {
      const filePath = join(directory, "uploads", cell.filePath.replace("/api/files/", ""));
      expect(await probeMedia(filePath)).toMatchObject({ width: 29, height: 52, videoCodec: "png" });
      expect(saved).toContainEqual(expect.objectContaining({
        shotId: cell.shotId, filePath: cell.filePath, selected: true, status: "done",
      }));
    }
  });

  it("keeps the presenter before every product view and gives the array precedence over the legacy field", async () => {
    await generate({
      characterSheetUrl: presenterPath,
      productImageUrls: productPaths,
      productImageUrl: "/api/files/not-used.png",
    });
    const form = await assertUploadedImages([presenterBytes, ...productBytes]);
    expect(form.get("prompt")).toContain("第 1 张参考图是出镜人物");
    expect(form.get("prompt")).toContain("第 2 张参考图是商品实拍图");
    expect(form.get("prompt")).toContain("第 3 张参考图是商品实拍图");
  });

  it("retains compatibility with the single product reference field", async () => {
    await generate({ productImageUrl: productPaths[1] });
    await assertUploadedImages([productBytes[1]]);
  });

  it("honors an explicit empty product list without reintroducing legacy or saved product references", async () => {
    await generate({ productImageUrls: [], productImageUrl: productPaths[0] });
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("https://image-provider.test/v1/images/generations");
    expect(typeof request?.body).toBe("string");
    const body = JSON.parse(request!.body as string);
    expect(body.model).toBe("gpt-image-2");
    expect(body.prompt).not.toContain("参考图是商品实拍图");
  });

  it("reuses the persisted complete grid on a matching explicit retry without paying for another image", async () => {
    const first = await generate({ productImageUrls: productPaths, reuseExisting: true });
    expect(first.reused).toBe(false);
    const manifestText = await readFile(join(directory, "storyboard-grids", `${projectId}.json`), "utf8");
    expect(manifestText).not.toContain("test-key");
    const second = await generate({ productImageUrls: productPaths, reuseExisting: true, apiKey: "rotated-key" });
    expect(second).toEqual({ ...first, reused: true });
    expect(db.select().from(schema.assets).all()).toHaveLength(3);
  });

  it.each([
    ["reference order", { productImageUrls: [...productPaths].reverse() }],
    ["image model", { model: "gpt-image-1.5" }],
    ["image options", { options: { width: 1080, height: 1920 } }],
  ])("invalidates reuse when the %s changes", async (_reason, changed) => {
    await generate({ productImageUrls: productPaths, reuseExisting: true });
    const second = await generate({ productImageUrls: productPaths, reuseExisting: true, ...changed }, 2);
    expect(second.reused).toBe(false);
  });

  it("invalidates reuse when the script changes even when its shot IDs remain unchanged", async () => {
    await generate({ productImageUrls: productPaths, reuseExisting: true });
    db.update(schema.scripts).set({
      shots: originalShots.map((shot) => ({ ...shot, voiceover: "Updated script dialogue" })),
    }).where(eq(schema.scripts.id, scriptId)).run();
    expect((await generate({ productImageUrls: productPaths, reuseExisting: true }, 2)).reused).toBe(false);
  });

  it("invalidates reuse when an uploaded reference file is replaced at the same URL", async () => {
    await generate({ productImageUrls: productPaths, reuseExisting: true });
    const frontFile = join(directory, "uploads", projectId, "product-front.png");
    try {
      await writeFile(frontFile, productBytes[1]);
      expect((await generate({ productImageUrls: productPaths, reuseExisting: true }, 2)).reused).toBe(false);
    } finally {
      await writeFile(frontFile, productBytes[0]);
    }
  });

  it("does not reuse a deleted keyframe or a different selected take", async () => {
    const first = await generate({ productImageUrls: productPaths, reuseExisting: true });
    await rm(join(directory, "uploads", first.cells[0].filePath.replace("/api/files/", "")));
    expect((await generate({ productImageUrls: productPaths, reuseExisting: true }, 2)).reused).toBe(false);
    db.update(schema.assets).set({ selected: false }).where(eq(schema.assets.shotId, 1)).run();
    db.update(schema.assets).set({ selected: true }).where(eq(schema.assets.id, "previous-take")).run();
    expect((await generate({ productImageUrls: productPaths, reuseExisting: true }, 3)).reused).toBe(false);
  });

  it("honors an explicit regeneration request even when a reusable grid exists", async () => {
    await generate({ productImageUrls: productPaths, reuseExisting: true });
    expect((await generate({ productImageUrls: productPaths, reuseExisting: false }, 2)).reused).toBe(false);
  });

  it("preserves all usable selected media without credentials or an image-provider request", async () => {
    db.update(schema.assets).set({ filePath: productPaths[0] }).where(eq(schema.assets.id, "previous-take")).run();
    db.insert(schema.assets).values({ id: "existing-video", projectId, shotId: 2, type: "ai_generated", filePath: `/api/files/${projectId}/existing-video.mp4`, selected: true, status: "done" }).run();
    const response = await POST(new NextRequest(`http://localhost/api/project/${projectId}/storyboard-grid`, {
      method: "POST", body: JSON.stringify({ scriptId, preserveExisting: true }),
    }), { params: Promise.resolve({ id: projectId }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ reused: true, preserved: true, generatedCount: 0, count: 2,
      cells: [{ shotId: 1, filePath: productPaths[0] }, { shotId: 2, filePath: `/api/files/${projectId}/existing-video.mp4` }] });
    expect(fetchMock).not.toHaveBeenCalled(); expect(db.select().from(schema.assets).all()).toHaveLength(2);
  });

  it("fills only missing cells and keeps the existing take without claiming mixed cells form one cached grid", async () => {
    db.update(schema.assets).set({ filePath: productPaths[0] }).where(eq(schema.assets.id, "previous-take")).run();
    const result = await generate({ preserveExisting: true });
    expect(result.cells[0].filePath).toBe(productPaths[0]);
    expect(db.select().from(schema.assets).all()).toHaveLength(2);
    expect(db.select().from(schema.assets).where(eq(schema.assets.id, "previous-take")).get()?.selected).toBe(true);
    await expect(readFile(join(directory, "storyboard-grids", `${projectId}.json`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps late grid results as alternatives after the user changes selection during generation", async () => {
    fetchMock.mockImplementationOnce(async () => {
      db.update(schema.assets).set({ selected: false }).run();
      db.insert(schema.assets).values({ id: "user-new-choice", projectId, shotId: 1, type: "user_upload", filePath: productPaths[1], selected: true, status: "done" }).run();
      return Response.json({ data: [{ b64_json: gridBase64 }] });
    });
    await generate({ preserveExisting: true });
    const rows = db.select().from(schema.assets).all();
    expect(rows.find((row) => row.id === "user-new-choice")?.selected).toBe(true);
    expect(rows.filter((row) => row.shotId === 1 && row.id !== "user-new-choice").every((row) => !row.selected)).toBe(true);
    await expect(readFile(join(directory, "storyboard-grids", `${projectId}.json`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps late results detached from the current script revision", async () => {
    fetchMock.mockImplementationOnce(async () => {
      db.update(schema.scripts).set({ shots: originalShots.map((shot) => ({ ...shot, description: "Changed during provider generation" })) }).where(eq(schema.scripts.id, scriptId)).run();
      return Response.json({ data: [{ b64_json: gridBase64 }] });
    });
    await generate({ preserveExisting: true });
    const rows = db.select().from(schema.assets).all();
    expect(rows.find((row) => row.id === "previous-take")?.selected).toBe(true);
    expect(rows.filter((row) => row.id !== "previous-take").every((row) => !row.selected)).toBe(true);
    await expect(readFile(join(directory, "storyboard-grids", `${projectId}.json`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
