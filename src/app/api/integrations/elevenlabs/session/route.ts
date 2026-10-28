import { NextRequest } from "next/server";
import { createElevenLabsLocalSession, elevenLabsRouteError } from "@/lib/elevenlabs/local-access";
export const runtime = "nodejs";
export async function GET(req: NextRequest) {
  try { return await createElevenLabsLocalSession(req); }
  catch (error) { return elevenLabsRouteError(error); }
}
