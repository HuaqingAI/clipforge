// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { ARK_AGENT_PLAN_BASE_URL } from "@/lib/ark-config";
import { VolcEngineProvider } from "@/lib/providers/volcengine";
import { ProviderError } from "@/lib/providers/base";

const state = vi.hoisted(() => ({ db: null as unknown, record: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/ai-tasks", () => ({ recordAiTask: state.record, updateAiTask: state.update }));
vi.mock("@/lib/providers/atlas-catalog", () => ({
  fetchAtlasCatalog: vi.fn().mockResolvedValue([]), getCachedAtlasEntry: () => undefined,
}));
vi.mock("@/lib/media-probe", () => ({ probeMedia: vi.fn().mockResolvedValue({ duration: 8 }) }));
import { POST } from "@/app/api/project/[id]/storyboard-film/route";

const projectId = "film-rejection-project";
const scriptId = "film-rejection-script";
const sqlite = new Database(":memory:");
const db = drizzle(sqlite, { schema });
const refs = [7, 11].map((id) => `/api/files/${projectId}/shot-${id}.png`);
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "clipforge-film-rejection-"));
  vi.stubEnv("APP_DATA_DIR", directory);
  state.db = db;
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  db.insert(schema.projects).values({ id: projectId, name: "Film input rejection" }).run();
  db.insert(schema.scripts).values({ id: scriptId, projectId, styleType: "scene", shots: [7, 11].map((shotId) => ({
    shotId, type: "demo" as const, duration: 4, description: "Sofa upholstery and seat details",
    camera: "Slow push", visualSource: "ai_generate" as const, transition: "direct_concat" as const,
    voiceover: "Explore the sofa details.",
  })) }).run();
  await mkdir(join(directory, "uploads", projectId), { recursive: true });
  for (const [index, shotId] of [7, 11].entries()) {
    await writeFile(join(directory, "uploads", projectId, `shot-${shotId}.png`), `shot-${shotId}`);
    db.insert(schema.assets).values({ projectId, shotId, type: "ai_generated", filePath: refs[index], status: "done", selected: true }).run();
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  state.update.mockReset().mockResolvedValue(undefined);
  state.record.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("persisted full-film recovery", () => {
  beforeEach(() => {
    db.delete(schema.aiTasks).run();
    db.delete(schema.compositions).run();
  });
  function saveTask(patch: Partial<typeof schema.aiTasks.$inferInsert> = {}) {
    const taskId = "original-paid-film";
    db.insert(schema.aiTasks).values({ id: "original-film-row", projectId, provider: "volcengine", model: "doubao-seedance-2.0", mediaType: "video", mode: "video-to-video", taskId, status: "unknown", ...patch }).run();
    return taskId;
  }
  function recover(taskId: string, extra: Record<string, unknown> = {}) {
    return request({ action: "recover", taskId, scriptId: undefined, model: undefined, ...extra });
  }
  function completed(taskId: string) {
    return { taskId, status: "completed" as const, result: { taskId, modelId: "untrusted-current-model", videoUrls: ["https://videos.example/paid-result.mp4"] } };
  }

  it("imports the original model result once and returns the same composition without any new generation", async () => {
    const taskId = saveTask({ status: "completed" });
    const query = vi.spyOn(VolcEngineProvider.prototype, "getTaskStatus").mockResolvedValue(completed(taskId));
    const submit = vi.spyOn(VolcEngineProvider.prototype, "submitVideoTask");
    const fetchMock = vi.fn().mockResolvedValue(new Response("original video bytes")); vi.stubGlobal("fetch", fetchMock);
    state.update.mockImplementation(async (_id, patch) => {
      if (patch.status === "completed") expect(db.select().from(schema.compositions).get()?.status).toBe("done");
    });
    const first = await recover(taskId);
    expect(first.status).toBe(200);
    const output = await first.json();
    expect(output).toMatchObject({ taskId, modelId: "doubao-seedance-2.0", status: "completed" });
    const row = db.select().from(schema.compositions).get()!;
    expect(await readFile(row.outputPath!, "utf8")).toBe("original video bytes");
    const second = await recover(taskId, { apiKey: undefined });
    expect(await second.json()).toEqual(output);
    expect(db.select().from(schema.compositions).all()).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    expect(state.record).not.toHaveBeenCalled();
  });

  it.each([{ projectId: "other-project" }, { provider: "atlas-cloud" }, { shotId: 7 }, { mediaType: "image" as const }, { mode: "image-to-video" }])("refuses a task outside the project's saved full-film context: %o", async (patch) => {
    const taskId = saveTask(patch);
    const query = vi.spyOn(VolcEngineProvider.prototype, "getTaskStatus");
    const submit = vi.spyOn(VolcEngineProvider.prototype, "submitVideoTask");
    const response = await recover(taskId);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ taskId, recoverable: false });
    expect(query).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("keeps a pending original task recoverable without creating a composition", async () => {
    const taskId = saveTask();
    vi.spyOn(VolcEngineProvider.prototype, "getTaskStatus").mockResolvedValue({ taskId, status: "processing" });
    const submit = vi.spyOn(VolcEngineProvider.prototype, "submitVideoTask");
    const response = await recover(taskId);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ taskId, status: "processing", recoverable: true, modelId: "doubao-seedance-2.0" });
    expect(db.select().from(schema.compositions).all()).toHaveLength(0);
    expect(submit).not.toHaveBeenCalled();
  });

  it("preserves the original task when download fails and retries importing without submitting again", async () => {
    const taskId = saveTask();
    vi.spyOn(VolcEngineProvider.prototype, "getTaskStatus").mockResolvedValue(completed(taskId));
    const submit = vi.spyOn(VolcEngineProvider.prototype, "submitVideoTask");
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("unavailable", { status: 503 })).mockResolvedValueOnce(new Response("recovered bytes")); vi.stubGlobal("fetch", fetchMock);
    const failed = await recover(taskId);
    expect(failed.status).toBe(504);
    expect(await failed.json()).toMatchObject({ taskId, recoverable: true });
    expect(state.update).toHaveBeenLastCalledWith("original-film-row", expect.objectContaining({ status: "unknown" }));
    expect(state.update).not.toHaveBeenCalledWith("original-film-row", expect.objectContaining({ status: "completed" }));
    expect(db.select().from(schema.compositions).all()).toHaveLength(0);
    const restored = await recover(taskId);
    expect(restored.status).toBe(200);
    expect(db.select().from(schema.compositions).all()).toHaveLength(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it("reports a definitive provider failure without retrying the paid submission", async () => {
    const taskId = saveTask();
    vi.spyOn(VolcEngineProvider.prototype, "getTaskStatus").mockResolvedValue({ taskId, status: "failed", error: "Provider rejected the task" });
    const submit = vi.spyOn(VolcEngineProvider.prototype, "submitVideoTask");
    const response = await recover(taskId);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ taskId, recoverable: false, error: "Provider rejected the task" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("uses the same stable composition on initial completion and later recovery", async () => {
    const taskId = "initial-then-recovered";
    const submit = vi.spyOn(VolcEngineProvider.prototype, "submitVideoTask").mockResolvedValue({ taskId, modelId: "doubao-seedance-2.5" });
    vi.spyOn(VolcEngineProvider.prototype, "waitForTask").mockResolvedValue(completed(taskId));
    const query = vi.spyOn(VolcEngineProvider.prototype, "getTaskStatus");
    state.record.mockImplementation(async (input) => { saveTask({ taskId: input.taskId, model: input.model }); return "original-film-row"; });
    const fetchMock = vi.fn().mockResolvedValue(new Response("completed initial video")); vi.stubGlobal("fetch", fetchMock);
    state.update.mockImplementation(async (_id, patch) => {
      if (patch.status === "completed") expect(db.select().from(schema.compositions).get()?.status).toBe("done");
    });
    const initial = await request();
    expect(initial.status).toBe(200);
    const result = await initial.json();
    const recovered = await (await recover(taskId)).json();
    expect(recovered.compositionId).toBe(result.compositionId);
    expect(recovered.url).toBe(result.url);
    expect(db.select().from(schema.compositions).all()).toHaveLength(1);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => {
  vi.unstubAllEnvs();
  sqlite.close();
  await rm(directory, { recursive: true, force: true });
});

function request(extra: Record<string, unknown> = {}) {
  return POST(new NextRequest(`http://localhost/api/project/${projectId}/storyboard-film`, {
    method: "POST", body: JSON.stringify({
      scriptId, provider: "volcengine", apiKey: "test-plan-key", baseUrl: ARK_AGENT_PLAN_BASE_URL,
      model: "doubao-seedance-2.5", ...extra,
    }),
  }), { params: Promise.resolve({ id: projectId }) });
}

function rejectImage(index: number) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: {
    code: "InputImageSensitiveContentDetected.PrivacyInformation",
    message: `The input image 'content[${index}]' may contain real person. Request id: rejection-request-id`,
    param: `content[${index}]`, type: "BadRequest",
  } }, { status: 400 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("film rejected input mapping and task recovery", () => {
  it.each([undefined, "bytedance/seedance-2.0/text-to-video", "doubao-seedance-2.1"])("rejects missing or incompatible defaults without substituting a paid model: %s", async (model) => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    for (const dryRun of [true, false]) {
      const response = await request({ model, dryRun });
      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.error).toContain("设置 → 视频生成 → 默认视频模型");
      expect(body.errorCode).toBe(model ? "VIDEO_MODEL_UNSUPPORTED_FOR_FILM" : "DEFAULT_VIDEO_MODEL_REQUIRED");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.record).not.toHaveBeenCalled();
  });
  it.each([
    { provider: "kling-cli", model: "official" },
    { provider: "atlas-cloud", model: JSON.stringify(["kling-cli", "image_to_video", "official"]) },
  ])("requires a protected local session for CLI film generation and preview before provider calls: %o", async (selection) => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    for (const dryRun of [true, false]) {
      const response = await request({ ...selection, dryRun });
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe("KLING_LOCAL_ACCESS_DENIED");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.record).not.toHaveBeenCalled();
  });
  it("submits the exact previewed prompt without creating a task after image rejection", async () => {
    const fetchMock = rejectImage(1);
    const preview = await (await request({ dryRun: true })).json();
    expect(fetchMock).not.toHaveBeenCalled();
    const response = await request({ expectedPrompt: preview.prompt });
    const error = await response.json();
    expect(response.status).toBe(400);
    expect(error).toMatchObject({
      errorCode: "InputImageSensitiveContentDetected.PrivacyInformation", requestId: "rejection-request-id",
      rejectedReference: { number: 1, kind: "shot", shotId: 7, url: refs[0] },
    });
    expect(error.error).toContain("镜头 7");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.content[0].text).toBe(preview.prompt);
    expect(body.content[1]).toMatchObject({ role: "reference_image", image_url: { url: `data:image/png;base64,${Buffer.from("shot-7").toString("base64")}` } });
    expect(state.record).not.toHaveBeenCalled();
    expect(error).not.toHaveProperty("taskId");
  });

  it("rejects a script edited after confirmation before any provider request or paid task", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const preview = await (await request({ dryRun: true })).json();
    const original = db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()!;
    try {
      const shots = original.shots!.map((shot, index) => index === 0 ? { ...shot, description: "Changed product and scene after preview" } : shot);
      db.update(schema.scripts).set({ shots }).where(eq(schema.scripts.id, scriptId)).run();
      const response = await request({ expectedPrompt: preview.prompt });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ errorCode: "FILM_PLAN_STALE" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(state.record).not.toHaveBeenCalled();
    } finally {
      db.update(schema.scripts).set({ shots: original.shots }).where(eq(schema.scripts.id, scriptId)).run();
    }
  });

  it("rejects invalid confirmation payloads without a generation request", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const response = await request({ expectedPrompt: null });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ errorCode: "FILM_CONFIRMATION_INVALID" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.record).not.toHaveBeenCalled();
  });

  it.each([
    [1, { number: 1, kind: "character-sheet" }],
    [2, { number: 2, kind: "shot", shotId: 7, url: refs[0] }],
  ])("maps content[%i] correctly when a presenter sheet occupies the first image slot", async (index, expected) => {
    rejectImage(index);
    const sheet = "data:image/png;base64,c2hlZXQ=";
    const response = await request({ characterSheetUrl: sheet });
    expect(response.status).toBe(400);
    expect((await response.json()).rejectedReference).toMatchObject(expected);
  });

  it("returns the saved task ID and recovery flag when status is unknown instead of treating it as a submit rejection", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "already-submitted-task" }));
    vi.stubGlobal("fetch", fetchMock);
    state.record.mockResolvedValue("saved-task-row");
    const wait = vi.spyOn(VolcEngineProvider.prototype, "waitForTask")
      .mockRejectedValue(new ProviderError("Status lookup interrupted", "STATUS_UNKNOWN", "volcengine"));
    const response = await request();
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ taskId: "already-submitted-task", recoverable: true });
    expect(state.record).toHaveBeenCalledWith(expect.objectContaining({ taskId: "already-submitted-task" }));
    expect(state.record.mock.invocationCallOrder[0]).toBeLessThan(wait.mock.invocationCallOrder[0]);
    expect(state.update).toHaveBeenCalledWith("saved-task-row", expect.objectContaining({ status: "unknown" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
