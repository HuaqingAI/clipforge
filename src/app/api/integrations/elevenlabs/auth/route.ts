import { NextRequest } from "next/server";
import { assertElevenLabsLocalRequest, elevenLabsRouteError } from "@/lib/elevenlabs/local-access";
import { startElevenLabsLogin } from "@/lib/elevenlabs/client";
export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  try {
    await assertElevenLabsLocalRequest(req);
    return Response.json(await startElevenLabsLogin(), { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return elevenLabsRouteError(error); }
}
