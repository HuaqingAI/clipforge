import { NextRequest, NextResponse } from "next/server";
import { assertKlingLocalRequest, klingRouteError } from "@/lib/kling/local-access";
import { getKlingFilm, klingFilmView } from "@/lib/kling/film-repository";
import { startKlingFilmRunner, wakeKlingFilmRunner } from "@/lib/kling/films";
import { deleteKlingFilm } from "@/lib/kling/delete-film";
export const runtime = "nodejs";
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await assertKlingLocalRequest(req, false);
    const { id } = await params;
    startKlingFilmRunner(); wakeKlingFilmRunner();
    return NextResponse.json(klingFilmView(getKlingFilm(id)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return klingRouteError(error); }
}
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await assertKlingLocalRequest(req, true);
    const { id } = await params;
    return NextResponse.json(deleteKlingFilm(id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return klingRouteError(error); }
}
