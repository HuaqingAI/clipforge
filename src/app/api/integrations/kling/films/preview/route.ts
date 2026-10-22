import { NextRequest, NextResponse } from "next/server";
import { assertKlingLocalRequest, klingRouteError } from "@/lib/kling/local-access";
import { previewKlingFilm } from "@/lib/kling/film-plan";
export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  try {
    await assertKlingLocalRequest(req);
    return NextResponse.json(await previewKlingFilm(await req.json()), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return klingRouteError(error); }
}
