// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { assetScopeForShot, scriptRevision } from "@/lib/asset-context";
import { createCreativeProfileSnapshot, createPremiumProductCgProfile, createTideweOutdoorProfile } from "@/lib/creative-profiles";
import type { ProductFacts, TideweCopyDocument } from "@/lib/tidewe/types";
import { TIDEWE_COMPILER_VERSION, TIDEWE_CORPUS_VERSION } from "@/lib/tidewe/types";
import { englishWordCount, productFactsHash } from "@/lib/tidewe/validation";

vi.mock("@/lib/db", () => ({ getDb: () => db }));
vi.mock("@/lib/asset-persistence", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/asset-persistence")>(),
  persistAssetSource: vi.fn(async (projectId: string) => `/api/files/${projectId}/new-image.png`),
}));
import { PATCH, POST } from "@/app/api/project/[id]/assets/route";

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const projectId = "refinement-adoption";
const scriptId = "current-script";
const profile = createTideweOutdoorProfile();
const facts: ProductFacts = { version: 1, brand: "TIDEWE", category: "hunting_chair", items: [] };
const text = "Long waits change what you want from a chair.";
const copy: TideweCopyDocument = { version: 1, language: "en-US", text, translation: "长时间等待会改变你对一把椅子的需求。",
  angle: "long_wait", hookType: "scene", claimedFactIds: [], factsSnapshot: facts, factsHash: productFactsHash(facts),
  corpusVersion: TIDEWE_CORPUS_VERSION, compilerVersion: TIDEWE_COMPILER_VERSION, exampleIds: [], wordCount: englishWordCount(text), estimatedDuration: 5 };
const shot: schema.Shot = { shotId: 1, type: "hook", duration: 5, description: "林间人物安静等待。", camera: "固定镜头", prompt: "户外实拍人物安静观察树林。", visualIntent: "呈现户外等待场景。",
  voiceover: text, visualSource: "ai_generate", transition: "direct_concat", tidewe: { copySpan: { start: 0, end: text.length }, translation: copy.translation,
    shotGoal: "展现等待体验", productVisible: false, factRefs: [], sceneId: "woods" } };
const context = () => ({ params: Promise.resolve({ id: projectId }) });
function request(body: unknown, method = "PATCH") { return new NextRequest(`http://localhost/api/project/${projectId}/assets`, { method, body: JSON.stringify(body) }); }
function current() { return db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()!; }
function selectedIds() { return db.select().from(schema.assets).all().filter((asset) => asset.selected).map((asset) => asset.id); }
async function adopt(assetId: string) { return PATCH(request({ assetId }), context()); }

beforeEach(() => {
  sqlite = new Database(":memory:"); db = drizzle(sqlite, { schema }); migrate(db, { migrationsFolder: "drizzle" });
  db.insert(schema.projects).values({ id: projectId, name: "Refinement adoption", creativeProfile: profile, creativeConfigRevision: 6, productFacts: facts }).run();
  db.insert(schema.scripts).values({ id: scriptId, projectId, styleType: "tidewe_outdoor", selected: true, shots: [shot], copyDocument: copy,
    creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 2) }).run();
  db.insert(schema.assets).values([
    { id: "original", projectId, shotId: 1, type: "ai_generated", status: "done", selected: true, filePath: `/api/files/${projectId}/original.png`, ...assetScopeForShot(current(), shot) },
    { id: "refined", projectId, shotId: 1, type: "ai_generated", status: "done", selected: false, filePath: `/api/files/${projectId}/keyframe-refine-1-123-abcd1234.png`,
      prompt: "[keyframe-refine-v1] Repair", sourceKeyframeUrl: `/api/files/${projectId}/original.png`, ...assetScopeForShot(current(), shot, "original") },
  ]).run();
});
afterEach(() => { vi.restoreAllMocks(); sqlite.close(); });

function premium() {
  const premiumProfile = createPremiumProductCgProfile({ narrationMode: "none" });
  const productShot: schema.Shot = { ...shot, voiceover: "", tidewe: undefined };
  db.update(schema.projects).set({ creativeProfile: premiumProfile }).run();
  db.update(schema.scripts).set({ styleType: "premium_product_cg", copyDocument: null, shots: [productShot], creativeProfileSnapshot: createCreativeProfileSnapshot(premiumProfile, 2) }).run();
  const originalPath = `/api/files/${projectId}/asset-1-123-grid.png`;
  db.update(schema.assets).set({ ...assetScopeForShot(current(), productShot) }).run();
  db.update(schema.assets).set({ filePath: originalPath, prompt: "[storyboard-grid-v2] Product" }).where(eq(schema.assets.id, "original")).run();
  db.update(schema.assets).set({ sourceKeyframeUrl: originalPath }).where(eq(schema.assets.id, "refined")).run();
}

