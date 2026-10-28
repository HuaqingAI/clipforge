"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useParams } from "next/navigation";
import { LuArrowLeft, LuPlay, LuChevronDown, LuArrowRight, LuLoaderCircle } from "react-icons/lu";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { resolveTTSConfig, isPaidTTSReady, getTTSProviderMeta } from "@/lib/tts-presets";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useT, useLocale } from "@/lib/i18n";
import { RENDER_PRESETS, DEFAULT_RENDER_PRESET, type RenderPreset } from "@/lib/compose-presets";
import { BUILTIN_STYLE_PACKS, parseStylePack, serializeStylePack, STYLE_PACK_FORMAT, type StylePack } from "@/lib/style-packs";
import { decodeStoredAdTemplate, adTemplateStorageKey, adTemplateAppliedKey } from "@/lib/ad-templates";
import { buildHookVariants } from "@/lib/script-engine/hook-variants";
import type { ProductCategory } from "@/lib/script-engine/templates";
import { CAPTION_PRESET_IDS } from "@/lib/caption-presets";
import { sanitizeCreativeProfile, isTideweOutdoorProfile, isTideweNativeSpeech, type PremiumProductCgProfile, type TideweOutdoorProfile } from "@/lib/creative-profiles";
import { resolveNarrationVoice, TIDEWE_TTS_VOICES } from "@/lib/narration-voice";
import { ProjectHeader } from "@/components/project-header";
import { FreeVoicePreview } from "@/components/free-voice-preview";
import { ShotVideoPicker, buildShotAssetSelections, selectedShotAsset, type ShotVideoAsset } from "@/components/shot-video-picker";
import { klingErrorMessage, klingFetch } from "@/lib/kling/client";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Shot } from "@/lib/db/schema";

// 视频片段
interface VideoClipItem {
  shotId: number;
  type: Shot["type"];
  duration: number;
  voiceover: string;
  transition: "direct_concat" | "ffmpeg_fade";
}

// 合成配置
interface ComposeConfig {
  ttsEnabled: boolean;
  voiceoverMode: "auto" | "replace" | "mix";
  ttsVoice: string;
  /** 免费 TTS 音色（未配置付费 TTS 时使用） */
  freeVoice: string;
  subtitles: boolean;
  subtitleSize: number;
  subtitlePosition: "bottom" | "center" | "top";
  aspectRatio: "9:16" | "16:9" | "1:1";
  resolution: "720p" | "1080p";
  /** 渲染质量预设：快速/标准/高清（决定分辨率 + 编码速度/质量） */
  renderPreset: RenderPreset;
  /** 带货：片尾购买 CTA 贴片 */
  ctaEnabled: boolean;
  ctaText: string;
  /** 带货：左下角商品卡贴片（商品图缩略+名+购买引导，需商品图） */
  productCard: boolean;
  /** caption style preset: standard boxed / bold punch / minimal / word-by-word karaoke */
  captionPreset: "standard" | "bold" | "minimal" | "karaoke";
  /** 旁白闪避：旁白一响自动压低 BGM、停顿回升，旁白更清晰 */
  bgmDuck: boolean;
  /** 配乐强度（归一化 0..1，后端会再次做安全限制） */
  bgmVolume: number;
  /** Optional TTS de-broadcast chain and room-tone bed; disabled by default. */
  voiceGround: boolean;
}

function lockPremiumCgComposeConfig(config: ComposeConfig): ComposeConfig {
  return {
    ...config,
    ttsEnabled: false,
    voiceoverMode: "auto",
    subtitles: false,
    captionPreset: "standard",
    ctaEnabled: false,
    ctaText: "",
    productCard: false,
  };
}

function applyTideweComposeSnapshot(config: ComposeConfig, profile: TideweOutdoorProfile): ComposeConfig {
  const snapshot = profile.composeSnapshot;
  const captionPreset = CAPTION_PRESET_IDS.find((preset) => preset === snapshot.captionPreset) ?? "standard";
  const quality = snapshot.quality;
  const renderPreset = quality === "fast" || quality === "standard" || quality === "hd" ? quality : DEFAULT_RENDER_PRESET;
  return {
    ...config,
    ttsEnabled: true,
    voiceoverMode: isTideweNativeSpeech(profile) ? "auto" : "replace",
    freeVoice: resolveNarrationVoice(profile),
    subtitles: snapshot.subtitles !== false,
    subtitleSize: 24,
    subtitlePosition: "bottom",
    captionPreset,
    aspectRatio: "9:16",
    renderPreset,
    resolution: RENDER_PRESETS[renderPreset].resolution,
    bgmDuck: typeof snapshot.bgmDuck === "boolean" ? snapshot.bgmDuck : true,
    bgmVolume: typeof snapshot.bgmVolume === "number" && Number.isFinite(snapshot.bgmVolume) ? Math.max(0, Math.min(1, snapshot.bgmVolume)) : 0.18,
    ctaEnabled: false,
    ctaText: "",
    productCard: false,
  };
}

// 免费配音音色（微软 Edge keyless TTS，无需 Key）——与后端 FREE_TTS_VOICES 对应
// label 改为 i18n key，渲染时经 t() 取对应语言文案
const freeVoiceOptions = [
  { value: "zh-CN-XiaoxiaoNeural", labelKey: "freeVoiceXiaoxiao" },
  { value: "zh-CN-XiaoyiNeural", labelKey: "freeVoiceXiaoyi" },
  { value: "zh-CN-YunxiNeural", labelKey: "freeVoiceYunxi" },
  { value: "zh-CN-YunyangNeural", labelKey: "freeVoiceYunyang" },
  { value: "zh-CN-YunjianNeural", labelKey: "freeVoiceYunjian" },
];

// 转场标签（值为 i18n key）
const transitionLabels: Record<string, string> = {
  direct_concat: "transitionDirectConcat",
  ffmpeg_fade: "transitionFfmpegFade",
};

// 镜头类型标签（labelKey 为 i18n key）
const shotTypeLabels: Record<Shot["type"], { labelKey: string; color: string }> = {
  hook: { labelKey: "shotHook", color: "bg-red-500/20 text-red-400" },
  pain_point: { labelKey: "shotPainPoint", color: "bg-orange-500/20 text-orange-400" },
  product_reveal: { labelKey: "shotProductReveal", color: "bg-blue-500/20 text-blue-400" },
  demo: { labelKey: "shotDemo", color: "bg-green-500/20 text-green-400" },
  social_proof: { labelKey: "shotSocialProof", color: "bg-purple-500/20 text-purple-400" },
  cta: { labelKey: "shotCta", color: "bg-amber-500/20 text-amber-400" },
};

interface DbShot {
  shotId: number;
  type: VideoClipItem["type"];
  duration: number;
  voiceover: string;
  transition: Shot["transition"];
}

// 判断素材是图还是视频（视频用 <video> 当封面，图用 <img>）
const isVideoPath = (p: string) => /\.(mp4|webm|mov|m4v)(\?|$)/i.test(p);

