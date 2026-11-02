import { NextRequest, NextResponse } from "next/server";
import { previewProjectVideoPrompt, VideoPromptError } from "@/lib/server/video-prompt";
import { normalizeTideweVideoDirectionConfig, prepareTideweVideoDirections, TideweVideoDirectionError } from "@/lib/server/tidewe-video-direction";
import { getDb } from "@/lib/db";
import { scripts } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { resolveCurrentScript } from "@/lib/current-script";

export const runtime = "nodejs";

/** Prepare uncached English direction through the text model, then compile the reviewed video prompt. */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await req.json();
    let preview;
    try {
      preview = previewProjectVideoPrompt(id, body);
    } catch (error) {
      if (!(error instanceof TideweVideoDirectionError) || error.code !== "TIDEWE_VIDEO_DIRECTION_REQUIRED") throw error;
      // The first compile already validated project, profile, script, copy and references.
      const current = resolveCurrentScript(getDb().select().from(scripts).where(and(eq(scripts.projectId, id), eq(scripts.selected, true))).all());
      const shot = current && current.id === body.scriptId ? current.shots?.find((item) => item.shotId === body.shotId) : undefined;
      if (!shot) throw new VideoPromptError("SCRIPT_CONTEXT_CHANGED", "当前脚本或镜头已改变，请重新预览。", 409);
      await prepareTideweVideoDirections([shot], normalizeTideweVideoDirectionConfig(body.llmConfig));
      // Recheck saved state after the asynchronous preparation; never approve a stale edit.
      preview = previewProjectVideoPrompt(id, body);
    }
    return NextResponse.json(preview, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof VideoPromptError || error instanceof TideweVideoDirectionError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "请求体必须是 JSON 对象。", code: "VIDEO_PROMPT_INPUT_INVALID" }, { status: 400 });
    console.error("视频提示词预览失败", error);
    return NextResponse.json({ error: "视频提示词预览失败，请重试。" }, { status: 500 });
  }
}
