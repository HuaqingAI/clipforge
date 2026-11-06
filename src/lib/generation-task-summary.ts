import { desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { generationItems, generationRuns } from "@/lib/generation-schema";

export interface GenerationTaskSummary {
  id: string;
  projectId: string;
  kind: string;
  status: string;
  done: number;
  total: number;
  failed: number;
  stage: string | null;
  updatedAt: string;
}

/**
 * The global task center needs counts, not execution envelopes or result DTOs.
 * Keep this read separate from detail/recovery reads, which reconcile local jobs
 * and may need large encrypted checkpoints inside a write transaction.
 */
export function listGenerationTaskSummaries(now = Date.now()): GenerationTaskSummary[] {
  const db = getDb();
  const counts = db.select({
    runId: generationItems.runId,
    total: sql<number>`count(*)`.as("total"),
    done: sql<number>`sum(case when ${generationItems.status} = 'completed' then 1 else 0 end)`.as("done"),
    running: sql<number>`sum(case when ${generationItems.status} in ('running', 'importing') then 1 else 0 end)`.as("running"),
    queued: sql<number>`sum(case when ${generationItems.status} = 'queued' then 1 else 0 end)`.as("queued"),
    waiting: sql<number>`sum(case when ${generationItems.status} = 'waiting' then 1 else 0 end)`.as("waiting"),
    attention: sql<number>`sum(case when ${generationItems.status} = 'needs_attention' then 1 else 0 end)`.as("attention"),
    failed: sql<number>`sum(case when ${generationItems.status} = 'failed' then 1 else 0 end)`.as("failed"),
    cancelled: sql<number>`sum(case when ${generationItems.status} = 'cancelled' then 1 else 0 end)`.as("cancelled"),
    updatedAt: sql<number>`max(${generationItems.updatedAt})`.as("latest_item_update"),
  }).from(generationItems)
    .innerJoin(generationRuns, eq(generationItems.runId, generationRuns.id))
    .where(isNull(generationRuns.deletedAt))
    .groupBy(generationItems.runId).as("item_counts");

  const rows = db.select({
    id: generationRuns.id,
    projectId: generationRuns.projectId,
    kind: generationRuns.kind,
    runUpdatedAt: generationRuns.updatedAt,
    total: counts.total,
    done: counts.done,
    running: counts.running,
    queued: counts.queued,
    waiting: counts.waiting,
    attention: counts.attention,
    failed: counts.failed,
    cancelled: counts.cancelled,
    itemUpdatedAt: counts.updatedAt,
    stage: sql<string | null>`(
      select first_active.stage from generation_items as first_active
      where first_active.run_id = ${generationRuns.id}
        and first_active.status in ('running', 'waiting', 'importing')
      order by first_active.created_at, first_active.id limit 1
    )`,
  }).from(generationRuns).leftJoin(counts, eq(counts.runId, generationRuns.id))
    .where(isNull(generationRuns.deletedAt)).orderBy(desc(generationRuns.createdAt)).all();

  const visible: GenerationTaskSummary[] = [];
  const recent: GenerationTaskSummary[] = [];
  for (const row of rows) {
    const total = row.total ?? 0;
    const done = row.done ?? 0;
    let status = "queued";
    if (total && done === total) status = "completed";
    else if (row.running) status = "running";
    else if (row.queued) status = "queued";
    else if (row.waiting) status = "waiting";
    else if (row.attention) status = "needs_attention";
    else if (row.failed) status = "failed";
    else if (row.cancelled) status = "cancelled";
    const updatedAt = Math.max(row.runUpdatedAt, row.itemUpdatedAt ?? row.runUpdatedAt);
    const summary = { id: row.id, projectId: row.projectId, kind: row.kind, status,
      total, done, failed: (row.failed ?? 0) + (row.attention ?? 0), stage: row.stage,
      updatedAt: new Date(updatedAt).toISOString() };
    if (status === "completed") {
      if (updatedAt > now - 24 * 3600 * 1000) recent.push(summary);
    } else if (status !== "cancelled") visible.push(summary);
  }
  return [...visible, ...recent.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8)];
}
