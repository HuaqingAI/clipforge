import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { pipelineRuns, projects } from "@/lib/db/schema";
import { apiError, errText } from "@/lib/api-error";
import { startPipelineRun, isPipelineRunActive, type PipelineLlmConfig } from "@/lib/pipeline-runner";
import { isPipelineStage } from "@/lib/pipeline-stages";
import { getLatestPipelineRun } from "@/lib/pipeline-history";
import { isPremiumProductCgProject } from "@/lib/creative-profiles";

const SAFE_ID = /^[a-zA-Z0-9\-]+$/;

/**
 * Server-side hands-off pipeline (judge → stock-fill → compose) for one project.
 *
 * POST — start (or resume) a run. Idempotent: an already-active run is returned
 * instead of starting a duplicate. body:
 *   { scriptId?, llmConfig?, resume? } — resume:true restarts a failed/interrupted
 *   run from its recorded breakpoint stage instead of the top.
 * GET — latest run for the project. A row stuck in "running" whose executor is
 * gone (server restarted mid-run) is surfaced — and persisted — as failed with
 * interrupted:true so the UI can offer the resume choice.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!id || !SAFE_ID.test(id)) return apiError(req, "无效的项目ID", "Invalid project ID");
    const body = (await req.json().catch(() => ({}))) as {
      scriptId?: unknown;
      llmConfig?: { baseUrl?: unknown; apiKey?: unknown; model?: unknown };
      resume?: unknown;
    };

    const db = getDb();
    // This pipeline judges sales copy, sources stock footage, and starts the legacy
    // free-TTS composer. Premium product CG has a separate controlled storyboard path.
    // Check before inspecting or mutating a prior run so resume/idempotency cannot bypass it.
    const [project] = await db
      .select({ creativeProfile: projects.creativeProfile, videoMode: projects.videoMode })
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1);
    if (project && isPremiumProductCgProject(project)) {
      return NextResponse.json(
        {
          error: errText(
            req,
            "高端产品 CG 不支持带货自动成片流水线，请使用受控分镜 CG 生成流程。",
            "Premium product CG does not allow the sales auto-production pipeline. Use the controlled storyboard CG generation flow.",
          ),
          code: "PREMIUM_CG_OUTPUT_POLICY",
        },
        { status: 400 },
      );
    }
    const latest = getLatestPipelineRun(id);

    // idempotency: one live run per project
    if (latest && latest.status === "running" && isPipelineRunActive(latest.id)) {
      return NextResponse.json({ runId: latest.id, stage: latest.stage, reused: true }, { status: 200 });
    }
    // orphaned running row (process died mid-run) → settle it as failed before starting anew
    if (latest && latest.status === "running" && !isPipelineRunActive(latest.id)) {
      await db
        .update(pipelineRuns)
        .set({ status: "failed", error: "interrupted", updatedAt: new Date() })
        .where(and(eq(pipelineRuns.id, latest.id), eq(pipelineRuns.status, "running")));
      latest.status = "failed";
      if (!latest.error) latest.error = "interrupted";
    }

    const llmConfig: PipelineLlmConfig | undefined =
      body.llmConfig && typeof body.llmConfig.baseUrl === "string" && typeof body.llmConfig.model === "string"
        ? {
            baseUrl: body.llmConfig.baseUrl,
            model: body.llmConfig.model,
            ...(typeof body.llmConfig.apiKey === "string" ? { apiKey: body.llmConfig.apiKey } : {}),
          }
        : undefined;
    const scriptId = typeof body.scriptId === "string" && body.scriptId ? body.scriptId : undefined;

    // resume: pick up from the failed run's recorded stage (and script, unless overridden)
    const resuming = body.resume === true && latest?.status === "failed" && isPipelineStage(latest.stage);
    const runId = await startPipelineRun({
      projectId: id,
      scriptId: scriptId ?? (resuming ? latest?.scriptId ?? undefined : undefined),
      origin: req.nextUrl.origin,
      llmConfig,
      ...(resuming ? { fromStage: latest.stage } : {}),
    });
    return NextResponse.json({ runId, resumed: resuming }, { status: 202 });
  } catch (error) {
    console.error("启动流水线失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "启动流水线失败" },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!id || !SAFE_ID.test(id)) return apiError(req, "无效的项目ID", "Invalid project ID");
    const db = getDb();
    const latest = getLatestPipelineRun(id);
    if (!latest) return NextResponse.json({ run: null });

    let interrupted = false;
    if (latest.status === "running" && !isPipelineRunActive(latest.id)) {
      // executor gone (restart) — settle the row so every consumer sees one truth
      interrupted = true;
      await db
        .update(pipelineRuns)
        .set({ status: "failed", error: "interrupted", updatedAt: new Date() })
        .where(and(eq(pipelineRuns.id, latest.id), eq(pipelineRuns.status, "running")));
      latest.status = "failed";
      if (!latest.error) latest.error = "interrupted";
    }
    return NextResponse.json({ run: { ...latest, interrupted: interrupted || latest.error === "interrupted" } });
  } catch (error) {
    console.error("查询流水线失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "查询流水线失败" },
      { status: 500 }
    );
  }
}
