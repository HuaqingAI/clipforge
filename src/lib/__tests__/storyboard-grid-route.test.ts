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
import { assetMatchesScript, scriptRevision } from "@/lib/asset-context";
import {
  createCreativeProfileSnapshot,
  createPremiumProductCgProfile,
  createShortVideoSalesProfile,
  createTideweOutdoorProfile,
} from "@/lib/creative-profiles";
import { englishWordCount, productFactsHash } from "@/lib/tidewe/validation";
import type { ProductFacts, TideweCopyDocument, TidewePresenterSnapshot, TideweVisualPlan } from "@/lib/tidewe/types";
import { tidewePresenterAnchor } from "@/lib/tidewe/presenter";
import { TIDEWE_IMAGE_FOCUS_TARGET, TIDEWE_PHOTOGRAPHIC_POLICY } from "@/lib/tidewe/visual-policy";
import { PREMIUM_CG_IMAGE_NEGATIVE_PROMPT } from "@/lib/premium-cg-prompt";
import type { StoryboardGridResolutionInfo } from "@/lib/storyboard-grid-resolution";
import { withGenerationContext } from "@/lib/generation-context";

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
let gridBytes: Buffer;
let productBytes: Buffer[];
let presenterBytes: Buffer;
const gridWidth = 300;
const gridHeight = 540;
const gridColors = [
  [220, 30, 40], [20, 150, 60], [30, 60, 210],
  [180, 110, 25], [110, 30, 170], [25, 135, 160],
  [190, 55, 130], [90, 140, 25], [125, 80, 50],
];
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
    selected: true,
    styleType: "scene",
    shots: originalShots,
    copyDocument: null,
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
  // Deliberately drift the separators from exact thirds so a fixed 3x3 crop
  // would retain white seams and neighboring panels in the reference frames.
  const rgb = Buffer.alloc(gridWidth * gridHeight * 3);
  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      const row = y < 172 ? 0 : y < 354 ? 1 : 2;
      const col = x < 106 ? 0 : x < 194 ? 1 : 2;
      const seam = (x >= 106 && x < 108) || (x >= 194 && x < 196)
        || (y >= 172 && y < 174) || (y >= 354 && y < 356);
      rgb.set(seam ? [255, 255, 255] : gridColors[row * 3 + col], (y * gridWidth + x) * 3);
    }
  }
  gridBytes = execFileSync(process.env.FFMPEG_PATH!, [
    "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${gridWidth}x${gridHeight}`,
    "-i", "pipe:0", "-frames:v", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1",
  ], { input: rgb });
}, 20_000);

