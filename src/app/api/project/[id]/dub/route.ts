import { resolveCurrentScript } from "@/lib/current-script";
import { NextRequest, NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { scripts as scriptsTable, projects, type Shot } from "@/lib/db/schema";
import { translateShots, translateVoiceovers, defaultVoiceForLang, langName } from "@/lib/script-engine/translate";
import { scriptGenerationMetadata } from "@/lib/script-engine/provenance";
import { apiError, errText } from "@/lib/api-error";
import { lintCreativeProfileShots } from "@/lib/creative-policy-lint";
import {
  checkCreativeProfileContext,
  createCreativeProfileSnapshot,
  isPremiumProductCgProfile,
} from "@/lib/creative-profiles";

const SAFE_ID = /^[a-zA-Z0-9\-]+$/;

/**
 * POST /api/project/[id]/dub — Translate the currently selected script into a target language
 * and save it as a new selected script version (dubbed version).
 * Run a normal compose with the returned recommendedVoice to produce a re-voiced localized version
 * (for overseas distribution: same footage, different markets).
 * Visual search fields retain the original language; the dubbed version reuses the same visuals with only the audio/subtitles swapped.
 * body: { targetLang: string, llmConfig: {baseUrl,apiKey,model}, title? }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id || !SAFE_ID.test(id)) return apiError(req, "无效的项目ID", "Invalid project ID");

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* allow empty body; validated below */
  }
  const targetLang = typeof body.targetLang === "string" ? body.targetLang.trim() : "";
  if (!targetLang) return apiError(req, "请指定 targetLang（如 en/ja/ko/es）", "Please specify targetLang (e.g. en/ja/ko/es)");
  const llmConfig = body.llmConfig as { provider?: string; baseUrl?: string; apiKey?: string; model?: string } | undefined;
  if (!llmConfig?.baseUrl || !llmConfig?.model) {
    return apiError(req, "请配置 LLM 参数（baseUrl、model；本地/免费端点 apiKey 可留空）", "Please configure LLM parameters (baseUrl, model; apiKey may be left empty for local/free endpoints)");
  }

  const translationModel = llmConfig.model;
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (!project) return apiError(req, "项目不存在", "Project not found", 404);

  const rows = await db.select().from(scriptsTable).where(eq(scriptsTable.projectId, id));
  const source = resolveCurrentScript(rows);
  if (!source) return apiError(req, "该项目还没有脚本", "This project has no script yet", 404);
  const shots = (source.shots ?? []) as Shot[];
  const context = checkCreativeProfileContext(project, source);
  if (!context.ok) {
    return NextResponse.json({
      error: context.code === "CREATIVE_CONFIG_STALE"
        ? "The selected script uses an outdated creative configuration. Regenerate it before dubbing."
        : "The selected script does not match the current creative type. Generate a current script before dubbing.",
      code: context.code,
      currentCreationType: context.projectProfile.creationType,
      scriptCreationType: context.scriptProfile.creationType,
      projectRevision: context.projectRevision,
      scriptRevision: context.scriptRevision,
    }, { status: 409 });
  }
  const premiumProfile = isPremiumProductCgProfile(context.scriptProfile) ? context.scriptProfile : undefined;
  if (premiumProfile?.narrationMode === "none") {
    return NextResponse.json({
      error: "This premium product CG script is visual-only and cannot be dubbed.",
      code: "CG_NARRATION_DISABLED",
    }, { status: 409 });
  }
  if (!shots.length) return apiError(req, "脚本没有分镜", "The script has no shots");

  let translated: Shot[];
  try {
    const translationConfig = {
      baseUrl: llmConfig.baseUrl,
      apiKey: llmConfig.apiKey ?? "",
      model: translationModel,
    };
    if (premiumProfile) {
      // CG narration is sparse and must not retime visual product beats during localization.
      const sourceNarration = shots.map((shot) => shot.narration ?? shot.voiceover ?? "");
      const localizedNarration = await translateVoiceovers(sourceNarration, targetLang, translationConfig);
      translated = shots.map((shot, index) => {
        const voiceover = localizedNarration[index] ?? "";
        return {
          ...shot,
          voiceover,
          ...(typeof shot.narration === "string" ? { narration: voiceover } : {}),
        };
      });
      const issues = lintCreativeProfileShots(premiumProfile, translated);
      if (issues.length > 0) {
        return NextResponse.json({
          error: "Translated narration violates the premium product CG policy.",
          code: "CREATIVE_POLICY_VIOLATION",
          issues,
        }, { status: 400 });
      }
    } else {
      translated = await translateShots(shots, targetLang, translationConfig);
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : errText(req, "翻译失败", "Translation failed") }, { status: 502 });
  }
  const totalDuration = translated.reduce((sum, sh) => sum + sh.duration, 0);

  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim().slice(0, 80)
      : `[${langName(targetLang)}] ${source.title ?? "dub"}`.slice(0, 80);

  const [row] = db.transaction((tx) => {
    const [latest] = tx
      .select({ version: scriptsTable.version })
      .from(scriptsTable)
      .where(eq(scriptsTable.projectId, id))
      .orderBy(desc(scriptsTable.version))
      .limit(1)
      .all();
    const nextVersion = (latest?.version ?? 0) + 1;
    tx.update(scriptsTable).set({ selected: false }).where(eq(scriptsTable.projectId, id)).run();
    return tx
      .insert(scriptsTable)
      .values({
        projectId: id,
        version: nextVersion,
        styleType: source.styleType,
        title,
        totalDuration,
        shots: translated,
        selected: true,
        generationMetadata: scriptGenerationMetadata({ provider: llmConfig.provider, model: translationModel }, "translation"),
        // Translation derives from the source script; canonicalize its frozen policy instead of
        // carrying a malformed legacy JSON fragment into a newly created version.
        creativeProfileSnapshot: createCreativeProfileSnapshot(
          context.scriptProfile,
          context.scriptRevision ?? context.projectRevision,
          { styleType: source.styleType, videoMode: project.videoMode },
        ),
      })
      .returning()
      .all();
  });

  return NextResponse.json({
    scriptId: row.id,
    version: row.version,
    targetLang,
    shots: translated.length,
    recommendedVoice: defaultVoiceForLang(targetLang),
  });
}
