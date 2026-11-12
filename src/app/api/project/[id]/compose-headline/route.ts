import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { projects, scripts } from "@/lib/db/schema";
import { resolveCurrentScript } from "@/lib/current-script";
import { checkCreativeProfileContext, isTideweOutdoorProfile, sanitizeCreativeProfile, resolveCreativeProfile } from "@/lib/creative-profiles";
import { assertTideweScript } from "@/lib/tidewe/validation";
import { stripPauseMarks } from "@/lib/voice-markup";
import { generateComposeHeadline, normalizeComposeHeadlineConfig } from "@/lib/server/compose-headline";

/** Explicit title generation. Composition only applies the user's chosen text. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "标题生成请求格式无效" }, { status: 400 });
  }
  const value = body as Record<string, unknown>;
  if (typeof value.scriptId !== "string" || !value.scriptId.trim()) {
    return NextResponse.json({ error: "请先选择当前视频脚本" }, { status: 400 });
  }
  let config;
  try { config = normalizeComposeHeadlineConfig(value.llmConfig); }
  catch { return NextResponse.json({ error: "文字模型配置无效，请检查设置后重试。" }, { status: 400 }); }
  if (!config) return NextResponse.json({ error: "请先在设置中配置文字模型，再点击生成顶部标题。" }, { status: 400 });

  try {
    const db = getDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    const rows = await db.select().from(scripts).where(eq(scripts.projectId, id)).orderBy(desc(scripts.createdAt));
    const script = rows.find(row => row.id === value.scriptId);
    if (!script) return NextResponse.json({ error: "该项目中不存在此脚本" }, { status: 404 });
    if (resolveCurrentScript(rows)?.id !== script.id) {
      return NextResponse.json({ error: "当前脚本已切换，请刷新后重新生成顶部标题。" }, { status: 409 });
    }
    if (!Array.isArray(script.shots) || !script.shots.length) {
      return NextResponse.json({ error: "当前脚本没有可用的口播文案" }, { status: 400 });
    }
    const projectProfile = project.creativeProfile == null ? undefined : resolveCreativeProfile(project.creativeProfile);
    if (projectProfile) {
      const context = checkCreativeProfileContext(project, script);
      if (!context.ok) return NextResponse.json({ error: "当前脚本与项目创作配置不一致，请刷新后重新生成脚本。", code: context.code }, { status: 409 });
    }
    const activeProfile = projectProfile ?? sanitizeCreativeProfile(script.creativeProfileSnapshot?.profile);
    const tidewe = isTideweOutdoorProfile(activeProfile) || script.styleType === "tidewe_outdoor";
    if (tidewe) {
      if (value.voiceoverOverrides !== undefined || value.voiceover !== undefined || value.narration !== undefined
        || script.shots.some(shot => Boolean(shot.narration?.trim()))) {
        return NextResponse.json({ error: "TIDEWE 口播须通过完整文案保存并更新分镜，不能临时覆盖旁白。", code: "TIDEWE_COPY_DOCUMENT_REQUIRED" }, { status: 409 });
      }
      try { assertTideweScript(script); }
      catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "TIDEWE 原文覆盖无效", code: "TIDEWE_SCRIPT_INVALID" }, { status: 409 }); }
    }

    const overrides = new Map<number, string>();
    if (!tidewe && value.voiceoverOverrides !== undefined) {
      if (!Array.isArray(value.voiceoverOverrides) || value.voiceoverOverrides.length > script.shots.length) {
        return NextResponse.json({ error: "镜头口播覆盖格式无效" }, { status: 400 });
      }
      for (const item of value.voiceoverOverrides) {
        if (!item || typeof item !== "object" || Array.isArray(item) || !Number.isSafeInteger(item.shotId)
          || !script.shots.some(shot => shot.shotId === item.shotId) || overrides.has(item.shotId)
          || typeof item.voiceover !== "string") {
          return NextResponse.json({ error: "镜头口播覆盖格式无效" }, { status: 400 });
        }
        const text = item.voiceover.trim().slice(0, 500);
        if (text) overrides.set(item.shotId, text);
      }
    }
    const copy = script.shots.map(shot => {
      const text = tidewe
        ? script.copyDocument!.text.slice(shot.tidewe!.copySpan.start, shot.tidewe!.copySpan.end)
        : overrides.get(shot.shotId) ?? shot.voiceover ?? "";
      return stripPauseMarks(text).trim();
    }).filter(Boolean).join(" ");
    if (!copy) return NextResponse.json({ error: "当前脚本没有可用的口播文案" }, { status: 400 });

    const title = await generateComposeHeadline({ copy, productName: project.productName || undefined }, config);
    return NextResponse.json({ title });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "顶部标题生成失败，请重试。" }, { status: 500 });
  }
}
