import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { projects, scripts } from "@/lib/db/schema";
import { apiError, errText } from "@/lib/api-error";
import { scriptRevision } from "@/lib/asset-context";
import { checkCreativeProfileContext, isPremiumProductCgProfile, isTideweOutdoorProfile } from "@/lib/creative-profiles";
import { parseJudgeResponse } from "@/lib/script-judge";
import { actionableJudgeFeedback, buildJudgeApplyPrompt, parseJudgeApplyResponse } from "@/lib/script-judge-apply";
import { completeWithJsonRetry, reasoningParams } from "@/lib/script-engine/generator";
import { createLLMClient, jsonModeParams, llmErrorPair } from "@/lib/llm-error";
import { assertTideweScript } from "@/lib/tidewe/validation";

/** Apply reviewed suggestions atomically to the same saved alternative. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    let body;
    try { body = await req.json(); }
    catch { return apiError(req, "请求内容必须是有效的 JSON", "Request body must be valid JSON", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)
      || typeof body.scriptId !== "string" || typeof body.expectedScriptHash !== "string" || !body.expectedScriptHash
      || !body.report || typeof body.report !== "object") {
      return apiError(req, "缺少脚本、评审报告或原稿版本，请重新评审", "Script, report and source revision are required; run the judges again", 400);
    }
    const { scriptId, expectedScriptHash, llmConfig } = body;
    if (typeof llmConfig?.model !== "string" || !llmConfig.model.trim()) {
      return apiError(req, "缺少 LLM 配置，请先在设置中配置", "Missing LLM configuration", 400);
    }
    const db = getDb();
    const script = db.select().from(scripts).where(and(eq(scripts.id, scriptId), eq(scripts.projectId, id))).get();
    const project = db.select().from(projects).where(eq(projects.id, id)).get();
    if (!script || !project) return apiError(req, "脚本或项目不存在", "Script or project not found", 404);
    const stale = () => NextResponse.json({
      error: errText(req, "脚本或创作配置已变化，请重新运行判官团后再应用", "The script or creative settings changed; run the judges again"),
      code: "SCRIPT_CONTEXT_CHANGED",
    }, { status: 409 });
    const context = checkCreativeProfileContext(project, script);
    if (body.report.sourceScriptHash !== expectedScriptHash
      || !script.selected || scriptRevision(script) !== expectedScriptHash || !context.ok) return stale();
    if (isPremiumProductCgProfile(context.scriptProfile)) {
      return apiError(req, "该创作类型不提供判官团修改", "Judge edits are not available for this creation type", 400);
    }
    const tideweProfile = isTideweOutdoorProfile(context.scriptProfile) ? context.scriptProfile : null;
    if (tideweProfile) assertTideweScript(script, tideweProfile.presenter ?? null);
    const report = parseJudgeResponse(JSON.stringify(body.report), script.shots ?? []);
    if (!actionableJudgeFeedback(report).length) {
      return apiError(req, "没有需要应用的修改意见，品味建议仍保留供参考", "No actionable feedback; taste suggestions remain for review", 400);
    }
    const config = { baseUrl: typeof llmConfig.baseUrl === "string" ? llmConfig.baseUrl : "", apiKey: typeof llmConfig.apiKey === "string" ? llmConfig.apiKey : "", model: llmConfig.model };
    const update = await completeWithJsonRetry(createLLMClient(config), {
      model: config.model,
      messages: [{ role: "user", content: buildJudgeApplyPrompt(script, report) }],
      temperature: 0.3,
      max_tokens: 16000,
      ...reasoningParams(config.baseUrl),
      ...jsonModeParams(config.baseUrl),
    }, config, (content) => parseJudgeApplyResponse(content, script, report));

    return db.transaction((tx) => {
      const current = tx.select().from(scripts).where(and(eq(scripts.id, scriptId), eq(scripts.projectId, id))).get();
      const currentProject = tx.select().from(projects).where(eq(projects.id, id)).get();
      if (!current || !currentProject) return stale();
      const currentContext = checkCreativeProfileContext(currentProject, current);
      if (!current.selected || scriptRevision(current) !== expectedScriptHash || !currentContext.ok
        || (currentProject.creativeConfigRevision ?? 1) !== (project.creativeConfigRevision ?? 1)) return stale();
      if (tideweProfile && isTideweOutdoorProfile(currentContext.scriptProfile)) {
        assertTideweScript({ ...current, ...update }, currentContext.scriptProfile.presenter ?? null);
      }
      const updated = tx.update(scripts).set(update).where(eq(scripts.id, scriptId)).returning().get()!;
      return NextResponse.json({ success: true, script: { ...updated, scriptHash: scriptRevision(updated) } });
    }, { behavior: "immediate" });
  } catch (error) {
    const { zh, en } = llmErrorPair(error);
    return NextResponse.json({ error: errText(req, zh || "按建议修改失败，请重试", en || "Could not apply the judge suggestions; please retry") }, { status: 502 });
  }
}
