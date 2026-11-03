// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as schema from "@/lib/db/schema";
import { createTideweOutdoorProfile } from "@/lib/creative-profiles";
import {
  createCreativeProfileSnapshot,

  createShortVideoSalesProfile,
} from "@/lib/creative-profiles";

const state = vi.hoisted(() => ({
  db: null as unknown,
  createProvider: vi.fn(),
  generateVideo: vi.fn(),
  toRemoteUsableImage: vi.fn(),
  uploadLocalMedia: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/providers", () => ({ createProvider: state.createProvider }));
vi.mock("@/lib/remote-image", () => ({
  toRemoteUsableImage: state.toRemoteUsableImage,
  resolveUploadFilePath: () => "/fixture/reference.wav",
}));
vi.mock("@/lib/ai-tasks", () => ({ recordAiTask: vi.fn(), updateAiTask: vi.fn() }));
vi.mock("@/lib/kling/jobs", () => ({ createKlingJob: vi.fn() }));
vi.mock("@/lib/kling/repository", () => ({ klingJobView: vi.fn() }));

import { POST } from "@/app/api/ai/video/route";

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

const projectId = "video-profile-project";
const scriptId = "video-profile-script";
const quietPrompt = "A walnut lounge chair in a quiet studio. The camera moves slowly from left to right.";
const silentShot: schema.Shot = {
  shotId: 1,
  type: "product_reveal",
  duration: 5,
  description: "A walnut lounge chair in a quiet studio with the reference materials preserved.",
  camera: "A restrained slow lateral move.",
  voiceover: "",
  visualSource: "product_image",
  transition: "direct_concat",
};

function request(overrides: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/ai/video", {
    method: "POST",
    body: JSON.stringify({
      provider: "fixture",
      model: "video-model",
      apiKey: "fixture-key",
      prompt: quietPrompt,
      imageUrl: "/api/files/frame.png",
      projectId,
      scriptId,
      shotId: silentShot.shotId,
      ...overrides,
    }),
  });
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  state.db = db;
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });

  const profile = createShortVideoSalesProfile();
  db.insert(schema.projects).values({
    id: projectId,
    name: "Sales video profile",
    productImages: ["/api/files/frame.png"],
    creativeProfile: profile,
    creativeConfigRevision: 2,
  }).run();
  db.insert(schema.scripts).values({
    id: scriptId,
    projectId,
    selected: true,
    styleType: "pain_point",
    shots: [silentShot],
    creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 2),
  }).run();

  state.generateVideo.mockReset().mockResolvedValue({ videoUrls: ["https://example.test/video.mp4"] });
  state.uploadLocalMedia.mockReset().mockResolvedValue("https://example.test/reference.wav");
  state.createProvider.mockReset().mockReturnValue({
    generateVideo: state.generateVideo,
    uploadLocalMedia: state.uploadLocalMedia,
  });
  state.toRemoteUsableImage.mockReset().mockImplementation(async (value: unknown) => value);
});

afterEach(() => {
  sqlite.close();
  state.db = null;
  vi.clearAllMocks();
});

describe("video generation profile context", () => {
  it("rejects generation when only unselected script history remains before provider setup", async () => {
    db.update(schema.scripts).set({ selected: false }).run();

    const response = await POST(request({ scriptId: undefined }));

    expect(response.status).toBe(409);
    expect(state.createProvider).not.toHaveBeenCalled();
    expect(state.generateVideo).not.toHaveBeenCalled();
    expect(db.select().from(schema.scripts).all().every((row) => !row.selected)).toBe(true);
  });

  it("uses the selected script's frozen policy despite a newer project configuration", async () => {
    const profile = createShortVideoSalesProfile();
    const snapshot = createCreativeProfileSnapshot(profile, 1);
    db.update(schema.projects).set({ creativeProfile: createShortVideoSalesProfile() })
      .where(eq(schema.projects.id, projectId)).run();
    db.update(schema.scripts)
      .set({ creativeProfileSnapshot: snapshot })
      .where(eq(schema.scripts.id, scriptId))
      .run();

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(state.createProvider).toHaveBeenCalledTimes(1);
    expect(state.generateVideo).toHaveBeenCalledTimes(1);
    expect(state.generateVideo.mock.calls[0][0]).toMatchObject({ modelId: "video-model", prompt: quietPrompt });
    expect(db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()?.creativeProfileSnapshot).toEqual(snapshot);
  });

  it("rejects a selected script whose frozen creative type no longer matches the project", async () => {
    db.update(schema.scripts)
      .set({ creativeProfileSnapshot: createCreativeProfileSnapshot(createTideweOutdoorProfile(), 2) })
      .where(eq(schema.scripts.id, scriptId))
      .run();

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "CREATIVE_PROFILE_MISMATCH",
      projectCreationType: "short_video_sales",
      scriptCreationType: "tidewe_outdoor",
    });
    expect(state.createProvider).not.toHaveBeenCalled();
    expect(state.generateVideo).not.toHaveBeenCalled();
  });
});
