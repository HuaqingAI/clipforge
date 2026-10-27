import { NextRequest, NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { scripts as scriptsTable, projects } from "@/lib/db/schema";
import { splitNarrationIntoShots } from "@/lib/script-import";
import { apiError } from "@/lib/api-error";
import {
  createCreativeProfileSnapshot,
  isPremiumProductCgProfile,
  isTideweOutdoorProfile,
  resolveCreativeProfile,
} from "@/lib/creative-profiles";
import { POST as generateScripts } from "@/app/api/llm/script/route";

const SAFE_ID = /^[a-zA-Z0-9\-]+$/;

/**
 * POST /api/project/[id]/import-script — Start from user-written narration.
 * TIDEWE freezes complete English prose and uses AI only for translation/semantic visual planning.
 * Other sales profiles use the local sentence splitter, then continue through their normal media workflow.
 * body: { script: string, title?: string }
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
  const text = typeof body.script === "string" ? body.script.trim() : "";
  if (text.length < 2) return apiError(req, "请提供脚本文案", "Please provide script copy");

  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (project) {
    const profile = resolveCreativeProfile(project.creativeProfile, {
      videoMode: project.videoMode,
    });
    if (isPremiumProductCgProfile(profile)) {
      return NextResponse.json({
        error: "Premium product CG requires structured visual beats; the narration importer cannot turn sales copy into CG scene descriptions.",
        code: "CG_STRUCTURED_IMPORT_REQUIRED",
      }, { status: 409 });
    }
    if (isTideweOutdoorProfile(profile)) {
      return generateScripts(new NextRequest(new URL("/api/llm/script", req.url), {
        method: "POST", headers: { "Content-Type": "application/json", "Accept-Language": req.headers.get("accept-language") ?? "zh" },
        body: JSON.stringify({ projectId: id, copyText: text, count: 1, requestId: body.requestId,
          expectedCreativeConfigRevision: body.expectedCreativeConfigRevision, sourceScriptId: body.sourceScriptId,
          expectedScriptHash: body.expectedScriptHash, llmConfig: body.llmConfig }),
      }));
    }
  }
  if (!project) return apiError(req, "项目不存在", "Project not found", 404);

  const shots = splitNarrationIntoShots(text);
  if (!shots.length) return apiError(req, "脚本无法切分出分镜（缺少有效文案）", "Could not split the script into shots (no valid copy)", 422);
  const totalDuration = shots.reduce((sum, s) => sum + s.duration, 0);

  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim().slice(0, 80)
      : (shots[0]?.voiceover ?? "导入脚本").slice(0, 30);

  const [row] = db.transaction((tx) => {
    const [latest] = tx
      .select({ version: scriptsTable.version })
      .from(scriptsTable)
      .where(eq(scriptsTable.projectId, id))
      .orderBy(desc(scriptsTable.version))
      .limit(1)
      .all();
    const nextVersion = (latest?.version ?? 0) + 1;
    tx.update(scriptsTable).set({ selected: false }).where(eq(scriptsTable.projectId, id)).run();
    return tx
      .insert(scriptsTable)
      .values({
        projectId: id,
        version: nextVersion,
        styleType: "custom",
        title,
        totalDuration,
        shots,
        selected: true,
        creativeProfileSnapshot: createCreativeProfileSnapshot(
          project.creativeProfile,
          project.creativeConfigRevision,
          { styleType: "custom", videoMode: project.videoMode },
        ),
      })
      .returning()
      .all();
  });

  return NextResponse.json({ scriptId: row.id, version: row.version, shots: shots.length, totalDuration });
}
