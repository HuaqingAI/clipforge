// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";

const state = vi.hoisted(() => ({ db: null as unknown, poster: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/video-composer/frame-extract", () => ({ extractFirstFrame: state.poster }));
import { GET } from "@/app/api/works/route";

const sqlite = new Database(":memory:");
const db = drizzle(sqlite, { schema });
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "clipforge-works-feed-"));
  state.db = db;
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  db.insert(schema.projects).values({ id: "project", name: "Product" }).run();
});

afterAll(async () => {
  sqlite.close();
  if (!directory || dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("clipforge-works-feed-")) throw new Error("Unexpected fixture directory");
  await rm(directory, { recursive: true, force: true });
});

it("omits a work deleted while its poster is being backfilled and preserves the other works", async () => {
  const output = join(directory, "deleted.mp4");
  await writeFile(output, "video fixture");
  db.insert(schema.compositions).values([
    { id: "deleted", projectId: "project", status: "done", outputPath: output },
    { id: "retained", projectId: "project", status: "done", outputPath: join(directory, "retained.mp4"), thumbnailPath: join(directory, "retained.jpg") },
  ]).run();
  state.poster.mockImplementationOnce(async () => {
    db.delete(schema.compositions).where(eq(schema.compositions.id, "deleted")).run();
    return output + ".thumb.jpg";
  });

  const response = await GET();
  expect(response.status).toBe(200);
  expect((await response.json()).works.map((work: { id: string }) => work.id)).toEqual(["retained"]);
  expect(state.poster).toHaveBeenCalledOnce();
  expect(db.select().from(schema.projects).all()).toHaveLength(1);
});
