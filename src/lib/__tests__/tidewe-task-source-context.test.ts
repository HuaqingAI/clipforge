// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { sanitizeVideoControlSummary, type VideoControlSummary } from "@/lib/video-control-plan";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
import { recordAiTask, listAiTasks } from "@/lib/ai-tasks";

let sqlite: Database.Database;
const sourceContext = { version: 1 as const, sourceScriptId: "original-script", sourceShotKey: "a".repeat(64), sourceRevision: "b".repeat(64) };
const plan: VideoControlSummary = { version: 1, strategy: "keyframe", mode: "image-to-video", referenceRoles: ["keyframe"], referenceCount: 1, audioMode: "none", voiceoverBound: false, warnings: [], sourceContext };
beforeEach(() => {
  sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  state.db = db;
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  db.insert(schema.projects).values({ id: "tidewe-project", name: "TIDEWE" }).run();
});
afterEach(() => { sqlite.close(); state.db = null; });

describe("paid task source context survives recovery", () => {
  it("restores the original script and shot fingerprints from the existing task JSON column", async () => {
    await recordAiTask({ projectId: "tidewe-project", shotId: 1, provider: "fixture", model: "model", taskId: "paid-task", controlPlan: plan });
    const rows = await listAiTasks("tidewe-project", true);
    expect(rows).toHaveLength(1);
    expect(sanitizeVideoControlSummary(rows[0].controlPlan)?.sourceContext).toEqual(sourceContext);
  });
  it("does not turn legacy or malformed metadata into verified source provenance", () => {
    expect(sanitizeVideoControlSummary({ ...plan, sourceContext: undefined })?.sourceContext).toBeUndefined();
    expect(sanitizeVideoControlSummary({ ...plan, sourceContext: { ...sourceContext, sourceShotKey: "unverified" } })?.sourceContext).toBeUndefined();
    expect(sanitizeVideoControlSummary({ ...plan, sourceContext: { ...sourceContext, version: 2 } })?.sourceContext).toBeUndefined();
  });
});
