// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as schema from "@/lib/db/schema";
import {
  createCreativeProfileSnapshot,
  createPremiumProductCgProfile,
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

function setCgContext(profile: ReturnType<typeof createPremiumProductCgProfile>, shot: schema.Shot = silentShot, revision = 2) {
  db.update(schema.projects)
    .set({ creativeProfile: profile, creativeConfigRevision: revision })
    .where(eq(schema.projects.id, projectId))
    .run();
  db.update(schema.scripts)
    .set({
      styleType: "premium_product_cg",
      shots: [shot],
      creativeProfileSnapshot: createCreativeProfileSnapshot(profile, revision),
    })
    .where(eq(schema.scripts.id, scriptId))
    .run();
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  state.db = db;
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });

  const profile = createPremiumProductCgProfile({ narrationMode: "none" });
  db.insert(schema.projects).values({
    id: projectId,
    name: "Premium video policy",
    productImages: ["/api/files/frame.png"],
    creativeProfile: profile,
    creativeConfigRevision: 2,
  }).run();
  db.insert(schema.scripts).values({
    id: scriptId,
    projectId,
    selected: true,
    styleType: "premium_product_cg",
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

describe("premium CG video generation profile context", () => {
  it("rejects generation when only unselected script history remains before provider setup", async () => {
    db.update(schema.scripts).set({ selected: false }).run();

    const response = await POST(request({ scriptId: undefined }));

    expect(response.status).toBe(409);
    expect(state.createProvider).not.toHaveBeenCalled();
    expect(state.generateVideo).not.toHaveBeenCalled();
    expect(db.select().from(schema.scripts).all().every((row) => !row.selected)).toBe(true);
  });

  it("uses the selected script's frozen policy despite a newer project configuration", async () => {
    const profile = createPremiumProductCgProfile({ narrationMode: "none" });
    const snapshot = createCreativeProfileSnapshot(profile, 1);
    db.update(schema.projects).set({ creativeProfile: createPremiumProductCgProfile({ narrationMode: "restrained" }) })
      .where(eq(schema.projects.id, projectId)).run();
    db.update(schema.scripts)
      .set({ creativeProfileSnapshot: snapshot })
      .where(eq(schema.scripts.id, scriptId))
      .run();

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(state.createProvider).toHaveBeenCalledTimes(1);
    expect(state.generateVideo).toHaveBeenCalledTimes(1);
    expect(state.generateVideo.mock.calls[0][0]).toMatchObject({ audioEnabled: false });
    expect(db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()?.creativeProfileSnapshot).toEqual(snapshot);
  });

  it("rejects a selected script whose frozen creative type no longer matches the project", async () => {
    db.update(schema.scripts)
      .set({ creativeProfileSnapshot: createCreativeProfileSnapshot(createShortVideoSalesProfile(), 2) })
      .where(eq(schema.scripts.id, scriptId))
      .run();

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "CREATIVE_PROFILE_MISMATCH",
      projectCreationType: "premium_product_cg",
      scriptCreationType: "short_video_sales",
    });
    expect(state.createProvider).not.toHaveBeenCalled();
    expect(state.generateVideo).not.toHaveBeenCalled();
  });

  it("suppresses client voice and reference-audio controls for silent premium CG", async () => {
    const response = await POST(request({
      options: {
        audioEnabled: true,
        voiceover: "Client supplied voiceover must not reach the generator.",
        audioPrompt: "Commercial voice and music.",
      },
      referenceAudioUrls: ["/api/files/reference.wav"],
    }));

    expect(response.status).toBe(200);
    expect(state.generateVideo).toHaveBeenCalledTimes(1);
    const options = state.generateVideo.mock.calls[0][0];
    expect(options).toMatchObject({ audioEnabled: false });
    expect(options.voiceover).toBeUndefined();
    expect(options.audioPrompt).toBeUndefined();
    expect(options.referenceAudioUrls).toBeUndefined();
    expect(state.uploadLocalMedia).not.toHaveBeenCalled();
  });

  it("drops client reference-video controls before the premium CG request reaches a provider", async () => {
    const response = await POST(request({
      referenceVideoUrls: ["/api/files/legacy-sales-reference.mp4"],
    }));

    expect(response.status).toBe(200);
    expect(state.generateVideo).toHaveBeenCalledTimes(1);
    expect(state.generateVideo.mock.calls[0][0].referenceVideoUrls).toBeUndefined();
    expect(state.uploadLocalMedia).not.toHaveBeenCalled();
  });

  it("drops nested provider extras that could inject a sales reference video or frame", async () => {
    const response = await POST(request({
      options: {
        extra: {
          video_url: "https://example.test/legacy-sales.mp4",
          image_url: "https://example.test/sale-card.png",
          end_image: "https://example.test/cta-frame.png",
          prompt: "Add a flashing price card.",
        },
      },
    }));

    expect(response.status).toBe(200);
    expect(state.generateVideo).toHaveBeenCalledTimes(1);
    const options = state.generateVideo.mock.calls[0][0];
    expect(options.extra).toBeUndefined();
    expect(options.firstFrameUrl).toBe("/api/files/frame.png");
    expect(options.referenceVideoUrls).toBeUndefined();
  });

  it("rebuilds premium CG prompt and product references instead of trusting browser video fields", async () => {
    const forgedPrompt = "Add a giant BUY NOW card and flash a limited-time price.";
    const response = await POST(request({
      mode: "text-to-video",
      prompt: forgedPrompt,
      imageUrl: "https://example.test/foreign-sales-card.png",
      lastImageUrl: "https://example.test/foreign-tail.png",
      referenceImageUrls: ["https://example.test/foreign-reference.png"],
    }));

    expect(response.status).toBe(200);
    const options = state.generateVideo.mock.calls[0][0];
    expect(options).toMatchObject({
      mode: "image-to-video",
      firstFrameUrl: "/api/files/frame.png",
    });
    expect(options.prompt).toContain("高端产品三维动态影像");
    expect(options.prompt).not.toContain(forgedPrompt);
    expect(options.lastFrameUrl).toBeUndefined();
    expect(options.referenceImageUrls).toBeUndefined();
    expect(JSON.stringify(options)).not.toContain("foreign-sales-card.png");
  });

  it("accepts restrained narration only when it matches the selected shot", async () => {
    const approvedNarration = "The walnut frame meets the woven seat with a quiet, precise line.";
    const profile = createPremiumProductCgProfile({ narrationMode: "restrained" });
    setCgContext(profile, {
      ...silentShot,
      voiceover: approvedNarration,
      narration: approvedNarration,
    });

    const rejected = await POST(request({
      options: { audioEnabled: true, voiceover: "Buy this chair today." },
    }));
    expect(rejected.status).toBe(400);
    expect(state.generateVideo).not.toHaveBeenCalled();

    const accepted = await POST(request({
      options: {
        audioEnabled: true,
        voiceover: approvedNarration,
        audioPrompt: "Unapproved music direction.",
      },
      referenceAudioUrls: ["/api/files/reference.wav"],
    }));

    expect(accepted.status).toBe(200);
    expect(state.generateVideo).toHaveBeenCalledTimes(1);
    const options = state.generateVideo.mock.calls[0][0];
    expect(options).toMatchObject({ audioEnabled: true, voiceover: approvedNarration });
    expect(options.audioPrompt).toBeUndefined();
    expect(options.referenceAudioUrls).toBeUndefined();
    expect(state.uploadLocalMedia).not.toHaveBeenCalled();
  });
});
