import { NextRequest, NextResponse } from "next/server";
import { assertKlingLocalRequest, klingRouteError } from "@/lib/kling/local-access";
import { getKlingJob, klingJobView } from "@/lib/kling/repository";
import { startKlingJobRunner, wakeKlingJobRunner } from "@/lib/kling/jobs";
import { deleteKlingJob } from "@/lib/kling/delete-job";
export const runtime = "nodejs";
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await assertKlingLocalRequest(req, false);
    const { id } = await params;
    startKlingJobRunner(); wakeKlingJobRunner();
    return NextResponse.json(klingJobView(getKlingJob(id)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return klingRouteError(error); }
}
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await assertKlingLocalRequest(req, true);
    const { id } = await params;
    return NextResponse.json(deleteKlingJob(id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return klingRouteError(error); }
}
