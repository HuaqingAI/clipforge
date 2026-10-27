// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { eq } from "drizzle-orm";
import type Database from "better-sqlite3";
import type { KlingProfile, KlingVideoModelDescriptor } from "@/lib/kling/types";
import type { KlingFilmShotContext } from "@/lib/kling/jobs";
import type { KlingSubmitRequest } from "@/lib/kling/job-types";

const state = vi.hoisted(() => ({ sqlite: null as Database.Database | null, profile: null as KlingProfile | null,
  refresh: vi.fn(), verify: vi.fn(), create: vi.fn(), dispatch: vi.fn(), query: vi.fn(), compose: vi.fn() }));
vi.mock("@/lib/db", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  state.sqlite = new Database(":memory:");
  const db = drizzle(state.sqlite); migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return { db, getDb: () => db };
});
vi.mock("@/lib/kling/auth", () => ({ refreshProfile: (...args: unknown[]) => state.refresh(...args) }));
vi.mock("@/lib/kling/jobs", () => ({ createKlingFilmShotJob: (...args: unknown[]) => state.create(...args), dispatchKlingFilmShotJob: (...args: unknown[]) => state.dispatch(...args), queryKlingJob: (...args: unknown[]) => state.query(...args), startKlingJobRunner() {}, wakeKlingJobRunner() {} }));
vi.mock("@/lib/kling/film-plan", async (original) => ({ ...await original<typeof import("@/lib/kling/film-plan")>(), verifyKlingFilmFiles: (...args: unknown[]) => state.verify(...args) }));
vi.mock("@/lib/kling/film-compose", () => ({ composeKlingFilm: (...args: unknown[]) => state.compose(...args) }));

import { getDb } from "@/lib/db";
import { assets, projects, scripts, type Shot } from "@/lib/db/schema";
import { assetScopeForShot, scriptRevision } from "@/lib/asset-context";
import { klingProfiles } from "@/lib/kling/profile-schema";
import { klingJobs, klingJobOutputs } from "@/lib/kling/job-schema";
import { klingFilmRuns, klingFilmShots } from "@/lib/kling/film-schema";
import { getKlingJob, patchKlingJob } from "@/lib/kling/repository";
import { getKlingFilm, getKlingFilmShots, patchKlingFilm, withoutKlingFilmLease } from "@/lib/kling/film-repository";
import { startKlingFilm, klingFilmAction, runKlingFilmTick, stopKlingFilmRunner } from "@/lib/kling/films";
import { KlingError } from "@/lib/kling/errors";

