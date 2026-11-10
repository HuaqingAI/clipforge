import { and, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import { dbInitError, dbMigrationError, getDb } from "@/lib/db";
import { compositions, mediaEdits, projects } from "@/lib/db/schema";
import { saveCompositionError } from "@/lib/composition-error";
import { workspaceLeaseId } from "@/lib/workspace-lock";

const shared = globalThis as typeof globalThis & { clipforgeRecoveredLease?: string };

/** The service lock proves ordinary in-memory renders belong to a stopped process. */
export async function recoverInterruptedCompositions(): Promise<number> {
  const lease = workspaceLeaseId();
  if (!lease || shared.clipforgeRecoveredLease === lease || dbInitError || dbMigrationError) return 0;
  const db = getDb();
  const recovered = db.transaction((tx) => {
    const durable = tx.select({ id: mediaEdits.compositionId }).from(mediaEdits).where(and(
      inArray(mediaEdits.status, ["queued", "rendering"]), isNotNull(mediaEdits.compositionId),
    ));
    const rows = tx.select({ id: compositions.id, projectId: compositions.projectId }).from(compositions).where(and(
      inArray(compositions.status, ["pending", "composing"]), notInArray(compositions.id, durable),
    )).all();
    if (rows.length) {
      tx.update(compositions).set({ status: "failed" }).where(inArray(compositions.id, rows.map(row => row.id))).run();
    }
    // Also clear projects whose old composition was already handled by the DB's
    // compatibility sweep. A durable queued/rendering edit still has an active row.
    const activeProjects = tx.select({ id: compositions.projectId }).from(compositions).where(
      inArray(compositions.status, ["pending", "composing"]),
    );
    tx.update(projects).set({ status: "video", updatedAt: new Date() }).where(and(
      eq(projects.status, "composing"), notInArray(projects.id, activeProjects),
    )).run();
    return rows;
  });
  shared.clipforgeRecoveredLease = lease;
  await Promise.all(recovered.map(row => saveCompositionError(row.projectId, row.id,
    new Error("服务已重启，上次本地合成已中断，请重新合成 / The service restarted; please retry the interrupted render"),
  ).catch(error => console.warn("保存中断合成诊断失败:", error))));
  return recovered.length;
}
