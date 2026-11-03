// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { aiTasks, projects } from "@/lib/db/schema";
import { generationItems, generationRuns } from "@/lib/generation-schema";

const state = vi.hoisted(() => ({ db: null as unknown, directory: "" }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/paths", () => ({ getDataDir: () => state.directory }));
import { listActiveAiTasksAllProjects, listAiTasks } from "@/lib/ai-tasks";
import { encryptGenerationValue } from "@/lib/generation-secrets";

const sqlite = new Database(":memory:"), db = drizzle(sqlite);
beforeAll(() => {
  state.db = db;
  state.directory = mkdtempSync(join(tmpdir(), "clipforge-released-ai-tasks-"));
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  db.insert(projects).values([{ id: "project-a", name: "A" }, { id: "project-b", name: "B" }]).run();
});
beforeEach(() => { db.delete(generationItems).run(); db.delete(generationRuns).run(); db.delete(aiTasks).run(); });
afterAll(() => { sqlite.close(); rmSync(state.directory, { recursive: true, force: true }); });

function parent(options: { released?: boolean; deleted?: boolean; corrupt?: boolean } = {}) {
  db.insert(generationRuns).values({ id: "run", projectId: "project-a", clientRequestId: "request", requestHash: "hash", kind: "video", createdAt: 1, updatedAt: 1,
    ...(options.deleted && { deletedAt: 2 }) }).run();
  db.insert(generationItems).values({ id: "item", runId: "run", projectId: "project-a", kind: "video", shotId: 1,
    status: options.released ? "cancelled" : "needs_attention", stage: options.released ? "released" : "needs_attention",
    payload: options.corrupt ? "unreadable" : encryptGenerationValue({ request: { provider: "provider-a" } }),
    checkpoint: encryptGenerationValue({ taskId: "remote-task", ...(options.released && { blockingReleasedAt: 2 }) }),
    nextRunAt: 1, createdAt: 1, updatedAt: 1 }).run();
}
function paid(id: string, options: Partial<typeof aiTasks.$inferInsert> = {}) {
  db.insert(aiTasks).values({ id, projectId: "project-a", shotId: 1, provider: "provider-a", model: "video", taskId: "remote-task", status: "unknown", ...options }).run();
}

describe("released generation paid task listings", () => {
  it.each([{ released: true }, { deleted: true }])("removes the exact association from active listings but retains recovery history: %j", async (options) => {
    parent(options);
    paid("released");
    paid("other-provider", { provider: "provider-b" });
    paid("other-project", { projectId: "project-b" });
    paid("other-task", { taskId: "another-remote-task" });
    const before = db.select().from(aiTasks).all();
    expect((await listAiTasks("project-a", true)).map((task) => task.id).sort()).toEqual(["other-provider", "other-task"]);
    expect((await listActiveAiTasksAllProjects()).map((task) => task.id).sort()).toEqual(["other-project", "other-provider", "other-task"]);
    expect((await listAiTasks("project-a", false)).map((task) => task.id).sort()).toEqual(["other-provider", "other-task", "released"]);
    expect(db.select().from(aiTasks).all()).toEqual(before);
  });

  it("keeps completed results with failed imports out of the occupied-shot list after release", async () => {
    parent({ released: true }); paid("paid-output", { status: "completed", importState: "failed", resultUrls: ["https://example.test/paid.mp4"] });
    expect(await listAiTasks("project-a", true)).toEqual([]);
    expect(await listAiTasks("project-a", false)).toEqual([expect.objectContaining({ id: "paid-output", resultUrls: ["https://example.test/paid.mp4"] })]);
  });

  it.each([{}, { released: true, corrupt: true }])("continues showing paid tasks without a readable explicit release: %j", async (options) => {
    parent(options); paid("retained");
    expect(await listAiTasks("project-a", true)).toEqual([expect.objectContaining({ id: "retained" })]);
    expect(await listActiveAiTasksAllProjects()).toEqual([expect.objectContaining({ id: "retained" })]);
  });
});
