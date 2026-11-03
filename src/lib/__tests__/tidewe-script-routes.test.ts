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
import { productFactsHash, englishWordCount, TideweValidationError } from "@/lib/tidewe/validation";
import { withGenerationContext } from "@/lib/generation-context";
import { assetMatchesScript, assetScopeForShot, scriptRevision } from "@/lib/asset-context";
import { scriptGenerationMetadata } from "@/lib/script-engine/provenance";
import type { TideweCopyDocument, ProductFacts, TidewePresenterSnapshot } from "@/lib/tidewe/types";
import { tidewePresenterAnchor } from "@/lib/tidewe/presenter";

const calls = vi.hoisted(() => ({ generate: vi.fn(), analyze: vi.fn(), observe: vi.fn(), complete: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => db }));
vi.mock("@/lib/tidewe/image-analysis", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/tidewe/image-analysis")>(),
  analyzeTideweProductImages: calls.observe,
}));
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
const durationShotCounts = [{ targetDuration: 30, shotCount: 7 }, { targetDuration: 40, shotCount: 8 }, { targetDuration: 60, shotCount: 9 }];
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
function generated(text = copyText, presenter?: TidewePresenterSnapshot, shotCount = 8) {
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
  const shots = Array.from({ length: shotCount }, (_, index): schema.Shot => index === 0 ? shot : {
    ...shot, shotId: index + 1, duration: 1, voiceover: "",
    description: "林间环境与远处小径的自然观察画面。",
    tidewe: { ...shot.tidewe!, copySpan: { start: text.length, end: text.length },
      shotGoal: `补充第${index + 1}处户外环境观察`, personVisible: false, productVisible: false },
  });
  return { title: "Waiting in the woods", styleType: "tidewe_outdoor" as const, totalDuration: 9 + shotCount, copyDocument, shots };
}
function seedScript(id = "source-script", presenter?: TidewePresenterSnapshot) {
  // Historical scripts remain usable even when they predate the generation shot-count rule.
  const script = generated(copyText, presenter, 1);
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

describe("script product observation reuse", () => {
  const legacyObservations = "UNVERIFIED VISUAL OBSERVATIONS ONLY (not product specifications): observed green jacket";
  const controlObservations = "TIDEWE_REFERENCE_APPEARANCE_V2: 图3 observed 胸前控制器与按钮轮廓清楚可见。";
  const currentObservations = "TIDEWE_REFERENCE_APPEARANCE_V3: 图1 observed 靴筒轮廓与鞋底纹路清楚可见。";

  it.each([legacyObservations, controlObservations])("refreshes only known older project caches once: %s", async previousObservations => {
    db.update(schema.projects).set({ productAnalysis: previousObservations }).run();
    calls.observe.mockResolvedValue(currentObservations);
    const first = await generate(req("/api/llm/script", generationBody("refresh-legacy-cache")));
    expect(first.status).toBe(200);
    expect(calls.generate.mock.calls[0][0].productAnalysis).toBe(currentObservations);
    expect(db.select().from(schema.projects).get()?.productAnalysis).toBe(currentObservations);
    const second = await generate(req("/api/llm/script", generationBody("reuse-refreshed-cache")));
    expect(second.status).toBe(200);
    expect(calls.observe).toHaveBeenCalledOnce();
    expect(calls.generate.mock.calls[1][0].productAnalysis).toBe(currentObservations);
  });

  it("forwards all saved reference images to the single observation call", async () => {
    const references = Array.from({ length: 6 }, (_, index) => `https://example.invalid/jacket-${index + 1}.png`);
    db.update(schema.projects).set({ productImages: references }).run();
    expect((await generate(req("/api/llm/script", generationBody("all-product-images")))).status).toBe(200);
    expect(calls.observe).toHaveBeenCalledExactlyOnceWith(llmConfig, references);
  });

  it.each([legacyObservations, controlObservations])("preserves explicitly supplied older observations: %s", async explicitObservations => {
    db.update(schema.projects).set({ productAnalysis: explicitObservations }).run();
    const response = await generate(req("/api/llm/script", { ...generationBody(), productAnalysis: explicitObservations }));
    expect(response.status).toBe(200);
    expect(calls.observe).not.toHaveBeenCalled();
    expect(calls.generate.mock.calls[0][0].productAnalysis).toBe(explicitObservations);
  });

  it.each([legacyObservations, controlObservations].flatMap(previousObservations =>
    ["checkpoint string", "completed unavailable analysis", "failed attempt", "generated result"].map(kind => ({ previousObservations, kind })),
  ))("does not reanalyze older evidence while resuming a $kind: $previousObservations", async ({ previousObservations, kind }) => {
    db.update(schema.projects).set({ productAnalysis: previousObservations }).run();
    let checkpoint: Record<string, unknown> = kind === "checkpoint string" ? { productAnalysis: previousObservations }
      : kind === "completed unavailable analysis" ? { analysisComplete: true, productAnalysis: null }
      : kind === "failed attempt" ? { scriptValidationFailure: { code: "TIDEWE_VALIDATION_FAILED", message: "Invalid metadata" } }
      : { generatedScripts: [generated()], submissionState: "acknowledged" };
    const response = await withGenerationContext({ itemId: "legacy-checkpoint", checkpoint, save: value => { checkpoint = structuredClone(value); } },
      () => generate(req("/api/llm/script", generationBody("legacy-checkpoint"))));
    expect(response.status).toBe(200);
    expect(calls.observe).not.toHaveBeenCalled();
    if (kind === "generated result") expect(calls.generate).not.toHaveBeenCalled();
    else expect(calls.generate.mock.calls[0][0].productAnalysis).toBe(previousObservations);
  });

  it.each(["custom product observations", "TIDEWE_REFERENCE_APPEARANCE_V4: newer product observations"])("preserves custom and unknown newer project evidence: %s", async savedObservations => {
    db.update(schema.projects).set({ productAnalysis: savedObservations }).run();
    expect((await generate(req("/api/llm/script", generationBody()))).status).toBe(200);
    expect(calls.observe).not.toHaveBeenCalled();
    expect(calls.generate.mock.calls[0][0].productAnalysis).toBe(savedObservations);
  });

  it("reuses saved image observations for a fresh regeneration", async () => {
    expect((await generate(req("/api/llm/script", generationBody("first-generation")))).status).toBe(200);
    expect(calls.observe).toHaveBeenCalledOnce();
    expect((await generate(req("/api/llm/script", generationBody("next-generation")))).status).toBe(200);
    expect(calls.observe).toHaveBeenCalledOnce();
    expect(calls.generate).toHaveBeenCalledTimes(2);
    expect(calls.generate.mock.calls[1][0].productAnalysis).toBe("observed: visible green jacket");
  });

  it("honors explicitly supplied observations over the saved cache", async () => {
    db.update(schema.projects).set({ productAnalysis: "old observations" }).run();
    const response = await generate(req("/api/llm/script", { ...generationBody(), productAnalysis: "user-supplied observations" }));
    expect(response.status).toBe(200);
    expect(calls.observe).not.toHaveBeenCalled();
    expect(calls.generate).toHaveBeenCalledWith(expect.objectContaining({ productAnalysis: "user-supplied observations" }));
  });

  it("keeps the durable analysis checkpoint authoritative when resuming a frozen project", async () => {
    db.update(schema.projects).set({ productAnalysis: "project observations" }).run();
    const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!;
    let checkpoint: Record<string, unknown> = { analysisComplete: true, productAnalysis: "checkpoint observations", submissionState: "not_submitted" };
    const response = await withGenerationContext({
      itemId: "resume-observations", checkpoint, snapshot: { project }, save: value => { checkpoint = structuredClone(value); },
    }, () => generate(req("/api/llm/script", { ...generationBody(), productAnalysis: "request observations" })));
    expect(response.status).toBe(200);
    expect(calls.observe).not.toHaveBeenCalled();
    expect(calls.generate).toHaveBeenCalledWith(expect.objectContaining({ productAnalysis: "checkpoint observations" }));
    expect(checkpoint.productAnalysis).toBe("checkpoint observations");
  });

  it.each(["tidewe", "sales"])("preserves cached observations when %s product inputs are saved unchanged", async kind => {
    if (kind === "sales") db.update(schema.projects).set({ creativeProfile: createShortVideoSalesProfile() }).run();
    db.update(schema.projects).set({ productAnalysis: "cached observations" }).run();
    const current = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!;
    const response = await updateProject(req(`/api/project/${projectId}`, {
      productName: current.productName, productImages: [...current.productImages!], expectedCreativeConfigRevision: 1,
    }, "PATCH"), params());
    expect(response.status).toBe(200);
    expect((await response.json()).productAnalysis).toBe("cached observations");
  });

  const productChanges = [
    { field: "productImages", value: ["https://example.invalid/new-jacket.png"] },
    { field: "productName", value: "New outdoor jacket" },
    { field: "productCategory", value: "heated_gear" },
    { field: "productDescription", value: "A different product brief." },
    { field: "productId", value: "new-product" },
    { field: "brandId", value: "new-brand" },
  ];
  it.each(productChanges.flatMap(change => ["tidewe", "sales"].map(kind => ({ ...change, kind }))))(
    "clears old observations after $kind $field changes and analyzes the current images on generation", async ({ field, value, kind }) => {
      if (kind === "sales") {
        db.update(schema.projects).set({ creativeProfile: createShortVideoSalesProfile() }).run();
        calls.analyze.mockResolvedValue("new sales product observations");
      }
      db.update(schema.projects).set({ productAnalysis: "old product observations" }).run();
      const response = await updateProject(req(`/api/project/${projectId}`, {
        [field]: value, expectedCreativeConfigRevision: 1,
      }, "PATCH"), params());
      expect(response.status).toBe(200);
      const updated = await response.json();
      expect(updated.productAnalysis).toBeNull();
      const generatedResponse = await generate(req("/api/llm/script", { ...generationBody(), expectedCreativeConfigRevision: updated.creativeConfigRevision }));
      expect(generatedResponse.status).toBe(200);
      const analyzer = kind === "tidewe" ? calls.observe : calls.analyze;
      expect(analyzer).toHaveBeenCalledOnce();
      if (field === "productImages") expect(analyzer.mock.calls[0][kind === "tidewe" ? 1 : 0]).toEqual(value);
      expect(calls.generate).toHaveBeenCalledWith(expect.objectContaining({
        productAnalysis: kind === "tidewe" ? "observed: visible green jacket" : "new sales product observations",
      }));
    },
  );

  it("retains explicitly replaced observations in the same product update", async () => {
    db.update(schema.projects).set({ productAnalysis: "old observations" }).run();
    const response = await updateProject(req(`/api/project/${projectId}`, {
      productImages: ["https://example.invalid/replaced-jacket.png"], productAnalysis: "replacement observations", expectedCreativeConfigRevision: 1,
    }, "PATCH"), params());
    expect(response.status).toBe(200);
    expect((await response.json()).productAnalysis).toBe("replacement observations");
  });
});

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

  it("keeps the saved presenter when a creation type change is rejected", async () => {
    const assigned = await updateProject(req(`/api/project/${projectId}`, {
      creativeProfile: createTideweOutdoorProfile({ presenter: presenterA }), expectedCreativeConfigRevision: 1,
    }, "PATCH"), params());
    expect(assigned.status).toBe(200);
    const switched = await updateProject(req(`/api/project/${projectId}`, {
      creativeProfile: { creationType: "short_video_sales" }, expectedCreativeConfigRevision: 2,
    }, "PATCH"), params());
    expect(switched.status).toBe(400);
    expect(await switched.json()).toMatchObject({ code: "CREATION_TYPE_LOCKED", creationType: "tidewe_outdoor" });
    const restored = await updateProject(req(`/api/project/${projectId}`, {
      creativeProfile: { creationType: "tidewe_outdoor" }, expectedCreativeConfigRevision: 2,
    }, "PATCH"), params());
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ characterId: presenterA.id, creativeConfigRevision: 2, creativeProfile: { presenter: presenterA } });
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
  it("creates two independent profile drafts and demotes image specifications to observations", async () => {
    const response = await create(req("/api/project", { creativeProfile: { creationType: "tidewe_outdoor" }, productFacts: {
      ...facts, items: [{ id: "image-color", key: "color", value: "green", status: "confirmed", source: { kind: "uploaded_image", ref: "jacket.png" } }],
    } }));
    expect(response.status).toBe(201);
    const row = await response.json();
    expect(Object.keys(row.creativeProfileDrafts).sort()).toEqual(["short_video_sales", "tidewe_outdoor"]);
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

describe("TIDEWE optional AI scene direction", () => {
  it("forwards a trimmed scene brief to single-copy AI generation without treating it as full copy", async () => {
    const sceneDescription = "清晨湖边，一位猎人穿着当前装备，在浅水旁自然展示外观。";
    calls.generate.mockResolvedValueOnce([generated()]);
    const response = await generate(req("/api/llm/script", { ...generationBody(), sceneDescription: `  ${sceneDescription}\r\n` }));
    expect(response.status).toBe(200);
    expect((await response.json()).scripts).toHaveLength(1);
    expect(calls.generate).toHaveBeenCalledWith(expect.objectContaining({ sceneDescription, count: 1 }));
    expect(calls.generate.mock.calls[0][0]).not.toHaveProperty("copyText");
  });

  it.each([undefined, "", " \r\n\t "])("preserves the original AI input when the scene brief is %j", async sceneDescription => {
    const response = await generate(req("/api/llm/script", { ...generationBody(), sceneDescription }));
    expect(response.status).toBe(200);
    expect(calls.generate.mock.calls[0][0]).not.toHaveProperty("sceneDescription");
    expect(calls.generate.mock.calls[0][0]).toMatchObject({ count: 1 });
  });

  it.each([null, false, 123, [], { scene: "lake" }])("rejects a non-text AI scene brief before paid generation: %j", async sceneDescription => {
    const response = await generate(req("/api/llm/script", { ...generationBody(), sceneDescription }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "TIDEWE_SCENE_DESCRIPTION_INVALID" });
    expect(calls.observe).not.toHaveBeenCalled();
    expect(calls.generate).not.toHaveBeenCalled();
    expect(db.select().from(schema.scripts).all()).toEqual([]);
  });

  it.each(["希望在湖边展示", { scene: "lake" }])("ignores stale scene direction when complete English copy is provided: %j", async sceneDescription => {
    const response = await generate(req("/api/llm/script", { ...generationBody(), sceneDescription, copyText }));
    expect(response.status).toBe(200);
    expect(calls.generate.mock.calls[0][0]).toMatchObject({ copyText, count: 1 });
    expect(calls.generate.mock.calls[0][0]).not.toHaveProperty("sceneDescription");
  });

  it.each([createShortVideoSalesProfile()])("keeps scene direction out of $creationType generation", async creativeProfile => {
    db.update(schema.projects).set({ creativeProfile }).where(eq(schema.projects.id, projectId)).run();
    const response = await generate(req("/api/llm/script", { ...generationBody(), sceneDescription: { scene: "lake" } }));
    expect(response.status).toBe(200);
    expect(calls.generate).toHaveBeenCalledOnce();
    expect(calls.generate.mock.calls[0][0]).not.toHaveProperty("sceneDescription");
  });
});

describe("TIDEWE generation, history and concurrency", () => {
  it.each(durationShotCounts.flatMap(setting => [false, true].map(regenerate => ({ ...setting, regenerate }))))("saves exactly $shotCount shots for the $targetDuration-second target on initial generation or regeneration=$regenerate", async ({ targetDuration, shotCount, regenerate }) => {
    db.update(schema.projects).set({ creativeProfile: createTideweOutdoorProfile({ targetDuration }) }).where(eq(schema.projects.id, projectId)).run();
    const source = regenerate ? seedScript() : undefined;
    calls.generate.mockResolvedValueOnce([generated(copyText, undefined, shotCount)]);
    const response = await generate(req("/api/llm/script", {
      ...generationBody(), ...(source && { sourceScriptId: source.id, expectedScriptHash: scriptRevision(source) }),
    }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.scripts).toHaveLength(1);
    expect(result.scripts[0].shots).toHaveLength(shotCount);
    expect(result.scripts[0].copyDocument.text).toBe(copyText);
    expect(result.scripts[0].selected).toBe(true);
    const rows = db.select().from(schema.scripts).all();
    expect(rows).toHaveLength(regenerate ? 2 : 1);
    expect(rows.find(row => row.selected)?.shots).toHaveLength(shotCount);
    if (source) expect(rows.find(row => row.id === source.id)).toMatchObject({ selected: false, shots: source.shots, copyDocument: source.copyDocument });
    expect(calls.generate).toHaveBeenCalledOnce();
    expect(calls.generate).toHaveBeenCalledWith(expect.objectContaining({ count: 1, creativeProfile: expect.objectContaining({ targetDuration }) }));
  });

  it.each([2, 3].flatMap(count => [false, true].map(regenerate => ({ count, regenerate }))))("normalizes legacy count=$count to one copy on initial generation or regeneration=$regenerate", async ({ count, regenerate }) => {
    const source = regenerate ? seedScript() : undefined;
    const response = await generate(req("/api/llm/script", {
      ...generationBody(), count, ...(source && { sourceScriptId: source.id, expectedScriptHash: scriptRevision(source) }),
    }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.scripts).toHaveLength(1);
    expect(calls.generate).toHaveBeenCalledOnce();
    expect(calls.generate).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }));
    expect(db.select().from(schema.scripts).all()).toHaveLength(regenerate ? 2 : 1);
  });

  it.each([1, 2, 3])("recovers all %s previously paid copies and replays their request without generating again", async count => {
    const paidScripts = Array.from({ length: count }, (_, index) => ({ ...generated(), title: `Recovered copy ${index + 1}` }));
    const body = generationBody(`paid-checkpoint-${count}`);
    let checkpoint: Record<string, unknown> = { generatedScripts: paidScripts, submissionState: "acknowledged", analysisComplete: true, productAnalysis: "observed green jacket" };
    const response = await withGenerationContext({ itemId: `paid-checkpoint-${count}`, checkpoint, save: value => { checkpoint = structuredClone(value); } },
      () => generate(req("/api/llm/script", body)));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.scripts).toHaveLength(count);
    expect(result.scripts.map((script: { title: string }) => script.title)).toEqual(paidScripts.map(script => script.title));
    expect(result.scripts.filter((script: { selected: boolean }) => script.selected)).toHaveLength(1);
    expect(checkpoint.generatedScripts).toEqual(paidScripts);
    const replay = await generate(req("/api/llm/script", body));
    expect(replay.status).toBe(200);
    expect((await replay.json()).scripts.map((script: { id: string }) => script.id)).toEqual(result.scripts.map((script: { id: string }) => script.id));
    expect(db.select().from(schema.scripts).all()).toHaveLength(count);
    expect(calls.generate).not.toHaveBeenCalled();
    expect(calls.observe).not.toHaveBeenCalled();
    expect(calls.analyze).not.toHaveBeenCalled();
  });

  it.each([5, 7, 9, 10])("saves a completed %s-shot checkpoint without buying generation again", async shotCount => {
    const source = seedScript();
    const paidScripts = [generated(copyText, undefined, shotCount)];
    let checkpoint: Record<string, unknown> = { generatedScripts: paidScripts, submissionState: "acknowledged", analysisComplete: true, productAnalysis: "observed green jacket" };
    const execute = () => withGenerationContext({ itemId: `recovered-${shotCount}-shot-script`, checkpoint, save: value => { checkpoint = structuredClone(value); } },
      () => generate(req("/api/llm/script", { ...generationBody(`checkpoint-${shotCount}`), sourceScriptId: source.id, expectedScriptHash: scriptRevision(source) })));
    let savedIds: string[] | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await execute();
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.scripts[0].shots).toHaveLength(shotCount);
      const ids = result.scripts.map((script: { id: string }) => script.id);
      if (savedIds) expect(ids).toEqual(savedIds);
      savedIds = ids;
      expect(checkpoint.generatedScripts).toEqual(paidScripts);
      const rows = db.select().from(schema.scripts).all();
      expect(rows).toHaveLength(2);
      expect(rows.find(row => row.id === source.id)?.selected).toBe(false);
      expect(rows.find(row => row.selected)?.shots).toHaveLength(shotCount);
    }
    expect(calls.generate).not.toHaveBeenCalled();
    expect(calls.observe).not.toHaveBeenCalled();
    expect(calls.analyze).not.toHaveBeenCalled();
  });

  it.each([
    ...durationShotCounts.flatMap(({ targetDuration, shotCount: expectedShotCount }) => [7, 8, 9]
      .filter(shotCount => shotCount !== expectedShotCount).map(shotCount => ({ targetDuration, expectedShotCount, shotCount }))),
    ...[5, 10].map(shotCount => ({ targetDuration: 40, expectedShotCount: 8, shotCount })),
  ])("directly applies generated $shotCount-shot output for the $targetDuration-second target", async ({ targetDuration, shotCount }) => {
    db.update(schema.projects).set({ creativeProfile: createTideweOutdoorProfile({ targetDuration }) }).where(eq(schema.projects.id, projectId)).run();
    seedScript();
    calls.generate.mockResolvedValueOnce([generated(copyText, undefined, shotCount)]);
    const response = await generate(req("/api/llm/script", generationBody()));
    expect(response.status).toBe(200);
    expect((await response.json()).scripts[0]).toMatchObject({ selected: true, copyDocument: { text: copyText } });
    const rows = db.select().from(schema.scripts).all();
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.selected)?.shots).toHaveLength(shotCount);
    expect(calls.generate).toHaveBeenCalledOnce();
  });

  it.each([2, 3])("rejects %s newly generated copies without saving them or replacing the selected historical script", async count => {
    seedScript();
    const before = db.select().from(schema.scripts).all();
    calls.generate.mockResolvedValueOnce(Array.from({ length: count }, () => generated()));
    const response = await generate(req("/api/llm/script", { ...generationBody(), count }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "TIDEWE_VALIDATION_FAILED" });
    expect(db.select().from(schema.scripts).all()).toEqual(before);
    expect(calls.generate).toHaveBeenCalledOnce();
    expect(calls.generate).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }));
  });

  it("recovers all previously paid copies with their generated shot counts", async () => {
    const paidScripts = [generated(), generated(copyText, undefined, 7)];
    let checkpoint: Record<string, unknown> = { generatedScripts: paidScripts, submissionState: "acknowledged", analysisComplete: true, productAnalysis: "observed green jacket" };
    const response = await withGenerationContext({ itemId: "paid-invalid-second-copy", checkpoint, save: value => { checkpoint = structuredClone(value); } },
      () => generate(req("/api/llm/script", generationBody("paid-invalid-second-copy"))));
    expect(response.status).toBe(200);
    expect((await response.json()).scripts.map((script: { shots: schema.Shot[] }) => script.shots.length)).toEqual([8, 7]);
    expect(checkpoint.generatedScripts).toEqual(paidScripts);
    expect(db.select().from(schema.scripts).all()).toHaveLength(2);
    expect(calls.generate).not.toHaveBeenCalled();
  });

  it("applies generated creative output without quality review and keeps it selectable and editable", async () => {
    const source = seedScript();
    const output = generated("Buy now! These 20 features are worth a look.", undefined, 3);
    output.shots[0] = { ...output.shots[0], duration: 1, description: "Outdoor presenter holds the jacket.", camera: "foreground blur" };
    calls.generate.mockResolvedValueOnce([output]);
    const response = await generate(req("/api/llm/script", generationBody()));
    expect(response.status).toBe(200);
    const saved = (await response.json()).scripts[0];
    expect(saved).toMatchObject({ selected: true, shots: output.shots, copyDocument: output.copyDocument });
    expect((await edit(req(`/api/project/${projectId}/scripts`, { selectedScriptId: source.id }, "PATCH"), params())).status).toBe(200);
    expect((await edit(req(`/api/project/${projectId}/scripts`, { selectedScriptId: saved.id }, "PATCH"), params())).status).toBe(200);
    expect((await edit(req(`/api/project/${projectId}/scripts`, { scriptId: saved.id, shotTexts: [{ shotId: 1, camera: "手持跟随" }] }, "PATCH"), params())).status).toBe(200);
    expect(db.select().from(schema.scripts).all().find(row => row.id === saved.id)?.copyDocument).toEqual(output.copyDocument);
    expect(calls.generate).toHaveBeenCalledOnce();
    expect(calls.complete).not.toHaveBeenCalled();
  });

  it.each(["planner rejection", "empty candidates", "missing canonical copy", "invalid shot"])("records %s as a completed local failure without recoverable scripts", async failure => {
    const source = seedScript();
    if (failure === "planner rejection") calls.generate.mockRejectedValueOnce(new TideweValidationError("Shot 2 has on_camera speech in detail framing; use off_camera narration or choose a framing that includes the speaking face."));
    else if (failure === "empty candidates") calls.generate.mockResolvedValueOnce([]);
    else if (failure === "missing canonical copy") calls.generate.mockResolvedValueOnce([{ ...generated(), copyDocument: undefined }]);
    else {
      const invalid = generated();
      invalid.shots[0].tidewe!.copySpan = { start: 0, end: 1 };
      calls.generate.mockResolvedValueOnce([invalid]);
    }
    let checkpoint: Record<string, unknown> = {};
    const response = await withGenerationContext({ itemId: "local-validation", checkpoint, save: value => { checkpoint = structuredClone(value); } },
      () => generate(req("/api/llm/script", { ...generationBody(), productAnalysis: "observed green jacket" })));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "TIDEWE_VALIDATION_FAILED" });
    expect(checkpoint).toMatchObject({ submissionState: "acknowledged", stage: "failed", scriptValidationFailure: { code: "TIDEWE_VALIDATION_FAILED" } });
    expect(checkpoint.generatedScripts).toBeUndefined();
    expect(db.select().from(schema.scripts).all()).toMatchObject([{ id: source.id, selected: true }]);
    expect(calls.generate).toHaveBeenCalledOnce();
  });

  it("preserves an interrupted LLM submission as unknown instead of labelling it a local failure", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    calls.generate.mockRejectedValueOnce(new Error("network interrupted"));
    let checkpoint: Record<string, unknown> = {};
    try {
      const response = await withGenerationContext({ itemId: "network-failure", checkpoint, save: value => { checkpoint = structuredClone(value); } },
        () => generate(req("/api/llm/script", { ...generationBody(), productAnalysis: "observed green jacket" })));
      expect(response.status).toBe(500);
      expect(checkpoint.submissionState).toBe("submitting");
      expect(checkpoint.scriptValidationFailure).toBeUndefined();
      expect(checkpoint.generatedScripts).toBeUndefined();
    } finally { log.mockRestore(); }
  });

  it("rejects invalid imported copy before submission without marking it acknowledged", async () => {
    let checkpoint: Record<string, unknown> = {};
    const response = await withGenerationContext({ itemId: "invalid-copy", checkpoint, save: value => { checkpoint = structuredClone(value); } },
      () => generate(req("/api/llm/script", { ...generationBody(), copyText: "这是一段中文文案" })));
    expect(response.status).toBe(400);
    expect(checkpoint).toEqual({});
    expect(calls.generate).not.toHaveBeenCalled();
  });

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

  it("archives inflight generation after project presenter settings change", async () => {
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
    expect(rows.find(row => row.id === source.id)?.selected).toBe(true);
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
  it("accepts an older configuration counter but rejects malformed request identifiers", async () => {
    const response = await generate(req("/api/llm/script", { ...generationBody(), expectedCreativeConfigRevision: 0 }));
    expect(response.status).toBe(200);
    expect(calls.generate).toHaveBeenCalledTimes(1);
    calls.generate.mockClear();
    const malformed = await generate(req("/api/llm/script", { ...generationBody("bad") }));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "TIDEWE_REQUEST_ID_REQUIRED" });
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
    const lateResponse = await older;
    expect(lateResponse.status).toBe(409);
    expect(await lateResponse.json()).toMatchObject({ code: "SCRIPT_CONTEXT_CHANGED" });
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
  it("archives generation when the same source script is edited during generation", async () => {
    const source = seedScript();
    calls.generate.mockImplementationOnce(async () => {
      db.update(schema.scripts).set({ title: "New title", shots: [{ ...source.shots![0], camera: "缓慢横移" }] }).where(eq(schema.scripts.id, source.id)).run();
      return [generated()];
    });
    const response = await generate(req("/api/llm/script", { ...generationBody(), sourceScriptId: source.id, expectedScriptHash: scriptRevision(source) }));
    expect(response.status).toBe(409);
    const rows = db.select().from(schema.scripts).all();
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.id === source.id)).toMatchObject({ selected: true, title: "New title", shots: [{ camera: "缓慢横移" }] });
    expect(rows.find(row => row.id !== source.id)?.selected).toBe(false);
  });
  it("returns hashes and the canonical copy in script history", async () => {
    const source = seedScript();
    const response = await list(req(`/api/project/${projectId}/scripts`, undefined, "GET"), params());
    const rows = await response.json();
    expect(rows[0]).toMatchObject({ scriptHash: scriptRevision(source), copyDocument: { text: copyText } });
  });
});

