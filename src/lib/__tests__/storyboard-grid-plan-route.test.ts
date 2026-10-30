// @vitest-environment node
import { execFileSync } from "child_process";
import { createHash } from "crypto";
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
import { createCreativeProfileSnapshot, createShortVideoSalesProfile, createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { withGenerationContext } from "@/lib/generation-context";
import { englishWordCount, productFactsHash } from "@/lib/tidewe/validation";
import { tidewePresenterAnchor } from "@/lib/tidewe/presenter";
import type { ProductFacts, TideweCopyDocument } from "@/lib/tidewe/types";

const state = vi.hoisted(() => ({ db: null as unknown, policy: "policy-at-submission" }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/storyboard-grid", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storyboard-grid")>();
  return {
    ...original,
    buildStoryboardGridPrompt: vi.fn((...args: Parameters<typeof original.buildStoryboardGridPrompt>) => `${original.buildStoryboardGridPrompt(...args)}\n${state.policy}`),
  };
});
vi.mock("@/lib/remote-image", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/remote-image")>();
  return { ...original, toRemoteUsableImage: vi.fn(original.toRemoteUsableImage) };
});
import { POST } from "@/app/api/project/[id]/storyboard-grid/route";
import { buildStoryboardGridPrompt } from "@/lib/storyboard-grid";
import { toRemoteUsableImage } from "@/lib/remote-image";

const require = createRequire(import.meta.url);
const sqlite = new Database(":memory:");
const db = drizzle(sqlite, { schema });
const projectId = "frozen-grid-plan-project";
const scriptId = "frozen-grid-plan-script";
const reference = `/api/files/${projectId}/product.png`;
const presenterReference = `/api/files/${projectId}/presenter.png`;
const fetchMock = vi.fn<typeof fetch>();
const shots: schema.Shot[] = [1, 2].map((shotId) => ({
  shotId, type: "demo", duration: 3, description: `Demonstrate product ${shotId}`,
  camera: "static", visualSource: "ai_generate", transition: "direct_concat", voiceover: "",
}));
let directory: string;
let gridBytes: Buffer;
let referenceBytes: Buffer;
let checkpoint: Record<string, unknown>;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "clipforge-grid-plan-"));
  vi.stubEnv("APP_DATA_DIR", directory);
  vi.stubEnv("FFMPEG_PATH", require("ffmpeg-static") as string);
  vi.stubEnv("FFPROBE_PATH", (require("@ffprobe-installer/ffprobe") as { path: string }).path);
  state.db = db;
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  const profile = createShortVideoSalesProfile({ styleType: "scene" });
  db.insert(schema.projects).values({ id: projectId, name: "Frozen prompt fixture", productImages: [reference], creativeProfile: profile }).run();
  db.insert(schema.scripts).values({ id: scriptId, projectId, selected: true, styleType: "scene", shots, creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 0) }).run();
  const uploads = join(directory, "uploads", projectId);
  await mkdir(uploads, { recursive: true });
  referenceBytes = execFileSync(process.env.FFMPEG_PATH!, [
    "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=90x162", "-frames:v", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1",
  ]);
  await writeFile(join(uploads, "product.png"), referenceBytes);
  const width = 300, height = 540;
  const colors = [[220, 30, 40], [20, 150, 60], [30, 60, 210], [180, 110, 25], [110, 30, 170], [25, 135, 160], [190, 55, 130], [90, 140, 25], [125, 80, 50]];
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const seam = (x >= 100 && x < 102) || (x >= 200 && x < 202) || (y >= 180 && y < 182) || (y >= 360 && y < 362);
    rgb.set(seam ? [255, 255, 255] : colors[Math.floor(y / 180) * 3 + Math.floor(x / 100)], (y * width + x) * 3);
  }
  gridBytes = execFileSync(process.env.FFMPEG_PATH!, [
    "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-i", "pipe:0", "-frames:v", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1",
  ], { input: rgb });
}, 20_000);

beforeEach(async () => {
  checkpoint = {};
  state.policy = "policy-at-submission";
  db.delete(schema.assets).run();
  const profile = createShortVideoSalesProfile({ styleType: "scene" });
  db.update(schema.projects).set({ productImages: [reference], creativeProfile: profile, creativeConfigRevision: 0 }).where(eq(schema.projects.id, projectId)).run();
  db.update(schema.scripts).set({ styleType: "scene", shots, copyDocument: null, creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 0) }).where(eq(schema.scripts.id, scriptId)).run();
  await writeFile(join(directory, "uploads", projectId, "product.png"), referenceBytes);
  await writeFile(join(directory, "uploads", projectId, "presenter.png"), referenceBytes);
  await rm(join(directory, "storyboard-grids", `${projectId}.json`), { force: true });
  vi.mocked(buildStoryboardGridPrompt).mockClear();
  vi.mocked(toRemoteUsableImage).mockClear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    expect(String(input)).toBe("https://image-provider.test/v1/images/edits");
    return Response.json({ data: [{ b64_json: gridBytes.toString("base64") }] });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  sqlite.close();
  await rm(directory, { recursive: true, force: true });
});

