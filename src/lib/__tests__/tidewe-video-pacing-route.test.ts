// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { createCreativeProfileSnapshot, createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { assetScopeForShot } from "@/lib/asset-context";
import { productFactsHash } from "@/lib/tidewe/validation";
import { TIDEWE_PACING_VERSION } from "@/lib/tidewe/pacing";

const state = vi.hoisted(() => ({ db: null as unknown, provider: vi.fn(), generate: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/providers", () => ({ createProvider: state.provider }));
vi.mock("@/lib/remote-image", () => ({ toRemoteUsableImage: async (value: string) => value }));
vi.mock("@/lib/server/video-prompt", async original => ({
  ...await original<typeof import("@/lib/server/video-prompt")>(),
  assertReviewedVideoPrompt: () => ({ prompt: "The presenter explains the woodland route in clear English.", negativePrompt: "",
    controlPlan: { version: 1, strategy: "keyframe", mode: "image-to-video", audioMode: "native", voiceoverBound: true,
      firstFrameUrl: "/api/files/pacing/frame.png", referenceInputs: [], referenceRoles: ["keyframe"], referenceCount: 1, warnings: [] } }),
}));
import { POST } from "@/app/api/ai/video/route";

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

function seed(wordCount: number, paced = true) {
  const profile = createTideweOutdoorProfile({ targetDuration: 30 });
  const text = Array.from({ length: wordCount / 4 }, () => "The trail begins here.").join(" ");
  const facts = { version: 1 as const, brand: "TIDEWE", category: "other" as const, items: [] };
  const shot: schema.Shot = { shotId: 1, type: "hook", duration: 2, description: "主播在林间说明行走路线。", camera: "固定中景",
    prompt: "主播站在林间面向镜头说明路线。", visualIntent: "让观众看清路线起点。",
    voiceover: text, visualSource: "ai_generate", transition: "direct_concat",
    tidewe: { personVisible: true, speechDelivery: "on_camera", copySpan: { start: 0, end: text.length },
      translation: "林间的行走路线从这里开始。", shotGoal: "说明路线", productVisible: false, factRefs: [], sceneId: "woods" } };
  db.insert(schema.projects).values({ id: "pacing", name: "Pacing", creativeProfile: profile, creativeConfigRevision: 1 }).run();
  const script = db.insert(schema.scripts).values({ id: "script", projectId: "pacing", selected: true, styleType: "tidewe_outdoor", shots: [shot],
    creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1), copyDocument: {
      version: 1, language: "en-US", source: "user_provided", text, translation: shot.tidewe!.translation,
      angle: "scene", hookType: "scene", claimedFactIds: [], factsSnapshot: facts, factsHash: productFactsHash(facts),
      corpusVersion: profile.corpusVersion, compilerVersion: profile.promptCompilerVersion, exampleIds: [], wordCount, estimatedDuration: 6.2,
      ...(paced ? { pacingVersion: TIDEWE_PACING_VERSION } : {}),
    } }).returning().get()!;
  db.insert(schema.assets).values({ id: "frame", projectId: "pacing", shotId: 1, type: "ai_generated", status: "done", selected: true,
    filePath: "/api/files/pacing/frame.png", ...assetScopeForShot(script, shot) }).run();
}

function request() {
  return POST(new NextRequest("http://localhost/api/ai/video", { method: "POST", body: JSON.stringify({
    provider: "fixture", model: "video-model", apiKey: "fixture-key", projectId: "pacing", scriptId: "script", shotId: 1,
    prompt: "The presenter explains the woodland route in clear English.", imageUrl: "/api/files/pacing/frame.png",
    promptContext: { contextKey: "reviewed" }, options: { duration: 2 },
  }) }));
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }); state.db = db;
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  state.generate.mockReset().mockResolvedValue({ videoUrls: ["https://example.test/pacing.mp4"] });
  state.provider.mockReset().mockReturnValue({ generateVideo: state.generate });
});
afterEach(() => sqlite.close());

describe("native TIDEWE generation speaking budget", () => {
  it("expands a short generation slot to keep the complete paced line", async () => {
    seed(20);
    const response = await request();
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(state.generate).toHaveBeenCalledWith(expect.objectContaining({ duration: 6, minimumDuration: 6, audioEnabled: true }));
  });

  it("rejects an impossible single-shot line before setting up a paid provider", async () => {
    seed(80);
    const response = await request();
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(422);
    expect(await response.json()).toMatchObject({ code: "TIDEWE_SPEECH_BUDGET_EXCEEDED" });
    expect(state.provider).not.toHaveBeenCalled();
    expect(state.generate).not.toHaveBeenCalled();
  });

  it("retains the stored minimum for historical scripts without the pacing marker", async () => {
    seed(20, false);
    const response = await request();
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(state.generate).toHaveBeenCalledWith(expect.objectContaining({ duration: 2, minimumDuration: 2 }));
  });
});
