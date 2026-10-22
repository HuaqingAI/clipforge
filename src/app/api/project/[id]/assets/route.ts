import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { assets, scripts } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { LAST_FRAME_SUFFIX } from "@/lib/video-composer/frame-extract";
import { resolveUploadFilePath } from "@/lib/remote-image";
import { existsSync } from "fs";
import { persistAssetSource, saveAssetCandidate } from "@/lib/asset-persistence";
import { sanitizeGenerationControlSummary } from "@/lib/video-repair-plan";
import { assetScopeForShot, assetMatchesScript, filterAssetsForScript } from "@/lib/asset-context";

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
    const script = scriptRows.find((row) => row.selected) ?? scriptRows[0];
    const rows = req.nextUrl.searchParams.get("all") === "1" ? allRows : filterAssetsForScript(allRows, script);
    return NextResponse.json(rows.map((row) => {
      const tailPath = row.filePath && /\.(mp4|webm|mov|m4v)$/i.test(row.filePath)
        ? resolveUploadFilePath(`${row.filePath}${LAST_FRAME_SUFFIX}`)
        : null;
      return { ...row, ...(tailPath && existsSync(tailPath) && { lastFrameUrl: `${row.filePath}${LAST_FRAME_SUFFIX}` }) };
    }));
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
    if (body.provider === "kling-cli") return NextResponse.json({ error: "Kling 视频请通过原作业恢复入库", code: "KLING_JOB_REQUIRED" }, { status: 409 });
    const { shotId, sourceUrl } = body as { shotId?: number; sourceUrl?: string };

    if (typeof shotId !== "number" || !sourceUrl) {
      return NextResponse.json({ error: "缺少 shotId 或 sourceUrl" }, { status: 400 });
    }
    // 校验 projectId 防路径穿越
    if (!/^[a-zA-Z0-9-]+$/.test(id)) {
      return NextResponse.json({ error: "无效的项目ID" }, { status: 400 });
    }

    const db = getDb();
    const scriptRows = await db.select().from(scripts).where(eq(scripts.projectId, id)).orderBy(desc(scripts.createdAt));
    const script = typeof body.scriptId === "string" ? scriptRows.find((row) => row.id === body.scriptId) : scriptRows.find((row) => row.selected) ?? scriptRows[0];
    const shot = script?.shots?.find((row) => row.shotId === shotId);
    if (scriptRows.length && (!script || !shot)) return NextResponse.json({ error: "目标脚本或镜头已变化，请刷新素材页" }, { status: 409 });
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
      ...(thumbnailPath && { sourceKeyframeUrl: thumbnailPath }),
    }));
  } catch (error) {
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
    const [target] = await db.select().from(assets).where(and(eq(assets.id, body.assetId), eq(assets.projectId, id))).limit(1);
    if (!target || target.status !== "done") return NextResponse.json({ error: "素材不存在或尚未就绪" }, { status: 404 });
    db.transaction((tx) => {
      const scriptRows = tx.select().from(scripts).where(eq(scripts.projectId, id)).orderBy(desc(scripts.createdAt)).all();
      const script = scriptRows.find((row) => row.selected) ?? scriptRows[0];
      if (!assetMatchesScript(target, script)) throw new Error("此素材属于其他脚本修订，请在原 Kling 任务详情中明确采用为当前镜头");
      const candidates = tx.select().from(assets).where(and(eq(assets.projectId, id), eq(assets.shotId, target.shotId))).all();
      for (const candidate of filterAssetsForScript(candidates, script)) tx.update(assets).set({ selected: false }).where(eq(assets.id, candidate.id)).run();
      tx.update(assets).set({ selected: true }).where(eq(assets.id, target.id)).run();
    });
    return NextResponse.json({ ...target, selected: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "切换素材失败";
    return NextResponse.json({ error: message }, { status: message.startsWith("此素材属于其他脚本修订") ? 409 : 500 });
  }
}
