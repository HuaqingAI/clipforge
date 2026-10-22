import { NextRequest, NextResponse } from "next/server";
import { assertKlingLocalRequest, klingRouteError } from "@/lib/kling/local-access";
import { klingFilmAction } from "@/lib/kling/films";
export const runtime = "nodejs";
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; action: string }> }) {
  try {
    await assertKlingLocalRequest(req);
    const { id, action } = await params;
    return NextResponse.json({ run: await klingFilmAction(id, action, await req.json()) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return klingRouteError(error); }
}
