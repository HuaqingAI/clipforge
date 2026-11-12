// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import path from "node:path";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

const state = vi.hoisted(() => ({
  sqlite: null as Database.Database | null,
  convertImage: vi.fn(),
}));
vi.mock("@/lib/db", async () => {
  const { default: Sqlite } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  state.sqlite = new Sqlite(":memory:");
  state.sqlite.pragma("foreign_keys = ON");
  const db = drizzle(state.sqlite);
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return { db, getDb: () => db };
});
vi.mock("@/lib/remote-image", () => ({
  toRemoteUsableImage: (...args: unknown[]) => state.convertImage(...args),
  resolveUploadFilePath: () => null,
}));

import { getDb } from "@/lib/db";
import { aiTasks, projects, scripts } from "@/lib/db/schema";
import { BaseProvider } from "@/lib/providers/base";
import { withGenerationContext } from "@/lib/generation-context";
import { POST as generate } from "@/app/api/ai/video/route";
import { POST as resume } from "@/app/api/ai/video/task/route";

const firstFrame = "data:image/png;base64,Zmlyc3Q=";
const lastFrame = "data:image/png;base64,bGFzdA==";
const videoUrl = "https://cdn.example.com/h3-video.mp4";
const taskId = "task-h3";
const submitUrl = "https://gateway.example/v2/video_generation";
const queryUrl = `https://gateway.example/v2/query/video_generation/${taskId}`;

function request(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/ai/video", {
    method: "POST", body: JSON.stringify(body), headers: { "Accept-Language": "en" },
  });
}

function input(): Record<string, unknown> {
  return {
    provider: "openai", apiKey: "fixture-key", baseUrl: "https://gateway.example/v1/",
    model: "MiniMax-H3", prompt: "A red ball rolls across a wooden table.",
    mode: "image-to-video", imageUrl: "/api/files/project-h3/first.png",
    lastImageUrl: "/api/files/project-h3/last.png", projectId: "project-h3",
    scriptId: "script-h3", shotId: 1,
    options: { width: 1344, height: 768, duration: 4, audioEnabled: false },
  };
}

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function completed() {
  return json({ task: { id: taskId, model: "MiniMax-H3", status: "succeeded", duration: 6, content: { url: videoUrl } } });
}

function storedTask() {
  return getDb().select().from(aiTasks).where(eq(aiTasks.taskId, taskId)).get();
}

beforeEach(() => {
  state.convertImage.mockReset();
  state.convertImage.mockImplementation(async (url?: string) => {
    if (url === "/api/files/project-h3/first.png") return firstFrame;
    if (url === "/api/files/project-h3/last.png") return lastFrame;
    return url;
  });
  vi.spyOn(BaseProvider.prototype as unknown as { sleep(ms: number): Promise<void> }, "sleep").mockResolvedValue(undefined);
  const db = getDb();
  db.delete(aiTasks).run();
  db.delete(scripts).run();
  db.delete(projects).run();
  db.insert(projects).values({ id: "project-h3", name: "HTH project", productName: "Red ball" }).run();
  db.insert(scripts).values({
    id: "script-h3", projectId: "project-h3", styleType: "scene", selected: true,
    shots: [{ shotId: 1, type: "demo", duration: 4, description: "A ball rolls across a table.",
      voiceover: "", camera: "static", visualSource: "ai_generate", transition: "direct_concat" }],
  }).run();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => state.sqlite?.close());

describe("HTH MiniMax-H3 video routes", () => {
  it("normalizes local first/last frames, saves the paid task before querying, and reports upstream audio and duration", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return json({ task_id: taskId });
      expect(storedTask()).toMatchObject({
        projectId: "project-h3", shotId: 1, provider: "openai", model: "MiniMax-H3",
        mediaType: "video", mode: "image-to-video", taskId, status: "submitted",
      });
      return completed();
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await generate(request(input()));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ taskId, modelId: "MiniMax-H3", videoUrls: [videoUrl], duration: 6, hasAudio: true });
    expect(state.convertImage.mock.calls.map(([url]) => url)).toEqual([
      "/api/files/project-h3/first.png", "/api/files/project-h3/last.png",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(submitUrl);
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer fixture-key" });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      model: "MiniMax-H3", duration: 4, resolution: "768P", ratio: "adaptive",
      content: [
        { type: "text", text: "A red ball rolls across a wooden table." },
        { type: "image_url", image_url: { url: firstFrame }, role: "first_frame" },
        { type: "image_url", image_url: { url: lastFrame }, role: "last_frame" },
      ],
    });
    expect(fetchMock.mock.calls[1][0]).toBe(queryUrl);
    expect(fetchMock.mock.calls[1][1]?.method).toBe("GET");
    expect(storedTask()).toMatchObject({ status: "completed", resultUrls: [videoUrl], error: null });
  });

  it("returns a deferred task with a durable task row and checkpoint before any status request", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>().mockResolvedValue(json({ task_id: taskId }));
    vi.stubGlobal("fetch", fetchMock);
    let checkpoint: Record<string, unknown> = {};

    const response = await withGenerationContext({
      itemId: "generation-h3", checkpoint: null, deferPolling: true,
      save: (value) => { checkpoint = structuredClone(value); },
    }, () => generate(request(input())));

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ taskId, modelId: "MiniMax-H3", status: "processing" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(submitUrl);
    expect(storedTask()).toMatchObject({ taskId, status: "submitted" });
    expect(checkpoint).toMatchObject({ taskId, modelId: "MiniMax-H3", provider: "openai", submissionState: "acknowledged", aiTaskRowId: storedTask()?.id });
  });

  it.each(["failed", "cancelled"])("persists a terminal %s task without marking it recoverable", async (status) => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? json({ task_id: taskId })
      : json({ task: { id: taskId, model: "MiniMax-H3", status, error: { code: "UPSTREAM_FAILURE", message: "Generation stopped" } } }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await generate(request(input()));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ taskId, recoverable: false });
    expect(storedTask()).toMatchObject({ status: "failed", error: expect.stringContaining("Generation stopped") });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("retains a task after interrupted queries and resumes the original task without paying again", async () => {
    let recovered = false;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return json({ task_id: taskId });
      return recovered ? completed() : json({ error: { message: "Status endpoint unavailable" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const interrupted = await generate(request(input()));

    expect(interrupted.status).toBe(504);
    expect(await interrupted.json()).toMatchObject({ taskId, recoverable: true });
    expect(storedTask()).toMatchObject({ taskId, status: "unknown" });
    const rowId = storedTask()?.id;
    recovered = true;
    const response = await resume(request({
      provider: "openai", apiKey: "fixture-key", baseUrl: "https://gateway.example/v1", taskId,
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ taskId, status: "completed", videoUrls: [videoUrl] });
    expect(storedTask()).toMatchObject({ id: rowId, status: "completed", resultUrls: [videoUrl], error: null });
    expect(getDb().select().from(aiTasks).all()).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(fetchMock.mock.calls.slice(1).every(([url, init]) => url === queryUrl && init?.method === "GET")).toBe(true);
  });
});