beforeEach(async () => {
  gridBase64 = gridBytes.toString("base64");
  await rm(join(directory, "storyboard-grids", `${projectId}.json`), { force: true });
  const salesProfile = createShortVideoSalesProfile({ styleType: "scene" });
  db.update(schema.projects).set({
    creativeProfile: salesProfile,
    creativeConfigRevision: 0,
    productImages: productPaths,
  }).where(eq(schema.projects.id, projectId)).run();
  db.update(schema.scripts).set({
    styleType: "scene",
    shots: originalShots,
    copyDocument: null,
    creativeProfileSnapshot: createCreativeProfileSnapshot(salesProfile, 0),
  }).where(eq(schema.scripts.id, scriptId)).run();
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

async function requestGrid(references: Record<string, unknown> = {}) {
  return POST(new NextRequest(`http://localhost/api/project/${projectId}/storyboard-grid`, {
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
}

async function generate(references: Record<string, unknown>, expectedRequests = 1, expectedCount = 2) {
  const response = await requestGrid(references);
  const result = await response.json();
  expect(result).not.toHaveProperty("error");
  expect(response.status).toBe(200);
  expect(result).toMatchObject({ count: expectedCount, cells: Array.from({ length: expectedCount }, (_, i) => ({ shotId: i + 1 })) });
  expect(fetchMock).toHaveBeenCalledTimes(expectedRequests);
  return result as { gridPath: string; cells: { shotId: number; filePath: string }[]; count: number; reused: boolean; resolution: StoryboardGridResolutionInfo };
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

function useTidewe(presenterImage = presenterPath, personVisible = true, speechMode: "on_camera" | "voiceover" = "voiceover", speechDelivery?: "on_camera" | "off_camera", segments = ["Take a look.", " See what fits."]) {
  const presenter: TidewePresenterSnapshot = { id: "saved-host", name: "Sam", appearance: "短发户外主播", referenceImages: [presenterImage] };
  const profile = createTideweOutdoorProfile({ speechMode, presenter });
  const text = segments.join("");
  const facts: ProductFacts = { version: 1, brand: "TIDEWE", category: "other", items: [] };
  const copyDocument: TideweCopyDocument = { version: 1, language: "en-US", text, translation: "看一眼，找到适合自己的。", angle: "scene", hookType: "scene", claimedFactIds: [], factsSnapshot: facts, factsHash: productFactsHash(facts), corpusVersion: profile.corpusVersion, compilerVersion: profile.promptCompilerVersion, exampleIds: [], wordCount: englishWordCount(text), estimatedDuration: 6 };
  let start = 0;
  const shots: schema.Shot[] = segments.map((segment, index) => {
    const shot = originalShots[index % originalShots.length];
    const copySpan = { start, end: start + segments[index].length }; start = copySpan.end;
    const visualPlan: TideweVisualPlan = personVisible && index % 2 === 0
      ? { framing: "wide", visualRole: "demonstration", productFocus: "主播手持的当前商品整体与接触位置", actionStart: "主播已握稳商品，商品完整入画", action: "向拍摄同伴轻抬一次商品", actionEnd: "商品自然停稳" }
      : { framing: "close_up", visualRole: "detail", productFocus: "当前商品参考可见的表面与外轮廓", actionStart: "商品可见表面与外轮廓已经入画", action: "保持商品表面与外轮廓可读", actionEnd: "商品与镜头自然停稳" };
    return { ...shot, shotId: index + 1, characterId: presenter.id, description: personVisible ? `${tidewePresenterAnchor(presenter)}在树林边展示商品。` : "树林边静置商品的特写。", visualIntent: "展示户外商品", camera: "固定中景", voiceover: segment.trim(), prompt: personVisible ? "户外实拍主播展示商品。" : "户外实拍商品特写。", tidewe: { copySpan, translation: "查看商品。", shotGoal: "展示商品", productVisible: true, personVisible, presenter, visualPlan, ...(speechDelivery && { speechDelivery }), sceneId: "woods", factRefs: [] } };
  });
  db.update(schema.projects).set({ creativeProfile: profile, creativeConfigRevision: 1 }).where(eq(schema.projects.id, projectId)).run();
  db.update(schema.scripts).set({ styleType: "tidewe_outdoor", shots, copyDocument, creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1) }).where(eq(schema.scripts.id, scriptId)).run();
}

describe("durable grid provider rejection", () => {
  it.each([401, 429, 503])("records HTTP %i as unsubmitted only when rejection is definite", async (status) => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "provider rejection" }, { status }));
    let checkpoint: Record<string, unknown> = {};
    const response = await withGenerationContext({ itemId: `grid-http-${status}`, checkpoint,
      save: (value) => { checkpoint = structuredClone(value); } }, () => POST(new NextRequest(`http://localhost/api/project/${projectId}/storyboard-grid`, {
        method: "POST", body: JSON.stringify({ scriptId, provider: "openai", model: "gpt-image-2", apiKey: "test-key", baseUrl: "https://image-provider.test/v1", productImageUrls: productPaths }),
      }), { params: Promise.resolve({ id: projectId }) }));
    expect(response.status).toBe(status === 429 ? 429 : 500);
    expect(checkpoint.submissionState).toBe(status === 503 ? "submitting" : "not_submitted");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(db.select().from(schema.assets).all()).toHaveLength(1);
  });
});

describe("TIDEWE frozen presenter grid references", () => {
  it.each([
    { provider: "openai", productPart: "靴子鞋底" },
    { provider: "fal-ai", productPart: "靴子鞋底" },
    { provider: "openai", productPart: "椅脚" },
    { provider: "fal-ai", productPart: "椅脚" },
  ])("keeps low-angle $productPart support ground readable in the actual $provider positive grid request", async ({ provider, productPart }) => {
    useTidewe(presenterPath, false);
    const saved = db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()!;
    db.update(schema.scripts).set({ shots: saved.shots!.map((shot, index) => ({ ...shot,
      description: `${productPart}已稳定落在现有落叶地面，画面下沿至接触处为连续地面。`, camera: index === 0 ? "固定低机位近景，保留当前局部构图。" : "固定低机位接触处特写。",
      prompt: `林边真实自然光，${productPart}和邻近落叶地面构成连续支撑。`, visualIntent: "观察当前商品与支撑面实际接触。",
      tidewe: { ...shot.tidewe!, visualPlan: { framing: index === 0 ? "close_up" : "detail", visualRole: "detail", productFocus: `${productPart}与现有落叶地面的接触关系`, actionStart: `${productPart}已稳固放在现有地面上`, action: "静态观察当前接地与支撑状态", actionEnd: "商品继续保持稳定接地" } },
    })) }).where(eq(schema.scripts.id, scriptId)).run();
    const beforeScript = db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()!;
    let prompt: string;
    if (provider === "fal-ai") {
      const model = "openai/gpt-image-2/image-to-image";
      const endpoint = `https://fal-provider.test/${model}`;
      fetchMock.mockImplementation(async (url, init) => {
        if (String(url) === endpoint && init?.method === "POST") return Response.json({ request_id: "foreground-grid" });
        if (String(url) === `${endpoint}/requests/foreground-grid/status`) return Response.json({ status: "COMPLETED" });
        expect(String(url)).toBe(`${endpoint}/requests/foreground-grid`);
        return Response.json({ images: [{ url: `data:image/png;base64,${gridBase64}` }] });
      });
      await generate({ provider, model, baseUrl: "https://fal-provider.test" }, 3);
      const submitted = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;
      expect(submitted.num_images).toBe(1);
      expect(submitted).not.toHaveProperty("negative_prompt");
      expect((submitted.image_urls as string[]).map(url => Buffer.from(url.split(",")[1], "base64"))).toEqual(productBytes);
      prompt = String(submitted.prompt);
    } else {
      await generate({});
      const form = await assertUploadedImages(productBytes);
      expect(form.get("n")).toBe("1");
      expect(form.has("negative_prompt")).toBe(false);
      prompt = String(form.get("prompt"));
    }
    expect(prompt.split(TIDEWE_IMAGE_FOCUS_TARGET)).toHaveLength(2);
    expect(prompt).not.toContain(TIDEWE_PHOTOGRAPHIC_POLICY);
    expect(prompt.match(/合焦目标：近前景—接触处—商品共同合焦/g)).toHaveLength(beforeScript.shots!.length);
    expect(prompt).toContain("仅限本格已有表面");
    expect(prompt).toContain("已确认景别：近景／较大操作区域");
    expect(prompt).toContain("已确认景别：特写／局部部件与接触");
    expect(prompt).toContain("第 1 张参考图为当前同一商品的第 1/2 个视角");
    expect(prompt).toContain("第 2 张参考图为当前同一商品的第 2/2 个视角");
    for (const shot of beforeScript.shots!) {
      expect(prompt).toContain(shot.description);
      expect(prompt).toContain(shot.camera!);
      expect(prompt).toContain(shot.tidewe!.visualPlan!.productFocus!);
      expect(prompt).toContain(shot.tidewe!.visualPlan!.actionStart);
      expect(prompt).toContain(shot.tidewe!.visualPlan!.action);
      expect(prompt).not.toContain(shot.tidewe!.visualPlan!.actionEnd);
    }
    expect(prompt).not.toContain("嘴部清晰可见");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()).toEqual(beforeScript);
  });

  it.each(["openai", "fal-ai"])("sends initial anatomy, reference and readable-background quality in the actual %s positive request", async provider => {
    const fal = provider === "fal-ai";
    useTidewe(presenterPath, !fal);
    const beforeScript = db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()!;
    let prompt: string;
    if (fal) {
      const model = "openai/gpt-image-2/image-to-image";
      const endpoint = `https://fal-provider.test/${model}`;
      fetchMock.mockImplementation(async (url, init) => {
        if (String(url) === endpoint && init?.method === "POST") return Response.json({ request_id: "grid-quality-request" });
        if (String(url) === `${endpoint}/requests/grid-quality-request/status`) return Response.json({ status: "COMPLETED" });
        expect(String(url)).toBe(`${endpoint}/requests/grid-quality-request`);
        return Response.json({ images: [{ url: `data:image/png;base64,${gridBase64}` }] });
      });
      await generate({ provider, model, baseUrl: "https://fal-provider.test" }, 3);
      const submitted = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;
      expect(submitted.num_images).toBe(1);
      expect(submitted).not.toHaveProperty("negative_prompt");
      const refs = submitted.image_urls as string[];
      expect(refs.map(url => Buffer.from(url.split(",")[1], "base64"))).toEqual(productBytes);
      prompt = String(submitted.prompt);
    } else {
      await generate({});
      const form = await assertUploadedImages([presenterBytes, ...productBytes]);
      expect(form.get("n")).toBe("1");
      expect(form.has("negative_prompt")).toBe(false);
      prompt = String(form.get("prompt"));
      expect(prompt).toContain("光线与焦点服从本格");
      expect(prompt).toContain("第 2 张参考图为当前同一商品的第 1/2 个视角");
      expect(prompt).toContain("第 3 张参考图为当前同一商品的第 2/2 个视角");
    }
    expect(prompt.split(TIDEWE_IMAGE_FOCUS_TARGET)).toHaveLength(2);
    expect(prompt).not.toContain(TIDEWE_PHOTOGRAPHIC_POLICY);
    expect(prompt.split("画面结构：")).toHaveLength(2);
    expect(prompt).toContain("肩、肘、前臂、手腕与手自然连续");
    expect(prompt).toContain("左右手、掌背、拇指侧别与关节符合真实姿态");
    expect(prompt).toContain("保留自然遮挡");
    expect(prompt).toContain("可见部件数量和连接关系以参考为准");
    expect(prompt).toContain("共享透视、色温、原生成像质感、光向及接触阴影");
    expect(prompt).toContain("商品在本格环境中重新成像");
    expect(prompt.match(/合焦目标：近前景—接触处—商品共同合焦/g)).toHaveLength(beforeScript.shots!.length);
    for (const shot of beforeScript.shots!) {
      expect(prompt).toContain(shot.description.replace(tidewePresenterAnchor(shot.tidewe!.presenter!), "主播"));
      expect(prompt).toContain(shot.camera!);
      expect(prompt).toContain(shot.tidewe!.visualPlan!.productFocus!);
      expect(prompt).toContain(shot.tidewe!.visualPlan!.actionStart);
      expect(prompt).toContain(shot.tidewe!.visualPlan!.action);
      expect(prompt).not.toContain(shot.tidewe!.visualPlan!.actionEnd);
    }
    expect(prompt).not.toMatch(/reference image 1|source image|repair report|Edit and regenerate|保留源图/i);
    expect(db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()).toEqual(beforeScript);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("uploads the frozen presenter and actual product bytes in prompt order", async () => {
    useTidewe();
    await generate({});
    const form = await assertUploadedImages([presenterBytes, ...productBytes]);
    expect(form.get("prompt")).toContain("Sam");
  });
  it("does not add the selected person to a silent product-only B-roll grid", async () => {
    useTidewe(presenterPath, false);
    await generate({});
    await assertUploadedImages(productBytes);
  });
  it("omits the presenter reference for a person-free grid with native off-camera narration", async () => {
    useTidewe(`/api/files/${projectId}/missing-person.png`, false, "on_camera", "off_camera");
    await generate({});
    const form = await assertUploadedImages(productBytes);
    expect(form.get("prompt")).not.toContain("嘴部清晰可见");
    expect(form.get("prompt")).not.toContain("固定出镜人物");
  });
  it.each(["foreign", "unavailable"])("rejects %s identity references before provider generation", async (reason) => {
    useTidewe(reason === "unavailable" ? `/api/files/${projectId}/missing-person.png` : presenterPath);
    const response = await POST(new NextRequest(`http://localhost/api/project/${projectId}/storyboard-grid`, { method: "POST", body: JSON.stringify({ scriptId, provider: "openai", model: "gpt-image-2", apiKey: "test-key", ...(reason === "foreign" ? { characterSheetUrl: productPaths[0] } : {}) }) }), { params: Promise.resolve({ id: projectId }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: reason === "foreign" ? "TIDEWE_PRESENTER_REFERENCE_INVALID" : "TIDEWE_REFERENCE_UNAVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("TIDEWE product coverage before grid generation", () => {
  it("rejects the affected five-shot presenter-only script before resolving references or calling the provider, without changing saved data", async () => {
    useTidewe(`/api/files/${projectId}/missing-presenter.png`, true, "voiceover", undefined,
      ["Check the fit.", " Look at the shaft.", " Consider your layers.", " Think about the ground.", " Choose what fits."]);
    const saved = db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()!;
    db.update(schema.scripts).set({ shots: saved.shots!.map(shot => ({
      ...shot, description: `${tidewePresenterAnchor(shot.tidewe!.presenter!)}在树林边以胸上近景向拍摄同伴讲解，画面不包含靴子。`, camera: "胸上近景",
      tidewe: { ...shot.tidewe!, productVisible: false },
    })) }).where(eq(schema.scripts.id, scriptId)).run();
    const beforeScript = db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()!;
    const beforeAssets = db.select().from(schema.assets).all();
    const beforeProject = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!;
    expect(beforeScript.shots).toHaveLength(5);
    expect(beforeScript.shots!.every(shot => shot.tidewe?.productVisible === false)).toBe(true);
    // Both the foreign requested presenter and the unavailable frozen reference would fail
    // later reference validation. Product coverage must be the first reported defect.
    const response = await requestGrid({ characterSheetUrl: productPaths[0] });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "TIDEWE_PRODUCT_COVERAGE_INVALID", issues: expect.arrayContaining([
      expect.objectContaining({ code: "PRODUCT_NOT_VISIBLE" }),
    ]) });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()).toEqual(beforeScript);
    expect(db.select().from(schema.assets).all()).toEqual(beforeAssets);
    expect(db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()).toEqual(beforeProject);
    await expect(readFile(join(directory, "storyboard-grids", `${projectId}.json`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a complete three-shot plan with no product detail or use shot", async () => {
    useTidewe(presenterPath, true, "voiceover", undefined, ["Check the fit.", " Look at the shaft.", " Choose what fits."]);
    const saved = db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()!;
    const presenterPlan: TideweVisualPlan = { framing: "medium", visualRole: "presenter", productFocus: "主播身旁的迷彩靴筒", actionStart: "主播已站稳", action: "向同伴作一次小幅手势", actionEnd: "主播自然站稳" };
    db.update(schema.scripts).set({
      shots: saved.shots!.map(shot => ({ ...shot, tidewe: { ...shot.tidewe!, visualPlan: presenterPlan } })),
    }).where(eq(schema.scripts.id, scriptId)).run();
    const beforeScript = db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()!;
    const beforeAssets = db.select().from(schema.assets).all();
    const response = await requestGrid();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "TIDEWE_PRODUCT_COVERAGE_INVALID", issues: expect.arrayContaining([
      expect.objectContaining({ code: "PRODUCT_DETAIL_MISSING" }),
      expect.objectContaining({ code: "PRODUCT_USE_MISSING" }),
    ]) });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()).toEqual(beforeScript);
    expect(db.select().from(schema.assets).all()).toEqual(beforeAssets);
  });

  it.each(["complete-without-focus", "partial-plan"])("rejects %s instead of allowing the missing product evidence", async planCoverage => {
    useTidewe(presenterPath, true, "voiceover", undefined, ["Check the fit.", " Look at the shaft.", " Choose what fits."]);
    const saved = db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()!;
    const oldPlan: TideweVisualPlan = { framing: "medium", visualRole: "presenter", actionStart: "主播已站稳", action: "向同伴作一次小幅手势", actionEnd: "主播自然站稳" };
    db.update(schema.scripts).set({
      shots: saved.shots!.map((shot, index) => ({ ...shot, tidewe: { ...shot.tidewe!, visualPlan: planCoverage === "complete-without-focus" || index === 0 ? oldPlan : undefined } })),
    }).where(eq(schema.scripts.id, scriptId)).run();
    const beforeScript = db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()!;
    const beforeAssets = db.select().from(schema.assets).all();
    const response = await requestGrid();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "TIDEWE_PRODUCT_COVERAGE_INVALID", issues: expect.arrayContaining([
      expect.objectContaining({ code: "PRODUCT_FOCUS_MISSING" }),
    ]) });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()).toEqual(beforeScript);
    expect(db.select().from(schema.assets).all()).toEqual(beforeAssets);
  });

  it("rejects a two-shot script with a visible product but no visual plan or product focus", async () => {
    useTidewe();
    const saved = db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()!;
    db.update(schema.scripts).set({ shots: saved.shots!.map((shot, index) => ({
      ...shot, tidewe: { ...shot.tidewe!, productVisible: index === 0, visualPlan: undefined },
    })) }).where(eq(schema.scripts.id, scriptId)).run();
    const historical = db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()!;
    expect(historical.copyDocument?.visualBeats).toBeUndefined();
    expect(historical.shots!.every(shot => !shot.tidewe?.visualPlan)).toBe(true);
    const response = await requestGrid();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "TIDEWE_PRODUCT_COVERAGE_INVALID", issues: expect.arrayContaining([
      expect.objectContaining({ code: "PRODUCT_FOCUS_MISSING", shotId: 1 }),
    ]) });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()).toEqual(historical);
  });

  it("sends each approved productFocus to the real provider prompt for a valid structured boot storyboard", async () => {
    useTidewe(presenterPath, true, "voiceover", undefined, ["Check the shaft.", " Look at the outsole.", " See how it fits."]);
    const saved = db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()!;
    const plans: TideweVisualPlan[] = [
      { framing: "medium", visualRole: "presenter", productFocus: "主播手持的迷彩高筒靴", actionStart: "主播已握稳靴筒，靴子完整入画", action: "朝拍摄同伴轻抬靴筒一次", actionEnd: "靴子停稳" },
      { framing: "detail", visualRole: "detail", productFocus: "鞋底可见沟槽与手指接触处", actionStart: "鞋底朝向镜头，手指已接触可见沟槽", action: "手指沿一条可见沟槽轻划一次", actionEnd: "手指在沟槽旁停稳" },
      { framing: "wide", visualRole: "demonstration", productFocus: "已穿在脚上的高筒靴与裤脚关系", actionStart: "主播双脚穿着靴子站稳，靴底接触地面", action: "手指轻整一次现有裤脚", actionEnd: "裤脚自然停在靴筒旁，双脚站稳" },
    ];
    const facts: ProductFacts = { ...saved.copyDocument!.factsSnapshot, category: "waterproof_boots" };
    const cameras = ["腰上中景，手持靴子完整入画", "鞋底沟槽细节特写", "低机位全景，脚上的靴子与裤脚清楚入画"];
    db.update(schema.scripts).set({
      copyDocument: { ...saved.copyDocument!, productName: "TIDEWE camouflage boots", visualObservations: "参考图可见高筒、迷彩与外底沟槽。", factsSnapshot: facts, factsHash: productFactsHash(facts) },
      shots: saved.shots!.map((shot, index) => ({ ...shot, camera: cameras[index], description: `${tidewePresenterAnchor(shot.tidewe!.presenter!)}；${plans[index].actionStart}`, tidewe: { ...shot.tidewe!, visualPlan: plans[index] } })),
    }).where(eq(schema.scripts.id, scriptId)).run();
    await generate({}, 1, 3);
    const form = await assertUploadedImages([presenterBytes, ...productBytes]);
    const prompt = String(form.get("prompt"));
    for (const plan of plans) expect(prompt).toContain(`本镜商品观察对象：${plan.productFocus}`);
    expect(prompt).toContain("该商品或部位必须清楚入画");
    expect(db.select().from(schema.assets).all().filter(asset => asset.id !== "previous-take")).toHaveLength(3);
  });
});

