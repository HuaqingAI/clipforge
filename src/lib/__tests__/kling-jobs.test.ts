// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type Database from "better-sqlite3";
import type { KlingCliResult, KlingProfile, KlingRunOptions, KlingVideoModelDescriptor } from "@/lib/kling/types";
import type { KlingSubmitRequest } from "@/lib/kling/job-types";

const state = vi.hoisted(() => ({ directory: "", sqlite: null as Database.Database | null, profile: null as KlingProfile | null,
  profiles: {} as Record<string, KlingProfile>, lease: vi.fn(),
  cli: vi.fn(), refresh: vi.fn(), prepare: vi.fn(), download: vi.fn(), probe: vi.fn(), poster: vi.fn(), lastFrame: vi.fn() }));
vi.mock("@/lib/paths", () => ({ getDataDir: () => state.directory, getUploadsDir: () => path.join(state.directory, "uploads") }));
vi.mock("@/lib/db", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  state.sqlite = new Database(":memory:");
  const db = drizzle(state.sqlite);
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return { db, getDb: () => db };
});
vi.mock("@/lib/kling/profiles", () => ({ getProfile: (id: string) => structuredClone(state.profiles[id] ?? state.profile) }));
vi.mock("@/lib/kling/auth", () => ({ refreshProfile: (...args: unknown[]) => state.refresh(...args) }));
vi.mock("@/lib/kling/cli-runner", () => ({
  runKling: (...args: unknown[]) => state.cli(...args),
  withKlingLease: (...args: unknown[]) => state.lease(...args),
}));
vi.mock("@/lib/kling/inputs", async (original) => ({ ...await original<typeof import("@/lib/kling/inputs")>(), prepareKlingInputs: (...args: unknown[]) => state.prepare(...args) }));
vi.mock("@/lib/kling/download", () => ({ downloadPublicFile: (...args: unknown[]) => state.download(...args) }));
vi.mock("@/lib/media-probe", () => ({ probeMedia: (...args: unknown[]) => state.probe(...args) }));
vi.mock("@/lib/video-composer/frame-extract", () => ({ extractFirstFrame: (...args: unknown[]) => state.poster(...args), extractLastFrame: (...args: unknown[]) => state.lastFrame(...args) }));

import { getDb } from "@/lib/db";
import { projects, scripts, assets, aiTasks, type Shot } from "@/lib/db/schema";
import { klingProfiles } from "@/lib/kling/profile-schema";
import { klingJobs, type KlingJob } from "@/lib/kling/job-schema";
import { deleteKlingJob } from "@/lib/kling/delete-job";
import { klingFilmRuns } from "@/lib/kling/film-schema";
import { createKlingJob, dispatchKlingJob, queryKlingJob, retryKlingImport, runKlingJobTick, stopKlingJobRunner, klingJobAction, bindKlingJob, continueKlingJob,
  createKlingFilmShotJob, dispatchKlingFilmShotJob, type KlingFilmShotContext } from "@/lib/kling/jobs";
import { getKlingJob, getKlingOutputs, patchKlingJob, klingJobView, withKlingJobLease } from "@/lib/kling/repository";
import { importKlingOutputs, selectKlingOutput } from "@/lib/kling/output-import";
import { KlingError } from "@/lib/kling/errors";
import { filterAssetsForScript } from "@/lib/asset-context";
import { createCreativeProfileSnapshot, createPremiumProductCgProfile, createShortVideoSalesProfile } from "@/lib/creative-profiles";

const shot: Shot = { shotId: 1, type: "demo", duration: 5, description: "Product on table", camera: "static", visualSource: "ai_generate", transition: "direct_concat", voiceover: "Product demo" };
const model: KlingVideoModelDescriptor = { selectionKey: '["kling-cli","text_to_video","model-1"]', provider: "kling-cli", profileId: "profile-1", region: "global", tool: "text_to_video", remoteModelId: "model-1", displayName: "Model 1", catalogRevision: "catalog-1", available: true, parameters: [], inputSlots: [], capabilities: { image: false, tailFrame: false, multiImage: false, audio: false } };
const oldPhase = process.env.NEXT_PHASE;
function request(overrides: Partial<KlingSubmitRequest> = {}): KlingSubmitRequest {
  return { provider: "kling-cli", executionScope: "single-shot", profileId: "profile-1", clientRequestId: "request-1", projectId: "project-1", scriptId: "script-1", shotId: 1,
    selectionKey: model.selectionKey, mode: "text-to-video", prompt: "Slowly show the product", expectedSelectedAssetId: null,
    billingAcknowledgement: { policyRevision: "credits-v1", acceptedForRequestId: "request-1" }, ...overrides };
}
function shotRequest(shotId: number, overrides: Partial<KlingSubmitRequest> = {}): KlingSubmitRequest {
  const clientRequestId = `request-${shotId}`;
  return request({ shotId, clientRequestId, billingAcknowledgement: { policyRevision: "credits-v1", acceptedForRequestId: clientRequestId }, ...overrides });
}
function useMultipleShots(count = 6): void {
  getDb().update(scripts).set({ shots: Array.from({ length: count }, (_, index) => ({ ...shot, shotId: index + 1 })) }).where(eq(scripts.id, "script-1")).run();
}
function configurePremiumCgContext(revision = 1) {
  const profile = createPremiumProductCgProfile({ narrationMode: "none" });
  getDb().update(projects).set({ creativeProfile: profile, creativeConfigRevision: revision }).where(eq(projects.id, "project-1")).run();
  getDb().update(scripts).set({
    styleType: "premium_product_cg",
    shots: [{ ...shot, voiceover: "" }],
    creativeProfileSnapshot: createCreativeProfileSnapshot(profile, revision),
  }).where(eq(scripts.id, "script-1")).run();
  return profile;
}
function premiumCgImageModel(): KlingVideoModelDescriptor {
  const imageModel: KlingVideoModelDescriptor = {
    ...model,
    selectionKey: '["kling-cli","image_to_video","premium-image-model"]',
    tool: "image_to_video",
    remoteModelId: "premium-image-model",
    inputSlots: [{ name: "image", role: "image", required: true }],
    capabilities: { ...model.capabilities, image: true },
  };
  state.profile!.catalogSnapshot = [imageModel];
  getDb().update(projects)
    .set({ productImages: ["/api/files/project-1/product.png"] })
    .where(eq(projects.id, "project-1"))
    .run();
  return imageModel;
}
function addProfile(id: string, overrides: Partial<KlingProfile> = {}): KlingProfile {
  const profile = { ...structuredClone(state.profile!), id, homePath: path.join(state.directory, id), ...overrides };
  state.profiles[id] = profile;
  getDb().insert(klingProfiles).values({ id, data: profile }).run();
  return profile;
}
function useDistinctAcknowledgements(): void {
  let count = 0;
  state.cli.mockImplementation(async (_profile: KlingProfile, _args: string[], options: KlingRunOptions) => {
    const id = `remote-parallel-${++count}`; options.onGenerationId?.(id); return cliResult(id);
  });
}
function cliResult(generationId?: string) { return { exitCode: 0, signal: null, json: { ok: true, body: generationId ? { generationId } : {} }, generationId, stdout: "", stderr: "", timedOut: false, aborted: false }; }
const rejectedUpload = { ok: true, status: 200, body: { status: 500, result: 1, message: "Service busy", data: null,
  error: { type: "AGENT.UnsupportedFileType", detail: "Unsupported file type. Please refer to the API documentation for supported formats." } } };
function unsupportedUploadResult(overrides: Partial<KlingCliResult> = {}): KlingCliResult {
  return { ...cliResult(), exitCode: 1, json: undefined,
    stderr: `[kling] Uploaded -> https://private.invalid/image?signature=must-not-leak\nFailed to upload C:\\fixture\\0.webp: ${JSON.stringify(rejectedUpload)}\n`, ...overrides };
}
async function acknowledge(job: KlingJob, generationId = "remote-1"): Promise<KlingJob> { await dispatchKlingJob(job.id); expect(getKlingJob(job.id).remoteGenerationId).toBe(generationId); return getKlingJob(job.id); }
async function tick() {
  // Drain create's queued, disabled tick before explicitly enabling a single recovery sweep.
  await new Promise<void>((resolve) => setImmediate(resolve));
  delete process.env.NEXT_PHASE;
  try { await runKlingJobTick(); } finally { process.env.NEXT_PHASE = "phase-production-build"; }
}

beforeAll(async () => { state.directory = await fs.mkdtemp(path.join(os.tmpdir(), "clipforge-kling-jobs-")); });
beforeEach(() => {
  vi.stubEnv("CLIPFORGE_RUNTIME", ""); vi.stubEnv("CLIPFORGE_KLING_DISABLED", "");
  process.env.NEXT_PHASE = "phase-production-build";
  stopKlingJobRunner();
  state.sqlite!.exec("DROP TRIGGER IF EXISTS reject_kling_insert; DROP TRIGGER IF EXISTS reject_kling_claim; DELETE FROM kling_film_shots; DELETE FROM kling_film_runs; DELETE FROM kling_job_outputs; DELETE FROM kling_jobs; DELETE FROM ai_tasks; DELETE FROM assets; DELETE FROM scripts; DELETE FROM projects; DELETE FROM kling_profiles;");
  vi.clearAllMocks();
  state.profiles = {};
  const now = Date.now();
  state.profile = { id: "profile-1", label: "test", region: "global", cliPackage: "@klingai/cli-global", cliVersion: "0.2.0", adapterVersion: "1", nodePath: process.execPath, packagePath: "/fixture", cliEntry: "/fixture/dist/cli.js", homePath: path.join(state.directory, "home"), endpoint: "https://kling.ai/mcp", environmentState: "ready", authState: "authenticated", authRevision: 1, principalKey: '["global","user-1"]', accountSummary: { id: "user-1" }, catalogSnapshot: [structuredClone(model)], catalogRevision: "catalog-1", catalogCheckedAt: now, createdAt: now, updatedAt: now };
  getDb().insert(klingProfiles).values({ id: "profile-1", data: state.profile }).run();
  getDb().insert(projects).values({ id: "project-1", name: "Fixture project" }).run();
  getDb().insert(scripts).values({ id: "script-1", projectId: "project-1", styleType: "scene", shots: [shot], selected: true }).run();
  state.refresh.mockImplementation(async (id: string) => structuredClone(state.profiles[id] ?? state.profile));
  state.lease.mockImplementation(async (profile: KlingProfile, fn: (lease: unknown) => unknown) => fn({ profileId: profile.id, owner: "test", token: 1, assertOwned() {} }));
  state.prepare.mockResolvedValue([]);
  state.cli.mockImplementation(async (_profile: KlingProfile, args: string[], options: KlingRunOptions) => {
    if (args[0] === "query_tasks") return { ...cliResult(), json: { ok: true, body: { status: "processing", works: [] } } };
    options.onGenerationId?.("remote-1"); return cliResult("remote-1");
  });
  state.download.mockImplementation(async (_url: string, destination: string) => { await fs.writeFile(destination, "fixture-video-content"); });
  state.probe.mockResolvedValue({ duration: 5, width: 1280, height: 720, hasAudio: true, formatName: "mov,mp4", frameRate: 24, videoCodec: "h264" });
  state.poster.mockImplementation(async (video: string) => { await fs.writeFile(video + ".thumb.jpg", "poster"); return video + ".thumb.jpg"; });
  state.lastFrame.mockResolvedValue(undefined);
});
afterEach(async () => { stopKlingJobRunner(); await new Promise<void>((resolve) => setImmediate(resolve)); vi.unstubAllEnvs(); });
afterAll(async () => { stopKlingJobRunner(); state.sqlite?.close(); await fs.rm(state.directory, { recursive: true, force: true }); if (oldPhase === undefined) delete process.env.NEXT_PHASE; else process.env.NEXT_PHASE = oldPhase; });

