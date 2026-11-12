import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { batchJobItems, batchJobs } from "@/lib/db/schema";

/** Read historical sales batch records; new batch creation has been retired. */
export async function GET(req: NextRequest) {
  try {
    const db = getDb();
    const jobId = req.nextUrl.searchParams.get("jobId");
    const activeOnly = req.nextUrl.searchParams.get("active") === "1";

    const [job] = jobId
      ? await db.select().from(batchJobs).where(eq(batchJobs.id, jobId)).limit(1)
      : activeOnly
        ? await db.select().from(batchJobs).where(eq(batchJobs.status, "running")).orderBy(desc(batchJobs.createdAt)).limit(1)
        : await db.select().from(batchJobs).orderBy(desc(batchJobs.createdAt)).limit(1);
    if (!job) return NextResponse.json({ job: null, items: [] });
    const items = await db.select().from(batchJobItems).where(eq(batchJobItems.jobId, job.id));
    return NextResponse.json({ job, items });
  } catch (error) {
    console.error("查询批量任务失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "查询批量任务失败" },
      { status: 500 }
    );
  }
}
