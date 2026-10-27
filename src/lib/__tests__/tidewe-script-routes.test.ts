// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { createCreativeProfileSnapshot, createShortVideoSalesProfile, createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { productFactsHash, englishWordCount } from "@/lib/tidewe/validation";
import { assetMatchesScript, assetScopeForShot, scriptRevision } from "@/lib/asset-context";
import { scriptGenerationMetadata } from "@/lib/script-engine/provenance";
import type { TideweCopyDocument, ProductFacts, TidewePresenterSnapshot } from "@/lib/tidewe/types";
import { tidewePresenterAnchor } from "@/lib/tidewe/presenter";

const calls = vi.hoisted(() => ({ generate: vi.fn(), analyze: vi.fn(), observe: vi.fn(), complete: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => db }));
vi.mock("@/lib/tidewe/image-analysis", () => ({ analyzeTideweProductImages: calls.observe }));
vi.mock("@/lib/script-engine/generator", () => ({
  generateScript: calls.generate, analyzeProduct: calls.analyze,
  completeWithJsonRetry: calls.complete, reasoningParams: () => ({}), extractJSON: (text: string) => text,
}));
import { POST as generate } from "@/app/api/llm/script/route";
import { POST as create } from "@/app/api/project/route";
import { PATCH as updateProject } from "@/app/api/project/[id]/route";
import { PATCH as edit, GET as list } from "@/app/api/project/[id]/scripts/route";
import { POST as importCopy } from "@/app/api/project/[id]/import-script/route";
import { POST as judge } from "@/app/api/project/[id]/script-judge/route";

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const projectId = "tidewe-route-project";
const profile = createTideweOutdoorProfile();
const presenterA = { id: "hunter-a", name: "Hunter A", appearance: "成年美国猎人，棕色短发，自然户外着装。", description: "平实自然的户外装备演示者。",
  referenceImages: ["/api/files/presenter-library/hunter-a.png"], sourceReferenceImages: ["https://example.test/hunter-a.png"] };
const presenterB = { ...presenterA, id: "hunter-b", name: "Hunter B", appearance: "成年美国猎人，黑色短发，自然户外着装。",
  referenceImages: ["/api/files/presenter-library/hunter-b.png"], sourceReferenceImages: ["https://example.test/hunter-b.png"] };
const facts: ProductFacts = { version: 1, brand: "TIDEWE", category: "hunting_apparel", items: [] };
const llmConfig = { baseUrl: "https://example.invalid/v1", apiKey: "test-secret", model: "mock-model" };
const copyText = "Sitting still feels different from walking into the woods. Have a look if that sounds familiar.";
const params = () => ({ params: Promise.resolve({ id: projectId }) });
function req(path: string, body?: unknown, method = "POST") {
  return new NextRequest(`http://localhost${path}`, { method, ...(body !== undefined && { body: JSON.stringify(body) }), headers: { "Content-Type": "application/json" } });
}
function generated(text = copyText, presenter?: TidewePresenterSnapshot) {
  const copyDocument: TideweCopyDocument = {
    version: 1, language: "en-US", text, translation: "坐着等候和走进林子感觉不同。适合的话可以看看。",
    angle: "long_wait", hookType: "scene", claimedFactIds: [], factsSnapshot: facts, factsHash: productFactsHash(facts),
    corpusVersion: profile.corpusVersion, compilerVersion: profile.promptCompilerVersion, exampleIds: [],
    wordCount: englishWordCount(text), estimatedDuration: 10,
  };
  const shot: schema.Shot = {
    shotId: 1, type: "hook", duration: 10, description: presenter ? `${tidewePresenterAnchor(presenter)}在林边面向镜头自然展示装备。` : "林间背影坐在树旁观察远处。", camera: "固定镜头", visualSource: "ai_generate",
    prompt: "户外实拍风格，林间人物安静观察远处，镜头保持稳定。", visualIntent: "呈现长时间等待的户外体验。",
    transition: "direct_concat", voiceover: text, tidewe: { copySpan: { start: 0, end: text.length }, translation: copyDocument.translation,
      shotGoal: "等待的户外场景", productVisible: false, ...(presenter && { presenter, personVisible: true }), factRefs: [], sceneId: "woods" },
  };
  return { title: "Waiting in the woods", styleType: "tidewe_outdoor" as const, totalDuration: 10, copyDocument, shots: [shot] };
}
function seedScript(id = "source-script", presenter?: TidewePresenterSnapshot) {
  const script = generated(copyText, presenter);
  return db.insert(schema.scripts).values({ ...script, id, projectId, selected: true, version: 1,
    creativeProfileSnapshot: createCreativeProfileSnapshot(createTideweOutdoorProfile({ presenter }), 1) }).returning().get()!;
}
function generationBody(requestId = "request-0001") {
  return { projectId, requestId, expectedCreativeConfigRevision: 1, llmConfig };
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  db.insert(schema.projects).values({ id: projectId, name: "TIDEWE", productName: "TIDEWE outdoor jacket", productCategory: "hunting_apparel",
    productImages: ["https://example.invalid/jacket.png"], productFacts: facts, creativeProfile: profile, creativeConfigRevision: 1 }).run();
  calls.generate.mockReset().mockResolvedValue([generated()]);
  calls.analyze.mockReset();
  calls.observe.mockReset().mockResolvedValue("observed: visible green jacket");
  calls.complete.mockReset().mockResolvedValue({ verdicts: [], rewrites: [{ shotId: 1, voiceover: "Buy now!", tier: "default" }], descriptionRewrites: [], summary: "意见" });
});
afterEach(() => { sqlite.close(); vi.clearAllMocks(); });

