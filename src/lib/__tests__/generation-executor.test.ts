// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { GenerationExecutionItem } from "@/lib/generation-types";
import type { KlingJob } from "@/lib/kling/job-schema";

const state = vi.hoisted(() => ({ sqlite: null as Database.Database | null, submit: vi.fn(), script: vi.fn(), grid: vi.fn(), query: vi.fn(), download: vi.fn(), createKling: vi.fn(), retryKling: vi.fn(), startKling: vi.fn(), getKling: vi.fn(), outputs: vi.fn() }));
vi.mock("@/lib/db", async () => {
  const { default: Sqlite } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  state.sqlite = new Sqlite(":memory:"); state.sqlite.pragma("foreign_keys = ON");
  const db = drizzle(state.sqlite); migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return { getDb: () => db };
});
vi.mock("@/lib/providers", () => ({ createProvider: () => ({ getTaskStatus: state.query }) }));
vi.mock("@/app/api/ai/video/route", () => ({ POST: state.submit }));
vi.mock("@/app/api/ai/image/route", () => ({ POST: state.submit }));
vi.mock("@/app/api/llm/script/route", () => ({ POST: state.script }));
vi.mock("@/app/api/topic/script/route", () => ({ POST: state.script }));
vi.mock("@/app/api/project/[id]/storyboard-grid/route", () => ({ POST: state.grid }));
vi.mock("@/lib/kling/jobs", () => ({ createKlingJob: state.createKling, retryKlingImport: state.retryKling, startKlingJobRunner: state.startKling }));
vi.mock("@/lib/kling/repository", () => ({ getKlingJob: state.getKling, getKlingOutputs: state.outputs }));
vi.mock("@/lib/asset-persistence", async (original) => ({ ...await original<typeof import("@/lib/asset-persistence")>(), persistAssetSource: state.download }));
import { getDb } from "@/lib/db";
import { projects, scripts, assets, aiTasks } from "@/lib/db/schema";
import { klingJobs, klingJobOutputs } from "@/lib/kling/job-schema";
import { klingProfiles } from "@/lib/kling/profile-schema";
import { executeGenerationItem } from "@/lib/generation-executor";
import { beforeGenerationSubmission, generationCheckpoint, generationContextCheckpoint } from "@/lib/generation-context";
import { recordAiTask } from "@/lib/ai-tasks";

function item(): GenerationExecutionItem {
  const project = getDb().select().from(projects).get()!;
  const script = getDb().select().from(scripts).get()!;
  return { id: "generation-one", runId: "run-A", projectId: "A", scriptId: "script-A", shotId: 1, kind: "video", checkpoint: null,
    payload: { request: { provider: "mock", model: "test-video", apiKey: "test-secret", prompt: "original" }, asset: { expectedSelectedAssetId: null }, snapshot: { project: project as unknown as Record<string, unknown>, script: script as unknown as Record<string, unknown> } } };
}
function run(input: GenerationExecutionItem) {
  return executeGenerationItem(input, (value) => { input.checkpoint = structuredClone(value); });
}
beforeEach(() => {
  vi.clearAllMocks();
  const db = getDb(); db.delete(klingJobOutputs).run(); db.delete(klingJobs).run(); db.delete(klingProfiles).run(); db.delete(aiTasks).run(); db.delete(assets).run(); db.delete(scripts).run(); db.delete(projects).run();
  db.insert(projects).values({ id: "A", name: "A", productName: "original product" }).run();
  db.insert(scripts).values({ id: "script-A", projectId: "A", selected: true, styleType: "scene", shots: [{ shotId: 1, type: "demo", duration: 5, description: "original", voiceover: "test", camera: "static", visualSource: "ai_generate", transition: "direct_concat" }] }).run();
  state.download.mockReset().mockResolvedValue("/api/files/A/downloaded.png");
  state.submit.mockReset().mockImplementation(async () => { beforeGenerationSubmission(); generationCheckpoint({ taskId: "cloud-paid", videoUrls: ["https://example.test/paid.mp4"], submissionState: "acknowledged" }); return Response.json({ taskId: "cloud-paid", videoUrls: ["https://example.test/paid.mp4"] }); });
  state.query.mockReset(); state.script.mockReset(); state.grid.mockReset(); state.createKling.mockReset(); state.retryKling.mockReset(); state.getKling.mockReset(); state.outputs.mockReset();
});
afterAll(() => state.sqlite?.close());