describe("adopting and restoring existing refined stills", () => {
  it("adopts a TIDEWE candidate and restores its original after revision-only drift", async () => {
    expect((await adopt("refined")).status).toBe(200);
    expect(selectedIds()).toEqual(["refined"]);
    expect((await adopt("original")).status).toBe(200);
    expect(selectedIds()).toEqual(["original"]);
    expect(current().creativeProfileSnapshot?.creativeConfigRevision).toBe(2);
  });

  it("accepts direct same-script TIDEWE output after a project revision changes", async () => {
    const response = await POST(request({ shotId: 1, sourceUrl: "https://example.test/image.png", scriptId, expectedScriptHash: scriptRevision(current()) }, "POST"), context());
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(selectedIds()).toEqual([saved.id]);
    expect(saved.sourceScriptId).toBe(scriptId);
  });

  it.each(["video", "remote-image"])("keeps a same-script %s usable after a project revision changes", async (kind) => {
    db.update(schema.assets).set({ filePath: kind === "video" ? `/api/files/${projectId}/video.mp4` : "https://example.test/image.png" }).where(eq(schema.assets.id, "refined")).run();
    expect((await adopt("refined")).status).toBe(200);
    expect(selectedIds()).toEqual(["refined"]);
  });

  it.each(["invalid-copy", "other-script"])("preserves the current selection after a %s conflict", async (change) => {
    if (change === "invalid-copy") db.update(schema.scripts).set({ copyDocument: { ...copy, translation: "English only" } }).run();
    if (change === "other-script") db.update(schema.assets).set({ sourceScriptId: "another-script" }).where(eq(schema.assets.id, "refined")).run();
    expect((await adopt("refined")).status).toBe(409);
    expect(selectedIds()).toEqual(["original"]);
  });

  it.each(["facts", "profile"])("keeps an existing same-script take usable after live project %s edits", async (change) => {
    if (change === "facts") db.update(schema.projects).set({ productFacts: { ...facts, sku: "different-product" } }).run();
    else db.update(schema.projects).set({ creativeProfile: createTideweOutdoorProfile({ speechMode: "voiceover" }) }).run();
    expect((await adopt("refined")).status).toBe(200);
    expect(selectedIds()).toEqual(["refined"]);
    expect(current().copyDocument?.factsHash).toBe(copy.factsHash);
  });

  it("adopts an existing take after editing its shot in the same alternative", async () => {
    const originalScope = db.select().from(schema.assets).where(eq(schema.assets.id, "refined")).get()!;
    db.update(schema.scripts).set({ shots: [{ ...shot, camera: "缓慢前推镜头" }] }).run();
    expect((await adopt("refined")).status).toBe(200);
    expect(selectedIds()).toEqual(["refined"]);
    expect(db.select().from(schema.assets).where(eq(schema.assets.id, "refined")).get()?.sourceRevision).toBe(originalScope.sourceRevision);
  });

  it("adopts and restores trusted premium CG stills under unchanged frozen settings", async () => {
    premium();
    expect((await adopt("refined")).status).toBe(200);
    expect(selectedIds()).toEqual(["refined"]);
    expect((await adopt("original")).status).toBe(200);
    expect(selectedIds()).toEqual(["original"]);
  });

  it("retains premium CG provenance validation for stale-compatible stills", async () => {
    premium();
    db.update(schema.assets).set({ prompt: "Untrusted image" }).where(eq(schema.assets.id, "refined")).run();
    const response = await adopt("refined");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "PREMIUM_CG_ASSET_PROVENANCE_REQUIRED" });
    expect(selectedIds()).toEqual(["original"]);
  });

  it("adopts trusted same-script premium CG videos after project revision changes", async () => {
    premium();
    db.update(schema.assets).set({ filePath: `/api/files/${projectId}/kling/take.mp4`, provider: "kling-cli" }).where(eq(schema.assets.id, "refined")).run();
    const response = await adopt("refined");
    expect(response.status).toBe(200);
    expect(selectedIds()).toEqual(["refined"]);
  });

  it("uses the frozen premium CG context when live settings change inside the selection transaction", async () => {
    premium();
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce((callback, options) => {
      db.update(schema.projects).set({ creativeProfile: createPremiumProductCgProfile({ narrationMode: "restrained" }) }).run();
      return transaction(callback, options);
    });
    const response = await adopt("refined");
    expect(response.status).toBe(200);
    expect(selectedIds()).toEqual(["refined"]);
    expect(current().creativeProfileSnapshot?.profile).toMatchObject({ narrationMode: "none" });
  });
});
