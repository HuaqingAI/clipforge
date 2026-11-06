// Source-checkout maintenance tool. Dry-run by default; --apply first backs up
// SQLite (including its WAL) and the encryption key. Requires Node.js 24.
import Database from "better-sqlite3";
import { createRequire, registerHooks } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

async function sourceHelpers() {
  // Native TypeScript stripping handles these pure fs/crypto helpers; this hook
  // resolves the same @/ alias and extensionless imports as the app's bundler.
  const hooks = registerHooks({ resolve(specifier, context, next) {
    let target;
    if (specifier.startsWith("@/")) target = join(root, "src", specifier.slice(2));
    else if (specifier.startsWith(".") && context.parentURL?.startsWith(pathToFileURL(join(root, "src") + sep).href)) {
      target = fileURLToPath(new URL(specifier, context.parentURL));
    }
    if (target) {
      if (existsSync(`${target}.ts`)) target += ".ts";
      else if (existsSync(join(target, "index.ts"))) target = join(target, "index.ts");
      return next(pathToFileURL(target).href, context);
    }
    return next(specifier, context);
  } });
  try {
    return {
      ...await import("../src/lib/generation-checkpoint-media.ts"),
      ...await import("../src/lib/generation-secrets.ts"),
    };
  } finally { hooks.deregister(); }
}

function localFile(dataDir, projectId, url) {
  if (!/^[a-zA-Z0-9-]+$/.test(projectId ?? "") || typeof url !== "string" || !url.startsWith(`/api/files/${projectId}/`)) return false;
  const directory = resolve(dataDir, "uploads", projectId) + sep;
  const target = resolve(dataDir, "uploads", url.slice("/api/files/".length));
  try { return target.startsWith(directory) && statSync(target).isFile(); } catch { return false; }
}