async function requestGrid(overrides: Record<string, unknown> = {}) {
  return withGenerationContext({
    itemId: "frozen-grid-execution", checkpoint,
    save: (value) => { checkpoint = structuredClone(value); },
  }, () => POST(new NextRequest(`http://localhost/api/project/${projectId}/storyboard-grid`, {
    method: "POST",
    body: JSON.stringify({ scriptId, provider: "openai", model: "gpt-image-2", apiKey: "private-api-key", baseUrl: "https://image-provider.test/v1", productImageUrls: [reference], ...overrides }),
  }), { params: Promise.resolve({ id: projectId }) }));
}

async function generate(overrides: Record<string, unknown> = {}) {
  const response = await requestGrid(overrides);
  const result = await response.json();
  expect(result).not.toHaveProperty("error");
  expect(response.status).toBe(200);
  return result;
}

async function manifest() {
  return JSON.parse(await readFile(join(directory, "storyboard-grids", `${projectId}.json`), "utf8"));
}

function useTidewe() {
  const presenter = { id: "saved-host", name: "Sam", appearance: "短发户外主播", referenceImages: [presenterReference] };
  const profile = createTideweOutdoorProfile({ presenter });
  const segments = ["Take a look.", " See what fits."];
  const text = segments.join("");
  const facts: ProductFacts = { version: 1, brand: "TIDEWE", category: "other", items: [] };
  const copyDocument: TideweCopyDocument = {
    version: 1, language: "en-US", text, translation: "看一眼，找到适合自己的。", angle: "scene", hookType: "scene", claimedFactIds: [],
    factsSnapshot: facts, factsHash: productFactsHash(facts), corpusVersion: profile.corpusVersion,
    compilerVersion: profile.promptCompilerVersion, exampleIds: [], wordCount: englishWordCount(text), estimatedDuration: 6,
  };
  let start = 0;
  const tideweShots: schema.Shot[] = shots.map((shot, index) => {
    const copySpan = { start, end: start + segments[index].length };
    start = copySpan.end;
    return { ...shot, characterId: presenter.id, description: `${tidewePresenterAnchor(presenter)}在林边展示商品。`, camera: "固定中景",
      prompt: "户外实拍主播展示当前商品。", visualIntent: "观察真实商品", voiceover: segments[index].trim(),
      tidewe: { copySpan, translation: "查看商品。", shotGoal: "观察当前商品", productVisible: true, personVisible: true,
        presenter, sceneId: "woods", factRefs: [], visualPlan: {
          framing: index === 0 ? "wide" : "close_up", visualRole: index === 0 ? "demonstration" : "detail", productFocus: "当前商品参考可见的表面与接触位置",
          actionStart: "主播已握稳当前商品", action: "轻抬一次当前商品", actionEnd: "商品自然停稳",
        },
      },
    };
  });
  db.update(schema.projects).set({ creativeProfile: profile, creativeConfigRevision: 1 }).where(eq(schema.projects.id, projectId)).run();
  db.update(schema.scripts).set({ styleType: "tidewe_outdoor", shots: tideweShots, copyDocument, creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1) }).where(eq(schema.scripts.id, scriptId)).run();
}

