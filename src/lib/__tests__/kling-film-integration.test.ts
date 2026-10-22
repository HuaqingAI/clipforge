// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import type Database from "better-sqlite3";
import type { KlingProfile, KlingRunOptions, KlingVideoModelDescriptor } from "@/lib/kling/types";

const state = vi.hoisted(() => ({ directory: "", generatedFixture: "", sqlite: null as Database.Database | null,
  profile: null as KlingProfile | null, cli: vi.fn(), refresh: vi.fn(), download: vi.fn(), tts: vi.fn() }));
vi.mock("@/lib/db", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  state.sqlite = new Database(":memory:");
  const db = drizzle(state.sqlite);
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return { db, getDb: () => db };
});
vi.mock("@/lib/paths", async (original) => ({ ...await original<typeof import("@/lib/paths")>(), getDataDir: () => state.directory,
  getUploadsDir: () => path.join(state.directory, "uploads"), getOutputDir: () => path.join(state.directory, "output") }));
vi.mock("@/lib/kling/auth", () => ({ refreshProfile: (...args: unknown[]) => state.refresh(...args) }));
vi.mock("@/lib/kling/cli-runner", async (original) => ({ ...await original<typeof import("@/lib/kling/cli-runner")>(), runKling: (...args: unknown[]) => state.cli(...args) }));
vi.mock("@/lib/kling/download", () => ({ downloadPublicFile: (...args: unknown[]) => state.download(...args) }));
vi.mock("@/lib/edge-tts", () => ({ generateSpeechFreeDetailed: (...args: unknown[]) => state.tts(...args) }));

import { getDb } from "@/lib/db";
import { projects, scripts, assets, compositions, aiTasks, type Shot } from "@/lib/db/schema";
import { assetScopeForShot } from "@/lib/asset-context";
import { ffmpegBin } from "@/lib/ffmpeg-path";
import { probeMedia } from "@/lib/media-probe";
import { klingProfiles } from "@/lib/kling/profile-schema";
import { klingJobs } from "@/lib/kling/job-schema";
import { KLING_ADAPTER_VERSION, KLING_VERSION, KLING_PACKAGE, KLING_ENDPOINT } from "@/lib/kling/types";
import { getKlingJob, getKlingOutputs } from "@/lib/kling/repository";
import { getKlingFilm, getKlingFilmShots } from "@/lib/kling/film-repository";
import { previewKlingFilm, verifyKlingFilmFiles } from "@/lib/kling/film-plan";
import { contentHash } from "@/lib/kling/inputs";
import { withKlingLease } from "@/lib/kling/cli-runner";
import { startKlingFilm, runKlingFilmTick, stopKlingFilmRunner } from "@/lib/kling/films";
import { queryKlingJob, stopKlingJobRunner } from "@/lib/kling/jobs";
import { GET as getVideo } from "@/app/api/output/[...path]/route";
import { GET as getAsset } from "@/app/api/files/[...path]/route";

const runFile = promisify(execFile);
const oldPhase = process.env.NEXT_PHASE;
const profileId = randomUUID();
const model: KlingVideoModelDescriptor = { selectionKey: '["kling-cli","image_to_video","fixture-model"]', provider: "kling-cli", profileId, region: "global", tool: "image_to_video", remoteModelId: "fixture-model", displayName: "Offline fixture", catalogRevision: "fixture-catalog", available: true,
  parameters: [{ name: "duration", required: true, type: "number", allowedValues: [1], default: 1 }, { name: "audio", required: true, type: "boolean", allowedValues: [true, false], default: true }, { name: "aspect_ratio", required: true, type: "string", allowedValues: ["16:9"], default: "16:9" }],
  inputSlots: [{ name: "image", role: "image", required: true }], capabilities: { image: true, tailFrame: false, multiImage: false, audio: true } };
const shots: Shot[] = [1, 2].map((shotId) => ({ shotId, type: "demo", duration: 1, description: `Product detail ${shotId}`, camera: "static", visualSource: "ai_generate", transition: "direct_concat", voiceover: "" }));

