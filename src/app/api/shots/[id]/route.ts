import { NextRequest, NextResponse } from "next/server";
import { assertShotDeleteOrigin, deleteLocalShotVideo, ShotLibraryError } from "@/lib/shot-library";

export const runtime = "nodejs";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertShotDeleteOrigin(req);
    const { id } = await params;
    return NextResponse.json(deleteLocalShotVideo(id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const known = error instanceof ShotLibraryError;
    if (!known) console.error("删除本地镜头失败:", error);
    return NextResponse.json({ error: known ? error.message : "删除镜头失败，请稍后重试。", code: known ? error.code : "SHOT_DELETE_FAILED" },
      { status: known ? error.status : 500, headers: { "Cache-Control": "no-store" } });
  }
}