describe("TIDEWE project context", () => {
  it.each(["nested", "flat"])("persists the selected presenter from a %s creation profile and synchronizes the legacy ID", async shape => {
    const creativeProfile = { creationType: "tidewe_outdoor", presenter: presenterA };
    const response = await create(req("/api/project", shape === "nested" ? { creativeProfile } : creativeProfile));
    expect(response.status).toBe(201);
    const row = await response.json();
    expect(row.creativeProfile.presenter).toEqual(presenterA);
    expect(row.creativeProfileDrafts.tidewe_outdoor.presenter).toEqual(presenterA);
    expect(row.characterId).toBe(presenterA.id);
    expect(db.select().from(schema.projects).where(eq(schema.projects.id, row.id)).get()?.creativeProfile).toMatchObject({ presenter: presenterA });
  });

  it("treats a presenter-only profile update as settings and protects the next revision", async () => {
    const response = await updateProject(req(`/api/project/${projectId}`, {
      creativeProfile: { creationType: "tidewe_outdoor", presenter: presenterA }, expectedCreativeConfigRevision: 1,
    }, "PATCH"), params());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ characterId: presenterA.id, creativeConfigRevision: 2,
      creativeProfile: { presenter: presenterA }, creativeProfileDrafts: { tidewe_outdoor: { presenter: presenterA } } });
    const stale = await updateProject(req(`/api/project/${projectId}`, {
      creationType: "tidewe_outdoor", presenter: presenterB, expectedCreativeConfigRevision: 1,
    }, "PATCH"), params());
    expect(stale.status).toBe(409);
    const changed = await updateProject(req(`/api/project/${projectId}`, {
      creationType: "tidewe_outdoor", presenter: presenterB, expectedCreativeConfigRevision: 2,
    }, "PATCH"), params());
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ characterId: presenterB.id, creativeConfigRevision: 3, creativeProfile: { presenter: presenterB } });
  });

  it("rejects standalone character IDs that bypass the authoritative TIDEWE presenter configuration", async () => {
    const missing = await updateProject(req(`/api/project/${projectId}`, { characterId: presenterA.id }, "PATCH"), params());
    expect(missing.status).toBe(400);
    const legacy = await updateProject(req(`/api/project/${projectId}`, { characterId: presenterA.id, expectedCreativeConfigRevision: 1 }, "PATCH"), params());
    expect(legacy.status).toBe(400);
    expect(await legacy.json()).toMatchObject({ code: "TIDEWE_PRESENTER_PROFILE_REQUIRED" });
    const mismatch = await create(req("/api/project", { creativeProfile: { creationType: "tidewe_outdoor", presenter: presenterA }, characterId: presenterB.id }));
    expect(mismatch.status).toBe(400);
    expect(db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()?.characterId).toBeNull();
  });

  it("restores the saved presenter draft after switching creation types", async () => {
    const assigned = await updateProject(req(`/api/project/${projectId}`, {
      creativeProfile: createTideweOutdoorProfile({ presenter: presenterA }), expectedCreativeConfigRevision: 1,
    }, "PATCH"), params());
    expect(assigned.status).toBe(200);
    expect((await updateProject(req(`/api/project/${projectId}`, {
      creativeProfile: { creationType: "short_video_sales" }, expectedCreativeConfigRevision: 2,
    }, "PATCH"), params())).status).toBe(200);
    const restored = await updateProject(req(`/api/project/${projectId}`, {
      creativeProfile: { creationType: "tidewe_outdoor" }, expectedCreativeConfigRevision: 3,
    }, "PATCH"), params());
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ characterId: presenterA.id, creativeConfigRevision: 4, creativeProfile: { presenter: presenterA } });
  });

  it("does not silently discard invalid presenter settings supplied through profile drafts", async () => {
    const invalid = { ...profile, presenter: { ...presenterA, referenceImages: "broken" } };
    expect((await create(req("/api/project", { creativeProfile: { creationType: "short_video_sales" }, creativeProfileDrafts: { tidewe_outdoor: invalid } }))).status).toBe(400);
    const response = await updateProject(req(`/api/project/${projectId}`, {
      creativeProfileDrafts: { tidewe_outdoor: invalid }, expectedCreativeConfigRevision: 1,
    }, "PATCH"), params());
    expect(response.status).toBe(400);
    expect(db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()?.creativeConfigRevision).toBe(1);
  });
  it("creates three independent profile drafts and demotes image specifications to observations", async () => {
    const response = await create(req("/api/project", { creativeProfile: { creationType: "tidewe_outdoor" }, productFacts: {
      ...facts, items: [{ id: "image-color", key: "color", value: "green", status: "confirmed", source: { kind: "uploaded_image", ref: "jacket.png" } }],
    } }));
    expect(response.status).toBe(201);
    const row = await response.json();
    expect(Object.keys(row.creativeProfileDrafts).sort()).toEqual(["premium_product_cg", "short_video_sales", "tidewe_outdoor"]);
    expect(row.productFacts.items[0].status).toBe("observed");
    expect(row.creativeProfile).toMatchObject({ creationType: "tidewe_outdoor", language: "en-US" });
  });
  it("rejects invalid fact sources as a client error", async () => {
    const response = await create(req("/api/project", { creativeProfile: { creationType: "tidewe_outdoor" }, productFacts: { items: [{}] } }));
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("TIDEWE_FACTS_INVALID");
  });
  it("requires context revision for product edits and increments it atomically", async () => {
    const missing = await updateProject(req(`/api/project/${projectId}`, { productImages: ["changed.png"] }, "PATCH"), params());
    expect(missing.status).toBe(400);
    const response = await updateProject(req(`/api/project/${projectId}`, { productImages: ["changed.png"], expectedCreativeConfigRevision: 1 }, "PATCH"), params());
    expect(response.status).toBe(200);
    expect((await response.json()).creativeConfigRevision).toBe(2);
    const stale = await updateProject(req(`/api/project/${projectId}`, { productFacts: facts, expectedCreativeConfigRevision: 1 }, "PATCH"), params());
    expect(stale.status).toBe(409);
  });
  it("rejects a legacy product write when another session switches the project to TIDEWE", async () => {
    db.update(schema.projects).set({ creativeProfile: createShortVideoSalesProfile() }).where(eq(schema.projects.id, projectId)).run();
    const stale = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!;
    // Pause at the asynchronous context read, as a concurrent profile-switch request would.
    const select = vi.spyOn(db, "select").mockImplementationOnce(() => ({
      from: () => ({ where: () => ({ limit: () => {
        db.update(schema.projects).set({ creativeProfile: profile, creativeConfigRevision: 2 }).where(eq(schema.projects.id, projectId)).run();
        return Promise.resolve([stale]);
      } }) }),
    }) as never);
    try {
      const response = await updateProject(req(`/api/project/${projectId}`, { productImages: ["stale-sales-image.png"] }, "PATCH"), params());
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("CREATIVE_CONFIG_CONFLICT");
      const current = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!;
      expect(current.productImages).toEqual(["https://example.invalid/jacket.png"]);
      expect(current.creativeConfigRevision).toBe(2);
    } finally { select.mockRestore(); }
  });
  it("rejects a legacy character write when another session switches to a TIDEWE presenter", async () => {
    db.update(schema.projects).set({ creativeProfile: createShortVideoSalesProfile() }).where(eq(schema.projects.id, projectId)).run();
    const stale = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!;
    const select = vi.spyOn(db, "select").mockImplementationOnce(() => ({
      from: () => ({ where: () => ({ limit: () => {
        db.update(schema.projects).set({ creativeProfile: createTideweOutdoorProfile({ presenter: presenterB }),
          characterId: presenterB.id, creativeConfigRevision: 2 }).where(eq(schema.projects.id, projectId)).run();
        return Promise.resolve([stale]);
      } }) }),
    }) as never);
    try {
      const response = await updateProject(req(`/api/project/${projectId}`, { characterId: presenterA.id }, "PATCH"), params());
      expect(response.status).toBe(409);
      expect(db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()?.characterId).toBe(presenterB.id);
    } finally { select.mockRestore(); }
  });
});

