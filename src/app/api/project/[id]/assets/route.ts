import { resolveCurrentScript } from "@/lib/current-script";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { assets, projects, scripts, klingJobs, klingJobOutputs } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { LAST_FRAME_SUFFIX } from "@/lib/video-composer/frame-extract";
import { resolveUploadFilePath } from "@/lib/remote-image";
import { existsSync } from "fs";
import { AssetContextConflictError, persistAssetSource, saveAssetCandidate } from "@/lib/asset-persistence";
import { sanitizeGenerationControlSummary } from "@/lib/video-repair-plan";
import { assetScopeForShot, assetMatchesScript, filterAssetsForScript } from "@/lib/asset-context";
import { errText } from "@/lib/api-error";
import {
  checkCreativeProfileContext,
  isPremiumProductCgProject,
  isTideweOutdoorProfile,
} from "@/lib/creative-profiles";
import { assertTideweScript } from "@/lib/tidewe/validation";
import {
  hasTrustedPremiumCgAssetProvenance,
  PREMIUM_CG_ASSET_PROVENANCE_REQUIRED,
} from "@/lib/premium-cg-assets";

const PREMIUM_CG_DIRECT_ASSET_IMPORT_FORBIDDEN = "PREMIUM_CG_DIRECT_ASSET_IMPORT_FORBIDDEN";

function premiumCgConflict(req: NextRequest, code: string, zh: string, en: string) {
  return NextResponse.json({ error: errText(req, zh, en), code }, { status: 409 });
}

// 获取某项目已生成的素材（素材页恢复状态用）
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const [allRows, scriptRows] = await Promise.all([
      db.select().from(assets).where(eq(assets.projectId, id)).orderBy(desc(assets.createdAt)),
      db.select().from(scripts).where(eq(scripts.projectId, id)).orderBy(desc(scripts.createdAt)),
    ]);
    const script = resolveCurrentScript(scriptRows);
    const all = req.nextUrl.searchParams.get("all") === "1";
    const includeHistory = !all && req.nextUrl.searchParams.get("includeHistory") === "1";
    const currentRows = script ? filterAssetsForScript(allRows, script) : [];
    const currentIds = new Set(currentRows.map((row) => row.id));
    const adoptedIds = new Set(currentRows.map((row) => row.derivedFromAssetId).filter(Boolean));
    const shotIds = new Set(script?.shots?.map((shot) => shot.shotId));
    const rows = all ? allRows : includeHistory && script
      ? allRows.filter((row) => currentIds.has(row.id) || (
        row.sourceScriptId === script.id && shotIds.has(row.shotId) && !adoptedIds.has(row.id)
      ))
      : currentRows;
    const recovery = new Map<string, { klingJobId: string; klingOutputId: string; shotId: number }>();
    if (includeHistory && script && rows.some((row) => !currentIds.has(row.id))) {
      const outputs = await db.select({ output: klingJobOutputs, job: klingJobs })
        .from(klingJobOutputs).innerJoin(klingJobs, eq(klingJobOutputs.jobId, klingJobs.id))
        .where(and(eq(klingJobs.projectId, id), eq(klingJobs.scriptId, script.id), eq(klingJobOutputs.importState, "imported")))
        .orderBy(desc(klingJobOutputs.createdAt));
      for (const { output, job } of outputs) {
        if (!output.assetId || output.data.deletedAt || job.data.deletedAt || recovery.has(output.assetId)) continue;
        recovery.set(output.assetId, { klingJobId: job.id, klingOutputId: output.id, shotId: job.shotId });
      }
    }
    return NextResponse.json(rows.map((row) => {
      const tailPath = row.filePath && /\.(mp4|webm|mov|m4v)$/i.test(row.filePath)
        ? resolveUploadFilePath(`${row.filePath}${LAST_FRAME_SUFFIX}`)
        : null;
      const matchesCurrentScript = currentIds.has(row.id);
      const linkedOutput = recovery.get(row.id) ?? (row.derivedFromAssetId ? recovery.get(row.derivedFromAssetId) : undefined);
      return {
        ...row,
        ...(includeHistory && { matchesCurrentScript }),
        ...(includeHistory && !matchesCurrentScript && {
          previouslySelected: row.selected,
          selected: false,
          ...(linkedOutput?.shotId === row.shotId && {
            klingJobId: linkedOutput.klingJobId,
            klingOutputId: linkedOutput.klingOutputId,
          }),
        }),
        ...(tailPath && existsSync(tailPath) && { lastFrameUrl: `${row.filePath}${LAST_FRAME_SUFFIX}` }),
      };
    }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("获取素材失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "获取素材失败" },
      { status: 500 }
    );
  }
}

