"use client";

import { useModelCatalog } from "@/lib/hooks/use-model-catalog";
import { ModelCatalogStatus } from "@/components/model-catalog-status";
import { configuredCatalogProviders } from "@/lib/model-catalog";
import { KlingJobDetail, klingJobBlocksSubmission, klingJobStatus } from "@/components/kling-job-detail";
import { KlingJobsList } from "@/components/kling-jobs-list";
import { KlingShotGenerator } from "@/components/kling-shot-generator";
import { ApiShotGenerator, VideoGenerationFailure } from "@/components/video-generation-dialog";
import { StoryboardFilmPanel } from "@/components/storyboard-film-panel";
import { BatchMotionPanel } from "@/components/batch-motion-panel";
import { KeyframeRefinementDialog } from "@/components/keyframe-refinement-dialog";
import type { BatchMotionDraft } from "@/lib/batch-motion";
import { klingFetch, klingErrorMessage } from "@/lib/kling/client";
import type { KlingJobView } from "@/lib/kling/job-types";
import { KLING_MAX_CONCURRENT_SHOTS, type KlingConcurrencyStatus } from "@/lib/kling/concurrency";
import type { KlingPublicStatus } from "@/lib/kling/types";

import { Suspense, useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { LuZap, LuCheck, LuCircleX, LuImage, LuArrowRight, LuLoaderCircle, LuTriangleAlert, LuUpload, LuScissors, LuPlay, LuFileText, LuSparkles } from "react-icons/lu";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { SHOW_TEXT_EDITOR } from "@/lib/ui-features";
import { mergeCustomModels, buildImageOptions, buildVideoOptions, toEditVariant } from "@/lib/gen-params";
import { DEFAULT_STORYBOARD_GRID_RESOLUTION, type StoryboardGridResolution } from "@/lib/storyboard-grid-resolution";
import { useCharacterStore } from "@/lib/stores/project-store";
import type { Shot } from "@/lib/db/schema";
import { buildAssetRows, shouldOfferStockFill, needsImageModelWarning, nextChainKeyframe, type AssetItem, chainByDefault, isKlingVideoSelection } from "@/lib/assets-view";
import { realMixFromRows, shotReality } from "@/lib/real-mix";
import { fetchVideoPrompt } from "@/lib/video-prompt-client";
import type { VideoPromptRequest } from "@/lib/video-prompt-request";
import { validateVideoPrompt } from "@/lib/video-prompt";
import { keyframeInstantLine } from "@/lib/prompt-lint";
import { RETAKE_SYMPTOMS, type RetakeSymptom } from "@/lib/retake-patch";
import {
  CAMERA_PRESETS,
  CAMERA_PRESET_CATEGORIES,
  getCameraPreset,
  cameraPresetPrompt,
  recommendedPresets,
  findPresetByPrompt,
  mixablePresets,
  mixCameraPrompt,
  type CameraPresetCategory,
} from "@/lib/camera-presets";
import { LOOK_PRESETS, lookImageSuffix } from "@/lib/look-presets";
import { realFaceLine } from "@/lib/presenters";
import { modelSupportsLastFrame } from "@/lib/video-composer/transitions";
import {
  sanitizeVideoControlSummary,
  sanitizeVideoSourceContext,
  type VideoSourceContext,
} from "@/lib/video-control-plan";
import type { GenerationControlSummary } from "@/lib/video-repair-plan";
import { useT, useLocale } from "@/lib/i18n";
import { LocalMaterialLibrary } from "./_components/local-material-library";
import { ShotMaterialPreview } from "./_components/shot-material-preview";
import { AssetImagePreview } from "./_components/asset-image-preview";
import { classifyMaterial, MATERIAL_ACCEPT, type PublicLocalMaterial } from "@/lib/material-library";
import { uploadLocalMaterial, type MaterialUploadProgress } from "@/lib/upload-local-material";
import { ProjectHeader } from "@/components/project-header";
import { ModelCapabilityPreflight } from "@/components/model-capability-preflight";
import {
  checkPromptConsistency,
  compileCreativePrompt,
  sanitizeCreativeIntent,
  sanitizeVisualBible,
  type CreativeIntent,
  type VisualBible,
} from "@/lib/production-system";
import { isPremiumProductCgProfile, isTideweOutdoorProfile, isTideweNativeSpeech } from "@/lib/creative-profiles";
import { compileTideweVisualPrompt } from "@/lib/tidewe/visual-policy";
import { tidewePresenterReference } from "@/lib/tidewe/presenter";

// shot type labels (label changed to i18n key in the assets namespace, resolved per locale)
const shotTypeLabels: Record<Shot["type"], { key: string; color: string }> = {
  hook: { key: "shotTypeHook", color: "bg-red-500/20 text-red-400" },
  pain_point: { key: "shotTypePainPoint", color: "bg-orange-500/20 text-orange-400" },
  product_reveal: { key: "shotTypeProductReveal", color: "bg-blue-500/20 text-blue-400" },
  demo: { key: "shotTypeDemo", color: "bg-green-500/20 text-green-400" },
  social_proof: { key: "shotTypeSocialProof", color: "bg-purple-500/20 text-purple-400" },
  cta: { key: "shotTypeCta", color: "bg-amber-500/20 text-amber-400" },
};

// platform info for the default image model (used when initiating generation requests)
interface ImageModelTarget {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  supportsAudio?: boolean;
  profileId?: string;
}

// persisted cloud AI task row (from /api/ai/tasks, issue #16 recovery flow)
interface PendingAiTask {
  id: string;
  shotId: number | null;
  provider: string;
  model: string;
  taskId: string;
  prompt?: string;
  mode?: string;
  status: "submitted" | "processing" | "completed" | "failed" | "unknown";
  controlPlan?: GenerationControlSummary | null;
}

interface PreparedMotion extends BatchMotionDraft {
  asset: AssetItem;
  selectionKey: string;
  profileId?: string;
  scriptId: string;
  configurationKey: string;
  provider: string;
  prompt: string;
  firstFrameUrl: string;
  lastFrameUrl?: string;
  referenceImages: string[];
  apiImages: Array<{ label: string; url: string }>;
  validateAssetSelection: boolean;
  options: Record<string, unknown>;
  klingParameters: Record<string, unknown>;
  generate(): Promise<void>;
}

function motionAssetKey(asset: AssetItem) {
  return JSON.stringify([asset.assetId, asset.thumbnailUrl, asset.status, asset.isVideo,
    asset.type, asset.duration, asset.camera, asset.description, asset.prompt, asset.voiceover, asset.characterId, asset.visualSource, asset.tidewe]);
}

function sameTideweScene(first: AssetItem | undefined, second: AssetItem | undefined) {
  return Boolean(first?.tidewe?.sceneId && first.tidewe.sceneId === second?.tidewe?.sceneId
    && first.tidewe.productVisible === second.tidewe.productVisible
    && first.tidewe.personVisible === second.tidewe.personVisible);
}

// shot types that "feature the product": when product fidelity is enabled, these AI shots use image-to-image (redraw with product photo to lock in the subject)
const PRODUCT_SHOT_TYPES = new Set(["product_reveal", "demo", "cta"]);

export default function AssetsPage() {
  return <Suspense fallback={null}><AssetsPageContent /></Suspense>;
}

function AssetsPageContent() {
  const t = useT("assets");
  const tw = useT("tidewe");
  const tc = useT("common");
  const tm = useT("materials");
  const locale = useLocale();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedJob = searchParams.get("klingJob");
  const requestedFilm = searchParams.get("klingFilm") || searchParams.get("film");
  const { providers, defaultImageModel, defaultVideoModel, customModels, imageParams, videoParams, llm, motionIntensity, setMotionIntensity, motionRealism, setMotionRealism, chainMode, setChainMode, visualLook, setVisualLook } = useSettingsStore();
  // beginner/director split: simple mode hides the director panel, the storyboard-grid button
  // and per-shot camera tooling — beginners see shots + generate, nothing else
  const uiMode = useSettingsStore((st) => st.uiMode);

  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [productImages, setProductImages] = useState<string[]>([]);
  // product fidelity: when AI generates shots featuring the product, use the original product photo as a reference for redrawing to prevent AI from altering the product (critical for commerce)
  const [productSafe, setProductSafe] = useState(true);
  // after image generation, automatically run image-to-video to produce real motion shots (i2v quality path, replacing fake Ken-Burns camera moves). Only active when a video model is configured.
  const [autoMotion, setAutoMotion] = useState(true);
  const [projectName, setProjectName] = useState("");
  // project type: topic (one-sentence-to-video without a product) uses the free stock library for automatic visuals
  const [contentType, setContentType] = useState<string>("");
  // project product category — unlocks the category physical-realism layers in the i2v motion prompt
  const [projectCategory, setProjectCategory] = useState<string>("");
  const [projectCreativeIntent, setProjectCreativeIntent] = useState<CreativeIntent>({ subject: "" });
  const [projectVisualBible, setProjectVisualBible] = useState<VisualBible>({ characterAnchors: [], productAnchors: [], wardrobeAnchors: [], environmentAnchors: [], lightingAnchors: [], forbiddenChanges: [] });
  const [projectCreativeProfile, setProjectCreativeProfile] = useState<unknown>();
  // real tail frames of videos generated THIS session (shotId → extracted last-frame URL);
  // tail-chain mode starts the next shot from here for a pixel-continuous cut
  const lastFrameByShot = useRef(new Map<number, string>());
  // shots currently being converted to motion
  const [motionShots, setMotionShots] = useState<Set<number>>(new Set());
  const [unresolvedMotionShots, setUnresolvedMotionShots] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const assetsRequest = useRef(0);
  const [isBatchGenerating, setIsBatchGenerating] = useState(false);
  // state for "auto-fill visuals (free stock)" feature
  const [isFillingStock, setIsFillingStock] = useState(false);
  const [stockMsg, setStockMsg] = useState<string | null>(null);
  // cloud paid tasks with unretrieved results (issue #16): submitted/processing/unknown rows
  // persisted server-side the moment the provider acknowledged the task
  const [pendingTasks, setPendingTasks] = useState<PendingAiTask[]>([]);
  const [resumingTasks, setResumingTasks] = useState<Set<string>>(new Set());
  const [taskMsg, setTaskMsg] = useState<string | null>(null);
  const [klingJobs, setKlingJobs] = useState<KlingJobView[]>([]);
  const [klingJobsError, setKlingJobsError] = useState<string | null>(null);
  const [klingJobsLoaded, setKlingJobsLoaded] = useState(false);
  const [klingConcurrency, setKlingConcurrency] = useState<KlingConcurrencyStatus>();
  const [klingJobId, setKlingJobId] = useState<string | null>(null);
  const [motionDraft, setMotionDraft] = useState<PreparedMotion | null>(null);
  const [batchMotion, setBatchMotion] = useState<{
    scriptId: string;
    configurationKey: string;
    shots: Array<{ asset: AssetItem; draft?: BatchMotionDraft; disabledReason?: string }>;
  } | null>(null);
  const [preparingBatchMotion, setPreparingBatchMotion] = useState(false);
  const [batchMotionBusy, setBatchMotionBusy] = useState(false);
  const batchMotionLock = useRef(false);
  const motionContext = useRef<{ scriptId: string; scriptHash: string; configurationKey: string; assets: AssetItem[] }>({ scriptId: "", scriptHash: "", configurationKey: "", assets: [] });
  // Batch generation must await confirmation instead of replacing one pending dialog with another.
  const motionDraftDone = useRef<(() => void) | null>(null);
  const motionPreparation = useRef<AbortController | null>(null);
  const batchPreparation = useRef<AbortController | null>(null);
  const finishMotionDraft = useCallback(() => {
    setMotionDraft(null);
    const resolve = motionDraftDone.current;
    motionDraftDone.current = null;
    resolve?.();
  }, []);
  const [klingFilmOpen, setKlingFilmOpen] = useState(false);
  const [klingFilmRunId, setKlingFilmRunId] = useState<string | undefined>();
  const [filmTaskId, setFilmTaskId] = useState<string | undefined>();
  const hadTaskQuery = useRef(false);
  // per-shot camera editing (preset picker + inline free text): edits persist into the
  // selected script's shots via the scripts PATCH, so the next (re)generation uses them
  const [scriptId, setScriptId] = useState<string>("");
  const [scriptHash, setScriptHash] = useState("");
  const [creativeConfigRevision, setCreativeConfigRevision] = useState(0);
  const [scriptTitle, setScriptTitle] = useState("");
  const [editingCameraShot, setEditingCameraShot] = useState<number | null>(null);
  const [cameraDraft, setCameraDraft] = useState("");
  const [savingCameraShot, setSavingCameraShot] = useState<number | null>(null);
  // storyboard grid: one generation renders all shots in a 3x3 grid → cells become keyframes
  const [isGridGenerating, setIsGridGenerating] = useState(false);
  const [gridResolution, setGridResolution] = useState<StoryboardGridResolution>(DEFAULT_STORYBOARD_GRID_RESOLUTION);
  const [gridNotice, setGridNotice] = useState<string | null>(null);
  const [keyframeRefinement, setKeyframeRefinement] = useState<{
    scriptId: string;
    initialShotId?: number;
    shots: Array<{ assetId: string; shotId: number; imageUrl: string; description: string }>;
  } | null>(null);
  const [keyframeRefinementBusy, setKeyframeRefinementBusy] = useState(false);
  // on-camera presenter from the character library; their multi-view sheet rides the
  // grid and film passes as an identity reference so the person stops morphing
  const { characters: presenterLib } = useCharacterStore();
  const [presenterId, setPresenterId] = useState("");
  const boundPresenter = isTideweOutdoorProfile(projectCreativeProfile) ? projectCreativeProfile.presenter : undefined;
  const presenterSheet = isTideweOutdoorProfile(projectCreativeProfile)
    ? tidewePresenterReference(projectCreativeProfile)
    : presenterLib.find((c) => c.id === presenterId)?.referenceImages?.[0];

  const doneCount = assets.filter((a) => a.status === "done").length;
  const allDone = assets.length > 0 && doneCount === assets.length;
  // real/AI mix metering (duration-weighted) — Douyin tilts traffic toward hybrid content at ≥50% real
  const mix = realMixFromRows(assets);
  const enabledCatalogProviders = configuredCatalogProviders(providers);
  const catalog = useModelCatalog(enabledCatalogProviders);
  const [modelTarget, videoModelTarget] = useMemo((): [ImageModelTarget | null, ImageModelTarget | null] => {
    const enabled = configuredCatalogProviders(providers);
    const names = new Set(enabled.map((p) => p.name));
    const resolve = (type: "image" | "video", modelId: string) => {
      const model = mergeCustomModels(catalog.models.filter((item) => item.mediaType === type), customModels, type, names).find((item) => item.id === modelId);
      const provider = model && enabled.find((item) => item.name === model.provider);
      return model && (model.provider === "kling-cli" || model.extra?.available !== false) && provider ? { provider: provider.name, model: modelId, apiKey: provider.apiKey ?? "", baseUrl: provider.baseUrl, supportsAudio: model.provider === "kling-cli" ? true : model.supportsAudio, profileId: provider.profileId } : null;
    };
    return [resolve("image", defaultImageModel), resolve("video", defaultVideoModel)];
  }, [providers, customModels, defaultImageModel, defaultVideoModel, catalog.models]);
  const isKlingDefault = videoModelTarget?.provider === "kling-cli" || isKlingVideoSelection(defaultVideoModel);
  const klingProfileId = providers["kling-cli"]?.profileId;
  const klingCapacityBlocked = Boolean(klingConcurrency && (klingConcurrency.blockedByUnknownSubmission || klingConcurrency.active >= klingConcurrency.max));
  const klingCapacityMessage = klingConcurrency?.blockedByUnknownSubmission ? "此账号有提交结果不明的任务，请先核对原任务再继续。" : `当前账号已占用全部 ${KLING_MAX_CONCURRENT_SHOTS} 个生成名额，请等待镜头完成后再提交。`;
  const klingEnabled = providers["kling-cli"]?.enabled === true;
  const videoConfigurationKey = JSON.stringify({ target: videoModelTarget, videoParams, visualLook, motionIntensity, motionRealism, chainMode, projectCategory, projectCreativeIntent, projectVisualBible, projectCreativeProfile, productSafe, productImages, presenterSheet, presenterLib: isTideweOutdoorProfile(projectCreativeProfile) ? undefined : presenterLib });
  const premiumCg = isPremiumProductCgProfile(projectCreativeProfile);
  const tidewe = isTideweOutdoorProfile(projectCreativeProfile);
  const tideweNative = isTideweNativeSpeech(projectCreativeProfile);
  const premiumCgVisualOnly = premiumCg && projectCreativeProfile.narrationMode === "none";
  // Premium CG always starts from the supplied product reference. Sales users may still
  // choose a freer text-to-image treatment through the existing toggle.
  const productReferenceLocked = premiumCg || tidewe || productSafe;
  const refinableShots = assets.flatMap((asset) => asset.assetId && asset.status === "done" && !asset.isVideo
    && asset.thumbnailUrl && !/\.(?:mp4|webm|mov|m4v)(?:[?#]|$)/i.test(asset.thumbnailUrl)
    ? [{ assetId: asset.assetId, shotId: asset.shotId, imageUrl: asset.thumbnailUrl, description: asset.description }]
    : []);
  const openKeyframeRefinement = (initialShotId?: number) => {
    if (!scriptId || !refinableShots.length || keyframeRefinementBusy || isGridGenerating || isBatchGenerating || batchMotionBusy) return;
    setKeyframeRefinement({ scriptId, shots: refinableShots, ...(initialShotId !== undefined && { initialShotId }) });
  };
  motionContext.current = { scriptId, scriptHash, configurationKey: videoConfigurationKey, assets };
  const batchMotionValid = Boolean(batchMotion && batchMotion.scriptId === scriptId && batchMotion.configurationKey === videoConfigurationKey);

  const motionDraftValid = Boolean(motionDraft && motionDraft.selectionKey === defaultVideoModel
    && motionDraft.scriptId === scriptId && motionDraft.configurationKey === videoConfigurationKey
    && videoModelTarget?.provider === motionDraft.provider
    && videoModelTarget?.profileId === motionDraft.profileId
    && (!motionDraft.validateAssetSelection || assets.find((asset) => asset.shotId === motionDraft.asset.shotId)?.assetId === motionDraft.asset.assetId));
  useEffect(() => { if (motionDraft && !motionDraftValid) finishMotionDraft(); }, [motionDraft, motionDraftValid, finishMotionDraft]);
  useEffect(() => () => {
    motionPreparation.current?.abort();
    batchPreparation.current?.abort();
    motionDraftDone.current?.();
  }, [id, scriptId, videoConfigurationKey]);

  // when no image model is configured (modelTarget is null), offer key-free users a free stock fill entry point
  const offerStockFill = !loading && shouldOfferStockFill(assets, contentType, modelTarget !== null);
  // only show the "configure a model" warning when there are still AI shots that need generating (no warning once everything is ready, to avoid contradicting the "all done" state)
  const showModelWarning = !loading && needsImageModelWarning(assets, modelTarget !== null);

  // load real data: project info + selected script shots + resolve the provider for the default image model
  useEffect(() => {
    let cancelled = false;
    const request = ++assetsRequest.current;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [projectRes, scriptsRes, assetsRes] = await Promise.all([
          fetch(`/api/project/${id}`),
          fetch(`/api/project/${id}/scripts`),
          fetch(`/api/project/${id}/assets`),
        ]);

        const project = projectRes.ok ? await projectRes.json() : null;
        const scripts = scriptsRes.ok ? await scriptsRes.json() : [];
        const savedAssets = assetsRes.ok ? await assetsRes.json() : [];
        if (cancelled) return;

        const imgs: string[] = project && Array.isArray(project.productImages) ? project.productImages : [];
        if (project) {
          setProjectName(project.name ?? project.productName ?? "");
          setProductImages(imgs);
          setContentType(typeof project.contentType === "string" ? project.contentType : "");
          setProjectCategory(typeof project.productCategory === "string" ? project.productCategory : "");
          setProjectCreativeProfile(project.creativeProfile);
          setCreativeConfigRevision(project.creativeConfigRevision ?? 0);
          setProjectCreativeIntent(sanitizeCreativeIntent(project.creativeIntent));
          setProjectVisualBible(sanitizeVisualBible(project.visualBible));
          const requestedPresenter = new URLSearchParams(window.location.search).get("presenter");
          setPresenterId(isTideweOutdoorProfile(project.creativeProfile) ? project.creativeProfile.presenter?.id ?? "" : requestedPresenter || (typeof project.characterId === "string" ? project.characterId : ""));
          if (Array.isArray(project.productionWorkflow)) {
            const motionStage = project.productionWorkflow.find((stage: { id?: unknown }) => stage.id === "motion");
            if (motionStage) setAutoMotion(motionStage.enabled !== false);
          }
        }
        if (request !== assetsRequest.current) return;

        // Historical scripts remain available, but only an explicit selection is current.
        const selected = Array.isArray(scripts)
          ? scripts.find((s: { selected?: boolean }) => s.selected)
          : null;

        if (!selected || !Array.isArray(selected.shots) || selected.shots.length === 0) {
          setScriptId("");
          setScriptHash("");
          setScriptTitle("");
          lastFrameByShot.current.clear();
          setAssets([]);
          setLoadError(t("errorNoScript"));
          return;
        }
        // remember which script row the view came from — camera edits PATCH back into it
        setScriptId(typeof selected.id === "string" ? selected.id : "");
        setScriptHash(typeof selected.scriptHash === "string" ? selected.scriptHash : "");
        setScriptTitle(typeof selected.title === "string" ? selected.title.trim() : "");

        // selected script shots + persisted assets → view rows (shared pure function used by "refresh after filling visuals")
        const rows = buildAssetRows(selected.shots as Shot[], Array.isArray(savedAssets) ? savedAssets : [], imgs);
        lastFrameByShot.current.clear();
        for (const row of rows) if (row.lastFrameUrl) lastFrameByShot.current.set(row.shotId, row.lastFrameUrl);
        setAssets(rows);
      } catch (e) {
        if (!cancelled && request === assetsRequest.current) setLoadError(e instanceof Error ? e.message : t("errorLoadFailed"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // re-fetch project / scripts / assets and rebuild view rows (refresh thumbnails after filling visuals, reuses the same pure function)
  const reloadAssets = useCallback(async () => {
    const request = ++assetsRequest.current;
    const [projectRes, scriptsRes, assetsRes] = await Promise.all([
      fetch(`/api/project/${id}`),
      fetch(`/api/project/${id}/scripts`),
      fetch(`/api/project/${id}/assets`),
    ]);
    const project = projectRes.ok ? await projectRes.json() : null;
    const scripts = scriptsRes.ok ? await scriptsRes.json() : [];
    const savedAssets = assetsRes.ok ? await assetsRes.json() : [];
    if (request !== assetsRequest.current) return;
    const imgs: string[] = project && Array.isArray(project.productImages) ? project.productImages : [];
    setProjectCreativeProfile(project?.creativeProfile);
    setCreativeConfigRevision(project?.creativeConfigRevision ?? 0);
    setProductImages(imgs);
    const selected = Array.isArray(scripts)
      ? scripts.find((s: { selected?: boolean }) => s.selected)
      : null;
    if (selected && Array.isArray(selected.shots) && selected.shots.length > 0) {
      setLoadError(null);
      setScriptId(typeof selected.id === "string" ? selected.id : "");
      setScriptHash(typeof selected.scriptHash === "string" ? selected.scriptHash : "");
      setScriptTitle(typeof selected.title === "string" ? selected.title.trim() : "");
      const rows = buildAssetRows(selected.shots as Shot[], Array.isArray(savedAssets) ? savedAssets : [], imgs);
      lastFrameByShot.current.clear();
      for (const row of rows) if (row.lastFrameUrl) lastFrameByShot.current.set(row.shotId, row.lastFrameUrl);
      setAssets(rows);
    } else {
      setScriptId("");
      setScriptHash("");
      setScriptTitle("");
      lastFrameByShot.current.clear();
      setAssets([]);
      setLoadError(t("errorNoScript"));
    }
  }, [id, t]);

  const importedKlingSignature = useRef("");
  const klingJobsRequest = useRef({ serial: 0 });
  const reloadKlingJobs = useCallback(async () => {
    const request = ++klingJobsRequest.current.serial;
    try {
      const [response, statusResponse] = await Promise.all([
        klingFetch(`/api/integrations/kling/jobs?projectId=${encodeURIComponent(id)}`),
        (klingEnabled || isKlingDefault) ? klingFetch(`/api/integrations/kling/status${klingProfileId ? `?profileId=${encodeURIComponent(klingProfileId)}` : ""}`).catch(() => null) : Promise.resolve(null),
      ]);
      const body = await response.json();
      if (!response.ok) throw new Error(klingErrorMessage(body));
      const status = statusResponse?.ok ? await statusResponse.json() as KlingPublicStatus : undefined;
      if (request !== klingJobsRequest.current.serial) return;
      setKlingConcurrency(status?.concurrency);
      const jobs = Array.isArray(body.jobs) ? body.jobs as KlingJobView[] : [];
      setKlingJobs(jobs); setKlingJobsError(null); setKlingJobsLoaded(true);
      const signature = JSON.stringify(jobs.flatMap((job) => job.outputs.map((output) => [output.assetId, output.selected])));
      const assetsChanged = importedKlingSignature.current && importedKlingSignature.current !== signature;
      importedKlingSignature.current = signature;
      if (assetsChanged) await reloadAssets();
    } catch (failure) { if (request === klingJobsRequest.current.serial) setKlingJobsError(failure instanceof Error ? failure.message : "读取 Kling 任务失败"); }
  }, [id, reloadAssets, klingEnabled, isKlingDefault, klingProfileId]);

  useEffect(() => {
    const requestGuard = klingJobsRequest.current;
    importedKlingSignature.current = "";
    setKlingJobsLoaded(false);
    void reloadKlingJobs();
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void reloadKlingJobs(); }, 5000);
    return () => { clearInterval(timer); requestGuard.serial++; };
  }, [reloadKlingJobs]);

  // Task-center navigation can update only the query while this page stays mounted.
  useEffect(() => {
    const wasTaskLinked = hadTaskQuery.current;
    hadTaskQuery.current = Boolean(requestedFilm || requestedJob);
    if (requestedFilm) {
      setKlingJobId(null);
      setFilmTaskId(undefined);
      setKlingFilmRunId(requestedFilm === "1" ? undefined : requestedFilm);
      setKlingFilmOpen(true);
    } else if (requestedJob) {
      setKlingFilmOpen(false);
      setFilmTaskId(undefined);
      setKlingFilmRunId(undefined);
      setKlingJobId(requestedJob);
    } else if (wasTaskLinked) {
      setKlingFilmOpen(false);
      setFilmTaskId(undefined);
      setKlingFilmRunId(undefined);
      setKlingJobId(null);
    }
  }, [id, requestedFilm, requestedJob]);

  const clearTaskQuery = (kind: "film" | "job") => {
    const url = new URL(window.location.href);
    const keys = kind === "film" ? ["klingFilm", "film"] : ["klingJob"];
    if (!keys.some((key) => url.searchParams.has(key))) return;
    for (const key of keys) url.searchParams.delete(key);
    router.replace(`${url.pathname}${url.search}${url.hash}`, { scroll: false });
  };

  // persist a per-shot camera edit into the selected script (scripts PATCH whitelists `camera`),
  // then mirror it into the view rows so the next generateMotion call picks it up immediately
  const saveCamera = useCallback(
    async (shotId: number, text: string) => {
      const trimmed = text.trim();
      setEditingCameraShot(null);
      const current = assets.find((a) => a.shotId === shotId);
      if (!scriptId || trimmed === (current?.camera ?? "")) return;
      setSavingCameraShot(shotId);
      try {
        const res = await fetch(`/api/project/${id}/scripts`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scriptId, ...(tidewe && { expectedScriptHash: scriptHash, expectedCreativeConfigRevision: creativeConfigRevision }), shotTexts: [{ shotId, camera: trimmed }] }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || t("cameraSaveFailed"));
        }
        if (tidewe) await reloadAssets();
        else setAssets((prev) => prev.map((a) => (a.shotId === shotId ? { ...a, camera: trimmed || undefined } : a)));
      } catch (e) {
        setAssets((prev) =>
          prev.map((a) => (a.shotId === shotId ? { ...a, error: e instanceof Error ? e.message : t("cameraSaveFailed") } : a))
        );
      } finally {
        setSavingCameraShot(null);
      }
    },
    [assets, scriptId, scriptHash, creativeConfigRevision, tidewe, reloadAssets, id, t]
  );

  // Apply a named camera preset; sentence language follows the script.
  const applyCameraPreset = useCallback(
    (shotId: number, presetId: string) => {
      const preset = getCameraPreset(presetId);
      const asset = assets.find((a) => a.shotId === shotId);
      if (!preset || !asset) return;
      void saveCamera(shotId, cameraPresetPrompt(preset, `${asset.camera ?? ""}${asset.description ?? ""}`));
    },
    [assets, saveCamera]
  );

  // Combine the currently applied preset with a second compatible move.
  // Only offered while the camera text exactly equals a preset sentence — after mixing it
  // no longer does, which naturally caps the stack at two moves.
  const applyCameraMix = useCallback(
    (shotId: number, basePresetId: string, overlayPresetId: string) => {
      const base = getCameraPreset(basePresetId);
      const overlay = getCameraPreset(overlayPresetId);
      const asset = assets.find((a) => a.shotId === shotId);
      if (!base || !overlay || !asset) return;
      const mixed = mixCameraPrompt(base, overlay, `${asset.camera ?? ""}${asset.description ?? ""}`);
      if (mixed) void saveCamera(shotId, mixed);
    },
    [assets, saveCamera]
  );

  // one-click "auto-fill visuals (free stock)": pull visuals from the free stock library (keyless Openverse images) shot-by-shot using search terms.
  // no image generation key required — this is the key step in the zero-barrier "one-sentence topic video" closed loop.
  // per-shot local image/video upload: a single hidden input, click sets the target shot; onChange uploads
  // then persists as that shot's asset. This unblocks user_upload shots (which had no action = dead end)
  // and lets users replace an AI/stock visual with their own footage.
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const pendingUploadShot = useRef<number | null>(null);
  const [uploadingShot, setUploadingShot] = useState<number | null>(null);
  const shotUploadAbort = useRef<AbortController | null>(null);
  const [shotUploadProgress, setShotUploadProgress] = useState<MaterialUploadProgress | null>(null);
  const [materialLibraryRevision, setMaterialLibraryRevision] = useState(0);
  useEffect(() => () => { shotUploadAbort.current?.abort(); }, [id]);
  const applyLocalMaterial = async (material: PublicLocalMaterial, shotId: number) => {
    const res = await fetch(`/api/project/${id}/assets`, {
      method: "POST", headers: { "Content-Type": "application/json", "Accept-Language": locale },
      body: JSON.stringify({ scriptId, ...(tidewe && { expectedScriptHash: scriptHash }), shotId, sourceUrl: material.url, type: "user_upload", provider: "local", prompt: [material.originalName, ...material.tags].join(" ") }),
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.error || t("uploadFailed")); }
    await reloadAssets();
  };
  const openUploadFor = (shotId: number) => {
    pendingUploadShot.current = shotId;
    uploadInputRef.current?.click();
  };
  const onUploadFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const shotId = pendingUploadShot.current;
    e.target.value = ""; // allow re-picking the same file later
    if (!file || shotId == null || shotUploadAbort.current) return;
    const controller = new AbortController(); shotUploadAbort.current = controller;
    setUploadingShot(shotId);
    try {
      if (classifyMaterial(file.name)) {
        const { material } = await uploadLocalMaterial(id, file, { locale, signal: controller.signal, onProgress: setShotUploadProgress });
        controller.signal.throwIfAborted();
        setMaterialLibraryRevision((value) => value + 1);
        await applyLocalMaterial(material, shotId);
      } else {
        // Preserve the existing GIF / SVG / BMP image-only path.
        const fd = new FormData(); fd.append("files", file); fd.append("projectId", id);
        const up = await fetch("/api/upload", { method: "POST", body: fd, signal: controller.signal });
        const data = await up.json().catch(() => ({}));
        if (!up.ok || !data.paths?.[0]) throw new Error(data.error || t("uploadFailed"));
        const res = await fetch(`/api/project/${id}/assets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scriptId, ...(tidewe && { expectedScriptHash: scriptHash }), shotId, sourceUrl: data.paths[0], type: "user_upload" }) });
        if (!res.ok) throw new Error(t("uploadFailed"));
        await reloadAssets();
      }
    } catch (err) {
      setStockMsg(controller.signal.aborted ? tm("cancelled") : err instanceof Error ? err.message : t("uploadFailed"));
    } finally {
      shotUploadAbort.current = null; setShotUploadProgress(null);
      setUploadingShot(null);
      pendingUploadShot.current = null;
    }
  };

  const fillStock = useCallback(async (localOnly = false) => {
    if (isFillingStock) return;
    setIsFillingStock(true);
    setStockMsg(null);
    try {
      const res = await fetch(`/api/project/${id}/stock-fill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // free sources are primarily Openverse images (video sources require a Pexels/Pixabay key, to be integrated in settings later)
        // llmConfig opt-in: semantic rerank picks the best-matching footage per shot (heuristic fallback inside the route)
        body: JSON.stringify({
          source: localOnly ? "local" : "all",
          mediaType: localOnly ? "auto" : "image",
          ...(!localOnly && llm.baseUrl && llm.model ? { llmConfig: { baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model } } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t("stockFillFailed"));
      await reloadAssets();
      setStockMsg(
        t("stockFilledMsg", { filled: data.filled ?? 0, total: data.total ?? 0 }) +
          (data.sameSourceHits ? t("stockSameSourceMsg", { n: data.sameSourceHits }) : "") +
          // fallback transparency: name the shots that got generic filler footage so the user knows
          // exactly which ones to swap, instead of discovering off-topic visuals in the final video
          (Array.isArray(data.universalFallbacks) && data.universalFallbacks.length
            ? t("stockUniversalFallbackMsg", { shots: data.universalFallbacks.join("、") })
            : "") +
          (Array.isArray(data.unmatchedShots) && data.unmatchedShots.length
            ? t("stockUnmatchedMsg", { shots: data.unmatchedShots.join("、") })
            : "")
      );
    } catch (e) {
      setStockMsg(e instanceof Error ? e.message : t("stockFillFailed"));
    } finally {
      setIsFillingStock(false);
    }
  }, [id, isFillingStock, reloadAssets, t, llm.baseUrl, llm.apiKey, llm.model]);

  // load cloud tasks whose results were never retrieved (issue #16) so the user can
  // recover a paid task instead of resubmitting (and paying again)
  const reloadPendingTasks = useCallback(async () => {
    try {
      const res = await fetch(`/api/ai/tasks?projectId=${id}&active=1`);
      if (!res.ok) return;
      const rows = await res.json();
      if (Array.isArray(rows)) setPendingTasks(rows.filter((row) => row.provider !== "kling-cli"));
    } catch {
      // recovery UI is best-effort; never block the page on it
    }
  }, [id]);

  useEffect(() => {
    reloadPendingTasks();
  }, [reloadPendingTasks]);

  // save a generated video as the shot's asset (shared by the normal flow and task recovery).
  // keyframeUrl = the static first frame the i2v ran from: persisted as thumbnailPath so the
  // keyframe survives the upsert — it powers the per-shot motion re-run and keyframe chaining
  const saveVideoAsset = useCallback(
    async (shotId: number, url: string, prompt: string | undefined, provider: string, model: string, keyframeUrl?: string, generationPlan?: GenerationControlSummary | null, sourceContext?: VideoSourceContext) => {
      const saveRes = await fetch(`/api/project/${id}/assets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scriptId: sourceContext?.sourceScriptId ?? scriptId,
          ...(tidewe && { expectedScriptHash: sourceContext?.sourceRevision ?? scriptHash }),
          shotId, type: "ai_generate", sourceUrl: url, prompt, provider, model,
          ...(keyframeUrl && { thumbnailPath: keyframeUrl }),
          ...(generationPlan && { generationPlan }),
        }),
      });
      if (!saveRes.ok) {
        const failure = await saveRes.json().catch(() => null);
        throw new VideoGenerationFailure(`视频已生成，但保存素材失败：${failure?.error || saveRes.status}。请先核对已有视频，避免重复生成。`, true);
      }
      let savedUrl = url;
      let savedLastFrame: string | undefined;
      if (saveRes.ok) {
        const saved = await saveRes.json();
        if (saved.filePath) savedUrl = saved.filePath;
        // the server extracted this clip's REAL last frame — remember it for tail-chaining
        if (typeof saved.lastFrameUrl === "string") {
          savedLastFrame = saved.lastFrameUrl;
        }
      }
      const sourceScriptId = sourceContext?.sourceScriptId ?? scriptId;
      const sourceHash = sourceContext?.sourceRevision ?? scriptHash;
      if (motionContext.current.scriptId !== sourceScriptId
        || (tidewe && motionContext.current.scriptHash !== sourceHash)) return;
      if (savedLastFrame) lastFrameByShot.current.set(shotId, savedLastFrame);
      setAssets((prev) =>
        prev.map((a) =>
          a.shotId === shotId
            ? {
                ...a,
                status: "done",
                thumbnailUrl: keyframeUrl ?? savedUrl,
                videoUrl: savedUrl,
                isVideo: true,
                keyframeUrl,
                sourceImageUrl: keyframeUrl,
                lastFrameUrl: savedLastFrame ?? a.lastFrameUrl,
                generationPlan: generationPlan ?? a.generationPlan,
                error: undefined,
              }
            : a
        )
      );
    },
    [id, scriptId, scriptHash, tidewe]
  );

  // resume a persisted cloud task: query (and wait for) its status, then save the result
  const resumeTask = useCallback(
    async (task: PendingAiTask) => {
      if (task.shotId == null && task.mode === "video-to-video") {
        setFilmTaskId(task.taskId); setKlingFilmRunId(undefined); setKlingFilmOpen(true);
        return;
      }
      const prov = providers[task.provider];
      if (!prov?.apiKey) {
        setTaskMsg(t("errorNoVideoModel"));
        return;
      }
      setResumingTasks((prev) => new Set(prev).add(task.id));
      setTaskMsg(null);
      try {
        const res = await fetch("/api/ai/video/task", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: task.provider,
            apiKey: prov.apiKey,
            baseUrl: prov.baseUrl,
            taskId: task.taskId,
            wait: true,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || t("taskResumeFailed"));
        if (data.status === "completed" && data.videoUrls?.[0]) {
          if (task.controlPlan && "kind" in task.controlPlan && task.controlPlan.kind === "repair") {
            const finalizeRes = await fetch(`/api/project/${id}/repair`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "finalize", plan: task.controlPlan, resultUrl: data.videoUrls[0] }),
            });
            const finalized = await finalizeRes.json();
            if (!finalizeRes.ok) throw new Error(finalized.error || t("taskResumeFailed"));
            await reloadAssets();
          } else if (task.shotId != null) {
            const sourceContext = sanitizeVideoControlSummary(task.controlPlan)?.sourceContext;
            if (tidewe && !sourceContext) throw new Error(`该历史任务没有原始文案版本，结果已保留但不能自动采用。请查看结果并确认后手动上传：${data.videoUrls[0]}`);
            const asset = assets.find((a) => a.shotId === task.shotId);
            // best-effort keyframe provenance: the task was submitted from the shot's static frame
            const keyframe = asset && !asset.isVideo ? asset.thumbnailUrl : asset?.keyframeUrl;
            await saveVideoAsset(task.shotId, data.videoUrls[0], task.prompt, task.provider, task.model, keyframe, task.controlPlan, sourceContext);
          }
          setTaskMsg(t("taskResumeDone"));
        } else if (data.status === "failed" || data.status === "cancelled") {
          setTaskMsg(`${t("taskResumeFailed")}${data.error ? `: ${data.error}` : ""}`);
        } else {
          setTaskMsg(t("taskResumeProcessing"));
        }
        if (task.shotId != null && ["completed", "failed", "cancelled"].includes(data.status)) {
          setUnresolvedMotionShots((previous) => { const next = new Set(previous); next.delete(task.shotId!); return next; });
        }
        await reloadPendingTasks();
      } catch (e) {
        setTaskMsg(e instanceof Error ? e.message : t("taskResumeFailed"));
      } finally {
        setResumingTasks((prev) => {
          const next = new Set(prev);
          next.delete(task.id);
          return next;
        });
      }
    },
    [providers, assets, saveVideoAsset, reloadAssets, reloadPendingTasks, id, tidewe, t]
  );

  // convert to motion shot: use the already-generated image for this shot as the first frame, call the image-to-video model, and save the result as the shot's asset (video).
  // Keyframe chaining: when the next shot's static keyframe exists and the model
  // supports a pinned last frame, the clip ends by flowing into the next scene — the transition is
  // generated inside the clip, and the composer's hard concat becomes seamless.
  const prepareMotion = useCallback(
    async (shotId: number, firstFrameOverride?: string, lastFrameOverride?: string | null, retake?: RetakeSymptom, batch = false, signal?: AbortSignal): Promise<PreparedMotion | undefined> => {
      const asset = assets.find((a) => a.shotId === shotId);
      if (!asset) return;
      const existing = klingJobs.find((job) => job.shotId === shotId && job.scriptId === scriptId && klingJobBlocksSubmission(job));
      if (existing) { setKlingJobId(existing.jobId); return; }
      if (unresolvedMotionShots.has(shotId) || pendingTasks.some((task) => task.shotId === shotId && task.status !== "failed")) {
        setTaskMsg("此镜头已有待恢复视频任务，请先通过下方任务恢复入口核对结果，避免重复提交。");
        return;
      }
      if ((klingEnabled || isKlingDefault) && (!klingJobsLoaded || klingJobsError)) { setTaskMsg("请先恢复 Kling 任务列表，再提交新视频。"); return; }
      if (!batch && isKlingDefault && klingCapacityBlocked) { setTaskMsg(klingCapacityMessage); return; }
      // prefer the freshly passed URL for the first frame: during auto-chaining React state hasn't updated yet, so the thumbnailUrl in the closure is stale
      const firstFrame = firstFrameOverride || (asset.isVideo ? asset.keyframeUrl : asset.thumbnailUrl);
      if (!firstFrame) return;
      if (!videoModelTarget) {
        setAssets((prev) =>
          prev.map((a) => (a.shotId === shotId ? { ...a, error: t("errorNoVideoModel") } : a))
        );
        return;
      }
      // chain target: explicit override wins (null = explicitly no chain); otherwise the next shot's static keyframe
      const assetIndex = assets.findIndex((item) => item.shotId === shotId);
      const previousAsset = assetIndex > 0 ? assets[assetIndex - 1] : undefined;
      const nextAsset = assets[assetIndex + 1];
      const chainFrame =
        chainMode !== "pin" || lastFrameOverride === null || (videoModelTarget.provider !== "kling-cli" && !modelSupportsLastFrame(videoModelTarget.model))
          ? undefined
          : lastFrameOverride ??
            // demo-type shots skip auto-chaining (their ending IS the content); explicit override still chains
            (chainByDefault(asset?.type) && (!tidewe || sameTideweScene(asset, nextAsset)) ? nextChainKeyframe(assets, shotId) : undefined);
      // TIDEWE requires a saved keyframe from this shot. An extracted previous tail
      // is neither its presenter identity frame nor an allowed TIDEWE reference.
      // Other styles can use the previous real tail for pixel-continuous seams.
      let tailFirstFrame: string | undefined;
      if (!tidewe && chainMode === "tail" && !firstFrameOverride && previousAsset) {
        tailFirstFrame = previousAsset.lastFrameUrl ?? lastFrameByShot.current.get(previousAsset.shotId);
      }
      const effectiveFirstFrame = tailFirstFrame ?? firstFrame;
      const previousTail = !tidewe
        ? previousAsset?.lastFrameUrl ?? (previousAsset ? lastFrameByShot.current.get(previousAsset.shotId) : undefined)
        : undefined;
      const characterReference = tidewe
        ? (asset?.tidewe?.personVisible !== false || (tideweNative && asset?.voiceover?.trim()) ? presenterSheet : undefined)
        : !premiumCg && asset?.characterId
        ? presenterLib.find((character) => character.id === asset.characterId)?.referenceImages?.[0] ?? presenterSheet
        : undefined;
      const productReference = productReferenceLocked && (tidewe ? asset?.tidewe?.productVisible !== false : premiumCg || asset?.visualSource === "product_image" || PRODUCT_SHOT_TYPES.has(asset?.type ?? ""))
        ? productImages[0]
        : undefined;
      const expectedAssetKey = motionAssetKey(asset);
      const validate = () => {
        const current = motionContext.current;
        const selected = current.assets.find((item) => item.shotId === shotId);
        return current.scriptId === scriptId && current.configurationKey === videoConfigurationKey
          && Boolean(selected && motionAssetKey(selected) === expectedAssetKey);
      };
      const promptRequest: VideoPromptRequest = {
        scriptId, shotId, provider: videoModelTarget.provider, model: videoModelTarget.model,
        settings: { visualLook, motionIntensity, motionRealism },
        ...(videoParams.negativePrompt && { negativePrompt: videoParams.negativePrompt }),
        chainToNext: !!chainFrame, locale, batch, retake,
        generateAudio: tideweNative || (!tidewe && !batch && !premiumCgVisualOnly && videoParams.audioEnabled !== false),
        controlInputs: {
          supportsAudio: tideweNative ? videoModelTarget.supportsAudio : tidewe || batch || premiumCgVisualOnly || videoParams.audioEnabled === false ? false : videoModelTarget.supportsAudio,
          firstFrameUrl: effectiveFirstFrame, lastFrameUrl: chainFrame,
          characterReferenceUrl: premiumCg ? undefined : characterReference,
          productReferenceUrl: productReference,
          continuityReferenceUrl: batch ? undefined : previousTail,
        },
      };
      const preview = await fetchVideoPrompt(id, promptRequest, signal);
      if (signal?.aborted) return;
      if (!validate()) throw new Error("脚本、素材或生成设置已更改，请重新打开视频生成确认。");
      const finalPrompt = preview.prompt;
      const controlPlan = preview.controlPlan;
      const consistencyFailure = tidewe ? undefined : checkPromptConsistency(finalPrompt, projectVisualBible).find((issue) => issue.severity === "fail");
      if (consistencyFailure) {
        setAssets((prev) => prev.map((item) => item.shotId === shotId ? { ...item, error: t("visualBibleBlocked", { anchor: consistencyFailure.anchor }) } : item));
        return;
      }
      // per-shot duration: the composer's slot follows the script duration (voice-fitted), and the
      // composer trims overshoot from the TAIL — which would cut a chained ending. Round to the
      // model's supported range instead of always sending the global 5s default.
      const videoOptions = buildVideoOptions(videoParams);
      if (preview.negativePrompt) {
        videoOptions.negativePrompt = preview.negativePrompt;
      }
      if (asset?.duration) {
        videoOptions.duration = Math.min(15, Math.max(4, tideweNative ? Math.ceil(asset.duration) : Math.round(asset.duration)));
      }
      if ((tidewe && controlPlan.audioMode !== "native") || (batch && !tideweNative) || premiumCgVisualOnly) {
        // Keep the browser-side confirmation honest. The route derives the same policy from the
        // persisted project profile and remains authoritative if a request is forged.
        videoOptions.audioEnabled = false;
        delete videoOptions.voiceover;
        delete videoOptions.audioPrompt;
        delete videoOptions.audioUrl;
        delete videoOptions.audioReferenceUrl;
        delete videoOptions.tts;
        delete videoOptions.ttsEnabled;
      } else if (controlPlan.audioMode === "native") {
        videoOptions.audioEnabled = true;
        delete videoOptions.audioUrl;
        delete videoOptions.audioReferenceUrl;
        delete videoOptions.tts;
        delete videoOptions.ttsEnabled;
        if (asset?.voiceover?.trim()) videoOptions.voiceover = asset.voiceover.trim();
        if (controlPlan.audioPrompt) videoOptions.audioPrompt = controlPlan.audioPrompt;
      }
      const referenceImageUrls = controlPlan.referenceInputs.filter((item) => item.mediaType === "image").map((item) => item.url);
      const referenceVideoUrls = controlPlan.referenceInputs.filter((item) => item.mediaType === "video").map((item) => item.url);
      const referenceAudioUrls = batch || premiumCgVisualOnly ? [] : controlPlan.referenceInputs.filter((item) => item.mediaType === "audio").map((item) => item.url);
      const controlSummary = sanitizeVideoControlSummary(controlPlan);
      const generate = async () => {
        const promptIssues = validateVideoPrompt(finalPrompt);
        if (promptIssues.length) throw new VideoGenerationFailure(promptIssues.map((issue) => issue.message).join(" "));
        // A settings change invalidates a previously prepared confirmation before any billed request.
        const currentSettings = useSettingsStore.getState();
        if (currentSettings.defaultVideoModel !== videoModelTarget.model || currentSettings.visualLook !== visualLook
          || currentSettings.motionIntensity !== motionIntensity || currentSettings.motionRealism !== motionRealism) {
          throw new VideoGenerationFailure("视频模型或提示词设置已更改，请重新打开当前镜头的生成确认。");
        }
        if (!validate()) throw new VideoGenerationFailure("脚本、分镜图片或视频生成设置已更改，请重新打开视频生成确认。");
        const res = await fetch("/api/ai/video", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: videoModelTarget.provider,
            model: videoModelTarget.model,
            apiKey: videoModelTarget.apiKey,
            baseUrl: videoModelTarget.baseUrl,
            mode: controlPlan.mode,
            prompt: finalPrompt,
            promptContext: preview.promptContext,
            ...(controlPlan.firstFrameUrl && { imageUrl: controlPlan.firstFrameUrl }),
            ...(controlPlan.lastFrameUrl && { lastImageUrl: controlPlan.lastFrameUrl }),
            ...(referenceImageUrls.length && { referenceImageUrls }),
            ...(referenceVideoUrls.length && { referenceVideoUrls }),
            ...(referenceAudioUrls.length && { referenceAudioUrls }),
            ...(controlSummary && { controlPlan: controlSummary }),
            // issue #16: identify the task server-side so the paid task ID is persisted
            // against this project/shot and stays recoverable after timeout or restart
            projectId: id,
            scriptId,
            shotId,
            // user-defined video parameters (aspect ratio / resolution / duration / frame rate / motion / seed / negative prompt)
            options: videoOptions,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          // the paid task may already exist in the cloud — surface its ID and the recovery
          // path instead of a bare failure that invites a duplicate (billed) resubmit
          if (data.taskId) {
            await reloadPendingTasks();
            throw new VideoGenerationFailure(
              t("errorWithTaskId", { msg: data.error || t("errorImageToVideoFailed"), taskId: data.taskId }), true, String(data.taskId)
            );
          }
          throw new VideoGenerationFailure(data.error || t("errorImageToVideoFailed"), res.status >= 500);
        }
        const url = data.videoUrls?.[0];
        if (!url) throw new Error(t("errorEmptyResult"));
        // save as this shot's asset (video will be downloaded locally); compose processes it as a video clip (including native audio track detection).
        // Persist the motion prompt actually sent AND the source keyframe (provenance + re-run/chaining)
        try {
          await saveVideoAsset(shotId, url, finalPrompt, videoModelTarget.provider, data.modelId || videoModelTarget.model, effectiveFirstFrame, controlSummary, sanitizeVideoSourceContext(data.sourceContext));
        } catch (failure) {
          throw new VideoGenerationFailure(failure instanceof Error ? failure.message : "视频保存失败，请勿重复生成。", true, data.taskId ? String(data.taskId) : undefined);
        }
      };
      return {
            asset, selectionKey: videoModelTarget.model, provider: videoModelTarget.provider, scriptId, configurationKey: videoConfigurationKey,
            profileId: videoModelTarget.profileId, prompt: finalPrompt,
            promptContext: preview.promptContext, negativePrompt: preview.negativePrompt,
            firstFrameUrl: effectiveFirstFrame, lastFrameUrl: controlPlan.lastFrameUrl,
            referenceImages: [...new Set(referenceImageUrls)],
            apiImages: [
              ...(controlPlan.firstFrameUrl ? [{ label: "首帧", url: controlPlan.firstFrameUrl }] : []),
              ...(controlPlan.lastFrameUrl ? [{ label: "尾帧", url: controlPlan.lastFrameUrl }] : []),
              ...referenceImageUrls.map((url, index) => ({ label: `参考图片 ${index + 1}`, url })),
            ],
            validateAssetSelection: !firstFrameOverride || firstFrameOverride === asset.thumbnailUrl || firstFrameOverride === asset.keyframeUrl,
            options: videoOptions,
            klingParameters: { ...videoParams, duration: videoOptions.duration, negativePrompt: videoOptions.negativePrompt, audioEnabled: videoOptions.audioEnabled },
            validate,
            generate: async () => {
              try { await generate(); }
              catch (error) {
                if (!(error instanceof VideoGenerationFailure) || error.uncertain || error.taskId) {
                  setUnresolvedMotionShots((previous) => new Set(previous).add(shotId));
                }
                setAssets((previous) => previous.map((item) => item.shotId === shotId ? { ...item, error: error instanceof Error ? error.message : t("errorImageToVideoFailed") } : item));
                throw error;
              }
            },
      };
    },
    [assets, videoModelTarget, videoConfigurationKey, isKlingDefault, klingEnabled, klingJobs, klingJobsLoaded, klingJobsError, klingCapacityBlocked, klingCapacityMessage, pendingTasks, unresolvedMotionShots, scriptId, id, videoParams, motionIntensity, motionRealism, chainMode, projectVisualBible, premiumCg, premiumCgVisualOnly, tidewe, tideweNative, visualLook, productReferenceLocked, productImages, presenterLib, presenterSheet, saveVideoAsset, reloadPendingTasks, t, locale]
  );

  const generateMotion = useCallback(async (shotId: number, firstFrameOverride?: string, lastFrameOverride?: string | null, retake?: RetakeSymptom) => {
    if (motionPreparation.current || batchPreparation.current || motionDraftDone.current || batchMotionBusy || preparingBatchMotion) return;
    const controller = new AbortController();
    motionPreparation.current = controller;
    setMotionShots((previous) => new Set(previous).add(shotId));
    try {
      const draft = await prepareMotion(shotId, firstFrameOverride, lastFrameOverride, retake, false, controller.signal);
      if (!draft || controller.signal.aborted) return;
      await new Promise<void>((resolve) => {
        motionDraftDone.current = resolve;
        setMotionDraft(draft);
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        setAssets((previous) => previous.map((item) => item.shotId === shotId
          ? { ...item, error: error instanceof Error ? error.message : "读取视频提示词失败，请重试。" } : item));
      }
    } finally {
      if (motionPreparation.current === controller) motionPreparation.current = null;
      setMotionShots((previous) => { const next = new Set(previous); next.delete(shotId); return next; });
    }
  }, [prepareMotion, batchMotionBusy, preparingBatchMotion]);

  const openBatchMotion = useCallback(async () => {
    if (batchMotionLock.current || motionPreparation.current || batchMotionBusy || motionDraftDone.current || isBatchGenerating || isGridGenerating || !scriptId || !videoModelTarget) return;
    const controller = new AbortController();
    batchPreparation.current = controller;
    batchMotionLock.current = true;
    setPreparingBatchMotion(true);
    try {
      const shots = await Promise.all(assets.map(async (asset) => {
        const existingTask = klingJobs.some((job) => job.scriptId === scriptId && job.shotId === asset.shotId && klingJobBlocksSubmission(job));
        const disabledReason = asset.isVideo ? t("batchMotionAlreadyVideo")
          : asset.status !== "done" || !asset.thumbnailUrl || /\.(?:mp4|webm|mov|m4v)(?:[?#]|$)/i.test(asset.thumbnailUrl) ? t("batchMotionNeedImage")
          : motionShots.has(asset.shotId) || unresolvedMotionShots.has(asset.shotId) || existingTask || pendingTasks.some((task) => task.shotId === asset.shotId && task.status !== "failed") ? t("batchMotionExistingTask")
          : premiumCg && !isKlingDefault ? t("batchMotionControlledModelRequired")
          : (klingEnabled || isKlingDefault) && (!klingJobsLoaded || klingJobsError) ? t("batchMotionTasksUnavailable")
          : undefined;
        if (disabledReason) return { asset, disabledReason };
        // Each selected shot starts from its OWN still. Batch submission does not
        // wait for another shot's generated tail or bridge to an unselected shot.
        try {
          const draft = await prepareMotion(asset.shotId, asset.thumbnailUrl, null, undefined, true, controller.signal);
          return draft ? { asset, draft } : { asset, disabledReason: t("batchMotionUnavailable") };
        } catch (error) {
          return { asset, disabledReason: error instanceof Error ? error.message : "读取视频提示词失败，请重试。" };
        }
      }));
      if (controller.signal.aborted) return;
      setBatchMotion({ scriptId, configurationKey: videoConfigurationKey, shots });
    } finally {
      if (batchPreparation.current === controller) batchPreparation.current = null;
      batchMotionLock.current = false;
      setPreparingBatchMotion(false);
    }
  }, [assets, scriptId, videoModelTarget, videoConfigurationKey, klingJobs, motionShots, unresolvedMotionShots, pendingTasks, klingEnabled, isKlingDefault, premiumCg, klingJobsLoaded, klingJobsError, prepareMotion, batchMotionBusy, isBatchGenerating, isGridGenerating, t]);

  // actually generate a single asset. Returns the saved static keyframe URL (undefined on failure) so
  // the batch flow can run a second keyframe-chained motion pass without re-reading stale React state.
  const generateOne = useCallback(
    async (shotId: number, opts?: { skipMotion?: boolean }): Promise<string | undefined> => {
      const asset = assets.find((a) => a.shotId === shotId);
      if (!asset) return undefined;

      // product image shot: use the product photo directly, no AI call needed (persisted for the composer to read)
      if (asset.visualSource === "product_image" && !(tideweNative && asset.voiceover?.trim())) {
        if (tidewe) {
          try {
            if (!productImages[0] || asset.tidewe?.productVisible === false) throw new Error("该镜头缺少匹配的产品画面，请按分镜生成或上传素材。");
            const saved = await fetch(`/api/project/${id}/assets`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ scriptId, expectedScriptHash: scriptHash, shotId, type: "product_image", sourceUrl: productImages[0] }),
            });
            if (!saved.ok) { const failure = await saved.json().catch(() => ({})); throw new Error(failure.error || "素材保存失败，请刷新后重试。"); }
          } catch (error) {
            setAssets(previous => previous.map(row => row.shotId === shotId ? { ...row, status: "failed", error: error instanceof Error ? error.message : "素材保存失败" } : row));
            return undefined;
          }
        }
        setAssets((prev) =>
          prev.map((a) =>
            a.shotId === shotId ? {
              ...a, status: "done", thumbnailUrl: productImages[0],
              isVideo: undefined, videoUrl: undefined, keyframeUrl: undefined, sourceImageUrl: undefined,
              lastFrameUrl: undefined, generationPlan: undefined,
            } : a
          )
        );
        if (productImages[0]) {
          if (!tidewe) fetch(`/api/project/${id}/assets`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ shotId, type: "product_image", sourceUrl: productImages[0] }),
          }).catch(() => {});
          // auto motion: use the product image as the first frame and run image-to-video (bring the real product to life); falls back to a static image on failure
          if (!opts?.skipMotion && autoMotion && videoModelTarget && !isKlingDefault) await generateMotion(shotId, productImages[0]);
        }
        return productImages[0];
      }

      // AI-generated shot: requires a default image model to be configured
      if (!modelTarget) {
        setAssets((prev) =>
          prev.map((a) =>
            a.shotId === shotId
              ? { ...a, status: "failed", error: t("errorNoImageModel") }
              : a
          )
        );
        return undefined;
      }

      setAssets((prev) => prev.map((a) => (a.shotId === shotId ? { ...a, status: "generating", error: undefined } : a)));

      // product fidelity: AI shot featuring product + product image available + toggle on → redraw with product image (image-to-image, locks in the product subject)
      const useProductSafe =
        productReferenceLocked && !!productImages[0] && (tidewe ? asset.tidewe?.productVisible !== false : premiumCg || PRODUCT_SHOT_TYPES.has(asset.type));
      const characterReference = tidewe && (asset.tidewe?.personVisible !== false || (tideweNative && asset.voiceover?.trim())) ? presenterSheet : undefined;
      const referenceImageUrls = tidewe ? [...new Set([...(characterReference ? [characterReference] : []), ...(useProductSafe ? productImages : [])])] : [];
      const hasImageReferences = useProductSafe || referenceImageUrls.length > 0;
      const genModel = hasImageReferences ? toEditVariant(modelTarget.model) : modelTarget.model;
      const genMode = hasImageReferences ? "image-to-image" : "text-to-image";
      const basePrompt = asset.prompt || asset.description;
      // cast shots: pin the anti-"AI face" realism constraint onto the keyframe too,
      // so the person is ordinary-looking from the very first frame the i2v runs on
      const castSuffix = !premiumCg && asset.characterId ? `。${realFaceLine(basePrompt)}` : "";
      // global look: one lighting/palette block across every keyframe keeps shots in one video
      // from drifting between styles (the LLM improvises style words per shot otherwise)
      const lookText = premiumCg ? "" : lookImageSuffix(visualLook, basePrompt);
      const lookSuffix = lookText ? `。${lookText}` : "";
      // frame-position directive: a keyframe is the frozen instant JUST BEFORE the action,
      // holding visible potential energy — gives the i2v pass a beat to play out instead of
      // animating an already-completed pose
      const frameSuffix = `。${keyframeInstantLine(basePrompt)}`;
      const productIdentitySuffix = premiumCg
        ? " Preserve the supplied product's visible silhouette, proportions, materials, colors, seams, hardware, and existing markings. Re-render only the described setting, background, and lighting."
        : "。严格保持商品的外观、包装、颜色、logo 和文字完全不变，只重绘符合描述的场景、背景与光线。";
      const shotPrompt = useProductSafe
        ? `${basePrompt}${productIdentitySuffix}${castSuffix}${lookSuffix}${frameSuffix}`
        : `${basePrompt}${castSuffix}${lookSuffix}${frameSuffix}`;
      const projectDirection = compileCreativePrompt({
        ...projectCreativeIntent,
        continuity: [...(projectCreativeIntent.continuity ?? []), ...projectVisualBible.characterAnchors, ...projectVisualBible.wardrobeAnchors, ...projectVisualBible.environmentAnchors, ...projectVisualBible.lightingAnchors],
        productConstraints: [...(projectCreativeIntent.productConstraints ?? []), ...projectVisualBible.productAnchors],
      });
      const genPrompt = tidewe ? compileTideweVisualPrompt(asset, "image", tideweNative ? "on_camera" : "voiceover", boundPresenter).prompt : projectDirection.prompt ? `${shotPrompt}. Project direction: ${projectDirection.prompt}` : shotPrompt;
      const consistencyFailure = tidewe ? undefined : checkPromptConsistency(genPrompt, projectVisualBible).find((issue) => issue.severity === "fail");
      if (consistencyFailure) {
        setAssets((prev) => prev.map((item) => item.shotId === shotId ? { ...item, status: "failed", error: t("visualBibleBlocked", { anchor: consistencyFailure.anchor }) } : item));
        return undefined;
      }

      try {
        const res = await fetch("/api/ai/image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: modelTarget.provider,
            model: genModel,
            apiKey: modelTarget.apiKey,
            baseUrl: modelTarget.baseUrl,
            mode: genMode,
            prompt: genPrompt,
            projectId: id,
            scriptId,
            shotId,
            ...(tidewe ? referenceImageUrls.length > 0 && { imageUrl: referenceImageUrls[0], referenceImageUrls } : useProductSafe && { imageUrl: productImages[0] }),
            // user-defined image parameters (aspect ratio → dimensions / count / steps / guidance / seed / negative prompt)
            options: (() => {
              const options = buildImageOptions(imageParams);
              if (!tidewe && projectDirection.negativePrompt) options.negativePrompt = [options.negativePrompt, projectDirection.negativePrompt].filter(Boolean).join(", ");
              return options;
            })(),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || t("errorGenerateFailed"));
        const url = data.imageUrls?.[0];
        if (!url) throw new Error(t("errorEmptyResult"));
        // persist to database (remote images will be downloaded locally) so the composer can read the real AI asset
        let savedUrl = url;
        try {
          const saveRes = await fetch(`/api/project/${id}/assets`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              scriptId, ...(tidewe && { expectedScriptHash: scriptHash }), shotId, type: "ai_generate", sourceUrl: url,
              prompt: genPrompt, provider: modelTarget.provider, model: genModel,
            }),
          });
          if (saveRes.ok) {
            const saved = await saveRes.json();
            if (saved.filePath) savedUrl = saved.filePath;
          } else if (tidewe) {
            const failure = await saveRes.json().catch(() => ({}));
            throw new Error(failure.error || "生成结果尚未保存，请先刷新核对，避免重复生成。");
          }
        } catch (error) {
          if (tidewe) throw error;
          // persist failure doesn't affect the preview (the composer will fall back to the product image as a safety net)
        }
        setAssets((prev) =>
          prev.map((a) => (a.shotId === shotId ? {
            ...a, status: "done", thumbnailUrl: savedUrl,
            isVideo: undefined, videoUrl: undefined, keyframeUrl: undefined, sourceImageUrl: undefined,
            lastFrameUrl: undefined, generationPlan: undefined,
          } : a))
        );
        // auto motion: use the freshly generated image as the first frame and run image-to-video (real camera moves replace fake Ken-Burns); falls back to static image on failure
        if (!opts?.skipMotion && autoMotion && videoModelTarget && !isKlingDefault) await generateMotion(shotId, savedUrl);
        return savedUrl;
      } catch (e) {
        setAssets((prev) =>
          prev.map((a) =>
            a.shotId === shotId ? { ...a, status: "failed", error: e instanceof Error ? e.message : t("errorGenerateFailed") } : a
          )
        );
        return undefined;
      }
    },
    [assets, id, scriptId, scriptHash, modelTarget, productImages, productReferenceLocked, imageParams, autoMotion, videoModelTarget, isKlingDefault, projectCreativeIntent, projectVisualBible, premiumCg, tidewe, tideweNative, boundPresenter, presenterSheet, visualLook, generateMotion, t]
  );

  // storyboard grid: ONE image generation renders every shot as a 3x3 grid cell (person /
  // outfit / room / light physically identical), the server crops cells into per-shot
  // keyframes — then the normal per-shot "animate" i2v pass takes over
  const runStoryboardGrid = useCallback(async () => {
    if (!modelTarget || !scriptId || isGridGenerating) return;
    setIsGridGenerating(true);
    setGridNotice(null);
    try {
      // identity/product anchoring: with a presenter sheet or product photo attached the
      // grid runs in edit mode (multi-reference) — field-proven to lock person AND product
      const productRefs = productReferenceLocked ? productImages : [];
      const hasRefs = (!premiumCg && !!presenterSheet) || productRefs.length > 0;
      const res = await fetch(`/api/project/${id}/storyboard-grid`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scriptId,
          provider: modelTarget.provider,
          model: hasRefs ? toEditVariant(modelTarget.model) : modelTarget.model,
          apiKey: modelTarget.apiKey,
          baseUrl: modelTarget.baseUrl,
          gridResolution,
          ...(!premiumCg && presenterSheet && { characterSheetUrl: presenterSheet }),
          productImageUrls: productRefs,
          // the grid itself is 9:16 so each of the 3x3 cells is exactly 9:16 too
          options: buildImageOptions(imageParams ? { ...imageParams, aspectRatio: "9:16", count: 1 } : undefined),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("gridFailed"));
      await reloadAssets();
      let notice = t("gridDone").replace("{n}", String(data.count ?? ""));
      if (data.resolution) {
        notice += ` ${t("gridResolutionActual", {
          width: data.resolution.gridWidth,
          height: data.resolution.gridHeight,
          cellWidth: data.resolution.minCellWidth,
          cellHeight: data.resolution.minCellHeight,
        })}`;
        if (data.resolution.limited) notice += ` ${t("gridResolutionLimited")}`;
      }
      setGridNotice(notice);
    } catch (e) {
      setGridNotice(e instanceof Error ? e.message : t("gridFailed"));
    } finally {
      setIsGridGenerating(false);
    }
  }, [id, scriptId, modelTarget, imageParams, gridResolution, isGridGenerating, presenterSheet, premiumCg, productReferenceLocked, productImages, reloadAssets, t]);

  // generate all in one click (sequential, to avoid hitting platform rate limits with concurrent requests).
  // With auto-motion on, this runs TWO passes: (1) every static keyframe, (2) keyframe-chained i2v per shot —
  // chaining needs the NEXT shot's keyframe to exist, which a single interleaved pass can't provide.
  const generateAll = useCallback(async () => {
    const pending = assets.filter((a) => a.status === "pending" || a.status === "failed");
    if (pending.length === 0) return;
    setIsBatchGenerating(true);
    const chained = autoMotion && !!videoModelTarget && !isKlingDefault;
    // freshly saved keyframes by shot — React state in this closure is stale during the loop
    const savedByShot = new Map<number, string>();
    for (const asset of pending) {
      const url = await generateOne(asset.shotId, { skipMotion: chained });
      if (url) savedByShot.set(asset.shotId, url);
    }
    if (chained) {
      // pass 2: i2v in script order; each shot chains into the next shot's keyframe when available.
      // Existing static keyframes (generated in earlier sessions) participate too.
      const staticFrameOf = (a: AssetItem): string | undefined =>
        savedByShot.get(a.shotId) ?? (a.status === "done" && !a.isVideo ? a.thumbnailUrl : undefined);
      for (let i = 0; i < assets.length; i++) {
        const row = assets[i];
        if (row.isVideo) continue; // already a motion/stock video — don't re-bill
        // tail mode: sequential continuation — the previous shot's real tail frame (captured at
        // save time in this very loop) beats the shot's own keyframe as the first frame
        const previous = assets[i - 1];
        const tailFrame = !tidewe && chainMode === "tail" && previous
          ? previous.lastFrameUrl ?? lastFrameByShot.current.get(previous.shotId) : undefined;
        const firstFrame = tailFrame ?? staticFrameOf(row);
        if (!firstFrame) continue;
        const next = assets[i + 1];
        // pin mode pins the next keyframe as the last frame; tail/off modes never pin
        const lastFrame = chainMode === "pin" && next && chainByDefault(row.type)
          && (!tidewe || sameTideweScene(row, next)) ? staticFrameOf(next) : undefined;
        // null = explicitly no chain (last shot / next frame unavailable)
        await generateMotion(row.shotId, firstFrame, lastFrame ?? null);
      }
    }
    setIsBatchGenerating(false);
  }, [assets, generateOne, generateMotion, autoMotion, videoModelTarget, isKlingDefault, chainMode, tidewe]);

  return (
    <div className="min-h-screen grid-bg">
      {/* project context strip: name + step navigation (global chrome lives in AppShell) */}
      <ProjectHeader projectName={projectName || t("untitledProject")} />
      {keyframeRefinement && <KeyframeRefinementDialog
        key={`${id}:${keyframeRefinement.scriptId}`}
        open={keyframeRefinement.scriptId === scriptId}
        onOpenChange={(open) => { if (!open) setKeyframeRefinement(null); }}
        projectId={id} scriptId={keyframeRefinement.scriptId}
        shots={keyframeRefinement.shots} initialShotId={keyframeRefinement.initialShotId}
        modelTarget={modelTarget} onApplied={reloadAssets} onBusyChange={setKeyframeRefinementBusy}
      />}
      <KlingShotGenerator
        open={motionDraftValid && motionDraft?.provider === "kling-cli"}
        onOpenChange={(open) => { if (!open) finishMotionDraft(); }}
        projectId={id} scriptId={scriptId} profileId={providers["kling-cli"]?.profileId}
        defaultModel={defaultVideoModel}
        asset={motionDraft?.asset ?? null}
        preparedPrompt={motionDraft?.prompt ?? ""}
        promptContext={motionDraft?.promptContext}
        negativePrompt={motionDraft?.negativePrompt}
        firstFrameUrl={motionDraft?.firstFrameUrl}
        lastFrameUrl={motionDraft?.lastFrameUrl}
        defaultParameters={motionDraft?.klingParameters}
        referenceImages={motionDraft?.referenceImages ?? []}
        onRefreshTasks={reloadKlingJobs}
        onSubmitted={(jobId) => { finishMotionDraft(); setKlingJobId(jobId); void reloadKlingJobs(); }}
      />
      {motionDraftValid && motionDraft && motionDraft.provider !== "kling-cli" && <ApiShotGenerator
        shotId={motionDraft.asset.shotId} modelLabel={`${motionDraft.provider} · ${motionDraft.selectionKey}`}
        prompt={motionDraft.prompt} images={motionDraft.apiImages} options={motionDraft.options}
        onOpenChange={(open) => { if (!open) finishMotionDraft(); }}
        onGenerate={motionDraft.generate} onRefreshTasks={reloadPendingTasks}
      />}
      {batchMotion && <BatchMotionPanel
        open onOpenChange={(open) => { if (!open) setBatchMotion(null); }}
        projectId={id} scriptId={batchMotion.scriptId}
        modelLabel={catalog.models.find((model) => model.id === defaultVideoModel)?.name ?? defaultVideoModel}
        selectionKey={defaultVideoModel} provider={videoModelTarget?.provider ?? ""}
        profileId={videoModelTarget?.profileId} shots={batchMotion.shots} valid={batchMotionValid}
        onBusyChange={setBatchMotionBusy}
        onSubmitted={() => { void reloadKlingJobs(); void reloadPendingTasks(); }}
        onUncertain={(shotId) => setUnresolvedMotionShots((previous) => new Set(previous).add(shotId))}
        onRefreshTasks={async () => { await Promise.all([reloadKlingJobs(), reloadPendingTasks()]); }}
      />}
      <KlingJobDetail jobId={klingJobId} open={klingJobId !== null} onOpenChange={(open) => { if (!open) { setKlingJobId(null); clearTaskQuery("job"); } }} onChanged={() => { void reloadKlingJobs(); void reloadAssets(); }} />
      <StoryboardFilmPanel creativeProfile={projectCreativeProfile} open={klingFilmOpen && !!scriptId} onOpenChange={(open) => { setKlingFilmOpen(open); if (!open) { setFilmTaskId(undefined); setKlingFilmRunId(undefined); clearTaskQuery("film"); } }}
        projectId={id} scriptId={scriptId} presenterId={premiumCg ? undefined : presenterId}
        initialRunId={klingFilmRunId} initialTaskId={filmTaskId} onAssetsChanged={reloadAssets} />

      {/* single hidden input reused for every per-shot upload; target shot tracked in pendingUploadShot */}
      <input
        ref={uploadInputRef}
        type="file"
        accept={`${MATERIAL_ACCEPT},.gif,.svg,.bmp`}
        className="hidden"
        onChange={onUploadFileChange}
      />

      <main className="mx-auto max-w-4xl px-6 py-8">
        {!loading && !loadError && scriptId && (
          <section aria-label={t("currentScript")} className="mb-4 flex flex-col gap-3 rounded-xl border border-primary/25 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <LuFileText aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{t("currentScript")}</p>
                <p className="mt-1 break-words text-sm font-semibold">{scriptTitle || t("untitledScript")}</p>
              </div>
            </div>
            <Link href={`/project/${id}/script`} className={buttonVariants({ variant: "outline", size: "sm", className: "self-start sm:self-auto" })}>
              {t("viewScript")}
              <LuArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
            </Link>
          </section>
        )}
        {!loading && tidewe && (
          <section aria-label={tw("presenterLabel")} className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/10 p-3 text-sm">
            <div>
              <p className="font-medium">{tw("presenterLabel")}：{boundPresenter?.name ?? tw("presenterDefault")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{boundPresenter ? tw("presenterAssetsBound") : tw("presenterAssetsDefault")}</p>
            </div>
            <Link href={`/project/${id}/script`} className="text-xs text-primary underline">{tw("presenterEditSettings")}</Link>
          </section>
        )}
        <ModelCatalogStatus statuses={catalog.statuses} pending={catalog.pending} onRetry={catalog.retry} />
        {isKlingDefault && <div className="mb-4 space-y-1 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm"><p>当前视频平台为 Kling CLI。同一账号最多同时生成 {KLING_MAX_CONCURRENT_SHOTS} 个镜头，支持单镜头转动态或勾选分镜批量提交。</p>{klingConcurrency && <p role="status" className="text-xs">当前账号生成名额：{klingConcurrency.active} / {klingConcurrency.max}（含待提交镜头）</p>}{klingCapacityBlocked && <p role="alert" className="text-xs text-amber-600">{klingCapacityMessage}</p>}</div>}
        {(klingEnabled || klingJobs.length > 0) && klingJobsError && <p role="alert" className="mb-4 rounded-lg border border-amber-500/40 p-3 text-sm">Kling 任务暂时无法读取：{klingJobsError}。请先恢复任务列表，再提交新视频。<button className="ml-2 text-primary underline" onClick={() => void reloadKlingJobs()}>重新读取</button></p>}
        <KlingJobsList jobs={klingJobs.filter((job) => job.scriptId === scriptId)} onOpenJob={setKlingJobId} onRefresh={reloadKlingJobs} onDeleted={async (jobId) => {
          klingJobsRequest.current.serial++;
          assetsRequest.current++;
          setKlingJobs((current) => current.filter((job) => job.jobId !== jobId));
          setKlingJobId((current) => current === jobId ? null : current);
          setMaterialLibraryRevision((current) => current + 1);
          await Promise.all([reloadKlingJobs(), reloadAssets()]);
        }} />
        {/* Action bar: title + generation ACTIONS only. Creative settings live in the
            director panel below so this row stays a stable, scannable set of verbs. */}
        <div className="flex flex-wrap items-center justify-between gap-y-3 mb-4">
          <div>
            <h2 className="text-lg font-semibold">{t("title")}</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              {loading ? tc("loading") : t("assetsReady", { done: doneCount, total: assets.length })}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {SHOW_TEXT_EDITOR && (
              <Link href={`/project/${id}/transcript`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-primary/35 bg-primary/8 px-2.5 text-xs font-medium text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                <LuScissors className="h-3.5 w-3.5" />{t("textEditor")}
              </Link>
            )}
            {offerStockFill && (
              <Button
                onClick={() => void fillStock()}
                disabled={isFillingStock || batchMotionBusy}
                variant="outline"
                size="sm"
                className="text-xs border-primary/50 text-primary hover:bg-primary/10"
                title={t("stockFillHint")}
              >
                {isFillingStock ? (
                  <>
                    <LuLoaderCircle className="animate-spin w-3.5 h-3.5 mr-1" />
                    {t("stockFilling")}
                  </>
                ) : (
                  <>
                    <LuImage className="w-3.5 h-3.5 mr-1" />
                    {t("stockFill")}
                  </>
                )}
              </Button>
            )}
            {/* Generation actions stay VISIBLE when their prerequisites are unmet (disabled with the
                reason in the tooltip) — hiding them made the features undiscoverable. */}
            {(() => {
              const shotsOk = assets.length >= 2 && assets.length <= 9;
              const gridReady = Boolean(modelTarget) && shotsOk;
              const gridReason = !modelTarget ? t("gridNeedModel") : !shotsOk ? t("gridNeedShots") : t("gridTip");
              const batchReady = Boolean(scriptId && videoModelTarget && assets.some((asset) => asset.status === "done" && asset.thumbnailUrl && !asset.isVideo));
              const batchReason = !videoModelTarget ? t("batchMotionNeedModel") : t("batchMotionHint");
              return (
                <>
                  {uiMode === "pro" && (
                    <div className="inline-flex items-center gap-1.5">
                      <label htmlFor="storyboard-grid-resolution" className="sr-only">{t("gridResolutionLabel")}</label>
                      <select
                        id="storyboard-grid-resolution"
                        value={gridResolution}
                        onChange={(event) => setGridResolution(event.target.value as StoryboardGridResolution)}
                        disabled={isGridGenerating || isBatchGenerating || batchMotionBusy}
                        aria-describedby="storyboard-grid-resolution-hint"
                        className="h-8 max-w-36 rounded-lg border border-border bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
                      >
                        <option value="standard">{t("gridResolutionStandard")}</option>
                        <option value="2k">{t("gridResolution2k")}</option>
                        <option value="4k">{t("gridResolution4k")}</option>
                      </select>
                      <Button
                        onClick={runStoryboardGrid}
                        disabled={!gridReady || isGridGenerating || isBatchGenerating || batchMotionBusy}
                        variant="outline"
                        className="text-xs"
                        title={gridReason}
                      >
                        {isGridGenerating ? (
                          <>
                            <LuLoaderCircle className="animate-spin mr-1.5 h-3.5 w-3.5" />
                            {t("gridRunning")}
                          </>
                        ) : (
                          <>{t("gridButton")}</>
                        )}
                      </Button>
                    </div>
                  )}
                  <Button
                    onClick={() => openKeyframeRefinement()}
                    disabled={!scriptId || !refinableShots.length || isGridGenerating || isBatchGenerating || batchMotionBusy || keyframeRefinementBusy || motionShots.size > 0}
                    variant="outline"
                    className="text-xs"
                    title={t("keyframeRefineTip")}
                  >
                    <LuSparkles className="mr-1.5 h-3.5 w-3.5" />{t("keyframeRefineBatch")}
                  </Button>
                  <Button
                    onClick={openBatchMotion}
                    disabled={!batchReady || isGridGenerating || isBatchGenerating || preparingBatchMotion || batchMotionBusy || motionShots.size > 0}
                    variant="outline"
                    className="text-xs border-primary/50 text-primary hover:bg-primary/10 disabled:border-border/60 disabled:text-muted-foreground"
                    title={batchReason}
                  >
                    {preparingBatchMotion || batchMotionBusy ? <LuLoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <LuPlay className="mr-1.5 h-3.5 w-3.5" />}
                    {t("batchMotionButton")}
                  </Button>
                </>
              );
            })()}
            {(!allDone || isBatchGenerating) && (
              <Button
                onClick={generateAll}
                disabled={isBatchGenerating || isGridGenerating || batchMotionBusy || assets.length === 0}
                className="brand-gradient text-white text-xs"
              >
                {isBatchGenerating ? (
                  <>
                    <LuLoaderCircle className="animate-spin mr-1.5 h-3.5 w-3.5" />
                    {t("generatingAll")}
                  </>
                ) : (
                  <>
                    <LuZap className="w-3.5 h-3.5 mr-1" />
                    {isKlingDefault ? "批量生成图片关键帧" : t("generateAll")}
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
        {uiMode === "pro" && (
          <p id="storyboard-grid-resolution-hint" className="-mt-2 mb-4 text-xs leading-relaxed text-muted-foreground">
            {t("gridResolutionHint")}
            {" "}{t("keyframeRefineFlow")}
          </p>
        )}

        {/* Director panel: global creative settings applied to every generation pass.
            One labeled container instead of loose pills scattered through the action bar.
            Pro mode only — beginners get working defaults without the vocabulary. */}
        {uiMode === "pro" && (
        <div className="mb-6 flex flex-wrap items-center gap-2 rounded-xl border border-border/50 bg-muted/10 px-3 py-2.5">
          <span className="mr-1 text-xs font-semibold tracking-wide text-muted-foreground">{t("directorPanel")}</span>
          {/* Presenter picker: characters from the library; ones with a multi-view sheet
              anchor the person's identity through the grid and film passes */}
          {!premiumCg && !tidewe && presenterLib.length > 0 && (
            <div
              className="flex items-center gap-1 rounded-full border border-border/60 bg-muted/20 pl-2.5 pr-1.5 h-8"
              title={t("presenterTip")}
            >
              <span className="text-xs font-medium text-muted-foreground">{t("presenterLabel")}</span>
              <select
                value={presenterId}
                onChange={(e) => setPresenterId(e.target.value)}
                className="bg-transparent text-xs outline-none h-6 max-w-28 text-foreground"
              >
                <option value="">{t("presenterNone")}</option>
                {presenterLib.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.referenceImages?.[0] ? ` ${t("presenterSheetBadge")}` : ""}
                  </option>
                ))}
              </select>
            </div>
          )}
          {/* Visual-look picker with enumerated lighting/palette
              panel): applies to keyframe image prompts AND pins lighting through the i2v pass */}
          {!premiumCg && <div
            className="flex items-center gap-1 rounded-full border border-border/60 bg-muted/20 pl-2.5 pr-1.5 h-8"
            title={t("lookTip")}
          >
            <span className="text-xs font-medium text-muted-foreground">{t("lookLabel")}</span>
            <select
              value={visualLook}
              onChange={(e) => setVisualLook(e.target.value)}
              className="bg-transparent text-xs outline-none h-6 max-w-28 text-foreground"
            >
              <option value="none">{t("lookNone")}</option>
              {/* "real" family = raw phone-shot looks (UGC anti-AI-slop path); styled = art-directed */}
              <optgroup label={locale === "zh" ? "实拍感" : "Real-shot"}>
                {LOOK_PRESETS.filter((p) => p.group === "real").map((p) => (
                  <option key={p.id} value={p.id}>
                    {locale === "zh" ? p.name.zh : p.name.en}
                  </option>
                ))}
              </optgroup>
              <optgroup label={locale === "zh" ? "风格化" : "Styled"}>
                {LOOK_PRESETS.filter((p) => p.group !== "real").map((p) => (
                  <option key={p.id} value={p.id}>
                    {locale === "zh" ? p.name.zh : p.name.en}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>}
          {videoModelTarget && !isKlingDefault && (
            <div
              className="flex items-center gap-0.5 rounded-full border border-border/60 bg-muted/20 pl-2.5 pr-1 h-8"
              title={t("motionIntensityTip")}
            >
              <span className="text-xs font-medium text-muted-foreground mr-1">{t("motionIntensity")}</span>
              {(["subtle", "normal", "strong"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setMotionIntensity(v)}
                  className={`rounded-full px-2 h-6 text-xs font-medium transition-all ${
                    motionIntensity === v
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t(`motionIntensity_${v}`)}
                </button>
              ))}
            </div>
          )}
          {videoModelTarget && !isKlingDefault && (
            <div
              className="flex items-center gap-0.5 rounded-full border border-border/60 bg-muted/20 pl-2.5 pr-1 h-8"
              title={t("motionRealismTip")}
            >
              <span className="text-xs font-medium text-muted-foreground mr-1">{t("motionRealism")}</span>
              {(["auto", "constraints", "off"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setMotionRealism(v)}
                  className={`rounded-full px-2 h-6 text-xs font-medium transition-all ${
                    motionRealism === v
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t(`motionRealism_${v}`)}
                </button>
              ))}
            </div>
          )}
          {videoModelTarget && (isKlingDefault || modelSupportsLastFrame(videoModelTarget.model)) && (
            <div
              className="flex items-center gap-0.5 rounded-full border border-border/60 bg-muted/20 pl-2.5 pr-1 h-8"
              title={t("chainModeTip")}
            >
              <span className="text-xs font-medium text-muted-foreground mr-1">{t("chainMode")}</span>
              {(["pin", "tail", "off"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setChainMode(v)}
                  className={`rounded-full px-2 h-6 text-xs font-medium transition-all ${
                    chainMode === v
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t(`chainMode_${v}`)}
                </button>
              ))}
            </div>
          )}
          {videoModelTarget && !isKlingDefault && (
            <button
              type="button"
              onClick={() => setAutoMotion((v) => !v)}
              title={t("autoMotionTip")}
              className={`flex items-center gap-1.5 rounded-full border px-3 h-8 text-xs font-medium transition-all ${
                autoMotion
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border/60 bg-muted/20 text-muted-foreground"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${autoMotion ? "bg-primary" : "bg-muted-foreground/40"}`} />
              {t("autoMotion")}{autoMotion ? t("on") : t("off")}
            </button>
          )}
          {!premiumCg && productImages.length > 0 && (
            <button
              type="button"
              onClick={() => setProductSafe((v) => !v)}
              title={t("productSafeTip")}
              className={`flex items-center gap-1.5 rounded-full border px-3 h-8 text-xs font-medium transition-all ${
                productSafe
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border/60 bg-muted/20 text-muted-foreground"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${productSafe ? "bg-primary" : "bg-muted-foreground/40"}`} />
              {t("productSafe")}{productSafe ? t("on") : t("off")}
            </button>
          )}
        </div>
        )}

        {uiMode === "pro" && videoModelTarget && !isKlingDefault && (
          <ModelCapabilityPreflight
            modelId={videoModelTarget.model}
            provider={videoModelTarget.provider}
            supportsAudio={videoModelTarget.supportsAudio}
            duration={videoParams.duration}
            resolution={videoParams.resolution}
            aspectRatio={videoParams.aspectRatio}
            chainMode={chainMode}
            audioEnabled={!premiumCgVisualOnly && videoModelTarget.supportsAudio === true}
            referenceImageCount={Number(!premiumCg && Boolean(presenterSheet)) + Number(Boolean(productReferenceLocked && productImages[0]))}
          />
        )}

        {/* storyboard-grid outcome line (success count or error) */}
        {gridNotice && (
          <div role="status" className="mb-4 rounded-lg border border-border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground">
            {gridNotice}
          </div>
        )}

        {/* auto-fill visuals hint/result (free stock, no key required, preferred path for topic
            videos). Also renders when stockMsg is set alone — per-shot upload errors land there
            and must stay visible even when the stock-fill offer itself is hidden. */}
        {(offerStockFill || stockMsg) && (
          <div className="mb-4 flex items-center gap-2 rounded-lg bg-primary/5 border border-primary/15 px-3 py-2 text-xs text-muted-foreground">
            <LuImage className="w-3.5 h-3.5 text-primary/70 shrink-0" />
            <span>{stockMsg ?? t("stockFillTip")}</span>
          </div>
        )}

        {uploadingShot !== null && <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border p-3 text-sm" role="status">
          <span>{tm("shot", { id: uploadingShot })} · {shotUploadProgress?.verifying ? tm("verifying") : tm("uploading", { percent: shotUploadProgress?.percent ?? 0 })}</span>
          <Button variant="outline" className="min-h-11" onClick={() => shotUploadAbort.current?.abort()}>{tm("cancel")}</Button>
        </div>}
        <LocalMaterialLibrary key={id} projectId={id} refreshKey={materialLibraryRevision}
          shots={assets.map((asset) => ({ shotId: asset.shotId, description: asset.description || "" }))}
          canFill={assets.some((asset) => asset.visualSource !== "product_image" && asset.status !== "done")}
          busy={isBatchGenerating || isGridGenerating || isFillingStock || uploadingShot !== null || motionShots.size > 0 || assets.some((asset) => asset.status === "generating")}
          onUse={applyLocalMaterial} onFill={() => fillStock(true)} />

        {/* cloud paid-task recovery (issue #16): submitted tasks whose results were never
            retrieved — offer resume instead of a duplicate (billed) resubmit */}
        {pendingTasks.length === 0 && taskMsg && <p role="status" className="mb-4 rounded-md border border-amber-500/40 p-3 text-sm text-amber-600">{taskMsg}</p>}
        {pendingTasks.length > 0 && (
          <div className="mb-6 p-4 rounded-xl bg-blue-500/10 border border-blue-500/30">
            <div className="flex items-start gap-3">
              <LuLoaderCircle className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-medium text-blue-200">
                  {t("pendingTasksTitle", { n: pendingTasks.length })}
                </p>
                <p className="text-xs text-blue-300/80 mt-0.5">{t("pendingTasksDesc")}</p>
                <div className="mt-2 space-y-1.5">
                  {pendingTasks.map((task) => (
                    <div key={task.id} className="flex items-center gap-2 text-xs text-blue-200/90">
                      <span className="truncate">
                        {t("taskLabel", { shot: task.shotId ?? "-", model: task.model, taskId: task.taskId })}
                      </span>
                      <Button
                        onClick={() => resumeTask(task)}
                        disabled={resumingTasks.has(task.id)}
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-[11px] border-blue-500/40 text-blue-300 hover:bg-blue-500/15 shrink-0"
                      >
                        {resumingTasks.has(task.id) ? (
                          <>
                            <LuLoaderCircle className="animate-spin w-3 h-3 mr-1" />
                            {t("btnResumingTask")}
                          </>
                        ) : (
                          t("btnResumeTask")
                        )}
                      </Button>
                    </div>
                  ))}
                </div>
                {taskMsg && <p className="text-xs text-blue-300/80 mt-2">{taskMsg}</p>}
              </div>
            </div>
          </div>
        )}

        {/* no image model configured warning (only shown when there are still AI shots pending generation) */}
        {showModelWarning && (
          <div className="mb-6 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-3">
            <LuTriangleAlert className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-amber-200">{t("noModelTitle")}</p>
              <p className="text-xs text-amber-300/80 mt-0.5">
                {t("noModelDesc")}
                <Link href="/settings?tab=image" className="underline ml-1">{t("goToSettings")}</Link>
              </p>
            </div>
          </div>
        )}

        {/* loading state / empty state */}
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <LuLoaderCircle className="w-6 h-6 animate-spin mb-3" />
            <p className="text-sm">{t("loadingShots")}</p>
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <LuImage className="w-10 h-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground mb-4">{loadError}</p>
            <Link href={`/project/${id}/script`}>
              <Button variant="outline" size="sm">{t("backToScriptStep")}</Button>
            </Link>
          </div>
        ) : (
          <>
            {/* progress bar */}
            <div className="mb-6">
              <div className="h-2 bg-muted/30 rounded-full overflow-hidden">
                <div
                  className="h-full brand-gradient transition-all duration-700 rounded-full"
                  style={{ width: `${assets.length ? (doneCount / assets.length) * 100 : 0}%` }}
                />
              </div>
              {/* real/AI mix meter — Douyin tilts traffic toward hybrid content at ≥50% real (duration-weighted) */}
              {mix.realRatio != null && (
                <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground" title={t("mixTiltTip")}>
                  <span className="shrink-0">{t("mixLabel")}</span>
                  <div className="h-1.5 w-32 rounded-full overflow-hidden bg-muted/30 flex shrink-0">
                    <div className="h-full bg-emerald-500/80" style={{ width: `${Math.round(mix.realRatio * 100)}%` }} />
                    <div className="h-full bg-violet-500/60" style={{ width: `${100 - Math.round(mix.realRatio * 100)}%` }} />
                  </div>
                  <span className="shrink-0 tabular-nums">
                    {t("mixReal")} {Math.round(mix.realRatio * 100)}% · {t("mixAi")} {100 - Math.round(mix.realRatio * 100)}%
                  </span>
                  {mix.tiltEligible && <span className="text-emerald-500 truncate">✓ {t("mixTiltOk")}</span>}
                </div>
              )}
            </div>

            {/* asset list */}
            <div className="space-y-4">
              {assets.map((asset) => {
                const typeInfo = shotTypeLabels[asset.type];
                const existingKlingJob = klingJobs.find((job) => job.shotId === asset.shotId && job.scriptId === scriptId && klingJobBlocksSubmission(job));
                // per-shot real/AI chip (same classification as the mix meter above)
                const reality = shotReality({
                  visualSource: asset.visualSource,
                  assetType: asset.assetType,
                  done: asset.status === "done",
                });
                return (
                  <Card key={asset.shotId} className="glass-card overflow-hidden">
                    <CardContent className="p-0">
                      <div className="flex">
                        {/* left-side index */}
                        <div className="flex flex-col items-center justify-center w-16 py-4 border-r border-border/50 shrink-0">
                          <span className="text-lg font-bold text-muted-foreground/50">
                            {String(asset.shotId).padStart(2, "0")}
                          </span>
                          <Badge className={`${typeInfo.color} border-0 text-[10px] mt-1`}>
                            {t(typeInfo.key)}
                          </Badge>
                          <span className="text-[10px] text-muted-foreground mt-1">{asset.duration}s</span>
                          {reality && (
                            <span
                              className={`text-[9px] mt-1 px-1 rounded ${
                                reality === "real"
                                  ? "bg-emerald-500/15 text-emerald-600"
                                  : "bg-violet-500/15 text-violet-600"
                              }`}
                            >
                              {reality === "real" ? t("badgeReal") : t("badgeAi")}
                            </span>
                          )}
                        </div>

                        {/* center content */}
                        <div className="min-w-0 flex-1 p-4">
                          <p className="text-sm leading-relaxed mb-2">{asset.description}</p>
                          {/* per-shot camera move: named-preset picker + inline free-text edit
                              (curated moves instead of prompt guessing).
                              Edits persist into the script and apply on the next motion generation */}
                          {uiMode === "pro" && (
                          <div className="flex items-center gap-1.5 mb-2 text-xs min-w-0">
                            <span className="shrink-0 text-muted-foreground/70">🎥</span>
                            {editingCameraShot === asset.shotId ? (
                              <input
                                autoFocus
                                value={cameraDraft}
                                onChange={(e) => setCameraDraft(e.target.value)}
                                onBlur={() => saveCamera(asset.shotId, cameraDraft)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") saveCamera(asset.shotId, cameraDraft);
                                  if (e.key === "Escape") setEditingCameraShot(null);
                                }}
                                maxLength={200}
                                className="flex-1 min-w-0 bg-muted/20 border border-border/60 rounded px-2 py-0.5 text-xs outline-none focus:border-primary"
                              />
                            ) : (
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingCameraShot(asset.shotId);
                                  setCameraDraft(asset.camera ?? "");
                                }}
                                title={t("cameraEditTip")}
                                className="min-w-0 truncate text-left text-muted-foreground hover:text-foreground underline decoration-dotted underline-offset-2"
                              >
                                {asset.camera || t("cameraUnset")}
                              </button>
                            )}
                            {savingCameraShot === asset.shotId ? (
                              <LuLoaderCircle className="w-3 h-3 animate-spin shrink-0 text-muted-foreground" />
                            ) : (
                              <select
                                value=""
                                onChange={(e) => e.target.value && applyCameraPreset(asset.shotId, e.target.value)}
                                title={t("cameraPresetTip")}
                                className="shrink-0 bg-muted/20 border border-border/60 rounded px-1 h-5 text-[11px] text-muted-foreground outline-none max-w-24"
                              >
                                <option value="">{t("cameraPresetPick")}</option>
                                <optgroup label={t("cameraRecommendGroup")}>
                                  {recommendedPresets(asset.type).map((p) => (
                                    <option key={`rec-${p.id}`} value={p.id}>
                                      {locale === "zh" ? p.name.zh : p.name.en}
                                    </option>
                                  ))}
                                </optgroup>
                                {(Object.keys(CAMERA_PRESET_CATEGORIES) as CameraPresetCategory[]).map((cat) => (
                                  <optgroup key={cat} label={locale === "zh" ? CAMERA_PRESET_CATEGORIES[cat].zh : CAMERA_PRESET_CATEGORIES[cat].en}>
                                    {CAMERA_PRESETS.filter((p) => p.category === cat).map((p) => (
                                      <option key={p.id} value={p.id}>
                                        {locale === "zh" ? p.name.zh : p.name.en}
                                      </option>
                                    ))}
                                  </optgroup>
                                ))}
                              </select>
                            )}
                            {/* Mix overlay: only while the text is a preset sentence. */}
                            {savingCameraShot !== asset.shotId && editingCameraShot !== asset.shotId && (() => {
                              const base = findPresetByPrompt(asset.camera);
                              if (!base) return null;
                              const sample = `${asset.camera ?? ""}${asset.description ?? ""}`;
                              const candidates = mixablePresets(base, sample);
                              if (candidates.length === 0) return null;
                              return (
                                <select
                                  value=""
                                  onChange={(e) => e.target.value && applyCameraMix(asset.shotId, base.id, e.target.value)}
                                  title={t("cameraMixTip")}
                                  className="shrink-0 bg-muted/20 border border-border/60 rounded px-1 h-5 text-[11px] text-muted-foreground outline-none max-w-20"
                                >
                                  <option value="">{t("cameraMixPick")}</option>
                                  {candidates.map((p) => (
                                    <option key={p.id} value={p.id}>
                                      {locale === "zh" ? p.name.zh : p.name.en}
                                    </option>
                                  ))}
                                </select>
                              );
                            })()}
                          </div>
                          )}
                          {asset.prompt && (
                            <div
                              role="region"
                              aria-label="Prompt"
                              tabIndex={0}
                              className="text-xs text-muted-foreground bg-muted/20 rounded px-2 py-1.5 mb-2 max-h-40 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                            >
                              {t("promptLabel", { prompt: asset.prompt })}
                            </div>
                          )}
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span>
                              {asset.assetProvider === "local"
                                ? tm("title")
                                : asset.assetType === "stock_footage"
                                ? t("sourceStock")
                                : asset.assetType === "user_upload"
                                ? t("sourceUserUpload")
                                : asset.visualSource === "product_image"
                                ? t("sourceProductImage")
                                : asset.visualSource === "ai_generate"
                                ? t("sourceAiGenerate")
                                : t("sourceUserUpload")}
                            </span>
                          </div>
                          <ShotMaterialPreview asset={asset} />
                          {/* single error slot for the whole card: generation failures AND
                              non-fatal errors (camera save / i2v) that keep status "done" */}
                          {asset.error && (
                            <p className="text-xs text-destructive mt-2">⚠ {asset.error}</p>
                          )}
                        </div>

                        {/* right-side preview + actions */}
                        <div className="flex flex-col items-center justify-center gap-2 p-4 shrink-0">
                          {existingKlingJob && <Button variant="outline" size="sm" className="text-xs w-24" onClick={() => setKlingJobId(existingKlingJob.jobId)} title="先查询或恢复原任务，避免重复生成">查看视频任务</Button>}
                          {existingKlingJob && <span className="max-w-24 text-center text-[10px] text-amber-600">{klingJobStatus(existingKlingJob)}</span>}
                          {/* thumbnail area */}
                          <div className="w-24 h-16 bg-muted/30 rounded-md flex items-center justify-center border border-border/30 overflow-hidden">
                            {asset.status === "done" && asset.thumbnailUrl ? (
                              // i2v shots may carry an mp4 as their preview — render it muted instead of a broken <img>
                              asset.isVideo && /\.(?:mp4|webm|mov|m4v)(?:[?#]|$)/i.test(asset.thumbnailUrl) ? (
                                <video src={asset.thumbnailUrl} muted playsInline className="w-full h-full object-cover" />
                              ) : (
                                <AssetImagePreview
                                  src={asset.thumbnailUrl}
                                  alt={t("assetPreviewAlt")}
                                  shotId={asset.shotId}
                                  onRefine={asset.assetId && !asset.isVideo && !batchMotionBusy && !isBatchGenerating && !isGridGenerating && !motionShots.has(asset.shotId) ? () => openKeyframeRefinement(asset.shotId) : undefined}
                                  className="block h-full w-full"
                                >
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src={asset.thumbnailUrl} alt={t("assetPreviewAlt")} className="w-full h-full object-cover" />
                                </AssetImagePreview>
                              )
                            ) : asset.status === "done" ? (
                              <div className="w-full h-full bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
                                <LuCheck className="w-5 h-5 text-primary" />
                              </div>
                            ) : asset.status === "generating" ? (
                              <LuLoaderCircle className="animate-spin h-5 w-5 text-primary" />
                            ) : asset.status === "failed" ? (
                              <LuCircleX className="w-5 h-5 text-destructive" />
                            ) : (
                              <LuImage className="w-4 h-4 text-muted-foreground/40" />
                            )}
                          </div>

                          {asset.status === "done" && asset.isVideo && asset.videoUrl && (
                            <a
                              href={asset.videoUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={buttonVariants({ variant: "outline", size: "sm", className: "text-xs w-24" })}
                              aria-label={t("playShotVideo", { shot: asset.shotId })}
                            >
                              <LuPlay className="w-3 h-3 mr-1" />{t("btnPlayVideo")}
                            </a>
                          )}

                          {/* action buttons (AI-generated shots can be manually generated or retried) */}
                          {asset.visualSource === "ai_generate" && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-xs w-24"
                              disabled={batchMotionBusy || asset.status === "generating" || motionShots.has(asset.shotId)}
                              onClick={() => generateOne(asset.shotId)}
                            >
                              {asset.status === "generating"
                                ? t("btnGenerating")
                                : asset.status === "done"
                                ? t("btnRegenerate")
                                : asset.status === "failed"
                                ? tc("retry")
                                : t("btnGenerate")}
                            </Button>
                          )}
                          {/* Upload the creator's own image or video for a non-product shot. */}
                          {asset.visualSource !== "product_image" && (
                            <Button
                              variant={asset.visualSource === "user_upload" && asset.status !== "done" ? "outline" : "ghost"}
                              size="sm"
                              className="text-xs w-24 text-muted-foreground hover:text-primary"
                              disabled={batchMotionBusy || uploadingShot !== null || isBatchGenerating || asset.status === "generating"}
                              onClick={() => openUploadFor(asset.shotId)}
                            >
                              {uploadingShot === asset.shotId ? (
                                <LuLoaderCircle className="animate-spin h-3.5 w-3.5" />
                              ) : (
                                <><LuUpload className="w-3 h-3 mr-1" />{asset.status === "done" ? t("btnReplaceUpload") : t("btnUpload")}</>
                              )}
                            </Button>
                          )}
                          {/* convert to motion shot: existing image asset → image-to-video (real camera moves). Product close-up shots are best kept static to avoid distortion */}
                          {asset.status === "done" && asset.assetId && asset.thumbnailUrl && !asset.isVideo && (
                            <Button
                              variant="outline" size="sm" className="text-xs w-24"
                              disabled={batchMotionBusy || keyframeRefinementBusy || isBatchGenerating || isGridGenerating || motionShots.has(asset.shotId)}
                              onClick={() => openKeyframeRefinement(asset.shotId)}
                              title={t("keyframeRefineTip")}
                            >
                              <LuSparkles className="w-3 h-3 mr-1" />{t("keyframeRefine")}
                            </Button>
                          )}
                          {asset.status === "done" && asset.thumbnailUrl && !asset.isVideo && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-xs w-24 text-muted-foreground hover:text-primary"
                              disabled={batchMotionBusy || motionShots.has(asset.shotId) || (isKlingDefault && klingCapacityBlocked && !existingKlingJob)}
                              onClick={() => generateMotion(asset.shotId)}
                              // pre-call transparency (issue #16): show which provider/model this
                              // paid call actually uses, so a t2v/i2v mix-up is visible up front
                              title={
                                isKlingDefault && klingCapacityBlocked && !existingKlingJob ? klingCapacityMessage : videoModelTarget
                                  ? `${t("motionTip")}\n${videoModelTarget.provider} · ${videoModelTarget.model}`
                                  : t("motionTip")
                              }
                            >
                              {motionShots.has(asset.shotId) ? t("btnConvertingMotion") : t("btnConvertMotion")}
                            </Button>
                          )}
                          {asset.isVideo && (
                            <span className="text-[10px] text-primary">{t("motionDone")}</span>
                          )}
                          {/* per-shot fallback (commercial "regenerate one shot" mechanism): re-run ONLY
                              the i2v from the preserved keyframe — never throws away the whole batch.
                              Full keyframe+motion redo stays available via the regenerate button above */}
                          {asset.isVideo && asset.keyframeUrl && (videoModelTarget || isKlingDefault) && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-xs w-24 text-muted-foreground hover:text-primary"
                              disabled={batchMotionBusy || motionShots.has(asset.shotId) || (isKlingDefault && klingCapacityBlocked && !existingKlingJob)}
                              onClick={() => generateMotion(asset.shotId, asset.keyframeUrl)}
                              title={`${t("redoMotionTip")}\n${videoModelTarget?.provider ?? "kling-cli"} · ${defaultVideoModel}`}
                            >
                              {motionShots.has(asset.shotId) ? t("btnConvertingMotion") : t("btnRedoMotion")}
                            </Button>
                          )}
                          {/* diagnosis retake: pick ONE symptom → resubmit with exactly ONE prompt patch
                              (user-initiated paid call; the notice states what the retake changed) */}
                          {asset.isVideo && asset.keyframeUrl && videoModelTarget && !isKlingDefault && (
                            <select
                              className="h-7 w-24 rounded-md border border-border/60 bg-background px-1 text-[11px] text-muted-foreground"
                              disabled={batchMotionBusy || motionShots.has(asset.shotId)}
                              value=""
                              title={t("retakeDiagTip")}
                              onChange={(e) => {
                                const v = e.target.value as RetakeSymptom | "";
                                if (v) void generateMotion(asset.shotId, asset.keyframeUrl, undefined, v);
                              }}
                            >
                              <option value="">{t("retakeDiag")}</option>
                              {RETAKE_SYMPTOMS.map((sym) => (
                                <option key={sym.id} value={sym.id}>
                                  {locale === "zh" ? sym.label.zh : sym.label.en}
                                </option>
                              ))}
                            </select>
                          )}
                          {/* error text lives in the middle column next to the shot content; not repeated here */}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {/* bottom action */}
            <div className="mt-8 flex justify-end">
              <Link href={allDone ? `/project/${id}/video` : "#"}>
                <Button className="brand-gradient text-white text-sm" disabled={!allDone}>
                  {t("nextCompose")}
                  <LuArrowRight className="w-4 h-4 ml-1" />
                </Button>
              </Link>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
