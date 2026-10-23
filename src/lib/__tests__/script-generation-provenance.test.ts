// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { scriptGenerationMetadata } from "@/lib/script-engine/provenance";
import { createCreativeProfileSnapshot, createPremiumProductCgProfile } from "@/lib/creative-profiles";
import { POST as commerceScript } from "@/app/api/llm/script/route";
import { PATCH as updateScripts } from "@/app/api/project/[id]/scripts/route";
import { POST as topicScript } from "@/app/api/topic/script/route";
import { POST as dubScript } from "@/app/api/project/[id]/dub/route";
import { POST as importScript } from "@/app/api/project/[id]/import-script/route";

const generation = vi.hoisted(() => ({ commerce: vi.fn(), topic: vi.fn(), translate: vi.fn(), translateVoiceovers: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => db }));
vi.mock("@/lib/script-engine/generator", () => ({
  generateScript: generation.commerce,
  generateTopicScript: generation.topic,
  analyzeProduct: vi.fn(),
}));
vi.mock("@/lib/script-engine/translate", () => ({
  translateShots: generation.translate,
  translateVoiceovers: generation.translateVoiceovers,
  defaultVoiceForLang: () => "test-voice",
  langName: () => "English",
}));

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const projectId = "script-provenance";
const llmConfig = {
  provider: "Atlas",
  model: "deepseek-ai/deepseek-v4-pro",
  baseUrl: "https://private-endpoint.invalid/v1?token=endpoint-secret",
  apiKey: "private-test-api-key",
};
const shot: schema.Shot = {
  shotId: 1, type: "cta", duration: 5,
  description: "完整商品原图静止居中，背景为纯净浅蓝色。商品下方固定显示“点击下方小黄车”；底部小字为“价格、使用及清洗要求以商品页和说明书为准”。",
  camera: "固定镜头。", voiceover: "", visualSource: "product_image", transition: "direct_concat",
};
const generated = { title: "Original script", styleType: "scene", totalDuration: 5, shots: [shot] };

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  db.insert(schema.projects).values({ id: projectId, name: "Script provenance" }).run();
  generation.commerce.mockResolvedValue([generated]);
  generation.topic.mockResolvedValue([generated]);
  generation.translate.mockResolvedValue([{ ...shot, voiceover: "Translated copy" }]);
  generation.translateVoiceovers.mockResolvedValue(["Translated copy"]);
});

afterEach(() => {
  sqlite.close();
  vi.clearAllMocks();
});

function request(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) });
}

function expectMetadata(operation: "commerce-script" | "topic-script" | "translation") {
  const row = db.select().from(schema.scripts).where(eq(schema.scripts.selected, true)).get()!;
  expect(row.generationMetadata).toEqual({
    version: 1, operation, provider: llmConfig.provider, model: llmConfig.model,
    generatedAt: expect.any(String),
  });
  expect(new Date(row.generationMetadata!.generatedAt).toISOString()).toBe(row.generationMetadata!.generatedAt);
  expect(JSON.stringify(row)).not.toContain(llmConfig.apiKey);
  expect(JSON.stringify(row)).not.toContain(llmConfig.baseUrl);
  expect(row.generationMetadata).not.toHaveProperty("baseUrl");
  expect(row.generationMetadata).not.toHaveProperty("apiKey");
  return row;
}

