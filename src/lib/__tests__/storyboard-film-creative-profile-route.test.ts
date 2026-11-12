import { archivedCreativeProfile } from "@/lib/__tests__/fixtures/creative-profile";
// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as schema from "@/lib/db/schema";
import {
  createCreativeProfileSnapshot } from "@/lib/creative-profiles";
import { assetScopeForShot } from "@/lib/asset-context";

const state = vi.hoisted(() => ({
  db: null as unknown,
  createProvider: vi.fn(),
  generateVideo: vi.fn(),
  toRemoteUsableImage: vi.fn(),
  recordAiTask: vi.fn(),
  updateAiTask: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/providers", () => ({ createProvider: state.createProvider }));
vi.mock("@/lib/remote-image", () => ({ toRemoteUsableImage: state.toRemoteUsableImage }));
vi.mock("@/lib/ai-tasks", () => ({ recordAiTask: state.recordAiTask, updateAiTask: state.updateAiTask }));
vi.mock("@/lib/providers/atlas-catalog", () => ({
  fetchAtlasCatalog: vi.fn().mockResolvedValue([]),
  getCachedAtlasEntry: vi.fn(),
}));
vi.mock("@/lib/media-probe", () => ({ probeMedia: vi.fn().mockResolvedValue(undefined) }));

import { POST } from "@/app/api/project/[id]/storyboard-film/route";

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let dataDirectory: string;

const projectId = "film-creative-profile-project";
const scriptId = "film-creative-profile-script";
const silentShots: schema.Shot[] = [
  {
    shotId: 1,
    type: "product_reveal",
    duration: 5,
    description: "A walnut lounge chair in a quiet studio, preserving the supplied silhouette and upholstery texture.",
    camera: "A restrained slow lateral move across the front corner.",
    voiceover: "",
    visualSource: "product_image",
    transition: "direct_concat",
  },
  {
    shotId: 2,
    type: "demo",
    duration: 5,
    description: "A close observation of the walnut grain, woven seat, and careful joint alignment.",
    camera: "A slow macro push-in limited to the visible material detail.",
    voiceover: "",
    visualSource: "product_image",
    transition: "direct_concat",
  },
];

function request(overrides: Record<string, unknown> = {}) {
  return POST(new NextRequest(`http://localhost/api/project/${projectId}/storyboard-film`, {
    method: "POST",
    body: JSON.stringify({
      scriptId,
      provider: "fixture",
      apiKey: "fixture-key",
      model: "doubao-seedance-2.5",
      ...overrides,
    }),
  }), { params: Promise.resolve({ id: projectId }) });
}

function setCreativeContext(
  profile: ReturnType<typeof archivedCreativeProfile>,
  shots: schema.Shot[] = silentShots,
  revision = 2,
) {
  db.update(schema.projects)
    .set({ creativeProfile: profile, creativeConfigRevision: revision })
    .where(eq(schema.projects.id, projectId))
    .run();
  db.update(schema.scripts)
    .set({
      styleType: profile.styleType as typeof schema.scripts.$inferSelect.styleType,
      shots,
      creativeProfileSnapshot: createCreativeProfileSnapshot(profile, revision),
    })
    .where(eq(schema.scripts.id, scriptId))
    .run();
  rescopeSelectedGridAssets();
}

function rescopeSelectedGridAssets() {
  const script = db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()!;
  const shots = script.shots ?? [];
  for (const asset of db.select().from(schema.assets).where(eq(schema.assets.projectId, projectId)).all()) {
    const shot = shots.find((item) => item.shotId === asset.shotId);
    if (!shot) continue;
    db.update(schema.assets)
      .set(assetScopeForShot(script, shot))
      .where(eq(schema.assets.id, asset.id))
      .run();
  }
}

beforeEach(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), "clipforge-film-creative-profile-"));
  vi.stubEnv("APP_DATA_DIR", dataDirectory);
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  state.db = db;
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });

  const profile = archivedCreativeProfile();
  db.insert(schema.projects).values({
    id: projectId,
    name: "Sales film audio policy",
    creativeProfile: profile,
    creativeConfigRevision: 2,
  }).run();
  db.insert(schema.scripts).values({
    id: scriptId,
    projectId,
    selected: true,
    styleType: "pain_point",
    shots: silentShots,
    creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 2),
  }).run();
  const persistedScript = db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()!;
  for (const shot of silentShots) {
    const persistedShot = persistedScript.shots?.find((item) => item.shotId === shot.shotId) ?? shot;
    db.insert(schema.assets).values({
      projectId,
      shotId: shot.shotId,
      type: "ai_generated",
      filePath: `/api/files/${projectId}/asset-${shot.shotId}-1000-grid.png`,
      status: "done",
      selected: true,
      provider: "fixture",
      prompt: `[storyboard-grid cell ${shot.shotId}]`,
      ...assetScopeForShot(persistedScript, persistedShot),
    }).run();
  }

  state.generateVideo.mockReset().mockResolvedValue({
    modelId: "doubao-seedance-2.5",
    videoUrls: ["https://example.test/sales-film.mp4"],
  });
  state.createProvider.mockReset().mockReturnValue({ generateVideo: state.generateVideo });
  state.toRemoteUsableImage.mockReset().mockImplementation(async (value: unknown) => value);
  state.recordAiTask.mockReset().mockResolvedValue(undefined);
  state.updateAiTask.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("generated film")));
});

afterEach(async () => {
  sqlite.close();
  state.db = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe("storyboard film creative-profile audio policy", () => {

  it("keeps audio controls available for the legacy sales profile", async () => {
    setCreativeContext(archivedCreativeProfile({ styleType: "scene" }));
    const voiceover = "This chair brings a warm finish to the room.";
    const audioPrompt = "Soft room tone and a calm voice.";
    const response = await request({
      options: {
        audioEnabled: true,
        voiceover,
        audioPrompt,
        referenceAudioUrls: ["https://example.test/sales-reference.wav"],
        extra: { generate_audio: true },
      },
    });

    expect(response.status).toBe(200);
    expect(state.generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      audioEnabled: true,
      voiceover,
      audioPrompt,
      referenceAudioUrls: ["https://example.test/sales-reference.wav"],
      extra: { generate_audio: true },
    }));
  });
});
