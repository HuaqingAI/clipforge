// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { generationItems, generationRuns } from "@/lib/generation-schema";
import { klingProfiles } from "@/lib/kling/profile-schema";
import { decryptGenerationValue, encryptGenerationValue } from "@/lib/generation-secrets";
import { enqueueGenerationRun, generationRunAction, getGenerationRun, listGenerationRuns, runGenerationTick, stopGenerationRunner, type EnqueueGenerationRunInput } from "@/lib/generation-runs";

const klingModel: KlingVideoModelDescriptor = { selectionKey: "fixture-kling-model", provider: "kling-cli", profileId: "profile-1", region: "global", tool: "text_to_video", remoteModelId: "model-1", displayName: "Model 1", catalogRevision: "catalog-1", available: true, parameters: [], inputSlots: [], capabilities: { image: false, tailFrame: false, multiImage: false, audio: false } };
function klingProfile(): KlingProfile {
  return { id: "profile-1", label: "Kling account", region: "global", cliPackage: "@klingai/cli-global", cliVersion: "0.2.0", adapterVersion: "1", nodePath: "node", packagePath: "fixture", cliEntry: "fixture", homePath: "fixture", endpoint: "https://kling.ai/mcp", environmentState: "ready", authState: "authenticated", authRevision: 1, principalKey: "frozen-principal", catalogSnapshot: [structuredClone(klingModel)], catalogRevision: "catalog-1", catalogCheckedAt: Date.now(), createdAt: 1, updatedAt: 1 };
}

function input(projectId = "A", count = 1): EnqueueGenerationRunInput {
  return { projectId, clientRequestId: `request-${projectId}`, kind: "video_batch", items: Array.from({ length: count }, (_, i) => ({ kind: "video", scriptId: `script-${projectId}`, shotId: i + 1,
    request: { provider: "mock", apiKey: "frozen-secret", model: "original", prompt: `shot ${i + 1}`, options: { duration: 5 } }, asset: { type: "ai_generated", shotId: i + 1 } })) };
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
      provider: "openai", model: "gpt-image-2", apiKey: "refinement-secret", issues: ["hands"], resolution: "2k" } };
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

describe("durable cross-project generation", () => {
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
