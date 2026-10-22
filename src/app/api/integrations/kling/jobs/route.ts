import { NextRequest, NextResponse } from "next/server";
import { assertKlingLocalRequest, klingRouteError } from "@/lib/kling/local-access";
import { listKlingJobs, klingJobView } from "@/lib/kling/repository";
import { startKlingJobRunner, wakeKlingJobRunner } from "@/lib/kling/jobs";
export const runtime = "nodejs";
export async function GET(req: NextRequest) {
  try {
    await assertKlingLocalRequest(req, false);
    const projectId = req.nextUrl.searchParams.get("projectId") ?? undefined;
    if (projectId && !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) return NextResponse.json({ error: { code: "KLING_INPUT_INVALID", message: "项目编号无效" } }, { status: 400 });
    startKlingJobRunner(); wakeKlingJobRunner();
    return NextResponse.json({ jobs: listKlingJobs(projectId).map(klingJobView) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return klingRouteError(error); }
}
