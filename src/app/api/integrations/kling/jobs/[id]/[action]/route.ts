import { NextRequest, NextResponse } from "next/server";
import { assertKlingLocalRequest, klingRouteError } from "@/lib/kling/local-access";
import { klingJobAction } from "@/lib/kling/jobs";
export const runtime = "nodejs";
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; action: string }> }) {
  try {
    await assertKlingLocalRequest(req);
    const { id, action } = await params;
    if (!["query", "import", "continue", "bind", "pause-query", "resume-query", "dismiss", "cancel-prepared"].includes(action)) return NextResponse.json({ error: { code: "KLING_ACTION_UNSUPPORTED", message: "不支持的任务操作" } }, { status: 400 });
    const body = await req.json();
    return NextResponse.json(await klingJobAction(id, action, body), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return klingRouteError(error); }
}
