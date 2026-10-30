// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { GenerationExecutionError, type GenerationExecutionItem } from "@/lib/generation-types";
import type { KlingProfile, KlingVideoModelDescriptor } from "@/lib/kling/types";

const state = vi.hoisted(() => ({ directory: "", sqlite: null as Database.Database | null, execute: vi.fn() }));
vi.mock("@/lib/paths", () => ({ getDataDir: () => state.directory, getUploadsDir: () => `${state.directory}/uploads` }));
vi.mock("@/lib/db", async () => {
  const { default: Sqlite } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  state.sqlite = new Sqlite(":memory:"); state.sqlite.pragma("foreign_keys = ON");
  const db = drizzle(state.sqlite);
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return { db, getDb: () => db };
});
vi.mock("@/lib/generation-executor", () => ({ executeGenerationItem: (...args: unknown[]) => state.execute(...args) }));
import { getDb } from "@/lib/db";
import { assets, characters, projects, scripts } from "@/lib/db/schema";
import { assetScopeForShot } from "@/lib/asset-context";
import { createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { generationItems, generationRuns } from "@/lib/generation-schema";
import { klingProfiles } from "@/lib/kling/profile-schema";
import { decryptGenerationValue, encryptGenerationValue } from "@/lib/generation-secrets";
import { deleteGenerationRuns, enqueueGenerationRun, generationRunAction, getGenerationRun, listGenerationRuns, runGenerationTick, stopGenerationRunner, type EnqueueGenerationRunInput } from "@/lib/generation-runs";

const klingModel: KlingVideoModelDescriptor = { selectionKey: "fixture-kling-model", provider: "kling-cli", profileId: "profile-1", region: "global", tool: "text_to_video", remoteModelId: "model-1", displayName: "Model 1", catalogRevision: "catalog-1", available: true, parameters: [], inputSlots: [], capabilities: { image: false, tailFrame: false, multiImage: false, audio: false } };
function klingProfile(): KlingProfile {
  return { id: "profile-1", label: "Kling account", region: "global", cliPackage: "@klingai/cli-global", cliVersion: "0.2.0", adapterVersion: "1", nodePath: "node", packagePath: "fixture", cliEntry: "fixture", homePath: "fixture", endpoint: "https://kling.ai/mcp", environmentState: "ready", authState: "authenticated", authRevision: 1, principalKey: "frozen-principal", catalogSnapshot: [structuredClone(klingModel)], catalogRevision: "catalog-1", catalogCheckedAt: Date.now(), createdAt: 1, updatedAt: 1 };
}

function input(projectId = "A", count = 1): EnqueueGenerationRunInput {
  return { projectId, clientRequestId: `request-${projectId}`, kind: "video_batch", items: Array.from({ length: count }, (_, i) => ({ kind: "video", scriptId: `script-${projectId}`, shotId: i + 1,
    request: { provider: "mock", apiKey: "frozen-secret", model: "original", prompt: `shot ${i + 1}`, options: { duration: 5 } }, asset: { type: "ai_generated", shotId: i + 1 } })) };
}
const scriptValidationMessage = "Shot 2 has on_camera speech in detail framing; use off_camera narration or choose a framing that includes the speaking face.";
function stalledScriptValidation() {
  const db = getDb();
  db.update(projects).set({ creativeProfile: createTideweOutdoorProfile() }).where(eq(projects.id, "A")).run();
  const request: EnqueueGenerationRunInput = { projectId: "A", clientRequestId: "stalled-script", kind: "script", items: [{ kind: "script", request: {} }] };
  const run = enqueueGenerationRun(request);
  const item = db.select().from(generationItems).where(eq(generationItems.runId, run.id)).get()!;
  db.update(generationItems).set({ status: "needs_attention", stage: "needs_attention", error: scriptValidationMessage,
    errorCode: "GENERATION_NEEDS_ATTENTION", checkpoint: encryptGenerationValue({ submissionState: "submitting" }) }).where(eq(generationItems.id, item.id)).run();
  return { run, item, request };
}
function refinementInput(projectId = "A", count = 1): EnqueueGenerationRunInput {
  const db = getDb();
  const script = db.select().from(scripts).where(eq(scripts.id, `script-${projectId}`)).get()!;
  const directory = path.join(state.directory, "uploads", projectId);
  mkdirSync(directory, { recursive: true });
  return { projectId, clientRequestId: `refine-${projectId}`, kind: count === 1 ? "keyframe_refine" : "keyframe_refine_batch", items: Array.from({ length: count }, (_, index) => {
    const shot = script.shots![index], sourceAssetId = `source-${projectId}-${shot.shotId}`;
    const sourceImageUrl = `/api/files/${projectId}/${sourceAssetId}.png`;
    writeFileSync(path.join(directory, `${sourceAssetId}.png`), `source bytes ${index}`);
    db.insert(assets).values({ id: sourceAssetId, projectId, shotId: shot.shotId, type: "ai_generated", filePath: sourceImageUrl, status: "done", ...assetScopeForShot(script, shot) }).run();
    return { kind: "keyframe_refine", scriptId: script.id, shotId: shot.shotId, request: { scriptId: script.id, shotId: shot.shotId, sourceAssetId, sourceImageUrl,
      provider: "openai", model: "gpt-image-2", apiKey: "refinement-secret", issues: ["hands"], resolution: "720p" } };
  }) };
}
async function settled(id: string) { await vi.waitFor(() => expect(["completed", "failed", "needs_attention", "waiting"].includes(getGenerationRun(id).status)).toBe(true)); }
beforeAll(() => { state.directory = mkdtempSync(path.join(tmpdir(), "clipforge-generation-test-")); });
afterAll(() => { stopGenerationRunner(); state.sqlite?.close(); rmSync(state.directory, { recursive: true, force: true }); });
beforeEach(() => {
  vi.stubEnv("NEXT_PHASE", "phase-production-build"); state.execute.mockReset();
  const db = getDb(); db.delete(generationItems).run(); db.delete(generationRuns).run(); db.delete(klingProfiles).run(); db.delete(assets).run(); db.delete(characters).run(); db.delete(scripts).run(); db.delete(projects).run();
  db.insert(klingProfiles).values({ id: "profile-1", data: klingProfile() }).run();
  for (const id of ["A", "B"]) {
    db.insert(projects).values({ id, name: `Project ${id}`, productName: `Product ${id}` }).run();
    db.insert(scripts).values({ id: `script-${id}`, projectId: id, styleType: "scene", selected: true,
      shots: Array.from({ length: 15 }, (_, i) => ({ shotId: i + 1, type: "demo", duration: 5, description: "demo", voiceover: "test", camera: "static", visualSource: "ai_generate", transition: "direct_concat" })) }).run();
  }
});
afterEach(() => { stopGenerationRunner(); vi.unstubAllEnvs(); });

describe("finished generation record deletion", () => {
  function finish(id: string, statuses: string[]) {
    const db = getDb();
    const items = db.select().from(generationItems).where(eq(generationItems.runId, id)).all();
    for (let index = 0; index < items.length; index++) db.update(generationItems).set({ status: statuses[index], leaseOwner: null, leaseExpiresAt: null }).where(eq(generationItems.id, items[index].id)).run();
    return items;
  }
  it.each([["completed"], ["failed"], ["completed", "failed"]])("soft deletes finished %j records and retains request, items, assets and files", (...statuses) => {
    const request = refinementInput("A", statuses.length);
    const run = enqueueGenerationRun(request);
    finish(run.id, statuses);
    const db = getDb();
    const oldRun = db.select().from(generationRuns).get()!;
    const oldItems = db.select().from(generationItems).all();
    const oldAssets = db.select().from(assets).all();
    const source = path.join(state.directory, "uploads", "A", "source-A-1.png");
    const bytes = readFileSync(source);
    expect(deleteGenerationRuns("A", run.id)).toEqual({ deletedIds: [run.id], deletedCount: 1 });
    expect(db.select().from(generationRuns).get()).toEqual({ ...oldRun, deletedAt: expect.any(Number) });
    expect(db.select().from(generationItems).all()).toEqual(oldItems);
    expect(db.select().from(assets).all()).toEqual(oldAssets);
    expect(readFileSync(source)).toEqual(bytes);
    expect(listGenerationRuns()).toEqual([]);
    expect(listGenerationRuns("A")).toEqual([]);
    expect(deleteGenerationRuns("A", run.id)).toEqual({ deletedIds: [], deletedCount: 0 });
    expect(() => getGenerationRun(run.id)).toThrow(expect.objectContaining({ status: 410, code: "GENERATION_RUN_DELETED" }));
    for (const action of ["retry_import", "cancel"]) expect(() => generationRunAction(run.id, action)).toThrow(expect.objectContaining({ status: 410, code: "GENERATION_RUN_DELETED" }));
    for (const replay of [request, { ...request, label: "changed" }]) expect(() => enqueueGenerationRun(replay)).toThrow(expect.objectContaining({ status: 410, code: "GENERATION_RUN_DELETED" }));
    expect(db.select().from(generationRuns).all()).toHaveLength(1);
    expect(state.execute).not.toHaveBeenCalled();
  });
  it.each(["queued", "running", "waiting", "importing", "needs_attention", "cancelled", "unknown"])("rejects a failed batch containing a %s item", (status) => {
    const run = enqueueGenerationRun(input("A", 2));
    finish(run.id, ["failed", status]);
    expect(() => deleteGenerationRuns("A", run.id)).toThrow(expect.objectContaining({ status: 409, code: "GENERATION_RUN_NOT_DELETABLE" }));
    expect(getDb().select().from(generationRuns).get()?.deletedAt).toBeNull();
  });
  it.each([{ leaseOwner: "worker", leaseExpiresAt: null }, { leaseOwner: null, leaseExpiresAt: 1 }])("rejects terminal statuses while an execution lease remains: %j", (lease) => {
    const run = enqueueGenerationRun(input());
    const [item] = finish(run.id, ["completed"]);
    getDb().update(generationItems).set(lease).where(eq(generationItems.id, item.id)).run();
    expect(() => deleteGenerationRuns("A", run.id)).toThrow(expect.objectContaining({ code: "GENERATION_RUN_NOT_DELETABLE" }));
  });
  it("requires a valid project, keeps cross-project records private and rejects an empty batch", () => {
    const run = enqueueGenerationRun(input());
    finish(run.id, ["completed"]);
    for (const projectId of [undefined, null, "", "  "]) expect(() => deleteGenerationRuns(projectId, run.id)).toThrow(expect.objectContaining({ status: 400, code: "GENERATION_PROJECT_REQUIRED" }));
    expect(() => deleteGenerationRuns("missing", run.id)).toThrow(expect.objectContaining({ status: 404, code: "GENERATION_PROJECT_NOT_FOUND" }));
    expect(() => deleteGenerationRuns("B", run.id)).toThrow(expect.objectContaining({ status: 404, code: "GENERATION_RUN_NOT_FOUND" }));
    getDb().delete(generationItems).where(eq(generationItems.runId, run.id)).run();
    expect(() => deleteGenerationRuns("A", run.id)).toThrow(expect.objectContaining({ code: "GENERATION_RUN_NOT_DELETABLE" }));
  });
  it("atomically bulk deletes only eligible records in the current project", () => {
    const db = getDb();
    const a = enqueueGenerationRun(input()); finish(a.id, ["completed"]);
    const failed = enqueueGenerationRun({ ...input(), clientRequestId: "failed" }); finish(failed.id, ["failed"]);
    const mixed = enqueueGenerationRun({ ...input("A", 2), clientRequestId: "mixed" }); finish(mixed.id, ["failed", "waiting"]);
    const b = enqueueGenerationRun(input("B")); finish(b.id, ["completed"]);
    const result = deleteGenerationRuns("A");
    expect(result.deletedCount).toBe(2); expect(result.deletedIds.sort()).toEqual([a.id, failed.id].sort());
    expect(listGenerationRuns().map((run) => run.id).sort()).toEqual([mixed.id, b.id].sort());
    expect(db.select().from(generationItems).all()).toHaveLength(5);
    expect(deleteGenerationRuns("A")).toEqual({ deletedIds: [], deletedCount: 0 });
  });
  it("rolls back every tombstone if a bulk update fails", () => {
    const a = enqueueGenerationRun(input()); finish(a.id, ["completed"]);
    const b = enqueueGenerationRun({ ...input(), clientRequestId: "abort-delete" }); finish(b.id, ["failed"]);
    state.sqlite!.exec("CREATE TRIGGER prevent_test_delete BEFORE UPDATE OF deleted_at ON generation_runs WHEN OLD.client_request_id = 'abort-delete' AND NEW.deleted_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'deletion failed'); END");
    try { expect(() => deleteGenerationRuns("A")).toThrow("deletion failed"); }
    finally { state.sqlite!.exec("DROP TRIGGER prevent_test_delete"); }
    expect(getDb().select().from(generationRuns).all().every((run) => run.deletedAt === null)).toBe(true);
    expect(listGenerationRuns("A")).toHaveLength(2);
  });
  it("never reconciles hidden script failures on get or list", () => {
    const { run, item } = stalledScriptValidation();
    finish(run.id, ["failed"]);
    deleteGenerationRuns("A", run.id);
    getDb().update(generationItems).set({ status: "needs_attention" }).where(eq(generationItems.id, item.id)).run();
    const before = getDb().select().from(generationItems).get();
    expect(() => getGenerationRun(run.id)).toThrow(expect.objectContaining({ code: "GENERATION_RUN_DELETED" }));
    expect(listGenerationRuns()).toEqual([]);
    expect(listGenerationRuns("A")).toEqual([]);
    expect(getDb().select().from(generationItems).get()).toEqual(before);
  });
  it("rechecks deletion under the recovery transaction lock", () => {
    const db = getDb(), run = enqueueGenerationRun(input());
    const [item] = finish(run.id, ["failed"]);
    db.update(generationItems).set({ checkpoint: encryptGenerationValue({ taskId: "already-paid" }) }).where(eq(generationItems.id, item.id)).run();
    const transaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementationOnce(((callback, options) => {
      expect(options).toEqual({ behavior: "immediate" });
      deleteGenerationRuns("A", run.id); // The competing delete commits before recovery obtains its lock.
      return transaction(callback, options);
    }) as typeof db.transaction);
    try { expect(() => generationRunAction(run.id, "retry_import")).toThrow(expect.objectContaining({ code: "GENERATION_RUN_DELETED" })); }
    finally { spy.mockRestore(); }
    expect(db.select().from(generationItems).get()?.status).toBe("failed");
  });
  it("rechecks active items under the deletion transaction lock after recovery wins", () => {
    const db = getDb(), run = enqueueGenerationRun(input());
    const [item] = finish(run.id, ["failed"]);
    db.update(generationItems).set({ checkpoint: encryptGenerationValue({ taskId: "already-paid" }) }).where(eq(generationItems.id, item.id)).run();
    const transaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementationOnce(((callback, options) => {
      expect(options).toEqual({ behavior: "immediate" });
      generationRunAction(run.id, "retry_import"); // Recovery commits before deletion obtains its lock.
      return transaction(callback, options);
    }) as typeof db.transaction);
    try { expect(() => deleteGenerationRuns("A", run.id)).toThrow(expect.objectContaining({ code: "GENERATION_RUN_NOT_DELETABLE" })); }
    finally { spy.mockRestore(); }
    expect(db.select().from(generationRuns).get()?.deletedAt).toBeNull();
    expect(db.select().from(generationItems).get()?.status).toBe("waiting");
  });
  it("never claims a deleted parent even if a legacy item incorrectly becomes active", async () => {
    const db = getDb(), run = enqueueGenerationRun(input());
    const [item] = finish(run.id, ["completed"]);
    deleteGenerationRuns("A", run.id);
    db.update(generationItems).set({ status: "queued" }).where(eq(generationItems.id, item.id)).run();
    vi.stubEnv("NEXT_PHASE", ""); await runGenerationTick();
    expect(state.execute).not.toHaveBeenCalled();
    expect(db.select().from(generationItems).get()?.status).toBe("queued");
  });
});

describe("durable cross-project generation", () => {
  it.each([undefined, "720p", "1080p"])("freezes the selected refinement resolution and defaults omission to 720p (%s)", (resolution) => {
    const request = refinementInput();
    if (resolution === undefined) delete request.items[0].request.resolution;
    else request.items[0].request.resolution = resolution;
    const before = structuredClone(request);
    enqueueGenerationRun(request);
    const payload = decryptGenerationValue<GenerationExecutionItem["payload"]>(getDb().select().from(generationItems).get()!.payload);
    expect(payload.request.resolution).toBe(resolution ?? "720p");
    expect(request).toEqual(before);
    expect(state.execute).not.toHaveBeenCalled();
  });
  it.each(["2k", "4k", "1440p", null])("rejects an invalid refinement resolution atomically before accepting a batch (%s)", (resolution) => {
    const request = refinementInput("A", 3);
    request.items[2].request.resolution = resolution;
    expect(() => enqueueGenerationRun(request)).toThrow("请选择 720p 或 1080p 精修分辨率");
    expect(listGenerationRuns()).toEqual([]);
    expect(getDb().select().from(generationItems).all()).toEqual([]);
    expect(state.execute).not.toHaveBeenCalled();
  });
  it.each([1, 4])("atomically registers %s refinement shots with durable source snapshots", (count) => {
    const request = refinementInput("A", count);
    const run = enqueueGenerationRun(request);
    expect(run.kind).toBe(count === 1 ? "keyframe_refine" : "keyframe_refine_batch");
    expect(run.total).toBe(count);
    expect(run.items.every((item) => item.kind === "keyframe_refine" && item.status === "queued")).toBe(true);
    for (const saved of getDb().select().from(generationItems).all()) {
      const payload = decryptGenerationValue<GenerationExecutionItem["payload"]>(saved.payload);
      expect(payload.snapshot?.refinement?.source).toMatchObject({ id: `source-A-${saved.shotId}`, projectId: "A", sourceScriptId: "script-A" });
      expect(payload.snapshot?.referenceInputs).toEqual([expect.objectContaining({ url: `/api/files/A/source-A-${saved.shotId}.png`, hash: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
      expect(saved.payload).not.toContain("refinement-secret");
    }
  });
  it("rejects an entire refinement batch when one source belongs to another shot", () => {
    const request = refinementInput("A", 3);
    request.items[2].request.sourceAssetId = "source-A-1";
    expect(() => enqueueGenerationRun(request)).toThrow("精修源图不属于");
    expect(listGenerationRuns()).toEqual([]);
    expect(getDb().select().from(generationItems).all()).toEqual([]);
  });
  it("freezes an optional region without changing the source reference list", () => {
    const request = refinementInput();
    const focusRegion = { x: 0, y: 0.7, width: 1, height: 0.3 };
    Object.assign(request.items[0].request, { issues: ["integration"], focusRegion });
    enqueueGenerationRun(request);
    focusRegion.y = 0.5;
    const payload = decryptGenerationValue<GenerationExecutionItem["payload"]>(getDb().select().from(generationItems).get()!.payload);
    expect(payload.request.focusRegion).toEqual({ x: 0, y: 0.7, width: 1, height: 0.3 });
    expect(payload.snapshot?.referenceInputs).toHaveLength(1);
    expect(payload.snapshot?.referenceInputs?.[0].url).toBe("/api/files/A/source-A-1.png");
    expect(state.execute).not.toHaveBeenCalled();
  });
  it.each([
    { focusRegion: { x: 0, y: 0.7, width: 1, height: 0.3, feather: 0.1 }, code: "INVALID_FOCUS_REGION" },
    { focusRegion: { x: 0, y: 0.7, width: 1, height: 0.3 }, issues: ["integration", "hands"], code: "FOCUS_REGION_REQUIRES_INTEGRATION" },
    { focusRegion: { x: 0, y: 0.7, width: 1, height: 0.3 }, provider: "fal-ai", code: "FOCUS_MASK_UNSUPPORTED" },
    { focusRegion: { x: 0, y: 0.7, width: 1, height: 0.3 }, model: "gpt-image-1.5", code: "FOCUS_MASK_UNSUPPORTED" },
  ])("rejects invalid region enqueue before accepting any task ($code)", ({ code, ...fields }) => {
    const request = refinementInput();
    Object.assign(request.items[0].request, { issues: ["integration"], ...fields });
    expect(() => enqueueGenerationRun(request)).toThrow(expect.objectContaining({ status: 400, code }));
    expect(getDb().select().from(generationItems).all()).toEqual([]);
    expect(state.execute).not.toHaveBeenCalled();
  });
  it("rejects a non-PNG region source before enqueue", () => {
    const request = refinementInput();
    Object.assign(request.items[0].request, { issues: ["integration"], focusRegion: { x: 0, y: 0.7, width: 1, height: 0.3 }, sourceImageUrl: "/api/files/A/source.jpg" });
    getDb().update(assets).set({ filePath: "/api/files/A/source.jpg" }).where(eq(assets.id, "source-A-1")).run();
    expect(() => enqueueGenerationRun(request)).toThrow(expect.objectContaining({ status: 400, code: "FOCUS_MASK_PNG_REQUIRED" }));
    expect(getDb().select().from(generationItems).all()).toEqual([]);
    expect(state.execute).not.toHaveBeenCalled();
  });
  it("rejects stale or missing refinement source files before accepting a batch", () => {
    const request = refinementInput("A", 2);
    request.items[1].request.sourceImageUrl = "/api/files/A/changed.png";
    expect(() => enqueueGenerationRun(request)).toThrow("精修源图已变化");
    request.items[1].request.sourceImageUrl = "/api/files/A/source-A-2.png";
    rmSync(path.join(state.directory, "uploads", "A", "source-A-2.png"));
    expect(() => enqueueGenerationRun(request)).toThrow("本地参考素材不存在");
    expect(listGenerationRuns()).toEqual([]);
  });
  it("freezes the resolved presenter reference and source row independently from later library edits", () => {
    const db = getDb();
    const request = refinementInput();
    const presenter = "/api/files/A/presenter.png";
    writeFileSync(path.join(state.directory, "uploads", "A", "presenter.png"), "original presenter");
    db.insert(characters).values({ id: "presenter", name: "Presenter", referenceImages: [presenter] }).run();
    db.update(projects).set({ characterId: "presenter" }).where(eq(projects.id, "A")).run();
    enqueueGenerationRun(request);
    db.update(characters).set({ referenceImages: ["https://example.test/new.png"] }).where(eq(characters.id, "presenter")).run();
    db.update(assets).set({ filePath: "/api/files/A/edited.png" }).where(eq(assets.id, "source-A-1")).run();
    const payload = decryptGenerationValue<GenerationExecutionItem["payload"]>(db.select().from(generationItems).get()!.payload);
    expect(payload.snapshot?.refinement).toMatchObject({ source: { filePath: "/api/files/A/source-A-1.png" }, presenterReference: presenter });
    expect(payload.snapshot?.referenceInputs?.map((input) => input.url)).toEqual(expect.arrayContaining(["/api/files/A/source-A-1.png", presenter]));
  });
  it("deduplicates lost refinement acknowledgements and prevents overlapping batches", () => {
    const request = refinementInput("A", 2);
    const run = enqueueGenerationRun(request);
    expect(enqueueGenerationRun(structuredClone(request)).id).toBe(run.id);
    request.clientRequestId = "another-refinement";
    expect(() => enqueueGenerationRun(request)).toThrow("已有未结束任务");
    expect(generationRunAction(run.id, "cancel").status).toBe("cancelled");
    expect(enqueueGenerationRun(request).total).toBe(2);
  });
  it("cancels queued refinement while preserving acknowledged refinement for recovery", () => {
    const run = enqueueGenerationRun(refinementInput("A", 2));
    const [paid] = getDb().select().from(generationItems).all();
    getDb().update(generationItems).set({ status: "needs_attention", checkpoint: encryptGenerationValue({ submissionState: "acknowledged", taskId: "paid-refinement" }) }).where(eq(generationItems.id, paid.id)).run();
    const cancelled = generationRunAction(run.id, "cancel");
    expect(cancelled.items.filter((item) => item.status === "cancelled")).toHaveLength(1);
    expect(generationRunAction(run.id, "retry_import").items.find((item) => item.id === paid.id)?.status).toBe("waiting");
  });
  it("atomically accepts all 15 shots without a Kling account slot cap", () => {
    const request = input("A", 15); request.items.forEach((item) => { Object.assign(item.request, { provider: "kling-cli", profileId: "profile-1", selectionKey: klingModel.selectionKey }); });
    const run = enqueueGenerationRun(request);
    expect(run.total).toBe(15); expect(run.items.every((item) => item.status === "queued")).toBe(true);
    expect(getDb().select().from(generationItems).all()).toHaveLength(15);
    const payload = decryptGenerationValue<GenerationExecutionItem["payload"]>(getDb().select().from(generationItems).get()!.payload);
    expect(payload.snapshot?.kling).toMatchObject({ principalKey: "frozen-principal", model: klingModel });
    const changed = klingProfile(); changed.principalKey = "other-account"; changed.catalogSnapshot[0].remoteModelId = "other-model";
    getDb().update(klingProfiles).set({ data: changed }).where(eq(klingProfiles.id, "profile-1")).run();
    expect(decryptGenerationValue<GenerationExecutionItem["payload"]>(getDb().select().from(generationItems).get()!.payload).snapshot?.kling).toEqual(payload.snapshot?.kling);
  });
  it("rejects an unverified Kling profile before accepting any part of a batch", () => {
    const request = input("A", 3); request.items[2].request.provider = "kling-cli";
    expect(() => enqueueGenerationRun(request)).toThrow("Kling 账号或模型尚未核验");
    expect(listGenerationRuns()).toEqual([]);
    expect(getDb().select().from(generationItems).all()).toEqual([]);
  });
  it("rolls back the entire batch if any source shot is invalid", () => {
    const request = input("A", 3); request.items[2].shotId = 999;
    expect(() => enqueueGenerationRun(request)).toThrow("镜头");
    expect(listGenerationRuns()).toEqual([]); expect(getDb().select().from(generationItems).all()).toEqual([]);
  });
  it("reuses an identical request and rejects changed content and overlapping active shots", () => {
    const request = input("A", 2); const run = enqueueGenerationRun(request);
    expect(enqueueGenerationRun(structuredClone(request)).id).toBe(run.id);
    request.items[0].request.prompt = "changed";
    expect(() => enqueueGenerationRun(request)).toThrow("请求编号");
    request.clientRequestId = "new-request";
    expect(() => enqueueGenerationRun(request)).toThrow("已有未结束任务");
  });
  it("encrypts credentials and freezes project/model/prompt before background execution", async () => {
    const request = input(); const run = enqueueGenerationRun(request);
    request.items[0].request.model = "changed";
    getDb().update(projects).set({ productName: "Edited while B runs" }).where(eq(projects.id, "A")).run();
    const saved = getDb().select().from(generationItems).get()!;
    expect(saved.payload).not.toContain("frozen-secret");
    expect(JSON.stringify(getGenerationRun(run.id))).not.toContain("frozen-secret");
    state.execute.mockImplementation(async (item: GenerationExecutionItem) => {
      expect(item.payload.request.model).toBe("original"); expect(item.payload.snapshot?.project?.productName).toBe("Product A");
      return { assetId: "asset-1", apiKey: "do-not-return" };
    });
    vi.stubEnv("NEXT_PHASE", ""); await runGenerationTick(); await settled(run.id);
    expect(getGenerationRun(run.id).status).toBe("completed");
    expect(JSON.stringify(getGenerationRun(run.id))).not.toContain("do-not-return");
  });
  it("executes B alongside A and keeps the complete queue after the submitter leaves", async () => {
    const a = enqueueGenerationRun(input("A", 6)); const b = enqueueGenerationRun(input("B", 2));
    const release: Array<() => void> = [];
    state.execute.mockImplementation((item: GenerationExecutionItem) => new Promise((resolve) => { release.push(() => resolve({ assetId: item.id })); }));
    vi.stubEnv("NEXT_PHASE", ""); await runGenerationTick();
    await vi.waitFor(() => expect(state.execute).toHaveBeenCalledTimes(4));
    const dispatched = state.execute.mock.calls.map(([item]) => (item as GenerationExecutionItem).projectId);
    expect(dispatched.filter((id) => id === "A")).toHaveLength(2); expect(dispatched.filter((id) => id === "B")).toHaveLength(2);
    expect(getGenerationRun(a.id).total).toBe(6); expect(getGenerationRun(b.id).status).toBe("running");
    release.forEach((finish) => finish());
    await vi.waitFor(() => expect(getGenerationRun(b.id).status).toBe("completed"));
    state.execute.mockResolvedValue({ assetId: "next" });
    for (let i = 0; i < 2; i++) { await runGenerationTick(); await new Promise((resolve) => setTimeout(resolve, 20)); }
    await settled(a.id); expect(getGenerationRun(a.id).done).toBe(6);
  });
  it("recovers a dead worker using its exact cloud checkpoint without losing outputs", async () => {
    const run = enqueueGenerationRun(input());
    const item = getDb().select().from(generationItems).get()!;
    getDb().update(generationItems).set({ status: "running", leaseOwner: "999999999:dead", leaseExpiresAt: 1,
      checkpoint: encryptGenerationValue({ taskId: "paid-cloud-id", resultUrls: ["https://example.test/paid.mp4"] }) }).where(eq(generationItems.id, item.id)).run();
    state.execute.mockImplementation(async (execution: GenerationExecutionItem) => { expect(execution.checkpoint?.taskId).toBe("paid-cloud-id"); return { assetId: "imported-once" }; });
    vi.stubEnv("NEXT_PHASE", ""); await runGenerationTick(); await settled(run.id);
    expect(getGenerationRun(run.id).status).toBe("completed"); expect(state.execute).toHaveBeenCalledOnce();
  });
  it("cancels unsubmitted shots while keeping paid work recoverable", () => {
    const run = enqueueGenerationRun(input("A", 2)); const [first] = getDb().select().from(generationItems).all();
    getDb().update(generationItems).set({ status: "waiting", checkpoint: encryptGenerationValue({ taskId: "paid" }) }).where(eq(generationItems.id, first.id)).run();
    const cancelled = generationRunAction(run.id, "cancel");
    expect(cancelled.items.filter((i) => i.status === "cancelled")).toHaveLength(1);
    expect(cancelled.items.find((i) => i.id === first.id)?.status).toBe("waiting");
  });
  it("cancels a definitively rate-limited item while retaining ambiguous and accepted submissions", () => {
    const run = enqueueGenerationRun(input("A", 3));
    const [limited, ambiguous, paid] = getDb().select().from(generationItems).all();
    for (const [item, checkpoint] of [[limited, { submissionState: "not_submitted" }], [ambiguous, { submissionState: "submitting" }], [paid, { submissionState: "acknowledged", taskId: "paid" }]] as const) {
      getDb().update(generationItems).set({ status: "waiting", checkpoint: encryptGenerationValue(checkpoint) }).where(eq(generationItems.id, item.id)).run();
    }
    const cancelled = generationRunAction(run.id, "cancel");
    expect(cancelled.items.find((i) => i.id === limited.id)?.status).toBe("cancelled");
    expect(cancelled.items.find((i) => i.id === ambiguous.id)?.status).toBe("waiting");
    expect(cancelled.items.find((i) => i.id === paid.id)?.status).toBe("waiting");
  });
  it("honors cancellation when an in-flight request later proves it was not accepted", async () => {
    const run = enqueueGenerationRun(input());
    let finish!: () => void;
    state.execute.mockImplementation((_item: GenerationExecutionItem, save: (checkpoint: Record<string, unknown>) => void) => new Promise((resolve) => {
      finish = () => { save({ submissionState: "not_submitted" }); resolve({ pending: true, retryAfterMs: 1000 }); };
    }));
    vi.stubEnv("NEXT_PHASE", ""); await runGenerationTick();
    await vi.waitFor(() => expect(state.execute).toHaveBeenCalledOnce());
    generationRunAction(run.id, "cancel");
    finish(); await settled(run.id);
    getDb().update(generationItems).set({ nextRunAt: 0 }).where(eq(generationItems.runId, run.id)).run();
    await runGenerationTick();
    expect(getGenerationRun(run.id).status).toBe("cancelled");
    expect(state.execute).toHaveBeenCalledOnce();
  });
  it("marks a running preparation cancelled when the final pre-submission guard stops it", async () => {
    const run = enqueueGenerationRun(refinementInput());
    state.execute.mockRejectedValue(Object.assign(new Error("cancelled before payment"), { code: "GENERATION_CANCELLED" }));
    vi.stubEnv("NEXT_PHASE", ""); await runGenerationTick();
    await vi.waitFor(() => expect(getGenerationRun(run.id).status).toBe("cancelled"));
    expect(getGenerationRun(run.id).items[0]).toMatchObject({ status: "cancelled", stage: "cancelled", error: null, errorCode: null });
  });
  it("allows recovery of paid script output after saving fails without accepting an empty output", () => {
    const run = enqueueGenerationRun({ projectId: "A", clientRequestId: "script-save", kind: "script", items: [{ kind: "script", request: {} }] });
    const item = getDb().select().from(generationItems).get()!;
    getDb().update(generationItems).set({ status: "needs_attention", checkpoint: encryptGenerationValue({ generatedScripts: [] }) }).where(eq(generationItems.id, item.id)).run();
    expect(() => generationRunAction(run.id, "retry_import")).toThrow("核对原平台");
    getDb().update(generationItems).set({ checkpoint: encryptGenerationValue({ generatedScripts: [{ title: "already paid script" }] }) }).where(eq(generationItems.id, item.id)).run();
    expect(generationRunAction(run.id, "retry_import").status).toBe("waiting");
  });
  it.each(["get", "list"])("locally reconciles the identified TIDEWE planner failure through %s and unlocks a fresh generation", entry => {
    const { run, item, request } = stalledScriptValidation();
    const reconciled = entry === "get" ? getGenerationRun(run.id) : listGenerationRuns("A").find(value => value.id === run.id)!;
    expect(reconciled).toMatchObject({ status: "failed", items: [{ status: "failed", stage: "failed", error: scriptValidationMessage, errorCode: "TIDEWE_VALIDATION_FAILED" }] });
    const saved = getDb().select().from(generationItems).where(eq(generationItems.id, item.id)).get()!;
    expect(decryptGenerationValue(saved.checkpoint!)).toMatchObject({ submissionState: "acknowledged", stage: "failed",
      scriptValidationFailure: { code: "TIDEWE_VALIDATION_FAILED", message: scriptValidationMessage } });
    expect(state.execute).not.toHaveBeenCalled();
    expect(getDb().select().from(scripts).where(eq(scripts.projectId, "A")).all()).toMatchObject([{ id: "script-A", selected: true }]);
    expect(enqueueGenerationRun({ ...request, clientRequestId: "fresh-script-after-validation" }).status).toBe("queued");
  });
  it.each(["unknown error", "generated scripts", "cloud task", "completed result", "result urls", "live lease", "other profile", "other endpoint", "saved script", "public result", "corrupt checkpoint"])("preserves a stalled script with %s instead of treating it as the known local failure", guard => {
    const { run, item } = stalledScriptValidation();
    const db = getDb();
    const row = db.select().from(generationItems).where(eq(generationItems.id, item.id)).get()!;
    if (guard === "unknown error") db.update(generationItems).set({ error: "network interrupted while submitting" }).where(eq(generationItems.id, item.id)).run();
    else if (["generated scripts", "cloud task", "completed result", "result urls"].includes(guard)) {
      const output = guard === "generated scripts" ? { generatedScripts: [{ title: "paid result" }] }
        : guard === "cloud task" ? { taskId: "accepted-task" }
          : guard === "completed result" ? { completedResult: { scripts: [{ id: "saved" }] } }
            : { resultUrls: ["https://example.test/paid-result"] };
      db.update(generationItems).set({ checkpoint: encryptGenerationValue({ submissionState: "submitting", ...output }) }).where(eq(generationItems.id, item.id)).run();
    } else if (guard === "live lease") db.update(generationItems).set({ leaseOwner: "live-worker", leaseExpiresAt: Date.now() + 60000 }).where(eq(generationItems.id, item.id)).run();
    else if (guard === "other profile" || guard === "other endpoint") {
      const payload = decryptGenerationValue<GenerationExecutionItem["payload"]>(row.payload);
      if (guard === "other profile") payload.snapshot!.project!.creativeProfile = null;
      else payload.request.generationEndpoint = "/api/topic/script";
      db.update(generationItems).set({ payload: encryptGenerationValue(payload) }).where(eq(generationItems.id, item.id)).run();
    } else if (guard === "saved script") db.update(scripts).set({ generationMetadata: { requestId: item.id } as never }).where(eq(scripts.id, "script-A")).run();
    else if (guard === "public result") db.update(generationItems).set({ result: { scripts: [{ id: "known-result" }] } }).where(eq(generationItems.id, item.id)).run();
    else db.update(generationItems).set({ checkpoint: "invalid-encrypted-checkpoint" }).where(eq(generationItems.id, item.id)).run();
    const before = db.select().from(generationItems).where(eq(generationItems.id, item.id)).get()!;
    expect(getGenerationRun(run.id).items[0]).toMatchObject({ status: "needs_attention", errorCode: "GENERATION_NEEDS_ATTENTION" });
    expect(db.select().from(generationItems).where(eq(generationItems.id, item.id)).get()).toEqual(before);
    expect(state.execute).not.toHaveBeenCalled();
  });
  it("finishes a new local script validation failure with failed status and stage", async () => {
    const run = enqueueGenerationRun({ projectId: "A", clientRequestId: "script-validation-failed", kind: "script", items: [{ kind: "script", request: {} }] });
    state.execute.mockRejectedValue(new GenerationExecutionError(scriptValidationMessage, "TIDEWE_VALIDATION_FAILED"));
    vi.stubEnv("NEXT_PHASE", ""); await runGenerationTick();
    await vi.waitFor(() => {
      const saved = getDb().select().from(generationItems).where(eq(generationItems.runId, run.id)).get()!;
      expect(saved).toMatchObject({ status: "failed", stage: "failed", errorCode: "TIDEWE_VALIDATION_FAILED", leaseOwner: null });
    });
    expect(getGenerationRun(run.id).status).toBe("failed");
    expect(state.execute).toHaveBeenCalledOnce();
  });
  it("only retries known cloud results; an unknown paid submission requires attention", () => {
    const run = enqueueGenerationRun(input()); const item = getDb().select().from(generationItems).get()!;
    getDb().update(generationItems).set({ status: "needs_attention", checkpoint: encryptGenerationValue({ submissionState: "submitting" }) }).where(eq(generationItems.id, item.id)).run();
    expect(() => generationRunAction(run.id, "retry_import")).toThrow("核对原平台");
    getDb().update(generationItems).set({ checkpoint: encryptGenerationValue({ taskId: "known-cloud-task" }) }).where(eq(generationItems.id, item.id)).run();
    expect(generationRunAction(run.id, "retry_import").status).toBe("waiting");
  });
  it("gives the first import failure a fresh retry budget after many successful cloud polls", async () => {
    const run = enqueueGenerationRun(input());
    const db = getDb(), item = db.select().from(generationItems).get()!;
    db.update(generationItems).set({ attempts: 68, checkpoint: encryptGenerationValue({ taskId: "paid-task", resultUrls: ["https://example.test/paid.mp4"] }) }).where(eq(generationItems.id, item.id)).run();
    state.execute.mockImplementation(async (execution: GenerationExecutionItem, save: (checkpoint: Record<string, unknown>) => void) => {
      save({ ...execution.checkpoint, stage: "importing", localPaths: { 0: "/api/files/A/paid.mp4" }, childJobId: "paid-child" });
      throw new GenerationExecutionError("temporary disk failure", "GENERATION_IMPORT_FAILED", true);
    });
    vi.stubEnv("NEXT_PHASE", ""); await runGenerationTick();
    await vi.waitFor(() => {
      const saved = db.select().from(generationItems).where(eq(generationItems.id, item.id)).get()!;
      expect(saved).toMatchObject({ status: "waiting", attempts: 69, leaseOwner: null });
      expect(decryptGenerationValue(saved.checkpoint!)).toEqual({ taskId: "paid-task", resultUrls: ["https://example.test/paid.mp4"], stage: "importing", localPaths: { 0: "/api/files/A/paid.mp4" }, childJobId: "paid-child", importFailures: 1 });
      expect(saved.checkpoint).not.toContain("paid-task");
    });
    expect(getGenerationRun(run.id).failed).toBe(0);
  });
  it("stops after six actual import failures and resets that budget for manual recovery", async () => {
    const run = enqueueGenerationRun(input());
    const db = getDb(), item = db.select().from(generationItems).get()!;
    db.update(generationItems).set({ attempts: 40, checkpoint: encryptGenerationValue({ taskId: "paid-task" }) }).where(eq(generationItems.id, item.id)).run();
    state.execute.mockImplementation(async (execution: GenerationExecutionItem, save: (checkpoint: Record<string, unknown>) => void) => {
      save({ ...execution.checkpoint, resultUrls: ["https://example.test/paid.mp4"], stage: "importing" });
      throw new GenerationExecutionError("temporary import failure", "GENERATION_IMPORT_FAILED", true);
    });
    vi.stubEnv("NEXT_PHASE", "");
    for (let failure = 1; failure <= 6; failure++) {
      db.update(generationItems).set({ nextRunAt: 0 }).where(eq(generationItems.id, item.id)).run();
      await runGenerationTick();
      await vi.waitFor(() => {
        const saved = db.select().from(generationItems).where(eq(generationItems.id, item.id)).get()!;
        expect(saved).toMatchObject({ status: failure === 6 ? "needs_attention" : "waiting", leaseOwner: null });
        expect(decryptGenerationValue(saved.checkpoint!)).toMatchObject({ taskId: "paid-task", importFailures: failure });
      });
    }
    expect(state.execute).toHaveBeenCalledTimes(6);
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    expect(generationRunAction(run.id, "retry_import").status).toBe("waiting");
    expect(decryptGenerationValue(db.select().from(generationItems).get()!.checkpoint!)).toMatchObject({ taskId: "paid-task", resultUrls: ["https://example.test/paid.mp4"], importFailures: 0 });
    vi.stubEnv("NEXT_PHASE", ""); await runGenerationTick();
    await vi.waitFor(() => {
      const saved = db.select().from(generationItems).get()!;
      expect(saved).toMatchObject({ status: "waiting", leaseOwner: null });
      expect(decryptGenerationValue(saved.checkpoint!)).toMatchObject({ importFailures: 1 });
    });
  });
  it("does not count transient query errors against the import retry budget", async () => {
    enqueueGenerationRun(input());
    const db = getDb(), item = db.select().from(generationItems).get()!;
    db.update(generationItems).set({ checkpoint: encryptGenerationValue({ taskId: "paid-task", importFailures: 3 }) }).where(eq(generationItems.id, item.id)).run();
    state.execute.mockRejectedValue(new GenerationExecutionError("temporary query failure", "GENERATION_QUERY_FAILED", true));
    vi.stubEnv("NEXT_PHASE", ""); await runGenerationTick();
    await vi.waitFor(() => {
      const saved = db.select().from(generationItems).get()!;
      expect(saved).toMatchObject({ status: "waiting", leaseOwner: null });
      expect(decryptGenerationValue(saved.checkpoint!)).toEqual({ taskId: "paid-task", importFailures: 3 });
    });
  });
  it("leaves a replacement worker's checkpoint and lease intact after a late import error", async () => {
    enqueueGenerationRun(input());
    const db = getDb(), item = db.select().from(generationItems).get()!;
    const replacement = `${process.pid}:replacement`;
    state.execute.mockImplementation(async () => {
      db.update(generationItems).set({ leaseOwner: replacement, checkpoint: encryptGenerationValue({ taskId: "paid-task", importFailures: 2, stage: "new-worker" }) }).where(eq(generationItems.id, item.id)).run();
      throw new GenerationExecutionError("late import failure", "GENERATION_IMPORT_FAILED", true);
    });
    vi.stubEnv("NEXT_PHASE", ""); await runGenerationTick();
    await vi.waitFor(() => expect(state.execute).toHaveBeenCalledOnce());
    const saved = db.select().from(generationItems).get()!;
    expect(saved).toMatchObject({ status: "running", leaseOwner: replacement, errorCode: null });
    expect(decryptGenerationValue(saved.checkpoint!)).toEqual({ taskId: "paid-task", importFailures: 2, stage: "new-worker" });
  });
  it("authenticates encrypted snapshots", () => {
    const encrypted = encryptGenerationValue({ apiKey: "private" });
    expect(decryptGenerationValue(encrypted)).toEqual({ apiKey: "private" });
    const parts = encrypted.split("."); parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptGenerationValue(parts.join("."))).toThrow();
  });
});
