import { NextRequest, NextResponse } from "next/server";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { aiTasks, assets, compositions, klingFilmRuns, klingJobs, pipelineRuns, projects, scripts } from "@/lib/db/schema";
import { apiError, errText } from "@/lib/api-error";
import { ACTIVE_AI_TASK_STATUSES } from "@/lib/ai-tasks";
import { klingJobHasUnresolvedWork } from "@/lib/kling/concurrency";
import { lintCreativeProfileShots } from "@/lib/creative-policy-lint";
import {
  checkCreativeProfileContext,
  isPremiumProductCgProfile,
  isTideweOutdoorProfile,
} from "@/lib/creative-profiles";
import { scriptRevision } from "@/lib/asset-context";
import { assertTideweScript } from "@/lib/tidewe/validation";
import { POST as generateScripts } from "@/app/api/llm/script/route";

function scriptView<T extends Parameters<typeof scriptRevision>[0]>(script: T) {
  return { ...script, scriptHash: scriptRevision(script) };
}

// Historical variants remain readable after regeneration or a profile switch. Selection and edits
// are limited to scripts whose frozen creative context matches the current project configuration.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const rows = await getDb()
      .select()
      .from(scripts)
      .where(eq(scripts.projectId, id))
      .orderBy(desc(scripts.createdAt));
    return NextResponse.json(rows.map(scriptView));
  } catch (error) {
    console.error("Failed to fetch scripts:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : errText(req, "Failed to fetch scripts", "Failed to fetch scripts") },
      { status: 500 },
    );
  }
}

