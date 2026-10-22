import { NextRequest, NextResponse } from "next/server";
import { assertKlingLocalRequest, klingRouteError } from "@/lib/kling/local-access";
import { selectKlingJobOutput } from "@/lib/kling/jobs";
import { getKlingJob, klingJobView } from "@/lib/kling/repository";
export const runtime = "nodejs";
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; outputId: string }> }) {
  try {
    await assertKlingLocalRequest(req);
    const { id, outputId } = await params;
    await selectKlingJobOutput(id, outputId, await req.json());
    return NextResponse.json({ job: klingJobView(getKlingJob(id)) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return klingRouteError(error); }
}