describe("script generation provenance", () => {
  it.each(["user_upload", "auto", null])("rejects an unsupported explicit visual source %s before generating", async (visualSource) => {
    const response = await commerceScript(request("/api/llm/script", {
      projectId, visualSource, productName: "Reference chair", llmConfig,
    }));
    expect(response.status).toBe(400);
    expect(generation.commerce).not.toHaveBeenCalled();
    expect(db.select().from(schema.scripts).all()).toHaveLength(0);
  });

  it.each(["product_image", "ai_generate"])("uses the saved %s source over a conflicting generation request", async (visualSource) => {
    db.update(schema.projects)
      .set({ creativeProfile: createPremiumProductCgProfile({ visualSource }) })
      .where(eq(schema.projects.id, projectId)).run();
    const response = await commerceScript(request("/api/llm/script", {
      projectId, productName: "Reference chair", productAnalysis: "Verified details", insightMode: false,
      creativeProfile: createPremiumProductCgProfile({ visualSource: visualSource === "product_image" ? "ai_generate" : "product_image" }),
      llmConfig,
    }));
    expect(response.status).toBe(200);
    expect(generation.commerce).toHaveBeenCalledWith(expect.objectContaining({
      creativeProfile: expect.objectContaining({ visualSource }),
    }));
    expect(db.select().from(schema.scripts).get()?.creativeProfileSnapshot?.profile.visualSource).toBe(visualSource);
  });

  it("whitelists non-secret identifiers and labels endpoints without a provider", () => {
    expect(scriptGenerationMetadata({ ...llmConfig, provider: undefined }, "commerce-script", new Date("2026-10-21T00:00:00.000Z")))
      .toEqual({
        version: 1, operation: "commerce-script", provider: "openai-compatible",
        model: llmConfig.model, generatedAt: "2026-10-21T00:00:00.000Z",
      });
  });

  it("upgrades existing script rows without changing shots or inventing a historical model", () => {
    const legacy = new Database(":memory:");
    try {
      legacy.exec("CREATE TABLE scripts (id TEXT PRIMARY KEY, shots TEXT)");
      legacy.prepare("INSERT INTO scripts (id, shots) VALUES (?, ?)").run("legacy", JSON.stringify([shot]));
      legacy.exec(readFileSync(join(process.cwd(), "drizzle/0022_add_script_generation_metadata.sql"), "utf8"));
      expect(legacy.prepare("SELECT * FROM scripts").get()).toEqual({ id: "legacy", shots: JSON.stringify([shot]), generation_metadata: null });
    } finally {
      legacy.close();
    }
  });

  it("persists commerce model provenance alongside the complete original shot", async () => {
    const response = await commerceScript(request("/api/llm/script", {
      projectId, productName: "Portable blender", productAnalysis: "Already analyzed", insightMode: false, llmConfig,
    }));
    expect(response.status).toBe(200);
    const row = expectMetadata("commerce-script");
    expect(row.shots).toEqual([shot]);
    expect((await response.json()).scripts[0].generationMetadata).toEqual(row.generationMetadata);
  });

  it("appends a new immutable script revision when commerce scripts are regenerated", async () => {
    const first = await commerceScript(request("/api/llm/script", {
      projectId, productName: "Portable blender", productAnalysis: "Already analyzed", insightMode: false, llmConfig,
    }));
    expect(first.status).toBe(200);
    const original = db.select().from(schema.scripts).where(eq(schema.scripts.selected, true)).get()!;

    generation.commerce.mockResolvedValueOnce([{ ...generated, title: "Regenerated script" }]);
    const second = await commerceScript(request("/api/llm/script", {
      projectId, productName: "Portable blender", productAnalysis: "Already analyzed", insightMode: false, llmConfig,
    }));
    expect(second.status).toBe(200);

    const rows = db.select().from(schema.scripts).where(eq(schema.scripts.projectId, projectId)).all();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.version).sort()).toEqual([1, 2]);
    expect(rows.find((row) => row.id === original.id)).toMatchObject({ selected: false, title: "Original script" });
    expect(rows.find((row) => row.selected)).toMatchObject({ version: 2, title: "Regenerated script" });
    expect(rows.find((row) => row.id === original.id)?.creativeProfileSnapshot)
      .toEqual(original.creativeProfileSnapshot);
  });

  it("archives a late script result without selecting it after the creative profile changes", async () => {
    db.insert(schema.scripts).values({
      id: "previous-selection",
      projectId,
      styleType: "scene",
      selected: true,
      shots: [shot],
    }).run();
    generation.commerce.mockImplementationOnce(async () => {
      db.update(schema.projects)
        .set({ creativeProfile: createPremiumProductCgProfile({ narrationMode: "none" }), creativeConfigRevision: 1 })
        .where(eq(schema.projects.id, projectId))
        .run();
      return [generated];
    });

    const response = await commerceScript(request("/api/llm/script", {
      projectId, productName: "Portable blender", productAnalysis: "Already analyzed", insightMode: false, llmConfig,
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CREATIVE_CONFIG_STALE" });
    const rows = db.select().from(schema.scripts).where(eq(schema.scripts.projectId, projectId)).all();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === "previous-selection")?.selected).toBe(true);
    expect(rows.find((row) => row.id !== "previous-selection")).toMatchObject({
      selected: false,
      creativeProfileSnapshot: { creativeConfigRevision: 0 },
    });
  });

  it("uses the persisted premium profile as authority over conflicting request fields", async () => {
    db.update(schema.projects)
      .set({ creativeProfile: createPremiumProductCgProfile({ narrationMode: "none" }) })
      .where(eq(schema.projects.id, projectId))
      .run();

    const response = await commerceScript(request("/api/llm/script", {
      projectId,
      productName: "Walnut lounge chair",
      productAnalysis: "Verified product notes",
      styleType: "pain_point",
      videoMode: "graphic_montage",
      narrationMode: "restrained",
      insightMode: false,
      llmConfig,
    }));

    expect(response.status).toBe(200);
    expect(generation.commerce).toHaveBeenCalledWith(expect.objectContaining({
      styleType: "premium_product_cg",
      videoMode: "product_closeup",
      narrationMode: "none",
      creativeProfile: expect.objectContaining({
        creationType: "premium_product_cg",
        textPolicy: expect.objectContaining({ captions: false, cta: "none" }),
      }),
    }));
  });

  it.each(["other", "automotive"])("preserves the CG %s category beyond legacy sales categories", async (productCategory) => {
    db.update(schema.projects)
      .set({
        creativeProfile: createPremiumProductCgProfile(),
        productName: "Premium mechanical watch",
        productCategory,
      })
      .where(eq(schema.projects.id, projectId))
      .run();

    const response = await commerceScript(request("/api/llm/script", {
      projectId,
      category: "beauty",
      productAnalysis: "Visible product reference observations",
      insightMode: false,
      llmConfig,
    }));

    expect(response.status).toBe(200);
    expect(generation.commerce).toHaveBeenCalledWith(expect.objectContaining({
      productName: "Premium mechanical watch",
      productCategoryHint: productCategory,
      styleType: "premium_product_cg",
    }));
  });

  it("does not select a legacy sales script after switching the project to premium CG", async () => {
    db.update(schema.projects)
      .set({ creativeProfile: createPremiumProductCgProfile({ narrationMode: "none" }) })
      .where(eq(schema.projects.id, projectId))
      .run();
    db.insert(schema.scripts).values({
      id: "legacy-sales-script",
      projectId,
      styleType: "scene",
      selected: true,
      shots: [shot],
    }).run();

    const response = await updateScripts(
      request(`/api/project/${projectId}/scripts`, { selectedScriptId: "legacy-sales-script" }),
      { params: Promise.resolve({ id: projectId }) },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "CREATIVE_PROFILE_MISMATCH",
      currentCreationType: "premium_product_cg",
      scriptCreationType: "short_video_sales",
    });
  });

  it("does not select a same-type script whose creative configuration revision is stale", async () => {
    const profile = createPremiumProductCgProfile({ narrationMode: "none" });
    db.update(schema.projects)
      .set({ creativeProfile: profile, creativeConfigRevision: 2 })
      .where(eq(schema.projects.id, projectId))
      .run();
    db.insert(schema.scripts).values({
      id: "stale-cg-script",
      projectId,
      styleType: "premium_product_cg",
      shots: [{ ...shot, voiceover: "" }],
      creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1),
    }).run();

    const response = await updateScripts(
      request(`/api/project/${projectId}/scripts`, { selectedScriptId: "stale-cg-script" }),
      { params: Promise.resolve({ id: projectId }) },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "CREATIVE_CONFIG_STALE",
      currentCreationType: "premium_product_cg",
      scriptCreationType: "premium_product_cg",
      projectRevision: 2,
      scriptRevision: 1,
    });
  });

  it("persists topic model provenance with the original shots", async () => {
    db.update(schema.projects).set({ contentType: "topic" }).where(eq(schema.projects.id, projectId)).run();
    const response = await topicScript(request("/api/topic/script", { projectId, topic: "A short topic", llmConfig }));
    expect(response.status).toBe(200);
    const row = expectMetadata("topic-script");
    expect(row.shots).toEqual([shot]);
    expect((await response.json()).scripts[0].generationMetadata).toEqual(row.generationMetadata);
  });

  it("records the translation model on the new version while retaining the source history", async () => {
    db.insert(schema.scripts).values({ id: "source", projectId, styleType: "scene", selected: true, shots: [shot] }).run();
    const response = await dubScript(request(`/api/project/${projectId}/dub`, { targetLang: "en", llmConfig }), { params: Promise.resolve({ id: projectId }) });
    expect(response.status).toBe(200);
    const translated = expectMetadata("translation");
    expect(translated.shots?.[0].description).toBe(shot.description);
    expect(translated.styleType).toBe("scene");
    expect(translated.creativeProfileSnapshot).toMatchObject({
      profile: { creationType: "short_video_sales" },
      creativeConfigRevision: 0,
    });
    expect(db.select().from(schema.scripts).where(eq(schema.scripts.id, "source")).get()?.generationMetadata).toBeNull();
  });

  it("rejects dubbing for visual-only premium product CG before calling the translator", async () => {
    const profile = createPremiumProductCgProfile({ narrationMode: "none" });
    db.update(schema.projects).set({ creativeProfile: profile }).where(eq(schema.projects.id, projectId)).run();
    db.insert(schema.scripts).values({
      id: "silent-cg-source",
      projectId,
      styleType: "premium_product_cg",
      selected: true,
      shots: [{ ...shot, voiceover: "" }],
      creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 0),
    }).run();

    const response = await dubScript(
      request(`/api/project/${projectId}/dub`, { targetLang: "en", llmConfig }),
      { params: Promise.resolve({ id: projectId }) },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CG_NARRATION_DISABLED" });
    expect(generation.translate).not.toHaveBeenCalled();
    expect(generation.translateVoiceovers).not.toHaveBeenCalled();
  });

  it("keeps restrained CG visual timing and the source snapshot during dubbing", async () => {
    const profile = createPremiumProductCgProfile({ narrationMode: "restrained" });
    const cgShot: schema.Shot = {
      shotId: 1,
      type: "product_reveal",
      duration: 7,
      description: "A walnut lounge chair in a quiet studio.",
      camera: "A slow, level dolly toward the chair.",
      visualSource: "product_image",
      transition: "direct_concat",
      voiceover: "A calm observation of material and form.",
      narration: "A calm observation of material and form.",
    };
    const snapshot = createCreativeProfileSnapshot(profile, 3);
    db.update(schema.projects)
      .set({ creativeProfile: profile, creativeConfigRevision: 3 })
      .where(eq(schema.projects.id, projectId))
      .run();
    db.insert(schema.scripts).values({
      id: "restrained-cg-source",
      projectId,
      styleType: "premium_product_cg",
      selected: true,
      shots: [cgShot],
      creativeProfileSnapshot: snapshot,
    }).run();
    generation.translateVoiceovers.mockResolvedValueOnce(["A translated factual observation."]);

    const response = await dubScript(
      request(`/api/project/${projectId}/dub`, { targetLang: "en", llmConfig }),
      { params: Promise.resolve({ id: projectId }) },
    );
    expect(response.status).toBe(200);
    const translated = db.select().from(schema.scripts).where(eq(schema.scripts.selected, true)).get()!;
    expect(translated.styleType).toBe("premium_product_cg");
    expect(translated.creativeProfileSnapshot).toEqual(snapshot);
    expect(translated.shots).toMatchObject([{
      duration: 7,
      voiceover: "A translated factual observation.",
      narration: "A translated factual observation.",
    }]);
    expect(generation.translate).not.toHaveBeenCalled();
  });

  it("leaves manual imports without an invented model identity", async () => {
    const response = await importScript(request(`/api/project/${projectId}/import-script`, { script: "This is user written copy." }), { params: Promise.resolve({ id: projectId }) });
    expect(response.status).toBe(200);
    const row = db.select().from(schema.scripts).get()!;
    expect(row.generationMetadata).toBeNull();
    expect(row.creativeProfileSnapshot).toMatchObject({ profile: { creationType: "short_video_sales" } });
  });

  it("rejects the generic narration importer for premium product CG", async () => {
    const profile = createPremiumProductCgProfile({ narrationMode: "restrained" });
    db.update(schema.projects).set({ creativeProfile: profile }).where(eq(schema.projects.id, projectId)).run();

    const response = await importScript(
      request(`/api/project/${projectId}/import-script`, { script: "This user-written sales copy should not become a CG scene." }),
      { params: Promise.resolve({ id: projectId }) },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CG_STRUCTURED_IMPORT_REQUIRED" });
    expect(db.select().from(schema.scripts).where(eq(schema.scripts.projectId, projectId)).all()).toEqual([]);
  });
});
