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
import { scriptRevision } from "@/lib/asset-context";
import { assertTideweScript, englishWordCount, productFactsHash } from "@/lib/tidewe/validation";
import type { TideweCopyDocument } from "@/lib/tidewe/types";

const calls = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => db }));
vi.mock("@/lib/script-engine/generator", () => ({
  completeWithJsonRetry: calls.complete, reasoningParams: () => ({}), extractJSON: (text: string) => text,
}));
import { POST } from "@/app/api/project/[id]/script-judge/apply/route";

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let source: typeof schema.scripts.$inferSelect;
let result: unknown;
const profile = createTideweOutdoorProfile();
const projectId = "judge-project";
const first = "Wet grass makes waterproofing the first thing I check.";
const second = "I'd check the fit with my hunting socks, too.";
const params = () => ({ params: Promise.resolve({ id: projectId }) });
const llmConfig = { baseUrl: "https://example.invalid/v1", apiKey: "fixture-key", model: "fixture-model" };
function saved() { return db.select().from(schema.scripts).where(eq(schema.scripts.id, source.id)).get()!; }
function body(overrides: Record<string, unknown> = {}) {
  return { scriptId: source.id, expectedScriptHash: scriptRevision(source), llmConfig,
    ...overrides,
    report: { sourceScriptHash: scriptRevision(source),
      ...(overrides.report && typeof overrides.report === "object" ? overrides.report : {
        verdicts: [{ judge: "voice", issues: [{ shotId: 2, tier: "default", issue: `「${second}」口语需要更自然` }] }], rewrites: [], descriptionRewrites: [],
      }),
    } };
}
function request(payload = body()) {
  return new NextRequest(`http://localhost/api/project/${projectId}/script-judge/apply`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  db.insert(schema.projects).values({ id: projectId, name: "TIDEWE", creativeProfile: profile, creativeConfigRevision: 1 }).run();
  const facts: TideweCopyDocument["factsSnapshot"] = { version: 1, brand: "TIDEWE", category: "waterproof_boots", items: [] };
  const text = `${first} ${second}`;
  const copyDocument: TideweCopyDocument = { version: 1, language: "en-US", text, translation: "走过湿草地时先看防水。我也会配上狩猎袜检查合脚程度。",
    angle: "scene_pain", hookType: "scene", claimedFactIds: [], factsSnapshot: facts, factsHash: productFactsHash(facts),
    corpusVersion: profile.corpusVersion, compilerVersion: profile.promptCompilerVersion, exampleIds: [], wordCount: englishWordCount(text), estimatedDuration: 9,
    visualBeats: [{ text, visualRole: "presenter", visualIdea: "主播在林边解释选购时需要核对的问题。", factRefs: [] }] };
  source = db.insert(schema.scripts).values({ id: "source", projectId, selected: true, styleType: "tidewe_outdoor", totalDuration: 12,
    creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1), copyDocument,
    shots: [first, second].map((voiceover, i) => ({ shotId: i + 1, type: i ? "demo" : "hook", duration: 6,
      description: i ? "猎人坐在林边穿上袜子，整理靴子。" : "猎人沿林边的湿草地走向猎位。", camera: "固定镜头", visualIntent: "呈现户外装备使用场景。", prompt: "林边人物自然展示装备。",
      visualSource: "ai_generate", transition: "direct_concat", voiceover,
      tidewe: { copySpan: { start: i ? first.length + 1 : 0, end: i ? text.length : first.length }, translation: i ? "我也会配上狩猎袜检查合脚程度。" : "走过湿草地时先看防水。",
        shotGoal: "呈现真实户外使用", productVisible: true, factRefs: [], sceneId: "woods",
        visualPlan: { framing: "medium", visualRole: "presenter", actionStart: "双脚已经踩稳林边地面。", action: "向拍摄同伴自然说明选购问题。", actionEnd: "身体站稳并保持自然交流。" } } })),
  }).returning().get()!;
  result = { patches: [{ shotId: 2, voiceover: "I'd try these on with my hunting socks.", translation: "我会配上狩猎袜试穿这双靴子。" }] };
  calls.complete.mockReset().mockImplementation(async (_client, _params, _config, parse) => parse(JSON.stringify(result)));
});
afterEach(() => { sqlite.close(); vi.clearAllMocks(); });

