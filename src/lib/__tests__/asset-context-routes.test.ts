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

function linkKlingOutput(options: {
  assetId: string;
  projectId?: string;
  scriptId?: string;
  shotId?: number;
  jobDeleted?: boolean;
  outputDeleted?: boolean;
  importState?: typeof schema.klingJobOutputs.$inferInsert["importState"];
}) {
  db.insert(schema.klingProfiles).values({ id: "history-profile", data: {} as typeof schema.klingProfiles.$inferInsert["data"] }).onConflictDoNothing().run();
  db.insert(schema.klingJobs).values({
    id: "history-job", profileId: "history-profile", principalKey: "account", region: "global", clientRequestId: "history-request",
    projectId: options.projectId ?? projectId, scriptId: options.scriptId ?? "script-a", shotId: options.shotId ?? 1,
    submissionState: "acknowledged", remoteState: "completed", importState: "completed",
    data: { ...(options.jobDeleted && { deletedAt: 1 }) } as typeof schema.klingJobs.$inferInsert["data"], createdAt: 1, updatedAt: 1,
  }).run();
  db.insert(schema.klingJobOutputs).values({
    id: "history-output", jobId: "history-job", workKey: "history-work", assetId: options.assetId,
    importState: options.importState ?? "imported", createdAt: 1, updatedAt: 1,
    data: { url: "https://example.test/history.mp4", urlObtainedAt: 1, providerWorkId: "history-work", ...(options.outputDeleted && { deletedAt: 1 }) },
  }).run();
}

function changeCurrentShot() {
  db.update(schema.scripts).set({ shots: [{ ...shot, description: "Updated product scene" }] }).where(eq(schema.scripts.id, "script-a")).run();
}

beforeEach(() => {
  sqlite = new Database(":memory:"); db = drizzle(sqlite, { schema }); migrate(db, { migrationsFolder: "drizzle" });
  db.insert(schema.projects).values({ id: projectId, name: "Asset context" }).run();
  db.insert(schema.scripts).values([{ id: "script-a", projectId, styleType: "scene", selected: true, shots: [shot] }, { id: "script-b", projectId, styleType: "scene", selected: false, shots: [shot] }]).run();
  for (const script of db.select().from(schema.scripts).all()) db.insert(schema.assets).values({ id: `asset-${script.id}`, projectId, shotId: 1, type: "ai_generated", status: "done", selected: true, filePath: `/api/files/${projectId}/${script.id}.png`, ...assetScopeForShot(script, shot) }).run();
});
afterEach(() => sqlite.close());

