// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "@/lib/db/schema";
import { createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { fillShotStock, persistCandidate, type ScoredStockCandidate } from "@/lib/stock-fill";

const services = vi.hoisted(() => ({ search: vi.fn(), download: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => db }));
vi.mock("@/lib/providers/stock-registry", () => ({ searchStock: services.search, searchAllStock: services.search }));
vi.mock("@/lib/providers/stock-types", async (original) => ({ ...await original<typeof import("@/lib/providers/stock-types")>(), downloadStockFile: services.download }));

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const candidate: ScoredStockCandidate = { id: "woods", source: "local", mediaType: "video", type: "video", downloadUrl: "https://example.test/woods.mp4", pageUrl: "https://example.test/woods", author: "fixture", authorUrl: "", license: "owned", durationSec: 5 };
function setSpeech(speechMode: "on_camera" | "voiceover", voiceover: string) {
  db.update(schema.projects).set({ creativeProfile: createTideweOutdoorProfile({ speechMode }) }).run();
  db.update(schema.scripts).set({ shots: [{ shotId: 1, type: "hook", duration: 5, camera: "固定镜头", description: "林间人物介绍", voiceover, visualSource: "ai_generate", transition: "direct_concat", tidewe: { copySpan: { start: 0, end: voiceover.length }, translation: "林间介绍", shotGoal: "建立户外场景", productVisible: false, factRefs: [], sceneId: "woods" } }] }).run();
}
beforeEach(() => {
  sqlite = new Database(":memory:"); db = drizzle(sqlite, { schema }); migrate(db, { migrationsFolder: "drizzle" });
  db.insert(schema.projects).values({ id: "native-stock", name: "TIDEWE native" }).run();
  db.insert(schema.scripts).values({ projectId: "native-stock", styleType: "tidewe_outdoor", selected: true, shots: [] }).run();
  services.search.mockReset().mockResolvedValue([]); services.download.mockReset();
});
afterEach(() => { sqlite.close(); });

describe("TIDEWE automatic stock adoption", () => {
  it("rejects a spoken non-product shot before either searching or directly downloading a candidate", async () => {
    setSpeech("on_camera", "Cold mornings are when I want a choice.");
    await expect(fillShotStock({ projectId: "native-stock", shotId: 1, query: "forest", source: "local", searchOpts: { mediaType: "video" } })).rejects.toThrow("真人口播镜头");
    await expect(persistCandidate("native-stock", 1, "forest", candidate)).rejects.toThrow("真人口播镜头");
    expect(services.search).not.toHaveBeenCalled(); expect(services.download).not.toHaveBeenCalled();
    expect(db.select().from(schema.assets).all()).toEqual([]);
  });
  it.each([
    { speechMode: "on_camera", voiceover: "  " },
    { speechMode: "voiceover", voiceover: "Cold mornings are when I want a choice." },
  ] as const)("retains stock search for $speechMode with eligible environment footage", async ({ speechMode, voiceover }) => {
    setSpeech(speechMode, voiceover);
    await expect(fillShotStock({ projectId: "native-stock", shotId: 1, query: "forest", source: "local", searchOpts: { mediaType: "video" } })).resolves.toBeNull();
    expect(services.search).toHaveBeenCalled();
    expect(services.download).not.toHaveBeenCalled();
  });
});
