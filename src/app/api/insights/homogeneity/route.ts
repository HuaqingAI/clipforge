import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { projects, scripts as scriptsTable } from "@/lib/db/schema";
import { fingerprintOf, homogeneityReport } from "@/lib/structure-fingerprint";

/**
 * GET /api/insights/homogeneity?limit=8 — cross-project template self-check: fingerprints the latest
 * script of the most recent N projects and reports pairwise structural similarity, so creators see
 * "your recent videos are one template" before the platform's duplication detector does.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "8", 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(2, Math.min(20, limitRaw)) : 8;

  const db = getDb();
  const recent = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .orderBy(desc(projects.createdAt))
    .limit(limit);
  if (recent.length < 2) {
    return NextResponse.json({ total: recent.length, similarPairs: [], similarShare: 0, verdict: "ok", message: null });
  }

  const rows = await db
    .select()
    .from(scriptsTable)
    .where(and(inArray(scriptsTable.projectId, recent.map((p) => p.id)), eq(scriptsTable.selected, true)));

  // Only selected scripts describe each project's current video.
  const nameOf = new Map(recent.map((p) => [p.id, p.name] as const));
  const byProject = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const cur = byProject.get(r.projectId);
    if (!cur || (r.selected && !cur.selected) || (r.selected === cur.selected && (r.version ?? 0) > (cur.version ?? 0))) {
      byProject.set(r.projectId, r);
    }
  }

  const fingerprints = [...byProject.values()].map((r) =>
    fingerprintOf({
      projectId: r.projectId,
      projectName: nameOf.get(r.projectId) ?? undefined,
      styleType: r.styleType,
      shots: (r.shots ?? []) as Array<{ duration?: number; type?: string }>,
    })
  );
  return NextResponse.json(homogeneityReport(fingerprints));
}