export default function VideoPage() {
  const t = useT("video");
  const tt = useT("tidewe");
  const locale = useLocale();
  const { id } = useParams<{ id: string }>();
  const { defaultResolution, defaultAspectRatio, tts, providers } = useSettingsStore();
  const [clips, setClips] = useState<VideoClipItem[]>([]);
  const [scriptId, setScriptId] = useState("");
  const [savedAssets, setSavedAssets] = useState<ShotVideoAsset[]>([]);
  const [savingAssetId, setSavingAssetId] = useState<string | null>(null);
  const [assetSelectionError, setAssetSelectionError] = useState<{ shotId: number; message: string } | null>(null);
  const selectingAsset = useRef(false);
  // 缩略图严格跟随持久化选材，与合成请求中的资产编号一致。
  const thumbs = useMemo(() => Object.fromEntries(clips.flatMap(({ shotId }) => {
    const asset = selectedShotAsset(savedAssets, shotId);
    return asset?.filePath ? [[shotId, asset.filePath]] : [];
  })), [clips, savedAssets]);
  const [projectName, setProjectName] = useState("");
  const [premiumCgProfile, setPremiumCgProfile] = useState<PremiumProductCgProfile | null>(null);
  const premiumCg = premiumCgProfile !== null;
  const premiumCgRef = useRef(false);
  const [tidewe, setTidewe] = useState(false);
  const [tideweNativeSpeech, setTideweNativeSpeech] = useState(false);
  const tideweRef = useRef(false);
  const [loadedProfileProjectId, setLoadedProfileProjectId] = useState<string | null>(null);
  const availableFreeVoices: { value: string; labelKey?: string; label?: string }[] = tidewe
    ? TIDEWE_TTS_VOICES.map((voice) => ({ value: voice.value, label: locale === "zh" ? voice.labelZh : voice.label }))
    : freeVoiceOptions;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [config, setConfig] = useState<ComposeConfig>({
    ttsEnabled: true,
    voiceoverMode: "auto",
    ttsVoice: "female-gentle",
    freeVoice: "zh-CN-XiaoxiaoNeural",
    subtitles: true,
    subtitleSize: 24,
    subtitlePosition: "bottom",
    aspectRatio: "9:16",
    resolution: "1080p",
    renderPreset: DEFAULT_RENDER_PRESET,
    ctaEnabled: false,
    ctaText: "", // 默认空，开启时按当前语言用 ctaPlaceholder 预填（避免英文用户拿到中文默认 CTA）
    productCard: false,
    captionPreset: "standard",
    bgmDuck: true,
    bgmVolume: 0.18,
    voiceGround: false,
  });

  // 合成状态
  const [isComposing, setIsComposing] = useState(false);
  const [composeProgress, setComposeProgress] = useState(0);
  const [composeDone, setComposeDone] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  // 背景音乐
  const [bgm, setBgm] = useState<{ path: string; name: string } | null>(null);
  const [bgmUploading, setBgmUploading] = useState(false);
  // 是否已配置付费 TTS（否则配音走免费 Edge keyless TTS）
  const paidTtsReady = !tidewe && isPaidTTSReady(tts, providers);
  const uploadBgm = async (file: File) => {
    setBgmUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/project/${id}/bgm`, { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("errorUploadFailed"));
      setBgm({ path: data.path, name: data.name });
    } catch {
      setBgm(null);
    } finally {
      setBgmUploading(false);
    }
  };

  // 载入真实分镜（已选脚本）+ 项目名 + 默认画面设置
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      setAssetSelectionError(null);
      setLoadedProfileProjectId(null);
      premiumCgRef.current = false;
      tideweRef.current = false;
      setTidewe(false);
      setTideweNativeSpeech(false);
      setPremiumCgProfile(null);
      try {
        const [projectRes, scriptsRes, assetsRes] = await Promise.all([
          fetch(`/api/project/${id}`),
          fetch(`/api/project/${id}/scripts`),
          fetch(`/api/project/${id}/assets?includeHistory=1`, { cache: "no-store" }),
        ]);
        const project = projectRes.ok ? await projectRes.json() : null;
        const scripts = scriptsRes.ok ? await scriptsRes.json() : [];
        if (!assetsRes.ok) throw new Error(t("errorLoadFailed"));
        const assets = await assetsRes.json();
        if (cancelled) return;
        if (project) {
          setProjectName(project.name ?? project.productName ?? "");
          setProjectCategory(typeof project.productCategory === "string" ? project.productCategory : "");
          const creativeProfile = sanitizeCreativeProfile(project.creativeProfile);
          const isTidewe = isTideweOutdoorProfile(creativeProfile);
          tideweRef.current = isTidewe;
          setTidewe(isTidewe);
          setTideweNativeSpeech(isTideweNativeSpeech(creativeProfile));
          const cgProfile = creativeProfile?.creationType === "premium_product_cg" ? creativeProfile : null;
          premiumCgRef.current = Boolean(cgProfile);
          setPremiumCgProfile(cgProfile);
          if (cgProfile) setConfig(lockPremiumCgComposeConfig);
          if (isTidewe) setConfig((current) => applyTideweComposeSnapshot(current, creativeProfile));
          if (Array.isArray(project.productionWorkflow)) {
            const voiceStage = project.productionWorkflow.find((stage: { id?: unknown }) => stage.id === "voice");
            if (voiceStage && !cgProfile && !isTidewe) setConfig((current) => ({ ...current, ttsEnabled: voiceStage.enabled !== false }));
          }
          setLoadedProfileProjectId(id);
        }
        setSavedAssets(Array.isArray(assets) ? assets : []);
        const selected = Array.isArray(scripts)
          ? scripts.find((s: { selected?: boolean }) => s.selected)
          : null;
        if (!selected || !Array.isArray(selected.shots) || selected.shots.length === 0) {
          setScriptId("");
          setScriptShots([]);
          setLoadError(t("errorNoScript"));
          setClips([]);
        } else {
          setScriptId(typeof selected.id === "string" ? selected.id : "");
          // raw shots feed the variant matrix (hook rewrites need full Shot objects)
          setScriptShots(selected.shots as Shot[]);
          setClips(
            (selected.shots as DbShot[]).map((s) => ({
              shotId: s.shotId,
              type: s.type,
              duration: s.duration,
              voiceover: s.voiceover ?? "",
              // Legacy AI modes use the same hard cut in the composer.
              transition: s.transition === "ffmpeg_fade" ? "ffmpeg_fade" : "direct_concat",
            }))
          );
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : t("errorLoadFailed"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // 用设置里的默认分辨率/比例初始化一次
  useEffect(() => {
    setConfig((c) => ({ ...c, resolution: defaultResolution, aspectRatio: defaultAspectRatio }));
  }, [defaultResolution, defaultAspectRatio]);

  // Production-console preview hand-off: select the existing real fast profile
  // (720p / veryfast / CRF 26) without touching any paid generation stage.
  useEffect(() => {
    if (loadedProfileProjectId !== id) return;
    if (new URLSearchParams(window.location.search).get("renderPreset") !== "fast") return;
    setConfig((current) => ({ ...current, renderPreset: "fast", resolution: RENDER_PRESETS.fast.resolution }));
  }, [id, loadedProfileProjectId]);

  const totalDuration = clips.reduce((sum, c) => sum + c.duration, 0);

  // 更新片段转场
  const updateTransition = (shotId: number, transition: string) => {
    setClips((prev) =>
      prev.map((c) =>
        c.shotId === shotId ? { ...c, transition: transition as VideoClipItem["transition"] } : c
      )
    );
  };

  const applyTransitionToAll = (transition: VideoClipItem["transition"]) => {
    // A transition belongs to the incoming shot; the first shot has no boundary.
    setClips((prev) => prev.map((clip, index) => index === 0 ? clip : { ...clip, transition }));
  };

  // style packs: declarative JSON recipes (caption preset / audio mix / quality / CTA / product card).
  // Novice-safe "external skill": pure data validated against a whitelist — nothing executable.
  const packFileRef = useRef<HTMLInputElement>(null);
  const [packNotice, setPackNotice] = useState<string | null>(null);

  const applyStylePack = (pack: StylePack) => {
    if (premiumCgRef.current || tideweRef.current) return;
    const p = pack.compose;
    setConfig((c) => ({
      ...c,
      ...(p.captionPreset && { captionPreset: p.captionPreset }),
      ...(p.bgmVolume !== undefined && { bgmVolume: p.bgmVolume }),
      ...(p.bgmDuck !== undefined && { bgmDuck: p.bgmDuck }),
      ...(p.quality && { renderPreset: p.quality, resolution: RENDER_PRESETS[p.quality].resolution }),
      ...(p.aspectRatio && { aspectRatio: p.aspectRatio }),
      ...(p.ctaText ? { ctaEnabled: true, ctaText: p.ctaText } : {}),
      ...(p.productCard !== undefined && { productCard: p.productCard }),
    }));
    setPackNotice(t("stylePackApplied").replace("{name}", pack.name));
  };

  // Ad-template hand-off (set at project creation on the new-project page): apply the
  // template's compose recipe ONCE per project, through the same whitelisted style-pack
  // path — later manual tweaks are never overwritten on revisit.
  useEffect(() => {
    if (loadedProfileProjectId !== id) return;
    try {
      if (premiumCgRef.current || tideweRef.current) {
        localStorage.removeItem(adTemplateStorageKey(id));
        localStorage.removeItem(adTemplateAppliedKey(id));
        return;
      }
      const stored = localStorage.getItem(adTemplateStorageKey(id));
      if (!stored || localStorage.getItem(adTemplateAppliedKey(id))) return;
      // decodes both builtin ids and inline AI custom templates (custom:<json>)
      const tpl = decodeStoredAdTemplate(stored);
      if (!tpl) return;
      applyStylePack({
        format: STYLE_PACK_FORMAT,
        name: locale === "zh" ? tpl.name.zh : tpl.name.en,
        compose: tpl.compose,
      });
      localStorage.setItem(adTemplateAppliedKey(id), "1");
    } catch {
      // localStorage unavailable — the pre-fill is a convenience, never a blocker
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, loadedProfileProjectId]);

  const importStylePack = async (file: File) => {
    const pack = parseStylePack(await file.text());
    if (!pack) {
      setPackNotice(t("stylePackInvalid"));
      return;
    }
    applyStylePack(pack);
  };

  const exportStylePack = () => {
    const json = serializeStylePack({
      name: projectName || "my-style",
      compose: {
        captionPreset: config.captionPreset,
        bgmVolume: config.bgmVolume,
        bgmDuck: config.bgmDuck,
        quality: config.renderPreset,
        aspectRatio: config.aspectRatio,
        ...(config.ctaEnabled && config.ctaText.trim() ? { ctaText: config.ctaText.trim() } : {}),
        productCard: config.productCard,
      },
    });
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "clipforge-style-pack.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  // —— Variant matrix: same assets,
  // hook copy × caption preset combos rendered as separate labeled outputs
  // for A/B testing. Zero extra AI-generation cost — only compose (FFmpeg + TTS) reruns. ——
  const [scriptShots, setScriptShots] = useState<Shot[]>([]);
  const [projectCategory, setProjectCategory] = useState("");
  const [matrixOpen, setMatrixOpen] = useState(false);
  const [matrixHooks, setMatrixHooks] = useState<Set<string>>(new Set(["base"]));
  const [matrixCaptions, setMatrixCaptions] = useState<Set<string>>(new Set());
  const [matrixRunning, setMatrixRunning] = useState(false);
  const [matrixResults, setMatrixResults] = useState<Array<{ label: string; status: "composing" | "done" | "failed"; url?: string; error?: string }>>([]);

  const selectAsset = async (asset: ShotVideoAsset) => {
    if (selectingAsset.current || isComposing || matrixRunning) return;
    selectingAsset.current = true;
    setSavingAssetId(asset.id);
    setAssetSelectionError(null);
    try {
      if (asset.matchesCurrentScript === false) {
        if (!asset.klingJobId || !asset.klingOutputId) throw new Error(locale === "zh" ? "请返回素材页恢复此版本的原任务" : "Return to assets to recover the original task for this version");
        const response = await klingFetch(`/api/integrations/kling/jobs/${encodeURIComponent(asset.klingJobId)}/outputs/${encodeURIComponent(asset.klingOutputId)}/select`, {
          method: "POST",
          body: JSON.stringify({ adoptCurrentContext: true }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(klingErrorMessage(data));
        // Adoption creates a persisted binding with a new ID. Use the server's
        // actual selection so the preview and composition pin the same take.
        const assetsRes = await fetch(`/api/project/${id}/assets?includeHistory=1`, { cache: "no-store" });
        if (!assetsRes.ok) throw new Error(t("errorLoadFailed"));
        const assets = await assetsRes.json();
        if (!Array.isArray(assets)) throw new Error(t("errorLoadFailed"));
        setSavedAssets(assets);
      } else {
        const response = await fetch(`/api/project/${id}/assets`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assetId: asset.id }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || (locale === "zh" ? "切换视频版本失败，请重试" : "Failed to select this version. Please retry."));
        setSavedAssets((current) => current.map((row) => row.shotId === asset.shotId ? { ...row, selected: row.id === asset.id } : row));
      }
      setComposeDone(false);
      setOutputUrl(null);
    } catch (failure) {
      setAssetSelectionError({ shotId: asset.shotId, message: failure instanceof Error ? failure.message : locale === "zh" ? "切换视频版本失败，请重试" : "Failed to select this version. Please retry." });
    } finally {
      selectingAsset.current = false;
      setSavingAssetId(null);
    }
  };

  /** Hard cap on one batch (compose is FFmpeg-heavy and runs sequentially). */
  const MATRIX_MAX = 6;

  // hook-pattern categories use the script-engine vocabulary; map the project's UI category in
  const matrixCategory = (
    ["beauty", "food", "home", "fashion", "tech"].includes(projectCategory)
      ? projectCategory
      : projectCategory === "digital"
        ? "tech"
        : "home"
  ) as ProductCategory;

  // zero-LLM hook rewrites from the validated pattern library (base + 2 alternatives)
  const hookVariants = useMemo(
    () => (!tidewe && scriptShots.length > 0 ? buildHookVariants({ shots: scriptShots }, matrixCategory, 2) : []),
    [scriptShots, matrixCategory, tidewe]
  );

  const matrixCombos = useMemo(() => {
    const hooks = [...matrixHooks];
    const captions = config.subtitles ? [...matrixCaptions] : [config.captionPreset];
    const combos: Array<{ hookKey: string; hookLabel: string; caption: string; label: string }> = [];
    for (const h of hooks) {
      const hookLabel = h === "base" ? t("matrixBaseHook") : hookVariants.find((v) => v.hookId === h)?.hookName ?? h;
      for (const c of captions) {
        const captionLabel = config.subtitles ? c : t("matrixNoSubtitles");
        combos.push({ hookKey: h, hookLabel, caption: c, label: `${hookLabel}×${captionLabel}` });
      }
    }
    return combos.slice(0, MATRIX_MAX);
  }, [matrixHooks, matrixCaptions, hookVariants, config.subtitles, config.captionPreset, t]);

  const toggleMatrixOpen = () => {
    setMatrixOpen((open) => {
      // Seed the caption dimension from the current config on first open.
      if (!open) {
        setMatrixCaptions((s) => (s.size === 0 ? new Set([config.captionPreset]) : s));
      }
      return !open;
    });
  };

  const toggleInSet = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, value: string) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  /** Run the matrix: sequential compose per combo, each polled by its own compositionId. */
  const runMatrix = async () => {
    if (premiumCg || tidewe || matrixRunning || isComposing || selectingAsset.current || !scriptId || matrixCombos.length === 0) return;
    const shotAssetSelections = buildShotAssetSelections(clips, savedAssets);
    const transitionOverrides = clips.map(({ shotId, transition }) => ({ shotId, transition }));
    setMatrixRunning(true);
    setMatrixResults(matrixCombos.map((c) => ({ label: c.label, status: "composing" as const })));
    for (let i = 0; i < matrixCombos.length; i++) {
      const combo = matrixCombos[i];
      try {
        // hook variant: in-memory voiceover override for shot 1 (the stored script stays untouched)
        const variant = combo.hookKey === "base" ? undefined : hookVariants.find((v) => v.hookId === combo.hookKey);
        const hookShot = variant?.script.shots[0];
        const res = await fetch(`/api/project/${id}/compose`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scriptId,
            shotAssetSelections,
            transitionOverrides,
            resolution: config.resolution,
            renderPreset: config.renderPreset,
            aspectRatio: config.aspectRatio,
            subtitles: premiumCg ? false : config.subtitles,
            label: combo.label,
            ...(!premiumCg && hookShot && { voiceoverOverrides: [{ shotId: hookShot.shotId, voiceover: hookShot.voiceover ?? "" }] }),
            ...(!premiumCg && config.ctaEnabled && config.ctaText.trim() && { ctaText: config.ctaText.trim() }),
            ...(!premiumCg && config.productCard && { productCard: true }),
            ...(!premiumCg && { captionPreset: combo.caption }),
            ...(bgm?.path && { bgmPath: bgm.path, bgmVolume: config.bgmVolume, bgmDuck: config.bgmDuck }),
            ...(!premiumCg && { voiceGround: config.voiceGround }),
            ...(!premiumCg && config.ttsEnabled && config.voiceoverMode !== "auto" && { voiceoverMode: config.voiceoverMode }),
            ...(!premiumCg && config.ttsEnabled && paidTtsReady && { ttsConfig: resolveTTSConfig(tts, providers) }),
            ...(!premiumCg && config.ttsEnabled && !paidTtsReady && { freeTts: { enabled: true, voice: config.freeVoice } }),
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.compositionId) throw new Error(data.error || "compose failed");
        // poll THIS composition by id (avoids the latest-row race across sequential renders)
        const url: string = await new Promise((resolve, reject) => {
          const poll = setInterval(async () => {
            try {
              const r = await fetch(`/api/project/${id}/compose?compositionId=${encodeURIComponent(data.compositionId)}`);
              const d = await r.json();
              const c = d.composition;
              if (!c) return;
              if (c.status === "done" && c.url) {
                clearInterval(poll);
                resolve(c.url);
              } else if (c.status === "failed") {
                clearInterval(poll);
                reject(new Error(c.error || t("errorComposeAssets")));
              }
            } catch {
              // transient poll failure — keep trying until the outer timeout
            }
          }, 3000);
          setTimeout(() => {
            clearInterval(poll);
            reject(new Error("timeout"));
          }, 300000);
        });
        setMatrixResults((prev) => prev.map((r, idx) => (idx === i ? { ...r, status: "done", url } : r)));
      } catch (error) {
        setMatrixResults((prev) => prev.map((r, idx) => (idx === i ? { ...r, status: "failed", error: error instanceof Error ? error.message : t("errorComposeFailed") } : r)));
      }
    }
    setMatrixRunning(false);
  };

  // 真实合成：调用 compose API 跑 FFmpeg，配乐观进度动画，完成后拿到真实 mp4
  const startCompose = async () => {
    if (isComposing || matrixRunning || selectingAsset.current || !scriptId) return;
    const shotAssetSelections = buildShotAssetSelections(clips, savedAssets);
    const transitionOverrides = clips.map(({ shotId, transition }) => ({ shotId, transition }));
    setIsComposing(true);
    setComposeError(null);
    setComposeDone(false);
    setOutputUrl(null);
    setComposeProgress(0);

    // 乐观进度：先爬到 90%，等真实结果回来再到 100%
    const timer = setInterval(() => {
      setComposeProgress((prev) => (prev >= 90 ? 90 : prev + 3));
    }, 200);

    try {
      // 提交合成任务（后台异步），随后轮询状态
      const res = await fetch(`/api/project/${id}/compose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scriptId,
          shotAssetSelections,
          transitionOverrides,
          resolution: config.resolution,
          renderPreset: config.renderPreset,
          aspectRatio: config.aspectRatio,
          subtitles: premiumCg ? false : config.subtitles,
          ...(tidewe && { ttsEnabled: config.ttsEnabled }),
          ...(tideweNativeSpeech && { nativeAudio: true }),
          ...(!premiumCg && config.ctaEnabled && config.ctaText.trim() && { ctaText: config.ctaText.trim() }),
          ...(!premiumCg && config.productCard && { productCard: true }),
          ...(!premiumCg && config.captionPreset !== "standard" && { captionPreset: config.captionPreset }),
          ...(bgm?.path && { bgmPath: bgm.path, bgmVolume: config.bgmVolume, bgmDuck: config.bgmDuck }),
          ...(!premiumCg && { voiceGround: config.voiceGround }),
          // 开启配音时：已配付费 TTS 走付费；否则走免费 Edge keyless TTS（无需 Key），合成为每镜生成口播音轨
          ...(!premiumCg && config.ttsEnabled && (tidewe || config.voiceoverMode !== "auto") && { voiceoverMode: config.voiceoverMode }),
          ...(!premiumCg && config.ttsEnabled && paidTtsReady && {
            // 解析后的完整配置（含平台、复用的 Key、默认 baseUrl/模型/音色、可选 GroupId）
            ttsConfig: resolveTTSConfig(tts, providers),
          }),
          ...(!premiumCg && config.ttsEnabled && !paidTtsReady && {
            freeTts: { enabled: true, voice: config.freeVoice },
          }),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.compositionId) throw new Error(data.error || t("errorComposeFailed"));

      // 轮询合成状态，直到 done / failed（后台任务，避免长视频请求超时）
      const url: string = await new Promise((resolve, reject) => {
        const poll = setInterval(async () => {
          try {
            const r = await fetch(`/api/project/${id}/compose?compositionId=${encodeURIComponent(data.compositionId)}`);
            const d = await r.json();
            const c = d.composition;
            if (!c) return;
            if (c.status === "done" && c.url) {
              clearInterval(poll);
              resolve(c.url);
            } else if (c.status === "failed") {
              clearInterval(poll);
              reject(new Error(c.error || t("errorComposeAssets")));
            }
          } catch {
            // 单次轮询失败忽略，继续重试
          }
        }, 3000);
        // 兜底超时：5 分钟
        setTimeout(() => {
          clearInterval(poll);
          reject(new Error(t("errorComposeTimeout")));
        }, 300000);
      });

      clearInterval(timer);
      setComposeProgress(100);
      setOutputUrl(url);
      setComposeDone(true);
    } catch (e) {
      clearInterval(timer);
      setComposeError(e instanceof Error ? e.message : t("errorComposeFailed"));
      setComposeProgress(0);
    } finally {
      setIsComposing(false);
    }
  };

  return (
    <div className="min-h-screen grid-bg">
      {/* project context strip: name + CLICKABLE step navigation — replaces the legacy
          inline non-clickable stepper this page carried while owned by a parallel session */}
      <ProjectHeader projectName={projectName || t("defaultProjectName")} />

      <main className="mx-auto max-w-7xl px-6 py-8">
        {/* page-level load feedback: these states existed but were never rendered,
            leaving an empty timeline with no explanation */}
        {loading && (
          <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
            <LuLoaderCircle className="h-4 w-4 animate-spin" />
            {t("stateLoading")}
          </div>
        )}
        {!loading && loadError && (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
            <p className="text-sm text-muted-foreground">{loadError}</p>
            <Link href={`/project/${id}/assets`}>
              <Button variant="outline" size="sm">{t("backToAssets")}</Button>
            </Link>
          </div>
        )}
        <div className={`grid grid-cols-1 lg:grid-cols-3 gap-6 ${loading || loadError ? "hidden" : ""}`}>
          {/* 左侧：视频时间线 */}
          <div className="lg:col-span-2">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-base font-semibold">{t("timelineTitle")}</h2>
                <p className="text-xs text-muted-foreground mt-0.5">{t("timelineMeta", { count: clips.length, duration: totalDuration })}</p>
              </div>
              <Link href={`/project/${id}/assets`}>
                <Button variant="outline" size="sm" className="text-xs">
                  <LuArrowLeft className="w-3.5 h-3.5 mr-1" />
                  {t("backToAssets")}
                </Button>
              </Link>
            </div>

            {clips.length > 1 && (
              <div role="group" aria-label={t("transitionBulkLabel")} className="mb-4 rounded-lg border border-border/50 bg-muted/10 p-3 space-y-2">
                <p className="text-xs font-medium">{t("transitionBulkLabel")}</p>
                <div className="flex flex-wrap gap-2">
                  {(["direct_concat", "ffmpeg_fade"] as const).map((transition) => (
                    <Button
                      key={transition}
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-pressed={clips.slice(1).every((clip) => clip.transition === transition)}
                      onClick={() => applyTransitionToAll(transition)}
                      className="text-xs aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-primary"
                    >
                      {t(transition === "direct_concat" ? "transitionAllDirectConcat" : "transitionAllFfmpegFade")}
                    </Button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">{t("transitionBulkHint")}</p>
              </div>
            )}

            <div className="space-y-1">
              {clips.map((clip, index) => {
                const typeInfo = shotTypeLabels[clip.type];
                return (
                  <div key={clip.shotId}>
                    {/* 片段卡片 */}
                    <Card className="glass-card">
                      <CardContent className="p-4">
                        <div className="flex items-center gap-4">
                          {/* 缩略图：有已生成的画面就直接预览，否则回退占位图 */}
                          <div className="w-20 h-14 bg-muted/30 rounded-md shrink-0 overflow-hidden border border-border/30 relative">
                            <div className="absolute inset-0 bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
                              <LuPlay className="w-4 h-4 text-primary/60" />
                            </div>
                            {thumbs[clip.shotId] &&
                              (isVideoPath(thumbs[clip.shotId]) ? (
                                <video
                                  src={thumbs[clip.shotId]}
                                  muted
                                  playsInline
                                  preload="metadata"
                                  className="absolute inset-0 w-full h-full object-cover"
                                />
                              ) : (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={thumbs[clip.shotId]}
                                  alt=""
                                  className="absolute inset-0 w-full h-full object-cover"
                                />
                              ))}
                          </div>

                          {/* 信息 */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <Badge className={`${typeInfo.color} border-0 text-[10px]`}>
                                {t(typeInfo.labelKey)}
                              </Badge>
                              <span className="text-xs text-muted-foreground">{clip.duration}s</span>
                            </div>
                            <p className="text-xs text-muted-foreground truncate">
                              🎙 {clip.voiceover}
                            </p>
                          </div>

                          {/* 序号 */}
                          <span className="text-sm font-bold text-muted-foreground/30 shrink-0">
                            {String(clip.shotId).padStart(2, "0")}
                          </span>
                        </div>
                        <ShotVideoPicker
                          shotId={clip.shotId}
                          assets={savedAssets}
                          locale={locale}
                          disabled={savingAssetId !== null || isComposing || matrixRunning}
                          savingAssetId={savingAssetId}
                          error={assetSelectionError?.shotId === clip.shotId ? assetSelectionError.message : undefined}
                          onSelect={(asset) => { void selectAsset(asset); }}
                        />
                      </CardContent>
                    </Card>

                    {/* 转场选择器（最后一个片段后面不显示） */}
                    {index < clips.length - 1 && (
                      <div className="flex items-center justify-center py-1.5">
                        <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-muted/20 border border-border/30">
                          <LuChevronDown className="w-3 h-3 text-muted-foreground" />
                          <select
                            aria-label={locale === "en" ? `Transition from shot ${clip.shotId} to shot ${clips[index + 1].shotId}` : `镜头 ${clip.shotId} 到镜头 ${clips[index + 1].shotId} 的转场`}
                            value={clips[index + 1].transition}
                            onChange={(e) => updateTransition(clips[index + 1].shotId, e.target.value)}
                            className="text-[11px] text-muted-foreground bg-transparent border-none outline-none cursor-pointer"
                          >
                            <option value="direct_concat">{t(transitionLabels.direct_concat)}</option>
                            <option value="ffmpeg_fade">{t(transitionLabels.ffmpeg_fade)}</option>
                          </select>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 右侧：合成配置 */}
          <div className="lg:col-span-1 space-y-4">
            <h2 className="text-base font-semibold">{t("composeSettings")}</h2>

            {/* style packs: apply a whole look at once; import shared packs / export the current settings */}
            {!premiumCg && !tidewe && <Card className="glass-card">
              <CardContent className="p-4 space-y-3">
                <Label className="text-sm font-medium">{t("stylePackLabel")}</Label>
                <div className="grid grid-cols-2 gap-2">
                  {BUILTIN_STYLE_PACKS.map((p) => (
                    <button
                      key={p.name}
                      onClick={() => applyStylePack(p)}
                      title={p.description}
                      className="h-9 rounded-md text-xs border border-border/50 bg-muted/20 text-muted-foreground hover:border-primary/40 hover:text-primary transition-all px-1 truncate"
                    >
                      {p.name.split(" / ")[0]}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => packFileRef.current?.click()}
                    className="h-8 rounded-md text-xs border border-border/50 bg-muted/20 text-muted-foreground hover:border-primary/40 transition-all"
                  >
                    {t("stylePackImport")}
                  </button>
                  <button
                    onClick={exportStylePack}
                    className="h-8 rounded-md text-xs border border-border/50 bg-muted/20 text-muted-foreground hover:border-primary/40 transition-all"
                  >
                    {t("stylePackExport")}
                  </button>
                </div>
                <input
                  ref={packFileRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void importStylePack(f);
                    e.target.value = ""; // allow re-importing the same file
                  }}
                />
                {packNotice && <p className="text-[11px] text-primary">{packNotice}</p>}
                <p className="text-[11px] text-muted-foreground">{t("stylePackHint")}</p>
              </CardContent>
            </Card>}

            {/* 配音设置 */}
            {!premiumCg && <Card className="glass-card">
              <CardContent className="p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">{t("ttsLabel")}</Label>
                  {!paidTtsReady && (
                    <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-500">{t("ttsFreeBadge")}</span>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{t("ttsEnableLabel")}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-label={t("ttsEnableLabel")}
                    aria-checked={config.ttsEnabled}
                    onClick={() => setConfig((c) => ({ ...c, ttsEnabled: !c.ttsEnabled }))}
                    className={`relative w-10 h-5 rounded-full transition-colors ${config.ttsEnabled ? "bg-primary" : "bg-muted"}`}
                  >
                    <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${config.ttsEnabled ? "translate-x-5" : "translate-x-0.5"}`} />
                  </button>
                </div>
                <p className="text-[11px] text-muted-foreground">{tidewe ? t("ttsTideweHint") : t("ttsAutoHint")}</p>
                {tideweNativeSpeech && config.ttsEnabled && config.voiceoverMode === "auto" && <p className="text-[11px] text-muted-foreground">{tt("nativeSpeechHint")}</p>}
                <div className={`space-y-3 ${config.ttsEnabled ? "" : "opacity-50"}`}>
                  {([
                    { mode: "replace", label: "ttsReplaceLabel", hint: "ttsReplaceHint" },
                    { mode: "mix", label: "ttsMixLabel", hint: "ttsMixHint" },
                  ] as const).map(({ mode, label, hint }) => (
                    <div key={mode} className="flex items-center justify-between gap-3">
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">{t(label)}</p>
                        <p id={`voiceover-${mode}-hint`} className="text-[11px] text-muted-foreground">{t(hint)}</p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-label={t(label)}
                        aria-describedby={`voiceover-${mode}-hint`}
                        aria-checked={config.voiceoverMode === mode}
                        disabled={!config.ttsEnabled}
                        onClick={() => setConfig((c) => ({ ...c, voiceoverMode: c.voiceoverMode === mode ? "auto" : mode }))}
                        className={`relative h-5 w-10 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed ${config.voiceoverMode === mode ? "bg-primary" : "bg-muted"}`}
                      >
                        <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${config.voiceoverMode === mode ? "translate-x-5" : "translate-x-0.5"}`} />
                      </button>
                    </div>
                  ))}
                </div>
                {config.ttsEnabled && paidTtsReady && (
                  <p className="text-[11px] text-muted-foreground">
                    {t("ttsPaidHint", { provider: getTTSProviderMeta(tts.provider).label })}
                  </p>
                )}
                {config.ttsEnabled && !paidTtsReady && (
                  <div className="space-y-2">
                    <Select value={config.freeVoice} onValueChange={(v) => setConfig((c) => ({ ...c, freeVoice: v ?? c.freeVoice }))}>
                      <SelectTrigger aria-label={t("ttsVoiceLabel")} className="bg-muted/30 border-border/50 text-xs">
                        {/* Base UI 的 Select.Value 默认显示原始 value，用函数子节点映射为中文标签 */}
                        <SelectValue>
                          {(value: string) => {
                            const o = availableFreeVoices.find((o) => o.value === value);
                            return o?.labelKey ? t(o.labelKey) : o?.label ?? value;
                          }}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {availableFreeVoices.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.labelKey ? t(o.labelKey) : o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FreeVoicePreview
                      key={`${config.freeVoice}:${locale}`}
                      voice={config.freeVoice}
                      text={tidewe ? "The walk in is one thing. Sitting still on a cold morning is another." : t("ttsPreviewText")}
                    />
                  </div>
                )}
                {/* 人声落地：TTS 旁白过手机麦频段+AGC 压缩+房间底噪垫底，摆脱「播音棚干声」感（原生模型人声不经过此链） */}
                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-muted-foreground">{t("voiceGroundLabel")}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-label={t("voiceGroundLabel")}
                    aria-checked={config.voiceGround}
                     disabled={!config.ttsEnabled}
                    onClick={() => setConfig((c) => ({ ...c, voiceGround: !c.voiceGround }))}
                    className={`relative w-10 h-5 rounded-full transition-colors ${config.voiceGround ? "bg-primary" : "bg-muted"}`}
                  >
                    <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${config.voiceGround ? "translate-x-5" : "translate-x-0.5"}`} />
                  </button>
                </div>
              </CardContent>
            </Card>}

            {/* 字幕设置 */}
            {!premiumCg && <Card className="glass-card">
              <CardContent className="p-4 space-y-3">
                <Label className="text-sm font-medium">{t("subtitleLabel")}</Label>
                <div className="flex items-center justify-between">
                  <Label htmlFor="compose-subtitles" className="text-xs text-muted-foreground">{t("subtitleEnableLabel")}</Label>
                  <button
                    id="compose-subtitles"
                    type="button"
                    role="switch"
                    aria-label={t("subtitleEnableLabel")}
                    aria-describedby="compose-subtitles-hint"
                    aria-checked={config.subtitles}
                    onClick={() => setConfig((c) => ({ ...c, subtitles: !c.subtitles }))}
                    className={`relative w-10 h-5 rounded-full transition-colors ${config.subtitles ? "bg-primary" : "bg-muted"}`}
                  >
                    <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${config.subtitles ? "translate-x-5" : "translate-x-0.5"}`} />
                  </button>
                </div>
                <p id="compose-subtitles-hint" className="text-[11px] text-muted-foreground">{t("subtitleEnableHint")}</p>
                <div className={`grid grid-cols-3 gap-2 ${config.subtitles ? "" : "opacity-50"}`}>
                  {(["bottom", "center", "top"] as const).map((pos) => (
                    <button
                      key={pos}
                      disabled={!config.subtitles}
                      onClick={() => setConfig((c) => ({ ...c, subtitlePosition: pos }))}
                      className={`h-9 rounded-md text-xs border transition-all disabled:cursor-not-allowed ${
                        config.subtitlePosition === pos
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border/50 bg-muted/20 text-muted-foreground hover:border-primary/40"
                      }`}
                    >
                      {pos === "bottom" ? t("subtitleBottom") : pos === "center" ? t("subtitleCenter") : t("subtitleTop")}
                    </button>
                  ))}
                </div>
                {/* caption style preset: standard boxed / bold punch / minimal / karaoke word-by-word */}
                <div className={`space-y-1.5 pt-1 ${config.subtitles ? "" : "opacity-50"}`}>
                  <span className="text-xs text-muted-foreground">{t("captionStyleLabel")}</span>
                  <div className="grid grid-cols-2 gap-2">
                    {(["standard", "bold", "minimal", "karaoke"] as const).map((preset) => (
                      <button
                        key={preset}
                        disabled={!config.subtitles}
                        onClick={() => setConfig((c) => ({ ...c, captionPreset: preset }))}
                        className={`h-9 rounded-md text-xs border transition-all disabled:cursor-not-allowed ${
                          config.captionPreset === preset
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border/50 bg-muted/20 text-muted-foreground hover:border-primary/40"
                        }`}
                      >
                        {t(`captionPreset_${preset}`)}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground">{t(`captionPresetDesc_${config.captionPreset}`)}</p>
                </div>
              </CardContent>
            </Card>}

            {/* 带货转化：购买 CTA 片尾 */}
            {!premiumCg && !tidewe && <Card className="glass-card">
              <CardContent className="p-4 space-y-3">
                <Label className="text-sm font-medium">{t("complianceLabel")}</Label>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{t("ctaLabel")}</span>
                  <button
                    onClick={() =>
                      setConfig((c) => {
                        const enabling = !c.ctaEnabled;
                        // 开启且文案为空时，用当前语言的 placeholder 预填，保留一键便利又随语言走
                        return { ...c, ctaEnabled: enabling, ctaText: enabling && !c.ctaText.trim() ? t("ctaPlaceholder") : c.ctaText };
                      })
                    }
                    className={`relative w-10 h-5 rounded-full transition-colors ${config.ctaEnabled ? "bg-primary" : "bg-muted"}`}
                  >
                    <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${config.ctaEnabled ? "translate-x-5" : "translate-x-0.5"}`} />
                  </button>
                </div>
                {config.ctaEnabled && (
                  <Input
                    value={config.ctaText}
                    onChange={(e) => setConfig((c) => ({ ...c, ctaText: e.target.value }))}
                    placeholder={t("ctaPlaceholder")}
                    className="bg-muted/30 border-border/50 text-xs"
                  />
                )}
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{t("productCardLabel")}</span>
                  <button
                    onClick={() => setConfig((c) => ({ ...c, productCard: !c.productCard }))}
                    className={`relative w-10 h-5 rounded-full transition-colors ${config.productCard ? "bg-primary" : "bg-muted"}`}
                  >
                    <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${config.productCard ? "translate-x-5" : "translate-x-0.5"}`} />
                  </button>
                </div>
              </CardContent>
            </Card>}

            {/* 画面设置 */}
            <Card className="glass-card">
              <CardContent className="p-4 space-y-4">
                <Label className="text-sm font-medium">{t("canvasLabel")}</Label>
                {/* 渲染质量预设：快速/标准/高清（选中同步分辨率） */}
                <div className="space-y-2">
                  <span className="text-xs text-muted-foreground">{t("renderQualityLabel")}</span>
                  <div className="grid grid-cols-3 gap-2">
                    {(["fast", "standard", "hd"] as const).map((preset) => (
                      <button
                        key={preset}
                        onClick={() =>
                          setConfig((c) => ({ ...c, renderPreset: preset, resolution: RENDER_PRESETS[preset].resolution }))
                        }
                        className={`flex flex-col items-center gap-0.5 rounded-md py-1.5 text-xs border transition-all ${
                          config.renderPreset === preset
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border/50 bg-muted/20 text-muted-foreground hover:border-primary/40"
                        }`}
                      >
                        <span className="font-medium">{t(`renderPreset_${preset}`)}</span>
                        <span className="text-[10px] opacity-70">{RENDER_PRESETS[preset].resolution}</span>
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground">{t(`renderPresetDesc_${config.renderPreset}`)}</p>
                </div>
                {/* 比例 */}
                <div className="space-y-2">
                  <span className="text-xs text-muted-foreground">{t("aspectRatioLabel")}</span>
                  <div className="grid grid-cols-3 gap-2">
                    {(["9:16", "16:9", "1:1"] as const).map((ratio) => (
                      <button
                        key={ratio}
                        onClick={() => setConfig((c) => ({ ...c, aspectRatio: ratio }))}
                        className={`h-9 rounded-md text-xs border transition-all ${
                          config.aspectRatio === ratio
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border/50 bg-muted/20 text-muted-foreground hover:border-primary/40"
                        }`}
                      >
                        {ratio === "9:16" ? t("aspectVertical") : ratio === "16:9" ? t("aspectHorizontal") : t("aspectSquare")}
                      </button>
                    ))}
                  </div>
                </div>
                {/* 分辨率 */}
                <div className="space-y-2">
                  <span className="text-xs text-muted-foreground">{t("resolutionLabel")}</span>
                  <div className="grid grid-cols-2 gap-2">
                    {(["720p", "1080p"] as const).map((res) => (
                      <button
                        key={res}
                        onClick={() => setConfig((c) => ({ ...c, resolution: res }))}
                        className={`h-9 rounded-md text-xs border transition-all ${
                          config.resolution === res
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border/50 bg-muted/20 text-muted-foreground hover:border-primary/40"
                        }`}
                      >
                        {res}
                      </button>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* 合成按钮 */}
            <div className="space-y-3">
              {/* 背景音乐（可选，合成时混入并自动压低让位配音） */}
              <div className="space-y-3 p-3 rounded-lg border border-border/40 bg-muted/10">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium">{t("bgmOptionalTitle")}</p>
                    <p className="text-[11px] text-muted-foreground truncate">{bgm ? t("bgmSelected", { name: bgm.name }) : t("bgmUploadHint")}</p>
                  </div>
                  <label className="shrink-0">
                    <input type="file" accept="audio/*" className="hidden" disabled={isComposing || bgmUploading}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadBgm(f); e.target.value = ""; }} />
                    <span className={`inline-flex items-center h-8 px-3 rounded-md border border-border/60 text-xs cursor-pointer hover:border-primary/50 ${(isComposing || bgmUploading) ? "opacity-50 pointer-events-none" : ""}`}>
                      {bgmUploading ? t("bgmUploading") : bgm ? t("bgmReplace") : t("bgmUploadCta")}
                    </span>
                  </label>
                </div>
                {bgm && <>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{t("bgmVolumeLabel")}</span>
                      <span className="tabular-nums">{Math.round(config.bgmVolume * 100)}%</span>
                    </div>
                    <input type="range" min={5} max={40} step={1}
                      value={Math.round(config.bgmVolume * 100)}
                      onChange={(event) => setConfig((c) => ({ ...c, bgmVolume: Number(event.target.value) / 100 }))}
                      className="w-full accent-primary" aria-label={t("bgmVolumeLabel")} />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">{t("bgmDuckLabel")}</span>
                    <button type="button" role="switch" aria-label={t("bgmDuckLabel")} aria-checked={config.bgmDuck}
                      onClick={() => setConfig((c) => ({ ...c, bgmDuck: !c.bgmDuck }))}
                      className={`relative w-10 h-5 shrink-0 rounded-full transition-colors ${config.bgmDuck ? "bg-primary" : "bg-muted"}`}>
                      <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${config.bgmDuck ? "translate-x-5" : "translate-x-0.5"}`} />
                    </button>
                  </div>
                </>}
              </div>

              {/* 合成进度 */}
              {(isComposing || composeDone) && (
                <div>
                  <div className="h-2 bg-muted/30 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-200 ${composeDone ? "bg-emerald-500" : "brand-gradient"}`}
                      style={{ width: `${composeProgress}%` }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground text-center mt-2">
                    {composeDone ? t("composeDoneMsg") : t("composingMsg", { progress: composeProgress })}
                  </p>
                </div>
              )}

              {/* 合成失败提示 */}
              {composeError && (
                <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
                  <p className="text-xs text-destructive break-words whitespace-pre-wrap">⚠ {composeError}</p>
                </div>
              )}

              {/* 成片预览 */}
              {composeDone && outputUrl && (
                <div className="rounded-lg overflow-hidden border border-border/50 bg-black">
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <video src={outputUrl} controls className="w-full max-h-[360px]" />
                </div>
              )}

              <Button
                onClick={startCompose}
                disabled={isComposing || matrixRunning || savingAssetId !== null || !scriptId || clips.length === 0}
                className="w-full brand-gradient text-white"
              >
                {isComposing ? (
                  <>
                    <LuLoaderCircle className="animate-spin mr-2 h-4 w-4" />
                    {t("composing")}
                  </>
                ) : composeDone ? (
                  t("composeRedo")
                ) : (
                  <>
                    <LuPlay className="w-4 h-4 mr-1" />
                    {t("composeStart")}
                  </>
                )}
              </Button>

              {composeDone && outputUrl && (
                <>
                  <a href={`${outputUrl}?download=1`} download>
                    <Button variant="outline" className="w-full">{t("downloadVideo")}</Button>
                  </a>
                  <Link href={`/project/${id}/export`}>
                    <Button className="w-full bg-emerald-600 hover:bg-emerald-700 text-white">
                      {t("nextExport")}
                      <LuArrowRight className="w-4 h-4 ml-1" />
                    </Button>
                  </Link>
                </>
              )}

              {/* Variant matrix: hook × caption × BGM combos as
                  labeled outputs — same assets, compose-only reruns, zero AI-gen cost */}
              {!premiumCg && !tidewe && clips.length > 0 && (
                <div className="rounded-lg border border-border/50 bg-muted/10 p-3 space-y-2">
                  <button
                    type="button"
                    onClick={toggleMatrixOpen}
                    className="w-full flex items-center justify-between text-sm font-medium"
                  >
                    <span>🧪 {t("matrixTitle")}</span>
                    <span className="text-xs text-muted-foreground">{matrixOpen ? "−" : "+"}</span>
                  </button>
                  {matrixOpen && (
                    <div className="space-y-3 text-xs pt-1">
                      <p className="text-muted-foreground leading-relaxed">{t("matrixDesc")}</p>
                      <div>
                        <p className="font-medium mb-1.5">{t("matrixHooks")}</p>
                        <div className="flex flex-wrap gap-1.5">
                          {[{ key: "base", name: t("matrixBaseHook") }, ...hookVariants.map((v) => ({ key: v.hookId, name: v.hookName }))].map((h) => (
                            <button
                              key={h.key}
                              type="button"
                              onClick={() => toggleInSet(setMatrixHooks, h.key)}
                              className={`rounded-full border px-2 py-0.5 transition-all ${
                                matrixHooks.has(h.key)
                                  ? "border-primary bg-primary/10 text-primary"
                                  : "border-border/60 text-muted-foreground hover:border-primary/40"
                              }`}
                            >
                              {h.name}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <p className="font-medium mb-1.5">{t("matrixCaptions")}</p>
                        {!config.subtitles && <p className="text-muted-foreground">{t("matrixNoSubtitles")}</p>}
                        <div className={`flex flex-wrap gap-1.5 ${config.subtitles ? "" : "opacity-50"}`}>
                          {CAPTION_PRESET_IDS.map((c) => (
                            <button
                              key={c}
                              type="button"
                              disabled={!config.subtitles}
                              onClick={() => toggleInSet(setMatrixCaptions, c)}
                              className={`rounded-full border px-2 py-0.5 transition-all disabled:cursor-not-allowed ${
                                matrixCaptions.has(c)
                                  ? "border-primary bg-primary/10 text-primary"
                                  : "border-border/60 text-muted-foreground hover:border-primary/40"
                              }`}
                            >
                              {c}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground">{t("matrixCount", { n: matrixCombos.length, max: MATRIX_MAX })}</span>
                        <Button
                          size="sm"
                          className="text-xs"
                          disabled={matrixRunning || matrixCombos.length === 0 || isComposing || savingAssetId !== null || !scriptId}
                          onClick={runMatrix}
                        >
                          {matrixRunning ? (
                            <>
                              <LuLoaderCircle className="animate-spin mr-1 h-3 w-3" />
                              {t("matrixRunning", {
                                done: matrixResults.filter((r) => r.status !== "composing").length,
                                total: matrixResults.length,
                              })}
                            </>
                          ) : (
                            t("matrixRun", { n: matrixCombos.length })
                          )}
                        </Button>
                      </div>
                      {matrixResults.length > 0 && (
                        <div className="space-y-1">
                          {matrixResults.map((r) => (
                            <div key={r.label} className="flex flex-wrap items-center gap-2">
                              {r.status === "composing" ? (
                                <LuLoaderCircle className="animate-spin h-3 w-3 shrink-0 text-muted-foreground" />
                              ) : r.status === "done" ? (
                                <span className="text-emerald-500 shrink-0">✓</span>
                              ) : (
                                <span className="text-destructive shrink-0">✗</span>
                              )}
                              <span className="truncate text-muted-foreground">{r.label}</span>
                              {r.url && (
                                <a href={r.url} target="_blank" rel="noreferrer" className="text-primary underline shrink-0">
                                  {t("matrixView")}
                                </a>
                              )}
                              {r.error && <p className="w-full text-destructive text-xs break-words whitespace-pre-wrap">{r.error}</p>}
                            </div>
                          ))}
                          <p className="text-[10px] text-muted-foreground pt-1">{t("matrixExportHint")}</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