describe("context-aware asset persistence and reading", () => {
  it("keeps current assets empty when only unselected script history remains", async () => {
    db.update(schema.scripts).set({ selected: false }).run();
    db.insert(schema.assets).values({ id: "legacy-history", projectId, shotId: 1, type: "ai_generated", status: "done", selected: true }).run();

    const current = await GET(new NextRequest(`http://localhost/api/project/${projectId}/assets`), context);
    expect(await current.json()).toEqual([]);
    const history = await GET(new NextRequest(`http://localhost/api/project/${projectId}/assets?all=1`), context);
    expect((await history.json()).map((row: { id: string }) => row.id).sort()).toEqual(["asset-script-a", "asset-script-b", "legacy-history"]);
    const selection = await PATCH(new NextRequest(`http://localhost/api/project/${projectId}/assets`, {
      method: "PATCH", body: JSON.stringify({ assetId: "legacy-history" }),
    }), context);
    expect(selection.status).toBe(409);
    expect(db.select().from(schema.scripts).all().every((row) => !row.selected)).toBe(true);
  });

  it("shows only the current script's asset and refuses to select another script's same-number take", async () => {
    const response = await GET(new NextRequest(`http://localhost/api/project/${projectId}/assets`), context);
    expect((await response.json()).map((row: { id: string }) => row.id)).toEqual(["asset-script-a"]);
    const mismatch = await PATCH(new NextRequest(`http://localhost/api/project/${projectId}/assets`, { method: "PATCH", body: JSON.stringify({ assetId: "asset-script-b" }) }), context);
    expect(mismatch.status).toBe(409);
    expect(db.select().from(schema.assets).where(eq(schema.assets.id, "asset-script-a")).get()?.selected).toBe(true);
  });

  it("keeps same-script takes available for composition after editing a shot", async () => {
    changeCurrentShot();
    const script = db.select().from(schema.scripts).where(eq(schema.scripts.id, "script-a")).get()!;
    db.insert(schema.assets).values({ id: "current-take", projectId, shotId: 1, type: "ai_generated", status: "done", selected: true, ...assetScopeForShot(script, script.shots![0]) }).run();
    db.insert(schema.assets).values({ id: "removed-shot", projectId, shotId: 99, type: "ai_generated", status: "done", sourceScriptId: script.id, sourceShotKey: "old", sourceRevision: "old" }).run();
    linkKlingOutput({ assetId: "asset-script-a" });

    const response = await GET(new NextRequest(`http://localhost/api/project/${projectId}/assets?includeHistory=1`), context);
    const rows = await response.json();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(rows.map((row: { id: string }) => row.id).sort()).toEqual(["asset-script-a", "current-take"]);
    expect(rows.find((row: { id: string }) => row.id === "asset-script-a")).toMatchObject({
      matchesCurrentScript: true, selected: true,
    });
    expect(rows.find((row: { id: string }) => row.id === "current-take")).toMatchObject({ matchesCurrentScript: true, selected: true });
    expect(db.select().from(schema.assets).where(eq(schema.assets.id, "asset-script-a")).get()?.selected).toBe(true);
    const current = await GET(new NextRequest(`http://localhost/api/project/${projectId}/assets`), context);
    expect((await current.json()).map((row: { id: string }) => row.id).sort()).toEqual(["asset-script-a", "current-take"]);
  });

  it("keeps composition history empty when there is no explicitly selected script", async () => {
    db.update(schema.scripts).set({ selected: false }).run();
    const response = await GET(new NextRequest(`http://localhost/api/project/${projectId}/assets?includeHistory=1`), context);
    expect(await response.json()).toEqual([]);
  });

  it.each([
    { label: "another project", projectId: "other-project" },
    { label: "another script", scriptId: "script-b" },
    { label: "another shot", shotId: 2 },
    { label: "another asset", assetId: "asset-script-b" },
    { label: "a deleted job", jobDeleted: true },
    { label: "a deleted output", outputDeleted: true },
    { label: "an unfinished import", importState: "pending" as const },
  ])("does not expose recovery metadata for $label", async (options) => {
    changeCurrentShot();
    linkKlingOutput({ assetId: "asset-script-a", ...options });
    const response = await GET(new NextRequest(`http://localhost/api/project/${projectId}/assets?includeHistory=1`), context);
    const rows = await response.json();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "asset-script-a", matchesCurrentScript: true, selected: true });
    expect(rows[0]).not.toHaveProperty("klingJobId");
    expect(rows[0]).not.toHaveProperty("klingOutputId");
  });

  it("keeps a derived same-script take current after an edit without recovery metadata", async () => {
    const original = db.select().from(schema.assets).where(eq(schema.assets.id, "asset-script-a")).get()!;
    db.insert(schema.assets).values({ ...original, id: "old-derived-take", derivedFromAssetId: original.id }).run();
    changeCurrentShot();
    linkKlingOutput({ assetId: original.id });
    const rows = await (await GET(new NextRequest(`http://localhost/api/project/${projectId}/assets?includeHistory=1`), context)).json();
    expect(rows.find((row: { id: string }) => row.id === "old-derived-take")).toMatchObject({
      matchesCurrentScript: true,
    });
  });

  it("retains the original and its derived take under their same script identity", async () => {
    changeCurrentShot();
    const script = db.select().from(schema.scripts).where(eq(schema.scripts.id, "script-a")).get()!;
    db.insert(schema.assets).values({ id: "adopted-take", projectId, shotId: 1, type: "ai_generated", status: "done", selected: true, ...assetScopeForShot(script, script.shots![0], "asset-script-a") }).run();
    linkKlingOutput({ assetId: "asset-script-a" });
    const rows = await (await GET(new NextRequest(`http://localhost/api/project/${projectId}/assets?includeHistory=1`), context)).json();
    expect(rows.map((row: { id: string }) => row.id).sort()).toEqual(["adopted-take", "asset-script-a"]);
    expect(rows[0]).toMatchObject({ matchesCurrentScript: true, selected: true });
    expect(rows[0]).not.toHaveProperty("klingJobId");
    const all = await (await GET(new NextRequest(`http://localhost/api/project/${projectId}/assets?all=1&includeHistory=1`), context)).json();
    expect(all.map((row: { id: string }) => row.id).sort()).toEqual(["adopted-take", "asset-script-a", "asset-script-b"]);
    expect(all.every((row: { selected: boolean }) => row.selected)).toBe(true);
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

  it("imports and selects an old revision when the same alternative and take remain selected", async () => {
    const original = db.select().from(schema.scripts).where(eq(schema.scripts.id, "script-a")).get()!;
    db.update(schema.scripts).set({ shots: [{ ...shot, description: "A new scene" }] }).where(eq(schema.scripts.id, original.id)).run();
    const imported = await saveAssetCandidate({ projectId, shotId: 1, filePath: "/api/files/p/old-revision.png", scope: assetScopeForShot(original, shot), selectedPolicy: { mode: "select-if-unchanged", baseline: { scriptId: original.id, scriptRevision: scriptRevision(original), selectedAssetId: "asset-script-a" } } });
    expect(imported.selected).toBe(true);
    const rows = await (await GET(new NextRequest(`http://localhost/api/project/${projectId}/assets`), context)).json();
    expect(rows.map((row: { id: string }) => row.id).sort()).toEqual(["asset-script-a", imported.id].sort());
    expect(rows.find((row: { id: string }) => row.id === "asset-script-a").selected).toBe(false);
    expect(imported.sourceRevision).toBe(scriptRevision(original));
  });

  it.each(["other-script", "missing-shot", "other-project"])("rejects a scoped save for %s", async (change) => {
    const original = db.select().from(schema.scripts).where(eq(schema.scripts.id, "script-a")).get()!;
    const scope = assetScopeForShot(original, shot);
    if (change === "other-script") {
      db.update(schema.scripts).set({ selected: false }).where(eq(schema.scripts.id, original.id)).run();
      db.update(schema.scripts).set({ selected: true }).where(eq(schema.scripts.id, "script-b")).run();
    }
    if (change === "missing-shot") db.update(schema.scripts).set({ shots: [] }).where(eq(schema.scripts.id, original.id)).run();
    await expect(saveAssetCandidate({ projectId: change === "other-project" ? "different-project" : projectId, shotId: 1,
      filePath: "/api/files/p/result.png", scope, expectedCurrentScript: { scriptId: original.id } })).rejects.toMatchObject({ code: "SCRIPT_CONTEXT_CHANGED" });
    expect(db.select().from(schema.assets).all()).toHaveLength(2);
  });

  it("preserves the original local task import path and blocks the full-film Seedance fallback", async () => {
    const forgedSave = await POST(new NextRequest(`http://localhost/api/project/${projectId}/assets`, { method: "POST", body: JSON.stringify({ provider: "kling-cli", shotId: 1, sourceUrl: "https://arbitrary.test/video.mp4" }) }), context);
    expect(forgedSave.status).toBe(409);
    const dryRun = await film(new NextRequest(`http://localhost/api/project/${projectId}/storyboard-film`, { method: "POST", body: JSON.stringify({ dryRun: true, model: JSON.stringify(["kling-cli", "image_to_video", "account-model"]) }) }), context);
    expect(dryRun.status).toBe(410);
    expect((await dryRun.json()).error.code).toBe("KLING_FILM_REMOVED");
  });
});