describe("storyboard grid uploaded product references", () => {
  it.each([
    { name: "default 4K portrait", options: undefined, gridResolution: undefined, ratio: "9:16", orientation: "竖版", size: "2160x3840" },
    { name: "4K landscape", options: { width: 1920, height: 1080 }, gridResolution: "4k", ratio: "16:9", orientation: "横版", size: "3840x2160" },
    { name: "2K portrait", options: undefined, gridResolution: "2k", ratio: "9:16", orientation: "竖版", size: "1152x2048" },
    { name: "standard portrait", options: undefined, gridResolution: "standard", ratio: "9:16", orientation: "竖版", size: "864x1536" },
    { name: "4K square within the pixel cap", options: { width: 1024, height: 1024 }, gridResolution: "4k", ratio: "1:1", orientation: "正方形", size: "2880x2880" },
  ])("keeps the $name prompt and provider dimensions consistent", async ({ options, gridResolution, ratio, orientation, size }) => {
    await generate({ productImageUrls: productPaths, gridResolution, ...(options ? { options } : {}) });
    const form = await assertUploadedImages(productBytes);
    expect(form.get("size")).toBe(size);
    expect(form.get("prompt")).toContain(`${ratio} ${orientation}`);
  });

  it("requests one 4K image even when custom extras contain an older size", async () => {
    await generate({ options: { width: 1080, height: 1920, count: 5, extra: { size: "864x1536", n: 5 } } });
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.size).toBe("2160x3840");
    expect(body.n).toBe(1);
  });

  it("reports the actual resolution when the provider returns fewer pixels than requested", async () => {
    const result = await generate({});
    expect(result.resolution).toMatchObject({ requested: "4k", gridWidth, gridHeight, limited: true });
    const dimensions = await Promise.all(result.cells.map((cell) =>
      probeMedia(join(directory, "uploads", cell.filePath.replace("/api/files/", "")))));
    expect(result.resolution.minCellWidth).toBe(Math.min(...dimensions.map((item) => item.width)));
    expect(result.resolution.minCellHeight).toBe(Math.min(...dimensions.map((item) => item.height)));
    expect(result.resolution.maxCellWidth).toBe(Math.max(...dimensions.map((item) => item.width)));
    expect(result.resolution.maxCellHeight).toBe(Math.max(...dimensions.map((item) => item.height)));
  });

  it("retains native 4K pixels when cropping a high-resolution provider response", async () => {
    const highResolutionGrid = execFileSync(process.env.FFMPEG_PATH!, [
      "-v", "error", "-i", "pipe:0", "-vf", "scale=2160:3840:flags=neighbor",
      "-frames:v", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1",
    ], { input: gridBytes, maxBuffer: 4 * 1024 * 1024 });
    gridBase64 = highResolutionGrid.toString("base64");
    const result = await generate({ productImageUrls: productPaths });
    expect(result.resolution).toMatchObject({ requested: "4k", gridWidth: 2160, gridHeight: 3840, limited: false });
    expect(result.resolution.minCellWidth).toBeGreaterThan(570);
    expect(result.resolution.minCellHeight).toBeGreaterThan(1150);
    for (const cell of result.cells) {
      const path = join(directory, "uploads", cell.filePath.replace("/api/files/", ""));
      const probe = await probeMedia(path);
      const rgb = execFileSync(process.env.FFMPEG_PATH!, [
        "-v", "error", "-i", path, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
      ], { maxBuffer: 8 * 1024 * 1024 });
      expect(rgb.length).toBe(probe.width * probe.height * 3);
      const expected = gridColors[cell.shotId - 1];
      let foreignPixels = 0;
      for (let offset = 0; offset < rgb.length; offset += 3) {
        if (rgb[offset] !== expected[0] || rgb[offset + 1] !== expected[1] || rgb[offset + 2] !== expected[2]) foreignPixels++;
      }
      expect(foreignPixels).toBe(0);
    }
  }, 15_000);

  it("rejects premium CG frame text before submitting an image request", async () => {
    const profile = createPremiumProductCgProfile({ narrationMode: "none" });
    db.update(schema.projects).set({
      creativeProfile: profile,
      creativeConfigRevision: 1,
    }).where(eq(schema.projects.id, projectId)).run();
    db.update(schema.scripts).set({
      styleType: "premium_product_cg",
      creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1),
      shots: originalShots.map((shot) => ({
        ...shot,
        description: "A product frame with a BUY NOW title card.",
      })),
    }).where(eq(schema.scripts.id, scriptId)).run();

    const response = await POST(new NextRequest(`http://localhost/api/project/${projectId}/storyboard-grid`, {
      method: "POST",
      body: JSON.stringify({
        scriptId,
        provider: "openai",
        model: "gpt-image-2",
        apiKey: "test-key",
        baseUrl: "https://image-provider.test/v1",
      }),
    }), { params: Promise.resolve({ id: projectId }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "CREATIVE_POLICY_VIOLATION",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "generated_text", field: "description" }),
        expect.objectContaining({ code: "marketing_visual", field: "description" }),
      ]),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not forward opaque provider extras that can replace a premium CG grid prompt", async () => {
    const profile = createPremiumProductCgProfile({ narrationMode: "none" });
    db.update(schema.projects).set({
      creativeProfile: profile,
      creativeConfigRevision: 1,
    }).where(eq(schema.projects.id, projectId)).run();
    db.update(schema.scripts).set({
      styleType: "premium_product_cg",
      creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1),
    }).where(eq(schema.scripts.id, scriptId)).run();

    await generate({
      productImageUrls: [productPaths[0]],
      options: { extra: { prompt: "Draw a giant BUY NOW price card over the furniture." } },
    });

    const form = await assertUploadedImages([productBytes[0]]);
    expect(form.get("prompt")).toContain("premium product CG storyboard grid");
    expect(form.get("prompt")).not.toContain("BUY NOW");
  });

  it("replaces client negative prompt aliases with the fixed premium CG image policy", async () => {
    const profile = createPremiumProductCgProfile({ narrationMode: "none" });
    db.update(schema.projects).set({
      creativeProfile: profile,
      creativeConfigRevision: 1,
    }).where(eq(schema.projects.id, projectId)).run();
    db.update(schema.scripts).set({
      styleType: "premium_product_cg",
      creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1),
    }).where(eq(schema.scripts.id, scriptId)).run();

    const forgedNegative = "render a flashing BUY NOW price card";
    const submitted: Record<string, unknown>[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      expect(String(input)).toBe("https://image-provider.test/v1/images/generations");
      expect(init?.method).toBe("POST");
      submitted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ images: [{ url: `data:image/png;base64,${gridBase64}` }] });
    });

    await generate({
      provider: "siliconflow",
      model: "Qwen/Qwen-Image",
      productImageUrls: [productPaths[0]],
      options: {
        negativePrompt: forgedNegative,
        negative_prompt: `${forgedNegative} alias`,
      },
    });

    expect(submitted[0]).toMatchObject({ negative_prompt: PREMIUM_CG_IMAGE_NEGATIVE_PROMPT });
    expect(JSON.stringify(submitted[0])).not.toContain(forgedNegative);

    await generate({
      provider: "siliconflow",
      model: "Qwen/Qwen-Image",
      productImageUrls: [productPaths[0]],
    }, 2);
    expect(submitted[1]).toMatchObject({ negative_prompt: PREMIUM_CG_IMAGE_NEGATIVE_PROMPT });
  });

  it("uses the saved project product references when a premium CG grid omits request references", async () => {
    const profile = createPremiumProductCgProfile({ narrationMode: "none" });
    db.update(schema.projects).set({
      creativeProfile: profile,
      creativeConfigRevision: 1,
    }).where(eq(schema.projects.id, projectId)).run();
    db.update(schema.scripts).set({
      styleType: "premium_product_cg",
      creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1),
    }).where(eq(schema.scripts.id, scriptId)).run();

    await generate({});

    await assertUploadedImages(productBytes);
  });

  it("requires a saved project product image for premium CG grids", async () => {
    const profile = createPremiumProductCgProfile({ narrationMode: "none" });
    db.update(schema.projects).set({
      creativeProfile: profile,
      creativeConfigRevision: 1,
      productImages: [],
    }).where(eq(schema.projects.id, projectId)).run();
    db.update(schema.scripts).set({
      styleType: "premium_product_cg",
      creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1),
    }).where(eq(schema.scripts.id, scriptId)).run();

    const response = await POST(new NextRequest(`http://localhost/api/project/${projectId}/storyboard-grid`, {
      method: "POST",
      body: JSON.stringify({ scriptId, provider: "openai", model: "gpt-image-2", apiKey: "test-key" }),
    }), { params: Promise.resolve({ id: projectId }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "PREMIUM_CG_PRODUCT_REFERENCE_REQUIRED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-project product reference for a premium CG grid", async () => {
    const profile = createPremiumProductCgProfile({ narrationMode: "none" });
    db.update(schema.projects).set({
      creativeProfile: profile,
      creativeConfigRevision: 1,
    }).where(eq(schema.projects.id, projectId)).run();
    db.update(schema.scripts).set({
      styleType: "premium_product_cg",
      creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1),
    }).where(eq(schema.scripts.id, scriptId)).run();

    const response = await POST(new NextRequest(`http://localhost/api/project/${projectId}/storyboard-grid`, {
      method: "POST",
      body: JSON.stringify({
        scriptId,
        provider: "openai",
        model: "gpt-image-2",
        apiKey: "test-key",
        productImageUrls: ["https://example.test/legacy-sales-reference.png"],
      }),
    }), { params: Promise.resolve({ id: projectId }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "PREMIUM_CG_PRODUCT_REFERENCE_INVALID" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a foreign legacy productImageUrl even when productImageUrls is valid", async () => {
    const profile = createPremiumProductCgProfile({ narrationMode: "none" });
    db.update(schema.projects).set({
      creativeProfile: profile,
      creativeConfigRevision: 1,
    }).where(eq(schema.projects.id, projectId)).run();
    db.update(schema.scripts).set({
      styleType: "premium_product_cg",
      creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1),
    }).where(eq(schema.scripts.id, scriptId)).run();

    const response = await POST(new NextRequest(`http://localhost/api/project/${projectId}/storyboard-grid`, {
      method: "POST",
      body: JSON.stringify({
        scriptId,
        provider: "openai",
        model: "gpt-image-2",
        apiKey: "test-key",
        productImageUrl: "https://example.test/foreign-legacy-reference.png",
        productImageUrls: [productPaths[0]],
      }),
    }), { params: Promise.resolve({ id: projectId }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "PREMIUM_CG_PRODUCT_REFERENCE_INVALID" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends both existing local product photos as ordered multipart images and saves usable shot crops", async () => {
    const result = await generate({ productImageUrls: productPaths });
    const form = await assertUploadedImages(productBytes);
    expect(form.get("prompt")).toContain("第 1 张参考图是商品实拍图");
    expect(form.get("prompt")).toContain("第 2 张参考图是商品实拍图");
    expect(await readFile(join(directory, "uploads", result.gridPath.replace("/api/files/", ""))))
      .toEqual(gridBytes);
    const saved = db.select().from(schema.assets).all();
    expect(saved.find((asset) => asset.id === "previous-take")?.selected).toBe(false);
    expect(saved.filter((asset) => asset.selected)).toHaveLength(2);
    for (const cell of result.cells) {
      const filePath = join(directory, "uploads", cell.filePath.replace("/api/files/", ""));
      const probe = await probeMedia(filePath);
      expect(probe.videoCodec).toBe("png");
      expect(probe.width).toBeGreaterThan(70);
      expect(probe.height).toBeGreaterThan(150);
      expect(saved).toContainEqual(expect.objectContaining({
        shotId: cell.shotId, filePath: cell.filePath, selected: true, status: "done",
      }));
    }
  });

  it("keeps every pixel of all nine reference frames inside its own panel when gutters drift", async () => {
    db.update(schema.scripts).set({
      shots: Array.from({ length: 9 }, (_, index) => ({ ...originalShots[0], shotId: index + 1 })),
    }).where(eq(schema.scripts.id, scriptId)).run();
    const result = await generate({ productImageUrls: productPaths }, 1, 9);
    for (const cell of result.cells) {
      const filePath = join(directory, "uploads", cell.filePath.replace("/api/files/", ""));
      const probe = await probeMedia(filePath);
      expect(probe.width).toBeGreaterThan(70);
      expect(probe.height).toBeGreaterThan(150);
      const rgb = execFileSync(process.env.FFMPEG_PATH!, [
        "-v", "error", "-i", filePath, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
      ]);
      expect(rgb.length).toBe(probe.width * probe.height * 3);
      const expected = gridColors[cell.shotId - 1];
      let foreignPixels = 0;
      for (let offset = 0; offset < rgb.length; offset += 3) {
        if (rgb[offset] !== expected[0] || rgb[offset + 1] !== expected[1] || rgb[offset + 2] !== expected[2]) foreignPixels++;
      }
      expect(foreignPixels, `shot ${cell.shotId} includes a seam or a neighboring panel`).toBe(0);
    }
  });

  it("rejects a provider image without a grid before replacing selected media or saving a manifest", async () => {
    gridBase64 = productBytes[0].toString("base64");
    const response = await POST(new NextRequest(`http://localhost/api/project/${projectId}/storyboard-grid`, {
      method: "POST",
      body: JSON.stringify({ scriptId, provider: "openai", model: "gpt-image-2", apiKey: "test-key", baseUrl: "https://image-provider.test/v1" }),
    }), { params: Promise.resolve({ id: projectId }) });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "STORYBOARD_GRID_LAYOUT_INVALID" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.select().from(schema.assets).all()).toEqual([
      expect.objectContaining({ id: "previous-take", selected: true, status: "done" }),
    ]);
    await expect(readFile(join(directory, "storyboard-grids", `${projectId}.json`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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
    ["image options", { options: { width: 1920, height: 1080 } }],
    ["grid resolution", { gridResolution: "2k" }],
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

  it("replaces a usable legacy grid crop instead of preserving its possibly contaminated pixels", async () => {
    const legacyPath = `/api/files/${projectId}/legacy-grid.png`;
    await writeFile(join(directory, "uploads", projectId, "legacy-grid.png"), productBytes[0]);
    db.update(schema.assets).set({
      filePath: legacyPath,
      prompt: "[storyboard-grid 第1格] Product demonstration",
    }).where(eq(schema.assets.id, "previous-take")).run();
    db.insert(schema.assets).values({
      id: "existing-video", projectId, shotId: 2, type: "ai_generated",
      filePath: `/api/files/${projectId}/existing-video.mp4`, selected: true, status: "done",
    }).run();

    const result = await generate({ preserveExisting: true });
    expect(result).toMatchObject({ preservedCount: 1, generatedCount: 1 });
    expect(result.cells[0].filePath).not.toBe(legacyPath);
    expect(result.cells[1].filePath).toBe(`/api/files/${projectId}/existing-video.mp4`);
    const rows = db.select().from(schema.assets).all();
    expect(rows.find((row) => row.id === "previous-take")?.selected).toBe(false);
    expect(rows.find((row) => row.id === "existing-video")?.selected).toBe(true);
    expect(rows).toContainEqual(expect.objectContaining({
      shotId: 1, filePath: result.cells[0].filePath, selected: true, prompt: expect.stringContaining("[storyboard-grid-v2 "),
    }));
  });

  it("preserves validated version 2 grid crops without submitting another provider request", async () => {
    const first = await generate({});
    fetchMock.mockClear();
    const response = await POST(new NextRequest(`http://localhost/api/project/${projectId}/storyboard-grid`, {
      method: "POST", body: JSON.stringify({ scriptId, preserveExisting: true }),
    }), { params: Promise.resolve({ id: projectId }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      reused: true, preserved: true, generatedCount: 0, cells: first.cells,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.select().from(schema.assets).all()).toHaveLength(3);
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

  it("restores a downloaded grid after a worker restart without another paid request or duplicate takes", async () => {
    let checkpoint: Record<string, unknown> = {};
    const execute = () => withGenerationContext({ itemId: "durable-grid-restart", checkpoint, save: (value) => { checkpoint = structuredClone(value); } }, () => generate({ productImageUrls: productPaths }));
    const first = await execute();
    expect(checkpoint.gridPublicPath).toBe(first.gridPath);
    const firstIds = db.select().from(schema.assets).all().map((asset) => asset.id).sort();
    const second = await execute();
    expect(second.cells).toEqual(first.cells);
    expect(second.gridPath).toBe(first.gridPath);
    expect(db.select().from(schema.assets).all().map((asset) => asset.id).sort()).toEqual(firstIds);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps late grid results as alternatives when the same script is edited during generation", async () => {
    const before = db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()!;
    fetchMock.mockImplementationOnce(async () => {
      db.update(schema.scripts).set({ shots: originalShots.map((shot) => ({ ...shot, description: "Changed during provider generation" })) }).where(eq(schema.scripts.id, scriptId)).run();
      return Response.json({ data: [{ b64_json: gridBase64 }] });
    });
    const result = await generate({ preserveExisting: true });
    const rows = db.select().from(schema.assets).all();
    const current = db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()!;
    const generated = rows.filter((row) => row.id !== "previous-take");
    expect(rows.find((row) => row.id === "previous-take")?.selected).toBe(true);
    expect(generated).toHaveLength(2);
    expect(generated.every((row) => !row.selected && assetMatchesScript(row, current))).toBe(true);
    expect(generated.map((row) => row.filePath).sort()).toEqual(result.cells.map((cell) => cell.filePath).sort());
    expect(generated.every((row) => row.sourceScriptId === scriptId && row.sourceRevision === scriptRevision(before))).toBe(true);
    expect(current.shots?.every((shot) => shot.description === "Changed during provider generation")).toBe(true);
    // Cache signatures still describe their original content, even though the assets remain usable.
    await expect(readFile(join(directory, "storyboard-grids", `${projectId}.json`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps late results as alternatives when another script is selected during generation", async () => {
    fetchMock.mockImplementationOnce(async () => {
      db.update(schema.scripts).set({ selected: false }).where(eq(schema.scripts.id, scriptId)).run();
      db.insert(schema.scripts).values({ id: "new-selected-script", projectId, styleType: "scene", selected: true, shots: originalShots }).run();
      return Response.json({ data: [{ b64_json: gridBase64 }] });
    });
    await generate({ preserveExisting: true });
    const rows = db.select().from(schema.assets).all();
    const current = db.select().from(schema.scripts).where(eq(schema.scripts.selected, true)).get()!;
    expect(current.id).toBe("new-selected-script");
    expect(rows.find((row) => row.id === "previous-take")?.selected).toBe(true);
    expect(rows.filter((row) => row.id !== "previous-take")).toHaveLength(2);
    expect(rows.filter((row) => row.id !== "previous-take").every((row) => !row.selected && row.sourceScriptId === scriptId && !assetMatchesScript(row, current))).toBe(true);
    await expect(readFile(join(directory, "storyboard-grids", `${projectId}.json`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