const model: KlingVideoModelDescriptor = { selectionKey: '["kling-cli","text_to_video","model"]', provider: "kling-cli", profileId: "profile", region: "global", tool: "text_to_video", remoteModelId: "model", displayName: "Model", catalogRevision: "catalog", available: true, parameters: [], inputSlots: [], capabilities: { image: false, tailFrame: false, multiImage: false, audio: false } };
const shots: Shot[] = [1, 2].map((shotId) => ({ shotId, type: "demo", duration: 5, description: `Product shot ${shotId}`, camera: "static", visualSource: "ai_generate", transition: "direct_concat", voiceover: `Narration ${shotId}` }));
const oldPhase = process.env.NEXT_PHASE;
function confirmation() { return { explicitConfirmation: true, planHash: "plan-hash", billingAcknowledgement: { policyRevision: "film-credits-v1", acceptedForPlanHash: "plan-hash" } }; }
function start() { return startKlingFilm({ planId: "film", clientRequestId: "start-request", ...confirmation() }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

function completeShot(shotId: number) {
  const db = getDb();
  const shot = getKlingFilmShots("film").find((row) => row.shotId === shotId)!;
  const job = getKlingJob(shot.jobId!);
  const script = db.select().from(scripts).where(eq(scripts.id, "script")).get()!;
  const assetId = `asset-${shotId}`;
  db.insert(assets).values({ id: assetId, projectId: "project", shotId, type: "ai_generated", provider: "kling-cli", filePath: `/api/files/shot-${shotId}.mp4`, selected: true, ...assetScopeForShot(script, script.shots!.find((item) => item.shotId === shotId)!) }).run();
  db.insert(klingJobOutputs).values({ id: `output-${shotId}`, jobId: job.id, workKey: `work-${shotId}`, importState: "imported", assetId, data: { url: "https://cdn.example/video.mp4", urlObtainedAt: Date.now(), providerWorkId: `work-${shotId}`, filePath: `/api/files/shot-${shotId}.mp4`, localPath: `/fixture/shot-${shotId}.mp4`, contentHash: `hash-${shotId}` }, createdAt: Date.now(), updatedAt: Date.now() }).run();
  patchKlingJob(job.id, { remoteState: "completed", importState: "completed" });
}

function useElevenShots() {
  const expanded = Array.from({ length: 11 }, (_, index) => index + 1).map((shotId) => ({ ...shots[0], shotId, description: `Product shot ${shotId}`, voiceover: `Narration ${shotId}` }));
  const script = getDb().update(scripts).set({ shots: expanded }).where(eq(scripts.id, "script")).returning().get()!;
  patchKlingFilm("film", {}, { scriptRevision: scriptRevision(script), scriptSnapshot: { shots: expanded } });
  getDb().delete(klingFilmShots).where(eq(klingFilmShots.runId, "film")).run();
  for (const [ordinal, shot] of expanded.entries()) getDb().insert(klingFilmShots).values({ id: `film-shot-${shot.shotId}`, runId: "film", shotId: shot.shotId, ordinal, status: "waiting", data: { shot, source: "generate", prompt: shot.description, options: {}, missingKeyframe: false, inputs: [], baselineAssetId: null, attempt: 0 }, updatedAt: Date.now() }).run();
}

beforeEach(() => {
  vi.stubEnv("CLIPFORGE_RUNTIME", ""); vi.stubEnv("CLIPFORGE_KLING_DISABLED", "");
  process.env.NEXT_PHASE = "phase-production-build"; stopKlingFilmRunner();
  state.sqlite!.exec("DELETE FROM kling_film_shots; DELETE FROM kling_film_runs; DELETE FROM kling_job_outputs; DELETE FROM kling_jobs; DELETE FROM assets; DELETE FROM scripts; DELETE FROM projects; DELETE FROM kling_profiles;");
  vi.clearAllMocks();
  const now = Date.now();
  state.profile = { id: "profile", label: "Test", region: "global", cliPackage: "@klingai/cli-global", cliVersion: "0.2.0", adapterVersion: "1", nodePath: process.execPath, packagePath: "/fixture", cliEntry: "/fixture/cli.js", homePath: "/fixture/home", endpoint: "https://kling.ai/mcp", environmentState: "ready", authState: "authenticated", authRevision: 1, principalKey: "principal", catalogSnapshot: [model], catalogRevision: "catalog", catalogCheckedAt: now, createdAt: now, updatedAt: now };
  getDb().insert(klingProfiles).values({ id: "profile", data: state.profile }).run();
  getDb().insert(projects).values({ id: "project", name: "Product" }).run();
  const script = getDb().insert(scripts).values({ id: "script", projectId: "project", styleType: "scene", shots, selected: true }).returning().get()!;
  getDb().insert(klingFilmRuns).values({ id: "film", projectId: "project", scriptId: "script", profileId: "profile", principalKey: "principal", status: "draft", data: { scriptRevision: scriptRevision(script), scriptSnapshot: { shots }, model, output: { resolution: "720p", aspectRatio: "9:16", audioStrategy: "edge-tts", voice: "zh-CN-XiaoxiaoNeural", subtitles: true }, planHash: "plan-hash", expiresAt: now + 900_000, reuseExistingVideos: true, warnings: [], stage: "Preview", authorizationEpoch: 0 }, createdAt: now, updatedAt: now }).run();
  for (const [ordinal, shot] of shots.entries()) getDb().insert(klingFilmShots).values({ id: `film-shot-${shot.shotId}`, runId: "film", shotId: shot.shotId, ordinal, status: "waiting", data: { shot, source: "generate", prompt: shot.description, options: {}, missingKeyframe: false, inputs: [], baselineAssetId: null, attempt: 0 }, updatedAt: now }).run();
  state.refresh.mockImplementation(async () => structuredClone(state.profile));
  state.verify.mockResolvedValue(undefined);
  state.create.mockImplementation(async (request: KlingSubmitRequest, context: KlingFilmShotContext) => {
    const shot = getKlingFilmShots(context.filmRunId).find((item) => item.id === context.filmShotId)!;
    const id = `job-${shot.shotId}-${shot.data.attempt}`;
    getDb().insert(klingJobs).values({ id, profileId: "profile", principalKey: "principal", region: "global", clientRequestId: request.clientRequestId, projectId: "project", scriptId: "script", shotId: shot.shotId, submissionState: "prepared", remoteState: "not_started", importState: "not_ready", data: { scriptRevision: scriptRevision(script), shotKey: "key", expectedSelectedAssetId: null, payloadHash: "hash", requestHash: "hash", model, prompt: request.prompt, options: {}, inputs: [], args: [], cliVersion: "0.2.0", adapterVersion: "1", authorizedBootId: "boot", authorizedUntil: Date.now() + 900_000, authorizationEpoch: 1, billingAcknowledgedAt: now, queryAttempts: 0, filmRunId: context.filmRunId, filmShotId: context.filmShotId, filmAuthorizationEpoch: context.authorizationEpoch }, createdAt: now, updatedAt: now }).run();
    return getKlingJob(id);
  });
  state.dispatch.mockImplementation(async (id: string, grant: KlingFilmShotContext & { assertDispatchAllowed(): void }) => {
    grant.assertDispatchAllowed();
    return patchKlingJob(id, { submissionState: "acknowledged", remoteState: "processing", remoteGenerationId: `remote-${id}` });
  });
  state.query.mockResolvedValue(undefined);
  state.compose.mockImplementation(async () => ({ compositionId: getKlingFilm("film").data.compositionId, url: "/api/files/film.mp4", thumbnailUrl: "/api/files/poster.jpg", quality: { width: 720, height: 1280, duration: 10, hasAudio: true } }));
});
afterEach(() => { stopKlingFilmRunner(); vi.unstubAllEnvs(); });
afterAll(() => { stopKlingFilmRunner(); state.sqlite?.close(); if (oldPhase === undefined) delete process.env.NEXT_PHASE; else process.env.NEXT_PHASE = oldPhase; });

describe("durable Kling film runner", () => {
  it("requires acknowledgement and starts the same plan idempotently", async () => {
    await expect(startKlingFilm({ planId: "film", clientRequestId: "request", explicitConfirmation: true, planHash: "plan-hash" })).rejects.toMatchObject({ code: "KLING_BILLING_ACK_REQUIRED" });
    const first = await start(); const second = await start();
    expect(second.runId).toBe(first.runId);
    expect(getKlingFilm("film").clientRequestId).toBe("start-request");
    await expect(startKlingFilm({ planId: "film", clientRequestId: "different-request", ...confirmation() })).rejects.toMatchObject({ code: "KLING_REQUEST_CONFLICT" });
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  it("starts and dispatches despite a stale local unsupported-model flag", async () => {
    state.profile!.catalogSnapshot = [{ ...model, available: false, disabledReason: "capability not confirmed" }];
    await start();
    await runKlingFilmTick();
    expect(state.dispatch).toHaveBeenCalledTimes(2);
    expect(getKlingFilm("film").status).toBe("running");
  });

  it("overlaps independent cloud jobs and composes only after every original job has imported", async () => {
    vi.stubEnv("APP_MIGRATIONS_DIR", "standalone-migrations");
    await start(); await runKlingFilmTick(); await runKlingFilmTick();
    expect(state.create).toHaveBeenCalledTimes(2); expect(state.dispatch).toHaveBeenCalledTimes(2); expect(state.compose).not.toHaveBeenCalled();
    completeShot(1); await runKlingFilmTick();
    expect(state.create).toHaveBeenCalledTimes(2); expect(state.dispatch).toHaveBeenCalledTimes(2); expect(state.compose).not.toHaveBeenCalled();
    completeShot(2); await runKlingFilmTick();
    expect(state.compose).toHaveBeenCalledOnce();
    expect(getKlingFilm("film")).toMatchObject({ status: "completed", data: { videoUrl: "/api/files/film.mp4" } });
  });

  it.each([["CLIPFORGE_KLING_DISABLED", "1"], ["CLIPFORGE_RUNTIME", "desktop"]])("does not dispatch an active film in a disabled runtime: %s", async (name, value) => {
    await start(); vi.stubEnv(name, value); await runKlingFilmTick();
    expect(state.create).not.toHaveBeenCalled(); expect(state.dispatch).not.toHaveBeenCalled(); expect(state.compose).not.toHaveBeenCalled();
  });

  it("acknowledges ten shots before any finish and releases a cloud slot before local import", async () => {
    useElevenShots();
    await start(); await runKlingFilmTick();
    expect(state.create).toHaveBeenCalledTimes(10); expect(state.dispatch).toHaveBeenCalledTimes(10);
    expect(getKlingFilmShots("film").slice(0, 10).map((shot) => getKlingJob(shot.jobId!).remoteState)).toEqual(Array(10).fill("processing"));
    expect(getKlingFilmShots("film")[10].jobId).toBeNull();
    await runKlingFilmTick();
    expect(state.create).toHaveBeenCalledTimes(10); expect(getKlingFilm("film").status).toBe("running");

    patchKlingJob("job-1-0", { remoteState: "completed", importState: "pending" });
    await runKlingFilmTick();
    expect(state.create).toHaveBeenCalledTimes(11); expect(state.dispatch).toHaveBeenCalledTimes(11);
    expect(getKlingFilmShots("film")[10].jobId).toBe("job-11-0");
    expect(getKlingFilmShots("film")[0].status).toBe("generating");
    expect(state.compose).not.toHaveBeenCalled();
  });

  it("reconciles other imported children when an earlier parallel child needs attention", async () => {
    useElevenShots();
    await start(); await runKlingFilmTick();
    patchKlingJob("job-1-0", { submissionState: "submission_unknown", remoteState: "unknown", remoteGenerationId: null });
    completeShot(2);
    await runKlingFilmTick();
    expect(getKlingFilm("film").status).toBe("needs_attention");
    expect(getKlingFilmShots("film")[1].status).toBe("ready");
    expect(getKlingJob("job-3-0").remoteGenerationId).toBe("remote-job-3-0");
    expect(getKlingFilmShots("film")[10].jobId).toBeNull();
    expect(state.dispatch).toHaveBeenCalledTimes(10);
  });

  it("treats a full reservation limit as waiting and retries on a later tick", async () => {
    useElevenShots();
    state.create.mockRejectedValueOnce(new KlingError("KLING_CONCURRENCY_LIMIT", "同时最多生成 10 个镜头", 409));
    await start(); await runKlingFilmTick();
    expect(getKlingFilm("film").status).toBe("running"); expect(state.dispatch).not.toHaveBeenCalled();
    await runKlingFilmTick();
    expect(state.dispatch).toHaveBeenCalledTimes(10); expect(getKlingFilm("film").status).toBe("running");
  });

  it("keeps a prepared child waiting when dispatch temporarily exhausts concurrency", async () => {
    useElevenShots();
    state.dispatch.mockImplementationOnce(async (id: string) => patchKlingJob(id, {}, { error: { code: "KLING_CONCURRENCY_LIMIT", message: "请等待其他镜头", retryable: true } }));
    await start(); await runKlingFilmTick();
    expect(getKlingFilm("film").status).toBe("running");
    expect(getKlingFilmShots("film")[0].status).toBe("generating");
    expect(state.create).toHaveBeenCalledTimes(10);
    await runKlingFilmTick();
    expect(state.create).toHaveBeenCalledTimes(10);
    expect(getKlingJob("job-1-0").submissionState).toBe("acknowledged");
    expect(getKlingFilmShots("film")[10].jobId).toBeNull();
  });

  it("stops new paid dispatches when paused during the first acknowledgement", async () => {
    useElevenShots();
    state.dispatch.mockImplementationOnce(async (id: string, grant: KlingFilmShotContext & { assertDispatchAllowed(): void }) => {
      grant.assertDispatchAllowed();
      const job = patchKlingJob(id, { submissionState: "acknowledged", remoteState: "processing", remoteGenerationId: `remote-${id}` });
      await withoutKlingFilmLease(() => klingFilmAction("film", "pause", {}));
      return job;
    });
    await start(); await runKlingFilmTick();
    expect(getKlingFilm("film").status).toBe("paused");
    expect(state.create).toHaveBeenCalledTimes(1); expect(state.dispatch).toHaveBeenCalledTimes(1);
    expect(getKlingJob("job-1-0").remoteGenerationId).toBe("remote-job-1-0");
  });

  it("rechecks siblings inside the final paid-dispatch guard after async preparation", async () => {
    useElevenShots();
    state.dispatch.mockImplementationOnce(async (id: string, grant: KlingFilmShotContext & { assertDispatchAllowed(): void }) => {
      grant.assertDispatchAllowed();
      return patchKlingJob(id, { submissionState: "acknowledged", remoteState: "processing", remoteGenerationId: `remote-${id}` });
    }).mockImplementationOnce(async (_id: string, grant: KlingFilmShotContext & { assertDispatchAllowed(): void }) => {
      grant.assertDispatchAllowed();
      patchKlingJob("job-1-0", { submissionState: "submission_unknown", remoteState: "unknown", remoteGenerationId: null });
      grant.assertDispatchAllowed();
    });
    await start(); await runKlingFilmTick();
    expect(getKlingFilm("film").status).toBe("needs_attention");
    expect(getKlingJob("job-2-0").submissionState).toBe("prepared");
    expect(getKlingFilmShots("film")[2].jobId).toBeNull();
    expect(state.create).toHaveBeenCalledTimes(2); expect(state.dispatch).toHaveBeenCalledTimes(2);
  });

  it("resumes ten original cloud IDs after a restart without generating replacements", async () => {
    useElevenShots();
    await start(); await runKlingFilmTick();
    const originalIds = Array.from({ length: 10 }, (_, index) => `job-${index + 1}-0`);
    for (const id of originalIds) patchKlingJob(id, { autoQueryPaused: true });
    patchKlingFilm("film", {}, { authorizationBootId: "earlier-server-boot" });
    await runKlingFilmTick();
    expect(getKlingFilm("film").status).toBe("paused");
    expect(state.dispatch).toHaveBeenCalledTimes(10);
    state.query.mockImplementation(async (id: string) => patchKlingJob(id, { autoQueryPaused: false }));
    await klingFilmAction("film", "resume", confirmation()); await runKlingFilmTick();
    expect(state.query.mock.calls.map(([id]) => id)).toEqual(originalIds);
    expect(state.create).toHaveBeenCalledTimes(10); expect(state.dispatch).toHaveBeenCalledTimes(10);
    expect(getKlingFilmShots("film")[10].jobId).toBeNull();
  });

  it("never creates another job for an unknown submission", async () => {
    state.dispatch.mockImplementationOnce(async (id: string) => patchKlingJob(id, { submissionState: "submission_unknown", remoteState: "unknown", remoteGenerationId: null }));
    await start(); await runKlingFilmTick();
    patchKlingJob("job-1-0", { submissionState: "submission_unknown", remoteState: "unknown", remoteGenerationId: null });
    await runKlingFilmTick(); await runKlingFilmTick();
    expect(getKlingFilm("film").status).toBe("needs_attention");
    await expect(klingFilmAction("film", "retry-shot", { ...confirmation(), shotId: 1 })).rejects.toMatchObject({ code: "KLING_FILM_RETRY_UNSAFE" });
    await expect(klingFilmAction("film", "resume", confirmation())).rejects.toMatchObject({ code: "KLING_FILM_NEEDS_ATTENTION" });
    expect(state.create).toHaveBeenCalledTimes(1); expect(state.dispatch).toHaveBeenCalledTimes(1);
  });

  it("allows a new attempt only for a definitely failed numeric shot id, with fresh billing acknowledgement", async () => {
    await start(); await runKlingFilmTick();
    patchKlingJob("job-1-0", { remoteState: "failed" }); await runKlingFilmTick();
    await expect(klingFilmAction("film", "retry-shot", { explicitConfirmation: true, planHash: "plan-hash", shotId: 1 })).rejects.toMatchObject({ code: "KLING_BILLING_ACK_REQUIRED" });
    await klingFilmAction("film", "retry-shot", { ...confirmation(), shotId: 1 }); await runKlingFilmTick();
    expect(getKlingFilmShots("film")[0]).toMatchObject({ jobId: "job-1-1", data: { attempt: 1 } });
    expect(state.dispatch).toHaveBeenCalledTimes(3);
    expect(getKlingJob("job-1-0").remoteState).toBe("failed");
  });

  it("requires billing acknowledgement to resume unsubmitted shots", async () => {
    await start(); await klingFilmAction("film", "pause", {});
    await expect(klingFilmAction("film", "resume", { explicitConfirmation: true, planHash: "plan-hash" })).rejects.toMatchObject({ code: "KLING_BILLING_ACK_REQUIRED" });
    expect(getKlingFilm("film").status).toBe("paused"); expect(state.dispatch).not.toHaveBeenCalled();
  });

  it("lets pause revoke a worker while it is preparing files, before any paid dispatch", async () => {
    await start();
    const pending = deferred<void>(); const entered = deferred<void>();
    state.verify.mockImplementationOnce(() => { entered.resolve(); return pending.promise; });
    const tick = runKlingFilmTick(); await entered.promise;
    await withoutKlingFilmLease(() => klingFilmAction("film", "pause", {}));
    pending.resolve(); await tick;
    expect(getKlingFilm("film").status).toBe("paused"); expect(state.create).not.toHaveBeenCalled(); expect(state.dispatch).not.toHaveBeenCalled();
  });

  it("lets cancellation during async resume authentication revoke the pending authorization", async () => {
    await start(); await klingFilmAction("film", "pause", {});
    const pending = deferred<KlingProfile>(); const entered = deferred<void>();
    state.refresh.mockImplementationOnce(() => { entered.resolve(); return pending.promise; });
    const resume = klingFilmAction("film", "resume", confirmation()); await entered.promise;
    await withoutKlingFilmLease(() => klingFilmAction("film", "cancel", {}));
    pending.resolve(state.profile!);
    await expect(resume).rejects.toMatchObject({ code: "KLING_FILM_AUTHORIZATION_REVOKED" });
    expect(getKlingFilm("film").status).toBe("cancelled"); expect(state.dispatch).not.toHaveBeenCalled();
  });

  it("pauses a plan from an earlier service boot and requires explicit resume", async () => {
    await start(); patchKlingFilm("film", {}, { authorizationBootId: "earlier-server-boot" });
    await runKlingFilmTick();
    expect(getKlingFilm("film").status).toBe("paused"); expect(state.dispatch).not.toHaveBeenCalled();
    await klingFilmAction("film", "resume", confirmation()); await runKlingFilmTick();
    expect(state.dispatch).toHaveBeenCalledTimes(2);
  });

  it("continues the confirmed film when the same script revision changes", async () => {
    await start(); getDb().update(scripts).set({ version: 2 }).where(eq(scripts.id, "script")).run();
    await runKlingFilmTick();
    expect(getKlingFilm("film").status).toBe("running"); expect(state.dispatch).toHaveBeenCalledTimes(2);
  });

  it("retries a failed local composition without creating any new paid jobs", async () => {
    await start(); await runKlingFilmTick(); completeShot(1); await runKlingFilmTick(); completeShot(2);
    state.compose.mockRejectedValueOnce(new KlingError("KLING_FILM_COMPOSE_FAILED", "Encoder failure", 500));
    await runKlingFilmTick();
    const compositionId = getKlingFilm("film").data.compositionId;
    expect(getKlingFilm("film")).toMatchObject({ status: "needs_attention", data: { error: "Encoder failure" } });
    await klingFilmAction("film", "retry-compose", {}); await runKlingFilmTick();
    expect(getKlingFilm("film")).toMatchObject({ status: "completed", data: { compositionId, videoUrl: "/api/files/film.mp4" } });
    expect(state.create).toHaveBeenCalledTimes(2); expect(state.dispatch).toHaveBeenCalledTimes(2); expect(state.compose).toHaveBeenCalledTimes(2);
  });

  it("preserves cancellation during an in-flight composition instead of publishing completion", async () => {
    await start(); await runKlingFilmTick(); completeShot(1); await runKlingFilmTick(); completeShot(2);
    const pending = deferred<unknown>(); const entered = deferred<void>();
    state.compose.mockImplementationOnce(() => { entered.resolve(); return pending.promise; });
    const tick = runKlingFilmTick(); await entered.promise;
    await withoutKlingFilmLease(() => klingFilmAction("film", "cancel", {}));
    pending.resolve({ videoUrl: "/api/files/cancelled.mp4" }); await tick;
    expect(getKlingFilm("film").status).toBe("cancelled"); expect(getKlingFilm("film").data.videoUrl).toBeUndefined();
  });
});
