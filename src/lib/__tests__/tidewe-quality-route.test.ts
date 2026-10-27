// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { assetScopeForShot } from "@/lib/asset-context";
import { createCreativeProfileSnapshot, createShortVideoSalesProfile, createTideweOutdoorProfile } from "@/lib/creative-profiles";
import type { TideweOutdoorProfile } from "@/lib/creative-profiles";
import { englishWordCount, productFactsHash } from "@/lib/tidewe/validation";
import { tidewePresenterAnchor } from "@/lib/tidewe/presenter";

const state = vi.hoisted(() => ({ evaluate: vi.fn(), localPath: "" }));
vi.mock("@/lib/db", () => ({ getDb: () => db }));
vi.mock("@/lib/generation-quality-evaluator", () => ({ evaluateGenerationQuality: state.evaluate }));
vi.mock("@/lib/remote-image", () => ({ resolveUploadFilePath: () => state.localPath, toRemoteUsableImage: async (ref: string) => ref }));
import { POST, PATCH } from "@/app/api/project/[id]/quality/route";

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let workingDir: string;
const projectId = "quality-project";
const oldReference = "https://example.test/frozen-hunter.png";
const replacementReference = "https://example.test/replacement-hunter.png";
const productReference = "https://example.test/product.png";
const presenter = { id: "hunter", name: "Hunter", appearance: "成年猎人", referenceImages: [oldReference] };
const shot: schema.Shot = { shotId: 1, type: "hook", duration: 5, description: `${tidewePresenterAnchor(presenter)}在林中展示装备。`, camera: "固定镜头",
  voiceover: "Long waits change your plans.", prompt: "林间自然实拍画面。", visualIntent: "呈现林间等待的户外体验。", visualSource: "ai_generate", transition: "direct_concat",
  tidewe: { presenter, personVisible: true, copySpan: { start: 0, end: "Long waits change your plans.".length }, translation: "长时间等待会改变计划。",
    shotGoal: "户外等待体验", productVisible: false, factRefs: [], sceneId: "woods" } };

function seedScript(selectedShot = shot, speechMode: TideweOutdoorProfile["speechMode"] = "on_camera", tidewe = true) {
  const frozen = tidewe ? createTideweOutdoorProfile({ presenter, speechMode }) : createShortVideoSalesProfile();
  const facts = { version: 1 as const, brand: "TIDEWE" as const, category: "hunting_apparel" as const, items: [] };
  const copyDocument = tidewe ? { version: 1 as const, language: "en-US" as const, text: selectedShot.voiceover, translation: "长时间等待会改变计划。",
    angle: "long_wait", hookType: "scene", claimedFactIds: [], factsSnapshot: facts, factsHash: productFactsHash(facts),
    corpusVersion: createTideweOutdoorProfile().corpusVersion, compilerVersion: createTideweOutdoorProfile().promptCompilerVersion,
    exampleIds: [], wordCount: englishWordCount(selectedShot.voiceover), estimatedDuration: 5 } : undefined;
  const script = db.insert(schema.scripts).values({ id: "selected-script", projectId, version: 1, selected: true,
    styleType: tidewe ? "tidewe_outdoor" : "scene", shots: [selectedShot], totalDuration: 5, copyDocument,
    creativeProfileSnapshot: createCreativeProfileSnapshot(frozen, 1) }).returning().get()!;
  db.insert(schema.assets).values({ id: "candidate", projectId, shotId: 1, type: "ai_generated", status: "done", filePath: "/api/files/candidate.png",
    selected: false, ...assetScopeForShot(script, selectedShot) }).run();
}

function evaluate() {
  return POST(new NextRequest(`http://localhost/api/project/${projectId}/quality`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assetId: "candidate", llmConfig: { baseUrl: "https://example.invalid/v1", apiKey: "mock-key", model: "mock-model" } }) }),
  { params: Promise.resolve({ id: projectId }) });
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }); migrate(db, { migrationsFolder: "drizzle" });
  workingDir = mkdtempSync(join(tmpdir(), "clipforge-quality-test-"));
  state.localPath = join(workingDir, "candidate.png");
  writeFileSync(state.localPath, Buffer.from("test-image"));
  db.insert(schema.projects).values({ id: projectId, name: "Quality", productImages: [productReference], characterId: presenter.id,
    creativeConfigRevision: 2, creativeProfile: createTideweOutdoorProfile({ presenter: { ...presenter, referenceImages: [replacementReference] } }) }).run();
  db.insert(schema.characters).values({ ...presenter, referenceImages: [replacementReference] }).run();
  state.evaluate.mockReset().mockResolvedValue({ version: 1, summary: "ok", overall: 90, confidence: 0.9, verdict: "accept",
    dimensions: [], issues: [], evaluatedAt: "2026-10-27T00:00:00Z" });
});

