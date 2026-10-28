import { resolveCurrentScript } from "@/lib/current-script";
import { NextRequest, NextResponse } from "next/server";
import { getDataDir, fileNameOf } from "@/lib/paths";
import { ffprobeBin, ffmpegBin } from "@/lib/ffmpeg-path";
import { join } from "path";
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { generateSpeech, estimateSpeechSeconds, type TTSConfig } from "@/lib/tts";
import { stripPauseMarks } from "@/lib/voice-markup";
import { shotEmotion, EMOTION_TTS } from "@/lib/emotion-acting";
import { generateSpeechFreeDetailed, type TTSWord } from "@/lib/edge-tts";
import { resolveRenderProfile, isRenderPreset } from "@/lib/compose-presets";
import { isCaptionPreset, captionPresetOverrides, CAPTION_PRESETS } from "@/lib/caption-presets";
import { getDb } from "@/lib/db";
import { scripts as scriptsTable, assets as assetsTable, projects, compositions } from "@/lib/db/schema";
import { filterAssetsForScript } from "@/lib/asset-context";
import { eq } from "drizzle-orm";
import { composeVideo, resolveChineseFontFamily, type ClipInput, type ComposeConfig } from "@/lib/video-composer/composer";
import { extractFirstFrame } from "@/lib/video-composer/frame-extract";
import { buildSubtitleTimeline, padDurationsForFade, segmentBoundaries, type TimelineSegment } from "@/lib/video-composer/timeline";
import { buildKaraokeAss } from "@/lib/video-composer/karaoke";
import { isAudibleFromVolumedetect } from "@/lib/video-composer/audio-probe";
import { buildComplianceOverlays } from "@/lib/compliance-overlays";
import { resolveBgmMix } from "@/lib/audio-mix";
import { renderAudioStems } from "@/lib/audio-stems";
import type { Shot, ScriptCharacter } from "@/lib/db/schema";
import { assignCharacterVoices } from "@/lib/character-voices";
import { desc, and } from "drizzle-orm";
import { readCompositionError, saveCompositionError } from "@/lib/composition-error";
import {
  isPremiumProductCgProfile,
  isTideweOutdoorProfile,
  isTideweNativeSpeech,
  sanitizeCreativeProfile,
  checkCreativeProfileContext,
} from "@/lib/creative-profiles";
import { lintCreativeProfileShots } from "@/lib/creative-policy-lint";
import {
  filterTrustedPremiumCgAssets,
  hasTrustedPremiumCgAssetProvenance,
  PREMIUM_CG_ASSET_PROVENANCE_REQUIRED,
} from "@/lib/premium-cg-assets";
import { resolveNarrationVoice } from "@/lib/narration-voice";
import { assertTideweScript } from "@/lib/tidewe/validation";
import { assertTideweMediaDuration } from "@/lib/tidewe/visual-policy";
import { validateElevenLabsConfig } from "@/lib/elevenlabs/config";
import { assertElevenLabsLocalRequest, elevenLabsRouteError } from "@/lib/elevenlabs/local-access";

type ComposeRequestBody = {
  scriptId?: unknown;
  shotAssetSelections?: unknown;
  transitionOverrides?: unknown;
  exportAudioStems?: boolean;
  voiceoverOverrides?: Array<{ shotId: number; voiceover: string }>;
  ttsConfig?: TTSConfig;
  freeTts?: { enabled?: boolean; voice?: string; rate?: string };
  voiceoverMode?: "auto" | "replace" | "mix";
  renderPreset?: unknown;
  captionPreset?: unknown;
  subtitles?: unknown;
  resolution?: "720p" | "1080p" | string;
  aspectRatio?: "9:16" | "16:9" | "1:1" | string;
  aigcBadge?: boolean;
  label?: string;
  ctaText?: string;
  aigcBadgeText?: string;
  bgmPath?: string;
  bgmVolume?: number;
  bgmDuck?: boolean;
  voiceGround?: boolean;
  karaoke?: boolean;
  productCard?: boolean;
  /** Persisted profile when an older client cannot load the project record yet. */
  creativeProfile?: unknown;
  /** Compatibility policy accepted during the profile rollout. */
  outputPolicy?: unknown;
  ttsEnabled?: unknown;
  ctaEnabled?: unknown;
  editorialGraphics?: unknown;
  [key: string]: unknown;
};

// 获取该项目最新一条合成记录（导出页读取真实成片）
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    // 可选 ?compositionId：精确取某一次合成（A/B 多变体顺序重渲时按 id 轮询，避免 GET 返回 latest 的竞态串号）
    const compositionId = req.nextUrl.searchParams.get("compositionId");
    const rows = compositionId
      ? await db
          .select()
          .from(compositions)
          .where(and(eq(compositions.projectId, id), eq(compositions.id, compositionId)))
          .limit(1)
      : await db
          .select()
          .from(compositions)
          .where(eq(compositions.projectId, id))
          .orderBy(desc(compositions.createdAt))
          .limit(1);
    if (rows.length === 0) {
      return NextResponse.json({ composition: null });
    }
    const c = rows[0];
    const error = c.status === "failed" ? await readCompositionError(c.projectId, c.id) : null;
    // separator-agnostic: Windows rows store backslash absolute paths (issue #15)
    const fileName = fileNameOf(c.outputPath);
    const timelineUrl = fileName ? `/api/output/${id}/${encodeURIComponent(`${fileName}.timeline.json`)}` : null;
    return NextResponse.json({
      composition: {
        ...c,
        fileName,
        url: fileName ? `/api/output/${id}/${fileName}` : null,
        timelineUrl,
        ...(error ? { error } : {}),
      },
    });
  } catch (error) {
    console.error("获取合成记录失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "获取合成记录失败" },
      { status: 500 }
    );
  }
}

/** 把 /api/files/{pid}/{file} 形式的访问路径还原为本地磁盘绝对路径 */
function toLocalPath(fileRef: string | undefined): string | undefined {
  if (!fileRef) return undefined;
  const m = fileRef.match(/\/api\/files\/(.+)/);
  if (!m) return undefined;
  const p = join(getDataDir(), "uploads", m[1]);
  return existsSync(p) ? p : undefined;
}

