import type Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decryptGenerationValue } from "@/lib/generation-secrets";
import { getDataDir } from "@/lib/paths";

export const TASK_RELEASE_BACKFILL_KEY = "task_feed_release_backfill_v1";

interface HistoricalRelease {
  project_id: string;
  payload: string;
  checkpoint: string | null;
}

/**
 * Old releases lived only inside encrypted execution envelopes. Materialize
 * those exact identities once so the feed never has to decrypt history.
 * Unreadable envelopes stay visible, and leave the backfill retryable.
 */
export function backfillGenerationTaskReleases(sqlite: Database.Database, now = Date.now()) {
  return sqlite.transaction(() => {
    if (sqlite.prepare("SELECT 1 FROM settings WHERE key = ?").get(TASK_RELEASE_BACKFILL_KEY)) {
      return { skipped: true, scanned: 0, marked: 0, unreadable: 0 };
    }
    const report = { skipped: false, scanned: 0, marked: 0, unreadable: 0 };
    const ids = sqlite.prepare(`SELECT i.id FROM generation_items AS i
      INNER JOIN generation_runs AS r ON r.id = i.run_id
      WHERE (i.stage = 'released' OR r.deleted_at IS NOT NULL)
        AND i.lease_owner IS NULL AND i.lease_expires_at IS NULL
        AND i.project_id = r.project_id`).all() as Array<{ id: string }>;
    if (ids.length) {
      // Decryption must never generate a replacement key for an existing database.
      const key = join(getDataDir(), "generation-task.key");
      if (!existsSync(key) || readFileSync(key).length !== 32) {
        return { ...report, scanned: ids.length, unreadable: ids.length };
      }
    }
    const item = sqlite.prepare("SELECT project_id, payload, checkpoint FROM generation_items WHERE id = ?");
    const release = sqlite.prepare(`UPDATE ai_tasks SET generation_released_at = ?
      WHERE project_id = ? AND provider = ? AND task_id = ? AND generation_released_at IS NULL`);
    const timestamp = Math.floor(now / 1000);
    for (const { id } of ids) {
      report.scanned++;
      const row = item.get(id) as HistoricalRelease;
      try {
        const payload = decryptGenerationValue<{ request?: { provider?: unknown } }>(row.payload);
        const checkpoint = row.checkpoint ? decryptGenerationValue<Record<string, unknown>>(row.checkpoint) : {};
        const provider = payload?.request?.provider;
        // Script/planner envelopes legitimately have no billable-provider identity.
        // Their readable history cannot hide a paid row and needs no retry.
        if (typeof provider !== "string" || !provider) continue;
        const taskIds = [...new Set([checkpoint.taskId, checkpoint.remoteTaskId]
          .filter((taskId): taskId is string => typeof taskId === "string" && taskId.length > 0))];
        for (const taskId of taskIds) {
          report.marked += release.run(timestamp, row.project_id, provider, taskId).changes;
        }
      } catch {
        report.unreadable++;
      }
    }
    if (!report.unreadable) {
      sqlite.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
        .run(TASK_RELEASE_BACKFILL_KEY, JSON.stringify({ completedAt: now }), timestamp);
    }
    return report;
  }).immediate();
}