// 保存/更新某分镜的素材（素材生成成功后落库，供合成读取真实素材）
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "请求内容必须是对象" }, { status: 400 });
    if (body.provider === "kling-cli") return NextResponse.json({ error: "Kling 视频请通过原作业恢复入库", code: "KLING_JOB_REQUIRED" }, { status: 409 });
    const { shotId, sourceUrl } = body as { shotId?: number; sourceUrl?: string };

    if (typeof shotId !== "number" || typeof sourceUrl !== "string" || !sourceUrl) {
      return NextResponse.json({ error: "缺少 shotId 或 sourceUrl" }, { status: 400 });
    }
    // 校验 projectId 防路径穿越
    if (!/^[a-zA-Z0-9-]+$/.test(id)) {
      return NextResponse.json({ error: "无效的项目ID" }, { status: 400 });
    }

    const db = getDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    // This endpoint receives arbitrary URLs from the browser. It cannot prove that one was
    // produced under the locked Premium CG prompt/reference policy, so CG output must enter
    // through a server-owned generation/import flow (grid or Kling) instead.
    if (isPremiumProductCgProject(project)) {
      return premiumCgConflict(
        req,
        PREMIUM_CG_DIRECT_ASSET_IMPORT_FORBIDDEN,
        "高端产品 CG 不支持直接导入或采用未验证来源的镜头素材，请通过受控的分镜或 Kling 生成流程创建素材。",
        "Premium product CG does not accept direct unverified asset imports. Generate the take through the controlled storyboard or Kling flow.",
      );
    }
    const scriptRows = await db.select().from(scripts).where(eq(scripts.projectId, id)).orderBy(desc(scripts.createdAt));
    const script = typeof body.scriptId === "string" ? scriptRows.find((row) => row.id === body.scriptId) : resolveCurrentScript(scriptRows);
    const shot = script?.shots?.find((row) => row.shotId === shotId);
    const tidewe = isTideweOutdoorProfile(project.creativeProfile) || script?.styleType === "tidewe_outdoor" || script?.copyDocument != null;
    if (tidewe) {
      if (typeof body.scriptId !== "string" || !body.scriptId.trim()) {
        return NextResponse.json({ error: "TIDEWE 保存素材必须携带生成开始时的 scriptId。", code: "TIDEWE_ASSET_CONTEXT_REQUIRED" }, { status: 400 });
      }
      const currentScript = resolveCurrentScript(scriptRows);
      const context = script ? checkCreativeProfileContext(project, script) : null;
      if (!script || !shot || currentScript?.id !== script.id
        || !context?.ok) throw new AssetContextConflictError();
      try { assertTideweScript(script, isTideweOutdoorProfile(context.scriptProfile) ? context.scriptProfile.presenter ?? null : undefined); }
      catch { throw new AssetContextConflictError("The current TIDEWE script is invalid. Regenerate it before saving assets."); }
    }
    if (scriptRows.length && (!script || !shot)) return NextResponse.json({ error: "目标脚本或镜头已变化，请刷新素材页" }, { status: 409 });
    if (script && resolveCurrentScript(scriptRows)?.id !== script.id) throw new AssetContextConflictError();
    const filePath = await persistAssetSource(id, sourceUrl, shotId);

    const typeMap: Record<string, "ai_generated" | "product_image" | "user_upload"> = {
      ai_generate: "ai_generated",
      ai_generated: "ai_generated",
      product_image: "product_image",
      user_upload: "user_upload",
    };
    const assetType = typeMap[body.type] ?? "ai_generated";
    const generationPlan = sanitizeGenerationControlSummary(body.generationPlan);

    // Static keyframe (first frame) accompanying an i2v video asset: serves as the assets-page
    // thumbnail AND as the source frame for per-shot motion re-runs / keyframe chaining — the
    // upsert below replaces the old keyframe row entirely, so without this column the frame is
    // unrecoverable. Local persisted paths only (the keyframe was saved as an image asset earlier).
    const thumbnailPath =
      typeof body.thumbnailPath === "string" && body.thumbnailPath.startsWith("/api/files/")
        ? body.thumbnailPath
        : undefined;

    return NextResponse.json(await saveAssetCandidate({
      projectId: id,
      shotId,
      type: assetType,
      filePath,
      thumbnailPath,
      provider: body.provider,
      model: body.model,
      prompt: body.prompt,
      generationPlan,
      ...(script && shot && { scope: assetScopeForShot(script, shot) }),
      ...(script && { expectedCurrentScript: { scriptId: script.id } }),
      ...(thumbnailPath && { sourceKeyframeUrl: thumbnailPath }),
    }));
  } catch (error) {
    if (error instanceof AssetContextConflictError) return NextResponse.json({ error: errText(req, "脚本或创作配置已变化，旧素材不能保存到当前脚本，请刷新后重试。", error.message), code: error.code }, { status: 409 });
    console.error("保存素材失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "保存素材失败" },
      { status: 500 }
    );
  }
}

