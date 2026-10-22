import { NextRequest, NextResponse } from "next/server";
import { assertWorkDeleteOrigin, deleteWork, WorkDeleteError } from "@/lib/delete-work";

export const runtime = "nodejs";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertWorkDeleteOrigin(req);
    const { id } = await params;
    return NextResponse.json(deleteWork(id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const known = error instanceof WorkDeleteError;
    if (!known) console.error("删除作品失败:", error);
    return NextResponse.json({ error: known ? error.message : "删除作品失败，请稍后重试。", code: known ? error.code : "WORK_DELETE_FAILED" },
      { status: known ? error.status : 500, headers: { "Cache-Control": "no-store" } });
  }
}