describe("TIDEWE alternative selection", () => {
  function select(scriptId: string) {
    return edit(req(`/api/project/${projectId}/scripts`, { selectedScriptId: scriptId }, "PATCH"), params());
  }

  it("switches and restores earlier-configuration alternatives without changing frozen content or project settings", async () => {
    const source = seedScript("source-script", presenterA);
    const alternative = db.insert(schema.scripts).values({ ...source, id: "alternative", selected: false }).returning().get()!;
    db.update(schema.projects).set({ creativeProfile: createTideweOutdoorProfile({ presenter: presenterB }),
      characterId: presenterB.id, creativeConfigRevision: 6 }).where(eq(schema.projects.id, projectId)).run();
    const projectBefore = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
    const rowsBefore = db.select().from(schema.scripts).orderBy(schema.scripts.id).all();

    for (const target of [alternative, source, alternative]) {
      const response = await select(target.id);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, script: { id: target.id, selected: true,
        scriptHash: scriptRevision(target), creativeProfileSnapshot: target.creativeProfileSnapshot } });
      expect(db.select().from(schema.scripts).orderBy(schema.scripts.id).all())
        .toEqual(rowsBefore.map(row => ({ ...row, selected: row.id === target.id })));
      expect(db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()).toEqual(projectBefore);
    }

    const edited = await edit(req(`/api/project/${projectId}/scripts`, { scriptId: alternative.id,
      expectedScriptHash: scriptRevision(alternative), expectedCreativeConfigRevision: 6,
      shotTexts: [{ shotId: 1, description: alternative.shots![0].description }] }, "PATCH"), params());
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ success: true, script: { id: alternative.id } });
    const restored = await edit(req(`/api/project/${projectId}/scripts`, { restoreScriptId: source.id }, "PATCH"), params());
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ success: true, selectedScriptId: source.id });
    expect(db.select().from(schema.scripts).orderBy(schema.scripts.id).all())
      .toEqual(rowsBefore.map(row => ({ ...row, selected: row.id === source.id })));
    expect(db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()).toEqual(projectBefore);
  });

  it("selects the same-project historical alternative regardless of batch or configuration counter", async () => {
    const source = seedScript();
    db.insert(schema.scripts).values({ ...source, id: "historical", version: 0, selected: false }).run();
    db.update(schema.projects).set({ creativeConfigRevision: 2 }).where(eq(schema.projects.id, projectId)).run();
    const before = db.select().from(schema.scripts).all();
    const response = await select("historical");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, script: { id: "historical", selected: true } });
    expect(db.select().from(schema.scripts).all()).toEqual(before.map(row => ({ ...row, selected: row.id === "historical" })));
  });

  it.each(["legacy", "current", "different-revision", "different-profile"])("selects a saved alternative independently of its %s sibling configuration", async context => {
    const source = seedScript("source-script", presenterA);
    db.insert(schema.scripts).values({ ...source, id: "alternative", selected: false }).run();
    const activeProfile = createTideweOutdoorProfile({ presenter: context === "different-profile" ? presenterB : presenterA });
    db.update(schema.scripts).set({
      ...(context === "different-profile" && generated(copyText, presenterB)),
      creativeProfileSnapshot: context === "legacy" ? null : createCreativeProfileSnapshot(activeProfile,
        context === "current" ? 6 : context === "different-revision" ? 2 : 1),
    }).where(eq(schema.scripts.id, source.id)).run();
    db.update(schema.projects).set({ creativeConfigRevision: 6 }).where(eq(schema.projects.id, projectId)).run();
    const before = db.select().from(schema.scripts).all();
    const response = await select("alternative");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, script: { id: "alternative", selected: true } });
    expect(db.select().from(schema.scripts).all()).toEqual(before.map(row => ({ ...row, selected: row.id === "alternative" })));
  });

  it("rejects another project's script while allowing its own unselected saved option", async () => {
    const source = seedScript();
    db.update(schema.scripts).set({ selected: false }).where(eq(schema.scripts.id, source.id)).run();
    db.insert(schema.projects).values({ id: "other-project", name: "Other project" }).run();
    db.insert(schema.scripts).values({ ...source, id: "foreign-selection", projectId: "other-project" }).run();
    db.update(schema.projects).set({ creativeConfigRevision: 2 }).where(eq(schema.projects.id, projectId)).run();
    const before = db.select().from(schema.scripts).all();
    const foreign = await select("foreign-selection");
    expect(foreign.status).toBe(404);
    expect(db.select().from(schema.scripts).all()).toEqual(before);
    const response = await select(source.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, script: { id: source.id, selected: true } });
    expect(db.select().from(schema.scripts).all()).toEqual(before.map(row => ({ ...row, selected: true })));
  });

  it("rejects another creative type even when it has the active batch version", async () => {
    const source = seedScript();
    db.insert(schema.scripts).values({ ...source, id: "other-type", selected: false, styleType: "scene",
      creativeProfileSnapshot: createCreativeProfileSnapshot(createShortVideoSalesProfile(), 1) }).run();
    db.update(schema.projects).set({ creativeConfigRevision: 2 }).where(eq(schema.projects.id, projectId)).run();
    const before = db.select().from(schema.scripts).all();
    const response = await select("other-type");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CREATIVE_PROFILE_MISMATCH" });
    expect(db.select().from(schema.scripts).all()).toEqual(before);
  });

  it("still validates a stale current-batch alternative against its frozen presenter", async () => {
    const source = seedScript("source-script", presenterA);
    db.insert(schema.scripts).values({ ...source, ...generated(copyText, presenterB), id: "corrupt-alternative", selected: false }).run();
    db.update(schema.projects).set({ creativeConfigRevision: 2 }).where(eq(schema.projects.id, projectId)).run();
    const before = db.select().from(schema.scripts).all();
    const response = await select("corrupt-alternative");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "TIDEWE_VALIDATION_FAILED" });
    expect(db.select().from(schema.scripts).all()).toEqual(before);
  });
});

