import { NextRequest } from "next/server";
import { assertKlingLocalRequest } from "@/lib/kling/local-access";
import { createProfile, createAccountProfile, updateProfile, getPublicKlingStatus } from "@/lib/kling/profiles";
import { KlingError, klingErrorResponse } from "@/lib/kling/errors";
export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  try {
    await assertKlingLocalRequest(req);
    const input = await req.json();
    if (!input || typeof input !== "object" || Array.isArray(input) || (input.id !== undefined && typeof input.id !== "string")) throw new KlingError("KLING_INVALID_CONFIG", "配置格式不正确。", 400);
    const accountRequest = Object.hasOwn(input, "sourceProfileId");
    if (accountRequest && (typeof input.sourceProfileId !== "string" || Object.keys(input).some((key) => key !== "sourceProfileId" && key !== "label"))) {
      throw new KlingError("KLING_INVALID_CONFIG", "新增 Kling 账户仅接受来源账户和名称。", 400);
    }
    const profile = accountRequest ? await createAccountProfile(input.sourceProfileId, input.label) : input.id ? updateProfile(input.id, input) : await createProfile(input);
    return Response.json({ profileId: profile.id, profile: getPublicKlingStatus(profile.id).profile }, { status: input.id ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return klingErrorResponse(error); }
}
