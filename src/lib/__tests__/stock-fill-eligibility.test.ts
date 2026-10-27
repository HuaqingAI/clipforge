// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { NextRequest } from "next/server";
import * as schema from "@/lib/db/schema";
import { POST } from "@/app/api/project/[id]/stock-fill/route";
import { fillShotStock, isPremiumCgStockFillBlocked, searchShotCandidates } from "@/lib/stock-fill";
import { rerankShotCandidates } from "@/lib/semantic-match";
import { createTideweOutdoorProfile } from "@/lib/creative-profiles";

vi.mock("@/lib/db", () => ({ getDb: () => db }));
vi.mock("@/lib/stock-fill", () => ({
  fillShotStock: vi.fn(async () => ({ provider: "local", mediaType: "image" })),
  searchShotCandidates: vi.fn(),
  persistCandidate: vi.fn(),
  isPremiumCgStockFillBlocked: vi.fn(() => false),
}));
vi.mock("@/lib/semantic-match", () => ({ rerankShotCandidates: vi.fn() }));

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
beforeEach(() => {
  vi.mocked(isPremiumCgStockFillBlocked).mockReturnValue(false);
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  db.insert(schema.projects)
    .values({ id: "fill-test", name: "Local fill" })
    .run();
  const shots = Array.from({ length: 7 }, (_, index) => ({
    shotId: index + 1,
    duration: 3,
    type: "demo" as const,
    camera: "static",
    transition: "direct_concat" as const,
    visualSource:
      index === 6 ? ("product_image" as const) : ("ai_generate" as const),
    description: "Coffee on a table",
    voiceover: "Coffee",
    stockKeywords: ["coffee"],
  }));
  db.insert(schema.scripts)
    .values({
      projectId: "fill-test",
      styleType: "custom",
      selected: true,
      shots,
    })
    .run();
  const states = ["done", "pending", "generating", "failed"] as const;
  db.insert(schema.assets)
    .values(
      states.map((status, index) => ({
        projectId: "fill-test",
        shotId: index + 1,
        type: "user_upload" as const,
        selected: true,
        status,
      })),
    )
    .run();
  // An old successful take must not hide a selected failure or an otherwise empty shot.
  db.insert(schema.assets)
    .values(
      [4, 5].map((shotId) => ({
        projectId: "fill-test",
        shotId,
        type: "user_upload" as const,
        selected: false,
        status: "done" as const,
      })),
    )
    .run();
});
afterEach(() => {
  sqlite.close();
  vi.clearAllMocks();
});

it("fills failed and empty shots while protecting ready, pending, generating and product shots", async () => {
  const response = await POST(
    new NextRequest("http://localhost/api/project/fill-test/stock-fill", {
      method: "POST",
      body: JSON.stringify({ source: "local", mediaType: "auto" }),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ id: "fill-test" }) },
  );
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.filled).toBe(3);
  expect(
    vi
      .mocked(fillShotStock)
      .mock.calls.map(([input]) => input.shotId)
      .sort(),
  ).toEqual([4, 5, 6]);
  expect(
    vi
      .mocked(fillShotStock)
      .mock.calls.every(([input]) => input.source === "local"),
  ).toBe(true);
  expect(rerankShotCandidates).not.toHaveBeenCalled();
});

it("blocks stock adoption for a premium product CG project before any candidate search", async () => {
  vi.mocked(isPremiumCgStockFillBlocked).mockReturnValue(true);

  const response = await POST(
    new NextRequest("http://localhost/api/project/fill-test/stock-fill", {
      method: "POST",
      body: JSON.stringify({ source: "local", mediaType: "auto" }),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ id: "fill-test" }) },
  );

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toMatchObject({ code: "PREMIUM_CG_STOCK_FILL_FORBIDDEN" });
  expect(fillShotStock).not.toHaveBeenCalled();
  expect(rerankShotCandidates).not.toHaveBeenCalled();
});

it.each([false, true])("only auto-fills silent environment B-roll in native TIDEWE projects, semantic=%s", async (semantic) => {
  db.delete(schema.assets).run();
  db.update(schema.projects).set({ creativeProfile: createTideweOutdoorProfile() }).run();
  const shots: schema.Shot[] = [
    { shotId: 1, type: "hook", duration: 5, description: "林间人物介绍", voiceover: "Cold mornings are when I want a choice.", visualSource: "ai_generate", stockKeywords: ["speaking forest"], transition: "direct_concat" },
    { shotId: 2, type: "demo", duration: 2, description: "清晨环境空镜", voiceover: "", visualSource: "ai_generate", stockKeywords: ["silent forest"], transition: "direct_concat" },
    { shotId: 3, type: "demo", duration: 3, description: "装备细节", voiceover: "", visualSource: "ai_generate", stockKeywords: ["hunting jacket"], transition: "direct_concat" },
  ].map((shot, index): schema.Shot => ({ ...shot, type: index === 0 ? "hook" : "demo", camera: "固定镜头", visualSource: "ai_generate", transition: "direct_concat", tidewe: { copySpan: { start: 0, end: 0 }, translation: "", shotGoal: "户外展示", productVisible: index === 2, factRefs: [], sceneId: "woods" } }));
  db.update(schema.scripts).set({ styleType: "tidewe_outdoor", shots }).run();
  vi.mocked(searchShotCandidates).mockResolvedValue({ cands: [], matchedQuery: "silent forest", fallbackLevel: "original" });
  const response = await POST(new NextRequest("http://localhost/api/project/fill-test/stock-fill", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "local", force: true, ...(semantic && { llmConfig: { baseUrl: "https://example.test", model: "fixture" } }) }),
  }), { params: Promise.resolve({ id: "fill-test" }) });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.results.find((shot: { shotId: number }) => shot.shotId === 1)).toMatchObject({ ok: false, reason: expect.stringContaining("真人口播") });
  expect(result.results.find((shot: { shotId: number }) => shot.shotId === 3)).toMatchObject({ ok: false, reason: expect.stringContaining("产品镜头") });
  if (semantic) {
    expect(vi.mocked(searchShotCandidates).mock.calls.map(([query]) => query)).toEqual(["silent forest"]);
    expect(fillShotStock).not.toHaveBeenCalled();
  } else {
    expect(vi.mocked(fillShotStock).mock.calls.map(([input]) => input.shotId)).toEqual([2]);
    expect(searchShotCandidates).not.toHaveBeenCalled();
  }
});
