import { NextResponse } from "next/server";
import { listLocalShotVideos } from "@/lib/shot-library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  try {
    return NextResponse.json({ shots: listLocalShotVideos() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("获取本地镜头失败:", error);
    return NextResponse.json({ error: "获取本地镜头失败，请稍后重试。" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