describe("TIDEWE generation, history and concurrency", () => {
  it.each([
    { label: "missing presenter", presenter: undefined },
    { label: "different presenter", presenter: presenterB },
    { label: "changed reference under the same ID", presenter: { ...presenterA, referenceImages: ["https://example.test/recast.png"] } },
  ])("rejects generated output with $label without saving or changing selection", async ({ presenter }) => {
    db.update(schema.projects).set({ creativeProfile: createTideweOutdoorProfile({ presenter: presenterA }), characterId: presenterA.id }).run();
    const source = seedScript("source-script", presenterA);
    calls.generate.mockResolvedValueOnce([generated(copyText, presenter)]);
    const response = await generate(req("/api/llm/script", generationBody()));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "TIDEWE_VALIDATION_FAILED" });
    expect(db.select().from(schema.scripts).all()).toMatchObject([{ id: source.id, selected: true }]);
  });

  it.each(["select", "restore"])("rejects %s when historical shots disagree with their frozen presenter", async action => {
    const persisted = createTideweOutdoorProfile({ presenter: presenterA });
    db.update(schema.projects).set({ creativeProfile: persisted, characterId: presenterA.id }).run();
    const source = seedScript("source-script", presenterA);
    db.insert(schema.scripts).values({ ...generated(copyText, presenterB), id: "corrupt-history", projectId, selected: false,
      version: action === "select" ? 1 : 0, creativeProfileSnapshot: createCreativeProfileSnapshot(persisted, 1) }).run();
    const body = action === "select" ? { selectedScriptId: "corrupt-history" } : { restoreScriptId: "corrupt-history" };
    const response = await edit(req(`/api/project/${projectId}/scripts`, body, "PATCH"), params());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "TIDEWE_VALIDATION_FAILED" });
    expect(db.select().from(schema.scripts).all().find(row => row.selected)?.id).toBe(source.id);
  });

  it("uses the persisted presenter despite conflicting request character and profile data", async () => {
    const persisted = createTideweOutdoorProfile({ presenter: presenterA });
    db.update(schema.projects).set({ creativeProfile: persisted, characterId: presenterA.id }).where(eq(schema.projects.id, projectId)).run();
    calls.generate.mockResolvedValueOnce([generated(copyText, presenterA)]);
    const response = await generate(req("/api/llm/script", { ...generationBody(), character: presenterB,
      characterId: presenterB.id, creativeProfile: createTideweOutdoorProfile({ presenter: presenterB }) }));
    expect(response.status).toBe(200);
    expect(calls.generate).toHaveBeenCalledWith(expect.objectContaining({ creativeProfile: persisted,
      character: { id: presenterA.id, name: presenterA.name, appearance: presenterA.appearance } }));
    expect((await response.json()).scripts[0].creativeProfileSnapshot.profile.presenter).toEqual(presenterA);
  });

  it("archives inflight results after the presenter changes without stealing the selected script", async () => {
    const initial = createTideweOutdoorProfile({ presenter: presenterA });
    db.update(schema.projects).set({ creativeProfile: initial, characterId: presenterA.id }).where(eq(schema.projects.id, projectId)).run();
    const source = seedScript();
    db.update(schema.scripts).set({ creativeProfileSnapshot: createCreativeProfileSnapshot(initial, 1) }).where(eq(schema.scripts.id, source.id)).run();
    calls.generate.mockImplementationOnce(async () => {
      const response = await updateProject(req(`/api/project/${projectId}`, {
        creativeProfile: createTideweOutdoorProfile({ presenter: presenterB }), expectedCreativeConfigRevision: 1,
      }, "PATCH"), params());
      expect(response.status).toBe(200);
      return [generated(copyText, presenterA)];
    });
    const response = await generate(req("/api/llm/script", generationBody("presenter-changed")));
    expect(response.status).toBe(409);
    const rows = db.select().from(schema.scripts).all();
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.selected)?.id).toBe(source.id);
    expect(rows.find(row => row.id !== source.id)).toMatchObject({ selected: false,
      creativeProfileSnapshot: { creativeConfigRevision: 1, profile: { presenter: presenterA } } });
    expect(db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()?.creativeProfile).toMatchObject({ presenter: presenterB });
  });
  it("uses persisted outdoor facts, saves canonical copy and deduplicates request retries", async () => {
    const first = await generate(req("/api/llm/script", generationBody()));
    expect(first.status).toBe(200);
    const result = await first.json();
    expect(result.scripts[0]).toMatchObject({ styleType: "tidewe_outdoor", copyDocument: { text: copyText }, generationMetadata: { requestId: "request-0001" }, scriptHash: expect.any(String) });
    expect(calls.analyze).not.toHaveBeenCalled();
    expect(calls.observe).toHaveBeenCalledTimes(1);
    expect(calls.generate).toHaveBeenCalledWith(expect.objectContaining({ styleType: "tidewe_outdoor", productCategoryHint: "hunting_apparel", productFacts: facts, performanceHint: undefined }));
    expect(calls.generate.mock.calls[0][0].character).toBeUndefined();
    const retry = await generate(req("/api/llm/script", generationBody()));
    expect(retry.status).toBe(200);
    expect(calls.generate).toHaveBeenCalledTimes(1);
    expect(db.select().from(schema.scripts).all()).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(llmConfig.apiKey);
  });
  it("rejects stale or malformed requests before starting a model", async () => {
    const response = await generate(req("/api/llm/script", { ...generationBody(), expectedCreativeConfigRevision: 0 }));
    expect(response.status).toBe(409);
    expect(calls.generate).not.toHaveBeenCalled();
  });
  it("coalesces concurrent retries into one generation and one saved batch", async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    calls.generate.mockImplementationOnce(async () => {
      entered();
      await pending;
      return [generated()];
    });
    const first = generate(req("/api/llm/script", generationBody("concurrent-retry")));
    await started;
    const retry = generate(req("/api/llm/script", generationBody("concurrent-retry")));
    release();
    const responses = await Promise.all([first, retry]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const results = await Promise.all(responses.map((response) => response.json()));
    expect(results[0].scripts[0].id).toBe(results[1].scripts[0].id);
    expect(calls.generate).toHaveBeenCalledTimes(1);
    expect(db.select().from(schema.scripts).all()).toHaveLength(1);
  });
  it("archives the older concurrent request after a newer batch is selected", async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    calls.generate.mockImplementationOnce(async () => {
      entered();
      await pending;
      return [generated()];
    });
    const older = generate(req("/api/llm/script", generationBody("concurrent-older")));
    await started;
    const newer = await generate(req("/api/llm/script", generationBody("concurrent-newer")));
    expect(newer.status).toBe(200);
    release();
    expect((await older).status).toBe(409);
    const rows = db.select().from(schema.scripts).all();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.selected)?.generationMetadata?.requestId).toBe("concurrent-newer");
    expect(rows.find((row) => row.generationMetadata?.requestId === "concurrent-older")?.selected).toBe(false);
  });
  it("replays a batch saved by another worker before the current generation finishes", async () => {
    calls.generate.mockImplementationOnce(async () => {
      const existing = seedScript("other-worker-result");
      db.update(schema.scripts).set({ generationMetadata: { ...scriptGenerationMetadata(llmConfig, "tidewe-outdoor-script"), requestId: "cross-worker-request" } }).where(eq(schema.scripts.id, existing.id)).run();
      return [generated()];
    });
    const response = await generate(req("/api/llm/script", generationBody("cross-worker-request")));
    expect(response.status).toBe(200);
    expect((await response.json()).scripts[0].id).toBe("other-worker-result");
    expect(db.select().from(schema.scripts).all()).toHaveLength(1);
  });
  it("archives a late candidate when the source script changes during generation", async () => {
    const source = seedScript();
    calls.generate.mockImplementationOnce(async () => {
      db.update(schema.scripts).set({ title: "New title", shots: [{ ...source.shots![0], camera: "缓慢横移" }] }).where(eq(schema.scripts.id, source.id)).run();
      return [generated()];
    });
    const response = await generate(req("/api/llm/script", { ...generationBody(), sourceScriptId: source.id, expectedScriptHash: scriptRevision(source) }));
    expect(response.status).toBe(409);
    const rows = db.select().from(schema.scripts).all();
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.id === source.id)?.selected).toBe(true);
    expect(rows.find(row => row.id !== source.id)?.selected).toBe(false);
  });
  it("returns hashes and the canonical copy in script history", async () => {
    const source = seedScript();
    const response = await list(req(`/api/project/${projectId}/scripts`, undefined, "GET"), params());
    const rows = await response.json();
    expect(rows[0]).toMatchObject({ scriptHash: scriptRevision(source), copyDocument: { text: copyText } });
  });
});

