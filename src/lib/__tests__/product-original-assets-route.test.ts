// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { createCreativeProfileSnapshot, createPremiumProductCgProfile, createShortVideoSalesProfile } from "@/lib/creative-profiles";
import { hasTrustedPremiumCgAssetProvenance } from "@/lib/premium-cg-assets";

vi.mock("@/lib/db", () => ({ getDb: () => db }));
import { PATCH, POST } from "@/app/api/project/[id]/assets/route";

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let directory: string;
const projectId = "original-product-project", scriptId = "original-product-script";
const productImage = `/api/files/${projectId}/product.png`;
const params = { params: Promise.resolve({ id: projectId }) };
const shot: schema.Shot = { shotId: 1, type: "product_reveal", duration: 6, description: "A chair in the supplied front view.", camera: "Slow push in.", visualSource: "product_image", transition: "direct_concat", voiceover: "" };
function request(body: Record<string, unknown>) {
  return POST(new NextRequest(`http://localhost/api/project/${projectId}/assets`, { method: "POST", body: JSON.stringify({ scriptId, shotId: 1, type: "product_image", sourceUrl: productImage, ...body }) }), params);
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "clipforge-original-products-"));
  vi.stubEnv("APP_DATA_DIR", directory);
  mkdirSync(join(directory, "uploads", projectId), { recursive: true });
  writeFileSync(join(directory, "uploads", projectId, "product.png"), "saved photo");
  sqlite = new Database(":memory:"); db = drizzle(sqlite, { schema }); migrate(db, { migrationsFolder: "drizzle" });
  const profile = createPremiumProductCgProfile({ visualSource: "product_image" });
  db.insert(schema.projects).values({ id: projectId, name: "Original photo", productImages: [productImage], creativeProfile: profile, creativeConfigRevision: 1 }).run();
  db.insert(schema.scripts).values({ id: scriptId, projectId, styleType: profile.styleType, selected: true, shots: [shot], creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1) }).run();
});
afterEach(() => { sqlite.close(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe("server-owned product original assets", () => {
  it("saves and selects an exact saved original with server metadata and current script scope", async () => {
    const response = await request({ provider: "forged-provider", model: "forged-model", prompt: "Add a giant discount card" });
    expect(response.status).toBe(200);
    const asset = await response.json();
    expect(asset).toMatchObject({ type: "product_image", provider: "product-original", sourceScriptId: scriptId, filePath: productImage, selected: true });
    expect(asset.model).toBeNull(); expect(asset.prompt).toBeNull();
    const script = db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get()!;
    expect(hasTrustedPremiumCgAssetProvenance(asset, projectId, script)).toBe(true);
    const selection = await PATCH(new NextRequest(`http://localhost/api/project/${projectId}/assets`, { method: "PATCH", body: JSON.stringify({ assetId: asset.id }) }), params);
    expect(selection.status).toBe(200);
    expect(hasTrustedPremiumCgAssetProvenance({ ...asset, sourceShotKey: "forged" }, projectId, script)).toBe(false);
  });

  it.each([
    { sourceUrl: "/api/files/another-project/discount-card.png", provider: "product-original" },
    { type: "ai_generated", provider: "product-original" },
  ])("rejects direct unverified inputs even with a forged original marker: %j", async (body) => {
    const response = await request(body);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("PREMIUM_CG_DIRECT_ASSET_IMPORT_FORBIDDEN");
    expect(db.select().from(schema.assets).all()).toHaveLength(0);
  });

  it("does not accept an original for a script that requests AI generation", async () => {
    const profile = createPremiumProductCgProfile({ visualSource: "ai_generate" });
    db.update(schema.projects).set({ creativeProfile: profile }).where(eq(schema.projects.id, projectId)).run();
    db.update(schema.scripts).set({ shots: [{ ...shot, visualSource: "ai_generate" }], creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1) }).where(eq(schema.scripts.id, scriptId)).run();
    expect((await request({ provider: "product-original" })).status).toBe(409);
  });

  it("reserves the trusted marker even on ordinary sales imports", async () => {
    const profile = createShortVideoSalesProfile({ styleType: "scene" });
    db.update(schema.projects).set({ creativeProfile: profile }).where(eq(schema.projects.id, projectId)).run();
    db.update(schema.scripts).set({ styleType: "scene", creativeProfileSnapshot: createCreativeProfileSnapshot(profile, 1) }).where(eq(schema.scripts.id, scriptId)).run();
    const response = await request({ provider: "product-original" });
    expect(response.status).toBe(200);
    const asset = await response.json();
    expect(asset.provider).toBeNull();
    expect(hasTrustedPremiumCgAssetProvenance(asset, projectId, db.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId)).get())).toBe(false);
  });
});
