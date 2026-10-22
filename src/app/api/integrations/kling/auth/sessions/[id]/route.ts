import { NextRequest } from "next/server";
import { assertKlingLocalRequest } from "@/lib/kling/local-access";
import { getAuthSession } from "@/lib/kling/auth";
import { klingErrorResponse } from "@/lib/kling/errors";
export const runtime = "nodejs";
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try { await assertKlingLocalRequest(req, false); const { id } = await context.params; return Response.json(getAuthSession(id), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return klingErrorResponse(error); }
}
