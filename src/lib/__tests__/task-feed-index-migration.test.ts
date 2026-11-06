// @vitest-environment node
import { describe, expect, it } from "vitest";
import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const migrationsFolder = path.join(process.cwd(), "drizzle");

function plan(sqlite: Sqlite.Database, sql: string): string {
  return (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
    .map((row) => row.detail).join("\n");
}

describe("task-feed index migration", () => {
  it("upgrades existing data without changing paid-task identity, checkpoints, or results", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "clipforge-task-feed-indexes-"));
    const sqlite = new Sqlite(":memory:");
    try {
      const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8"));
      const oldJournal = { ...journal, entries: journal.entries.filter((entry: { idx: number }) => entry.idx <= 26) };
      mkdirSync(path.join(directory, "meta"));
      writeFileSync(path.join(directory, "meta/_journal.json"), JSON.stringify(oldJournal));
      for (const entry of oldJournal.entries) copyFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), path.join(directory, `${entry.tag}.sql`));
      const db = drizzle(sqlite);
      migrate(db, { migrationsFolder: directory });
      sqlite.exec(`
        INSERT INTO projects(id,name) VALUES('project','Project');
        INSERT INTO generation_runs(id,project_id,client_request_id,request_hash,kind,created_at,updated_at)
          VALUES('run','project','paid-request','same-request-hash','image',1,2);
        INSERT INTO generation_items(id,run_id,project_id,kind,payload,checkpoint,result,status,next_run_at,created_at,updated_at)
          VALUES('item','run','project','image','encrypted-input','encrypted-recovery','{"assetId":"asset"}','waiting',1,1,2);
        INSERT INTO ai_tasks(id,project_id,provider,model,task_id,status,result_urls)
          VALUES('paid','project','provider','model','cloud-task','completed','["https://provider/result.png"]');
      `);
      const records = ["generation_runs", "generation_items", "ai_tasks"].map((table) => sqlite.prepare(`SELECT * FROM ${table}`).all());

      migrate(db, { migrationsFolder });
      migrate(db, { migrationsFolder });

      expect(["generation_runs", "generation_items", "ai_tasks"].map((table) => sqlite.prepare(`SELECT * FROM ${table}`).all()))
        .toEqual([records[0], records[1], records[2].map((row) => ({ ...row as Record<string, unknown>, generation_released_at: null }))]);
      sqlite.prepare("UPDATE ai_tasks SET generation_released_at = ? WHERE id = ?").run(1793923200, "paid");
      migrate(db, { migrationsFolder });
      expect(sqlite.prepare("SELECT generation_released_at FROM ai_tasks WHERE id = 'paid'").get())
        .toEqual({ generation_released_at: 1793923200 });
      expect(sqlite.prepare("PRAGMA index_info(generation_items_task_summary)").all().map((row) => (row as { name: string }).name))
        .toEqual(["run_id", "created_at", "id", "status", "stage", "updated_at"]);
      expect(sqlite.prepare("PRAGMA index_info(ai_tasks_status_import)").all().map((row) => (row as { name: string }).name))
        .toEqual(["status", "import_state"]);
      expect(() => sqlite.exec("INSERT INTO generation_runs(id,project_id,client_request_id,request_hash,kind,created_at,updated_at) VALUES('duplicate','project','paid-request','hash','image',1,2)"))
        .toThrow(/UNIQUE/);
    } finally {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("covers generation summaries and stages, and searches paid-task statuses without a table scan", () => {
    const sqlite = new Sqlite(":memory:");
    try {
      migrate(drizzle(sqlite), { migrationsFolder });
      const summaryPlan = plan(sqlite, `SELECT generation_items.run_id, count(*), sum(status = 'completed'), max(generation_items.updated_at)
        FROM generation_items INNER JOIN generation_runs ON generation_items.run_id = generation_runs.id
        WHERE generation_runs.deleted_at IS NULL GROUP BY generation_items.run_id`);
      const stagePlan = plan(sqlite, `SELECT stage FROM generation_items
        WHERE run_id = 'run-a' AND status IN ('running', 'waiting', 'importing')
        ORDER BY created_at, id LIMIT 1`);
      for (const queryPlan of [summaryPlan, stagePlan]) {
        expect(queryPlan).toContain("USING COVERING INDEX generation_items_task_summary");
        expect(queryPlan).not.toMatch(/SCAN generation_items$|TEMP B-TREE/m);
      }
      const paidPlan = plan(sqlite, `SELECT id, project_id, provider, model, media_type, status, task_id, created_at
        FROM ai_tasks WHERE provider != 'kling-cli' AND generation_released_at IS NULL AND
          (status IN ('submitted', 'processing', 'unknown') OR (status = 'completed' AND import_state != 'imported'))`);
      expect(paidPlan).toContain("MULTI-INDEX OR");
      expect(paidPlan).toContain("SEARCH ai_tasks USING INDEX ai_tasks_status_import");
      expect(paidPlan).not.toContain("SCAN ai_tasks");
    } finally {
      sqlite.close();
    }
  });
});
