// @vitest-environment node
import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backfillGenerationTaskReleases, TASK_RELEASE_BACKFILL_KEY } from "@/lib/db/backfill-task-release";
import { encryptGenerationValue } from "@/lib/generation-secrets";

let directory: string;
let sqlite: Sqlite.Database;
const now = Date.UTC(2026, 10, 6);
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "clipforge-task-release-backfill-"));
  vi.stubEnv("APP_DATA_DIR", directory);
  sqlite = new Sqlite(":memory:");
  migrate(drizzle(sqlite), { migrationsFolder: join(process.cwd(), "drizzle") });
  sqlite.exec("INSERT INTO projects (id, name) VALUES ('A','A'),('B','B')");
});
afterEach(() => { sqlite.close(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

function historical(id: string, { deleted = false, released = false, provider = "provider", taskId = "paid-task", remoteTaskId = "remote-task", leased = false } = {}) {
  sqlite.prepare(`INSERT INTO generation_runs (id,project_id,client_request_id,request_hash,kind,deleted_at,created_at,updated_at)
    VALUES (?, 'A', ?, 'hash', 'image', ?, 1, 1)`).run(id, id, deleted ? 2 : null);
  const payload = encryptGenerationValue({ request: { provider } });
  const checkpoint = encryptGenerationValue({ taskId, remoteTaskId, submissionState: "unknown" });
  sqlite.prepare(`INSERT INTO generation_items (id,run_id,project_id,kind,status,stage,payload,checkpoint,lease_owner,lease_expires_at,next_run_at,created_at,updated_at)
    VALUES (?,?,'A','image','needs_attention',?,?,?,?,?,1,1,1)`)
    .run(id, id, released ? "released" : "needs_attention", payload, checkpoint, leased ? "active-worker" : null, leased ? now + 1000 : null);
  return { payload, checkpoint };
}
function paid(id: string, projectId = "A", provider = "provider", taskId = "paid-task") {
  sqlite.prepare(`INSERT INTO ai_tasks (id,project_id,provider,model,task_id,status,import_state,result_urls)
    VALUES (?,?,?,'model',?,'unknown','pending','["https://paid.test/result.png"]')`).run(id, projectId, provider, taskId);
}
function marker() { return sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(TASK_RELEASE_BACKFILL_KEY); }

describe("historical paid-task release backfill", () => {
  it.each([{ deleted: true }, { released: true }])("marks only exact released provider identities and preserves paid recovery: %j", (options) => {
    historical("released", options);
    historical("live", { taskId: "live-task", remoteTaskId: "other-live-task" });
    historical("leased", { released: true, taskId: "leased-task", remoteTaskId: "leased-task", leased: true });
    paid("paid"); paid("remote", "A", "provider", "remote-task");
    paid("other-project", "B"); paid("other-provider", "A", "another-provider");
    paid("other-task", "A", "provider", "unrelated-task"); paid("live", "A", "provider", "live-task");
    paid("leased", "A", "provider", "leased-task");
    const before = sqlite.prepare("SELECT * FROM generation_items ORDER BY id").all();
    const report = backfillGenerationTaskReleases(sqlite, now);
    expect(report).toEqual({ skipped: false, scanned: 1, marked: 2, unreadable: 0 });
    expect(sqlite.prepare("SELECT id FROM ai_tasks WHERE generation_released_at IS NOT NULL ORDER BY id").all()).toEqual([{ id: "paid" }, { id: "remote" }]);
    expect(sqlite.prepare("SELECT generation_released_at, status, result_urls, task_id FROM ai_tasks WHERE id='paid'").get())
      .toEqual({ generation_released_at: now / 1000, status: "unknown", result_urls: '["https://paid.test/result.png"]', task_id: "paid-task" });
    expect(sqlite.prepare("SELECT * FROM generation_items ORDER BY id").all()).toEqual(before);
    expect(marker()).toBeTruthy();
    // A successful backfill only reads its settings marker on subsequent startups.
    sqlite.exec("DROP TABLE generation_items");
    expect(backfillGenerationTaskReleases(sqlite, now)).toEqual({ skipped: true, scanned: 0, marked: 0, unreadable: 0 });
  });

  it("keeps unreadable paid work visible and retries after its original envelope is restored", () => {
    const original = historical("released", { released: true });
    sqlite.prepare("UPDATE generation_items SET checkpoint = 'invalid-envelope' WHERE id = 'released'").run();
    paid("paid");
    expect(backfillGenerationTaskReleases(sqlite, now)).toEqual({ skipped: false, scanned: 1, marked: 0, unreadable: 1 });
    expect(sqlite.prepare("SELECT generation_released_at FROM ai_tasks WHERE id='paid'").get()).toEqual({ generation_released_at: null });
    expect(marker()).toBeUndefined();
    sqlite.prepare("UPDATE generation_items SET checkpoint = ? WHERE id='released'").run(original.checkpoint);
    expect(backfillGenerationTaskReleases(sqlite, now)).toEqual({ skipped: false, scanned: 1, marked: 1, unreadable: 0 });
    expect(marker()).toBeTruthy();
  });

  it("completes readable script history without a provider identity instead of retrying it forever", () => {
    historical("script", { deleted: true });
    sqlite.prepare("UPDATE generation_items SET kind = 'script', payload = ? WHERE id = 'script'")
      .run(encryptGenerationValue({ request: { generationEndpoint: "/api/llm/script" } }));
    paid("unrelated-paid");
    expect(backfillGenerationTaskReleases(sqlite, now)).toEqual({ skipped: false, scanned: 1, marked: 0, unreadable: 0 });
    expect(marker()).toBeTruthy();
    expect(sqlite.prepare("SELECT generation_released_at FROM ai_tasks WHERE id='unrelated-paid'").get())
      .toEqual({ generation_released_at: null });
    expect(backfillGenerationTaskReleases(sqlite, now)).toEqual({ skipped: true, scanned: 0, marked: 0, unreadable: 0 });
  });

  it("does not replace a missing encryption key or mark the backfill complete", () => {
    historical("released", { deleted: true }); paid("paid");
    const key = join(directory, "generation-task.key"); unlinkSync(key);
    expect(backfillGenerationTaskReleases(sqlite, now)).toEqual({ skipped: false, scanned: 1, marked: 0, unreadable: 1 });
    expect(existsSync(key)).toBe(false);
    expect(marker()).toBeUndefined();
  });

  it("finishes a fresh database without creating an encryption key", () => {
    expect(backfillGenerationTaskReleases(sqlite, now)).toEqual({ skipped: false, scanned: 0, marked: 0, unreadable: 0 });
    expect(existsSync(join(directory, "generation-task.key"))).toBe(false);
    expect(marker()).toBeTruthy();
  });
});
