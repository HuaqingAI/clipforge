// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import {
  createTideweOutdoorProfile,
  type ProjectCreativeProfile,
} from "@/lib/creative-profiles";

vi.mock("@/lib/db", () => ({ getDb: () => db }));
import { PATCH } from "@/app/api/project/[id]/route";

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const projectId = "fixed-creation-type-project";
const profiles = [
  createTideweOutdoorProfile(),
];

function seed(profile: ProjectCreativeProfile | null = profiles[0]) {
  return db.insert(schema.projects).values({
    id: projectId,
    name: "Original project",
    creativeProfile: profile,
    creativeConfigRevision: 3,
    videoMode: profile?.videoMode ?? "scene_demo",
  }).returning().get()!;
}

function patch(body: Record<string, unknown>) {
  return PATCH(new NextRequest(`http://localhost/api/project/${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedCreativeConfigRevision: 3, ...body }),
  }), { params: Promise.resolve({ id: projectId }) });
}

function savedProject() {
  return db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!;
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
});

afterEach(() => { sqlite.close(); });

describe("project creation type is fixed", () => {
  it.each([
    { profile: { creationType: "short_video_sales" } },
    { profile: "short_video_sales_v1" },
    { creativeProfile: { styleType: "pain_point" } },
    { profileId: "short_video_sales_v1" },
    { creativeProfileDrafts: { short_video_sales: { creationType: "short_video_sales" } } },
  ])("rejects removed creation profiles without changing the project: %j", async body => {
    const original = seed(createTideweOutdoorProfile());
    expect((await patch(body)).status).toBe(400);
    expect(savedProject()).toEqual(original);
  });

  it.each(profiles)("saves settings within $creationType and keeps revision checks", async (profile) => {
    seed(profile);
    const response = await patch({ creativeProfile: { ...profile, targetDuration: 60 }, name: "Updated project" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      name: "Updated project",
      creativeConfigRevision: 4,
      creativeProfile: { creationType: profile.creationType, targetDuration: 60 },
      creativeProfileDrafts: { [profile.creationType]: { targetDuration: 60 } },
    });

    const stale = await patch({ creativeProfile: profile });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "CREATIVE_CONFIG_CONFLICT", creativeConfigRevision: 4 });

    const identityOnly = await patch({
      creativeProfile: { creationType: profile.creationType },
      expectedCreativeConfigRevision: 4,
    });
    expect(identityOnly.status).toBe(200);
    expect(await identityOnly.json()).toMatchObject({
      creativeConfigRevision: 4,
      creativeProfile: { creationType: profile.creationType, targetDuration: 60 },
    });
  });

  it.each(profiles)("saves active $creationType draft settings without changing type", async (profile) => {
    seed(profile);
    const response = await patch({
      creativeProfileDrafts: { [profile.creationType]: { ...profile, targetDuration: 60 } },
    });

    expect(response.status).toBe(200);
    expect(savedProject()).toMatchObject({
      creativeConfigRevision: 4,
      creativeProfile: { creationType: profile.creationType, targetDuration: 60 },
    });
  });

  it("keeps archived projects from being reactivated or reinterpreted as TIDEWE", async () => {
    const original = seed(null);
    const response = await patch({ creativeProfile: createTideweOutdoorProfile() });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "CREATION_TYPE_LOCKED", creationType: "unsupported" });
    expect(savedProject()).toEqual(original);
  });

  it("preserves the direct legacy video mode update path", async () => {
    seed(null);
    const response = await patch({ videoMode: "graphic_montage" });
    expect(response.status).toBe(200);
    expect(savedProject()).toMatchObject({ creativeProfile: null, videoMode: "graphic_montage", creativeConfigRevision: 3 });
  });
});