describe("TIDEWE editing and import", () => {
  it("clears a stale structured action after a manual composition edit while preserving the exact copy", async () => {
    const source = seedScript();
    const visualPlan = { framing: "medium" as const, visualRole: "presenter" as const, actionStart: "手已靠近装备边缘", action: "点向装备一次", actionEnd: "手掌自然停稳" };
    const shots = source.shots!.map(shot => ({ ...shot, tidewe: { ...shot.tidewe!, visualPlan } }));
    db.update(schema.scripts).set({ shots }).where(eq(schema.scripts.id, source.id)).run();
    const unchanged = await edit(req(`/api/project/${projectId}/scripts`, { scriptId: source.id, shotTexts: [{ shotId: 1, camera: shots[0].camera }] }, "PATCH"), params());
    expect(unchanged.status).toBe(200);
    expect(db.select().from(schema.scripts).get()!.shots![0].tidewe!.visualPlan).toEqual(visualPlan);
    const changed = await edit(req(`/api/project/${projectId}/scripts`, { scriptId: source.id, shotTexts: [{ shotId: 1, description: "林间人物在椅旁查看地面接触位置。" }] }, "PATCH"), params());
    expect(changed.status).toBe(200);
    const saved = db.select().from(schema.scripts).get()!;
    expect(saved.shots![0].tidewe!.visualPlan).toBeUndefined();
    expect(saved.copyDocument).toEqual(source.copyDocument);
    expect(saved.shots![0].voiceover).toBe(source.shots![0].voiceover);
  });
  it("preserves the presenter, copy and same-script media when editing the camera", async () => {
    db.update(schema.projects).set({ creativeProfile: createTideweOutdoorProfile({ presenter: presenterA }), characterId: presenterA.id }).run();
    const source = seedScript("source-script", presenterA);
    const previousAsset = { shotId: 1, ...assetScopeForShot(source, source.shots![0]) };
    const response = await edit(req(`/api/project/${projectId}/scripts`, { scriptId: source.id,
      shotTexts: [{ shotId: 1, camera: "缓慢前推镜头" }] }, "PATCH"), params());
    expect(response.status).toBe(200);
    const updated = db.select().from(schema.scripts).where(eq(schema.scripts.id, source.id)).get()!;
    expect(updated.shots![0].tidewe?.presenter).toEqual(presenterA);
    expect(updated.copyDocument).toEqual(source.copyDocument);
    expect(assetMatchesScript(previousAsset, source)).toBe(true);
    expect(assetMatchesScript(previousAsset, updated)).toBe(true);
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
    expect(rows.find(row => row.selected)?.shots).toHaveLength(8);
  });
  it("blocks the legacy per-shot voiceover edit channel", async () => {
    const source = seedScript();
    const response = await edit(req(`/api/project/${projectId}/scripts`, { scriptId: source.id, shotTexts: [{ shotId: 1, voiceover: "Buy now" }] }, "PATCH"), params());
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("TIDEWE_COPY_DOCUMENT_REQUIRED");
    expect(db.select().from(schema.scripts).get()?.copyDocument?.text).toBe(copyText);
  });
  it("edits visuals without a content hash or configuration counter and keeps copy unchanged", async () => {
    const source = seedScript();
    const body = { scriptId: source.id, shotTexts: [{ shotId: 1, camera: "缓慢前移" }] };
    const response = await edit(req(`/api/project/${projectId}/scripts`, body, "PATCH"), params());
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
    expect(db.select().from(schema.scripts).get()?.shots).toHaveLength(8);
  });

  it("persists staff prose with original paragraphs and punctuation through the import entry point", async () => {
    const text = "I’ve worn this for 3 seasons.\r\n\r\nWait.  Wait. Buy now if it fits.";
    const result = generated(text);
    result.copyDocument.source = "user_provided";
    calls.generate.mockResolvedValueOnce([result]);
    const response = await importCopy(req(`/api/project/${projectId}/import-script`, { script: `  ${text}\r\n`, requestId: "staff-copy-import", llmConfig }), params());
    expect(response.status).toBe(200);
    expect(calls.generate).toHaveBeenCalledWith(expect.objectContaining({ copyText: text, count: 1 }));
    const saved = db.select().from(schema.scripts).get()!;
    expect(saved.copyDocument).toMatchObject({ text, source: "user_provided", factsSnapshot: facts });
    expect(saved.shots?.[0].voiceover).toBe(text);
    expect(saved.shots).toHaveLength(8);
    expect(saved.selected).toBe(true);
  });

  it.each(["全中文口播", "English copy with 中文译文", "12345", "a".repeat(12001)])("rejects invalid custom English copy before vision or script calls: %s", async copyText => {
    const response = await generate(req("/api/llm/script", { ...generationBody("bad-custom-copy"), copyText }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "TIDEWE_IMPORTED_COPY_INVALID", requestId: "bad-custom-copy" });
    expect(calls.observe).not.toHaveBeenCalled();
    expect(calls.generate).not.toHaveBeenCalled();
    expect(db.select().from(schema.scripts).all()).toEqual([]);
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
    expect(report.sourceScriptHash).toBe(scriptRevision(source));
    expect(calls.complete.mock.calls[0][1].messages[0].content).toContain("speechDelivery=off_camera");
    expect(calls.complete.mock.calls[0][1].messages[0].content).toContain(copyText);
  });

  it("reviews all storyboard seconds including silent shots against the frozen duration target", async () => {
    const source = seedScript();
    const spoken = source.shots![0];
    const silent = (shotId: number, duration: number, offset: number): schema.Shot => ({
      ...spoken, shotId, duration, voiceover: "", description: "林间湿草上的露水近景。",
      tidewe: { ...spoken.tidewe!, copySpan: { start: offset, end: offset }, speechDelivery: "off_camera", personVisible: false, productVisible: false,
        visualPlan: { framing: "close_up", visualRole: "context", actionStart: "湿草露水已经入画", action: "固定观察自然环境", actionEnd: "构图保持稳定" } },
    });
    const updated = db.update(schema.scripts).set({
      shots: [silent(1, 3.5, 0), { ...spoken, shotId: 2 }, silent(3, 2.5, copyText.length)],
      totalDuration: 99,
      creativeProfileSnapshot: createCreativeProfileSnapshot(createTideweOutdoorProfile({ targetDuration: 40 }), 1),
    }).where(eq(schema.scripts.id, source.id)).returning().get()!;
    db.update(schema.projects).set({ creativeProfile: createTideweOutdoorProfile({ targetDuration: 60 }) }).where(eq(schema.projects.id, projectId)).run();

    const response = await judge(req(`/api/project/${projectId}/script-judge`, { scriptId: source.id, llmConfig }), params());
    expect(response.status).toBe(200);
    expect((await response.json()).sourceScriptHash).toBe(scriptRevision(updated));
    const prompt = calls.complete.mock.calls[0][1].messages[0].content;
    expect(prompt).toContain('"actualTotalDuration":16,"plannedTotalDuration":40');
    expect(prompt).toContain('"shotId":2,"start":3.5,"end":13.5,"duration":10');
    expect(prompt).toContain('"shotId":3,"start":13.5,"end":16,"duration":2.5,"hasNarration":false');
    expect(prompt).toContain("林间湿草上的露水近景。");
    const reviewShots = JSON.parse(prompt.split("\n").find((line: string) => line.startsWith("SHOTS: ")).slice("SHOTS: ".length));
    expect(reviewShots.map((shot: { shotId: number }) => shot.shotId)).toEqual([1, 2, 3]);
    expect(reviewShots[0]).toMatchObject({ voiceover: "", tidewe: { speechDelivery: "off_camera", personVisible: false, visualPlan: { visualRole: "context", action: "固定观察自然环境" } } });
  });
});
