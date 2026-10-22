// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { saveCompositionError } from "@/lib/composition-error";

const state = vi.hoisted(() => ({ db: null as unknown, render: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/video-composer/composer", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/video-composer/composer")>(),
  composeVideo: state.render,
}));
import { GET, POST } from "@/app/api/project/[id]/compose/route";

let directory: string;
const sqlite = new Database(":memory:");
const db = drizzle(sqlite, { schema });
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "clipforge-compose-route-"));
  vi.stubEnv("APP_DATA_DIR", directory);
  state.db = db;
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  db.insert(schema.projects).values([
    { id: "project-a", name: "A", productImages: ["/api/files/project-a/product.png"] },
    { id: "project-b", name: "B" },
  ]).run();
  await mkdir(join(directory, "uploads", "project-a"), { recursive: true });
  await writeFile(join(directory, "uploads", "project-a", "product.png"), "fixture");
  db.insert(schema.scripts).values({ projectId: "project-a", styleType: "scene", selected: true, shots: [
    { shotId: 1, type: "hook", duration: 2, description: "Product shot", camera: "static", visualSource: "product_image", transition: "direct_concat", voiceover: "" },
  ] }).run();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  sqlite.close();
  await rm(directory, { recursive: true, force: true });
});

async function get(projectId: string, compositionId?: string) {
  const query = compositionId ? `?compositionId=${encodeURIComponent(compositionId)}` : "";
  const res = await GET(new NextRequest(`http://localhost/api/project/${projectId}/compose${query}`), { params: Promise.resolve({ id: projectId }) });
  return res.json();
}

describe("composition failure polling", () => {
  it("persists background failures before clients see failed status and returns the useful error", async () => {
    state.render.mockRejectedValueOnce(Object.assign(new Error("Command failed: ffmpeg PRIVATE_ARGV"), {
      stderr: "ffmpeg version 9.0\nUnrecognized option 'filter_complex_script'.\nError splitting the argument list: Option not found",
    }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(new NextRequest("http://localhost/api/project/project-a/compose", { method: "POST", body: "{}" }), { params: Promise.resolve({ id: "project-a" }) });
      expect(response.status).toBe(202);
      const { compositionId } = await response.json();
      await vi.waitFor(async () => {
        const { composition } = await get("project-a", compositionId);
        expect(composition).toMatchObject({ id: compositionId, status: "failed", error: "Unrecognized option 'filter_complex_script'.\nError splitting the argument list: Option not found" });
      });
      const [project] = db.select().from(schema.projects).where(eq(schema.projects.id, "project-a")).all();
      expect(project.status).toBe("video");
    } finally {
      log.mockRestore();
    }
  });

  it("pins polling to its requested take, isolates projects, and handles older failures", async () => {
    db.insert(schema.compositions).values([
      { id: "pinned", projectId: "project-a", status: "failed", createdAt: new Date(1000) },
      { id: "latest", projectId: "project-a", status: "failed", createdAt: new Date(Date.now() + 1000) },
      { id: "other", projectId: "project-b", status: "failed" },
      { id: "successful", projectId: "project-a", status: "done", outputPath: join(directory, "final.mp4") },
    ]).run();
    await saveCompositionError("project-a", "pinned", new Error("Pinned failure"));
    await saveCompositionError("project-b", "other", new Error("Other project private failure"));
    await saveCompositionError("project-a", "successful", new Error("Stale error"));
    expect((await get("project-a", "pinned")).composition).toMatchObject({ id: "pinned", error: "Pinned failure" });
    expect((await get("project-a")).composition).toMatchObject({ id: "latest", status: "failed" });
    expect((await get("project-a")).composition.error).toBeUndefined();
    expect(await get("project-a", "other")).toEqual({ composition: null });
    expect(await get("project-a", "../pinned")).toEqual({ composition: null });
    expect((await get("project-a", "successful")).composition.error).toBeUndefined();
  });
});
