// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generationItems, generationRuns } from "@/lib/generation-schema";
import { projects } from "@/lib/db/schema";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
import { listGenerationTaskSummaries } from "@/lib/generation-task-summary";

const sqlite = new Database(":memory:");
const queries: string[] = [];
const db = drizzle(sqlite, { logger: { logQuery: (query) => queries.push(query) } });
const now = Date.UTC(2026, 10, 6, 8);
beforeAll(() => {
  state.db = db;
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  db.insert(projects).values({ id: "project-a", name: "A" }).run();
});
beforeEach(() => { db.delete(generationItems).run(); db.delete(generationRuns).run(); queries.length = 0; });
afterAll(() => sqlite.close());

function run(id: string, options: Partial<typeof generationRuns.$inferInsert> = {}) {
  db.insert(generationRuns).values({ id, projectId: "project-a", clientRequestId: id, requestHash: "hash", kind: "image",
    createdAt: now, updatedAt: now, ...options }).run();
}
function item(runId: string, id: string, status: string, options: Partial<typeof generationItems.$inferInsert> = {}) {
  db.insert(generationItems).values({ id, runId, projectId: "project-a", kind: "image", status, stage: id,
    payload: "encrypted-input", nextRunAt: now, createdAt: now, updatedAt: now, ...options }).run();
}

describe("generation task summaries", () => {
  it.each([
    [["completed", "completed"], "completed", 2, 0],
    [["completed", "importing", "needs_attention"], "running", 1, 1],
    [["running", "queued"], "running", 0, 0],
    [["queued", "waiting", "needs_attention"], "queued", 0, 1],
    [["waiting", "failed"], "waiting", 0, 1],
    [["needs_attention", "failed"], "needs_attention", 0, 2],
    [["failed", "cancelled"], "failed", 0, 1],
    [[], "queued", 0, 0],
  ] as const)("matches detail status precedence for %j", (statuses, status, done, failed) => {
    run("run");
    statuses.forEach((value, index) => item("run", `item-${index}`, value));
    expect(listGenerationTaskSummaries(now)).toEqual([expect.objectContaining({ id: "run", status, total: statuses.length, done, failed })]);
  });

  it("uses the first active item's timestamp and id order, and the newest item/run update", () => {
    run("run", { updatedAt: now - 1000 });
    item("run", "z-first", "waiting", { createdAt: now - 100, updatedAt: now + 2000 });
    item("run", "a-first", "importing", { createdAt: now - 100, updatedAt: now });
    item("run", "later", "running", { createdAt: now, updatedAt: now + 1000 });
    expect(listGenerationTaskSummaries(now)).toEqual([expect.objectContaining({ status: "running", stage: "a-first", updatedAt: new Date(now + 2000).toISOString() })]);
    run("empty", { updatedAt: now + 3000 });
    expect(listGenerationTaskSummaries(now).find((row) => row.id === "empty")).toMatchObject({ updatedAt: new Date(now + 3000).toISOString(), stage: null });
  });

  it("excludes deleted/cancelled/old completed runs and caps recent completions without capping active or failed runs", () => {
    run("deleted", { deletedAt: now }); item("deleted", "deleted-item", "running");
    run("cancelled"); item("cancelled", "cancelled-item", "cancelled");
    run("old", { updatedAt: now - 24 * 3600 * 1000 });
    item("old", "old-item", "completed", { updatedAt: now - 24 * 3600 * 1000 });
    for (let index = 0; index < 10; index++) {
      run(`recent-${index}`, { updatedAt: now - index * 1000 });
      item(`recent-${index}`, `recent-item-${index}`, "completed", { updatedAt: now - index * 1000 });
      run(`active-${index}`); item(`active-${index}`, `active-item-${index}`, "running");
      run(`failed-${index}`); item(`failed-${index}`, `failed-item-${index}`, "failed");
    }
    const summaries = listGenerationTaskSummaries(now);
    expect(summaries.filter((row) => row.status === "completed").map((row) => row.id)).toEqual(Array.from({ length: 8 }, (_, index) => `recent-${index}`));
    expect(summaries.filter((row) => row.status === "running")).toHaveLength(10);
    expect(summaries.filter((row) => row.status === "failed")).toHaveLength(10);
    expect(summaries).toHaveLength(28);
  });

  it("reads only status metadata and works on a read-only connection even when historical envelopes/results are unreadable", () => {
    run("run"); item("run", "item", "completed", { checkpoint: "x".repeat(1024 * 1024) });
    sqlite.prepare("UPDATE generation_items SET result = ? WHERE id = ?").run("invalid-result-json", "item");
    queries.length = 0;
    sqlite.pragma("query_only = ON");
    try {
      expect(listGenerationTaskSummaries(now)).toEqual([expect.objectContaining({ id: "run", status: "completed", done: 1 })]);
    } finally { sqlite.pragma("query_only = OFF"); }
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toMatch(/payload|checkpoint|result|begin|update\s|insert\s|delete\s/i);
    expect(queries[0]).toMatch(/group by/i);
  });
});
