// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { assetScopeForShot, scriptRevision } from "@/lib/asset-context";
import { createCreativeProfileSnapshot, createShortVideoSalesProfile, createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { englishWordCount, productFactsHash } from "@/lib/tidewe/validation";
import { TIDEWE_COMPILER_VERSION, TIDEWE_CORPUS_VERSION, type ProductFacts, type TideweCopyDocument } from "@/lib/tidewe/types";
import { tidewePresenterAnchor } from "@/lib/tidewe/presenter";

const state = vi.hoisted(() => ({ persist: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => db }));
vi.mock("@/lib/asset-persistence", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/asset-persistence")>(), persistAssetSource: state.persist,
}));
import { POST, PATCH } from "@/app/api/project/[id]/assets/route";

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const projectId = "tidewe-asset-project";
const profile = createTideweOutdoorProfile();
const facts: ProductFacts = { version: 1, brand: "TIDEWE", category: "hunting_chair", items: [] };
const text = "Long waits change what you want from a chair.";
const copy: TideweCopyDocument = { version: 1, language: "en-US", text, translation: "长时间等待会改变你对一把椅子的需求。",
  angle: "long_wait", hookType: "scene", claimedFactIds: [], factsSnapshot: facts, factsHash: productFactsHash(facts),
  corpusVersion: TIDEWE_CORPUS_VERSION, compilerVersion: TIDEWE_COMPILER_VERSION, exampleIds: [], wordCount: englishWordCount(text), estimatedDuration: 5 };
const shot: schema.Shot = { shotId: 1, type: "hook", duration: 5, description: "林间人物安静等待。", camera: "固定镜头", prompt: "户外实拍人物安静观察树林。", visualIntent: "呈现户外等待场景。",
  voiceover: text, visualSource: "ai_generate", transition: "direct_concat", tidewe: { copySpan: { start: 0, end: text.length }, translation: copy.translation, shotGoal: "展现等待体验", productVisible: false, factRefs: [], sceneId: "woods" } };
const context = () => ({ params: Promise.resolve({ id: projectId }) });
function request(body: unknown, method = "POST") { return new NextRequest(`http://localhost/api/project/${projectId}/assets`, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }); }
function current() { return db.select().from(schema.scripts).where(eq(schema.scripts.id, "script-current")).get()!; }
function payload() { return { shotId: 1, sourceUrl: "https://example.invalid/image.png", scriptId: "script-current", expectedScriptHash: scriptRevision(current()) }; }

beforeEach(() => {
  sqlite = new Database(":memory:"); db = drizzle(sqlite, { schema }); migrate(db, { migrationsFolder: "drizzle" });
  db.insert(schema.projects).values({ id: projectId, name: "TIDEWE", creativeProfile: profile, creativeConfigRevision: 1, productFacts: facts }).run();
  db.insert(schema.scripts).values({ id: "script-current", projectId, version: 1, styleType: "tidewe_outdoor", selected: true, totalDuration: 5, shots: [shot], copyDocument: copy, creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1) }).run();
  state.persist.mockReset().mockResolvedValue(`/api/files/${projectId}/output.png`);
});
afterEach(() => { sqlite.close(); vi.clearAllMocks(); });

