// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { acquireWorkspaceLock } from "@/lib/workspace-lock";
import { recoverInterruptedCompositions } from "@/lib/startup-recovery";
import { DEFAULT_TRANSCRIPT_EDIT_PLAN } from "@/lib/transcript-editor";

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let directory: string;
let release: (() => void) | undefined;
const diagnostics = vi.hoisted(() => ({ save: vi.fn(async () => {}) }));
vi.mock("@/lib/db", () => ({ getDb: () => db, dbInitError: null, dbMigrationError: null }));
vi.mock("@/lib/composition-error", () => ({ saveCompositionError: diagnostics.save }));

beforeEach(() => {
  vi.clearAllMocks();
  directory = mkdtempSync(join(tmpdir(), "clipforge-startup-recovery-"));
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  db.insert(schema.projects).values([
    { id: "interrupted-project", name: "Interrupted", status: "composing" },
    { id: "durable-project", name: "Durable", status: "composing" },
  ]).run();
});
afterEach(() => { release?.(); release = undefined; sqlite.close(); rmSync(directory, { recursive: true, force: true }); });

describe("workspace startup recovery", () => {
  it("does not recover without exclusive service ownership", async () => {
    db.insert(schema.compositions).values({ id: "ordinary", projectId: "interrupted-project", status: "composing" }).run();
    expect(await recoverInterruptedCompositions()).toBe(0);
    expect(db.select().from(schema.compositions).get()?.status).toBe("composing");
  });

  it("immediately recovers recent ordinary renders and keeps durable edits and paid tasks", async () => {
    release = acquireWorkspaceLock(directory);
    db.insert(schema.compositions).values([
      { id: "ordinary", projectId: "interrupted-project", status: "composing" },
      { id: "pending", projectId: "interrupted-project", status: "pending" },
      { id: "completed", projectId: "interrupted-project", status: "done" },
      { id: "durable", projectId: "durable-project", status: "composing" },
    ]).run();
    db.insert(schema.mediaSources).values({ id: "source", projectId: "durable-project", originalName: "video.mp4", filePath: "/tmp/video.mp4", mimeType: "video/mp4", sizeBytes: 100 }).run();
    db.insert(schema.mediaEdits).values({ id: "edit", projectId: "durable-project", sourceId: "source", revision: 1, operationId: "edit-op", baseRevision: 0, actor: "human", plan: DEFAULT_TRANSCRIPT_EDIT_PLAN, keepRanges: [], compositionId: "durable", status: "rendering" }).run();
    db.insert(schema.aiTasks).values({ id: "paid", projectId: "interrupted-project", taskId: "remote-identity", provider: "kling-cli", model: "kling", mediaType: "video", status: "processing" }).run();
    expect(await recoverInterruptedCompositions()).toBe(2);
    expect(db.select().from(schema.compositions).all().map(row => [row.id, row.status])).toEqual([
      ["ordinary", "failed"], ["pending", "failed"], ["completed", "done"], ["durable", "composing"],
    ]);
    expect(db.select().from(schema.projects).where(eq(schema.projects.id, "interrupted-project")).get()?.status).toBe("video");
    expect(db.select().from(schema.projects).where(eq(schema.projects.id, "durable-project")).get()?.status).toBe("composing");
    expect(db.select().from(schema.mediaEdits).get()?.status).toBe("rendering");
    expect(db.select().from(schema.aiTasks).get()).toMatchObject({ taskId: "remote-identity", status: "processing" });
    expect(diagnostics.save).toHaveBeenCalledTimes(2);
  });

  it("does not sweep jobs started after this lease's startup when modules reload", async () => {
    release = acquireWorkspaceLock(directory);
    expect(await recoverInterruptedCompositions()).toBe(0);
    db.insert(schema.compositions).values({ id: "current", projectId: "interrupted-project", status: "composing" }).run();
    expect(await recoverInterruptedCompositions()).toBe(0);
    expect(db.select().from(schema.compositions).get()?.status).toBe("composing");
  });

  it("clears the project spinner when the compatibility sweep already failed its old render", async () => {
    release = acquireWorkspaceLock(directory);
    db.insert(schema.compositions).values({ id: "old", projectId: "interrupted-project", status: "failed" }).run();
    expect(await recoverInterruptedCompositions()).toBe(0);
    expect(db.select().from(schema.projects).where(eq(schema.projects.id, "interrupted-project")).get()?.status).toBe("video");
  });
});
