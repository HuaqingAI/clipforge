import { NextRequest, NextResponse } from "next/server";
import { previewProjectVideoPrompt, VideoPromptError } from "@/lib/server/video-prompt";

export const runtime = "nodejs";

/** A preview only compiles saved direction; it never invokes a model or starts a paid task. */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const preview = previewProjectVideoPrompt(id, await req.json());
    return NextResponse.json(preview, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof VideoPromptError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "请求体必须是 JSON 对象。", code: "VIDEO_PROMPT_INPUT_INVALID" }, { status: 400 });
    console.error("视频提示词预览失败", error);
    return NextResponse.json({ error: "视频提示词预览失败，请重试。" }, { status: 500 });
  }
}
