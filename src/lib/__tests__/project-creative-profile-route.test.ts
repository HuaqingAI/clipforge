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
  createPremiumProductCgProfile,
  createShortVideoSalesProfile,
  createTideweOutdoorProfile,
  type ProjectCreativeProfile,
} from "@/lib/creative-profiles";

vi.mock("@/lib/db", () => ({ getDb: () => db }));
import { PATCH } from "@/app/api/project/[id]/route";

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const projectId = "fixed-creation-type-project";
const profiles = [
  createShortVideoSalesProfile(),
  createPremiumProductCgProfile(),
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
  it.each(profiles.flatMap((current) => profiles
    .filter((incoming) => incoming.creationType !== current.creationType)
    .map((incoming) => ({ from: current.creationType, to: incoming.creationType, current, incoming })),
  ))("rejects $from to $to without saving any project changes", async ({ current, incoming }) => {
    const original = seed(current);
    const response = await patch({
      creativeProfile: incoming,
      creativeProfileDrafts: { [incoming.creationType]: incoming },
      name: "Must not save",
      productFacts: { version: 1, brand: "TIDEWE", category: "hunting_apparel", items: [] },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "CREATION_TYPE_LOCKED",
      creationType: current.creationType,
    });
    expect(savedProject()).toEqual(original);
  });

  it.each([
    { label: "profile alias", body: { profile: { creationType: "short_video_sales" } } },
    { label: "string profile alias", body: { profile: "short_video_sales_v1" } },
    { label: "nested profile ID", body: { creativeProfile: { id: "tidewe_outdoor_v1" } } },
    { label: "string creativeProfile", body: { creativeProfile: "tidewe_outdoor_v1" } },
    { label: "style identity", body: { creativeProfile: { styleType: "pain_point" } } },
    { label: "flat creationType", body: { creationType: "tidewe_outdoor" } },
    { label: "flat profileId", body: { profileId: "short_video_sales_v1" } },
    { label: "flat creativeProfileId", body: { creativeProfileId: "tidewe_outdoor_v1" } },
  ])("rejects creation type changes through $label", async ({ body }) => {
    const original = seed(createPremiumProductCgProfile());
    const response = await patch(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "CREATION_TYPE_LOCKED" });
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

  it("cannot activate a different type by updating an inactive draft", async () => {
    const profile = createShortVideoSalesProfile();
    seed(profile);
    const response = await patch({
      creativeProfileDrafts: { premium_product_cg: createPremiumProductCgProfile({ targetDuration: 60 }) },
    });

    expect(response.status).toBe(200);
    expect(savedProject()).toMatchObject({
      creativeProfile: profile,
      creativeProfileDrafts: { premium_product_cg: { targetDuration: 60 } },
    });
  });

  it("keeps legacy projects on their resolved sales type and permits profile migration", async () => {
    const original = seed(null);
    const rejected = await patch({ creativeProfile: createPremiumProductCgProfile() });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: "CREATION_TYPE_LOCKED", creationType: "short_video_sales" });
    expect(savedProject()).toEqual(original);

    const migrated = await patch({ creativeProfile: { creationType: "short_video_sales" } });
    expect(migrated.status).toBe(200);
    expect(savedProject()).toMatchObject({
      creativeConfigRevision: 4,
      creativeProfile: { creationType: "short_video_sales", videoMode: "scene_demo" },
    });
  });

  it("preserves the direct legacy video mode update path", async () => {
    seed(null);
    const response = await patch({ videoMode: "graphic_montage" });
    expect(response.status).toBe(200);
    expect(savedProject()).toMatchObject({ creativeProfile: null, videoMode: "graphic_montage", creativeConfigRevision: 3 });
  });
});
