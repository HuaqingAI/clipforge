// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { createCreativeProfileSnapshot, createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { englishWordCount, productFactsHash } from "@/lib/tidewe/validation";
import type { ProductFacts, TideweCopyDocument } from "@/lib/tidewe/types";

const state = vi.hoisted(() => ({ db: null as unknown, generate: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/server/compose-headline", async original => ({
  ...await original<typeof import("@/lib/server/compose-headline")>(), generateComposeHeadline: state.generate,
}));
import { POST } from "@/app/api/project/[id]/compose-headline/route";

const sqlite = new Database(":memory:");
const db = drizzle(sqlite, { schema });
const llmConfig = { baseUrl: "https://text.invalid/v1", apiKey: "private-fixture-key", model: "text-model" };
const shots: schema.Shot[] = [
  { shotId: 1, type: "hook", duration: 3, description: "Opening", camera: "static", visualSource: "ai_generate", transition: "direct_concat", voiceover: "First spoken line." },
  { shotId: 2, type: "demo", duration: 3, description: "Ending", camera: "static", visualSource: "ai_generate", transition: "direct_concat", voiceover: "The ending adds [pause] the complete benefit." },
];

beforeAll(() => { state.db = db; migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") }); });
beforeEach(() => {
  db.delete(schema.scripts).run();
  db.delete(schema.projects).run();
  db.insert(schema.projects).values({ id: "project", name: "Project", productName: "Product" }).run();
  db.insert(schema.projects).values({ id: "other-project", name: "Other project" }).run();
  db.insert(schema.scripts).values({ id: "current", projectId: "project", styleType: "scene", selected: true, shots }).run();
  db.insert(schema.scripts).values({ id: "old", projectId: "project", styleType: "scene", selected: false, shots }).run();
  db.insert(schema.scripts).values({ id: "foreign", projectId: "other-project", styleType: "scene", selected: true, shots }).run();
  state.generate.mockReset().mockResolvedValue("Complete Video Benefit Title");
});
afterAll(() => sqlite.close());

function request(body: unknown = { scriptId: "current", llmConfig }, id = "project") {
  return POST(new NextRequest(`http://localhost/api/project/${id}/compose-headline`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  }), { params: Promise.resolve({ id }) });
}

describe("manual top title generation endpoint", () => {
  it("reads all saved narration and ignores arbitrary client copy without modifying the script", async () => {
    const before = db.select().from(schema.scripts).all();
    const result = await request({ scriptId: "current", llmConfig, copy: "Client supplied unrelated copy" });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ title: "Complete Video Benefit Title" });
    expect(state.generate).toHaveBeenCalledExactlyOnceWith({
      copy: "First spoken line. The ending adds the complete benefit.", productName: "Product",
    }, llmConfig);
    expect(db.select().from(schema.scripts).all()).toEqual(before);
  });

  it("includes a requested hook variation while preserving the rest of the narration", async () => {
    const result = await request({ scriptId: "current", llmConfig,
      voiceoverOverrides: [{ shotId: 1, voiceover: "Alternative opening." }] });
    expect(result.status).toBe(200);
    expect(state.generate.mock.calls[0][0].copy).toBe("Alternative opening. The ending adds the complete benefit.");
  });

  it.each([
    { voiceoverOverrides: "invalid" },
    { voiceoverOverrides: [{ shotId: 8, voiceover: "Unknown shot" }] },
    { voiceoverOverrides: [{ shotId: 1, voiceover: 42 }] },
    { voiceoverOverrides: [{ shotId: 1, voiceover: "First" }, { shotId: 1, voiceover: "Duplicate" }] },
  ])("rejects invalid hook data before calling the model: %j", async invalid => {
    expect((await request({ scriptId: "current", llmConfig, ...invalid })).status).toBe(400);
    expect(state.generate).not.toHaveBeenCalled();
  });

  it.each([{}, { scriptId: "current" }, { scriptId: "current", llmConfig: { model: 42 } }, null, []])("requires a valid explicit generation request and model configuration: %j", async body => {
    expect((await request(body)).status).toBe(400);
    expect(state.generate).not.toHaveBeenCalled();
  });

  it("rejects missing projects, scripts owned by another project and stale script selections", async () => {
    expect((await request({ scriptId: "current", llmConfig }, "missing")).status).toBe(404);
    expect((await request({ scriptId: "foreign", llmConfig })).status).toBe(404);
    expect((await request({ scriptId: "old", llmConfig })).status).toBe(409);
    expect(state.generate).not.toHaveBeenCalled();
  });

  it("returns a generation failure without changing the script or creating a composition", async () => {
    state.generate.mockRejectedValue(new Error("视频标题生成失败，请检查文字模型连接和设置后重试。"));
    const result = await request();
    expect(result.status).toBe(500);
    const json = await result.json();
    expect(json.error).toContain("标题生成失败");
    expect(JSON.stringify(json)).not.toContain(llmConfig.apiKey);
    expect(db.select().from(schema.compositions).all()).toEqual([]);
    expect(db.select().from(schema.scripts).where(eq(schema.scripts.id, "current")).get()!.shots).toEqual(shots);
  });

  it("rejects an archived project carrying a TIDEWE snapshot before generating a title", async () => {
    db.update(schema.projects).set({ creativeProfile: {
      version: 1, id: "unsupported", creationType: "unsupported", styleType: "scene",
      videoMode: "product_closeup", targetDuration: 30, composeSnapshot: {},
    } }).where(eq(schema.projects.id, "project")).run();
    db.update(schema.scripts).set({ creativeProfileSnapshot: createCreativeProfileSnapshot(createTideweOutdoorProfile(), 1) })
      .where(eq(schema.scripts.id, "current")).run();
    const response = await request();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CREATIVE_PROFILE_MISMATCH" });
    expect(state.generate).not.toHaveBeenCalled();
  });

  it("uses canonical TIDEWE copy and refuses temporary overrides or broken copy spans", async () => {
    const profile = createTideweOutdoorProfile({ speechMode: "on_camera" });
    const text = "The walk into the woods is only the start. Have a look if that sounds familiar.";
    const facts: ProductFacts = { version: 1, brand: "TIDEWE", category: "other", items: [] };
    const copyDocument: TideweCopyDocument = {
      version: 1, language: "en-US", text, translation: "走进林子只是开始。适合的话可以看看。", angle: "scene", hookType: "scene",
      claimedFactIds: [], factsSnapshot: facts, factsHash: productFactsHash(facts), corpusVersion: profile.corpusVersion,
      compilerVersion: profile.promptCompilerVersion, exampleIds: [], wordCount: englishWordCount(text), estimatedDuration: 5,
    };
    const shot: schema.Shot = { ...shots[0], duration: 5, voiceover: text, description: "清晨林间沿小径行走的背影。", camera: "固定中景",
      prompt: "自然户外小径与背影。", visualIntent: "自然户外行走。",
      tidewe: { copySpan: { start: 0, end: text.length }, translation: copyDocument.translation,
        shotGoal: "建立户外行走场景", productVisible: false, factRefs: [], sceneId: "woods" } };
    db.update(schema.projects).set({ creativeProfile: profile, creativeConfigRevision: 1 }).where(eq(schema.projects.id, "project")).run();
    db.update(schema.scripts).set({ styleType: "tidewe_outdoor", copyDocument, shots: [shot],
      creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1) }).where(eq(schema.scripts.id, "current")).run();
    const generated = await request();
    expect(await generated.json()).toEqual({ title: "Complete Video Benefit Title" });
    expect(generated.status).toBe(200);
    expect(state.generate).toHaveBeenCalledExactlyOnceWith({ copy: text, productName: "Product" }, llmConfig);
    state.generate.mockClear();
    expect((await request({ scriptId: "current", llmConfig, voiceoverOverrides: [] })).status).toBe(409);
    db.update(schema.scripts).set({ shots: [{ ...shot, voiceover: "Different unapproved copy" }] }).where(eq(schema.scripts.id, "current")).run();
    expect((await request()).status).toBe(409);
    expect(state.generate).not.toHaveBeenCalled();
  });
});