/** Select an existing take as the real composition input. No media is deleted. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!/^[a-zA-Z0-9-]+$/.test(id)) return NextResponse.json({ error: "无效的项目ID" }, { status: 400 });
    const body = await req.json() as { assetId?: unknown };
    if (typeof body.assetId !== "string" || !/^[a-zA-Z0-9-]+$/.test(body.assetId)) {
      return NextResponse.json({ error: "缺少有效的 assetId" }, { status: 400 });
    }
    const db = getDb();
    return db.transaction((tx) => {
      const target = tx.select().from(assets).where(and(eq(assets.id, body.assetId as string), eq(assets.projectId, id))).get();
      if (!target || target.status !== "done") return NextResponse.json({ error: "素材不存在或尚未就绪" }, { status: 404 });
      const currentProject = tx.select().from(projects).where(eq(projects.id, id)).get();
      if (!currentProject) return NextResponse.json({ error: "Project not found" }, { status: 404 });
      const scriptRows = tx.select().from(scripts).where(eq(scripts.projectId, id)).orderBy(desc(scripts.createdAt)).all();
      const script = resolveCurrentScript(scriptRows);
      if (isPremiumProductCgProject(currentProject)) {
        if (!script) {
          return premiumCgConflict(
            req,
            PREMIUM_CG_ASSET_PROVENANCE_REQUIRED,
            "高端产品 CG 需要当前脚本和可验证来源的镜头素材。",
            "Premium product CG requires a current script and a take with verifiable provenance.",
          );
        }
        const context = checkCreativeProfileContext(currentProject, script);
        if (!context.ok) {
          return NextResponse.json({
            error: context.code === "CREATIVE_CONFIG_STALE"
              ? "The script was created with an outdated creative configuration. Regenerate a current script before selecting an asset."
              : "The script does not match the project's current creative type. Generate a current script before selecting an asset.",
            code: context.code,
            currentCreationType: context.projectProfile.creationType,
            scriptCreationType: context.scriptProfile.creationType,
            projectRevision: context.projectRevision,
            scriptRevision: context.scriptRevision,
          }, { status: 409 });
        }
        if (!hasTrustedPremiumCgAssetProvenance(target, id, script)) {
          return premiumCgConflict(
            req,
            PREMIUM_CG_ASSET_PROVENANCE_REQUIRED,
            "高端产品 CG 只能采用由受控分镜或 Kling 流程生成且与当前脚本匹配的素材。",
            "Premium product CG can only select a current-script take generated by the controlled storyboard or Kling flow.",
          );
        }
      }
      if (isTideweOutdoorProfile(currentProject.creativeProfile) || script?.styleType === "tidewe_outdoor" || script?.copyDocument != null) {
        const context = script ? checkCreativeProfileContext(currentProject, script) : null;
        if (!script || !context?.ok) throw new AssetContextConflictError();
        try { assertTideweScript(script, isTideweOutdoorProfile(context.scriptProfile) ? context.scriptProfile.presenter ?? null : undefined); }
        catch { throw new AssetContextConflictError("The current TIDEWE script is invalid. Regenerate it before selecting assets."); }
      }
      if (!script || !assetMatchesScript(target, script)) throw new Error("此素材属于其他脚本修订，请在原 Kling 任务详情中明确采用为当前镜头");
      const candidates = tx.select().from(assets).where(and(eq(assets.projectId, id), eq(assets.shotId, target.shotId))).all();
      for (const candidate of filterAssetsForScript(candidates, script)) tx.update(assets).set({ selected: false }).where(eq(assets.id, candidate.id)).run();
      tx.update(assets).set({ selected: true }).where(eq(assets.id, target.id)).run();
      return NextResponse.json({ ...target, selected: true });
    }, { behavior: "immediate" });
  } catch (error) {
    if (error instanceof AssetContextConflictError) return NextResponse.json({ error: errText(req, "脚本或创作配置已变化，请刷新后重新选择素材。", error.message), code: error.code }, { status: 409 });
    const message = error instanceof Error ? error.message : "切换素材失败";
    return NextResponse.json({ error: message }, { status: message.startsWith("此素材属于其他脚本修订") ? 409 : 500 });
  }
}
