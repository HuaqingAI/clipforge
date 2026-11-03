// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { createShortVideoSalesProfile } from "@/lib/creative-profiles";

const state = vi.hoisted(() => ({
  db: null as unknown,
  generateCover: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/video-composer/cover", () => ({ generateCover: state.generateCover }));

import { POST } from "@/app/api/project/[id]/cover/route";

const directory = mkdtempSync(join(tmpdir(), "clipforge-cover-policy-"));
const sqlite = new Database(":memory:");
const db = drizzle(sqlite, { schema });
const projectId = "sales-cover-project";
const outputPath = join(directory, "composition.mp4");

beforeAll(() => {
  state.db = db;
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  writeFileSync(outputPath, "fixture");
  db.insert(schema.projects).values({ id: projectId, name: "Cover policy" }).run();
  db.insert(schema.compositions).values({
    id: "cover-composition",
    projectId,
    outputPath,
    status: "done",
  }).run();
});

beforeEach(() => {
  state.generateCover.mockClear();
  db.update(schema.projects)
    .set({ creativeProfile: null, creativeConfigRevision: 0 })
    .where(eq(schema.projects.id, projectId))
    .run();
});

afterAll(() => {
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

function request(title = "Quiet product portrait") {
  return POST(
    new NextRequest(`http://localhost/api/project/${projectId}/cover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }),
    { params: Promise.resolve({ id: projectId }) },
  );
}

describe("sales cover generation", () => {

  it("keeps title cover generation available for sales projects", async () => {
    db.update(schema.projects)
      .set({ creativeProfile: createShortVideoSalesProfile() })
      .where(eq(schema.projects.id, projectId))
      .run();

    const response = await request("New collection");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ title: "New collection" });
    expect(state.generateCover).toHaveBeenCalledWith(expect.objectContaining({
      videoPath: outputPath,
      title: "New collection",
    }));
  });
});