describe("apply judge feedback", () => {
  it("saves corrected TIDEWE copy, translation and spans atomically while preserving timing and identities", async () => {
    const response = await POST(request(), params());
    expect(response.status).toBe(200);
    const updated = saved();
    assertTideweScript(updated);
    expect(updated.id).toBe(source.id);
    expect(updated.selected).toBe(true);
    expect(updated.shots![0]).toEqual(source.shots![0]);
    expect(updated.shots!.map(shot => [shot.shotId, shot.duration])).toEqual([[1, 6], [2, 6]]);
    expect(updated.copyDocument!.text).toBe(`${first} I'd try these on with my hunting socks.`);
    expect(updated.copyDocument!.translation).toContain("我会配上狩猎袜试穿这双靴子。");
    expect(updated.copyDocument!.factsSnapshot).toEqual(source.copyDocument!.factsSnapshot);
    expect(updated.copyDocument!.wordCount).toBe(englishWordCount(updated.copyDocument!.text));
    expect(updated.copyDocument!.visualBeats).toBeUndefined();
    expect(updated.shots![1].tidewe?.visualPlan).toEqual(source.shots![1].tidewe?.visualPlan);
    expect((await response.json()).script.scriptHash).toBe(scriptRevision(updated));
    expect(calls.complete.mock.calls[0][1].messages[0].content).toContain(second);
  });

  it("applies a visual suggestion to downstream generation directions without changing narration", async () => {
    result = { patches: [{ shotId: 2, description: "猎人穿上狩猎袜后套入靴子，站起活动脚踝并走两步。" }] };
    const response = await POST(request(body({ report: { verdicts: [{ judge: "visual", issues: [{ shotId: 2, tier: "default", issue: "「整理靴子」没有检验合脚程度" }] }] } })), params());
    expect(response.status).toBe(200);
    const updated = saved();
    expect(updated.copyDocument).toEqual(source.copyDocument);
    expect(updated.shots![1].prompt).toBe(updated.shots![1].description);
    expect(updated.shots![1].visualIntent).toBe(updated.shots![1].description);
    expect(updated.shots![1].voiceover).toBe(second);
    expect(updated.shots![1].tidewe?.visualPlan).toBeUndefined();
    expect(updated.shots![0].tidewe?.visualPlan).toEqual(source.shots![0].tidewe?.visualPlan);
  });

  it.each(["missing", "stale"])("rejects a %s source revision before calling the model", async kind => {
    const response = await POST(request(body({ expectedScriptHash: kind === "missing" ? undefined : "old" })), params());
    expect(response.status).toBe(kind === "missing" ? 400 : 409);
    expect(calls.complete).not.toHaveBeenCalled();
    expect(saved()).toEqual(source);
  });

  it.each(["edit", "selection", "configuration"])("rejects a concurrent %s during rewriting without overwriting it", async kind => {
    calls.complete.mockImplementationOnce(async (_client, _params, _config, parse) => {
      const output = parse(JSON.stringify(result));
      if (kind === "edit") db.update(schema.scripts).set({ title: "new title", shots: source.shots!.map(shot => ({ ...shot, camera: "缓慢推进" })) }).where(eq(schema.scripts.id, source.id)).run();
      if (kind === "selection") db.update(schema.scripts).set({ selected: false }).where(eq(schema.scripts.id, source.id)).run();
      if (kind === "configuration") db.update(schema.projects).set({ creativeConfigRevision: 2 }).where(eq(schema.projects.id, projectId)).run();
      return output;
    });
    const response = await POST(request(), params());
    expect(response.status).toBe(409);
    expect(saved().copyDocument).toEqual(source.copyDocument);
  });

  it("does not apply taste-only suggestions", async () => {
    const response = await POST(request(body({ report: { verdicts: [{ judge: "voice", issues: [{ shotId: 2, tier: "taste", issue: "换个说法" }] }] } })), params());
    expect(response.status).toBe(400);
    expect(calls.complete).not.toHaveBeenCalled();
    expect(saved()).toEqual(source);
  });

  it("rejects an old report paired with the current script revision", async () => {
    const response = await POST(request(body({ report: { ...body().report, sourceScriptHash: "older-report" } })), params());
    expect(response.status).toBe(409);
    expect(calls.complete).not.toHaveBeenCalled();
    expect(saved()).toEqual(source);
  });

  it("keeps the original script intact on an invalid model response", async () => {
    result = { patches: [{ shotId: 2, voiceover: "Hurry, buy now!", translation: "赶紧购买！" }] };
    const response = await POST(request(), params());
    expect(response.status).toBe(502);
    expect(saved()).toEqual(source);
  });

  it("rejects a report scoped to another project", async () => {
    const response = await POST(request(), { params: Promise.resolve({ id: "another-project" }) });
    expect(response.status).toBe(404);
    expect(calls.complete).not.toHaveBeenCalled();
  });

  it("supports a normal sales script with feedback but no supplied rewrite", async () => {
    const salesProfile = createShortVideoSalesProfile();
    db.update(schema.projects).set({ creativeProfile: salesProfile }).where(eq(schema.projects.id, projectId)).run();
    db.update(schema.scripts).set({ styleType: "pain_point", copyDocument: null,
      creativeProfileSnapshot: createCreativeProfileSnapshot(salesProfile, 1),
      shots: source.shots!.map(shot => ({ ...shot, tidewe: undefined })) }).where(eq(schema.scripts.id, source.id)).run();
    source = saved();
    const response = await POST(request(), params());
    expect(response.status).toBe(200);
    expect(saved().shots![1].voiceover).toBe("I'd try these on with my hunting socks.");
    expect(saved().copyDocument).toBeNull();
  });

  it("cannot apply an old report twice", async () => {
    const payload = body();
    expect((await POST(request(payload), params())).status).toBe(200);
    expect((await POST(request(payload), params())).status).toBe(409);
    expect(calls.complete).toHaveBeenCalledTimes(1);
  });
});
