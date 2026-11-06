// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it("backs up and compacts only confirmed imports, backfills exact released associations, and is idempotent", () => {
  const directory = mkdtempSync(join(tmpdir(), "clipforge-storage-maintenance-")); directories.push(directory);
  const key = randomBytes(32); writeFileSync(join(directory, "generation-task.key"), key);
  const encode = (value: unknown) => {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), bytes.toString("base64")].join(".");
  };
  const decode = (value: string) => {
    const [, iv, tag, text] = value.split("."), cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    cipher.setAuthTag(Buffer.from(tag, "base64"));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(text, "base64")), cipher.final()]).toString());
  };
  const db = new Database(join(directory, "sqlite.db"));
  migrate(drizzle(db), { migrationsFolder: join(process.cwd(), "drizzle") });
  db.prepare("INSERT INTO projects (id,name) VALUES ('project-a','A')").run();
  db.prepare("INSERT INTO generation_runs (id,project_id,client_request_id,request_hash,kind,created_at,updated_at,deleted_at) VALUES ('run','project-a','request','hash','image',1,1,2)").run();
  const local = "/api/files/project-a/saved.png";
  mkdirSync(join(directory, "uploads", "project-a"), { recursive: true });
  writeFileSync(join(directory, "uploads", "project-a", "saved.png"), "saved-image");
  const image = `data:image/png;base64,${Buffer.alloc(4096, 1).toString("base64")}`;
  const checkpoint = { taskId: "remote", submissionState: "acknowledged", imageUrls: [image], resultUrls: [image], completedResult: { imageUrls: [local] } };
  const insert = db.prepare("INSERT INTO generation_items (id,run_id,project_id,kind,status,payload,checkpoint,result,next_run_at,created_at,updated_at) VALUES (?,'run','project-a','image',?,?,?,?,1,1,1)");
  insert.run("done", "completed", encode({ request: { provider: "provider-a" } }), encode(checkpoint), JSON.stringify({ imageUrls: [local] }));
  insert.run("missing", "completed", encode({ request: { provider: "provider-a" } }), encode(checkpoint), JSON.stringify({ imageUrls: ["/api/files/project-a/missing.png"] }));
  insert.run("waiting", "waiting", encode({ request: { provider: "provider-a" } }), encode(checkpoint), null);
  const missingBefore = db.prepare("SELECT checkpoint FROM generation_items WHERE id='missing'").get() as { checkpoint: string };
  const waitingBefore = db.prepare("SELECT checkpoint FROM generation_items WHERE id='waiting'").get() as { checkpoint: string };
  db.prepare("INSERT INTO assets (id,project_id,shot_id,type,status,file_path) VALUES ('asset','project-a',1,'ai_generated','done',?)").run(local);
  const paid = db.prepare("INSERT INTO ai_tasks (id,project_id,provider,model,task_id,status,import_state,result_urls,asset_id) VALUES (?,'project-a',?,'model','remote','completed','imported',?,'asset')");
  paid.run("paid", "provider-a", JSON.stringify([image])); paid.run("other-provider", "provider-b", JSON.stringify([local]));
  db.close();
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, ["scripts/compact-task-storage.mjs", "--data-dir", directory, ...args], { cwd: process.cwd(), encoding: "utf8", windowsHide: true });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    return JSON.parse(result.stdout);
  };
  expect(run()).toMatchObject({ apply: false, backup: null, compactedCheckpoints: 1 });
  const report = run("--apply", "--vacuum");
  expect(report).toMatchObject({ compactedCheckpoints: 1, compactedAiTasks: 1, releasedTasks: 1 });
  expect(readFileSync(join(report.backup, "generation-task.key"))).toEqual(key);
  const backup = new Database(join(report.backup, "sqlite.db"), { readonly: true });
  expect((backup.prepare("SELECT checkpoint FROM generation_items WHERE id='done'").get() as { checkpoint: string }).checkpoint.length).toBeGreaterThan(10000);
  backup.close();
  const after = new Database(join(directory, "sqlite.db"), { readonly: true });
  const compacted = decode((after.prepare("SELECT checkpoint FROM generation_items WHERE id='done'").get() as { checkpoint: string }).checkpoint);
  expect(compacted).toMatchObject({ taskId: "remote", submissionState: "acknowledged", completedResult: { imageUrls: [local] } });
  expect(JSON.stringify(compacted)).not.toContain("data:image");
  expect(after.prepare("SELECT checkpoint FROM generation_items WHERE id='missing'").get()).toEqual(missingBefore);
  expect(after.prepare("SELECT checkpoint FROM generation_items WHERE id='waiting'").get()).toEqual(waitingBefore);
  expect(after.prepare("SELECT result_urls FROM ai_tasks WHERE id='paid'").get()).toEqual({ result_urls: JSON.stringify([local]) });
  expect(after.prepare("SELECT generation_released_at FROM ai_tasks WHERE id='other-provider'").get()).toEqual({ generation_released_at: null });
  after.close();
  expect(run("--apply")).toMatchObject({ compactedCheckpoints: 0, compactedAiTasks: 0, releasedTasks: 0 });
});
