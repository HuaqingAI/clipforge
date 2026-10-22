import { NextRequest, NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { projects, scripts as scriptsTable } from "@/lib/db/schema";
import { shotsToSrt, shotsToVtt } from "@/lib/subtitle-export";
import { apiError, errText } from "@/lib/api-error";
import { isPremiumProductCgProfile } from "@/lib/creative-profiles";

const SAFE_ID = /^[a-zA-Z0-9\-]+$/;

/**
 * GET /api/project/[id]/subtitle?format=srt|vtt —— export the latest script's subtitles (SRT / WebVTT, direct browser download).
 * Timestamps are accumulated from the planned shot durations in the script, for use in re-editing, platform-native captions, accessibility, or proofreading (the final video still has burnt-in subtitles).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id || !SAFE_ID.test(id)) return apiError(req, "无效的项目ID", "Invalid project ID");

  const format = new URL(req.url).searchParams.get("format") === "vtt" ? "vtt" : "srt";

  const db = getDb();
  const [project] = await db
    .select({ creativeProfile: projects.creativeProfile })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  if (!project) return apiError(req, "项目不存在", "Project not found", 404);
  if (isPremiumProductCgProfile(project.creativeProfile)) {
    return NextResponse.json({
      error: errText(req, "高端家具产品 CG 不支持字幕导出，因为字幕在该创作档案中已锁定关闭。", "High-end furniture product CG does not allow subtitle export because captions are locked off."),
      code: "PREMIUM_CG_OUTPUT_POLICY",
    }, { status: 400 });
  }
  const [script] = await db
    .select({ shots: scriptsTable.shots })
    .from(scriptsTable)
    .where(eq(scriptsTable.projectId, id))
    .orderBy(desc(scriptsTable.version))
    .limit(1);

  if (!script) return apiError(req, "该项目还没有脚本，先生成脚本再导出字幕", "This project has no script yet; generate a script before exporting subtitles", 404);
  const shots = Array.isArray(script.shots) ? script.shots : [];
  if (!shots.some((s) => (s?.voiceover ?? "").trim())) {
    return apiError(req, "脚本没有可导出的旁白文案", "The script has no voiceover text to export", 422);
  }

  const text = format === "vtt" ? shotsToVtt(shots) : shotsToSrt(shots);
  const mime = format === "vtt" ? "text/vtt; charset=utf-8" : "application/x-subrip; charset=utf-8";
  return new NextResponse(text, {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Content-Disposition": `attachment; filename="subtitle-${id}.${format}"`,
    },
  });
}
