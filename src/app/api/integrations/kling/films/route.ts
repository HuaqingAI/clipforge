import { NextRequest, NextResponse } from "next/server";
import { assertKlingLocalRequest, klingRouteError } from "@/lib/kling/local-access";
import { listKlingFilms, klingFilmView } from "@/lib/kling/film-repository";
export const runtime = "nodejs";
export async function GET(req: NextRequest) {
  try {
    await assertKlingLocalRequest(req, false);
    const projectId = req.nextUrl.searchParams.get("projectId") ?? undefined;
    if (projectId && !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) return NextResponse.json({ error: { code: "KLING_INPUT_INVALID", message: "项目编号无效" } }, { status: 400 });
    return NextResponse.json({ runs: listKlingFilms(projectId).map(klingFilmView) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return klingRouteError(error); }
}
export async function POST(req: NextRequest) {
  try {
    await assertKlingLocalRequest(req);
    return NextResponse.json({ error: { code: "KLING_FILM_REMOVED", message: "Kling 整片生成功能已移除，请使用单镜头生成后合成。历史整片任务仍可查看、暂停、取消或删除。", retryable: false } }, { status: 410, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return klingRouteError(error); }
}
