import { NextRequest, NextResponse } from "next/server";
import { deleteGenerationRuns, generationRunAction, GenerationRunError, getGenerationRun, wakeGenerationRunner } from "@/lib/generation-runs";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(_req: NextRequest, context: Context) {
  try { wakeGenerationRunner(); return NextResponse.json(getGenerationRun((await context.params).id), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return failure(error); }
}
export async function POST(req: NextRequest, context: Context) {
  try {
    const input = await req.json();
    if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.action !== "string") throw new GenerationRunError("后台任务操作参数不正确。");
    return NextResponse.json(generationRunAction((await context.params).id, input.action, input));
  }
  catch (error) { return failure(error); }
}
export async function DELETE(req: NextRequest, context: Context) {
  try { return NextResponse.json(deleteGenerationRuns(req.nextUrl.searchParams.get("projectId"), (await context.params).id)); }
  catch (error) { return failure(error); }
}
function failure(error: unknown) { return NextResponse.json({ error: error instanceof Error ? error.message : "后台任务操作失败。", code: error instanceof GenerationRunError ? error.code : "GENERATION_FAILED" }, { status: error instanceof GenerationRunError ? error.status : 500 }); }
