// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { join } from "path";
import { NextRequest } from "next/server";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import type { KlingJob } from "@/lib/kling/job-schema";

const state = vi.hoisted(() => ({ db: null as unknown, active: new Set<string>(), start: vi.fn().mockResolvedValue("resumed"), remove: vi.fn().mockResolvedValue(undefined) }));
vi.mock("fs/promises", async (original) => ({ ...await original<typeof import("fs/promises")>(), rm: (...args: unknown[]) => state.remove(...args) }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/pipeline-runner", () => ({ isPipelineRunActive: (id: string) => state.active.has(id), startPipelineRun: state.start }));
vi.mock("@/lib/transcript-render-runner", () => ({ reconcileTranscriptRenders: vi.fn() }));
import { GET } from "@/app/api/tasks/route";
import { GET as getPipeline, POST as postPipeline } from "@/app/api/project/[id]/pipeline/route";
import { getLatestPipelineRun } from "@/lib/pipeline-history";
import { parseTaskFeed, taskHref } from "@/lib/task-feed";
import { DELETE as deleteProject } from "@/app/api/project/[id]/route";
import { DELETE as deleteGenerationRun } from "@/app/api/generation-runs/[id]/route";

const sqlite = new Database(":memory:");
const db = drizzle(sqlite, { schema });
beforeAll(() => { state.db = db; migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") }); });
beforeEach(() => {
  db.delete(schema.generationItems).run();
  db.delete(schema.generationRuns).run();
  db.delete(schema.klingJobOutputs).run();
  db.delete(schema.klingJobs).run();
  db.delete(schema.klingProfiles).run();
  db.delete(schema.projects).run();
  db.delete(schema.batchJobs).run();
  state.active.clear();
  state.start.mockClear();
  state.remove.mockClear();
  db.insert(schema.projects).values([{ id: "project-a", name: "项目 A" }, { id: "project-b", name: "项目 B" }]).run();
});
afterAll(() => sqlite.close());

const sameTime = new Date("2026-09-16T00:00:00Z");
function run(values: Partial<typeof schema.pipelineRuns.$inferInsert> & { id: string }) {
  db.insert(schema.pipelineRuns).values({ projectId: "project-a", createdAt: sameTime, ...values }).run();
}
async function feed() { return parseTaskFeed(await (await GET()).json()); }
function job(overrides: Partial<Pick<KlingJob, "remoteState" | "importState" | "submissionState">> = {}) {
  const now = Date.now();
  db.insert(schema.klingProfiles).values({ id: "profile-a", data: {} as typeof schema.klingProfiles.$inferInsert["data"] }).run();
  db.insert(schema.klingJobs).values({ id: "job-run", projectId: "project-a", scriptId: "script-a", shotId: 1,
    profileId: "profile-a", principalKey: "account-a", region: "global", clientRequestId: "request-a",
    submissionState: "acknowledged", remoteState: "processing", importState: "not_ready", ...overrides,
    data: { scriptRevision: "revision", shotKey: "shot-1", expectedSelectedAssetId: null, payloadHash: "payload", requestHash: "request",
      model: { displayName: "Kling video" } as KlingJob["data"]["model"], prompt: "Product", options: {}, inputs: [], args: [],
      cliVersion: "0.2.0", adapterVersion: "1", authorizedBootId: "test", authorizedUntil: now + 60000,
      authorizationEpoch: 1, billingAcknowledgedAt: now, queryAttempts: 0 },
    createdAt: now, updatedAt: now }).run();
}

describe("任务发现和恢复状态", () => {
  it.each(["completed", "failed"])("removes a deleted %s task from the global feed while preserving its asset", async (status) => {
    const now = Date.now();
    db.insert(schema.generationRuns).values({ id: "history-run", projectId: "project-a", clientRequestId: "history-request", requestHash: "hash",
      kind: "image", createdAt: now, updatedAt: now }).run();
    db.insert(schema.generationItems).values({ id: "history-item", runId: "history-run", projectId: "project-a", kind: "image", status,
      payload: "encrypted-input", result: { assetId: "history-asset" }, nextRunAt: now, createdAt: now, updatedAt: now }).run();
    db.insert(schema.assets).values({ id: "history-asset", projectId: "project-a", shotId: 1, type: "ai_generated", status: "done", filePath: "/api/files/project-a/keep.png" }).run();
    try {
      const before = await feed();
      expect([...before.attention, ...before.recent].some((row) => row.id === "history-run")).toBe(true);
      const asset = db.select().from(schema.assets).where(eq(schema.assets.id, "history-asset")).get();
      const response = await deleteGenerationRun(new NextRequest("http://localhost/api/generation-runs/history-run?projectId=project-a", { method: "DELETE" }),
        { params: Promise.resolve({ id: "history-run" }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ deletedIds: ["history-run"], deletedCount: 1 });
      const after = await feed();
      expect([...after.active, ...after.attention, ...after.recent].some((row) => row.id === "history-run")).toBe(false);
      expect(db.select().from(schema.assets).where(eq(schema.assets.id, "history-asset")).get()).toEqual(asset);
      expect(state.remove).not.toHaveBeenCalled();
    } finally {
      db.delete(schema.assets).where(eq(schema.assets.id, "history-asset")).run();
    }
  });
  it.each(["queued", "running", "waiting", "importing", "needs_attention"])("keeps a project's files while its durable task is %s", async (status) => {
    const now = Date.now();
    db.insert(schema.generationRuns).values({ id: "durable-run", projectId: "project-a", clientRequestId: "request-durable", requestHash: "hash", kind: "video_batch", createdAt: now, updatedAt: now }).run();
    db.insert(schema.generationItems).values({ id: "durable-item", runId: "durable-run", projectId: "project-a", kind: "video", scriptId: "script-a", shotId: 1, status,
      payload: "encrypted-input", nextRunAt: now, createdAt: now, updatedAt: now }).run();
    const response = await deleteProject(new NextRequest("http://localhost/api/project/project-a", { method: "DELETE" }), { params: Promise.resolve({ id: "project-a" }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "PROJECT_HAS_UNRESOLVED_GENERATION_TASKS", blockingTasks: [{ kind: "generation", id: "durable-run", href: "/project/project-a/assets?runId=durable-run" }] });
    expect(db.select().from(schema.projects).all()).toHaveLength(2);
    expect(state.remove).not.toHaveBeenCalled();
  });
  it.each(["queued", "running", "waiting", "importing", "needs_attention"])("allows project deletion when a deleted historical task still has a legacy %s item", async (status) => {
    const now = Date.now();
    for (const projectId of ["project-a", "project-b"]) {
      db.insert(schema.generationRuns).values({ id: `historical-${projectId}`, projectId, clientRequestId: "historical-request", requestHash: "hash", kind: "video",
        deletedAt: projectId === "project-a" ? now : null, createdAt: now, updatedAt: now }).run();
      db.insert(schema.generationItems).values({ id: `historical-item-${projectId}`, runId: `historical-${projectId}`, projectId, kind: "video", status,
        payload: "encrypted-input", nextRunAt: now, createdAt: now, updatedAt: now }).run();
    }
    const response = await deleteProject(new NextRequest("http://localhost/api/project/project-a", { method: "DELETE" }), { params: Promise.resolve({ id: "project-a" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(db.select().from(schema.projects).all()).toMatchObject([{ id: "project-b" }]);
    expect(state.remove).toHaveBeenCalledTimes(2);
    expect(db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, "historical-project-b")).get()).toMatchObject({ projectId: "project-b", deletedAt: null });
    expect(db.select().from(schema.generationItems).where(eq(schema.generationItems.id, "historical-item-project-b")).get()).toMatchObject({ projectId: "project-b", status });
  });
  it("returns only visible recovery links when deleted history and an unfinished live task coexist", async () => {
    const now = Date.now();
    for (const id of ["hidden-run", "visible-run"]) {
      db.insert(schema.generationRuns).values({ id, projectId: "project-a", clientRequestId: id, requestHash: "hash", kind: "script",
        deletedAt: id === "hidden-run" ? now : null, createdAt: now, updatedAt: now }).run();
      db.insert(schema.generationItems).values({ id: `${id}-item`, runId: id, projectId: "project-a", kind: "script", status: "needs_attention",
        payload: "encrypted-input", nextRunAt: now, createdAt: now, updatedAt: now }).run();
    }
    const response = await deleteProject(new NextRequest("http://localhost/api/project/project-a", { method: "DELETE" }), { params: Promise.resolve({ id: "project-a" }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ blockingTasks: [{ kind: "generation", id: "visible-run", href: "/project/project-a/script?runId=visible-run" }] });
    expect(db.select().from(schema.projects).all()).toHaveLength(2);
    expect(state.remove).not.toHaveBeenCalled();
  });
  it("中断任务落库后多次刷新仍保留，接替任务成功后移除", async () => {
    run({ id: "orphan", status: "running", stage: "stock_fill" });
    for (let i = 0; i < 3; i++) {
      const result = await feed();
      expect(result.attention).toMatchObject([{ id: "orphan", kind: "pipeline_interrupted", stage: "stock_fill" }]);
      expect(result.active).toEqual([]);
    }
    expect(getLatestPipelineRun("project-a")).toMatchObject({ status: "failed", error: "interrupted" });
    run({ id: "replacement", status: "done" });
    expect((await feed()).attention).toEqual([]);
  });

  it("同秒重试以插入顺序识别最新任务，活动合成不重复展示", async () => {
    run({ id: "z-old", status: "failed" });
    db.insert(schema.compositions).values({ id: "composition", projectId: "project-a", status: "composing" }).run();
    run({ id: "a-new", status: "running", compositionId: "composition" });
    state.active.add("a-new");
    expect(getLatestPipelineRun("project-a")?.id).toBe("a-new");
    const result = await feed();
    expect(result.attention).toEqual([]);
    expect(result.active).toMatchObject([{ kind: "pipeline", id: "a-new" }]);
  });

  it("保留各项目最新失败并提供对应恢复入口，不向任务摘要暴露错误详情", async () => {
    run({ id: "a", status: "failed", error: "sensitive provider error" });
    run({ id: "b", projectId: "project-b", status: "failed", error: "interrupted" });
    const result = await feed();
    expect(result.attention).toHaveLength(2);
    const failed = result.attention.find((row) => row.id === "a")!;
    expect(failed.kind).toBe("pipeline_failed");
    expect(taskHref(failed)).toBe("/project/project-a/script");
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });

  it("全部运行批次都有各自进度，终止批次不再展示", async () => {
    db.insert(schema.batchJobs).values([{ id: "one", total: 3 }, { id: "two", total: 2 }, { id: "cancelled", status: "cancelled" }]).run();
    db.insert(schema.batchJobItems).values([
      { id: "1", jobId: "one", productId: "p", productName: "p", status: "done" },
      { id: "2", jobId: "one", productId: "p", productName: "p", status: "failed" },
      { id: "3", jobId: "two", productId: "p", productName: "p", status: "done" },
    ]).run();
    expect((await feed()).active).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "one", done: 1, failed: 1, total: 3 }),
      expect.objectContaining({ id: "two", done: 1, failed: 0, total: 2 }),
    ]));
    expect((await feed()).active).toHaveLength(2);
    expect((await GET()).headers.get("Cache-Control")).toBe("no-store");
  });

  it("项目查询及续跑也使用同秒内最新断点", async () => {
    run({ id: "z-earlier", status: "failed", stage: "judge", scriptId: "old-script" });
    run({ id: "a-later", status: "failed", stage: "compose", scriptId: "new-script" });
    const context = { params: Promise.resolve({ id: "project-a" }) };
    const url = "http://localhost/api/project/project-a/pipeline";
    expect(await (await getPipeline(new NextRequest(url), context)).json()).toMatchObject({ run: { id: "a-later" } });
    expect((await postPipeline(new NextRequest(url, { method: "POST", body: JSON.stringify({ resume: true }) }), context)).status).toBe(202);
    expect(state.start).toHaveBeenCalledWith(expect.objectContaining({ fromStage: "compose", scriptId: "new-script" }));
  });

  it("keeps sales projects eligible for a pipeline start", async () => {
    const projectId = "project-b";
    const response = await postPipeline(
      new NextRequest(`http://localhost/api/project/${projectId}/pipeline`, { method: "POST", body: "{}" }),
      { params: Promise.resolve({ id: projectId }) },
    );

    expect(response.status).toBe(202);
    expect(state.start).toHaveBeenCalledWith(expect.objectContaining({
      projectId,
      origin: "http://localhost",
    }));
  });

  it("links a completed Kling job whose local import failed without removing the project or its files", async () => {
    job({ remoteState: "completed", importState: "failed" });
    const response = await deleteProject(new NextRequest("http://localhost/api/project/project-a", { method: "DELETE", headers: { "accept-language": "en" } }), { params: Promise.resolve({ id: "project-a" }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "Resolve this project's generation tasks before deleting it",
      code: "PROJECT_HAS_UNRESOLVED_KLING_TASKS",
      blockingTasks: [{ kind: "kling_job", id: "job-run", href: "/project/project-a/assets?klingJob=job-run" }],
    });
    expect(db.select().from(schema.projects).all()).toHaveLength(2);
    expect(state.remove).not.toHaveBeenCalled();
  });

  it.each([
    { remoteState: "completed", importState: "completed" },
    { remoteState: "failed", importState: "not_ready" },
    { remoteState: "cancelled", importState: "not_ready" },
  ] as const)("allows project deletion when its Kling job is $remoteState/$importState", async (states) => {
    job(states);
    const response = await deleteProject(new NextRequest("http://localhost/api/project/project-a", { method: "DELETE" }), { params: Promise.resolve({ id: "project-a" }) });
    expect(response.status).toBe(200); expect(state.remove).toHaveBeenCalledTimes(2);
    expect(db.select().from(schema.projects).all()).toMatchObject([{ id: "project-b" }]);
  });
});
