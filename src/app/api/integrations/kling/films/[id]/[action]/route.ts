import { NextRequest, NextResponse } from "next/server";
import { assertKlingLocalRequest, klingRouteError } from "@/lib/kling/local-access";
import { klingFilmAction } from "@/lib/kling/films";
export const runtime = "nodejs";
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; action: string }> }) {
  try {
    await assertKlingLocalRequest(req);
    const { id, action } = await params;
    if (action !== "pause" && action !== "cancel") {
      return NextResponse.json({ error: { code: "KLING_FILM_REMOVED", message: "Kling 整片生成功能已移除，请使用单镜头生成后合成。历史整片任务仍可查看、暂停、取消或删除。", retryable: false } }, { status: 410, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ run: await klingFilmAction(id, action, await req.json()) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return klingRouteError(error); }
}