describe("generation executor recovery", () => {
  it("blocks the first paid submission when a confirmed local reference disappeared", async () => {
    const input = item();
    input.payload.snapshot!.referenceInputs = [{ url: "/api/files/A/missing-confirmed-frame.png", hash: "a".repeat(64) }];
    await expect(run(input)).rejects.toMatchObject({ code: "GENERATION_REFERENCE_UNREADABLE" });
    expect(state.submit).not.toHaveBeenCalled(); expect(state.createKling).not.toHaveBeenCalled();
  });
  it("preserves a known paid output even if its original reference was removed", async () => {
    const input = item();
    input.payload.snapshot!.referenceInputs = [{ url: "/api/files/A/missing-confirmed-frame.png", hash: "a".repeat(64) }];
    input.checkpoint = { taskId: "previously-paid", submissionState: "acknowledged", resultUrls: ["https://example.test/paid.mp4"] };
    expect(await run(input)).toHaveProperty("assetId");
    expect(state.submit).not.toHaveBeenCalled(); expect(state.query).not.toHaveBeenCalled();
  });
  it("records one paid task when the provider route and executor both register the same acceptance", async () => {
    const input = { projectId: "A", shotId: 1, provider: "mock", model: "model", taskId: "one-acceptance" };
    const ids = await Promise.all(Array.from({ length: 20 }, () => recordAiTask(input)));
    expect(new Set(ids).size).toBe(1); expect(ids[0]).toBeTruthy(); expect(getDb().select().from(aiTasks).all()).toHaveLength(1);
  });
  it("retries a failed download using the saved result without generating or querying again", async () => {
    const input = item(); state.download.mockRejectedValueOnce(new Error("download interrupted"));
    await expect(run(input)).rejects.toMatchObject({ code: "GENERATION_IMPORT_FAILED", retryable: true });
    expect(input.checkpoint?.taskId).toBe("cloud-paid");
    const result = await run(input);
    expect(result.assetId).toBeTruthy(); expect(state.submit).toHaveBeenCalledOnce(); expect(state.query).not.toHaveBeenCalled();
    expect(getDb().select().from(assets).all()).toHaveLength(1);
    expect(getDb().select().from(aiTasks).get()).toMatchObject({ taskId: "cloud-paid", importState: "imported", assetId: result.assetId });
  });
  it("imports once even if the worker dies after saving the asset but before saving its completion checkpoint", async () => {
    const input = item();
    await expect(executeGenerationItem(input, (value) => { if (value.completedResult) throw new Error("worker died"); input.checkpoint = structuredClone(value); })).rejects.toThrow("worker died");
    const result = await run(input);
    expect(result.assetId).toBeTruthy(); expect(state.download).toHaveBeenCalledOnce(); expect(state.submit).toHaveBeenCalledOnce();
    expect(getDb().select().from(assets).all()).toHaveLength(1);
  });
  it.each([{ kind: "video" as const, failSecond: true }, { kind: "image" as const, failSecond: false }])("imports every paid $kind output once and keeps only the first selected (second interrupted: $failSecond)", async ({ kind, failSecond }) => {
    const input = item(); input.kind = kind;
    const key = kind === "video" ? "videoUrls" : "imageUrls";
    const urls = ["https://example.test/output-0", "https://example.test/output-1"];
    state.submit.mockImplementationOnce(async () => { beforeGenerationSubmission(); generationCheckpoint({ taskId: "paid-multiple", [key]: urls, submissionState: "acknowledged" }); return Response.json({ taskId: "paid-multiple", [key]: urls }); });
    state.download.mockImplementationOnce(async () => "/api/files/A/output-0.png");
    if (failSecond) state.download.mockRejectedValueOnce(new Error("second download failed"));
    state.download.mockResolvedValueOnce("/api/files/A/output-1.png");
    let firstId: string | undefined;
    if (failSecond) {
      await expect(run(input)).rejects.toMatchObject({ code: "GENERATION_IMPORT_FAILED" });
      firstId = getDb().select().from(assets).get()?.id;
      expect(getDb().select().from(aiTasks).get()).toMatchObject({ importState: "failed", resultUrls: urls });
    }
    const result = await run(input);
    expect(result.assetIds).toHaveLength(2); expect(result.assetId).toBe((result.assetIds as string[])[0]);
    if (firstId) expect(result.assetId).toBe(firstId);
    expect(result[key]).toEqual(["/api/files/A/output-0.png", "/api/files/A/output-1.png"]);
    const saved = getDb().select().from(assets).all(); expect(saved).toHaveLength(2);
    expect(saved.filter((asset) => asset.selected).map((asset) => asset.id)).toEqual([result.assetId]);
    expect(getDb().select().from(aiTasks).get()).toMatchObject({ importState: "imported", resultUrls: urls, assetId: result.assetId });
    expect(await run(input)).toEqual(result); expect(state.submit).toHaveBeenCalledOnce(); expect(state.query).not.toHaveBeenCalled();
    expect(state.download).toHaveBeenCalledTimes(failSecond ? 3 : 2);
  });
  it("recovers a known cloud task through status queries and never submits it again", async () => {
    const input = item(); input.checkpoint = { taskId: "previously-paid", submissionState: "acknowledged" };
    state.query.mockResolvedValueOnce({ taskId: "previously-paid", status: "processing" }).mockResolvedValueOnce({ taskId: "previously-paid", status: "completed", result: { videoUrls: ["https://example.test/completed.mp4"] } });
    expect(await run(input)).toMatchObject({ pending: true });
    expect(await run(input)).toHaveProperty("assetId");
    expect(state.submit).not.toHaveBeenCalled(); expect(state.query).toHaveBeenCalledTimes(2);
  });
  it("requires attention for an ambiguous paid submission, including an ambiguous HTTP429", async () => {
    const interrupted = item(); interrupted.checkpoint = { submissionState: "submitting" };
    await expect(run(interrupted)).rejects.toMatchObject({ code: "GENERATION_NEEDS_ATTENTION", retryable: false });
    expect(state.submit).not.toHaveBeenCalled();
    const rateLimited = item(); state.submit.mockImplementationOnce(async () => { beforeGenerationSubmission(); return Response.json({ error: "rate limit after unknown acceptance" }, { status: 429 }); });
    await expect(run(rateLimited)).rejects.toMatchObject({ code: "GENERATION_NEEDS_ATTENTION" });
    await expect(run(rateLimited)).rejects.toMatchObject({ code: "GENERATION_NEEDS_ATTENTION" });
    expect(state.submit).toHaveBeenCalledOnce();
  });
  it("backs off only a definitively rejected429 and then submits the exact original request", async () => {
    const input = item(); const requests: unknown[] = [];
    state.submit.mockImplementationOnce(async (request: Request) => {
      requests.push(await request.json()); beforeGenerationSubmission(); generationCheckpoint({ submissionState: "not_submitted" });
      return Response.json({ error: "definitely rejected before acceptance" }, { status: 429 });
    }).mockImplementationOnce(async (request: Request) => {
      requests.push(await request.json()); beforeGenerationSubmission(); generationCheckpoint({ taskId: "accepted-after-backoff", submissionState: "acknowledged" });
      return Response.json({ taskId: "accepted-after-backoff" }, { status: 202 });
    });
    expect(await run(input)).toMatchObject({ pending: true, stage: "provider_rate_limited", retryAfterMs: 30000 });
    expect(await run(input)).toMatchObject({ pending: true });
    expect(requests[1]).toEqual(requests[0]); expect(input.checkpoint?.taskId).toBe("accepted-after-backoff");
  });
  it("backs off a definitively rejected storyboard-grid429 while preserving its original request", async () => {
    const input = item(); input.kind = "storyboard_grid"; input.shotId = null;
    const requests: unknown[] = [];
    state.grid.mockImplementationOnce(async (request: Request) => {
      requests.push(await request.json()); beforeGenerationSubmission(); generationCheckpoint({ submissionState: "not_submitted" });
      return Response.json({ error: "grid request rejected before acceptance" }, { status: 429 });
    }).mockImplementationOnce(async (request: Request) => {
      requests.push(await request.json()); beforeGenerationSubmission(); generationCheckpoint({ imageUrls: ["https://example.test/grid.png"], submissionState: "acknowledged" });
      return Response.json({ gridPath: "/api/files/A/grid.png", cells: [{ shotId: 1, filePath: "/api/files/A/cell.png" }] });
    });
    expect(await run(input)).toMatchObject({ pending: true, stage: "provider_rate_limited", retryAfterMs: 30000 });
    expect(await run(input)).toMatchObject({ gridPath: "/api/files/A/grid.png" });
    expect(requests[1]).toEqual(requests[0]); expect(state.grid).toHaveBeenCalledTimes(2);
    expect(await run(input)).toHaveProperty("gridPath"); expect(state.grid).toHaveBeenCalledTimes(2);
  });
  it.each([400, 401, 403])("marks a definitive upstream%s rejection as failed rather than ambiguous", async (status) => {
    const input = item();
    state.submit.mockImplementationOnce(async () => { beforeGenerationSubmission(); generationCheckpoint({ submissionState: "not_submitted" }); return Response.json({ code: "API_ERROR", error: "definitively rejected" }, { status }); });
    await expect(run(input)).rejects.toMatchObject({ code: "API_ERROR", retryable: false });
    expect(input.checkpoint?.submissionState).toBe("not_submitted"); expect(state.query).not.toHaveBeenCalled();
  });
  it("completes from a saved historical script even when the route returns a context conflict", async () => {
    const input = item(); input.kind = "script"; input.shotId = null;
    state.script.mockImplementationOnce(async () => {
      beforeGenerationSubmission();
      getDb().insert(scripts).values({ id: "historical-script", projectId: "A", selected: false, styleType: "scene", shots: [], generationMetadata: { requestId: input.id } as never }).run();
      return Response.json({ error: "project changed; saved as history" }, { status: 409 });
    });
    expect(await run(input)).toMatchObject({ historical: true, scripts: [expect.objectContaining({ id: "historical-script", selected: false })] });
    expect(await run(input)).toHaveProperty("scripts"); expect(state.script).toHaveBeenCalledOnce();
    expect(getDb().select().from(scripts).where(eq(scripts.id, "script-A")).get()?.selected).toBe(true);
  });
  it.each(["/api/llm/script", "/api/topic/script"])("recovers the paid scripts after a database save failure through %s without rebilling", async (endpoint) => {
    const input = item(); input.kind = "script"; input.shotId = null;
    input.payload.request.generationEndpoint = endpoint;
    const generate = vi.fn(async () => [{ title: "Original paid result", shots: getDb().select().from(scripts).get()!.shots! }]);
    state.sqlite!.exec("CREATE TEMP TRIGGER fail_script_save BEFORE INSERT ON scripts WHEN NEW.id = 'recovered-script' BEGIN SELECT RAISE(ABORT, 'temporary save failure'); END");
    state.script.mockImplementation(async (request: Request) => {
      const body = await request.json();
      let generated = generationContextCheckpoint()?.generatedScripts as Awaited<ReturnType<typeof generate>> | undefined;
      if (!generated) { beforeGenerationSubmission(); generated = await generate(); }
      generationCheckpoint({ generatedScripts: generated, submissionState: "acknowledged", stage: "saving" });
      try {
        const saved = getDb().transaction((tx) => {
          tx.update(scripts).set({ selected: false }).where(eq(scripts.projectId, "A")).run();
          return tx.insert(scripts).values({ id: "recovered-script", projectId: "A", selected: true, styleType: "scene", title: generated![0].title,
            shots: generated![0].shots, generationMetadata: { requestId: body.requestId } as never }).returning().get();
        });
        return Response.json({ scripts: [saved] });
      } catch { return Response.json({ error: "temporary save failure" }, { status: 500 }); }
    });
    try {
      await expect(run(input)).rejects.toMatchObject({ code: "GENERATION_IMPORT_FAILED", retryable: true });
      expect(input.checkpoint?.generatedScripts).toEqual(await generate.mock.results[0].value);
      expect(getDb().select().from(scripts).all()).toHaveLength(1);
      expect(getDb().select().from(scripts).get()?.selected).toBe(true);
    } finally { state.sqlite!.exec("DROP TRIGGER fail_script_save"); }
    const result = await run(input);
    expect(result).toMatchObject({ scripts: [expect.objectContaining({ id: "recovered-script", title: "Original paid result", selected: true })] });
    expect(generate).toHaveBeenCalledOnce(); expect(state.script).toHaveBeenCalledTimes(2);
    expect(getDb().select().from(scripts).all()).toHaveLength(2);
    expect(await run(input)).toEqual(result); expect(generate).toHaveBeenCalledOnce();
  });
  it("blocks first submission after its project changed, while retaining an already paid old result as an alternative", async () => {
    const input = item(); getDb().update(projects).set({ productName: "edited product" }).where(eq(projects.id, "A")).run();
    await expect(run(input)).rejects.toMatchObject({ code: "GENERATION_SOURCE_CHANGED" });
    expect(state.submit).not.toHaveBeenCalled();
    input.checkpoint = { taskId: "old-paid", resultUrls: ["https://example.test/old.mp4"] };
    expect(await run(input)).toMatchObject({ selected: false });
  });
  it("keeps a paid result as an alternative when the selected take changed during generation", async () => {
    const input = item(); getDb().insert(assets).values({ id: "new-user-choice", projectId: "A", shotId: 1, type: "user_upload", filePath: "/api/files/A/choice.png", selected: true, status: "done" }).run();
    input.checkpoint = { taskId: "paid", resultUrls: ["https://example.test/old.mp4"] };
    expect(await run(input)).toMatchObject({ selected: false });
    expect(getDb().select().from(assets).where(eq(assets.id, "new-user-choice")).get()?.selected).toBe(true);
  });
  it("retains a paid result under its frozen revision after editing the same script", async () => {
    const input = item(); getDb().update(scripts).set({ shots: [{ ...getDb().select().from(scripts).get()!.shots![0], description: "edited scene" }] }).where(eq(scripts.id, "script-A")).run();
    input.checkpoint = { taskId: "paid", resultUrls: ["https://example.test/old.mp4"] };
    expect(await run(input)).toMatchObject({ selected: false });
  });
  it("finds the same Kling child after child creation committed but the parent checkpoint was lost", async () => {
    const input = item(); input.payload.request = { ...input.payload.request, provider: "kling-cli", profileId: "profile-A" };
    getDb().insert(klingProfiles).values({ id: "profile-A", data: {} as never }).run();
    const job = { id: "same-child", profileId: "profile-A", principalKey: "account", region: "global", clientRequestId: input.id, projectId: "A", scriptId: "script-A", shotId: 1, submissionState: "acknowledged", remoteState: "completed", importState: "completed", remoteGenerationId: "remote-paid", data: {}, createdAt: 1, updatedAt: 1 } as KlingJob;
    getDb().insert(klingJobs).values(job).run();
    state.getKling.mockReturnValue(job); state.outputs.mockReturnValue([{ importState: "imported", assetId: "already-imported", data: { filePath: "/api/files/A/kling/paid.mp4" } }]);
    expect(await run(input)).toMatchObject({ childJobId: "same-child", assetIds: ["already-imported"] });
    expect(input.checkpoint?.childJobId).toBe("same-child"); expect(state.createKling).not.toHaveBeenCalled();
  });
  it.each(["KLING_JOB_BUSY", "KLING_PROFILE_BUSY"])("waits through %s while the Kling runner saves the same result", async (code) => {
    const input = item(); input.payload.request = { ...input.payload.request, provider: "kling-cli", profileId: "profile-A" };
    input.checkpoint = { childJobId: "saved-child" };
    state.getKling.mockReturnValue({ id: "saved-child", submissionState: "acknowledged", remoteState: "completed", remoteGenerationId: "remote-paid", data: {} } as KlingJob);
    state.outputs.mockReturnValueOnce([{ importState: "downloading", data: {} }])
      .mockReturnValue([{ importState: "imported", assetId: "saved-asset", data: { filePath: "/api/files/A/kling/paid.mp4" } }]);
    state.retryKling.mockRejectedValueOnce(Object.assign(new Error("another worker is importing"), { code }));
    expect(await run(input)).toMatchObject({ pending: true, stage: "importing" });
    expect(input.checkpoint?.childJobId).toBe("saved-child");
    expect(await run(input)).toMatchObject({ childJobId: "saved-child", assetIds: ["saved-asset"], videoUrls: ["/api/files/A/kling/paid.mp4"] });
    expect(state.retryKling).toHaveBeenCalledOnce(); expect(state.createKling).not.toHaveBeenCalled();
  });
  it("keeps actual Kling import errors retryable without creating another child", async () => {
    const input = item(); input.payload.request = { ...input.payload.request, provider: "kling-cli", profileId: "profile-A" };
    input.checkpoint = { childJobId: "saved-child" };
    state.getKling.mockReturnValue({ id: "saved-child", submissionState: "acknowledged", remoteState: "completed", data: {} } as KlingJob);
    state.outputs.mockReturnValue([{ importState: "failed", data: {} }]);
    state.retryKling.mockRejectedValueOnce(Object.assign(new Error("download interrupted"), { code: "KLING_DOWNLOAD_FAILED" }));
    await expect(run(input)).rejects.toMatchObject({ code: "GENERATION_IMPORT_FAILED", retryable: true, message: "download interrupted" });
    expect(input.checkpoint?.childJobId).toBe("saved-child"); expect(state.createKling).not.toHaveBeenCalled();
  });
  it("completes an imported Kling result even when automatic queries were paused", async () => {
    const input = item(); input.payload.request = { ...input.payload.request, provider: "kling-cli", profileId: "profile-A" };
    input.checkpoint = { childJobId: "saved-child" };
    state.getKling.mockReturnValue({ id: "saved-child", submissionState: "acknowledged", remoteState: "completed", autoQueryPaused: true, data: {} } as KlingJob);
    state.outputs.mockReturnValue([{ importState: "imported", assetId: "saved-asset", data: { filePath: "/api/files/A/kling/paid.mp4" } }]);
    expect(await run(input)).toMatchObject({ childJobId: "saved-child", assetIds: ["saved-asset"] });
    expect(state.retryKling).not.toHaveBeenCalled(); expect(state.createKling).not.toHaveBeenCalled();
  });
  it("uses the item identity for a new Kling child and keeps ambiguous children attached", async () => {
    const input = item(); input.payload.request = { ...input.payload.request, provider: "kling-cli", profileId: "profile-A", clientRequestId: "browser-id" };
    const job = { id: "child", submissionState: "submission_unknown", data: { error: { message: "unknown acceptance" } } } as KlingJob;
    state.createKling.mockResolvedValue(job); state.getKling.mockReturnValue(job);
    await expect(run(input)).rejects.toMatchObject({ code: "GENERATION_NEEDS_ATTENTION" });
    expect(state.createKling).toHaveBeenCalledWith(expect.objectContaining({ clientRequestId: input.id, billingAcknowledgement: { policyRevision: "credits-v1", acceptedForRequestId: input.id } }));
    await expect(run(input)).rejects.toMatchObject({ code: "GENERATION_NEEDS_ATTENTION" });
    expect(state.createKling).toHaveBeenCalledOnce(); expect(input.checkpoint?.childJobId).toBe("child");
  });
});
