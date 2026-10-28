// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { GenerationExecutionItem } from "@/lib/generation-types";
import type { KlingProfile, KlingVideoModelDescriptor } from "@/lib/kling/types";

const state = vi.hoisted(() => ({ directory: "", sqlite: null as Database.Database | null, execute: vi.fn() }));
vi.mock("@/lib/paths", () => ({ getDataDir: () => state.directory }));
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
import { projects, scripts } from "@/lib/db/schema";
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
async function settled(id: string) { await vi.waitFor(() => expect(["completed", "failed", "needs_attention", "waiting"].includes(getGenerationRun(id).status)).toBe(true)); }
beforeAll(() => { state.directory = mkdtempSync(path.join(tmpdir(), "clipforge-generation-test-")); });
afterAll(() => { stopGenerationRunner(); state.sqlite?.close(); rmSync(state.directory, { recursive: true, force: true }); });
beforeEach(() => {
  vi.stubEnv("NEXT_PHASE", "phase-production-build"); state.execute.mockReset();
  const db = getDb(); db.delete(generationItems).run(); db.delete(generationRuns).run(); db.delete(klingProfiles).run(); db.delete(scripts).run(); db.delete(projects).run();
  db.insert(klingProfiles).values({ id: "profile-1", data: klingProfile() }).run();
  for (const id of ["A", "B"]) {
    db.insert(projects).values({ id, name: `Project ${id}`, productName: `Product ${id}` }).run();
    db.insert(scripts).values({ id: `script-${id}`, projectId: id, styleType: "scene", selected: true,
      shots: Array.from({ length: 15 }, (_, i) => ({ shotId: i + 1, type: "demo", duration: 5, description: "demo", voiceover: "test", camera: "static", visualSource: "ai_generate", transition: "direct_concat" })) }).run();
  }
});
afterEach(() => { stopGenerationRunner(); vi.unstubAllEnvs(); });

describe("durable cross-project generation", () => {
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
  it("authenticates encrypted snapshots", () => {
    const encrypted = encryptGenerationValue({ apiKey: "private" });
    expect(decryptGenerationValue(encrypted)).toEqual({ apiKey: "private" });
    const parts = encrypted.split("."); parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptGenerationValue(parts.join("."))).toThrow();
  });
});