describe("durable storyboard grid prompt provenance", () => {
  it("persists the actual HTTP prompt before submission with safe controls and reference hashes", async () => {
    fetchMock.mockImplementationOnce(async (_input, init) => {
      const plan = checkpoint.gridPlan as Record<string, unknown>;
      expect(plan).toMatchObject({ version: 1, provider: "openai", model: "gpt-image-2" });
      expect(checkpoint.submissionState).toBe("submitting");
      expect(init?.body).toBeInstanceOf(FormData);
      expect((init?.body as FormData).get("prompt")).toBe(plan.prompt);
      expect((init?.body as FormData).get("model")).toBe(plan.model);
      return Response.json({ data: [{ b64_json: gridBytes.toString("base64") }] });
    });
    await generate({ options: { width: 1080, height: 1920, seed: 42, apiKey: "hidden-option-key", headers: { Authorization: "hidden-auth-header" }, negativePrompt: "data:image/png;base64,private-pixels", extra: { token: "hidden-extra-token", image: "data:image/png;base64,private-pixels" } } });
    const plan = checkpoint.gridPlan as Record<string, unknown>;
    expect(plan.prompt).toContain("policy-at-submission");
    expect(plan.signature).toBe((await manifest()).signature);
    expect(plan.options).toMatchObject({ seed: 42, count: 1, gridResolution: "4k" });
    expect(plan.referenceHashes).toEqual([createHash("sha256").update(`data:image/png;base64,${referenceBytes.toString("base64")}`).digest("hex")]);
    const serialized = JSON.stringify(plan);
    for (const forbidden of ["private-api-key", "hidden-option-key", "hidden-auth-header", "hidden-extra-token", "private-pixels", "data:image", referenceBytes.toString("base64"), "image-provider.test"]) expect(serialized).not.toContain(forbidden);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("recovers the paid image with its original prompt and signature after a policy change", async () => {
    const first = await generate();
    const plan = structuredClone(checkpoint.gridPlan);
    const originalSignature = (await manifest()).signature;
    await rm(join(directory, "storyboard-grids", `${projectId}.json`));
    state.policy = "new-policy-after-deployment";
    vi.mocked(buildStoryboardGridPrompt).mockClear();
    const second = await generate({ reuseExisting: true, gridResolution: "standard", model: "gpt-image-1.5", options: { width: 1920, height: 1080 } });
    expect(second.gridPath).toBe(first.gridPath);
    expect(second.cells).toEqual(first.cells);
    expect(second.resolution.requested).toBe("4k");
    expect(checkpoint.gridPlan).toEqual(plan);
    expect((await manifest()).signature).toBe(originalSignature);
    expect(buildStoryboardGridPrompt).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("imports historical paid output without a plan and never claims the current policy cache", async () => {
    checkpoint = { imageUrls: [`data:image/png;base64,${gridBytes.toString("base64")}`], submissionState: "acknowledged" };
    await generate({ reuseExisting: true });
    expect(checkpoint).not.toHaveProperty("gridPlan");
    expect(checkpoint.gridPublicPath).toEqual(expect.any(String));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(buildStoryboardGridPrompt).not.toHaveBeenCalled();
    await expect(manifest()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("imports an acknowledged paid image after both reference files disappear without re-reading refs or submitting", async () => {
    useTidewe();
    await generate();
    const plan = structuredClone(checkpoint.gridPlan);
    const originalSignature = (await manifest()).signature;
    await rm(join(directory, "uploads", String(checkpoint.gridPublicPath).replace("/api/files/", "")));
    await rm(join(directory, "uploads", projectId, "product.png"));
    await rm(join(directory, "uploads", projectId, "presenter.png"));
    await rm(join(directory, "storyboard-grids", `${projectId}.json`));
    fetchMock.mockClear();
    vi.mocked(toRemoteUsableImage).mockClear();
    vi.mocked(buildStoryboardGridPrompt).mockClear();

    const recovered = await generate({ provider: "fal-ai", model: "single-reference-model", characterSheetUrl: "/api/files/moved-presenter.png" });
    expect(recovered.count).toBe(2);
    expect(checkpoint.gridPlan).toEqual(plan);
    expect((await manifest()).signature).toBe(originalSignature);
    expect(toRemoteUsableImage).not.toHaveBeenCalled();
    expect(buildStoryboardGridPrompt).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.select().from(schema.assets).all()).toHaveLength(2);
  });

  it("recovers the downloaded paid grid when its remote URL expires and product refs are removed", async () => {
    useTidewe();
    const first = await generate();
    const plan = structuredClone(checkpoint.gridPlan);
    checkpoint.imageUrls = ["https://expired-output.test/paid-grid.png"];
    db.update(schema.projects).set({ productImages: [] }).where(eq(schema.projects.id, projectId)).run();
    await rm(join(directory, "uploads", projectId, "presenter.png"));
    fetchMock.mockClear();
    vi.mocked(toRemoteUsableImage).mockClear();

    const recovered = await generate();
    expect(recovered.gridPath).toBe(first.gridPath);
    expect(recovered.cells).toEqual(first.cells);
    expect(checkpoint.gridPlan).toEqual(plan);
    expect(toRemoteUsableImage).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, [], [""], ["   "]])("rejects missing refs without a paid output (%j) before any fresh submission", async (imageUrls) => {
    useTidewe();
    checkpoint = { ...(imageUrls === undefined ? {} : { imageUrls }), submissionState: "acknowledged" };
    await rm(join(directory, "uploads", projectId, "product.png"));
    await rm(join(directory, "uploads", projectId, "presenter.png"));
    const response = await requestGrid();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "TIDEWE_REFERENCE_UNAVAILABLE" });
    expect(toRemoteUsableImage).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(buildStoryboardGridPrompt).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveProperty("gridPlan");
    expect(db.select().from(schema.assets).all()).toHaveLength(0);
  });

  it("retains product coverage validation even when a paid output already exists", async () => {
    useTidewe();
    const script = db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()!;
    db.update(schema.scripts).set({ shots: script.shots!.map(shot => ({ ...shot, tidewe: { ...shot.tidewe!, productVisible: false } })) }).where(eq(schema.scripts.id, scriptId)).run();
    checkpoint = { imageUrls: [`data:image/png;base64,${gridBytes.toString("base64")}`], submissionState: "acknowledged" };
    const response = await requestGrid();
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "TIDEWE_PRODUCT_COVERAGE_INVALID" });
    expect(toRemoteUsableImage).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
