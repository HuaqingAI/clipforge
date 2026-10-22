import { NextRequest, NextResponse } from "next/server";
import { eq, desc, and } from "drizzle-orm";
import { join } from "path";
import { existsSync } from "fs";
import { getDb } from "@/lib/db";
import { getDataDir } from "@/lib/paths";
import { compositions, projects } from "@/lib/db/schema";
import { generateCover } from "@/lib/video-composer/cover";
import { apiError, errText } from "@/lib/api-error";
import { isPremiumProductCgProfile } from "@/lib/creative-profiles";

const SAFE_ID = /^[a-zA-Z0-9\-]+$/;

/**
 * POST /api/project/[id]/cover — generate a cover/thumbnail image from the latest composed video,
 * overlaying a bold title. body: { title: string, frameAt?: number, position?: "center"|"lower"|"upper" }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id || !SAFE_ID.test(id)) return apiError(req, "无效的项目ID", "Invalid project ID");

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* allow empty body; validated below */
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return apiError(req, "请提供封面标题", "Please provide a cover title");

  const db = getDb();
  const [project] = await db
    .select({ creativeProfile: projects.creativeProfile })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  if (!project) return apiError(req, "项目不存在", "Project not found", 404);
  // Covers burn a large title into the extracted frame. Premium CG locks
  // generated frame text, so an older client cannot request this sales output.
  if (isPremiumProductCgProfile(project.creativeProfile)) {
    return NextResponse.json(
      {
        error: errText(req, "高端家具产品 CG 不支持标题式封面文字", "High-end furniture product CG does not allow title-based cover text."),
        code: "PREMIUM_CG_OUTPUT_POLICY",
      },
      { status: 400 },
    );
  }
  const [comp] = await db
    .select()
    .from(compositions)
    // latest *successful* composition — a failed retry on top must not hide a good take
    .where(and(eq(compositions.projectId, id), eq(compositions.status, "done")))
    .orderBy(desc(compositions.createdAt))
    .limit(1);
  if (!comp?.outputPath || comp.status !== "done") {
    return apiError(req, "请先合成视频再生成封面", "Please compose the video before generating a cover");
  }
  // outputPath may be absolute or relative to the data dir
  const videoPath = existsSync(comp.outputPath) ? comp.outputPath : join(getDataDir(), comp.outputPath);
  if (!existsSync(videoPath)) return apiError(req, "成片文件不存在", "The composed video file does not exist", 404);

  const fileName = `cover-${Date.now()}.png`;
  const outPath = join(getDataDir(), "uploads", id, fileName);
  const position = body.position === "lower" || body.position === "upper" ? body.position : "center";
  try {
    await generateCover({ videoPath, title, outPath, frameAtSec: Number(body.frameAt) || 1, position });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : errText(req, "封面生成失败", "Cover generation failed") }, { status: 500 });
  }
  return NextResponse.json({ cover: `/api/files/${id}/${fileName}`, title });
}