/** 按镜头类型给商品原图分镜分配一个默认运镜 */
function defaultMotion(shot: Shot): string {
  if (shot.motion) return shot.motion;
  switch (shot.type) {
    case "hook":
      return "zoom_in_slow";
    case "product_reveal":
      return "ken_burns";
    case "demo":
      return "pan_right";
    case "cta":
      return "static";
    default:
      return "ken_burns";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The profile migration briefly has two client shapes in circulation. The
 * persisted project profile wins; request policy is only a fallback for callers
 * that have not yet loaded that project field.
 */
function profileFromSnapshot(value: unknown): unknown {
  return isRecord(value) ? value.profile : undefined;
}

function forbidsAddedFrameText(value: unknown): boolean {
  if (value === "forbid-added") return true;
  if (!isRecord(value)) return false;
  if (value.generatedFrameText === "forbid-added" || value.textPolicy === "forbid-added") return true;
  return isRecord(value.textPolicy) && value.textPolicy.generatedFrameText === "forbid-added";
}

function premiumCgComposeConflicts(body: ComposeRequestBody, narrationMode: "none" | "restrained"): boolean {
  const freeTtsEnabled = isRecord(body.freeTts) && body.freeTts.enabled === true;
  const requestedTtsConfig = isRecord(body.ttsConfig) && Object.keys(body.ttsConfig).length > 0;
  const requestedVoiceoverOverride = Array.isArray(body.voiceoverOverrides) && body.voiceoverOverrides.length > 0;
  const customAigcBadgeText = typeof body.aigcBadgeText === "string" && body.aigcBadgeText.trim().length > 0;
  return body.subtitles === true
    || body.karaoke === true
    || body.captionPreset === "karaoke"
    || body.productCard === true
    || body.textOverlay !== undefined
    || body.textOverlays !== undefined
    || body.ctaEnabled === true
    || body.editorialGraphics === true
    || (typeof body.ctaText === "string" && body.ctaText.trim().length > 0)
    || customAigcBadgeText
    || (narrationMode === "none" && (
      body.ttsEnabled === true
      || freeTtsEnabled
      || requestedTtsConfig
      || requestedVoiceoverOverride
      || body.voiceoverMode === "replace"
      || body.voiceoverMode === "mix"
    ))
    || (narrationMode === "restrained" && (
      // The profile owns the voice and replacement policy. Accepting a caller
      // supplied provider or mix mode would let an old sales UI bypass it.
      freeTtsEnabled
      || requestedTtsConfig
      || requestedVoiceoverOverride
      || body.ttsEnabled === true
      || body.voiceoverMode === "mix"
    ));
}

// 合成视频：读取已选脚本分镜 + 已生成素材，用 FFmpeg 合成带运镜与中文字幕的成片
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const parsedBody = await req.json().catch(() => null);
    const body: ComposeRequestBody = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
      ? parsedBody as ComposeRequestBody
      : {};
    if (body.subtitles !== undefined && typeof body.subtitles !== "boolean") {
      return NextResponse.json({ error: "字幕开关格式无效，请选择是否使用字幕" }, { status: 400 });
    }
    const requestedSubtitles = body.subtitles !== false;
    const exportAudioStems = body.exportAudioStems === true;
    const db = getDb();

    // 读取项目（拿商品图兜底）与已选脚本
    const projRows = await db.select().from(projects).where(eq(projects.id, id));
    if (projRows.length === 0) {
      return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    }
    const project = projRows[0];
    const productImages = (project.productImages ?? []) as string[];

    const scriptRows = await db.select().from(scriptsTable).where(eq(scriptsTable.projectId, id)).orderBy(desc(scriptsTable.createdAt));
    const selected = resolveCurrentScript(scriptRows);
    if (!selected || !Array.isArray(selected.shots) || selected.shots.length === 0) {
      return NextResponse.json({ error: "尚未生成脚本，无法合成" }, { status: 400 });
    }
    if (body.scriptId !== undefined && body.scriptId !== selected.id) {
      return NextResponse.json({ error: "当前脚本已切换，请刷新后重新选择镜头视频" }, { status: 409 });
    }
    const projectProfile = sanitizeCreativeProfile(project.creativeProfile);
    const scriptSnapshotProfile = sanitizeCreativeProfile(profileFromSnapshot(selected.creativeProfileSnapshot));

    // A script snapshot is immutable provenance. Reject a type/revision
    // mismatch before touching assets or creating a composition. Snapshotless
    // rows are classified as legacy sales by the shared checker, so a stale
    // sales script cannot enter a current CG production path.
    if (projectProfile) {
      const context = checkCreativeProfileContext(
        {
          creativeProfile: projectProfile,
          videoMode: project.videoMode,
          creativeConfigRevision: project.creativeConfigRevision,
        },
        {
          styleType: selected.styleType,
          creativeProfileSnapshot: selected.creativeProfileSnapshot,
        },
      );
      if (!context.ok) {
        return NextResponse.json(
          {
            error: context.code === "CREATIVE_PROFILE_MISMATCH"
              ? "当前项目创作类型与脚本快照不一致，请重新生成脚本"
              : "当前脚本使用的是旧版创作配置，请重新生成脚本",
            code: context.code,
            projectCreationType: context.projectProfile.creationType,
            scriptCreationType: context.scriptProfile.creationType,
            projectRevision: context.projectRevision,
            scriptRevision: context.scriptRevision,
          },
          { status: 409 },
        );
      }
    }

    // The persisted project profile is authoritative. A snapshot is a fallback
    // only for migrated rows whose project profile is still null. Request body
    // policy values are accepted solely for old clients with no persisted data.
    const bodyProfile = sanitizeCreativeProfile(body.creativeProfile) ?? sanitizeCreativeProfile(body.outputPolicy);
    const activeProfile = projectProfile ?? scriptSnapshotProfile ?? bodyProfile;
    const tidewe = isTideweOutdoorProfile(activeProfile);
    const tideweNative = isTideweNativeSpeech(activeProfile);
    if (tidewe) {
      if (body.voiceoverOverrides !== undefined || body.narration !== undefined || body.voiceover !== undefined
        || selected.shots.some((shot) => Boolean(shot.narration?.trim()))) {
        return NextResponse.json({ error: "TIDEWE 口播须通过完整文案保存并更新分镜，不能临时覆盖旁白。", code: "TIDEWE_COPY_DOCUMENT_REQUIRED" }, { status: 409 });
      }
      try { assertTideweScript(selected); }
      catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "TIDEWE 原文覆盖无效", code: "TIDEWE_SCRIPT_INVALID" }, { status: 409 }); }
      if (body.productCard === true || body.ctaEnabled === true || (typeof body.ctaText === "string" && body.ctaText.trim())) {
        return NextResponse.json({ error: "TIDEWE 使用文案中的自然推荐，不叠加默认购买条或商品卡。", code: "TIDEWE_OUTPUT_POLICY" }, { status: 400 });
      }
    }
    const premiumProfile = activeProfile?.creationType === "premium_product_cg" ? activeProfile : undefined;
    const premiumCg = Boolean(premiumProfile)
      || (!activeProfile && (isPremiumProductCgProfile(body.creativeProfile) || isPremiumProductCgProfile(body.outputPolicy)
        || forbidsAddedFrameText(body.creativeProfile) || forbidsAddedFrameText(body.outputPolicy)));
    const narrationMode: "none" | "restrained" = premiumProfile?.narrationMode ?? "none";
    if (premiumCg && premiumCgComposeConflicts(body, narrationMode)) {
      return NextResponse.json(
        { error: "高端产品 CG 不支持字幕、编辑性文字、购买 CTA 或商品卡；旁白由创作档案统一控制", code: "PREMIUM_CG_OUTPUT_POLICY" },
        { status: 400 },
      );
    }
    // A premium CG project is visual-first. Omitted switches resolve to the
    // profile's locked-off output policy; legacy projects preserve their default.
    const subtitles = premiumCg ? false : requestedSubtitles;
    let shots = selected.shots as Shot[];
    if (tidewe) {
      // The copy document owns executable narration; never prefer legacy narration fields.
      const text = selected.copyDocument!.text;
      shots = shots.map((shot) => {
        const clean = { ...shot, voiceover: text.slice(shot.tidewe!.copySpan.start, shot.tidewe!.copySpan.end).trim() };
        delete clean.narration;
        delete clean.textOverlay;
        return clean;
      });
    }
    if (premiumProfile) {
      // A silent CG profile deliberately discards historical sales narration.
      // Restrained mode checks exactly the line that will reach controlled TTS
      // (`narration` has precedence over legacy `voiceover`).
      const policyShots = shots.map((shot) => {
        if (premiumProfile.narrationMode === "none") {
          return { ...shot, voiceover: "", narration: "" };
        }
        const narration = typeof shot.narration === "string" && shot.narration.trim()
          ? shot.narration.trim()
          : shot.voiceover;
        return { ...shot, voiceover: narration, narration: "" };
      });
      const issues = lintCreativeProfileShots(premiumProfile, policyShots);
      // textOverlay is removed below as a legacy executable field. Visual
      // copy/marketing instructions and promotional narration require a fresh
      // script instead of being silently rewritten at compose time.
      const blocking = issues.filter((issue) => issue.code !== "text_overlay");
      if (blocking.length > 0) {
        return NextResponse.json(
          { error: "高端产品 CG 脚本包含新增文字或营销指令，请重新生成脚本", code: "CREATIVE_POLICY_VIOLATION", issues: blocking },
          { status: 400 },
        );
      }
    }
    // Transitions describe entry into the named shot and affect this render only.
    if (body.transitionOverrides !== undefined) {
      if (!Array.isArray(body.transitionOverrides) || body.transitionOverrides.length > shots.length) {
        return NextResponse.json({ error: "镜头转场设置格式无效" }, { status: 400 });
      }
      const validShotIds = new Set(shots.map((shot) => shot.shotId));
      const transitionByShot = new Map<number, "direct_concat" | "ffmpeg_fade">();
      for (const item of body.transitionOverrides) {
        if (!item || typeof item !== "object" || Array.isArray(item)
          || !Number.isSafeInteger(item.shotId) || !validShotIds.has(item.shotId)
          || transitionByShot.has(item.shotId)
          || (item.transition !== "direct_concat" && item.transition !== "ffmpeg_fade")) {
          return NextResponse.json({ error: "镜头转场设置格式无效，请为每个镜头选择直接拼接或渐变过渡" }, { status: 400 });
        }
        transitionByShot.set(item.shotId, item.transition);
      }
      shots = shots.map((shot) => {
        const transition = transitionByShot.get(shot.shotId);
        return transition ? { ...shot, transition } : shot;
      });
    }
    // Native dialogue has no verified silent handles for a cross-fade. Hard cuts
    // preserve every recorded word and keep the original lips and audio together.
    if (tideweNative) shots = shots.map((shot) => ({ ...shot, transition: "direct_concat" }));
    // Variant-matrix voiceover overrides for hook A/B: applied in memory
    // for this render only — the stored script stays untouched, so each variant compose can
    // carry a different hook copy without mutating the project.
    const voiceoverOverrides = body.voiceoverOverrides as Array<{ shotId: number; voiceover: string }> | undefined;
    if (Array.isArray(voiceoverOverrides) && voiceoverOverrides.length > 0) {
      const overrideByShot = new Map<number, string>();
      for (const o of voiceoverOverrides) {
        if (o && typeof o.shotId === "number" && typeof o.voiceover === "string") {
          overrideByShot.set(o.shotId, o.voiceover.trim().slice(0, 500));
        }
      }
      shots = shots.map((s) => {
        const v = overrideByShot.get(s.shotId);
        return v ? { ...s, voiceover: v } : s;
      });
    }
    if (premiumCg) {
      // Stored overlays, presenter anchors, and sales voiceover fields are
      // executable controls from older templates. Normalize them in memory so
      // a render cannot reintroduce copy without mutating the saved script.
      shots = shots.map((shot) => {
        const clean: Shot = { ...shot };
        delete clean.textOverlay;
        delete clean.characterId;
        if (narrationMode === "none") {
          clean.voiceover = "";
          delete clean.narration;
        } else {
          clean.voiceover = typeof clean.narration === "string" && clean.narration.trim()
            ? clean.narration.trim()
            : clean.voiceover?.trim() ?? "";
          delete clean.narration;
        }
        return clean;
      });
    }
    // Dialogue-script cast (drama style): deterministic per-character Edge voices, free multi-voice
    // dialogue. Narrator shots (no characterId) keep the default/free voice below.
    const scriptCharacters = (selected.characters ?? []) as ScriptCharacter[];
    const characterVoices = assignCharacterVoices(tidewe ? [] : scriptCharacters);
    if (characterVoices.size > 0) {
      console.info(
        `[compose] 剧情多音色：${scriptCharacters.map((c) => `${c.name}→${characterVoices.get(c.id)}`).join("、")}`
      );
    }

    // 已生成的素材（assets 表，按 shotId 索引）
    const scopedAssetRows = filterAssetsForScript(
      await db.select().from(assetsTable).where(eq(assetsTable.projectId, id)).orderBy(desc(assetsTable.createdAt)),
      selected,
    );
    const assetRows = premiumCg
      ? filterTrustedPremiumCgAssets(scopedAssetRows, id, selected)
      : scopedAssetRows;
    const assetByShot = new Map<number, string>();
    const assetAudioModeByShot = new Map<number, string>();
    for (const a of assetRows) {
      if (tidewe && a.selected && a.type === "stock_footage" && shots.find((shot) => shot.shotId === a.shotId)?.tidewe?.productVisible !== false) {
        return NextResponse.json({ error: `镜头 ${a.shotId} 是产品镜，不能使用相似库存装备冒充商品。`, code: "TIDEWE_PRODUCT_REFERENCE_REQUIRED" }, { status: 409 });
      }
      if (a.selected && a.status === "done" && a.filePath && !assetByShot.has(a.shotId)) {
        assetByShot.set(a.shotId, a.filePath);
        if (a.generationPlan?.audioMode) assetAudioModeByShot.set(a.shotId, a.generationPlan.audioMode);
      }
    }
    // Pin each requested take before starting background work. null pins product-image fallback.
    // A missing/deleted take must
    // ask the user to reselect instead of silently rendering a different video or product image.
    const pinnedShotIds = new Set<number>();
    if (body.shotAssetSelections !== undefined) {
      if (!Array.isArray(body.shotAssetSelections) || body.shotAssetSelections.length > shots.length) {
        return NextResponse.json({ error: "镜头视频选择格式无效" }, { status: 400 });
      }
      const seenShots = new Set<number>();
      for (const item of body.shotAssetSelections) {
        if (!item || typeof item !== "object" || Array.isArray(item)
          || !Number.isSafeInteger(item.shotId) || !shots.some((shot) => shot.shotId === item.shotId)
          || (item.assetId !== null && (typeof item.assetId !== "string" || !/^[a-zA-Z0-9-]+$/.test(item.assetId)))
          || seenShots.has(item.shotId)) {
          return NextResponse.json({ error: "镜头视频选择格式无效，请为每个镜头选择一个版本" }, { status: 400 });
        }
        seenShots.add(item.shotId);
        if (item.assetId === null) {
          assetByShot.delete(item.shotId);
          assetAudioModeByShot.delete(item.shotId);
          continue;
        }
        pinnedShotIds.add(item.shotId);
        const asset = scopedAssetRows.find((row) => row.id === item.assetId && row.shotId === item.shotId);
        if (tidewe && asset?.type === "stock_footage" && shots.find((shot) => shot.shotId === item.shotId)?.tidewe?.productVisible !== false) {
          return NextResponse.json({ error: `镜头 ${item.shotId} 的库存素材不能作为 TIDEWE 商品展示。`, code: "TIDEWE_PRODUCT_REFERENCE_REQUIRED" }, { status: 409 });
        }
        if (premiumCg && asset && !hasTrustedPremiumCgAssetProvenance(asset, id, selected)) {
          return NextResponse.json(
            {
              error: "Premium product CG can only compose controlled storyboard or Kling outputs from the current script.",
              code: PREMIUM_CG_ASSET_PROVENANCE_REQUIRED,
            },
            { status: 409 },
          );
        }
        if (!asset || asset.status !== "done" || !asset.filePath || !toLocalPath(asset.filePath)) {
          return NextResponse.json({ error: `镜头 ${item.shotId} 选择的素材已失效，请刷新后重新选择` }, { status: 409 });
        }
        assetByShot.set(item.shotId, asset.filePath);
        assetAudioModeByShot.set(item.shotId, asset.generationPlan?.audioMode ?? "");
      }
    }

    // Omitted switches retain the profile's automatic narration defaults. An
    // explicit false is the user's choice to use only the source recording.
    const ttsEnabled = body.ttsEnabled !== false;
    // 可选 TTS 配音配置（前端从设置带入）
    let ttsConfig: TTSConfig | undefined;
    if (!premiumCg && ttsEnabled && body.ttsConfig?.provider === "elevenlabs-cli") {
      // An explicit CLI selection must never become the implicit Edge fallback
      // when its voice or model is missing, including on TIDEWE projects.
      const validation = validateElevenLabsConfig(body.ttsConfig);
      if (!validation.ok) return NextResponse.json({ error: validation.error, code: "ELEVENLABS_CONFIG_INVALID" }, { status: 400 });
      try { await assertElevenLabsLocalRequest(req); }
      catch (error) { return elevenLabsRouteError(error); }
      ttsConfig = validation.config;
    } else if (!premiumCg && ttsEnabled && body.ttsConfig?.baseUrl && body.ttsConfig?.apiKey && body.ttsConfig?.model && body.ttsConfig?.voice) {
      ttsConfig = body.ttsConfig;
    }
    // 免费配音兜底（微软 Edge keyless TTS，无需 Key）：未配付费 TTS 时让「一句话主题成片」也能出声
    const freeTts = premiumCg ? undefined : body.freeTts as { enabled?: boolean; voice?: string; rate?: string } | undefined;
    // Restrained CG narration is a controlled post-production voice track. It
    // uses the keyless Edge voice without exposing provider/voice switches to
    // the request, and always replaces model-native speech when present.
    const usePremiumRestrainedTts = Boolean(premiumProfile && narrationMode === "restrained");
    // TIDEWE defaults to an English narration fallback. Whether it is needed is
    // decided from the chosen mode and each clip's audible audio and intent.
    const useFreeTts = usePremiumRestrainedTts || (!premiumCg && ttsEnabled && !ttsConfig && (tidewe || freeTts?.enabled === true));
    // Both extra switches are off in auto mode: audible source audio takes priority.
    const voiceoverMode = usePremiumRestrainedTts
      ? "replace"
      : !premiumCg && (body.voiceoverMode === "auto" || body.voiceoverMode === "replace" || body.voiceoverMode === "mix")
        ? body.voiceoverMode
        : tidewe && !tideweNative ? "replace" : "auto";
    let freeVoice: string;
    try { freeVoice = resolveNarrationVoice(activeProfile, freeTts?.voice); }
    catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "英语音色无效", code: "TIDEWE_VOICE_INVALID" }, { status: 400 }); }
    if (tidewe && ttsConfig && /^(?:zh|ja|ko)-/i.test(ttsConfig.voice)) {
      return NextResponse.json({ error: "TIDEWE 英文口播不能使用此非英语音色。", code: "TIDEWE_VOICE_INVALID" }, { status: 400 });
    }
    const freeRate = typeof freeTts?.rate === "string" ? freeTts.rate : undefined;
    const ttsDir = join(getDataDir(), "uploads", id, "tts");
    if (ttsConfig || useFreeTts) await mkdir(ttsDir, { recursive: true });

    /** 探测视频文件是否带「可听见」的音轨（自带语音/音效）；仅静音/空轨不算，让免费 TTS 旁白照常生效 */
    async function videoHasAudio(filePath: string): Promise<boolean> {
      try {
        const { exec } = await import("child_process");
        const { promisify } = await import("util");
        const execAsync = promisify(exec);
        // 1) 先看有没有音频流
        const { stdout } = await execAsync(
          `"${ffprobeBin()}" -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "${filePath}"`
        );
        if (stdout.trim().length === 0) return false;
        // 2) 有流再用 volumedetect 看是否真有声音（静音轨按无音频处理，避免吞掉 TTS 旁白）
        const { stderr } = await execAsync(
          `"${ffmpegBin()}" -i "${filePath}" -af volumedetect -f null -`
        );
        return isAudibleFromVolumedetect(stderr);
      } catch {
        return false;
      }
    }

    /** 探测媒体时长（秒），失败返回 0 */
    async function probeDuration(filePath: string): Promise<number> {
      try {
        const { exec } = await import("child_process");
        const { promisify } = await import("util");
        const execAsync = promisify(exec);
        const { stdout } = await execAsync(
          `"${ffprobeBin()}" -v error -show_entries format=duration -of csv=p=0 "${filePath}"`
        );
        return parseFloat(stdout.trim()) || 0;
      } catch {
        return 0;
      }
    }

    // Structured degradation log for this render (in-memory for now; persisted into the
    // .timeline.json sidecar so tooling can surface which shots degraded and why)
    const composeWarnings: { code: "tts_fallback_free" | "tts_failed"; shotId: number }[] = [];

    /**
     * 为某分镜生成配音并落地为本地 mp3；ElevenLabs 或 TIDEWE 失败时阻断合成。
     * 返回 { file, words }：words 为免费 Edge 引擎回传的词级时间戳（卡拉OK真同步用），付费引擎无词数据。
     * 其他付费 TTS 保留原有免费 Edge 兜底，并记录 tts_fallback_free 警告。
     * ElevenLabs 需保持用户选定的克隆声音，错误交给用户修复后重试。
     * characterVoice：剧情脚本中该镜说话角色的专属音色（仅免费 Edge 路径生效——付费 TTS 配置是
     * 单音色的，保持旁白音色以免半路换声）。
     */
    async function buildVoiceover(
      shotId: number,
      text: string,
      characterVoice?: string,
      shotType?: string
    ): Promise<{ file: string; words?: TTSWord[] } | undefined> {
      if (!text || (!ttsConfig && !useFreeTts)) return undefined;
      const freeOpts = { voice: characterVoice || freeVoice, rate: freeRate };
      // per-shot expressive delivery for paid engines that support it (hook → eager,
      // pain_point → troubled, cta → confident); providers without the capability
      // silently ignore these fields inside generateSpeech
      const emo = !tidewe && shotType ? shotEmotion(shotType) : undefined;
      const expressive = emo ? { emotion: EMOTION_TTS[emo].minimax, instruction: EMOTION_TTS[emo].instruction } : {};
      try {
        // 付费 TTS 优先；否则走免费 Edge keyless TTS（速度映射：speed 倍率 → SSML 带符号百分比）
        let audio: Buffer;
        let words: TTSWord[] | undefined;
        if (ttsConfig) {
          try {
            audio = await generateSpeech(text, { ...ttsConfig, ...expressive });
          } catch (e) {
            if (tidewe || ttsConfig.provider === "elevenlabs-cli") throw e;
            console.warn(`分镜 ${shotId} 付费配音失败，回退免费 Edge 配音:`, e);
            composeWarnings.push({ code: "tts_fallback_free", shotId });
            const d = await generateSpeechFreeDetailed(text, freeOpts);
            audio = d.audio;
            words = d.words.length > 0 ? d.words : undefined;
          }
        } else {
          const d = await generateSpeechFreeDetailed(text, freeOpts);
          audio = d.audio;
          words = d.words.length > 0 ? d.words : undefined;
        }
        const file = join(ttsDir, `shot-${shotId}.mp3`);
        await writeFile(file, audio);
        return { file, words };
      } catch (e) {
        if (ttsConfig?.provider === "elevenlabs-cli") throw new Error(`镜头 ${shotId} ElevenLabs 配音失败，请检查本机登录、声音权限和额度后重试：${e instanceof Error ? e.message : "未知错误"}`);
        if (tidewe) throw new Error(`镜头 ${shotId} 英文配音失败，请修复声音服务后重试：${e instanceof Error ? e.message : "未知错误"}`);
        console.warn(`分镜 ${shotId} 配音生成失败（已跳过）:`, e);
        composeWarnings.push({ code: "tts_failed", shotId });
        return undefined;
      }
    }

    // 廉价预检：至少一个分镜有可用素材（避免返回 202 后才发现没素材）
    const fallbackFor = (shot: Shot) => (tideweNative && shot.voiceover?.trim()) || (tidewe && shot.tidewe?.productVisible === false) ? undefined : productImages[0];
    const hasAnyAsset = shots.some((s) => toLocalPath(assetByShot.get(s.shotId) ?? fallbackFor(s)));
    if (!hasAnyAsset) {
      return NextResponse.json(
        { error: "没有可用素材，请先在素材步骤生成素材或上传商品图" },
        { status: 400 }
      );
    }

    // 渲染质量预设（快速/标准/高清）→ 分辨率 + 编码参数；只有「合法」预设才顶替 body.resolution，
    // 否则非法预设字符串会静默把用户显式选的 720p 顶成 1080p。
    const validPreset = isRenderPreset(body.renderPreset) ? body.renderPreset : undefined;
    // caption style preset (standard/bold/minimal/karaoke); invalid values fall back to the default look
    const captionPresetRaw: unknown = body.captionPreset;
    const captionPreset = isCaptionPreset(captionPresetRaw) ? captionPresetRaw : undefined;
    const profile = resolveRenderProfile(validPreset);
    const resolution: "720p" | "1080p" = validPreset
      ? profile.resolution
      : body.resolution === "720p"
        ? "720p"
        : "1080p";
    const outputCfg = {
      resolution,
      aspectRatio: (typeof body.aspectRatio === "string" && ["9:16", "16:9", "1:1"].includes(body.aspectRatio) ? body.aspectRatio : "9:16") as "9:16" | "16:9" | "1:1",
      videoPreset: profile.videoPreset,
      crf: profile.crf,
    };

    // The AIGC disclosure is a deterministic compliance layer, not generated
    // marketing copy. Premium CG may explicitly enable it; custom wording is
    // rejected above so the platform default remains stable.
    const aigcBadge = body.aigcBadge === true;

    // Variant label (variant-matrix batch renders): surfaces on the export page's output list
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 60) : undefined;

    // 立即建合成记录(composing)并返回；重活(TTS+FFmpeg)后台异步跑，前端轮询 GET 获取结果
    const [comp] = await db
      .insert(compositions)
      .values({ projectId: id, resolution: outputCfg.resolution, aspectRatio: outputCfg.aspectRatio, aigcBadge, ...(label && { label }), ...(tideweNative ? { ttsEnabled: false } : {}), status: "composing" })
      .returning();
    await db.update(projects).set({ status: "composing", updatedAt: new Date() }).where(eq(projects.id, id));

    // 后台异步合成（不阻塞请求，避免长视频超时）
    void (async () => {
     try {
    // Breathing gap in seconds between the end of one narration and the start of the next;
    // the extra tail needed by acrossfade transitions is added separately by padDurationsForFade
    const VOICE_GAP = 0.45;

    // 构建渲染分镜：跳过无素材的；有 TTS 配音时按配音实际时长卡点（字幕/贴片/画面严格对齐）
    const rendered: { shot: Shot; clip: ClipInput; duration: number; voiceSec?: number; words?: TTSWord[] }[] = [];
    const missing: number[] = [];
    for (const shot of shots) {
      // 素材优先级：该分镜已生成素材 → 商品原图兜底
      const ref = assetByShot.get(shot.shotId) ?? fallbackFor(shot);
      let local = toLocalPath(ref);
      if (!local) {
        if (tidewe) throw new Error(`镜头 ${shot.shotId} 缺少可用素材，请先生成或上传对应场景，不能跳过此镜口播。`);
        if (pinnedShotIds.has(shot.shotId)) throw new Error(`镜头 ${shot.shotId} 选择的素材已失效，请刷新后重新选择`);
        missing.push(shot.shotId);
        continue;
      }
      // 默认保留视频原声；覆盖/叠加模式允许有原声的镜头继续生成 TTS。
      // 注意：免费素材库（Wikimedia）也会返回 .ogv 等容器，必须纳入视频判定，否则被当静态图 → 冻结帧 + 丢音轨
      let isVideo = /\.(mp4|webm|mov|m4v|ogv|ogg|mkv|avi)$/i.test(local);
      // Broken-input gate: a video that ffprobe cannot time (truncated download, error page saved
      // as .mp4) would fail the whole single-pass filter_complex with an inscrutable error — swap
      // it for the product image instead of feeding it to ffmpeg, and log which shot degraded.
      if (isVideo && (await probeDuration(local)) <= 0) {
        if (tidewe) throw new Error(`镜头 ${shot.shotId} 视频无法测得有效时长，请恢复或重生成后合成。`);
        if (pinnedShotIds.has(shot.shotId)) throw new Error(`镜头 ${shot.shotId} 选中的视频无法解码，请重新选择视频版本后合成`);
        const fallback = toLocalPath(productImages[0]);
        console.warn(`[compose] 分镜 ${shot.shotId} 的视频素材无法解码（${local}），已降级为商品图兜底`);
        if (fallback && fallback !== local) {
          local = fallback;
          isVideo = /\.(mp4|webm|mov|m4v|ogv|ogg|mkv|avi)$/i.test(fallback);
        } else {
          missing.push(shot.shotId);
          continue;
        }
      }
      const nativeAudio = isVideo ? await videoHasAudio(local) : false;
      // A model planned for post narration may still return ambience or music.
      // Its audible track cannot stand in for the canonical spoken copy.
      const needsPostNarration = tideweNative && assetAudioModeByShot.get(shot.shotId) === "post";
      const vo =
        shot.voiceover && (needsPostNarration || !nativeAudio || voiceoverMode !== "auto")
          ? await buildVoiceover(shot.shotId, shot.voiceover, shot.characterId ? characterVoices.get(shot.characterId) : undefined, shot.type)
          : undefined;
      const audioPath = vo?.file;
      // A missing/failed voiceover keeps the original audio, including in replace mode.
      // Product-CG videos never inherit model-native speech. Silent CG uses
      // visual-only footage; restrained CG replaces it with the profile-owned
      // post-production narration. Ambient or music belongs in the explicit
      // BGM layer where it remains reviewable.
      const keepNativeAudio = !premiumCg && nativeAudio && (!audioPath || voiceoverMode === "mix");

      // Effective duration (core fix for issue #14 "next segment starts before speech ends"):
      // 1) TTS narration → actual audio length + breathing gap (clamped 1.5–20s); when the probe
      //    fails, estimate from text instead of falling back to the script's guessed duration,
      //    which used to hard-trim the narration mid-sentence;
      // 2) video with native voice → play out the real media length so model speech isn't cut;
      // 3) otherwise → script duration.
      let duration = shot.duration || 3;
      let voiceSec: number | undefined;
      // silent video clips also get probed: the composer speed-fits a moderately-too-long clip into
      // its slot (preserving a keyframe-chained ending) and needs the real source length for that
      let sourceDuration: number | undefined;
      if (tidewe && isVideo && keepNativeAudio && !audioPath) {
        sourceDuration = await probeDuration(local);
        duration = sourceDuration;
      } else if (audioPath) {
        const probed = await probeDuration(audioPath);
        if (tidewe && (!Number.isFinite(probed) || probed <= 0)) throw new Error(`镜头 ${shot.shotId} 英语配音无法测得实际时长，不能用估算值完成合成。`);
        voiceSec = probed > 0 ? probed : estimateSpeechSeconds(stripPauseMarks(shot.voiceover ?? ""));
        duration = tidewe ? Math.max(voiceSec + VOICE_GAP, 1.5) : Math.min(Math.max(voiceSec + VOICE_GAP, 1.5), 20);
        if (isVideo) {
          const mediaDur = await probeDuration(local);
          if (mediaDur > 0) {
            sourceDuration = mediaDur;
            // Mixing must preserve the original recording when it outlasts the narration.
            if (keepNativeAudio) duration = Math.max(duration, mediaDur);
          }
        }
      } else if (nativeAudio && !tidewe) {
        const mediaDur = await probeDuration(local);
        if (mediaDur > 0) duration = Math.min(Math.max(mediaDur, 1.5), 20);
      } else if (isVideo) {
        const mediaDur = await probeDuration(local);
        if (mediaDur > 0) sourceDuration = mediaDur;
      }

      const clip: ClipInput = {
        type: isVideo ? "video" : "image",
        filePath: local,
        duration,
        transition: shot.transition || "ai_start_end",
        ...(isVideo ? { hasAudio: keepNativeAudio } : { motion: defaultMotion(shot) }),
        ...(sourceDuration && { sourceDuration }),
        ...(audioPath && { audioPath }),
        ...(audioPath && keepNativeAudio && { mixNativeAudio: true }),
        ...(tidewe && isVideo ? { strictSourceDuration: true } : {}),
        ...(tideweNative && keepNativeAudio && !audioPath && shot.voiceover?.trim() ? { preserveNativeSpeech: true } : {}),
      };
      if (tidewe && isVideo) assertTideweMediaDuration(shot.shotId, duration, sourceDuration ?? await probeDuration(local));
      rendered.push({ shot, clip, duration, voiceSec, ...(vo?.words ? { words: vo.words } : {}) });
    }

    if (rendered.length === 0) throw new Error("没有可用素材");

    // acrossfade for ffmpeg_fade transitions consumes the previous clip's last FADE_DURATION:
    // pad voiced clips followed by a fade so the cross-fade only ever eats tail silence,
    // never the last words of narration (nor lets the next voice ride over them)
    const paddedDurations = padDurationsForFade(
      rendered.map((r) => ({
        duration: r.duration,
        transition: r.clip.transition,
        hasVoice: Boolean(r.clip.audioPath || r.clip.hasAudio),
      }))
    );
    rendered.forEach((r, i) => {
      r.duration = paddedDurations[i];
      r.clip.duration = paddedDurations[i];
      if (tidewe && r.clip.type === "video") assertTideweMediaDuration(r.shot.shotId, r.clip.duration, r.clip.sourceDuration ?? 0);
    });

    const clips = rendered.map((r) => r.clip);

    // Subtitle + overlay timeline (pure functions in timeline.ts): accumulates the rendered
    // segments' effective durations in lockstep with the composer's xfade timeline; caption
    // cards follow the actual speech window (not the padded tail) and cards spilling across
    // fade transitions are clamped so two captions never over-print
    const timeline = buildSubtitleTimeline(
      rendered.map((r): TimelineSegment => {
        const ov = r.shot.textOverlay;
        return {
          duration: r.duration,
          transition: r.clip.transition,
          // captions must never show the [pause] breath marker
          voiceover: r.shot.voiceover ? stripPauseMarks(r.shot.voiceover) : undefined,
          voiceSec: r.voiceSec,
          // real word timestamps (free Edge TTS) → exact karaoke sync + word-snapped caption cards
          ...(r.words ? { words: r.words } : {}),
          overlay:
            ov && ov.style !== "subtitle" && ov.text
              ? { text: ov.text, style: ov.style as "title" | "highlight" | "price" }
              : undefined,
        };
      })
    );
    const subtitleTexts = timeline.cues;
    const karaokeLines = timeline.karaokeLines;
    const overlays: { text: string; style: "title" | "highlight" | "price" | "badge"; startTime: number; endTime: number }[] = premiumCg
      ? []
      : [...timeline.overlays];

    // 可选叠加：片头角标（默认关）+ 片尾购买 CTA，按 body 开关
    overlays.push(
      ...buildComplianceOverlays(
        {
          ctaText: !premiumCg && typeof body.ctaText === "string" ? body.ctaText : undefined,
          aigcBadge,
          aigcBadgeText: typeof body.aigcBadgeText === "string" ? body.aigcBadgeText : undefined,
        },
        timeline.total
      )
    );

    // 仅混入用户明确提供的本地背景音乐，不自动检索或下载配乐。
    const bgmLocal = body.bgmPath ? toLocalPath(body.bgmPath) : undefined;

    const hasVoiceTrack = rendered.some((item) => Boolean(item.clip.audioPath || item.clip.hasAudio));
    const bgmMix = resolveBgmMix({ volume: body.bgmVolume, duck: body.bgmDuck, hasVoice: hasVoiceTrack });
    const config: ComposeConfig = {
      projectId: id,
      clips,
      output: {
        ...outputCfg,
        ...(bgmLocal && { bgmPath: bgmLocal, bgmVolume: bgmMix.volume, bgmDuck: bgmMix.duck }),
        // Grounding is opt-in. TIDEWE source-only recordings retain their original
        // sound; a generated voice is required before applying this option there.
        voiceGround: body.voiceGround === true && (!tidewe || clips.some((clip) => Boolean(clip.audioPath))),
      },
      subtitle:
        subtitles && subtitleTexts.length > 0
          ? { texts: subtitleTexts, position: "bottom", ...captionPresetOverrides(captionPreset) }
          : undefined,
      overlays: overlays.length > 0 ? overlays : undefined,
    };

    // karaoke per-character subtitles (opt-in via the karaoke flag or captionPreset=karaoke):
    // whole-sentence ASS \k burn-in via libass, replacing the rapid short caption cards
    const wantKaraoke = !tideweNative && subtitles && (body.karaoke === true || (captionPreset && CAPTION_PRESETS[captionPreset].karaoke === true));
    if (wantKaraoke && karaokeLines.length > 0) {
      const ass = buildKaraokeAss(karaokeLines, { fontName: resolveChineseFontFamily() });
      const assDir = join(getDataDir(), "output", id);
      await mkdir(assDir, { recursive: true });
      const assPath = join(assDir, `karaoke_${comp.id}.ass`);
      await writeFile(assPath, ass, "utf8");
      config.subtitle = { texts: [], karaokeAssPath: assPath };
    }

    // 商品卡贴片（opt-in）：用商品图首图 + 商品名做左下角挂车卡
    if (!premiumCg && body.productCard === true) {
      const cardImg = toLocalPath(productImages[0]);
      if (cardImg) {
        config.productCard = {
          imagePath: cardImg,
          name: (project.productName as string) || project.name || undefined,
          price: (project.productPrice as string) || undefined,
        };
      }
    }

        // 执行合成（FFmpeg）
        const outputPath = await composeVideo(config);
        // Splice-point sidecar (same pattern as the BGM credit sidecar): the composer's actual
        // fade-aware segment boundaries. The smart contact sheet reads this as the authoritative
        // cut list — per-frame scene detection cannot see gradual cross-fades. Best-effort only.
        const boundaries = segmentBoundaries(rendered.map((r) => ({ duration: r.duration, transition: r.clip.transition })));
        const starts = [0, ...boundaries];
        const stemDirName = `stems_${comp.id}`;
        let renderedStems: { voicePath?: string; bgmPath?: string } = {};
        if (exportAudioStems) {
          try {
            renderedStems = await renderAudioStems({
              clips,
              bgmPath: bgmLocal,
              bgmVolume: bgmMix.volume,
              voiceGround: config.output.voiceGround,
              totalDuration: timeline.total,
              outputDir: join(getDataDir(), "output", id, stemDirName),
            });
          } catch (error) {
            console.warn("音轨 stem 导出失败（不阻断成片）:", error);
          }
        }
        const dialogueClips = rendered.flatMap((r, index) => r.clip.audioPath ? [{
          source: fileNameOf(r.clip.audioPath),
          start: Number((starts[index] ?? 0).toFixed(3)),
          end: Number(((starts[index] ?? 0) + r.duration).toFixed(3)),
        }] : []);
        const nativeClips = rendered.flatMap((r, index) => r.clip.hasAudio && r.clip.type === "video" ? [{
          source: fileNameOf(r.clip.filePath),
          start: Number((starts[index] ?? 0).toFixed(3)),
          end: Number(((starts[index] ?? 0) + r.duration).toFixed(3)),
        }] : []);
        const audioTracks = [
          ...(dialogueClips.length ? [{ id: "A1", role: "dialogue", clips: dialogueClips }] : []),
          ...(nativeClips.length ? [{ id: "A2", role: "native", clips: nativeClips }] : []),
          ...(bgmLocal ? [{ id: "A3", role: "bgm", source: fileNameOf(bgmLocal), start: 0, end: Number(timeline.total.toFixed(3)), volume: bgmMix.volume, duck: bgmMix.duck }] : []),
        ];
        await writeFile(
          `${outputPath}.timeline.json`,
          JSON.stringify({
            version: 1,
            boundaries,
            total: timeline.total,
            audioTracks,
            ...(tideweNative ? { speechMode: "on_camera", captionTiming: "segment-estimate" } : {}),
            ...(exportAudioStems ? {
              audioStems: {
                voiceUrl: renderedStems.voicePath ? `/api/output/${id}/${stemDirName}/voice.wav` : null,
                bgmUrl: renderedStems.bgmPath ? `/api/output/${id}/${stemDirName}/bgm.wav` : null,
              },
            } : {}),
            // structured degradation log (TTS fallbacks / failed shots) — surfaced by tooling later
            ...(composeWarnings.length > 0 ? { warnings: composeWarnings } : {}),
          }),
          "utf8"
        ).catch(() => {});
        // 封面缩略图：抽首帧存成片旁（本地抽取永不过期），作品流/项目卡靠它凭画面找片；失败不阻断
        const thumbnailPath = await extractFirstFrame(outputPath);
        // 完成：更新合成记录与项目状态
        // Keep explicit BGM provenance available to export credits and the release gate.
        await db
          .update(compositions)
          .set({ outputPath, status: "done", ...(tidewe ? { ttsEnabled: clips.some((clip) => Boolean(clip.audioPath)) } : {}), ...(thumbnailPath && { thumbnailPath }), ...(bgmLocal && { bgmPath: bgmLocal }) })
          .where(eq(compositions.id, comp.id));
        await db.update(projects).set({ status: "done", updatedAt: new Date() }).where(eq(projects.id, id));
      } catch (e) {
        console.error("后台合成失败:", e);
        // Persist diagnostics before exposing failed status to polling clients.
        await saveCompositionError(comp.projectId, comp.id, e).catch((writeError) => {
          console.warn("保存合成错误详情失败:", writeError);
        });
        await db.update(compositions).set({ status: "failed" }).where(eq(compositions.id, comp.id)).catch(() => {});
        await db.update(projects).set({ status: "video", updatedAt: new Date() }).where(eq(projects.id, id)).catch(() => {});
      }
    })();

    // 立即返回，前端轮询 GET /api/project/[id]/compose 直到 status=done/failed
    return NextResponse.json({ compositionId: comp.id, status: "composing" }, { status: 202 });
  } catch (error) {
    console.error("视频合成失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "视频合成失败" },
      { status: 500 }
    );
  }
}