describe("Kling durable submission and recovery", () => {
  it("dispatches an authorized web job with an explicit migration directory", async () => {
    vi.stubEnv("APP_MIGRATIONS_DIR", "standalone-migrations");
    const job = await createKlingJob(request()); await tick();
    expect(state.cli).toHaveBeenCalledOnce();
    expect(getKlingJob(job.id).submissionState).toBe("acknowledged");
  });
  it.each([["CLIPFORGE_KLING_DISABLED", "1"], ["CLIPFORGE_RUNTIME", "desktop"]])("does not dispatch an authorized job in a disabled runtime: %s", async (name, value) => {
    const job = await createKlingJob(request()); vi.stubEnv(name, value); await tick();
    expect(state.cli).not.toHaveBeenCalled();
    expect(getKlingJob(job.id).submissionState).toBe("prepared");
  });
  it("records the server prompt rules and source shot without accepting a client audit override", async () => {
    const job = await createKlingJob({ ...request(), videoPromptAudit: { version: 999, sourceShot: { description: "forged" } } });
    expect(job.data.videoPromptAudit).toEqual({ version: 2, sourceShot: shot });
    expect(job.data.prompt).toBe(request().prompt);
    expect(job.data.args.at(-1)).toBe(request().prompt);
  });
  it.each(["固定镜头。镜头平稳向左横移。", "底部小字为“价。", "视频全程静音。添加环境音。"])("rejects invalid final prompts before preparing media or creating a paid job: %s", async (prompt) => {
    await expect(createKlingJob(request({ prompt }))).rejects.toMatchObject({ code: "KLING_PROMPT_INVALID", status: 422 });
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.cli).not.toHaveBeenCalled();
    expect(getDb().select().from(klingJobs).all()).toHaveLength(0);
  });
  it("blocks an invalid legacy prepared prompt without changing it or reaching the CLI", async () => {
    const job = await createKlingJob(request());
    const prompt = "固定镜头。镜头向左横移。";
    getDb().update(klingJobs).set({ data: { ...job.data, videoPromptAudit: undefined, prompt, args: [...job.data.args.slice(0, -1), prompt] } }).where(eq(klingJobs.id, job.id)).run();
    await dispatchKlingJob(job.id);
    expect(getKlingJob(job.id)).toMatchObject({ submissionState: "prepared", needsConfirmation: true, data: { prompt, error: { code: "KLING_PROMPT_INVALID" } } });
    expect(state.cli).not.toHaveBeenCalled();
  });

  it("returns the same persisted job for an identical request and dispatches only once", async () => {
    const first = await createKlingJob(request()); const duplicate = await createKlingJob(request());
    expect(duplicate.id).toBe(first.id);
    await acknowledge(first); await dispatchKlingJob(first.id);
    expect(state.cli).toHaveBeenCalledTimes(1);
    expect(getDb().select().from(aiTasks).all()).toHaveLength(1);
  });
  it("reserves an idempotent job from a verified stale catalog during CLI contention and retries before generating once", async () => {
    state.profile!.catalogCheckedAt = Date.now() - 400_000;
    state.refresh.mockRejectedValueOnce(new KlingError("KLING_PROFILE_BUSY", "Another command owns this profile", 409));
    const job = await createKlingJob(request());
    const duplicate = await createKlingJob(request());
    expect(duplicate.id).toBe(job.id);
    expect(job).toMatchObject({ submissionState: "prepared", needsConfirmation: false, principalKey: state.profile!.principalKey });
    expect(state.refresh).toHaveBeenCalledWith("profile-1", undefined, { credits: false });
    expect(state.cli).not.toHaveBeenCalled();
    state.lease.mockRejectedValueOnce(new KlingError("KLING_PROFILE_BUSY", "Still waiting for another command", 409));
    await dispatchKlingJob(job.id);
    expect(getKlingJob(job.id)).toMatchObject({ submissionState: "prepared", needsConfirmation: false, data: { error: { code: "KLING_PROFILE_BUSY" } } });
    expect(state.cli).not.toHaveBeenCalled();
    await tick(); await dispatchKlingJob(job.id);
    expect(getKlingJob(job.id)).toMatchObject({ submissionState: "acknowledged", remoteGenerationId: "remote-1" });
    expect(state.refresh).toHaveBeenCalledTimes(2);
    expect(state.cli).toHaveBeenCalledTimes(1);
    expect(getDb().select().from(klingJobs).all()).toHaveLength(1);
    expect(getDb().select().from(aiTasks).all()).toHaveLength(1);
  });
  it("blocks paid dispatch when a stale catalog queued during contention changes on live verification", async () => {
    state.profile!.catalogCheckedAt = Date.now() - 400_000;
    state.refresh.mockRejectedValueOnce(new KlingError("KLING_PROFILE_BUSY", "Another command owns this profile", 409));
    const job = await createKlingJob(request());
    state.refresh.mockResolvedValueOnce({ ...state.profile!, catalogSnapshot: [{ ...model, catalogRevision: "catalog-2" }] });
    await dispatchKlingJob(job.id);
    expect(getKlingJob(job.id)).toMatchObject({ submissionState: "prepared", needsConfirmation: true, data: { error: { code: "KLING_CATALOG_CHANGED" } } });
    expect(state.cli).not.toHaveBeenCalled();
  });
  it("blocks paid dispatch when a stale catalog queued during contention belongs to a different live account", async () => {
    state.profile!.catalogCheckedAt = Date.now() - 400_000;
    state.refresh.mockRejectedValueOnce(new KlingError("KLING_PROFILE_BUSY", "Another command owns this profile", 409));
    const job = await createKlingJob(request());
    state.refresh.mockResolvedValueOnce({ ...state.profile!, principalKey: "another-user" });
    await dispatchKlingJob(job.id);
    expect(getKlingJob(job.id)).toMatchObject({ submissionState: "prepared", needsConfirmation: true, data: { error: { code: "KLING_ACCOUNT_MISMATCH" } } });
    expect(state.cli).not.toHaveBeenCalled();
  });
  it.each(["KLING_AUTH_REQUIRED", "KLING_ACCOUNT_MISMATCH", "KLING_TIMEOUT"])("does not use a stale catalog after %s", async (code) => {
    state.profile!.catalogCheckedAt = Date.now() - 400_000;
    state.refresh.mockRejectedValueOnce(new KlingError(code, "Refresh could not verify the account", 409));
    await expect(createKlingJob(request())).rejects.toMatchObject({ code });
    expect(getDb().select().from(klingJobs).all()).toHaveLength(0);
    expect(state.prepare).not.toHaveBeenCalled(); expect(state.cli).not.toHaveBeenCalled();
  });
  it.each(["unchecked", "unversioned", "empty", "unavailable"])("does not reserve during contention with an %s cached catalog", async (condition) => {
    state.profile!.catalogCheckedAt = condition === "unchecked" ? undefined : Date.now() - 400_000;
    if (condition === "unversioned") state.profile!.catalogRevision = undefined;
    if (condition === "empty") state.profile!.catalogSnapshot = [];
    if (condition === "unavailable") state.profile!.catalogSnapshot[0].available = false;
    state.refresh.mockRejectedValueOnce(new KlingError("KLING_PROFILE_BUSY", "Another command owns this profile", 409));
    await expect(createKlingJob(request())).rejects.toMatchObject({ code: "KLING_PROFILE_BUSY" });
    expect(getDb().select().from(klingJobs).all()).toHaveLength(0);
    expect(state.prepare).not.toHaveBeenCalled(); expect(state.cli).not.toHaveBeenCalled();
  });
  it.each(["auth", "principal"])("rereads the cached %s binding before reserving during contention", async (condition) => {
    state.profile!.catalogCheckedAt = Date.now() - 400_000;
    state.refresh.mockImplementationOnce(async () => {
      if (condition === "auth") state.profile!.authState = "account_mismatch";
      else state.profile!.principalKey = "another-user";
      throw new KlingError("KLING_PROFILE_BUSY", "Another command owns this profile", 409);
    });
    await expect(createKlingJob(request())).rejects.toMatchObject({ code: "KLING_PROFILE_BUSY" });
    expect(getDb().select().from(klingJobs).all()).toHaveLength(0);
    expect(state.prepare).not.toHaveBeenCalled(); expect(state.cli).not.toHaveBeenCalled();
  });
  it("rejects a reused request ID with changed content", async () => {
    await createKlingJob(request());
    await expect(createKlingJob(request({ prompt: "Different prompt" }))).rejects.toMatchObject({ code: "KLING_REQUEST_CONFLICT" });
    expect(state.cli).not.toHaveBeenCalled();
  });
  it("blocks a second unresolved generation for the same shot", async () => {
    const original = await createKlingJob(request());
    await expect(createKlingJob(request({ clientRequestId: "request-2", billingAcknowledgement: { policyRevision: "credits-v1", acceptedForRequestId: "request-2" } }))).rejects.toMatchObject({ code: "KLING_REQUEST_CONFLICT", jobId: original.id });
  });
  it("persists a remote ID despite nonzero process exit", async () => {
    const job = await createKlingJob(request());
    state.cli.mockImplementationOnce(async (_p: KlingProfile, _a: string[], options: KlingRunOptions) => { options.onGenerationId?.("accepted-error"); return { ...cliResult("accepted-error"), exitCode: 1 }; });
    const final = await acknowledge(job, "accepted-error");
    expect(final.submissionState).toBe("acknowledged");
    const receipt = JSON.parse(await fs.readFile(path.join(state.directory, "integrations/kling/receipts", job.id + ".json"), "utf8"));
    expect(receipt).toMatchObject({ generationId: "accepted-error", principalKey: state.profile!.principalKey });
  });
  it("marks a no-ID result unknown and refuses to dispatch it again", async () => {
    const job = await createKlingJob(request()); state.cli.mockResolvedValueOnce({ ...cliResult(), exitCode: 1, timedOut: true });
    await dispatchKlingJob(job.id); await dispatchKlingJob(job.id);
    expect(getKlingJob(job.id)).toMatchObject({ submissionState: "submission_unknown", remoteState: "unknown" });
    expect(state.cli).toHaveBeenCalledTimes(1);
    expect(klingJobView(getKlingJob(job.id)).allowedActions).not.toContain("continue");
  });
  it.each(["result", "exception"] as const)("releases an explicitly rejected upload from a %s without automatically retrying", async (mode) => {
    const job = await createKlingJob(request());
    if (mode === "result") state.cli.mockResolvedValueOnce(unsupportedUploadResult());
    else state.cli.mockRejectedValueOnce(new KlingError("KLING_CLI_FAILED", "local upload failed", 502, unsupportedUploadResult()));
    await dispatchKlingJob(job.id); await dispatchKlingJob(job.id); await tick();
    expect(state.cli).toHaveBeenCalledTimes(1);
    expect(getKlingJob(job.id)).toMatchObject({ submissionState: "not_submitted", remoteState: "not_started", remoteGenerationId: null, needsConfirmation: false,
      data: { authorizedUntil: 0, error: { code: "KLING_INPUT_FORMAT_UNSUPPORTED", message: "参考图片上传被 Kling 拒绝，未提交视频生成。请使用 PNG 或 JPEG 图片后重新确认生成。", retryable: true } } });
    const view = klingJobView(getKlingJob(job.id));
    expect(view.allowedActions).not.toContain("continue"); expect(view.allowedActions).not.toContain("bind");
    expect(JSON.stringify(view)).not.toMatch(/must-not-leak|private\.invalid/);
    expect(JSON.stringify({ ...view, cliDiagnostics: undefined })).not.toMatch(/C:\\\\fixture|Service busy/);
    expect(view.cliDiagnostics?.stderr).toContain("Service busy");
    await expect(createKlingJob(request({ clientRequestId: "request-2" }))).rejects.toMatchObject({ code: "KLING_BILLING_ACK_REQUIRED" });
    const replacement = await createKlingJob(request({ clientRequestId: "request-2", billingAcknowledgement: { policyRevision: "credits-v1", acceptedForRequestId: "request-2" } }));
    expect(replacement.id).not.toBe(job.id); expect(replacement.submissionState).toBe("prepared");
    expect(state.cli).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["timeout", unsupportedUploadResult({ timedOut: true })],
    ["cancellation", unsupportedUploadResult({ aborted: true })],
    ["signal termination", unsupportedUploadResult({ signal: "SIGTERM" })],
    ["nonterminal upload text", unsupportedUploadResult({ stderr: `${unsupportedUploadResult().stderr}[kling] Submit arguments: {}\nMCP connection failed\n` })],
    ["unrelated error mentioning the code", unsupportedUploadResult({ stderr: "MCP tool call failed: AGENT.UnsupportedFileType\n" })],
    ["malformed upload response", unsupportedUploadResult({ stderr: 'Failed to upload C:\\fixture\\0.webp: {"error":"AGENT.UnsupportedFileType"\n' })],
  ] as const)("keeps a no-ID %s locked as unknown", async (_label, result) => {
    const job = await createKlingJob(request()); state.cli.mockResolvedValueOnce(result);
    await dispatchKlingJob(job.id); await dispatchKlingJob(job.id);
    expect(getKlingJob(job.id)).toMatchObject({ submissionState: "submission_unknown", remoteState: "unknown", remoteGenerationId: null,
      data: { error: { code: "KLING_SUBMISSION_UNKNOWN" } } });
    expect(state.cli).toHaveBeenCalledTimes(1);
    await expect(createKlingJob(request({ clientRequestId: "request-2", billingAcknowledgement: { policyRevision: "credits-v1", acceptedForRequestId: "request-2" } })))
      .rejects.toMatchObject({ code: "KLING_REQUEST_CONFLICT", jobId: job.id });
  });
  it.each([
    ["upload rejected", unsupportedUploadResult({ stderr: `Failed to upload C:\\fixture\\0.png: ${JSON.stringify({ ...rejectedUpload, body: { ...rejectedUpload.body, error: { type: "AGENT.UnknownError", detail: "temporary upload failure" } } })}\n` })],
    ["parameters rejected after upload", { ...cliResult(), json: undefined, exitCode: 1, stderr: "[kling] Uploaded -> https://private.invalid/input?signature=must-not-leak\nUnknown parameter --resolution. Model model-1 declares these generation parameters: duration (flags may use snake_case or camelCase; run kling who_am_i for the full spec).\n" }],
    ["CLI failed to start", { ...cliResult(), exitCode: null, spawnFailed: true, stderr: "spawn node ENOENT" }],
  ] as const)("releases the shot and account for a confirmed %s and saves diagnostics", async (_label, result) => {
    const job = await createKlingJob(request()); state.cli.mockResolvedValueOnce(result);
    await dispatchKlingJob(job.id); await dispatchKlingJob(job.id); await tick();
    expect(getKlingJob(job.id)).toMatchObject({ submissionState: "not_submitted", remoteState: "not_started", remoteGenerationId: null,
      data: { authorizedUntil: 0, cliDiagnostics: { exitCode: result.exitCode, submission: { outcome: "not_submitted" } } } });
    expect(state.cli).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(klingJobView(getKlingJob(job.id)))).not.toMatch(/must-not-leak|private\.invalid/);
    const replacement = await createKlingJob(request({ clientRequestId: "request-2", billingAcknowledgement: { policyRevision: "credits-v1", acceptedForRequestId: "request-2" } }));
    expect(replacement.id).not.toBe(job.id);
  });

  it("records startup verification failures as unsubmitted with the actual local exception", async () => {
    const job = await createKlingJob(request());
    state.cli.mockRejectedValueOnce(new KlingError("KLING_ENVIRONMENT_CHANGED", "Kling 安装路径已改变，请重新检测环境。", 409));
    await dispatchKlingJob(job.id);
    expect(getKlingJob(job.id)).toMatchObject({ submissionState: "not_submitted", remoteGenerationId: null,
      data: { cliDiagnostics: { spawnFailed: true, error: "KlingError: Kling 安装路径已改变，请重新检测环境。" } } });
  });

  it("keeps interrupted generation ambiguous and retains original CLI output after refresh", async () => {
    const job = await createKlingJob(request());
    state.cli.mockImplementationOnce(async (_profile: KlingProfile, _args: string[], options: KlingRunOptions) => {
      options.beforeSpawn?.();
      throw new KlingError("KLING_CLI_FAILED", "MCP tool call failed (text_to_video): fetch failed", 502,
        { ...cliResult(), exitCode: 1, stdout: '{"ok":false,"body":{"error":"unknown upstream error"}}', stderr: "MCP tool call failed (text_to_video): fetch failed" });
    });
    await dispatchKlingJob(job.id); await dispatchKlingJob(job.id);
    const view = klingJobView(getKlingJob(job.id));
    expect(view).toMatchObject({ submissionState: "submission_unknown", cliDiagnostics: { exitCode: 1,
      stdout: '{"ok":false,"body":{"error":"unknown upstream error"}}', stderr: "MCP tool call failed (text_to_video): fetch failed", submission: { outcome: "unknown" } } });
    expect(view.allowedActions).toContain("bind"); expect(view.allowedActions).not.toContain("continue");
    expect(state.cli).toHaveBeenCalledTimes(1);
  });
  it.each(["callback", "result", "exception"] as const)("prioritizes an acknowledged ID from the %s over upload-error diagnostics", async (mode) => {
    const job = await createKlingJob(request());
    state.cli.mockImplementationOnce(async (_profile: KlingProfile, _args: string[], options: KlingRunOptions) => {
      if (mode !== "result") options.onGenerationId?.("known-accepted");
      if (mode === "exception") throw new KlingError("KLING_CLI_FAILED", "failed later", 502, unsupportedUploadResult());
      return unsupportedUploadResult(mode === "result" ? { generationId: "known-accepted" } : {});
    });
    await acknowledge(job, "known-accepted");
    expect(getKlingJob(job.id)).toMatchObject({ submissionState: "acknowledged", remoteState: "pending" });
    expect(getKlingJob(job.id).data.error).toBeUndefined(); expect(state.cli).toHaveBeenCalledTimes(1);
  });
  it("recovers an ID carried by an exception without another generation", async () => {
    const job = await createKlingJob(request());
    state.cli.mockRejectedValueOnce(new KlingError("KLING_CLI_FAILED", "failed after acceptance", 502, { ...cliResult("accepted-throw"), exitCode: 1 }));
    await acknowledge(job, "accepted-throw"); expect(state.cli).toHaveBeenCalledTimes(1);
  });
  it("recovers the original ID from a raw JSON response before considering rejection", async () => {
    const job = await createKlingJob(request());
    state.cli.mockResolvedValueOnce({ ...unsupportedUploadResult(), stdout: '{"ok":false,"body":{"generationId":"raw-accepted"}}' });
    await acknowledge(job, "raw-accepted");
    expect(getKlingJob(job.id).data.cliDiagnostics?.stdout).toContain("raw-accepted");
    expect(state.cli).toHaveBeenCalledTimes(1);
  });
  it("does not dispatch a prepared job from an earlier server boot", async () => {
    const job = await createKlingJob(request()); patchKlingJob(job.id, {}, { authorizedBootId: "previous-server-boot" });
    await tick(); expect(getKlingJob(job.id)).toMatchObject({ submissionState: "prepared", needsConfirmation: true });
    expect(state.cli).not.toHaveBeenCalled();
  });
  it("repairs a crashed submitting row from its validated receipt", async () => {
    const job = await createKlingJob(request()); patchKlingJob(job.id, { submissionState: "submitting" });
    const directory = path.join(state.directory, "integrations/kling/receipts"); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, job.id + ".json"), JSON.stringify({ jobId: job.id, profileId: job.profileId, principalKey: job.principalKey, region: job.region, generationId: "receipt-1", requestHash: job.data.requestHash }));
    await tick(); expect(getKlingJob(job.id)).toMatchObject({ submissionState: "acknowledged", remoteGenerationId: "receipt-1", data: { bindingMethod: "receipt" } });
    expect(state.cli).not.toHaveBeenCalled();
  });
  it("does not accept a receipt from a different account", async () => {
    const job = await createKlingJob(request()); patchKlingJob(job.id, { submissionState: "submitting" });
    const directory = path.join(state.directory, "integrations/kling/receipts"); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, job.id + ".json"), JSON.stringify({ jobId: job.id, profileId: job.profileId, principalKey: "other-user", region: job.region, generationId: "wrong", requestHash: job.data.requestHash }));
    await tick(); expect(getKlingJob(job.id)).toMatchObject({ submissionState: "submission_unknown", remoteGenerationId: null });
  });
  it("repairs an unknown submission after database persistence recovers", async () => {
    const job = await createKlingJob(request()); patchKlingJob(job.id, { submissionState: "submission_unknown", remoteState: "unknown" });
    const directory = path.join(state.directory, "integrations/kling/receipts"); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, job.id + ".json"), JSON.stringify({ jobId: job.id, profileId: job.profileId, principalKey: job.principalKey, region: job.region, generationId: "recovered-unknown", requestHash: job.data.requestHash }));
    await tick(); expect(getKlingJob(job.id)).toMatchObject({ submissionState: "acknowledged", remoteGenerationId: "recovered-unknown" });
    expect(state.cli).not.toHaveBeenCalled();
  });
  it("rejects a receipt with an incorrect region or invalid remote ID", async () => {
    const job = await createKlingJob(request()); patchKlingJob(job.id, { submissionState: "submitting" });
    const directory = path.join(state.directory, "integrations/kling/receipts"); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, job.id + ".json"), JSON.stringify({ jobId: job.id, profileId: job.profileId, principalKey: job.principalKey, region: "cn", generationId: "--poll", requestHash: job.data.requestHash }));
    await tick(); expect(getKlingJob(job.id).remoteGenerationId).toBeNull();
  });
  it("stops before CLI invocation when input preparation fails", async () => {
    state.prepare.mockRejectedValueOnce(new KlingError("KLING_INPUT_INVALID", "bad image", 422));
    await expect(createKlingJob(request())).rejects.toMatchObject({ code: "KLING_INPUT_INVALID" });
    expect(getDb().select().from(klingJobs).all()).toHaveLength(0); expect(state.cli).not.toHaveBeenCalled();
  });
  it("stops before CLI invocation when the initial database insert fails", async () => {
    state.sqlite!.exec("CREATE TRIGGER reject_kling_insert BEFORE INSERT ON kling_jobs BEGIN SELECT RAISE(ABORT, 'fixture database failure'); END");
    await expect(createKlingJob(request())).rejects.toThrow(/fixture database failure/);
    expect(state.cli).not.toHaveBeenCalled();
  });
  it("never generates when the durable submitting claim cannot be written", async () => {
    const job = await createKlingJob(request());
    state.sqlite!.exec("CREATE TRIGGER reject_kling_claim BEFORE UPDATE ON kling_jobs WHEN NEW.submission_state = 'submitting' BEGIN SELECT RAISE(ABORT, 'fixture claim failure'); END");
    await dispatchKlingJob(job.id); expect(state.cli).not.toHaveBeenCalled();
    expect(getKlingJob(job.id)).toMatchObject({ submissionState: "prepared", needsConfirmation: true });
  });
  it("does not submit under a different principal", async () => {
    const job = await createKlingJob(request()); state.refresh.mockResolvedValueOnce({ ...state.profile, principalKey: "another-user" });
    await dispatchKlingJob(job.id); expect(state.cli).not.toHaveBeenCalled();
    expect(getKlingJob(job.id)).toMatchObject({ submissionState: "prepared", needsConfirmation: true, data: { blockedReason: "auth_required", error: { code: "KLING_ACCOUNT_MISMATCH" } } });
  });
  it("rechecks script context immediately before the billable submission", async () => {
    const job = await createKlingJob(request());
    getDb().update(scripts).set({ version: 2 }).where(eq(scripts.id, "script-1")).run();
    await dispatchKlingJob(job.id); expect(state.cli).not.toHaveBeenCalled();
    expect(getKlingJob(job.id)).toMatchObject({ submissionState: "prepared", needsConfirmation: true, data: { error: { code: "KLING_CONTEXT_CHANGED" } } });
  });
  it("blocks an already prepared premium CG job after the project changes creative type", async () => {
    configurePremiumCgContext();
    const imageModel = premiumCgImageModel();
    const job = await createKlingJob(request({ selectionKey: imageModel.selectionKey, mode: "image-to-video" }));
    getDb().update(projects).set({ creativeProfile: createShortVideoSalesProfile() }).where(eq(projects.id, "project-1")).run();

    await dispatchKlingJob(job.id);

    expect(state.cli).not.toHaveBeenCalled();
    expect(getKlingJob(job.id)).toMatchObject({ submissionState: "prepared", needsConfirmation: true, data: { error: { code: "CREATIVE_PROFILE_MISMATCH" } } });
  });
  it("blocks an already prepared premium CG job after the project creative revision changes", async () => {
    configurePremiumCgContext();
    const imageModel = premiumCgImageModel();
    const job = await createKlingJob(request({ selectionKey: imageModel.selectionKey, mode: "image-to-video" }));
    getDb().update(projects).set({ creativeConfigRevision: 2 }).where(eq(projects.id, "project-1")).run();

    await dispatchKlingJob(job.id);

    expect(state.cli).not.toHaveBeenCalled();
    expect(getKlingJob(job.id)).toMatchObject({ submissionState: "prepared", needsConfirmation: true, data: { error: { code: "CREATIVE_CONFIG_STALE" } } });
  });
  it("rebuilds a premium CG Kling request from the selected shot and project product image", async () => {
    configurePremiumCgContext();
    getDb().update(projects).set({ productImages: ["/api/files/project-1/product.png"] }).where(eq(projects.id, "project-1")).run();
    const imageModel: KlingVideoModelDescriptor = {
      ...model,
      selectionKey: '["kling-cli","image_to_video","image-model"]',
      tool: "image_to_video",
      remoteModelId: "image-model",
      inputSlots: [{ name: "image", role: "image", required: true }],
      capabilities: { ...model.capabilities, image: true },
    };
    state.profile!.catalogSnapshot = [imageModel];
    state.prepare.mockResolvedValueOnce([{ role: "image", sourceUrl: "/api/files/project-1/product.png", path: "/fixture/product.png", hash: "a".repeat(64), size: 1 }]);

    const job = await createKlingJob(request({
      selectionKey: imageModel.selectionKey,
      mode: "text-to-video",
      prompt: "Add a giant BUY NOW price card.",
      imageUrl: "https://example.test/foreign-sale-card.png",
      referenceImageUrls: ["https://example.test/foreign-reference.png"],
    }));

    expect(job.data.prompt).toContain("Premium product CG motion");
    expect(job.data.prompt).not.toContain("BUY NOW");
    expect(job.data.inputs).toEqual([expect.objectContaining({ role: "image", sourceUrl: "/api/files/project-1/product.png" })]);
    expect(JSON.stringify(job.data)).not.toContain("foreign-sale-card.png");
    expect(JSON.stringify(job.data)).not.toContain("foreign-reference.png");
  });
  it("does not claim a job whose authorization expired during identity checking", async () => {
    const job = await createKlingJob(request()); const now = Date.now(); const clock = vi.spyOn(Date, "now");
    state.refresh.mockImplementationOnce(async () => { clock.mockReturnValue(now + 130000); return structuredClone(state.profile); });
    try { await dispatchKlingJob(job.id); expect(state.cli).not.toHaveBeenCalled(); expect(getKlingJob(job.id).submissionState).toBe("prepared"); }
    finally { clock.mockRestore(); }
  });
  it("retains completed state when a later status response is pending", async () => {
    const job = await acknowledge(await createKlingJob(request())); patchKlingJob(job.id, { remoteState: "completed", importState: "completed" });
    await queryKlingJob(job.id);
    expect(getKlingJob(job.id).remoteState).toBe("completed");
    expect(getDb().select().from(aiTasks).all()[0].status).toBe("completed");
  });
  it("holds an exclusive persisted job lease across asynchronous work", async () => {
    const job = await createKlingJob(request());
    await withKlingJobLease(job.id, async () => { await expect(dispatchKlingJob(job.id)).rejects.toMatchObject({ code: "KLING_JOB_BUSY" }); });
    expect(getKlingJob(job.id).leaseOwner).toBeNull();
  });
  it("fences stale workers after the persisted owner is replaced", async () => {
    const job = await createKlingJob(request());
    await expect(withKlingJobLease(job.id, async () => {
      getDb().update(klingJobs).set({ leaseOwner: "999999999:new-owner" }).where(eq(klingJobs.id, job.id)).run();
      patchKlingJob(job.id, { remoteState: "failed" });
    })).rejects.toMatchObject({ code: "KLING_JOB_LEASE_LOST" });
    expect(getKlingJob(job.id).remoteState).toBe("not_started");
    expect(getKlingJob(job.id).leaseOwner).toBe("999999999:new-owner");
  });
  it("does not steal an expired lease from a live process", async () => {
    const job = await createKlingJob(request());
    getDb().update(klingJobs).set({ leaseOwner: `${process.pid}:old-runner`, leaseExpiresAt: Date.now() - 1 }).where(eq(klingJobs.id, job.id)).run();
    await expect(dispatchKlingJob(job.id)).rejects.toMatchObject({ code: "KLING_JOB_BUSY" }); expect(state.cli).not.toHaveBeenCalled();
  });
  it("cancels only an undispatched prepared job and releases its account blocker", async () => {
    const job = await createKlingJob(request()); expect(klingJobView(job).allowedActions).toContain("cancel-prepared");
    await klingJobAction(job.id, "cancel-prepared", {}); expect(getKlingJob(job.id).submissionState).toBe("not_submitted");
    const next = await createKlingJob(request({ clientRequestId: "request-2", billingAcknowledgement: { policyRevision: "credits-v1", acceptedForRequestId: "request-2" } }));
    expect(next.id).not.toBe(job.id); expect(state.cli).not.toHaveBeenCalled();
  });
  it("refuses to locally cancel a possibly submitted job", async () => {
    const job = await acknowledge(await createKlingJob(request()));
    await expect(klingJobAction(job.id, "cancel-prepared", {})).rejects.toMatchObject({ code: "KLING_ALREADY_DISPATCHED" });
    expect(getKlingJob(job.id).remoteGenerationId).toBe("remote-1");
  });
  it("requeries a manual binding candidate before confirmation and binds only the same result", async () => {
    const job = await createKlingJob(request()); patchKlingJob(job.id, { submissionState: "submission_unknown", remoteState: "unknown" });
    const preview = await bindKlingJob(job.id, { action: "preview", generationId: "manual-1" }) as { candidateToken: string };
    expect(klingJobView(getKlingJob(job.id)).allowedActions).toContain("bind");
    await bindKlingJob(job.id, { action: "confirm", candidateToken: preview.candidateToken, explicitConfirmation: true });
    expect(getKlingJob(job.id)).toMatchObject({ remoteGenerationId: "manual-1", data: { bindingMethod: "manual" } });
    expect(state.cli.mock.calls.map((call) => call[1][0])).toEqual(["query_tasks", "query_tasks"]);
  });
  it("requires a new preview when the candidate summary changes", async () => {
    const job = await createKlingJob(request()); patchKlingJob(job.id, { submissionState: "submission_unknown", remoteState: "unknown" });
    const preview = await bindKlingJob(job.id, { action: "preview", generationId: "manual-1" }) as { candidateToken: string };
    state.cli.mockResolvedValueOnce({ ...cliResult(), json: { ok: true, body: { status: "completed", works: [{ id: "new-work", url: "https://public.example.test/video.mp4" }] } } });
    await expect(bindKlingJob(job.id, { action: "confirm", candidateToken: preview.candidateToken, explicitConfirmation: true })).rejects.toMatchObject({ code: "KLING_BINDING_CANDIDATE_CHANGED" });
    expect(getKlingJob(job.id).remoteGenerationId).toBeNull();
  });
});

