import { NextRequest } from "next/server";
import { assertKlingLocalRequest } from "@/lib/kling/local-access";
import { refreshProfile } from "@/lib/kling/auth";
import { getPublicKlingStatus } from "@/lib/kling/profiles";
import { KlingError, klingErrorResponse } from "@/lib/kling/errors";
export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  try {
    await assertKlingLocalRequest(req);
    const input = await req.json();
    if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.profileId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.profileId) || (input.credits !== undefined && typeof input.credits !== "boolean")) {
      throw new KlingError("KLING_INVALID_CONFIG", "账号刷新参数不正确。", 400);
    }
    await refreshProfile(input.profileId, undefined, { credits: input.credits !== false });
    return Response.json(getPublicKlingStatus(input.profileId), { headers: { "Cache-Control": "no-store" } });
  }
  catch (error) { return klingErrorResponse(error); }
}
