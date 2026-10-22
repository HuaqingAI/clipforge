import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { KlingError } from "./errors";
import { canDeleteKlingFilm } from "./film-repository";
import { klingFilmRuns, klingFilmShots } from "./film-schema";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Remove only the local orchestration record; shot jobs, media and completed works stay intact. */
export function deleteKlingFilm(id: string): { deleted: true; runId: string } {
  if (!SAFE_ID.test(id)) throw new KlingError("KLING_INPUT_INVALID", "整片任务编号无效。", 400);
  try {
    getDb().transaction((tx) => {
      const run = tx.select().from(klingFilmRuns).where(eq(klingFilmRuns.id, id)).get();
      if (!run) throw new KlingError("KLING_FILM_NOT_FOUND", "整片任务不存在", 404);
      if (!["draft", "completed", "cancelled"].includes(run.status)) {
        throw new KlingError("KLING_FILM_DELETE_CONFLICT", "整片任务尚未结束，请先停止整片编排再删除记录。", 409);
      }
      if (!canDeleteKlingFilm(run)) throw new KlingError("KLING_FILM_DELETE_CONFLICT", "整片任务仍在处理，请稍后刷新再删除记录。", 409);
      tx.delete(klingFilmShots).where(eq(klingFilmShots.runId, id)).run();
      tx.delete(klingFilmRuns).where(eq(klingFilmRuns.id, id)).run();
    }, { behavior: "immediate" });
  } catch (error) {
    if (error instanceof KlingError) throw error;
    throw new KlingError("KLING_FILM_DELETE_FAILED", "删除整片记录失败，原记录已保留，请稍后重试。", 500);
  }
  return { deleted: true, runId: id };
}