describe("Kling ten-shot account concurrency", () => {
  const slotShotIds = Array.from({ length: 10 }, (_, index) => index + 1);
  const otherSlotShotIds = slotShotIds.map((id) => id + 10);
  beforeEach(() => { useMultipleShots(20); useDistinctAcknowledgements(); });
  it("accepts and acknowledges ten different shots before any has finished, then rejects an eleventh without redirecting to another shot", async () => {
    const jobs = await Promise.all(slotShotIds.map((id) => createKlingJob(shotRequest(id))));
    await Promise.all(jobs.map((job) => dispatchKlingJob(job.id)));
    for (const job of jobs) expect(getKlingJob(job.id)).toMatchObject({ submissionState: "acknowledged", remoteState: "pending", importState: "not_ready" });
    expect(new Set(jobs.map((job) => getKlingJob(job.id).remoteGenerationId)).size).toBe(10);
    const rejected = await createKlingJob(shotRequest(11)).catch((error) => error);
    expect(rejected).toMatchObject({ code: "KLING_CONCURRENCY_LIMIT", status: 409 }); expect(rejected.jobId).toBeUndefined();
    expect(state.cli).toHaveBeenCalledTimes(10);
    expect((await createKlingJob(shotRequest(1))).id).toBe(jobs[0].id);
  });
  it.each(["completed", "failed", "cancelled"] as const)("releases a slot when a cloud task is %s even if its local import has failed", async (remoteState) => {
    const jobs = await Promise.all(slotShotIds.map((id) => createKlingJob(shotRequest(id))));
    await Promise.all(jobs.map((job) => dispatchKlingJob(job.id)));
    patchKlingJob(jobs[0].id, { remoteState, importState: "failed" });
    expect((await createKlingJob(shotRequest(11))).submissionState).toBe("prepared");
    if (remoteState === "completed") {
      await expect(createKlingJob(shotRequest(1, { clientRequestId: "retry-shot-1", billingAcknowledgement: { policyRevision: "credits-v1", acceptedForRequestId: "retry-shot-1" } })))
        .rejects.toMatchObject({ code: "KLING_REQUEST_CONFLICT", jobId: jobs[0].id });
    }
  });
  it("reserves ten slots atomically across a burst of asynchronous creates", async () => {
    let release!: () => void; const preparation = new Promise<void>((resolve) => { release = resolve; });
    state.prepare.mockImplementation(async () => { await preparation; return []; });
    const pending = [...slotShotIds, ...otherSlotShotIds].map((id) => createKlingJob(shotRequest(id)));
    release(); const settled = await Promise.allSettled(pending);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(10);
    const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(failures).toHaveLength(10); for (const result of failures) expect(result.reason).toMatchObject({ code: "KLING_CONCURRENCY_LIMIT" });
    expect(getDb().select().from(klingJobs).all()).toHaveLength(10); expect(state.cli).not.toHaveBeenCalled();
  });
  it("keeps concurrent copies of the same request idempotent while preventing different requests for the same shot", async () => {
    const jobs = await Promise.all([createKlingJob(shotRequest(1)), createKlingJob(shotRequest(1))]);
    expect(jobs[0].id).toBe(jobs[1].id); expect(getDb().select().from(klingJobs).all()).toHaveLength(1);
    await expect(createKlingJob(shotRequest(1, { clientRequestId: "another-1", billingAcknowledgement: { policyRevision: "credits-v1", acceptedForRequestId: "another-1" } })))
      .rejects.toMatchObject({ code: "KLING_REQUEST_CONFLICT", jobId: jobs[0].id });
  });
  it("shares slots across profiles of the same account", async () => {
    addProfile("profile-2");
    await Promise.all(slotShotIds.map((id) => createKlingJob(shotRequest(id))));
    await expect(createKlingJob(shotRequest(11, { profileId: "profile-2" }))).rejects.toMatchObject({ code: "KLING_CONCURRENCY_LIMIT" });
  });
  it("shares ten account slots across different projects and profiles", async () => {
    addProfile("profile-2");
    getDb().insert(projects).values({ id: "project-2", name: "Other fixture project" }).run();
    getDb().insert(scripts).values({ id: "script-2", projectId: "project-2", styleType: "scene", shots: Array.from({ length: 11 }, (_, index) => ({ ...shot, shotId: index + 1 })), selected: true }).run();
    await Promise.all(slotShotIds.slice(0, 5).map((id) => createKlingJob(shotRequest(id))));
    const otherProject = { profileId: "profile-2", projectId: "project-2", scriptId: "script-2" };
    await Promise.all(slotShotIds.slice(5).map((id) => createKlingJob(shotRequest(id, otherProject))));
    await expect(createKlingJob(shotRequest(11, otherProject))).rejects.toMatchObject({ code: "KLING_CONCURRENCY_LIMIT" });
    expect(getDb().select().from(klingJobs).all()).toHaveLength(10);
    expect(state.cli).not.toHaveBeenCalled();
  });
  it("reserves a slot for a known task with an unrecognized remote status while allowing other free slots", async () => {
    const first = await createKlingJob(shotRequest(1)); await dispatchKlingJob(first.id);
    patchKlingJob(first.id, { remoteState: "unknown" });
    for (const id of slotShotIds.slice(1)) expect((await createKlingJob(shotRequest(id))).submissionState).toBe("prepared");
    await expect(createKlingJob(shotRequest(11))).rejects.toMatchObject({ code: "KLING_CONCURRENCY_LIMIT" });
  });
  it("allows a separate principal to reserve its own ten slots", async () => {
    addProfile("profile-2", { principalKey: '["global","user-2"]' });
    await Promise.all(slotShotIds.map((id) => createKlingJob(shotRequest(id))));
    const other = await Promise.all(otherSlotShotIds.map((id) => createKlingJob(shotRequest(id, { profileId: "profile-2" }))));
    expect(other).toHaveLength(10); expect(getDb().select().from(klingJobs).all()).toHaveLength(20);
  });
  it("excludes persisted jobs from another region when reserving global account slots", async () => {
    await Promise.all(slotShotIds.map((id) => createKlingJob(shotRequest(id))));
    // Persisted region values are strings; this fixture does not add unsupported CLI profile regions.
    getDb().update(klingJobs).set({ region: "legacy-region" }).run();
    const global = await Promise.all(otherSlotShotIds.map((id) => createKlingJob(shotRequest(id))));
    expect(global).toHaveLength(10); expect(global.every((job) => job.region === "global")).toBe(true);
    expect(getDb().select().from(klingJobs).all()).toHaveLength(20);
  });
  it("protects an unresolved shot even when generation is requested through another account", async () => {
    addProfile("profile-2", { principalKey: '["global","user-2"]' });
    const original = await createKlingJob(shotRequest(1));
    await expect(createKlingJob(shotRequest(1, { profileId: "profile-2", clientRequestId: "other-account-1", billingAcknowledgement: { policyRevision: "credits-v1", acceptedForRequestId: "other-account-1" } })))
      .rejects.toMatchObject({ code: "KLING_REQUEST_CONFLICT", jobId: original.id });
  });
  it("blocks new and already prepared shots after an unknown submission without consuming their confirmation", async () => {
    const first = await createKlingJob(shotRequest(1)); const waiting = await createKlingJob(shotRequest(2));
    const authorization = getKlingJob(waiting.id).data.authorizedUntil;
    state.cli.mockResolvedValueOnce({ ...cliResult(), exitCode: 1, timedOut: true });
    await dispatchKlingJob(first.id); await dispatchKlingJob(waiting.id);
    expect(getKlingJob(waiting.id)).toMatchObject({ submissionState: "prepared", needsConfirmation: false,
      data: { authorizedUntil: authorization, error: { code: "KLING_REQUEST_CONFLICT" } } });
    await expect(createKlingJob(shotRequest(3))).rejects.toMatchObject({ code: "KLING_REQUEST_CONFLICT", jobId: first.id });
    expect(state.cli).toHaveBeenCalledTimes(1);
    patchKlingJob(first.id, { submissionState: "not_submitted", remoteState: "not_started" });
    await dispatchKlingJob(waiting.id); expect(getKlingJob(waiting.id).submissionState).toBe("acknowledged");
  });
  it("rechecks account uncertainty in the durable dispatch transaction after asynchronous identity checking", async () => {
    const first = await createKlingJob(shotRequest(1)); const waiting = await createKlingJob(shotRequest(2));
    state.refresh.mockImplementationOnce(async () => {
      patchKlingJob(first.id, { submissionState: "submission_unknown", remoteState: "unknown" }); return structuredClone(state.profile);
    });
    await dispatchKlingJob(waiting.id);
    expect(state.cli).not.toHaveBeenCalled(); expect(getKlingJob(waiting.id)).toMatchObject({ submissionState: "prepared", needsConfirmation: false, data: { error: { code: "KLING_REQUEST_CONFLICT" } } });
  });
  it("retries temporary CLI lock contention without requiring renewed billing confirmation", async () => {
    const job = await createKlingJob(shotRequest(1)); const authorization = job.data.authorizedUntil;
    state.lease.mockRejectedValueOnce(new KlingError("KLING_PROFILE_BUSY", "Another command owns this profile", 409));
    await dispatchKlingJob(job.id);
    expect(getKlingJob(job.id)).toMatchObject({ submissionState: "prepared", needsConfirmation: false, data: { authorizedUntil: authorization, error: { code: "KLING_PROFILE_BUSY" } } });
    await dispatchKlingJob(job.id); expect(getKlingJob(job.id).submissionState).toBe("acknowledged"); expect(state.cli).toHaveBeenCalledTimes(1);
  });
  it("keeps the ten-slot reservation limit when catalog refresh is temporarily busy", async () => {
    useMultipleShots(11);
    for (let shotId = 1; shotId <= 10; shotId++) await createKlingJob(shotRequest(shotId));
    state.profile!.catalogCheckedAt = Date.now() - 400_000;
    state.refresh.mockRejectedValueOnce(new KlingError("KLING_PROFILE_BUSY", "Another command owns this profile", 409));
    await expect(createKlingJob(shotRequest(11))).rejects.toMatchObject({ code: "KLING_CONCURRENCY_LIMIT" });
    expect(getDb().select().from(klingJobs).all()).toHaveLength(10);
    expect(state.cli).not.toHaveBeenCalled();
  });
  it("keeps unresolved account submission protection when catalog refresh is temporarily busy", async () => {
    const unknown = await createKlingJob(shotRequest(1));
    patchKlingJob(unknown.id, { submissionState: "submission_unknown", remoteState: "unknown" });
    state.profile!.catalogCheckedAt = Date.now() - 400_000;
    state.refresh.mockRejectedValueOnce(new KlingError("KLING_PROFILE_BUSY", "Another command owns this profile", 409));
    await expect(createKlingJob(shotRequest(2))).rejects.toMatchObject({ code: "KLING_REQUEST_CONFLICT", jobId: unknown.id });
    expect(getDb().select().from(klingJobs).all()).toHaveLength(1);
    expect(state.cli).not.toHaveBeenCalled();
  });
  it.each([false, true])("defers a status query during CLI contention without changing task state (existing error: %s)", async (hasPreviousError) => {
    const job = await createKlingJob(shotRequest(1)); await dispatchKlingJob(job.id);
    const previousError = hasPreviousError ? { code: "KLING_PREVIOUS_QUERY_FAILED", message: "Previous query needs recovery", retryable: true } : undefined;
    const blockedReason = hasPreviousError ? "previous_query" : undefined;
    patchKlingJob(job.id, { nextQueryAt: Date.now() - 1000 }, { error: previousError, blockedReason });
    const previous = getKlingJob(job.id); const task = getDb().select().from(aiTasks).where(eq(aiTasks.id, previous.data.aiTaskId!)).get()!;
    state.lease.mockRejectedValueOnce(new KlingError("KLING_PROFILE_BUSY", "A different shot is being submitted", 409));
    await expect(queryKlingJob(job.id)).rejects.toMatchObject({ code: "KLING_PROFILE_BUSY" });
    const waiting = getKlingJob(job.id);
    expect(waiting).toMatchObject({ submissionState: "acknowledged", remoteState: "pending", importState: "not_ready", remoteGenerationId: previous.remoteGenerationId });
    expect(waiting.data.error).toEqual(previousError); expect(waiting.data.blockedReason).toBe(blockedReason);
    expect(waiting.data.queryAttempts).toBe(previous.data.queryAttempts); expect(waiting.nextQueryAt).toBeGreaterThan(previous.nextQueryAt!);
    expect(getDb().select().from(aiTasks).where(eq(aiTasks.id, task.id)).get()).toEqual(task);
    expect(state.cli).toHaveBeenCalledTimes(1);
    state.cli.mockResolvedValueOnce({ ...cliResult(), json: { ok: true, body: { status: "processing", works: [] } } });
    await queryKlingJob(job.id);
    const recovered = getKlingJob(job.id);
    expect(recovered).toMatchObject({ submissionState: "acknowledged", remoteState: "processing" });
    expect(recovered.data.error).toBeUndefined(); expect(recovered.data.blockedReason).toBeUndefined();
    expect(getDb().select().from(aiTasks).where(eq(aiTasks.id, task.id)).get()?.status).toBe("processing");
    expect(state.cli).toHaveBeenCalledTimes(2);
  });
  it("dispatches only available oldest reservations when legacy rows exceed ten slots", async () => {
    const jobs = await Promise.all(slotShotIds.map((id) => createKlingJob(shotRequest(id))));
    for (const [index, job] of jobs.entries()) getDb().update(klingJobs).set({ createdAt: 100 + index }).where(eq(klingJobs.id, job.id)).run();
    getDb().insert(klingJobs).values({ ...getKlingJob(jobs[0].id), id: "legacy-extra", clientRequestId: "legacy-extra-request", shotId: 11, createdAt: 200 }).run();
    await dispatchKlingJob("legacy-extra"); expect(state.cli).not.toHaveBeenCalled();
    expect(getKlingJob("legacy-extra")).toMatchObject({ submissionState: "prepared", needsConfirmation: false, data: { error: { code: "KLING_CONCURRENCY_LIMIT" } } });
    for (const job of jobs) await dispatchKlingJob(job.id);
    expect(state.cli).toHaveBeenCalledTimes(10); await dispatchKlingJob("legacy-extra"); expect(state.cli).toHaveBeenCalledTimes(10);
    patchKlingJob(jobs[0].id, { remoteState: "failed" });
    await dispatchKlingJob("legacy-extra"); expect(getKlingJob("legacy-extra").submissionState).toBe("acknowledged");
  });
});

