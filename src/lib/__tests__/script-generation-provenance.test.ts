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
import { POST as commerceScript } from "@/app/api/llm/script/route";
import { POST as topicScript } from "@/app/api/topic/script/route";
import { POST as dubScript } from "@/app/api/project/[id]/dub/route";
import { POST as importScript } from "@/app/api/project/[id]/import-script/route";

const generation = vi.hoisted(() => ({ commerce: vi.fn(), topic: vi.fn(), translate: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => db }));
vi.mock("@/lib/script-engine/generator", () => ({
  generateScript: generation.commerce,
  generateTopicScript: generation.topic,
  analyzeProduct: vi.fn(),
}));
vi.mock("@/lib/script-engine/translate", () => ({
  translateShots: generation.translate,
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

  it("persists commerce model provenance alongside the complete original shot", async () => {
    const response = await commerceScript(request("/api/llm/script", {
      projectId, productName: "Portable blender", productAnalysis: "Already analyzed", insightMode: false, llmConfig,
    }));
    expect(response.status).toBe(200);
    const row = expectMetadata("commerce-script");
    expect(row.shots).toEqual([shot]);
    expect((await response.json()).scripts[0].generationMetadata).toEqual(row.generationMetadata);
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
    expect(expectMetadata("translation").shots?.[0].description).toBe(shot.description);
    expect(db.select().from(schema.scripts).where(eq(schema.scripts.id, "source")).get()?.generationMetadata).toBeNull();
  });

  it("leaves manual imports without an invented model identity", async () => {
    const response = await importScript(request(`/api/project/${projectId}/import-script`, { script: "This is user written copy." }), { params: Promise.resolve({ id: projectId }) });
    expect(response.status).toBe(200);
    const row = db.select().from(schema.scripts).get()!;
    expect(row.generationMetadata).toBeNull();
  });
});
