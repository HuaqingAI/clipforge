/**
 * Persistence helpers for billable AI generation tasks (ai_tasks table).
 *
 * Purpose (issue #16): the provider task ID must hit disk the moment the cloud
 * acknowledges a paid task — before any polling — so a poll timeout, crash, or
 * restart can never lose a task the user has already been billed for.
 *
 * All writes are best-effort: a DB hiccup must never break the generation flow
 * itself (the API response still carries the task ID as a fallback).
 */

import { getDb } from "@/lib/db";
import { aiTasks } from "@/lib/db/schema";
import { and, eq, inArray, isNotNull, ne, or } from "drizzle-orm";
import { generationItems, generationRuns } from "@/lib/generation-schema";
import { decryptGenerationValue } from "@/lib/generation-secrets";
import { sanitizeGenerationControlSummary, type GenerationControlSummary } from "@/lib/video-repair-plan";

export type AiTaskStatus = "submitted" | "processing" | "completed" | "failed" | "unknown";

/** Statuses that still need attention — shown in the recovery UI, resumable after restart */
export const ACTIVE_AI_TASK_STATUSES: AiTaskStatus[] = ["submitted", "processing", "unknown"];

export interface RecordAiTaskInput {
  projectId?: string;
  shotId?: number;
  provider: string;
  model: string;
  mediaType?: "image" | "video";
  mode?: string;
  prompt?: string;
  taskId: string;
  controlPlan?: GenerationControlSummary;
}

/** Insert a row right after task submission; returns the row id (null if the DB write failed) */
export async function recordAiTask(input: RecordAiTaskInput): Promise<string | null> {
  try {
    const db = getDb();
    return db.transaction((tx) => {
      const existing = tx.select({ id: aiTasks.id }).from(aiTasks).where(and(eq(aiTasks.provider, input.provider), eq(aiTasks.taskId, input.taskId))).get();
      if (existing) return existing.id;
      const row = tx.insert(aiTasks).values({
        projectId: input.projectId ?? null,
        shotId: input.shotId ?? null,
        provider: input.provider,
        model: input.model,
        mediaType: input.mediaType ?? "video",
        mode: input.mode ?? null,
        prompt: input.prompt ?? null,
        taskId: input.taskId,
        controlPlan: sanitizeGenerationControlSummary(input.controlPlan),
        status: "submitted",
      }).returning({ id: aiTasks.id }).get();
      return row?.id ?? null;
    }, { behavior: "immediate" });
  } catch (error) {
    console.error("ai_tasks 落库失败（任务 ID 仍会随响应返回）:", error);
    return null;
  }
}

/** Update status/result of a task row (matched by row id) */
export async function updateAiTask(
  rowId: string | null,
  patch: { status?: AiTaskStatus; resultUrls?: string[]; error?: string | null; assetId?: string; importState?: "pending" | "imported" | "failed" }
): Promise<void> {
  if (!rowId) return;
  try {
    const db = getDb();
    await db
      .update(aiTasks)
      .set({
        ...(patch.status && { status: patch.status }),
        ...(patch.resultUrls && { resultUrls: patch.resultUrls }),
        ...(patch.error !== undefined && { error: patch.error }),
        ...(patch.assetId !== undefined && { assetId: patch.assetId }),
        ...(patch.importState !== undefined && { importState: patch.importState }),
        updatedAt: new Date(),
      })
      .where(eq(aiTasks.id, rowId));
  } catch (error) {
    console.error("ai_tasks 更新失败:", error);
  }
}

/** Update status/result by provider task ID (used by the standalone status/resume endpoint) */
export async function updateAiTaskByProviderTaskId(
  provider: string,
  taskId: string,
  patch: { status?: AiTaskStatus; resultUrls?: string[]; error?: string | null; assetId?: string; importState?: "pending" | "imported" | "failed" }
): Promise<void> {
  try {
    const db = getDb();
    await db
      .update(aiTasks)
      .set({
        ...(patch.status && { status: patch.status }),
        ...(patch.resultUrls && { resultUrls: patch.resultUrls }),
        ...(patch.error !== undefined && { error: patch.error }),
        ...(patch.assetId !== undefined && { assetId: patch.assetId }),
        ...(patch.importState !== undefined && { importState: patch.importState }),
        updatedAt: new Date(),
      })
      .where(and(eq(aiTasks.provider, provider), eq(aiTasks.taskId, taskId)));
  } catch (error) {
    console.error("ai_tasks 更新失败:", error);
  }
}

/** List a project's tasks, optionally only the ones still needing attention */
export async function listAiTasks(projectId: string, activeOnly: boolean) {
  const db = getDb();
  const where = activeOnly
    ? and(eq(aiTasks.projectId, projectId), or(inArray(aiTasks.status, ACTIVE_AI_TASK_STATUSES), and(eq(aiTasks.status, "completed"), ne(aiTasks.importState, "imported"))))
    : eq(aiTasks.projectId, projectId);
  const rows = db.select().from(aiTasks).where(where).all();
  return activeOnly ? withoutReleasedGenerationTasks(rows) : rows;
}

/** All still-active paid tasks across every project — the global task center's "money at risk" view */
export async function listActiveAiTasksAllProjects() {
  const db = getDb();
  const rows = db.select().from(aiTasks).where(or(inArray(aiTasks.status, ACTIVE_AI_TASK_STATUSES), and(eq(aiTasks.status, "completed"), ne(aiTasks.importState, "imported")))).all();
  return withoutReleasedGenerationTasks(rows);
}

/** A released background task retains its recovery history without occupying its shot. */
function withoutReleasedGenerationTasks(rows: Array<typeof aiTasks.$inferSelect>) {
  const projectIds = [...new Set(rows.flatMap((row) => row.projectId ? [row.projectId] : []))];
  if (!projectIds.length) return rows;
  const released = getDb().select({ projectId: generationItems.projectId, payload: generationItems.payload, checkpoint: generationItems.checkpoint })
    .from(generationItems).innerJoin(generationRuns, eq(generationRuns.id, generationItems.runId))
    .where(and(inArray(generationItems.projectId, projectIds), or(eq(generationItems.stage, "released"), isNotNull(generationRuns.deletedAt)))).all();
  const identities = new Set<string>();
  for (const item of released) {
    try {
      const payload = decryptGenerationValue<{ request?: { provider?: unknown } }>(item.payload);
      const checkpoint = item.checkpoint ? decryptGenerationValue<Record<string, unknown>>(item.checkpoint) : {};
      const provider = payload.request?.provider;
      if (typeof provider !== "string") continue;
      for (const taskId of [checkpoint.taskId, checkpoint.remoteTaskId]) {
        if (typeof taskId === "string" && taskId) identities.add(JSON.stringify([item.projectId, provider, taskId]));
      }
    } catch { /* An unreadable association must not hide a recoverable paid task. */ }
  }
  return rows.filter((row) => !identities.has(JSON.stringify([row.projectId, row.provider, row.taskId])));
}
