import { NextRequest } from "next/server";
import { assertKlingLocalRequest } from "@/lib/kling/local-access";
import { cancelLogin } from "@/lib/kling/auth";
import { klingErrorResponse } from "@/lib/kling/errors";
export const runtime = "nodejs";
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try { await assertKlingLocalRequest(req); const { id } = await context.params; return Response.json({ session: cancelLogin(id) }, { status: 202, headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return klingErrorResponse(error); }
}
