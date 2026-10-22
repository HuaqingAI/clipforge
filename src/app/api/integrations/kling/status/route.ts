import { NextRequest } from "next/server";
import { assertKlingLocalRequest } from "@/lib/kling/local-access";
import { getPublicKlingStatus } from "@/lib/kling/profiles";
import { klingErrorResponse } from "@/lib/kling/errors";
export const runtime = "nodejs";
export async function GET(req: NextRequest) {
  try { await assertKlingLocalRequest(req, false); return Response.json(getPublicKlingStatus(req.nextUrl.searchParams.get("profileId") ?? undefined), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return klingErrorResponse(error); }
}