/** Delete a single alternative while retaining its generated media and completed works. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError(req, "请求内容必须是有效的 JSON", "Request body must be valid JSON", 400);
  }
  const scriptId = body && typeof body === "object" && !Array.isArray(body) && "scriptId" in body
    && typeof body.scriptId === "string" ? body.scriptId.trim() : "";
  if (!scriptId) return apiError(req, "缺少有效的脚本编号", "A valid script ID is required", 400);

  try {
    const { id } = await params;
    return getDb().transaction((tx) => {
      const project = tx.select().from(projects).where(eq(projects.id, id)).get();
      if (!project) return apiError(req, "项目不存在", "Project not found", 404);
      const target = tx.select().from(scripts).where(and(eq(scripts.id, scriptId), eq(scripts.projectId, id))).get();
      if (!target) return apiError(req, "脚本不存在", "Script not found", 404);

      const runningPipeline = tx.select({ id: pipelineRuns.id }).from(pipelineRuns).where(and(
        eq(pipelineRuns.projectId, id), eq(pipelineRuns.status, "running"),
        or(eq(pipelineRuns.scriptId, scriptId), isNull(pipelineRuns.scriptId)),
      )).get();
      const runningComposition = tx.select({ id: compositions.id }).from(compositions).where(and(
        eq(compositions.projectId, id), inArray(compositions.status, ["pending", "composing"]),
      )).get();
      const generatingAsset = tx.select({ id: assets.id }).from(assets).where(and(
        eq(assets.projectId, id), eq(assets.sourceScriptId, scriptId), inArray(assets.status, ["pending", "generating"]),
      )).get();
      const activeAiTask = tx.select({ id: aiTasks.id }).from(aiTasks).where(and(
        eq(aiTasks.projectId, id), inArray(aiTasks.status, ACTIVE_AI_TASK_STATUSES),
      )).get();
      const unresolvedKlingJob = tx.select().from(klingJobs).where(and(
        eq(klingJobs.projectId, id), eq(klingJobs.scriptId, scriptId),
      )).all().some(klingJobHasUnresolvedWork);
      const unresolvedKlingFilm = tx.select({ status: klingFilmRuns.status }).from(klingFilmRuns).where(and(
        eq(klingFilmRuns.projectId, id), eq(klingFilmRuns.scriptId, scriptId),
      )).all().some((run) => !["draft", "completed", "cancelled"].includes(run.status));
      if (runningPipeline || runningComposition || generatingAsset || activeAiTask || unresolvedKlingJob || unresolvedKlingFilm) {
        return apiError(req, "脚本或项目仍有未完成的生成任务，请先完成或处理任务后再删除", "This script or project has unfinished generation tasks. Complete or resolve them before deleting the script.", 409);
      }

      tx.delete(scripts).where(eq(scripts.id, scriptId)).run();
      if (target.selected) {
        // Selection stays within this generation. An empty batch must never activate old history.
        const replacement = tx.select().from(scripts).where(and(
          eq(scripts.projectId, id), eq(scripts.version, target.version),
        )).orderBy(asc(scripts.createdAt), asc(scripts.id)).all()
          .find((script) => checkCreativeProfileContext(project, script).ok);
        tx.update(scripts).set({ selected: false }).where(eq(scripts.projectId, id)).run();
        if (replacement) tx.update(scripts).set({ selected: true }).where(eq(scripts.id, replacement.id)).run();
      }

      const selected = tx.select().from(scripts).where(and(eq(scripts.projectId, id), eq(scripts.selected, true))).get();
      const remaining = selected ? tx.select().from(scripts).where(and(
        eq(scripts.projectId, id), eq(scripts.version, selected.version),
      )).orderBy(desc(scripts.createdAt), asc(scripts.id)).all() : [];
      return NextResponse.json({ success: true, deletedScriptId: scriptId, selectedScriptId: selected?.id ?? null, scripts: remaining.map(scriptView) });
    }, { behavior: "immediate" });
  } catch (error) {
    console.error("Failed to delete script:", error);
    return apiError(req, "删除脚本失败，请重试", "Failed to delete the script. Please retry.", 500);
  }
}

interface ShotTextPatch {
  shotId: number;
  voiceover?: string;
  description?: string;
  camera?: string;
}

const CAMERA_MAX_LEN = 200;

function contextConflict(context: Exclude<ReturnType<typeof checkCreativeProfileContext>, { ok: true }>) {
  return {
    error: context.code === "CREATIVE_CONFIG_STALE"
      ? "The script was created with an outdated creative configuration. Regenerate a current script before using it."
      : "The script does not match the project's current creative type. Generate a current script before using it.",
    code: context.code,
    currentCreationType: context.projectProfile.creationType,
    scriptCreationType: context.scriptProfile.creationType,
    projectRevision: context.projectRevision,
    scriptRevision: context.scriptRevision,
  };
}

/** PATCH accepts a historical restoration, script selection, or narrowly scoped shot-text edits. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiError(req, "请求内容必须是有效的 JSON", "Request body must be valid JSON", 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return apiError(req, "请求内容必须是对象", "Request body must be an object", 400);
    }
    const payload = body as Record<string, unknown>;

    if ("copyText" in payload) {
      if (typeof payload.scriptId !== "string" || typeof payload.expectedScriptHash !== "string") return apiError(req, "修改全文需要源脚本及其修订", "A source script and expectedScriptHash are required", 400);
      const project = getDb().select().from(projects).where(eq(projects.id, id)).get();
      if (!project) return apiError(req, "项目不存在", "Project not found", 404);
      if (!isTideweOutdoorProfile(project.creativeProfile)) return apiError(req, "当前创作类型不支持此全文协议", "This full-copy editing protocol requires a TIDEWE project", 400);
      return generateScripts(new NextRequest(new URL("/api/llm/script", req.url), {
        method: "POST", headers: { "Content-Type": "application/json", "Accept-Language": req.headers.get("accept-language") ?? "zh" },
        body: JSON.stringify({ projectId: id, requestId: payload.requestId, expectedCreativeConfigRevision: payload.expectedCreativeConfigRevision,
          sourceScriptId: payload.scriptId, expectedScriptHash: payload.expectedScriptHash, copyText: payload.copyText, llmConfig: payload.llmConfig, count: 1 }),
      }));
    }

    if ("restoreScriptId" in payload) {
      const restoreScriptId = typeof payload.restoreScriptId === "string" ? payload.restoreScriptId.trim() : "";
      if (!restoreScriptId || ["selectedScriptId", "scriptId", "shotTexts"].some((key) => key in payload)) {
        return apiError(req, "恢复方案时请仅提供有效的脚本编号", "Provide a valid restoreScriptId without selection or edit fields", 400);
      }
      return getDb().transaction((tx) => {
        const project = tx.select().from(projects).where(eq(projects.id, id)).get();
        if (!project) return apiError(req, "项目不存在", "Project not found", 404);
        const target = tx.select().from(scripts).where(and(eq(scripts.id, restoreScriptId), eq(scripts.projectId, id))).get();
        if (!target) return apiError(req, "脚本不存在", "Script not found", 404);
        const context = checkCreativeProfileContext(project, target);
        if (!context.ok) {
          const conflict = contextConflict(context);
          return NextResponse.json({
            ...conflict,
            error: errText(req, context.code === "CREATIVE_CONFIG_STALE"
              ? "该历史方案的创作配置已过期，暂时无法恢复；请按当前配置重新生成方案。"
              : "该历史方案的创作类型与当前项目不一致，暂时无法恢复。", conflict.error),
          }, { status: 409 });
        }
        if (isTideweOutdoorProfile(context.scriptProfile)) assertTideweScript(target, context.scriptProfile.presenter ?? null);

        // Restoring changes the project's active batch. Any unfinished work in the project
        // must settle first, including work bound to a different historical script.
        const runningPipeline = tx.select({ id: pipelineRuns.id }).from(pipelineRuns).where(and(
          eq(pipelineRuns.projectId, id), eq(pipelineRuns.status, "running"),
        )).get();
        const runningComposition = tx.select({ id: compositions.id }).from(compositions).where(and(
          eq(compositions.projectId, id), inArray(compositions.status, ["pending", "composing"]),
        )).get();
        const generatingAsset = tx.select({ id: assets.id }).from(assets).where(and(
          eq(assets.projectId, id), inArray(assets.status, ["pending", "generating"]),
        )).get();
        const activeAiTask = tx.select({ id: aiTasks.id }).from(aiTasks).where(and(
          eq(aiTasks.projectId, id), inArray(aiTasks.status, ACTIVE_AI_TASK_STATUSES),
        )).get();
        const unresolvedKlingJob = tx.select().from(klingJobs).where(eq(klingJobs.projectId, id)).all().some(klingJobHasUnresolvedWork);
        const unresolvedKlingFilm = tx.select({ status: klingFilmRuns.status }).from(klingFilmRuns)
          .where(eq(klingFilmRuns.projectId, id)).all().some((run) => !["draft", "completed", "cancelled"].includes(run.status));
        if (runningPipeline || runningComposition || generatingAsset || activeAiTask || unresolvedKlingJob || unresolvedKlingFilm) {
          return apiError(req, "项目仍有未完成的生成任务，请先完成或处理任务后再恢复历史方案。", "This project has unfinished generation tasks. Complete or resolve them before restoring a historical script.", 409);
        }

        tx.update(scripts).set({ selected: false }).where(eq(scripts.projectId, id)).run();
        tx.update(scripts).set({ selected: true }).where(eq(scripts.id, restoreScriptId)).run();
        const restored = tx.select().from(scripts).where(and(
          eq(scripts.projectId, id), eq(scripts.version, target.version),
        )).orderBy(desc(scripts.createdAt), asc(scripts.id)).all();
        return NextResponse.json({ success: true, selectedScriptId: restoreScriptId, scripts: restored.map(scriptView) });
      }, { behavior: "immediate" });
    }

    const scriptId = payload.scriptId as string | undefined;
    const shotTexts = payload.shotTexts as ShotTextPatch[] | undefined;

    if (scriptId && Array.isArray(shotTexts)) {
      const db = getDb();
      const [script] = await db.select().from(scripts).where(eq(scripts.id, scriptId)).limit(1);
      if (!script || script.projectId !== id) {
        return apiError(req, "Script not found", "Script not found", 404);
      }
      const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
      if (!project) return apiError(req, "Project not found", "Project not found", 404);

      const context = checkCreativeProfileContext(project, script);
      if (!context.ok) return NextResponse.json(contextConflict(context), { status: 409 });

      const patchByShot = new Map<number, ShotTextPatch>();
      for (const patch of shotTexts) {
        if (patch && typeof patch.shotId === "number") patchByShot.set(patch.shotId, patch);
      }
      const shots = (script.shots ?? []).map((shot) => {
        const patch = patchByShot.get(shot.shotId);
        if (!patch) return shot;
        return {
          ...shot,
          ...(typeof patch.voiceover === "string" && { voiceover: patch.voiceover.trim() }),
          ...(typeof patch.description === "string" && { description: patch.description.trim() }),
          ...(typeof patch.camera === "string" && { camera: patch.camera.trim().slice(0, CAMERA_MAX_LEN) }),
        };
      });

      const profile = context.scriptProfile;
      if (isTideweOutdoorProfile(profile)) {
        if (shotTexts.some((patch) => patch && Object.prototype.hasOwnProperty.call(patch, "voiceover"))) return NextResponse.json({ error: "Edit the complete narration and replan its shots.", code: "TIDEWE_COPY_DOCUMENT_REQUIRED" }, { status: 409 });
        if (payload.expectedScriptHash !== scriptRevision(script) || payload.expectedCreativeConfigRevision !== project.creativeConfigRevision) return NextResponse.json({ error: "The script or configuration changed. Refresh before editing.", code: "SCRIPT_CONTEXT_CHANGED" }, { status: 409 });
        assertTideweScript({ ...script, shots }, profile.presenter ?? null);
        return db.transaction((tx) => {
          const current = tx.select().from(scripts).where(and(eq(scripts.id, scriptId), eq(scripts.projectId, id))).get();
          const currentProject = tx.select().from(projects).where(eq(projects.id, id)).get();
          if (!current || !currentProject || scriptRevision(current) !== payload.expectedScriptHash || currentProject.creativeConfigRevision !== payload.expectedCreativeConfigRevision) return NextResponse.json({ error: "The script or configuration changed. Refresh before editing.", code: "SCRIPT_CONTEXT_CHANGED" }, { status: 409 });
          const updated = tx.update(scripts).set({ shots }).where(eq(scripts.id, scriptId)).returning().get()!;
          return NextResponse.json({ success: true, script: scriptView(updated) });
        }, { behavior: "immediate" });
      }
      if (isPremiumProductCgProfile(profile)) {
        if (profile.narrationMode === "none" && shots.some((shot) => shot.voiceover.trim() || shot.narration?.trim())) {
          return NextResponse.json({
            error: "Visual-only premium product CG scripts cannot contain narration.",
            code: "CG_NARRATION_DISABLED",
          }, { status: 400 });
        }
        const issues = lintCreativeProfileShots(profile, shots);
        if (issues.length > 0) {
          return NextResponse.json({
            error: "Premium product CG script edits violate the no-added-text or restrained-narration policy.",
            code: "CREATIVE_POLICY_VIOLATION",
            issues,
          }, { status: 400 });
        }
      }

      const [updated] = await db.update(scripts).set({ shots }).where(eq(scripts.id, scriptId)).returning();
      return NextResponse.json({ success: true, script: scriptView(updated) });
    }

    const selectedId = payload.selectedScriptId as string | undefined;
    if (!selectedId) {
      return apiError(req, "Missing selectedScriptId or scriptId+shotTexts", "Missing selectedScriptId or scriptId+shotTexts", 400);
    }

    return getDb().transaction((tx) => {
      // Validate under the same write lock as selection so a concurrent deletion cannot
      // remove the target after validation and leave every remaining script deselected.
      const project = tx.select().from(projects).where(eq(projects.id, id)).get();
      if (!project) return apiError(req, "项目不存在", "Project not found", 404);
      const target = tx.select().from(scripts).where(and(eq(scripts.id, selectedId), eq(scripts.projectId, id))).get();
      if (!target) return apiError(req, "脚本不存在", "Script not found", 404);
      const context = checkCreativeProfileContext(project, target);
      if (!context.ok) return NextResponse.json(contextConflict(context), { status: 409 });
      if (isTideweOutdoorProfile(context.scriptProfile)) assertTideweScript(target, context.scriptProfile.presenter ?? null);
      tx.update(scripts).set({ selected: false }).where(eq(scripts.projectId, id)).run();
      const updated = tx.update(scripts).set({ selected: true }).where(eq(scripts.id, selectedId)).returning().get();
      return NextResponse.json({ success: true, script: updated ? scriptView(updated) : updated });
    }, { behavior: "immediate" });
  } catch (error) {
    console.error("Failed to update script:", error);
    if (error && typeof error === "object" && "code" in error && String(error.code).startsWith("TIDEWE_")) return NextResponse.json({ error: error instanceof Error ? error.message : "Script validation failed", code: error.code }, { status: "status" in error ? Number(error.status) || 400 : 400 });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : errText(req, "Update failed", "Update failed") },
      { status: 500 },
    );
  }
}
