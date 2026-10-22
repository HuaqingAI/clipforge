import { NextRequest } from "next/server";
import { assertKlingLocalRequest } from "@/lib/kling/local-access";
import { logoutProfile } from "@/lib/kling/auth";
import { getPublicKlingStatus } from "@/lib/kling/profiles";
import { klingErrorResponse } from "@/lib/kling/errors";
export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  try { await assertKlingLocalRequest(req); const { profileId } = await req.json(); await logoutProfile(profileId); return Response.json(getPublicKlingStatus(profileId), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return klingErrorResponse(error); }
}