beforeAll(async () => {
  process.env.NEXT_PHASE = "phase-production-build";
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("This integration test must remain offline"); }));
  state.directory = await fs.mkdtemp(path.join(os.tmpdir(), "clipforge-kling-film-integration-"));
  const fixtureDir = path.join(state.directory, "fixtures");
  const uploadDir = path.join(state.directory, "uploads", "project");
  await fs.mkdir(fixtureDir, { recursive: true }); await fs.mkdir(uploadDir, { recursive: true });
  const reusedVideo = path.join(uploadDir, "existing.mp4");
  state.generatedFixture = path.join(fixtureDir, "generated.mp4");
  for (const [destination, color, frequency] of [[reusedVideo, "blue", "440"], [state.generatedFixture, "orange", "880"]]) {
    await runFile(ffmpegBin(), ["-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=320x180:r=24:d=1`, "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=1`, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "1", destination], { timeout: 30_000 });
  }
  for (const extension of ["png", "webp"]) {
    await runFile(ffmpegBin(), ["-nostdin", "-y", "-v", "error", "-i", state.generatedFixture, "-frames:v", "1", path.join(fixtureDir, `keyframe.${extension}`)], { timeout: 30_000 });
  }
  const now = Date.now();
  state.profile = { id: profileId, label: "Offline test account", region: "global", cliPackage: KLING_PACKAGE, cliVersion: KLING_VERSION, adapterVersion: KLING_ADAPTER_VERSION, nodePath: process.execPath, packagePath: fixtureDir, cliEntry: path.join(fixtureDir, "cli.js"), homePath: path.join(state.directory, "home"), endpoint: KLING_ENDPOINT,
    environmentState: "ready", authState: "authenticated", authRevision: 1, principalKey: '["global","fixture-account"]', accountSummary: { id: "fixture-account" }, catalogSnapshot: [model], catalogRevision: "fixture-catalog", catalogCheckedAt: now, createdAt: now, updatedAt: now };
  getDb().insert(klingProfiles).values({ id: profileId, data: state.profile }).run();
  state.refresh.mockImplementation(async () => structuredClone(state.profile));
  state.tts.mockImplementation(() => { throw new Error("Native-audio film must not request TTS"); });
  state.download.mockImplementation(async (url: string, destination: string) => {
    expect(url).toBe("https://fixture.invalid/generated.mp4");
    await fs.copyFile(state.generatedFixture, destination);
  });
  state.cli.mockImplementation(async (_profile: KlingProfile, args: string[], options: KlingRunOptions) => {
    if (args[0] === "query_tasks") {
      expect(args).toEqual(["query_tasks", "remote-original"]);
      return { exitCode: 0, signal: null, json: { ok: true, body: { generationId: "remote-original", status: "completed", works: [{ id: "work-original", type: "video", url: "https://fixture.invalid/generated.mp4" }] } }, stdout: "", stderr: "", timedOut: false, aborted: false };
    }
    expect(args[0]).toBe("image_to_video");
    expect(args).toContain("fixture-model"); expect(args).toContain("--image");
    options.lease?.assertOwned(); options.onGenerationId?.("remote-original");
    return { exitCode: 0, signal: null, json: { ok: true, body: { generationId: "remote-original" } }, generationId: "remote-original", stdout: "", stderr: "", timedOut: false, aborted: false };
  });
}, 60_000);
beforeEach(async () => {
  state.sqlite!.exec("DELETE FROM kling_film_shots; DELETE FROM kling_film_runs; DELETE FROM kling_job_outputs; DELETE FROM kling_jobs; DELETE FROM compositions; DELETE FROM ai_tasks; DELETE FROM assets; DELETE FROM scripts; DELETE FROM projects;");
  vi.clearAllMocks();
  for (const extension of ["png", "webp"]) {
    await fs.copyFile(path.join(state.directory, "fixtures", `keyframe.${extension}`), path.join(state.directory, "uploads", "project", `keyframe.${extension}`));
  }
  getDb().insert(projects).values({ id: "project", name: "Offline film integration" }).run();
  const script = getDb().insert(scripts).values({ id: "script", projectId: "project", styleType: "scene", selected: true, shots }).returning().get()!;
  getDb().insert(assets).values({ id: "existing-video", projectId: "project", shotId: 1, type: "user_upload", provider: "local", selected: true, status: "done", filePath: "/api/files/project/existing.mp4", ...assetScopeForShot(script, shots[0]) }).run();
  getDb().insert(assets).values({ id: "keyframe", projectId: "project", shotId: 2, type: "ai_generated", provider: "fixture-images", selected: true, status: "done", filePath: "/api/files/project/keyframe.png", ...assetScopeForShot(script, shots[1]) }).run();
});
afterAll(async () => {
  stopKlingFilmRunner(); stopKlingJobRunner(); await new Promise<void>((resolve) => setImmediate(resolve));
  state.sqlite?.close(); if (state.directory) await fs.rm(state.directory, { recursive: true, force: true });
  vi.unstubAllGlobals(); if (oldPhase === undefined) delete process.env.NEXT_PHASE; else process.env.NEXT_PHASE = oldPhase;
});

describe("offline real Kling film pipeline", () => {
  it("runs ten original child jobs concurrently and starts the eleventh after a cloud completion", async () => {
    const expanded = Array.from({ length: 11 }, (_, index) => index + 1).map((shotId) => ({ ...shots[0], shotId, description: `Product detail ${shotId}` }));
    getDb().delete(assets).run();
    const script = getDb().update(scripts).set({ shots: expanded }).where(eq(scripts.id, "script")).returning().get()!;
    for (const shot of expanded) getDb().insert(assets).values({ id: `keyframe-${shot.shotId}`, projectId: "project", shotId: shot.shotId, type: "ai_generated", provider: "fixture-images", selected: true, status: "done", filePath: "/api/files/project/keyframe.png", ...assetScopeForShot(script, shot) }).run();
    const originalCli = state.cli.getMockImplementation();
    let submitted = 0;
    state.cli.mockImplementation(async (_profile: KlingProfile, args: string[], options: KlingRunOptions) => {
      if (args[0] === "query_tasks") {
        expect(args).toEqual(["query_tasks", "parallel-original-1"]);
        return { exitCode: 0, signal: null, json: { ok: true, body: { generationId: args[1], status: "completed", works: [{ id: "parallel-work-1", type: "video", url: "https://fixture.invalid/generated.mp4" }] } }, stdout: "", stderr: "", timedOut: false, aborted: false };
      }
      expect(args[0]).toBe("image_to_video");
      options.lease?.assertOwned();
      const generationId = `parallel-original-${++submitted}`;
      options.onGenerationId?.(generationId);
      return { exitCode: 0, signal: null, json: { ok: true, body: { generationId } }, generationId, stdout: "", stderr: "", timedOut: false, aborted: false };
    });
    try {
      const preview = await previewKlingFilm({ projectId: "project", scriptId: "script", profileId, selectionKey: model.selectionKey,
        output: { resolution: "720p", aspectRatio: "16:9", audioStrategy: "native", subtitles: false } });
      expect(preview.billableShotCount).toBe(11);
      await startKlingFilm({ planId: preview.runId, planHash: preview.planHash, clientRequestId: "parallel-integration-start", explicitConfirmation: true,
        billingAcknowledgement: { policyRevision: "film-credits-v1", acceptedForPlanHash: preview.planHash } });
      await runKlingFilmTick();
      const children = getDb().select().from(klingJobs).all();
      expect(children).toHaveLength(10);
      expect(children.map((job) => job.submissionState)).toEqual(Array(10).fill("acknowledged"));
      expect(new Set(children.map((job) => job.remoteGenerationId))).toEqual(new Set(Array.from({ length: 10 }, (_, index) => `parallel-original-${index + 1}`)));
      expect(getKlingFilm(preview.runId).status).toBe("running");
      expect(getKlingFilmShots(preview.runId)[10].jobId).toBeNull();
      await runKlingFilmTick();
      expect(submitted).toBe(10);
      const first = children.find((job) => job.remoteGenerationId === "parallel-original-1")!;
      const firstTask = getDb().select().from(aiTasks).where(eq(aiTasks.id, first.data.aiTaskId!)).get()!;
      await withKlingLease(state.profile!, async () => {
        await expect(queryKlingJob(first.id)).rejects.toMatchObject({ code: "KLING_PROFILE_BUSY" });
      });
      expect(getKlingJob(first.id)).toMatchObject({ submissionState: "acknowledged", remoteGenerationId: "parallel-original-1", remoteState: first.remoteState });
      expect(getKlingJob(first.id).data.error).toBeUndefined();
      expect(getKlingJob(first.id).data.blockedReason).toBeUndefined();
      expect(getKlingJob(first.id).nextQueryAt).toBeGreaterThan(Date.now());
      expect(getDb().select().from(aiTasks).where(eq(aiTasks.id, firstTask.id)).get()).toMatchObject({ status: firstTask.status, error: firstTask.error });
      await runKlingFilmTick();
      expect(getKlingFilm(preview.runId).status).toBe("running");
      expect(submitted).toBe(10);
      expect(getKlingFilmShots(preview.runId).slice(0, 10).every((shot) => shot.status === "generating")).toBe(true);
      expect(getKlingFilmShots(preview.runId)[10].jobId).toBeNull();
      await queryKlingJob(first.id);
      await runKlingFilmTick();
      expect(submitted).toBe(11);
      const eleventhJob = getKlingJob(getKlingFilmShots(preview.runId)[10].jobId!);
      expect(eleventhJob).toMatchObject({ submissionState: "acknowledged", remoteGenerationId: "parallel-original-11" });
      expect(getKlingFilmShots(preview.runId)[0].status).toBe("ready");
      expect(getKlingFilm(preview.runId).status).toBe("running");
      expect(getDb().select().from(compositions).all()).toHaveLength(0);
    } finally {
      state.cli.mockImplementation(originalCli!);
    }
  }, 60_000);

  it.each(["png", "webp"])("reuses one video and runs a %s keyframe through child submission, import, composition and seekable playback idempotently", async (extension) => {
    const sourceUrl = `/api/files/project/keyframe.${extension}`;
    const sourcePath = path.join(state.directory, "uploads", "project", `keyframe.${extension}`);
    const originalBytes = await fs.readFile(sourcePath);
    getDb().update(assets).set({ filePath: sourceUrl }).where(eq(assets.id, "keyframe")).run();
    const preview = await previewKlingFilm({ projectId: "project", scriptId: "script", profileId, selectionKey: model.selectionKey, reuseExistingVideos: true,
      output: { resolution: "720p", aspectRatio: "16:9", audioStrategy: "native", subtitles: false } });
    expect(preview).toMatchObject({ billableShotCount: 1, missingKeyframes: [], readyShots: 1 });
    expect(preview.shots.map((shot) => shot.source)).toEqual(["reuse", "generate"]);
    const preparedInput = getKlingFilmShots(preview.runId)[1].data.inputs[0];
    expect(preparedInput.sourceUrl).toBe(sourceUrl);
    expect(preparedInput.path).toMatch(/\.png$/);
    const uploadedBytes = await fs.readFile(preparedInput.path);
    expect(uploadedBytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(preparedInput.hash).toBe(contentHash(uploadedBytes));
    expect(preparedInput.size).toBe(uploadedBytes.length);
    if (extension === "webp") {
      expect(preparedInput.sourceHash).toBe(contentHash(originalBytes));
      expect(preparedInput.hash).not.toBe(preparedInput.sourceHash);
    } else {
      expect(preparedInput.sourceHash ?? preparedInput.hash).toBe(contentHash(originalBytes));
    }
    expect(await fs.readFile(sourcePath)).toEqual(originalBytes);
    expect((await probeMedia(preparedInput.path)).width).toBe(320);
    await verifyKlingFilmFiles(preview.runId);
    const startRequest = { planId: preview.runId, planHash: preview.planHash, clientRequestId: "integration-start", explicitConfirmation: true,
      billingAcknowledgement: { policyRevision: "film-credits-v1", acceptedForPlanHash: preview.planHash } };
    await startKlingFilm(startRequest); await startKlingFilm(startRequest);
    await runKlingFilmTick();
    let run = getKlingFilm(preview.runId);
    expect(run.status, run.data.error).toBe("running");
    const child = getDb().select().from(klingJobs).get()!;
    expect(child).toMatchObject({ shotId: 2, submissionState: "acknowledged", remoteGenerationId: "remote-original", data: { filmRunId: preview.runId, filmShotId: preview.shots[1].id } });
    expect(child.data.inputs[0].hash).toBe(preparedInput.hash);
    expect(child.data.inputs[0].sourceHash).toBe(preparedInput.sourceHash);
    expect(child.data.inputs[0].path).not.toBe(preparedInput.path);
    expect(getDb().select().from(aiTasks).all()).toHaveLength(1);
    await runKlingFilmTick(); // Acknowledged job waits; no new generation is allowed.
    await queryKlingJob(child.id);
    expect(getKlingJob(child.id)).toMatchObject({ remoteState: "completed", importState: "completed" });
    const output = getKlingOutputs(child.id)[0];
    expect(output).toMatchObject({ importState: "imported", workKey: "work-original", data: { selectionOutcome: "selected" } });
    const savedAsset = getDb().select().from(assets).where(eq(assets.id, output.assetId!)).get()!;
    expect(savedAsset).toMatchObject({ selected: true, shotId: 2, provider: "kling-cli", sourceScriptId: "script" });
    expect((await probeMedia(output.data.localPath!)).hasAudio).toBe(true);
    expect(getDb().select().from(assets).where(eq(assets.id, "keyframe")).get()?.selected).toBe(false);
    await runKlingFilmTick(); // Adopts the imported child, then runs the real local composer.
    run = getKlingFilm(preview.runId);
    expect(run.status, run.data.error).toBe("completed");
    expect(getKlingFilmShots(run.id).every((shot) => shot.status === "ready")).toBe(true);
    const composition = getDb().select().from(compositions).get()!;
    expect(composition).toMatchObject({ id: run.data.compositionId, status: "done" });
    const probe = await probeMedia(composition.outputPath!);
    expect(probe).toMatchObject({ width: 1280, height: 720, hasAudio: true, videoCodec: "h264" });
    expect(probe.duration).toBeCloseTo(2, 1);
    expect(run.data.videoUrl).toBe(`/api/output/project/kling-film-${composition.id}.mp4`);
    const playback = await getVideo(new NextRequest(`http://127.0.0.1:3000${run.data.videoUrl}`, { headers: { Range: "bytes=0-63" } }), { params: Promise.resolve({ path: ["project", `kling-film-${composition.id}.mp4`] }) });
    expect(playback.status).toBe(206); expect(playback.headers.get("Content-Type")).toBe("video/mp4");
    expect((await playback.arrayBuffer()).byteLength).toBe(64);
    const assetPath = savedAsset.filePath!.slice("/api/files/".length).split("/");
    const shotPlayback = await getAsset(new NextRequest(`http://127.0.0.1:3000${savedAsset.filePath}`, { headers: { Range: "bytes=0-31" } }), { params: Promise.resolve({ path: assetPath }) });
    expect(shotPlayback.status).toBe(206); expect((await shotPlayback.arrayBuffer()).byteLength).toBe(32);
    const before = (await fs.stat(composition.outputPath!)).mtimeMs;
    await runKlingFilmTick(); await runKlingFilmTick(); await startKlingFilm(startRequest);
    expect((await fs.stat(composition.outputPath!)).mtimeMs).toBe(before);
    expect(getDb().select().from(compositions).all()).toHaveLength(1);
    expect(getDb().select().from(klingJobs).all()).toHaveLength(1);
    expect(state.cli.mock.calls.filter(([, args]) => args[0] === "image_to_video")).toHaveLength(1);
    expect(state.download).toHaveBeenCalledOnce(); expect(state.tts).not.toHaveBeenCalled();
  }, 60_000);
  it.each(["original", "snapshot"])("blocks a WebP film before submission if its %s changes after preview", async (changedFile) => {
    const originalPath = path.join(state.directory, "uploads", "project", "keyframe.webp");
    getDb().update(assets).set({ filePath: "/api/files/project/keyframe.webp" }).where(eq(assets.id, "keyframe")).run();
    const preview = await previewKlingFilm({ projectId: "project", scriptId: "script", profileId, selectionKey: model.selectionKey,
      output: { resolution: "720p", aspectRatio: "16:9", audioStrategy: "native", subtitles: false } });
    const input = getKlingFilmShots(preview.runId)[1].data.inputs[0];
    expect(input.sourceHash).not.toBe(input.hash);
    await fs.appendFile(changedFile === "original" ? originalPath : input.path, "changed after preview");
    await expect(verifyKlingFilmFiles(preview.runId)).rejects.toMatchObject({ code: "KLING_INPUT_CHANGED" });
    await expect(startKlingFilm({ planId: preview.runId, planHash: preview.planHash, clientRequestId: "changed-input-start", explicitConfirmation: true,
      billingAcknowledgement: { policyRevision: "film-credits-v1", acceptedForPlanHash: preview.planHash } })).rejects.toMatchObject({ code: "KLING_INPUT_CHANGED" });
    expect(getDb().select().from(klingJobs).all()).toHaveLength(0);
    expect(state.cli).not.toHaveBeenCalled();
  }, 30_000);
});