afterEach(() => { sqlite.close(); rmSync(workingDir, { recursive: true, force: true }); vi.clearAllMocks(); });

describe("TIDEWE quality reference identity", () => {
  it("accepts a candidate when its script and frozen presenter match the current configuration", async () => {
    db.update(schema.projects).set({ creativeConfigRevision: 1, creativeProfile: createTideweOutdoorProfile({ presenter }) }).run();
    seedScript();
    const review = await (await evaluate()).json();
    const response = await PATCH(new NextRequest(`http://localhost/api/project/${projectId}/quality`, { method: "PATCH",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reviewId: review.id, decision: "accepted" }) }),
    { params: Promise.resolve({ id: projectId }) });
    expect(response.status).toBe(200);
    expect(db.select().from(schema.assets).get()?.selected).toBe(true);
    expect(db.select().from(schema.generationReviews).get()?.humanDecision).toBe("accepted");
  });

  it.each(["stale configuration", "different frozen presenter"])("refuses human acceptance with %s without selecting the asset", async cause => {
    if (cause === "different frozen presenter") {
      const replacement = { ...presenter, referenceImages: [replacementReference] };
      db.update(schema.projects).set({ creativeConfigRevision: 1 }).run();
      seedScript({ ...shot, description: `${tidewePresenterAnchor(replacement)}在林中展示装备。`, tidewe: { ...shot.tidewe!, presenter: replacement } });
    } else seedScript();
    const reviewResponse = await evaluate();
    expect(reviewResponse.status).toBe(200);
    const review = await reviewResponse.json();
    const response = await PATCH(new NextRequest(`http://localhost/api/project/${projectId}/quality`, { method: "PATCH",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reviewId: review.id, decision: "accepted" }) }),
    { params: Promise.resolve({ id: projectId }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "SCRIPT_CONTEXT_CHANGED" });
    expect(db.select().from(schema.assets).get()?.selected).toBe(false);
    expect(db.select().from(schema.generationReviews).get()?.humanDecision).toBeNull();
  });

  it("reviews against the frozen shot presenter after the project and library reference are replaced", async () => {
    seedScript();
    const response = await evaluate();
    expect(response.status).toBe(200);
    expect(state.evaluate).toHaveBeenCalledWith(expect.objectContaining({ referenceImageUrls: [oldReference],
      contract: expect.objectContaining({ referenceRoles: ["generated-output", "character-reference"] }) }));
    expect(db.select().from(schema.generationReviews).all()).toHaveLength(1);
  });

  it.each([
    { speechMode: "on_camera" as const, voiceover: "", expectedReferences: [] },
    { speechMode: "voiceover" as const, voiceover: shot.voiceover, expectedReferences: [] },
    { speechMode: "on_camera" as const, voiceover: shot.voiceover, expectedReferences: [oldReference] },
  ])("respects hidden people and products with $speechMode speech and '$voiceover'", async ({ speechMode, voiceover, expectedReferences }) => {
    seedScript({ ...shot, voiceover, tidewe: { ...shot.tidewe!, personVisible: false } }, speechMode);
    const response = await evaluate();
    expect(response.status).toBe(200);
    expect(state.evaluate).toHaveBeenCalledWith(expect.objectContaining({ referenceImageUrls: expectedReferences,
      contract: expect.objectContaining({ referenceRoles: ["generated-output", ...(expectedReferences.length ? ["character-reference"] : [])] }) }));
  });

  it("retains the current product and character-library references for ordinary sales scripts", async () => {
    seedScript({ ...shot, tidewe: undefined }, "voiceover", false);
    expect((await evaluate()).status).toBe(200);
    expect(state.evaluate).toHaveBeenCalledWith(expect.objectContaining({ referenceImageUrls: [productReference, replacementReference] }));
  });
});