describe("Kling deletion during cloud operations", () => {
  it.each(["submission_unknown", "acknowledged", "prepared"] as const)("releases local shot/account blockers for a deleted %s job", async (submissionState) => {
    const first = await createKlingJob(request());
    patchKlingJob(first.id, { submissionState, remoteState: submissionState === "acknowledged" ? "processing" : "unknown" });
    expect(deleteKlingJob(first.id).deleted).toBe(true);
    const next = await createKlingJob(request({ clientRequestId: "request-2", billingAcknowledgement: { policyRevision: "credits-v1", acceptedForRequestId: "request-2" } }));
    expect(next.id).not.toBe(first.id);
    expect(state.cli).not.toHaveBeenCalled();
  });
  it("fences a late acknowledgement without recreating a mirrored task or local output", async () => {
    const job = await createKlingJob(request());
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    state.cli.mockImplementationOnce(async (_profile: KlingProfile, _args: string[], options: KlingRunOptions) => {
      entered(); await gate; options.onGenerationId?.("late-ack"); return cliResult("late-ack");
    });
    const operation = dispatchKlingJob(job.id).catch((error) => error);
    await ready; expect(deleteKlingJob(job.id).deleted).toBe(true);
    release(); expect(await operation).toMatchObject({ code: "KLING_JOB_DELETED" });
    expect(getDb().select().from(aiTasks).all()).toEqual([]);
    expect(getKlingOutputs(job.id)).toEqual([]);
    const calls = state.cli.mock.calls.length; await tick(); expect(state.cli).toHaveBeenCalledTimes(calls);
  });
  it("fences a paid submission deleted after its claim and before the child starts", async () => {
    const job = await createKlingJob(request());
    let entered!: () => void, release!: () => void, spawned = false;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    state.cli.mockImplementationOnce(async (_profile: KlingProfile, _args: string[], options: KlingRunOptions) => {
      entered(); await gate; options.beforeSpawn?.(); spawned = true; return cliResult("too-late");
    });
    const operation = dispatchKlingJob(job.id).catch((error) => error);
    await ready; deleteKlingJob(job.id); release();
    expect(await operation).toMatchObject({ code: "KLING_JOB_DELETED" }); expect(spawned).toBe(false);
  });
  it("fences a late query result before saving or downloading any output", async () => {
    const job = await acknowledge(await createKlingJob(request()));
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    state.cli.mockImplementationOnce(async () => {
      entered(); await gate; return { ...cliResult(), json: { ok: true, body: { status: "completed", works: [{ id: "work-1", url: "https://public.example.test/video.mp4" }] } } };
    });
    const operation = queryKlingJob(job.id).catch((error) => error);
    await ready; deleteKlingJob(job.id); release();
    expect(await operation).toMatchObject({ code: "KLING_JOB_DELETED" });
    expect(getDb().select().from(aiTasks).all()).toEqual([]); expect(getKlingOutputs(job.id)).toEqual([]); expect(state.download).not.toHaveBeenCalled();
  });
});

