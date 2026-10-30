import { NextRequest, NextResponse } from "next/server";
import { deleteGenerationRuns, enqueueGenerationRun, GenerationRunError, listGenerationRuns, wakeGenerationRunner, type EnqueueGenerationRunInput } from "@/lib/generation-runs";

export const runtime = "nodejs";
export async function GET(req: NextRequest) {
  try {
    wakeGenerationRunner();
    return NextResponse.json({ runs: listGenerationRuns(req.nextUrl.searchParams.get("projectId") ?? undefined) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
export async function POST(req: NextRequest) {
  try { return NextResponse.json(enqueueGenerationRun(await req.json() as EnqueueGenerationRunInput), { status: 202 }); }
  catch (error) { return failure(error); }
}
export async function DELETE(req: NextRequest) {
  try { return NextResponse.json(deleteGenerationRuns(req.nextUrl.searchParams.get("projectId"))); }
  catch (error) { return failure(error); }
}
function failure(error: unknown) {
  return NextResponse.json({ error: error instanceof Error ? error.message : "后台任务操作失败。", code: error instanceof GenerationRunError ? error.code : "GENERATION_FAILED" }, { status: error instanceof GenerationRunError ? error.status : 500 });
}
