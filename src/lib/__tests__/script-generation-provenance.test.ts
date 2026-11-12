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
import { createCreativeProfileSnapshot, resolveCreativeProfile } from "@/lib/creative-profiles";
import { PATCH as updateScripts } from "@/app/api/project/[id]/scripts/route";
import { POST as dubScript } from "@/app/api/project/[id]/dub/route";
import { POST as importScript } from "@/app/api/project/[id]/import-script/route";

const generation = vi.hoisted(() => ({ commerce: vi.fn(), topic: vi.fn(), analysis: vi.fn(), translate: vi.fn(), translateVoiceovers: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => db }));
vi.mock("@/lib/script-engine/generator", () => ({
  generateScript: generation.commerce,
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







  it("selects a same-project same-type alternative without changing its frozen configuration", async () => {
    const profile = resolveCreativeProfile(null);
    db.update(schema.projects)
      .set({ creativeProfile: profile, creativeConfigRevision: 2 })
      .where(eq(schema.projects.id, projectId))
      .run();
    db.insert(schema.scripts).values({
      id: "stale-cg-script",
      projectId,
      styleType: "pain_point",
      shots: [{ ...shot, voiceover: "" }],
      creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1),
    }).run();

    const response = await updateScripts(
      request(`/api/project/${projectId}/scripts`, { selectedScriptId: "stale-cg-script" }),
      { params: Promise.resolve({ id: projectId }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, script: { id: "stale-cg-script", selected: true } });
    expect(db.select().from(schema.scripts).where(eq(schema.scripts.id, "stale-cg-script")).get())
      .toMatchObject({ selected: true, creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1) });
    expect(db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()?.creativeConfigRevision).toBe(2);
  });



  it("records the translation model on the new version while retaining the source history", async () => {
    db.insert(schema.scripts).values({ id: "source", projectId, styleType: "scene", selected: true, shots: [shot] }).run();
    const response = await dubScript(request(`/api/project/${projectId}/dub`, { targetLang: "en", llmConfig }), { params: Promise.resolve({ id: projectId }) });
    expect(response.status).toBe(200);
    const translated = expectMetadata("translation");
    expect(translated.shots?.[0].description).toBe(shot.description);
    expect(translated.styleType).toBe("scene");
    expect(translated.creativeProfileSnapshot).toMatchObject({
      profile: { creationType: "unsupported" },
      creativeConfigRevision: 0,
    });
    expect(db.select().from(schema.scripts).where(eq(schema.scripts.id, "source")).get()?.generationMetadata).toBeNull();
  });

  it("leaves manual imports without an invented model identity", async () => {
    const response = await importScript(request(`/api/project/${projectId}/import-script`, { script: "This is user written copy." }), { params: Promise.resolve({ id: projectId }) });
    expect(response.status).toBe(200);
    const row = db.select().from(schema.scripts).get()!;
    expect(row.generationMetadata).toBeNull();
    expect(row.creativeProfileSnapshot).toMatchObject({ profile: { creationType: "unsupported" } });
  });
});
