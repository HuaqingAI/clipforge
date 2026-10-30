// @vitest-environment node
import { describe, expect, it } from "vitest";
import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("generation run soft-delete migration", () => {
  it("upgrades an existing 0025 database without changing tasks or assets", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "clipforge-run-delete-migration-"));
    const sqlite = new Sqlite(":memory:");
    try {
      const journal = JSON.parse(readFileSync(path.join(process.cwd(), "drizzle/meta/_journal.json"), "utf8"));
      const oldJournal = { ...journal, entries: journal.entries.filter((entry: { idx: number }) => entry.idx <= 25) };
      mkdirSync(path.join(directory, "meta"));
      writeFileSync(path.join(directory, "meta/_journal.json"), JSON.stringify(oldJournal));
      for (const entry of oldJournal.entries) copyFileSync(path.join(process.cwd(), "drizzle", `${entry.tag}.sql`), path.join(directory, `${entry.tag}.sql`));
      const db = drizzle(sqlite);
      migrate(db, { migrationsFolder: directory });
      sqlite.exec("INSERT INTO projects(id,name) VALUES('A','A'); INSERT INTO generation_runs(id,project_id,client_request_id,request_hash,kind,created_at,updated_at) VALUES('run','A','same-paid-request','hash','image',1,1); INSERT INTO generation_items(id,run_id,project_id,kind,payload,next_run_at,created_at,updated_at,status,checkpoint) VALUES('item','run','A','image','encrypted-request',1,1,1,'completed','encrypted-checkpoint'); INSERT INTO assets(id,project_id,shot_id,type,file_path,status,selected) VALUES('asset','A',1,'ai_generated','/api/files/A/keep.png','done',1)");
      const oldRun = sqlite.prepare("SELECT * FROM generation_runs").get() as Record<string, unknown>;
      const oldItems = sqlite.prepare("SELECT * FROM generation_items").all();
      const oldAssets = sqlite.prepare("SELECT * FROM assets").all();
      migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      expect(sqlite.prepare("SELECT * FROM generation_runs").get()).toEqual({ ...oldRun, deleted_at: null });
      expect(sqlite.prepare("SELECT * FROM generation_items").all()).toEqual(oldItems);
      expect(sqlite.prepare("SELECT * FROM assets").all()).toEqual(oldAssets);
      sqlite.prepare("UPDATE generation_runs SET deleted_at = 2 WHERE id = 'run'").run();
      expect(() => sqlite.exec("INSERT INTO generation_runs(id,project_id,client_request_id,request_hash,kind,created_at,updated_at) VALUES('duplicate','A','same-paid-request','hash','image',1,1)")).toThrow(/UNIQUE/);
      migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      expect(sqlite.prepare("SELECT deleted_at FROM generation_runs").get()).toEqual({ deleted_at: 2 });
    } finally { sqlite.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