describe("Kling output persistence and selection", () => {
  async function completeJob() {
    const job = await acknowledge(await createKlingJob(request()));
    state.cli.mockResolvedValueOnce({ ...cliResult(), json: { ok: true, body: { status: "completed", works: [{ id: "work-1", type: "video", url: "https://public.example.test/video.mp4?secret=one" }] } } });
    await queryKlingJob(job.id); return getKlingJob(job.id);
  }
  async function preparePremiumCgJob() {
    configurePremiumCgContext();
    const imageModel = premiumCgImageModel();
    const inputPath = path.join(state.directory, "premium-product.png");
    const input = Buffer.from("premium product reference");
    await fs.writeFile(inputPath, input);
    state.prepare.mockResolvedValueOnce([{
      role: "image", sourceUrl: "/api/files/project-1/product.png", path: inputPath,
      hash: createHash("sha256").update(input).digest("hex"), size: input.length,
    }]);
    return acknowledge(await createKlingJob(request({ selectionKey: imageModel.selectionKey, mode: "image-to-video" })));
  }
  async function completePremiumCgJob(job?: KlingJob) {
    const target = job ?? await preparePremiumCgJob();
    state.cli.mockResolvedValueOnce({ ...cliResult(), json: { ok: true, body: { status: "completed", works: [{ id: "work-1", type: "video", url: "https://public.example.test/video.mp4" }] } } });
    await queryKlingJob(target.id);
    return getKlingJob(target.id);
  }
  it.each(["download", "probe", "poster", "lastFrame"] as const)("does not restore an output deleted during asynchronous %s", async (stage) => {
    const job = await acknowledge(await createKlingJob(request()));
    state.cli.mockResolvedValueOnce({ ...cliResult(), json: { ok: true, body: { status: "completed", works: [{ id: "work-1", url: "https://public.example.test/video.mp4" }] } } });
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const hook = stage === "download" ? state.download : stage === "probe" ? state.probe : stage === "poster" ? state.poster : state.lastFrame;
    const original = hook.getMockImplementation()!;
    hook.mockImplementationOnce(async (...args: unknown[]) => {
      entered(); await gate;
      if (stage === "lastFrame") await fs.writeFile(String(args[0]) + ".last.jpg", "late last frame");
      return original(...args);
    });
    const operation = queryKlingJob(job.id).catch((error) => error);
    await ready;
    const output = getKlingOutputs(job.id)[0];
    const directory = path.join(state.directory, "uploads", job.projectId, "kling", job.id);
    const source = path.join(directory, "source-keyframe.png"); await fs.writeFile(source, "original source");
    expect(deleteKlingJob(job.id)).toEqual({ deleted: true, jobId: job.id });
    release(); expect(await operation).toMatchObject({ code: "KLING_JOB_DELETED" });
    for (const suffix of [".part", ".mp4", ".mp4.thumb.jpg", ".mp4.last.jpg"]) await expect(fs.stat(path.join(directory, output.id + suffix))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(source, "utf8")).toBe("original source");
    expect(getDb().select().from(assets).all()).toEqual([]);
    expect(getDb().select().from(aiTasks).all()).toEqual([]);
    expect(getKlingOutputs(job.id)).toEqual([]);
    await tick(); expect(getKlingOutputs(job.id)).toEqual([]);
  });
  it("imports a downloaded video once and serves only its local URL to the browser", async () => {
    const job = await completeJob(); await importKlingOutputs(job.id);
    expect(getKlingOutputs(job.id)).toHaveLength(1); expect(state.download).toHaveBeenCalledTimes(1);
    const rows = getDb().select().from(assets).all(); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ selected: true, provider: "kling-cli", status: "done" });
    const view = klingJobView(getKlingJob(job.id)); expect(view.outputs[0].videoUrl).toMatch(/^\/api\/files\//); expect(JSON.stringify(view)).not.toContain("secret=one");
    expect(job.importState).toBe("completed");
  });
  it("replaces an untrusted selected take when a premium CG Kling output is imported", async () => {
    const job = await preparePremiumCgJob();
    getDb().insert(assets).values({
      id: "legacy-selected-take", projectId: "project-1", shotId: 1, type: "user_upload",
      filePath: "/api/files/project-1/legacy.mp4", selected: true, status: "done",
    }).run();

    await completePremiumCgJob(job);

    const output = getKlingOutputs(job.id)[0];
    expect(getDb().select().from(assets).where(eq(assets.id, "legacy-selected-take")).get()?.selected).toBe(false);
    expect(getDb().select().from(assets).where(eq(assets.id, output.assetId!)).get()).toMatchObject({ selected: true, provider: "kling-cli" });
    expect(output.data.selectionOutcome).toBe("selected");
  });
  it("keeps premium CG outputs detached after the creative configuration becomes stale", async () => {
    const job = await preparePremiumCgJob();
    getDb().update(projects).set({ creativeConfigRevision: 2 }).where(eq(projects.id, "project-1")).run();

    await completePremiumCgJob(job);

    const output = getKlingOutputs(job.id)[0];
    expect(output.data.selectionOutcome).toBe("detached");
    expect(getDb().select().from(assets).where(eq(assets.id, output.assetId!)).get()?.selected).toBe(false);
    let failure: unknown;
    try { selectKlingOutput(job.id, output.id, true); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "CREATIVE_CONFIG_STALE", status: 409 });
  });
  it("rejects selecting a premium CG output whose provenance is no longer trusted", async () => {
    const job = await completePremiumCgJob();
    await importKlingOutputs(job.id);
    const output = getKlingOutputs(job.id)[0];
    getDb().update(assets).set({ filePath: "/api/files/project-1/untrusted.mp4" }).where(eq(assets.id, output.assetId!)).run();

    let failure: unknown;
    try { selectKlingOutput(job.id, output.id, true); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "PREMIUM_CG_ASSET_PROVENANCE_REQUIRED", status: 409 });
  });
  it("keeps persisted outputs and mirrored URLs when a late query has no works", async () => {
    const job = await completeJob(); await queryKlingJob(job.id);
    expect(getKlingOutputs(job.id)).toHaveLength(1); expect(getKlingJob(job.id).remoteState).toBe("completed");
    expect(getDb().select().from(aiTasks).all()[0].resultUrls).toEqual(["https://public.example.test/video.mp4?secret=one"]);
    expect(state.download).toHaveBeenCalledTimes(1);
  });
  it("keeps a newly selected take when a late generation finishes", async () => {
    const job = await acknowledge(await createKlingJob(request()));
    getDb().insert(assets).values({ id: "new-user-take", projectId: "project-1", shotId: 1, type: "user_upload", filePath: "/api/files/new.mp4", selected: true, status: "done" }).run();
    state.cli.mockResolvedValueOnce({ ...cliResult(), json: { ok: true, body: { status: "completed", works: [{ id: "work-1", url: "https://public.example.test/video.mp4" }] } } });
    await queryKlingJob(job.id);
    expect(getDb().select().from(assets).where(eq(assets.id, "new-user-take")).get()?.selected).toBe(true);
    const output = getKlingOutputs(job.id)[0]; expect(output.data.selectionOutcome).toBe("kept_as_alternative");
    expect(getDb().select().from(assets).where(eq(assets.id, output.assetId!)).get()?.selected).toBe(false);
  });
  it("keeps a completed remote task after download failure and retries import without generating", async () => {
    const job = await acknowledge(await createKlingJob(request()));
    state.download.mockRejectedValueOnce(new Error("temporary download failure"));
    state.cli.mockResolvedValueOnce({ ...cliResult(), json: { ok: true, body: { status: "completed", works: [{ id: "work-1", url: "https://public.example.test/video.mp4" }] } } });
    await queryKlingJob(job.id); expect(getKlingJob(job.id)).toMatchObject({ remoteState: "completed", importState: "failed" });
    const calls = state.cli.mock.calls.length; await retryKlingImport(job.id);
    expect(state.cli).toHaveBeenCalledTimes(calls); expect(getKlingJob(job.id).importState).toBe("completed");
  });
  it("requires explicit adoption when a recovered output belongs to an old script", async () => {
    const job = await completeJob(); const output = getKlingOutputs(job.id)[0];
    getDb().update(scripts).set({ version: 2, shots: [{ ...shot, description: "Changed scene" }] }).where(eq(scripts.id, "script-1")).run();
    expect(() => selectKlingOutput(job.id, output.id, false)).toThrow(/旧脚本/);
    selectKlingOutput(job.id, output.id, true); selectKlingOutput(job.id, output.id, true);
    const rows = getDb().select().from(assets).all(); expect(rows).toHaveLength(2);
    const script = getDb().select().from(scripts).where(eq(scripts.id, "script-1")).get()!;
    const current = filterAssetsForScript(rows.filter((row) => row.selected), script);
    expect(current).toHaveLength(1);
    expect(current[0].derivedFromAssetId).toBe(output.assetId);
    const projection = klingJobView(getKlingJob(job.id)).outputs[0];
    expect(projection.selected).toBe(true); expect(projection.assetId).toBe(current[0].id);
  });
});

