// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { assetScopeForShot, scriptRevision } from "@/lib/asset-context";
import { saveAssetCandidate } from "@/lib/asset-persistence";
import { GET, PATCH, POST } from "@/app/api/project/[id]/assets/route";
import { POST as film } from "@/app/api/project/[id]/storyboard-film/route";

vi.mock("@/lib/db", () => ({ getDb: () => db }));
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const projectId = "asset-context-project";
const shot: schema.Shot = { shotId: 1, type: "hook", duration: 5, description: "Product A", camera: "static", visualSource: "ai_generate", transition: "direct_concat", voiceover: "" };
const context = { params: Promise.resolve({ id: projectId }) };

beforeEach(() => {
  sqlite = new Database(":memory:"); db = drizzle(sqlite, { schema }); migrate(db, { migrationsFolder: "drizzle" });
  db.insert(schema.projects).values({ id: projectId, name: "Asset context" }).run();
  db.insert(schema.scripts).values([{ id: "script-a", projectId, styleType: "scene", selected: true, shots: [shot] }, { id: "script-b", projectId, styleType: "scene", selected: false, shots: [shot] }]).run();
  for (const script of db.select().from(schema.scripts).all()) db.insert(schema.assets).values({ id: `asset-${script.id}`, projectId, shotId: 1, type: "ai_generated", status: "done", selected: true, filePath: `/api/files/${projectId}/${script.id}.png`, ...assetScopeForShot(script, shot) }).run();
});
afterEach(() => sqlite.close());

describe("context-aware asset persistence and reading", () => {
  it("shows only the current script's asset and refuses to select another script's same-number take", async () => {
    const response = await GET(new NextRequest(`http://localhost/api/project/${projectId}/assets`), context);
    expect((await response.json()).map((row: { id: string }) => row.id)).toEqual(["asset-script-a"]);
    const mismatch = await PATCH(new NextRequest(`http://localhost/api/project/${projectId}/assets`, { method: "PATCH", body: JSON.stringify({ assetId: "asset-script-b" }) }), context);
    expect(mismatch.status).toBe(409);
    expect(db.select().from(schema.assets).where(eq(schema.assets.id, "asset-script-a")).get()?.selected).toBe(true);
  });

  it("keeps a recovered result as an alternative after the user changes the active take", async () => {
    const script = db.select().from(schema.scripts).where(eq(schema.scripts.id, "script-a")).get()!;
    const first = await saveAssetCandidate({ projectId, shotId: 1, filePath: "/api/files/p/new-choice.png", scope: assetScopeForShot(script, shot) });
    const recovered = await saveAssetCandidate({ projectId, shotId: 1, filePath: "/api/files/p/recovered.png", scope: assetScopeForShot(script, shot), selectedPolicy: { mode: "select-if-unchanged", baseline: { scriptId: script.id, scriptRevision: scriptRevision(script), selectedAssetId: "asset-script-a" } } });
    expect(recovered.selected).toBe(false);
    expect(db.select().from(schema.assets).where(eq(schema.assets.id, first.id)).get()?.selected).toBe(true);
    expect(db.select().from(schema.assets).where(eq(schema.assets.id, "asset-script-b")).get()?.selected).toBe(true);
  });

  it("selects a recovered take only when script and previous selection still match", async () => {
    const script = db.select().from(schema.scripts).where(eq(schema.scripts.id, "script-a")).get()!;
    const recovered = await saveAssetCandidate({ projectId, shotId: 1, filePath: "/api/files/p/recovered.png", scope: assetScopeForShot(script, shot), selectedPolicy: { mode: "select-if-unchanged", baseline: { scriptId: script.id, scriptRevision: scriptRevision(script), selectedAssetId: "asset-script-a" } } });
    expect(recovered.selected).toBe(true);
    expect(db.select().from(schema.assets).where(eq(schema.assets.id, "asset-script-a")).get()?.selected).toBe(false);
    expect(db.select().from(schema.assets).where(eq(schema.assets.id, "asset-script-b")).get()?.selected).toBe(true);
  });

  it("does not deselect another script's legacy take when explicitly saving a nonselected script", async () => {
    db.insert(schema.assets).values({ id: "legacy", projectId, shotId: 1, type: "ai_generated", status: "done", selected: true }).run();
    const target = db.select().from(schema.scripts).where(eq(schema.scripts.id, "script-b")).get()!;
    await saveAssetCandidate({ projectId, shotId: 1, filePath: "/api/files/p/script-b-new.png", scope: assetScopeForShot(target, shot) });
    expect(db.select().from(schema.assets).where(eq(schema.assets.id, "legacy")).get()?.selected).toBe(true);
    expect(db.select().from(schema.assets).where(eq(schema.assets.id, "asset-script-a")).get()?.selected).toBe(true);
    expect(db.select().from(schema.assets).where(eq(schema.assets.id, "asset-script-b")).get()?.selected).toBe(false);
  });

  it("excludes an old revision and prevents a late import from selecting itself", async () => {
    const original = db.select().from(schema.scripts).where(eq(schema.scripts.id, "script-a")).get()!;
    db.update(schema.scripts).set({ shots: [{ ...shot, description: "A new scene" }] }).where(eq(schema.scripts.id, original.id)).run();
    const imported = await saveAssetCandidate({ projectId, shotId: 1, filePath: "/api/files/p/old-revision.png", scope: assetScopeForShot(original, shot), selectedPolicy: { mode: "select-if-unchanged", baseline: { scriptId: original.id, scriptRevision: scriptRevision(original), selectedAssetId: "asset-script-a" } } });
    expect(imported.selected).toBe(false);
    expect(await (await GET(new NextRequest(`http://localhost/api/project/${projectId}/assets`), context)).json()).toEqual([]);
  });

  it("preserves the original local task import path and blocks the full-film Seedance fallback", async () => {
    const forgedSave = await POST(new NextRequest(`http://localhost/api/project/${projectId}/assets`, { method: "POST", body: JSON.stringify({ provider: "kling-cli", shotId: 1, sourceUrl: "https://arbitrary.test/video.mp4" }) }), context);
    expect(forgedSave.status).toBe(409);
    const dryRun = await film(new NextRequest(`http://localhost/api/project/${projectId}/storyboard-film`, { method: "POST", body: JSON.stringify({ dryRun: true, model: JSON.stringify(["kling-cli", "image_to_video", "account-model"]) }) }), context);
    expect(dryRun.status).toBe(403);
    expect((await dryRun.json()).error.code).toBe("KLING_LOCAL_ACCESS_DENIED");
  });
});