describe("TIDEWE editing and import", () => {
  it("preserves the presenter in a camera edit and invalidates media for that changed shot", async () => {
    db.update(schema.projects).set({ creativeProfile: createTideweOutdoorProfile({ presenter: presenterA }), characterId: presenterA.id }).run();
    const source = seedScript("source-script", presenterA);
    const previousAsset = { shotId: 1, ...assetScopeForShot(source, source.shots![0]) };
    const response = await edit(req(`/api/project/${projectId}/scripts`, { scriptId: source.id,
      expectedScriptHash: scriptRevision(source), expectedCreativeConfigRevision: 1,
      shotTexts: [{ shotId: 1, camera: "缓慢前推镜头" }] }, "PATCH"), params());
    expect(response.status).toBe(200);
    const updated = db.select().from(schema.scripts).where(eq(schema.scripts.id, source.id)).get()!;
    expect(updated.shots![0].tidewe?.presenter).toEqual(presenterA);
    expect(updated.copyDocument).toEqual(source.copyDocument);
    expect(assetMatchesScript(previousAsset, source)).toBe(true);
    expect(assetMatchesScript(previousAsset, updated)).toBe(false);
  });

  it("rejects a visual description that replaces the selected presenter", async () => {
    db.update(schema.projects).set({ creativeProfile: createTideweOutdoorProfile({ presenter: presenterA }), characterId: presenterA.id }).run();
    const source = seedScript("source-script", presenterA);
    const response = await edit(req(`/api/project/${projectId}/scripts`, { scriptId: source.id,
      expectedScriptHash: scriptRevision(source), expectedCreativeConfigRevision: 1,
      shotTexts: [{ shotId: 1, description: "年轻金发女性在林中面向镜头展示装备。" }] }, "PATCH"), params());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "TIDEWE_VALIDATION_FAILED" });
    expect(db.select().from(schema.scripts).where(eq(schema.scripts.id, source.id)).get()?.shots).toEqual(source.shots);
  });

  it("preserves the source version and replans complete revised narration", async () => {
    const source = seedScript();
    const revised = "Waiting in the woods is a different kind of day. Take a look if this is how you spend yours.";
    calls.generate.mockResolvedValueOnce([generated(revised)]);
    const response = await edit(req(`/api/project/${projectId}/scripts`, { scriptId: source.id, expectedScriptHash: scriptRevision(source),
      expectedCreativeConfigRevision: 1, copyText: revised, requestId: "request-edit", llmConfig }, "PATCH"), params());
    expect(response.status).toBe(200);
    expect(calls.generate).toHaveBeenCalledWith(expect.objectContaining({ copyText: revised, count: 1 }));
    const rows = db.select().from(schema.scripts).all();
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.id === source.id)?.copyDocument?.text).toBe(copyText);
    expect(rows.find(row => row.selected)?.copyDocument?.text).toBe(revised);
  });
  it("blocks the legacy per-shot voiceover edit channel", async () => {
    const source = seedScript();
    const response = await edit(req(`/api/project/${projectId}/scripts`, { scriptId: source.id, shotTexts: [{ shotId: 1, voiceover: "Buy now" }] }, "PATCH"), params());
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("TIDEWE_COPY_DOCUMENT_REQUIRED");
    expect(db.select().from(schema.scripts).get()?.copyDocument?.text).toBe(copyText);
  });
  it("requires a content hash for visual edits and keeps copy unchanged", async () => {
    const source = seedScript();
    const body = { scriptId: source.id, expectedCreativeConfigRevision: 1, shotTexts: [{ shotId: 1, camera: "缓慢前移" }] };
    const stale = await edit(req(`/api/project/${projectId}/scripts`, body, "PATCH"), params());
    expect(stale.status).toBe(409);
    const response = await edit(req(`/api/project/${projectId}/scripts`, { ...body, expectedScriptHash: scriptRevision(source) }, "PATCH"), params());
    expect(response.status).toBe(200);
    const updated = await response.json();
    expect(updated.script.shots[0].camera).toBe("缓慢前移");
    expect(updated.script.copyDocument.text).toBe(copyText);
    expect(updated.script.scriptHash).not.toBe(scriptRevision(source));
  });
  it("imports the complete English text through semantic planning rather than the sentence splitter", async () => {
    const response = await importCopy(req(`/api/project/${projectId}/import-script`, { script: copyText, requestId: "request-import", expectedCreativeConfigRevision: 1, llmConfig }), params());
    expect(response.status).toBe(200);
    expect(calls.generate).toHaveBeenCalledWith(expect.objectContaining({ copyText, count: 1 }));
    expect(db.select().from(schema.scripts).get()?.styleType).toBe("tidewe_outdoor");
  });

  it("freezes the persisted presenter during full-copy import despite body character overrides", async () => {
    const persisted = createTideweOutdoorProfile({ presenter: presenterA });
    db.update(schema.projects).set({ creativeProfile: persisted, characterId: presenterA.id }).where(eq(schema.projects.id, projectId)).run();
    calls.generate.mockResolvedValueOnce([generated(copyText, presenterA)]);
    const response = await importCopy(req(`/api/project/${projectId}/import-script`, { script: copyText, requestId: "presenter-import",
      expectedCreativeConfigRevision: 1, llmConfig, character: presenterB, creativeProfile: createTideweOutdoorProfile({ presenter: presenterB }) }), params());
    expect(response.status).toBe(200);
    expect(calls.generate).toHaveBeenCalledWith(expect.objectContaining({ creativeProfile: persisted,
      character: { id: presenterA.id, name: presenterA.name, appearance: presenterA.appearance } }));
    expect(db.select().from(schema.scripts).get()?.creativeProfileSnapshot?.profile).toMatchObject({ presenter: presenterA });
  });
  it("gives brand-specific review feedback without exposing model narration rewrites", async () => {
    const source = seedScript();
    const response = await judge(req(`/api/project/${projectId}/script-judge`, { scriptId: source.id, llmConfig }), params());
    expect(response.status).toBe(200);
    const report = await response.json();
    expect(report.rewrites).toEqual([]);
    expect(calls.complete.mock.calls[0][1].messages[0].content).toContain("Off-screen");
    expect(calls.complete.mock.calls[0][1].messages[0].content).toContain(copyText);
  });
});