describe("TIDEWE asset source context", () => {
  it.each(["save", "select"])("rejects asset %s when the shot presenter differs from the frozen profile", async action => {
    const presenter = { id: "hunter", name: "Hunter", appearance: "成年猎人", referenceImages: ["https://example.test/old.png"] };
    const frozen = createTideweOutdoorProfile({ presenter });
    const recast = { ...presenter, referenceImages: ["https://example.test/recast.png"] };
    const recastShot = { ...shot, description: `${tidewePresenterAnchor(recast)}在林中等待。`,
      tidewe: { ...shot.tidewe!, presenter: recast, personVisible: true } };
    db.update(schema.projects).set({ creativeProfile: frozen }).run();
    db.update(schema.scripts).set({ shots: [recastShot], creativeProfileSnapshot: createCreativeProfileSnapshot(frozen, 1) }).run();
    db.insert(schema.assets).values({ id: "recast-asset", projectId, shotId: 1, type: "ai_generated", status: "done", selected: false,
      ...assetScopeForShot(current(), recastShot) }).run();
    const response = action === "save" ? await POST(request(payload()), context())
      : await PATCH(request({ assetId: "recast-asset" }, "PATCH"), context());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "SCRIPT_CONTEXT_CHANGED" });
    expect(state.persist).not.toHaveBeenCalled();
    expect(db.select().from(schema.assets).all()).toMatchObject([{ id: "recast-asset", selected: false }]);
  });

  it("requires the originating script ID without requiring a version hash", async () => {
    const response = await POST(request({ shotId: 1, sourceUrl: "old-task.png" }), context());
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("TIDEWE_ASSET_CONTEXT_REQUIRED");
    expect(state.persist).not.toHaveBeenCalled();
    expect(db.select().from(schema.assets).all()).toHaveLength(0);
  });
  it("saves a same-script output without a version hash", async () => {
    const response = await POST(request({ shotId: 1, sourceUrl: "old-task.png", scriptId: "script-current" }), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sourceScriptId: "script-current", selected: true });
  });
  it("saves current output with the exact source script and revision", async () => {
    const body = payload();
    const response = await POST(request(body), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sourceScriptId: body.scriptId, sourceRevision: body.expectedScriptHash, sourceShotKey: assetScopeForShot(current(), shot).sourceShotKey, selected: true });
  });
  it("saves a same-script output created before a visual edit", async () => {
    const body = payload();
    db.update(schema.scripts).set({ shots: [{ ...shot, camera: "缓慢前推镜头" }] }).where(eq(schema.scripts.id, body.scriptId)).run();
    const response = await POST(request(body), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sourceScriptId: body.scriptId, selected: true });
    expect(state.persist).toHaveBeenCalledOnce();
  });
  it.each(["script", "configuration"])("continues saving when the same alternative's %s revision changes during download", async (change) => {
    const body = payload();
    state.persist.mockImplementationOnce(async () => {
      if (change === "script") db.update(schema.scripts).set({ shots: [{ ...shot, camera: "缓慢后拉镜头" }] }).where(eq(schema.scripts.id, body.scriptId)).run();
      else db.update(schema.projects).set({ creativeConfigRevision: 2 }).where(eq(schema.projects.id, projectId)).run();
      return `/api/files/${projectId}/late.png`;
    });
    const response = await POST(request(body), context());
    expect(response.status).toBe(200);
    expect(db.select().from(schema.assets).all()).toMatchObject([{ sourceScriptId: body.scriptId, sourceRevision: body.expectedScriptHash, selected: true }]);
  });
  it("rejects a selected alternative change during download", async () => {
    const body = payload();
    state.persist.mockImplementationOnce(async () => {
      db.update(schema.scripts).set({ selected: false }).run();
      db.insert(schema.scripts).values({ ...current(), id: "script-new", selected: true }).run();
      return `/api/files/${projectId}/late.png`;
    });
    expect((await POST(request(body), context())).status).toBe(409);
    expect(db.select().from(schema.assets).all()).toHaveLength(0);
  });
  it("rejects a completed output if another script becomes selected", async () => {
    const body = payload();
    db.update(schema.scripts).set({ selected: false }).run();
    db.insert(schema.scripts).values({ ...current(), id: "script-new", selected: true, version: 2 }).run();
    expect((await POST(request(body), context())).status).toBe(409);
    expect(db.select().from(schema.assets).all()).toHaveLength(0);
  });
  it("allows selecting an existing same-script take after a project revision changes", async () => {
    db.insert(schema.assets).values({ id: "old-take", projectId, shotId: 1, type: "ai_generated", status: "done", selected: false, ...assetScopeForShot(current(), shot) }).run();
    db.update(schema.projects).set({ creativeConfigRevision: 2 }).where(eq(schema.projects.id, projectId)).run();
    const response = await PATCH(request({ assetId: "old-take" }, "PATCH"), context());
    expect(response.status).toBe(200);
    expect(db.select().from(schema.assets).get()?.selected).toBe(true);
  });
  it("retains the legacy sales save protocol without a source hash", async () => {
    db.delete(schema.scripts).run();
    db.update(schema.projects).set({ creativeProfile: createShortVideoSalesProfile() }).run();
    const response = await POST(request({ shotId: 1, sourceUrl: "https://example.invalid/sales.png" }), context());
    expect(response.status).toBe(200);
    expect(db.select().from(schema.assets).get()?.sourceScriptId).toBeNull();
  });
});