export async function compactTaskStorage({ dataDir = join(root, "data"), apply = false, vacuum = false } = {}) {
  dataDir = resolve(dataDir);
  process.env.APP_DATA_DIR = dataDir;
  const filename = join(dataDir, "sqlite.db");
  const db = new Database(filename, { readonly: !apply, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  const report = { apply, backup: null, releasedTasks: 0, compactedCheckpoints: 0, compactedAiTasks: 0,
    checkpointBytesSaved: 0, resultBytesSaved: 0, unreadableCheckpoints: 0, missingFiles: 0, changedConcurrently: 0 };
  try {
    const keyFile = join(dataDir, "generation-task.key");
    if (db.prepare("SELECT 1 FROM generation_items WHERE checkpoint IS NOT NULL LIMIT 1").get()
      && (!existsSync(keyFile) || readFileSync(keyFile).length !== 32)) throw new Error("Restore the original generation-task.key before compacting task storage.");
    if (apply) {
      const backup = join(dataDir, "backups", `task-storage-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`);
      mkdirSync(backup, { recursive: true });
      await db.backup(join(backup, "sqlite.db"));
      if (existsSync(keyFile)) copyFileSync(keyFile, join(backup, "generation-task.key"));
      report.backup = backup;
      const { drizzle } = require("drizzle-orm/better-sqlite3");
      const { migrate } = require("drizzle-orm/better-sqlite3/migrator");
      migrate(drizzle(db), { migrationsFolder: join(root, "drizzle") });
    }
    const { decryptGenerationValue, encryptGenerationValue, compactCompletedGenerationCheckpoint, persistGenerationMediaUrls } = await sourceHelpers();
    const ids = db.prepare(`SELECT i.id FROM generation_items i JOIN generation_runs r ON r.id = i.run_id
      WHERE i.lease_owner IS NULL AND (i.status = 'completed' OR i.stage = 'released' OR r.deleted_at IS NOT NULL)`).all();
    const hasReleaseColumn = db.prepare("PRAGMA table_info(ai_tasks)").all().some((column) => column.name === "generation_released_at");
    for (const { id } of ids) {
      const row = db.prepare(`SELECT i.*, r.deleted_at AS run_deleted_at FROM generation_items i
        JOIN generation_runs r ON r.id = i.run_id WHERE i.id = ? AND i.lease_owner IS NULL`).get(id);
      if (!row) continue;
      let checkpoint;
      try { checkpoint = row.checkpoint ? decryptGenerationValue(row.checkpoint) : {}; }
      catch { report.unreadableCheckpoints++; continue; }
      if (row.stage === "released" || row.run_deleted_at !== null) {
        try {
          const payload = decryptGenerationValue(row.payload);
          const provider = payload.request?.provider;
          const taskIds = [...new Set([checkpoint.taskId, checkpoint.remoteTaskId].filter((value) => typeof value === "string" && value))];
          for (const taskId of taskIds) {
            if (typeof provider !== "string") continue;
            const where = hasReleaseColumn ? " AND generation_released_at IS NULL" : "";
            const matches = db.prepare(`SELECT id FROM ai_tasks WHERE project_id = ? AND provider = ? AND task_id = ?${where}`).all(row.project_id, provider, taskId);
            if (apply) db.prepare(`UPDATE ai_tasks SET generation_released_at = ? WHERE project_id = ? AND provider = ? AND task_id = ? AND generation_released_at IS NULL`)
              .run(Math.floor(Date.now() / 1000), row.project_id, provider, taskId);
            report.releasedTasks += matches.length;
          }
        } catch { report.unreadableCheckpoints++; }
      }
      if (row.status !== "completed" || !row.checkpoint) continue;
      const result = row.result ? JSON.parse(row.result) : {};
      const compacted = compactCompletedGenerationCheckpoint(row.project_id, checkpoint, result);
      if (JSON.stringify(compacted) === JSON.stringify(checkpoint)) {
        if (/data:image\//i.test(JSON.stringify(checkpoint))) report.missingFiles++;
        continue;
      }
      const encrypted = encryptGenerationValue(compacted);
      if (encrypted.length >= row.checkpoint.length) continue;
      const changed = !apply || db.prepare(`UPDATE generation_items SET checkpoint = ?
        WHERE id = ? AND status = 'completed' AND lease_owner IS NULL AND updated_at = ? AND checkpoint = ?`)
        .run(encrypted, id, row.updated_at, row.checkpoint).changes;
      if (!changed) { report.changedConcurrently++; continue; }
      report.compactedCheckpoints++;
      report.checkpointBytesSaved += row.checkpoint.length - encrypted.length;
    }
    // Import-complete rows can reuse their confirmed asset. Multi-image results
    // keep every paid output: externalize each one instead of discarding extras.
    const paidIds = db.prepare("SELECT id FROM ai_tasks WHERE status = 'completed'").all();
    for (const { id } of paidIds) {
      const row = db.prepare("SELECT id, project_id, result_urls, asset_id, import_state, updated_at FROM ai_tasks WHERE id = ? AND status = 'completed'").get(id);
      if (!row?.project_id || !row.result_urls?.includes("data:image/")) continue;
      const urls = JSON.parse(row.result_urls);
      if (!Array.isArray(urls)) continue;
      const asset = row.import_state === "imported" && row.asset_id
        ? db.prepare("SELECT file_path FROM assets WHERE id = ? AND project_id = ? AND status = 'done'").get(row.asset_id, row.project_id) : null;
      let persisted;
      if (urls.length === 1 && localFile(dataDir, row.project_id, asset?.file_path)) persisted = [asset.file_path];
      else if (apply) {
        try { persisted = persistGenerationMediaUrls(row.project_id, urls); }
        catch { report.missingFiles++; continue; }
      } else continue; // Dry-run never creates raw media files.
      const json = JSON.stringify(persisted);
      if (json.length >= row.result_urls.length) continue;
      const changed = !apply || db.prepare(`UPDATE ai_tasks SET result_urls = ?
        WHERE id = ? AND status = 'completed' AND updated_at IS ? AND result_urls = ?`)
        .run(json, id, row.updated_at, row.result_urls).changes;
      if (!changed) { report.changedConcurrently++; continue; }
      report.compactedAiTasks++;
      report.resultBytesSaved += row.result_urls.length - json.length;
    }
    if (apply && vacuum) db.exec("VACUUM");
    return report;
  } finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { apply: { type: "boolean" }, vacuum: { type: "boolean" }, "data-dir": { type: "string" }, help: { type: "boolean" } } });
  if (values.help) console.log("Node.js 24: node scripts/compact-task-storage.mjs [--data-dir <directory>] [--apply] [--vacuum]\nDry-run by default. --apply creates a SQLite + key backup first. Stop the local service before --vacuum.");
  else compactTaskStorage({ dataDir: values["data-dir"], apply: values.apply, vacuum: values.vacuum })
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
