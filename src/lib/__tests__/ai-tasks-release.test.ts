// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { aiTasks, projects } from "@/lib/db/schema";
import { generationItems, generationRuns } from "@/lib/generation-schema";

const state = vi.hoisted(() => ({ db: null as unknown, directory: "" }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/paths", () => ({ getDataDir: () => state.directory }));
import { listActiveAiTaskSummaries, listActiveAiTasksAllProjects, listAiTasks, markGenerationAiTasksReleased, updateAiTask, updateAiTaskByProviderTaskId } from "@/lib/ai-tasks";
import { encryptGenerationValue } from "@/lib/generation-secrets";
import * as checkpointMedia from "@/lib/generation-checkpoint-media";

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
    db.transaction((tx) => markGenerationAiTasksReleased(tx, "project-a", "provider-a", ["remote-task"]));
    const before = db.select().from(aiTasks).all();
    expect((await listAiTasks("project-a", true)).map((task) => task.id).sort()).toEqual(["other-provider", "other-task"]);
    expect((await listActiveAiTasksAllProjects()).map((task) => task.id).sort()).toEqual(["other-project", "other-provider", "other-task"]);
    expect((await listActiveAiTaskSummaries()).map((task) => task.id).sort()).toEqual(["other-project", "other-provider", "other-task"]);
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
    expect(await listActiveAiTaskSummaries()).toEqual([expect.objectContaining({ id: "retained" })]);
  });

  it("lists only unresolved non-Kling paid summaries without reading result JSON", async () => {
    paid("unknown");
    paid("submitted", { status: "submitted" });
    paid("processing", { status: "processing" });
    paid("pending-import", { status: "completed", importState: "pending" });
    paid("failed-import", { status: "completed", importState: "failed" });
    paid("imported", { status: "completed", importState: "imported" });
    paid("failed", { status: "failed" });
    paid("kling", { provider: "kling-cli" });
    sqlite.prepare("UPDATE ai_tasks SET result_urls = ?, control_plan = ?").run("invalid-json", "invalid-json");
    const summaries = await listActiveAiTaskSummaries();
    expect(summaries.map((row) => row.id).sort()).toEqual(["failed-import", "pending-import", "processing", "submitted", "unknown"]);
    for (const row of summaries) {
      expect(Object.keys(row).sort()).toEqual(["createdAt", "id", "mediaType", "model", "projectId", "provider", "status", "taskId"]);
    }
  });

  it("reads no execution envelopes in the feed, and atomically hides only exact released identities", async () => {
    parent({ released: true });
    paid("released"); paid("other-provider", { provider: "provider-b" });
    paid("other-project", { projectId: "project-b" }); paid("other-task", { taskId: "other-task" });
    const queries: string[] = [];
    const logged = drizzle(sqlite, { logger: { logQuery: (query) => queries.push(query) } });
    state.db = logged;
    try {
      expect(() => logged.transaction((tx) => {
        markGenerationAiTasksReleased(tx, "project-a", "provider-a", ["remote-task"]);
        throw new Error("rollback");
      })).toThrow("rollback");
      expect((await listActiveAiTaskSummaries()).map((row) => row.id)).toContain("released");
      logged.transaction((tx) => markGenerationAiTasksReleased(tx, "project-a", "provider-a", ["remote-task", "remote-task", ""]));
      queries.length = 0;
      const summaries = await listActiveAiTaskSummaries();
      expect(summaries.map((row) => row.id).sort()).toEqual(["other-project", "other-provider", "other-task"]);
      expect(queries).toHaveLength(1);
      expect(queries[0]).not.toMatch(/payload|checkpoint|result_urls|control_plan|prompt|generation_items|generation_runs/i);
    } finally { state.db = db; }
  });

  it("persists image results as durable files without resetting a completed import", async () => {
    paid("imported-image", { status: "completed", importState: "imported", assetId: "saved-asset" });
    const image = `data:image/png;base64,${Buffer.from("paid-image-result").toString("base64")}`;
    await updateAiTask("imported-image", { resultUrls: [image], status: "completed" });
    const row = db.select().from(aiTasks).where(eq(aiTasks.id, "imported-image")).get()!;
    expect(row).toMatchObject({ importState: "imported", assetId: "saved-asset" });
    expect(row.resultUrls).toEqual([expect.stringMatching(/^\/api\/files\/project-a\/generation-result-/)]);
    expect(readFileSync(checkpointMedia.generationResultFilePath("project-a", row.resultUrls![0])!, "utf8")).toBe("paid-image-result");
  });

  it("updates provider task duplicates with files in each row's own project", async () => {
    paid("image-a"); paid("image-b", { projectId: "project-b", importState: "imported" });
    paid("unscoped", { projectId: null });
    const image = `data:image/png;base64,${Buffer.from("paid-image-provider-result").toString("base64")}`;
    await updateAiTaskByProviderTaskId("provider-a", "remote-task", { resultUrls: [image], status: "completed" });
    const rows = db.select().from(aiTasks).all();
    expect(rows.find((row) => row.id === "image-a")).toMatchObject({ resultUrls: [expect.stringContaining("/api/files/project-a/")], importState: "pending" });
    expect(rows.find((row) => row.id === "image-b")).toMatchObject({ resultUrls: [expect.stringContaining("/api/files/project-b/")], importState: "imported" });
    expect(rows.find((row) => row.id === "unscoped")).toMatchObject({ resultUrls: [image], status: "completed" });
  });

  it("retains the acknowledged image in the database if file persistence fails", async () => {
    paid("image");
    const image = "data:image/png;base64,cGFpZA==";
    const persist = vi.spyOn(checkpointMedia, "persistGenerationMediaUrls").mockImplementationOnce(() => { throw new Error("disk full"); });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await updateAiTask("image", { status: "completed", resultUrls: [image] });
      expect(db.select().from(aiTasks).where(eq(aiTasks.id, "image")).get()).toMatchObject({ status: "completed", resultUrls: [image], importState: "pending" });
      expect(warning).toHaveBeenCalledTimes(1);
    } finally { persist.mockRestore(); warning.mockRestore(); }
  });
});