describe("Kling FilmRun child dispatch authorization", () => {
  const context: KlingFilmShotContext = { filmRunId: "film-run-1", filmShotId: "film-shot-1", authorizationEpoch: 1, expectedInputHashes: [] };
  beforeEach(() => {
    const now = Date.now();
    getDb().insert(klingFilmRuns).values({ id: context.filmRunId, projectId: "project-1", scriptId: "script-1", profileId: "profile-1", principalKey: state.profile!.principalKey!, status: "running", createdAt: now, updatedAt: now,
      data: { scriptRevision: "fixture", scriptSnapshot: { shots: [shot] }, model, output: { resolution: "720p", aspectRatio: "9:16", audioStrategy: "edge-tts", voice: "zh-CN-XiaoxiaoNeural", subtitles: true }, planHash: "fixture-plan", expiresAt: now + 120000, reuseExistingVideos: true, warnings: [], stage: "running", authorizationEpoch: 1 } }).run();
  });
  it("rejects a child whose parent is absent or belongs to another project or principal", async () => {
    getDb().update(klingFilmRuns).set({ projectId: "another-project" }).run();
    await expect(createKlingFilmShotJob(request(), context)).rejects.toMatchObject({ code: "KLING_FILM_CONTEXT_INVALID" });
    getDb().update(klingFilmRuns).set({ projectId: "project-1", principalKey: "another-user" }).run();
    await expect(createKlingFilmShotJob(request(), context)).rejects.toMatchObject({ code: "KLING_FILM_CONTEXT_INVALID" });
    getDb().delete(klingFilmRuns).run();
    await expect(createKlingFilmShotJob(request(), context)).rejects.toMatchObject({ code: "KLING_FILM_CONTEXT_INVALID" });
    expect(state.cli).not.toHaveBeenCalled(); expect(getDb().select().from(klingJobs).all()).toHaveLength(0);
  });
  it("blocks ordinary jobs during active films while allowing unconfirmed drafts", async () => {
    await expect(createKlingJob(request())).rejects.toMatchObject({ code: "KLING_FILM_CONFLICT" });
    getDb().update(klingFilmRuns).set({ status: "draft" }).run();
    expect((await createKlingJob(request())).submissionState).toBe("prepared"); expect(state.cli).not.toHaveBeenCalled();
  });
  it("creates an idempotent linked child without dispatching it through the generic runner", async () => {
    const job = await createKlingFilmShotJob(request(), context);
    const duplicate = await createKlingFilmShotJob(request(), { ...context, authorizationEpoch: 2 });
    expect(duplicate.id).toBe(job.id);
    expect(job.data).toMatchObject({ filmRunId: "film-run-1", filmShotId: "film-shot-1", filmAuthorizationEpoch: 1 });
    await tick(); expect(state.cli).not.toHaveBeenCalled();
    expect(getKlingJob(job.id).submissionState).toBe("prepared");
  });
  it("does not accept FilmRun ownership or dispatch flags from browser requests", async () => {
    await expect(createKlingJob({ ...request(), filmRunId: "film-run-1" })).rejects.toMatchObject({ code: "KLING_SCOPE_UNSUPPORTED" });
    await expect(createKlingJob({ ...request(), executionScope: "film" })).rejects.toMatchObject({ code: "KLING_SCOPE_UNSUPPORTED" });
    await expect(createKlingJob({ ...request(), suppressAutoDispatch: true })).rejects.toMatchObject({ code: "KLING_SCOPE_UNSUPPORTED" });
    expect(getDb().select().from(klingJobs).all()).toHaveLength(0);
  });
  it("prevents the ordinary create, dispatch and continue paths from taking over a film child", async () => {
    const job = await createKlingFilmShotJob(request(), context);
    await expect(createKlingJob(request())).rejects.toMatchObject({ code: "KLING_REQUEST_CONFLICT" });
    await expect(dispatchKlingJob(job.id)).rejects.toMatchObject({ code: "KLING_FILM_MANAGED_JOB" });
    await expect(continueKlingJob(job.id, { explicitConfirmation: true })).rejects.toMatchObject({ code: "KLING_FILM_MANAGED_JOB" });
    expect(state.cli).not.toHaveBeenCalled();
  });
  it("compares the copied inputs with the parent manifest before persisting a child", async () => {
    state.prepare.mockResolvedValueOnce([{ role: "image", sourceUrl: "/api/files/input.png", path: "/fixture/input.png", hash: "a".repeat(64), size: 10 }]);
    await expect(createKlingFilmShotJob(request(), context)).rejects.toMatchObject({ code: "KLING_INPUT_CHANGED" });
    expect(getDb().select().from(klingJobs).all()).toHaveLength(0); expect(state.cli).not.toHaveBeenCalled();
  });
  it("compares input roles and order rather than only the set of hashes", async () => {
    const image = { role: "image", sourceUrl: "/api/files/a.png", path: "/fixture/a.png", hash: "a".repeat(64), size: 10 };
    const tail = { role: "tailImage", sourceUrl: "/api/files/b.png", path: "/fixture/b.png", hash: "b".repeat(64), size: 10 };
    state.prepare.mockResolvedValueOnce([tail, image]);
    await expect(createKlingFilmShotJob(request(), { ...context, expectedInputHashes: [{ role: image.role, hash: image.hash }, { role: tail.role, hash: tail.hash }] })).rejects.toMatchObject({ code: "KLING_INPUT_CHANGED" });
    expect(state.cli).not.toHaveBeenCalled();
  });
  it("requires a synchronous parent guard and checks it both before preparation and in the dispatch claim", async () => {
    const job = await createKlingFilmShotJob(request(), context); const guard = vi.fn();
    await dispatchKlingFilmShotJob(job.id, { ...context, assertDispatchAllowed: guard });
    expect(guard).toHaveBeenCalledTimes(2); expect(state.cli).toHaveBeenCalledTimes(1);
    expect(getKlingJob(job.id)).toMatchObject({ submissionState: "acknowledged", remoteGenerationId: "remote-1" });
    await dispatchKlingFilmShotJob(job.id, { ...context, assertDispatchAllowed: guard });
    expect(state.cli).toHaveBeenCalledTimes(1);
  });
  it("does not submit when a FilmRun pauses during asynchronous account checking", async () => {
    const job = await createKlingFilmShotJob(request(), context); let allowed = true;
    state.refresh.mockImplementationOnce(async () => { allowed = false; return structuredClone(state.profile); });
    const guard = () => { if (!allowed) throw new KlingError("KLING_FILM_PAUSED", "Parent is paused", 409); };
    await dispatchKlingFilmShotJob(job.id, { ...context, assertDispatchAllowed: guard });
    expect(state.cli).not.toHaveBeenCalled();
    expect(getKlingJob(job.id)).toMatchObject({ submissionState: "prepared", needsConfirmation: true, data: { error: { code: "KLING_FILM_PAUSED" } } });
  });
  it("rejects an accidentally asynchronous parent guard before any paid dispatch", async () => {
    const job = await createKlingFilmShotJob(request(), context);
    await expect(dispatchKlingFilmShotJob(job.id, { ...context, async assertDispatchAllowed() {} })).rejects.toMatchObject({ code: "KLING_FILM_CONTEXT_INVALID" });
    expect(state.cli).not.toHaveBeenCalled();
  });
  it("requires renewed parent authorization after a restart before reauthorizing an old prepared child", async () => {
    const job = await createKlingFilmShotJob(request(), context);
    patchKlingJob(job.id, {}, { authorizedBootId: "old-server-boot" }); await tick();
    expect(getKlingJob(job.id).needsConfirmation).toBe(true); expect(state.cli).not.toHaveBeenCalled();
    await expect(dispatchKlingFilmShotJob(job.id, { ...context, assertDispatchAllowed() { throw new KlingError("KLING_FILM_RECONFIRM_REQUIRED", "Restart needs batch consent", 409); } })).rejects.toMatchObject({ code: "KLING_FILM_RECONFIRM_REQUIRED" });
    expect(state.cli).not.toHaveBeenCalled();
    await dispatchKlingFilmShotJob(job.id, { ...context, authorizationEpoch: 2, assertDispatchAllowed() {} });
    expect(getKlingJob(job.id)).toMatchObject({ submissionState: "acknowledged", needsConfirmation: false, data: { filmAuthorizationEpoch: 2 } });
    expect(state.cli).toHaveBeenCalledTimes(1);
  });
  it("rejects grants for another film shot, obsolete epochs, or a different input manifest", async () => {
    const job = await createKlingFilmShotJob(request(), { ...context, authorizationEpoch: 2 });
    await expect(dispatchKlingFilmShotJob(job.id, { ...context, assertDispatchAllowed() {} })).rejects.toMatchObject({ code: "KLING_FILM_MANAGED_JOB" });
    await expect(dispatchKlingFilmShotJob(job.id, { ...context, authorizationEpoch: 2, filmShotId: "film-shot-other", assertDispatchAllowed() {} })).rejects.toMatchObject({ code: "KLING_FILM_MANAGED_JOB" });
    await expect(dispatchKlingFilmShotJob(job.id, { ...context, authorizationEpoch: 2, expectedInputHashes: [{ role: "image", hash: "a".repeat(64) }], assertDispatchAllowed() {} })).rejects.toMatchObject({ code: "KLING_INPUT_CHANGED" });
    expect(state.cli).not.toHaveBeenCalled();
  });
  it("keeps uncertain child submissions uncertain across parent resume without regenerating", async () => {
    const job = await createKlingFilmShotJob(request(), context); state.cli.mockResolvedValueOnce({ ...cliResult(), exitCode: 1, timedOut: true });
    await dispatchKlingFilmShotJob(job.id, { ...context, assertDispatchAllowed() {} });
    await dispatchKlingFilmShotJob(job.id, { ...context, authorizationEpoch: 2, assertDispatchAllowed() {} });
    await tick();
    expect(getKlingJob(job.id).submissionState).toBe("submission_unknown"); expect(state.cli).toHaveBeenCalledTimes(1);
  });
  it("keeps the same-shot unresolved job protection for film children", async () => {
    await createKlingFilmShotJob(request(), context);
    await expect(createKlingFilmShotJob(request({ clientRequestId: "request-2", billingAcknowledgement: { policyRevision: "credits-v1", acceptedForRequestId: "request-2" } }), { ...context, filmShotId: "film-shot-2" })).rejects.toMatchObject({ code: "KLING_REQUEST_CONFLICT" });
    expect(state.cli).not.toHaveBeenCalled();
  });
  it("shares ten account reservations between different film shots and prevents an eleventh", async () => {
    useMultipleShots(11);
    for (const shotId of Array.from({ length: 10 }, (_, index) => index + 1)) {
      const job = await createKlingFilmShotJob(shotRequest(shotId), { ...context, filmShotId: `film-shot-${shotId}` });
      expect(job.submissionState).toBe("prepared");
    }
    await expect(createKlingFilmShotJob(shotRequest(11), { ...context, filmShotId: "film-shot-11" })).rejects.toMatchObject({ code: "KLING_CONCURRENCY_LIMIT" });
    expect(state.cli).not.toHaveBeenCalled();
  });
});
