import { NextRequest } from "next/server";
import { assertKlingLocalRequest } from "@/lib/kling/local-access";
import { startLogin } from "@/lib/kling/auth";
import { klingErrorResponse } from "@/lib/kling/errors";
export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  try { await assertKlingLocalRequest(req); const { profileId } = await req.json(); const session = startLogin(profileId); return Response.json({ authSessionId: session.id, session }, { status: 202, headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return klingErrorResponse(error); }
}
