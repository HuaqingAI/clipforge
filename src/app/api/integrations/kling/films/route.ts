import { NextRequest, NextResponse } from "next/server";
import { assertKlingLocalRequest, klingRouteError } from "@/lib/kling/local-access";
import { startKlingFilm, startKlingFilmRunner, wakeKlingFilmRunner } from "@/lib/kling/films";
import { listKlingFilms, klingFilmView } from "@/lib/kling/film-repository";
export const runtime = "nodejs";
export async function GET(req: NextRequest) {
  try {
    await assertKlingLocalRequest(req, false);
    const projectId = req.nextUrl.searchParams.get("projectId") ?? undefined;
    if (projectId && !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) return NextResponse.json({ error: { code: "KLING_INPUT_INVALID", message: "项目编号无效" } }, { status: 400 });
    startKlingFilmRunner(); wakeKlingFilmRunner();
    return NextResponse.json({ runs: listKlingFilms(projectId).map(klingFilmView) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return klingRouteError(error); }
}
export async function POST(req: NextRequest) {
  try {
    await assertKlingLocalRequest(req);
    return NextResponse.json({ run: await startKlingFilm(await req.json()) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return klingRouteError(error); }
}
