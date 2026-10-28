import { NextRequest } from "next/server";
import { assertElevenLabsLocalRequest, elevenLabsRouteError } from "@/lib/elevenlabs/local-access";
import { getElevenLabsStatus } from "@/lib/elevenlabs/client";
export const runtime = "nodejs";
export async function GET(req: NextRequest) {
  try {
    await assertElevenLabsLocalRequest(req, false);
    return Response.json(await getElevenLabsStatus(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return elevenLabsRouteError(error); }
}
