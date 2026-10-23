"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { LuWand, LuClock, LuImage, LuArrowRight, LuBookmarkPlus, LuLoaderCircle, LuTriangleAlert, LuCircleCheck, LuCircleX, LuPencil, LuTrash2, LuHistory } from "react-icons/lu";
import { checkScriptCompliance } from "@/lib/ad-compliance";
import { checkPublishReadiness } from "@/lib/publish-readiness";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import type { Shot } from "@/lib/db/schema";
import { JUDGE_META, type JudgeReport, autoApplicableRewrites, autoApplicableDescriptionRewrites } from "@/lib/script-judge";
import { useTemplateStore } from "@/lib/stores/template-store";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { useT, useLocale } from "@/lib/i18n";
import { STAGE_LABEL_KEYS } from "@/lib/pipeline-stages";
import { friendlyError } from "@/lib/friendly-error";
import { abortable, currentScriptOptions, generateProjectScripts, type SavedScript as DbScript } from "@/lib/script-generation-client";
import { SHOW_FREE_QUICK_CUT } from "@/lib/ui-features";
import { ProjectHeader } from "@/components/project-header";
import { ScriptHistoryDialog } from "@/components/script-history-dialog";
import {
  createPremiumProductCgProfile,
  createShortVideoSalesProfile,
  resolveCreativeProfile,
  sanitizeCreativeProfileDrafts,
  type CreationType,
  type ProjectCreativeProfile,
  type ProjectCreativeProfileDrafts,
} from "@/lib/creative-profiles";

// shot type labels (label changed to i18n key, resolved per locale at render time)
const shotTypeLabels: Record<Shot["type"], { labelKey: string; color: string }> = {
  hook: { labelKey: "shotTypeHook", color: "bg-red-500/20 text-red-400" },
  pain_point: { labelKey: "shotTypePainPoint", color: "bg-orange-500/20 text-orange-400" },
  product_reveal: { labelKey: "shotTypeProductReveal", color: "bg-blue-500/20 text-blue-400" },
  demo: { labelKey: "shotTypeDemo", color: "bg-green-500/20 text-green-400" },
  social_proof: { labelKey: "shotTypeSocialProof", color: "bg-purple-500/20 text-purple-400" },
  cta: { labelKey: "shotTypeCta", color: "bg-amber-500/20 text-amber-400" },
};

// script style → i18n key (resolved per locale at render time)
const styleLabelKeys: Record<string, string> = {
  pain_point: "stylePainPoint",
  scene: "styleScene",
  comparison: "styleComparison",
  story: "styleStory",
  premium_product_cg: "stylePremiumCg",
};

interface ProjectMeta {
  productName: string;
  category: string;
  description: string;
  productImages: string[];
  videoMode: string;
  contentType: string;
  topic: string;
  creativeProfile: ProjectCreativeProfile;
  creativeProfileDrafts: ProjectCreativeProfileDrafts;
  creativeConfigRevision: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRecord(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function projectMetaFromResponse(value: unknown): ProjectMeta {
  const project = isRecord(value) ? value : {};
  const fallback = {
    videoMode: project.videoMode,
    targetDuration: project.targetDuration ?? project.duration,
    styleType: project.styleType,
  };
  const creativeProfile = resolveCreativeProfile(parseJsonRecord(project.creativeProfile), fallback);
  const parsedDrafts = sanitizeCreativeProfileDrafts(parseJsonRecord(project.creativeProfileDrafts)) ?? {};
  const creativeProfileDrafts: ProjectCreativeProfileDrafts = {
    short_video_sales: parsedDrafts.short_video_sales ?? createShortVideoSalesProfile(fallback),
    premium_product_cg: parsedDrafts.premium_product_cg ?? createPremiumProductCgProfile(),
  };
  if (creativeProfile.creationType === "premium_product_cg") {
    creativeProfileDrafts.premium_product_cg = creativeProfile;
  } else {
    creativeProfileDrafts.short_video_sales = creativeProfile;
  }
  return {
    productName: typeof project.productName === "string" ? project.productName : "",
    category: typeof project.productCategory === "string" ? project.productCategory : "",
    description: typeof project.productDescription === "string" ? project.productDescription : "",
    productImages: Array.isArray(project.productImages) ? project.productImages.filter((image): image is string => typeof image === "string") : [],
    videoMode: creativeProfile.videoMode,
    contentType: typeof project.contentType === "string" ? project.contentType : "product",
    topic: typeof project.topic === "string" ? project.topic : "",
    creativeProfile,
    creativeProfileDrafts,
    creativeConfigRevision: typeof project.creativeConfigRevision === "number" && Number.isSafeInteger(project.creativeConfigRevision)
      ? project.creativeConfigRevision
      : 0,
  };
}

export default function ScriptPage() {
  const t = useT("script");
  const tc = useT("common");
  const locale = useLocale();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [selectedScript, setSelectedScript] = useState(0);
  const [scripts, setScripts] = useState<
    { id: string; title: string; styleType: string; totalDuration: number; shots: Shot[] }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [projectName, setProjectName] = useState("");
  // project metadata: reused when re-generating the script from the empty state
  const [projectMeta, setProjectMeta] = useState<ProjectMeta | null>(null);
  const [creativeConfigSaving, setCreativeConfigSaving] = useState(false);
  const [creativeConfigError, setCreativeConfigError] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const generationInFlight = useRef(false);
  const generationAbort = useRef<AbortController | null>(null);
  const deletionAbort = useRef<AbortController | null>(null);
  const selectionAbort = useRef<AbortController | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionError, setSelectionError] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [genError, setGenError] = useState("");
  const { llm } = useSettingsStore();
  // beginner/director split: simple mode swaps the 3-column editor for a read-and-go card
  const uiMode = useSettingsStore((st) => st.uiMode);
  const setUiMode = useSettingsStore((st) => st.setUiMode);
  // judge panel: four narrow judges tear the lines apart before generation money is spent
  const [judging, setJudging] = useState(false);
  const [judgeReport, setJudgeReport] = useState<JudgeReport | null>(null);
  const [judgeError, setJudgeError] = useState("");
  const [judgeApplying, setJudgeApplying] = useState(false);
  const [judgeApplied, setJudgeApplied] = useState(false);

  useEffect(() => {
    setIsGenerating(false);
    setIsDeleting(false);
    setIsSelecting(false);
    setSelectionError("");
    setHistoryOpen(false);
    setDeleteTarget(null);
    setDeleteError("");
    return () => {
      generationAbort.current?.abort();
      generationAbort.current = null;
      generationInFlight.current = false;
      deletionAbort.current?.abort();
      deletionAbort.current = null;
      selectionAbort.current?.abort();
      selectionAbort.current = null;
    };
  }, [id]);

  // empty-state "generate script" click: topic projects use the de-commercialized script engine, commerce projects use the product script engine
  const handleGenerate = async () => {
    if (!projectMeta || generationInFlight.current || deletionAbort.current || selectionAbort.current || judging || judgeApplying || editStatus === "saving") return;
    if (!llm.apiKey) {
      setGenError(t("errorNoLlm"));
      return;
    }
    generationInFlight.current = true;
    const controller = new AbortController();
    generationAbort.current = controller;
    setIsGenerating(true);
    setGenError("");
    try {
      const isTopic = projectMeta.contentType === "topic";
      // topic projects use /api/topic/script (no product needed); otherwise use the commerce script engine
      const endpoint = isTopic ? "/api/topic/script" : "/api/llm/script";
      const payload = isTopic
        ? {
            projectId: id,
            topic: projectMeta.topic || projectName,
            targetDuration: 25,
            llmConfig: { provider: llm.provider, baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model },
          }
        : {
            projectId: id,
            productName: projectMeta.productName,
            category: projectMeta.category,
            productDescription: projectMeta.description,
            targetDuration: projectMeta.creativeProfile.targetDuration,
            styleType: projectMeta.creativeProfile.styleType,
            videoMode: projectMeta.creativeProfile.videoMode,
            creativeProfile: projectMeta.creativeProfile,
            creativeProfileDrafts: projectMeta.creativeProfileDrafts,
            productImages: projectMeta.productImages,
            llmConfig: {
              provider: llm.provider,
              baseUrl: llm.baseUrl,
              apiKey: llm.apiKey,
              model: llm.model,
              visionModel: llm.visionModel,
            },
          };
      const dbScripts = await generateProjectScripts({
        endpoint, payload, projectId: id, knownScriptIds: scripts.map((script) => script.id),
        signal: controller.signal,
        messages: {
          failed: t("errorGenFailedCheckLlm"),
          reload: t("errorReloadScripts"),
          unconfirmed: t("errorGenerationUnconfirmed"),
        },
      });
      if (controller.signal.aborted) return;
      const currentOptions = currentScriptOptions(dbScripts);
      setScripts(
        currentOptions.map((script) => ({
          id: script.id,
          title: script.title ?? t("untitledScript"),
          styleType: script.styleType,
          totalDuration: script.totalDuration ?? 0,
          shots: script.shots,
        }))
      );
      const selectedIndex = currentOptions.findIndex((script) => script.selected);
      setSelectedScript(selectedIndex >= 0 ? selectedIndex : 0);
    } catch (err) {
      if (!controller.signal.aborted) setGenError(friendlyError(err, locale));
    } finally {
      if (generationAbort.current === controller) {
        generationAbort.current = null;
        generationInFlight.current = false;
        setIsGenerating(false);
      }
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deletionAbort.current || generationInFlight.current || selectionAbort.current || judging || judgeApplying || editStatus === "saving") return;
    const controller = new AbortController();
    deletionAbort.current = controller;
    setIsDeleting(true);
    setDeleteError("");
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`/api/project/${id}/scripts`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scriptId: deleteTarget.id }),
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t("deleteFailed"));
      if (controller.signal.aborted) return;
      if (!Array.isArray(data.scripts)) throw new Error(t("deleteFailed"));
      const options = currentScriptOptions(data.scripts as DbScript[]);
      setScripts(options.map((script) => ({
        id: script.id,
        title: script.title ?? t("untitledScript"),
        styleType: script.styleType,
        totalDuration: script.totalDuration ?? 0,
        shots: script.shots ?? [],
      })));
      const selectedIndex = options.findIndex((script) => script.selected);
      setSelectedScript(selectedIndex >= 0 ? selectedIndex : 0);
      setJudgeReport(null);
      setJudgeError("");
      setJudgeApplied(false);
      setEditingShotId(null);
      setDeleteTarget(null);
    } catch (error) {
      if (deletionAbort.current === controller) setDeleteError(friendlyError(error, locale));
    } finally {
      clearTimeout(timeout);
      if (deletionAbort.current === controller) {
        deletionAbort.current = null;
        setIsDeleting(false);
      }
    }
  };

  const switchCreationType = async (nextType: CreationType) => {
    if (!projectMeta || projectMeta.contentType === "topic" || creativeConfigSaving) return;
    if (projectMeta.creativeProfile.creationType === nextType) return;

    const currentProfile = projectMeta.creativeProfile;
    const drafts: ProjectCreativeProfileDrafts = {
      ...projectMeta.creativeProfileDrafts,
      [currentProfile.creationType]: currentProfile,
    };
    const nextProfile = nextType === "premium_product_cg"
      ? drafts.premium_product_cg ?? createPremiumProductCgProfile()
      : drafts.short_video_sales ?? createShortVideoSalesProfile({ videoMode: projectMeta.videoMode });
    const nextDrafts: ProjectCreativeProfileDrafts = {
      ...drafts,
      [nextType]: nextProfile,
    };

    setCreativeConfigSaving(true);
    setCreativeConfigError("");
    try {
      const response = await fetch(`/api/project/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creativeProfile: nextProfile,
          creativeProfileDrafts: nextDrafts,
          expectedCreativeConfigRevision: projectMeta.creativeConfigRevision,
          videoMode: nextProfile.videoMode,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (data.code === "CREATIVE_CONFIG_CONFLICT") {
          setProjectMeta((previous) => previous
            ? projectMetaFromResponse({
                ...previous,
                creativeProfile: data.creativeProfile,
                creativeProfileDrafts: data.creativeProfileDrafts,
                creativeConfigRevision: data.creativeConfigRevision,
              })
            : previous
          );
        }
        throw new Error(data.error || t("creativeProfileSaveFailed"));
      }
      setProjectMeta(projectMetaFromResponse(data));
    } catch (error) {
      setCreativeConfigError(friendlyError(error, locale));
    } finally {
      setCreativeConfigSaving(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [scriptsRes, projectRes] = await Promise.all([
          fetch(`/api/project/${id}/scripts`),
          fetch(`/api/project/${id}`),
        ]);
        const savedScripts: DbScript[] = scriptsRes.ok ? await scriptsRes.json() : [];
        const dbScripts = Array.isArray(savedScripts) ? currentScriptOptions(savedScripts) : [];
        if (projectRes.ok) {
          const proj = await projectRes.json();
          if (!cancelled) {
            setProjectName(proj.name ?? proj.productName ?? "");
            setProjectMeta(projectMetaFromResponse(proj));
          }
        }
        if (cancelled) return;
        if (Array.isArray(dbScripts) && dbScripts.length > 0) {
          setScripts(
            dbScripts.map((s) => ({
              id: s.id,
              title: s.title ?? t("untitledScript"),
              styleType: s.styleType,
              totalDuration: s.totalDuration ?? 0,
              shots: s.shots ?? [],
            }))
          );
          // default to the script marked as selected
          const selIdx = dbScripts.findIndex((s) => s.selected);
          setSelectedScript(selIdx >= 0 ? selIdx : 0);
        } else {
          // no real scripts: stay empty so the render layer shows the "generate" empty state
          // (fixes issue #3: old logic fell back to the Debao demo data, so users opening their own
          //  projects saw someone else's demo and thought "I can't find the task I created")
          setScripts([]);
        }
      } catch {
        if (!cancelled) setScripts([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const currentScript = scripts[selectedScript];
  const isPremiumCgProject = projectMeta?.creativeProfile.creationType === "premium_product_cg";
  // pre-render ad compliance scan: rule-check the current script's voiceover and text overlays; warn on risky terms (non-blocking)
  const adViolations = useMemo(
    () => (currentScript && !isPremiumCgProject ? checkScriptCompliance(currentScript.shots as { voiceover?: string; textOverlay?: { text?: string } | null }[]) : []),
    [currentScript, isPremiumCgProject]
  );
  // pre-publish readiness check: inspect banned words / hook / duration / subtitles / CTA / three-act structure item by item (AIGC label is handled by the compose page, not checked here)
  const readiness = useMemo(
    () =>
      currentScript && !isPremiumCgProject
        ? checkPublishReadiness(currentScript.shots as Shot[], currentScript.totalDuration, {
            locale,
            // commerce hard rule "product visible in the first 3s" — only for product videos (topic videos have no productName)
            productName: projectMeta?.productName || undefined,
          })
        : null,
    [currentScript, locale, projectMeta?.productName, isPremiumCgProject]
  );

  // template-related state
  const { addTemplate } = useTemplateStore();
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [templateName, setTemplateName] = useState("");
  // Confirm before replacing the current alternatives; saved revisions remain in project history.
  const [regenConfirmOpen, setRegenConfirmOpen] = useState(false);
  const [savedTip, setSavedTip] = useState(false);

  /** click the "save as template" button */
  const handleSaveAsTemplate = () => {
    setTemplateName("");
    setShowSaveDialog(true);
  };

  /** confirm and save the template */
  const doSaveTemplate = () => {
    if (!templateName.trim() || !currentScript) return;
    addTemplate({
      id: crypto.randomUUID(),
      name: templateName.trim(),
      styleType: currentScript.styleType,
      shots: currentScript.shots as Shot[],
      totalDuration: currentScript.totalDuration,
      useCount: 0,
      createdAt: new Date(),
    });
    setShowSaveDialog(false);
    setSavedTip(true);
    setTimeout(() => setSavedTip(false), 3000);
  };

  // ---- selection persistence: switching the active variant must be written to the DB, otherwise
  // downstream steps (assets/video/export) read `selected` from the DB and use a different script ----
  const [selectionTip, setSelectionTip] = useState(false);
  const persistSelection = async (index: number) => {
    if (generationInFlight.current || deletionAbort.current || selectionAbort.current || judging || judgeApplying || editStatus === "saving") return;
    const target = scripts[index];
    if (!target) return;
    const previousIndex = selectedScript;
    const controller = new AbortController();
    selectionAbort.current = controller;
    setIsSelecting(true);
    setSelectionError("");
    setSelectedScript(index);
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`/api/project/${id}/scripts`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedScriptId: target.id }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(t("selectionFailed"));
      if (controller.signal.aborted) return;
      setSelectionTip(true);
      setTimeout(() => setSelectionTip(false), 1500);
    } catch (error) {
      if (selectionAbort.current === controller) {
        setSelectedScript(previousIndex);
        setSelectionError(friendlyError(error, locale));
      }
    } finally {
      clearTimeout(timeout);
      if (selectionAbort.current === controller) {
        selectionAbort.current = null;
        setIsSelecting(false);
      }
    }
  };

  const restoreHistoricalScript = async (scriptId: string) => {
    if (generationInFlight.current || deletionAbort.current || selectionAbort.current || judging || judgeApplying || editStatus === "saving" || creativeConfigSaving || autoFinishing) {
      throw new Error(t("historyRestoreBusy"));
    }
    const controller = new AbortController();
    selectionAbort.current = controller;
    setIsSelecting(true);
    const timeout = setTimeout(() => controller.abort(new Error(t("historyRestoreTimedOut"))), 15_000);
    try {
      const { response, data } = await abortable((async () => {
        const response = await fetch(`/api/project/${id}/scripts`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ restoreScriptId: scriptId }),
          signal: controller.signal,
        });
        return { response, data: await response.json() };
      })(), controller.signal);
      if (!response.ok) throw new Error(data.error || t("historyRestoreFailed"));
      if (controller.signal.aborted) throw new Error(t("historyRestoreFailed"));
      const options = Array.isArray(data.scripts) ? currentScriptOptions(data.scripts as DbScript[]) : [];
      if (!options.some((script) => script.id === scriptId && script.selected)) {
        throw new Error(t("historyRestoreFailed"));
      }
      setScripts(options.map((script) => ({
        id: script.id,
        title: script.title ?? t("untitledScript"),
        styleType: script.styleType,
        totalDuration: script.totalDuration ?? 0,
        shots: script.shots ?? [],
      })));
      setSelectedScript(options.findIndex((script) => script.selected));
      setSelectionError("");
      setGenError("");
      setHistoryOpen(false);
    } catch (error) {
      throw new Error(friendlyError(error, locale));
    } finally {
      clearTimeout(timeout);
      if (selectionAbort.current === controller) {
        selectionAbort.current = null;
        setIsSelecting(false);
      }
    }
  };

  // ---- per-shot inline editing: only voiceover/description text (structure/timing untouched) ----
  const [editingShotId, setEditingShotId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<{ voiceover: string; description: string }>({ voiceover: "", description: "" });
  const [editStatus, setEditStatus] = useState<"" | "saving" | "saved" | "failed">("");
  const startEditShot = (shot: Shot) => {
    if (generationInFlight.current || deletionAbort.current || selectionAbort.current || judging || judgeApplying || editStatus === "saving") return;
    setEditingShotId(shot.shotId);
    setEditDraft({ voiceover: shot.voiceover ?? "", description: shot.description ?? "" });
    setEditStatus("");
  };
  const cancelEditShot = () => {
    if (editStatus === "saving") return;
    setEditingShotId(null);
    setEditStatus("");
  };
  // ---- one-click auto-finish: script → auto-fill footage → compose → export, all keyless.
  // Mirrors the batch page's autoCompose so the single-project web flow isn't the only path that
  // can't run end-to-end automatically. Compose is polled by the exact compositionId (precise, race-free). ----
  const [autoFinishing, setAutoFinishing] = useState(false);
  const [autoFinishStage, setAutoFinishStage] = useState("");
  const [autoFinishError, setAutoFinishError] = useState("");
  // Hands-off mode (?auto=1, set by the /start hero flows): auto-run the same chain and show a
  // takeover progress card instead of dropping beginners into the full editor. "转手动" simply
  // reveals the editor — the running chain is untouched.
  const [autoMode, setAutoMode] = useState(false);
  const [autoModeTriggered, setAutoModeTriggered] = useState(false);
  // generation-task mode chosen on the studio card (?gen=ai): the free chain stays hands-off,
  // the AI chain stops at the script gate before continuing to Assets
  const [genPref, setGenPref] = useState<"free" | "ai">(SHOW_FREE_QUICK_CUT ? "free" : "ai");
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    if (qs.get("auto") === "1") setAutoMode(true);
    if (qs.get("gen") === "ai") setGenPref("ai");
  }, []);
  // (the ?auto=1 fresh-start trigger lives below, after the pipeline re-attach check)
  // The free chain now runs SERVER-SIDE (pipeline_runs): the page only starts a run and
  // observes it, so closing/refreshing the tab no longer kills the chain — reopening the
  // project re-attaches to the live run, and a failed run offers resume-from-breakpoint.
  const [resumableRun, setResumableRun] = useState<{ id: string; stage: string; interrupted?: boolean } | null>(null);

  /** Poll the project's latest pipeline run to a terminal status, mirroring stage labels. */
  const attachPipeline = async () => {
    if (!SHOW_FREE_QUICK_CUT || isPremiumCgProject) return;
    setAutoFinishing(true);
    setAutoFinishError("");
    setResumableRun(null);
    try {
      // 2.5s × 312 ≈ 13 min, above the server-side compose polling budget
      for (let i = 0; i < 312; i++) {
        const d = await fetch(`/api/project/${id}/pipeline`).then((x) => x.json()).catch(() => ({}));
        const run = d?.run;
        if (!run) throw new Error(t("autoFinishFailed"));
        const labelKey = STAGE_LABEL_KEYS[run.stage as keyof typeof STAGE_LABEL_KEYS];
        setAutoFinishStage(labelKey ? t(labelKey) : t("autoFinishSelecting"));
        if (run.status === "done") { router.push(`/project/${id}/export`); return; }
        if (run.status === "failed") {
          setResumableRun({ id: run.id, stage: run.stage, interrupted: run.interrupted });
          throw new Error(run.error === "interrupted" ? t("pipelineInterrupted") : run.error || t("autoFinishFailed"));
        }
        await new Promise((r) => setTimeout(r, 2500));
      }
      throw new Error(t("autoFinishFailed"));
    } catch (err) {
      setAutoFinishError(friendlyError(err, locale));
      setAutoFinishing(false);
    }
  };

  /** Start (or resume) the server-side run, then attach as an observer. */
  const startPipeline = async (resume: boolean) => {
    if (!SHOW_FREE_QUICK_CUT || isPremiumCgProject) return;
    if (autoFinishing) return;
    if (!resume && !currentScript) return;
    setAutoFinishing(true);
    setAutoFinishError("");
    setAutoFinishStage(t("autoFinishSelecting"));
    try {
      const res = await fetch(`/api/project/${id}/pipeline`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(resume ? { resume: true } : { scriptId: currentScript!.id }),
          // LLM config opt-in: enables the judge quality pass + semantic footage rerank
          ...(llm.baseUrl && llm.model ? { llmConfig: { baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model } } : {}),
        }),
      });
      if (!res.ok) throw new Error(t("autoFinishFailed"));
      await attachPipeline();
    } catch (err) {
      setAutoFinishError(friendlyError(err, locale));
      setAutoFinishing(false);
    }
  };

  const autoFinish = () => startPipeline(false);

  // On entry, look for a live or breakpointed run BEFORE any fresh auto start:
  // live → re-attach (the "came back after closing the tab" path);
  // failed → surface the resume/restart choice instead of silently starting over.
  const [pipelineChecked, setPipelineChecked] = useState(!SHOW_FREE_QUICK_CUT);
  useEffect(() => {
    if (!SHOW_FREE_QUICK_CUT || !projectMeta) return;
    if (isPremiumCgProject) {
      setPipelineChecked(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const d = await fetch(`/api/project/${id}/pipeline`).then((x) => x.json()).catch(() => ({}));
        if (cancelled) return;
        const run = d?.run;
        if (run?.status === "running") {
          setAutoModeTriggered(true); // suppress the fresh ?auto=1 trigger — we're already attached
          void attachPipeline();
        } else if (run?.status === "failed") {
          setResumableRun({ id: run.id, stage: run.stage, interrupted: run.interrupted });
        }
      } finally {
        if (!cancelled) setPipelineChecked(true);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot on mount; attachPipeline is a stable page-level handler
  }, [id, isPremiumCgProject, projectMeta]);

  // ?auto=1 fresh start (from the /start hero flows) — only after the re-attach check settled,
  // so an already-live or breakpointed run is never silently restarted from the top
  useEffect(() => {
    if (!SHOW_FREE_QUICK_CUT || !projectMeta || isPremiumCgProject || !autoMode || autoModeTriggered || loading || !currentScript || !pipelineChecked || resumableRun) return;
    setAutoModeTriggered(true);
    // the AI path lands on the "script ready" gate instead of auto-running the free chain
    if (genPref !== "ai") autoFinish();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- autoFinish is a stable page-level handler; triggering once per auto entry
  }, [autoMode, autoModeTriggered, loading, currentScript, genPref, pipelineChecked, resumableRun, isPremiumCgProject, projectMeta]);

  // Reports and open edits belong to a script ID; regeneration may retain the same list index.
  useEffect(() => {
    setJudgeReport(null);
    setJudgeError("");
    setJudgeApplied(false);
    setEditingShotId(null);
    setEditStatus("");
  }, [currentScript?.id]);

  // run the judge panel on the current script's voiceover lines (one LLM call, four judges)
  const runJudge = async () => {
    if (!currentScript || generationInFlight.current || deletionAbort.current || selectionAbort.current || judging || judgeApplying || editStatus === "saving") return;
    setJudging(true);
    setJudgeError("");
    setJudgeReport(null);
    setJudgeApplied(false);
    try {
      const res = await fetch(`/api/project/${id}/script-judge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scriptId: currentScript.id,
          llmConfig: { baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("judgeFailed"));
      setJudgeReport(data as JudgeReport);
    } catch (e) {
      setJudgeError(e instanceof Error ? e.message : t("judgeFailed"));
    } finally {
      setJudging(false);
    }
  };

  // apply the judges' rewrites through the existing shotTexts PATCH channel (+ optimistic update)
  const applyJudgeRewrites = async () => {
    if (!currentScript || !judgeReport || generationInFlight.current || deletionAbort.current || selectionAbort.current || judging || judgeApplying || editStatus === "saving") return;
    // tier gate applies to the button too: taste-tier rewrites stay suggestions in the list
    const autoRewrites = autoApplicableRewrites(judgeReport);
    const autoDescRewrites = autoApplicableDescriptionRewrites(judgeReport);
    if (autoRewrites.length === 0 && autoDescRewrites.length === 0) return;
    const patchByShot = new Map<number, { shotId: number; voiceover?: string; description?: string }>();
    for (const r of autoRewrites) patchByShot.set(r.shotId, { shotId: r.shotId, voiceover: r.voiceover });
    for (const r of autoDescRewrites) {
      patchByShot.set(r.shotId, { ...(patchByShot.get(r.shotId) ?? { shotId: r.shotId }), description: r.description });
    }
    setJudgeApplying(true);
    setScripts((prev) =>
      prev.map((s) =>
        s.id === currentScript.id
          ? {
              ...s,
              shots: s.shots.map((sh) => {
                const p = patchByShot.get(sh.shotId);
                return p ? { ...sh, ...(p.voiceover && { voiceover: p.voiceover }), ...(p.description && { description: p.description }) } : sh;
              }),
            }
          : s
      )
    );
    try {
      const res = await fetch(`/api/project/${id}/scripts`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scriptId: currentScript.id, shotTexts: Array.from(patchByShot.values()) }),
      });
      if (!res.ok) throw new Error("apply failed");
      setJudgeApplied(true);
    } catch {
      setJudgeError(t("judgeApplyFailed"));
    } finally {
      setJudgeApplying(false);
    }
  };

  const saveEditShot = async (shotId: number) => {
    if (!currentScript || generationInFlight.current || deletionAbort.current || selectionAbort.current || judging || judgeApplying || editStatus === "saving") return;
    setEditStatus("saving");
    // optimistic local update so the timeline reflects the edit immediately
    setScripts((prev) =>
      prev.map((s) =>
        s.id === currentScript.id
          ? { ...s, shots: s.shots.map((sh) => (sh.shotId === shotId ? { ...sh, voiceover: editDraft.voiceover.trim(), description: editDraft.description.trim() } : sh)) }
          : s
      )
    );
    try {
      const res = await fetch(`/api/project/${id}/scripts`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scriptId: currentScript.id, shotTexts: [{ shotId, voiceover: editDraft.voiceover, description: editDraft.description }] }),
      });
      if (!res.ok) throw new Error("save failed");
      setEditStatus("saved");
      setEditingShotId(null);
      setTimeout(() => setEditStatus(""), 1500);
    } catch {
      setEditStatus("failed");
    }
  };

  // slim context strip (shared by loading, empty and normal states); global chrome lives in AppShell
  const scriptActionsBusy = isGenerating || isDeleting || isSelecting || judging || judgeApplying || editStatus === "saving";
  const historyButton = (
    <Button variant="outline" size="sm" className="text-xs" disabled={scriptActionsBusy || creativeConfigSaving || autoFinishing} onClick={() => setHistoryOpen(true)}>
      <LuHistory className="mr-1 h-3.5 w-3.5" />{t("historyButton")}
    </Button>
  );
  const historyDialog = historyOpen ? (
    <ScriptHistoryDialog key={id} projectId={id} busy={scriptActionsBusy || creativeConfigSaving || autoFinishing} onClose={() => setHistoryOpen(false)} onRestore={restoreHistoricalScript} />
  ) : null;
  const headerBar = <ProjectHeader projectName={projectName || t("defaultProjectName")} />;
  const creativeProfileSwitcher = projectMeta && projectMeta.contentType !== "topic" ? (
    <Card className="glass-card mb-5">
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">{t("creativeTypeTitle")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("creativeTypeDesc")}</p>
          </div>
          <div className="flex gap-2" role="group" aria-label={t("creativeTypeTitle")}>
            {([
              { value: "short_video_sales" as const, labelKey: "creativeTypeSales" },
              { value: "premium_product_cg" as const, labelKey: "creativeTypeCg" },
            ]).map((option) => {
              const selected = projectMeta.creativeProfile.creationType === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={creativeConfigSaving || scriptActionsBusy || autoFinishing}
                  onClick={() => void switchCreationType(option.value)}
                  className={`rounded-lg border px-3 py-2 text-xs font-medium transition-all ${
                    selected ? "border-primary bg-primary/10 text-primary" : "border-border/50 bg-muted/20 text-muted-foreground hover:border-primary/40"
                  } disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  {selected && "✓ "}{t(option.labelKey)}
                </button>
              );
            })}
          </div>
        </div>
        {projectMeta.creativeProfile.creationType === "premium_product_cg" && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="text-primary">{t("creativeTypeCgActive")}</span>
            <span>{t("creativeProfileDuration", { n: projectMeta.creativeProfile.targetDuration })}</span>
            <span>{projectMeta.creativeProfile.narrationMode === "none" ? t("creativeProfileVisualOnly") : t("creativeProfileRestrainedVoice")}</span>
            <span>{t("creativeProfileNoText")}</span>
          </div>
        )}
        {creativeConfigError && <p role="alert" className="mt-2 text-xs text-destructive">{creativeConfigError}</p>}
      </CardContent>
    </Card>
  ) : null;

  // loading: skeleton screen (mimics the script card layout; feels faster than a spinner and reduces perceived wait)
  if (loading) {
    return (
      <div className="min-h-screen grid-bg">
        {headerBar}
        <div className="max-w-4xl mx-auto px-6 py-8 space-y-4" aria-busy="true" aria-label={t("loadingScripts")}>
          {[0, 1, 2].map((i) => (
            <Card key={i} className="glass-card animate-pulse">
              <CardContent className="p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="h-4 w-40 rounded bg-muted/60" />
                  <div className="h-4 w-16 rounded bg-muted/40" />
                </div>
                <div className="h-2 w-full rounded bg-muted/40" />
                <div className="flex gap-2">
                  <div className="h-6 w-20 rounded bg-muted/40" />
                  <div className="h-6 w-20 rounded bg-muted/40" />
                  <div className="h-6 w-24 rounded bg-muted/30" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  // empty state: this project has no real scripts yet (fixes #3: no longer shows the Debao demo; provides a recoverable "generate script" entry point)
  if (scripts.length === 0) {
    return (
      <div className="min-h-screen grid-bg">
        {headerBar}
        <div className="mx-auto max-w-md flex flex-col items-center justify-center py-28 px-6 text-center">
          <div className="w-full text-left">{creativeProfileSwitcher}</div>
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/40 mb-5">
            <LuWand className="w-8 h-8 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-semibold mb-2">{t("emptyTitle")}</h2>
          <p className="text-sm text-muted-foreground mb-6">
            {t("emptyDesc", { name: projectName || t("emptyDescThisProject") })}
          </p>
          {genError && (
            <div className="mb-4 flex flex-col items-center gap-2">
              <p role="alert" className="text-sm text-destructive">{genError}</p>
              {/* most generation errors are LLM-config related — offer a direct jump to Settings */}
              <Link href="/settings?tab=llm" className="text-xs text-primary underline underline-offset-2 hover:text-primary/80">
                {t("goToSettings")}
              </Link>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button onClick={handleGenerate} disabled={scriptActionsBusy || creativeConfigSaving} aria-busy={isGenerating} className="brand-gradient text-white">
              {isGenerating ? (
                <>
                  <LuLoaderCircle className="w-4 h-4 mr-2 animate-spin" />
                  {tc("generating")}
                </>
              ) : (
                <>
                  <LuWand className="w-4 h-4 mr-2" />
                  {t("generateScript")}
                </>
              )}
            </Button>
            {historyButton}
            <Link href="/projects">
              <Button variant="outline">{t("backToProjects")}</Button>
            </Link>
          </div>
        </div>
        {historyDialog}
      </div>
    );
  }

  // Hands-off takeover: while the auto chain (free) runs,
  // beginners see one progress card, not the editor
  if (SHOW_FREE_QUICK_CUT && !isPremiumCgProject && autoMode && !autoFinishError && (autoFinishing || !autoModeTriggered)) {
    return (
      <div className="min-h-screen grid-bg">
        {headerBar}
        <main className="mx-auto flex max-w-lg flex-col items-center px-6 py-24 text-center">
          <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl brand-gradient">
            <svg className="h-6 w-6 animate-spin text-white" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.4 0 0 5.4 0 12h4z" />
            </svg>
          </div>
          <h2 className="text-xl font-bold">{t("autoModeTitle")}</h2>
          <p className="mt-2 text-sm text-primary">
            {autoFinishStage || t("autoFinishSelecting")}
          </p>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            {t("autoModeHint")}
          </p>
          <Button variant="outline" size="sm" className="mt-8 text-xs" onClick={() => setAutoMode(false)}>
            {t("autoModeManual")}
          </Button>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen grid-bg">
      {headerBar}
      <main className="mx-auto max-w-7xl px-6 py-8">
        {creativeProfileSwitcher}
        {/* breakpoint choice: a failed/interrupted server-side run offers resume (default) or a
            clean restart — the beginner never loses a half-finished chain to a closed tab again */}
        {SHOW_FREE_QUICK_CUT && !isPremiumCgProject && resumableRun && !autoFinishing && (
          <div className="mx-auto mb-5 max-w-2xl rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
            <p className="text-sm font-medium text-amber-500">
              ⏸ {resumableRun.interrupted ? t("pipelineInterruptedTitle") : t("pipelineFailedTitle")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("pipelineResumeDesc", {
                stage: STAGE_LABEL_KEYS[resumableRun.stage as keyof typeof STAGE_LABEL_KEYS]
                  ? t(STAGE_LABEL_KEYS[resumableRun.stage as keyof typeof STAGE_LABEL_KEYS])
                  : resumableRun.stage,
              })}
            </p>
            <div className="mt-2.5 flex gap-2">
              <Button size="sm" className="brand-gradient text-white" onClick={() => startPipeline(true)}>
                {t("pipelineResume")}
              </Button>
              <Button size="sm" variant="outline" disabled={!currentScript} onClick={() => startPipeline(false)}>
                {t("pipelineRestart")}
              </Button>
            </div>
          </div>
        )}
        {uiMode === "simple" ? (
          /* Beginner view: script text + one big button. No storyboard, no panels. */
          <div className="mx-auto max-w-2xl space-y-4">
            <div className="text-center">
              <h2 className="text-xl font-bold">{t("simpleTitle")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t("simpleSubtitle")}</p>
            </div>
            <Card className="glass-card">
              <CardContent className="p-5">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h3 className="min-w-0 truncate text-sm font-semibold">{currentScript?.title}</h3>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {currentScript ? `${currentScript.totalDuration}s` : ""}
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                  {currentScript?.shots.map((sh) => sh.voiceover).filter(Boolean).join("\n\n")}
                </p>
              </CardContent>
            </Card>
            {autoFinishError && (
              <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-xs text-destructive">
                {autoFinishError}
              </div>
            )}
            {genError && (
              <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-500/40 bg-red-500/5 px-4 py-2.5 text-xs text-red-400">
                <span>{genError}</span>
                <Link href="/settings?tab=llm" className="shrink-0 text-primary underline underline-offset-2 hover:text-primary/80">
                  {t("goToSettings")}
                </Link>
              </div>
            )}
            <div className="flex flex-col items-center gap-3">
              <div className={`grid w-full gap-2 ${SHOW_FREE_QUICK_CUT && !isPremiumCgProject ? "sm:grid-cols-2" : ""}`}>
                {SHOW_FREE_QUICK_CUT && !isPremiumCgProject && <Button
                  size="lg"
                  variant={genPref === "ai" ? "outline" : "default"}
                  className={`w-full ${genPref === "ai" ? "" : "brand-gradient text-white"}`}
                  disabled={autoFinishing || !currentScript}
                  onClick={autoFinish}
                >
                  {autoFinishing ? (autoFinishStage || t("autoFinish")) : `⚡ ${t("autoFinish")}`}
                </Button>}
                <Link href={`/project/${id}/assets`} className="w-full">
                  <Button size="lg" className="w-full brand-gradient text-white" disabled={autoFinishing || !currentScript}>
                    {t("nextStepAssets")}
                    <LuArrowRight className="w-4 h-4 ml-1" />
                  </Button>
                </Link>
              </div>
              {SHOW_FREE_QUICK_CUT && !isPremiumCgProject && <p className="text-center text-xs text-muted-foreground">{t("autoFinishHint")}</p>}
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="outline" size="sm" className="text-xs" disabled={scriptActionsBusy} aria-busy={isGenerating} onClick={() => setRegenConfirmOpen(true)}>
                  {isGenerating && <LuLoaderCircle className="w-3.5 h-3.5 mr-1 animate-spin" />}
                  {t(isGenerating ? "regenerating" : "regenerate")}
                </Button>
                {historyButton}
                <Button variant="ghost" size="sm" className="text-xs text-muted-foreground hover:text-destructive" disabled={scriptActionsBusy || autoFinishing} onClick={() => { setDeleteTarget(currentScript); setDeleteError(""); }}>
                  <LuTrash2 className="mr-1 h-3.5 w-3.5" />{t("deleteScript")}
                </Button>
                <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => setUiMode("pro")}>
                  {t("simpleGoPro")}
                </Button>
              </div>
            </div>
          </div>
        ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* left panel: script option selection */}
          <div className="lg:col-span-1">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <h2 className="text-base font-semibold">{t("scriptOptions")}</h2>
              <div className="flex flex-wrap items-center gap-2">
                {selectionTip && (
                  <span className="text-xs text-green-400 animate-in fade-in">{t("selectionSaved")}</span>
                )}
                {savedTip && (
                  <span className="text-xs text-green-400 animate-in fade-in">{t("savedAsTemplate")}</span>
                )}
                <Button variant="outline" size="sm" className="text-xs" onClick={handleSaveAsTemplate}>
                  <LuBookmarkPlus className="w-3.5 h-3.5 mr-1" />
                  {t("saveAsTemplate")}
                </Button>
                <Button variant="outline" size="sm" disabled={scriptActionsBusy} aria-busy={isGenerating} className="text-xs" onClick={() => setRegenConfirmOpen(true)}>
                  {isGenerating ? <LuLoaderCircle className="w-3.5 h-3.5 mr-1 animate-spin" /> : <LuWand className="w-3.5 h-3.5 mr-1" />}
                  {t(isGenerating ? "regenerating" : "regenerate")}
                </Button>
                {historyButton}
              </div>
            </div>

            {selectionError && <p role="alert" className="mb-3 text-xs text-destructive">{selectionError}</p>}
            <div className="space-y-3">
              {scripts.map((script, index) => (
                <Card
                  key={script.id}
                  className={`cursor-pointer transition-all ${selectedScript === index ? "ring-2 ring-primary neon-glow" : "glass-card card-hover"}`}
                  onClick={() => persistSelection(index)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between mb-2">
                      <h3 className="font-medium text-sm">{script.title}</h3>
                      <div className="ml-2 flex shrink-0 items-center gap-1">
                        <Badge variant="secondary" className="text-xs">
                          {styleLabelKeys[script.styleType] ? t(styleLabelKeys[script.styleType]) : script.styleType}
                        </Badge>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" aria-label={`${t("deleteScript")} ${script.title}`} title={t("deleteScript")} disabled={scriptActionsBusy || autoFinishing} onClick={(event) => { event.stopPropagation(); setDeleteTarget(script); setDeleteError(""); }}>
                          <LuTrash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{t("shotCount", { n: script.shots.length })}</span>
                      <span>{script.totalDuration}s</span>
                    </div>
                    {/* shot type preview bar */}
                    <div className="mt-3 flex gap-0.5 h-1.5 rounded-full overflow-hidden">
                      {script.shots.map((shot) => {
                        const colors: Record<string, string> = {
                          hook: "bg-red-500", pain_point: "bg-orange-500",
                          product_reveal: "bg-blue-500", demo: "bg-green-500",
                          social_proof: "bg-purple-500", cta: "bg-amber-500",
                        };
                        return (
                          <div
                            key={shot.shotId}
                            className={`${colors[shot.type]} opacity-70`}
                            style={{ flex: shot.duration }}
                          />
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>

          {/* right panel: shot detail editing */}
          <div className="lg:col-span-2">
            <Tabs defaultValue="timeline" className="w-full">
              <div className="flex items-center justify-between mb-4">
                <TabsList>
                  <TabsTrigger value="timeline">{t("tabTimeline")}</TabsTrigger>
                  <TabsTrigger value="text">{t("tabText")}</TabsTrigger>
                </TabsList>
                <div className="flex items-center gap-2">
                  {!isPremiumCgProject && <Button
                      variant="outline"
                      className="text-sm"
                      disabled={scriptActionsBusy}
                      onClick={runJudge}
                      title={t("judgeHint")}
                    >
                      {judging ? (
                        <>
                          <LuLoaderCircle className="w-4 h-4 mr-1 animate-spin" />
                          {t("judging")}
                        </>
                      ) : (
                        <>⚖️ {t("judgeButton")}</>
                      )}
                    </Button>}
                  {SHOW_FREE_QUICK_CUT && !isPremiumCgProject && <Button
                    variant="outline"
                    className="text-sm"
                    disabled={autoFinishing}
                    onClick={autoFinish}
                    title={t("autoFinishHint")}
                  >
                    {autoFinishing ? (
                      <>
                        <LuLoaderCircle className="w-4 h-4 mr-1 animate-spin" />
                        {autoFinishStage || t("autoFinish")}
                      </>
                    ) : (
                      <>
                        <LuWand className="w-4 h-4 mr-1" />
                        {t("autoFinish")}
                      </>
                    )}
                  </Button>}
                  <Link href={`/project/${id}/assets`}>
                    <Button className="brand-gradient text-white text-sm" disabled={autoFinishing}>
                      {t("nextStepAssets")}
                      <LuArrowRight className="w-4 h-4 ml-1" />
                    </Button>
                  </Link>
                </div>
              </div>

              {/* judge-panel report: per-judge issues + before/after rewrites + one-click apply */}
              {judgeError && (
                <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-2.5 text-xs text-red-400">{judgeError}</div>
              )}
              {judgeReport && (
                <Card className="glass-card mb-4">
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold">⚖️ {t("judgeReportTitle")}</span>
                      <div className="flex items-center gap-2">
                        {judgeApplied ? (
                          <span className="text-xs text-green-400">{t("judgeAppliedTip")}</span>
                        ) : autoApplicableRewrites(judgeReport).length + autoApplicableDescriptionRewrites(judgeReport).length > 0 ? (
                          <Button size="sm" className="h-7 text-xs brand-gradient text-white" disabled={scriptActionsBusy} onClick={applyJudgeRewrites}>
                            {judgeApplying ? t("judgeApplying") : t("judgeApply", { n: autoApplicableRewrites(judgeReport).length + autoApplicableDescriptionRewrites(judgeReport).length })}
                          </Button>
                        ) : (
                          <span className="text-xs text-green-400">{t("judgeAllPass")}</span>
                        )}
                        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setJudgeReport(null)}>{tc("cancel")}</Button>
                      </div>
                    </div>
                    {judgeReport.summary && <p className="text-xs text-muted-foreground">{judgeReport.summary}</p>}
                    <div className="grid gap-2 sm:grid-cols-2">
                      {judgeReport.verdicts.map((v) => (
                        <div key={v.judge} className="rounded-lg border border-border/60 p-2.5">
                          <div className="text-xs font-medium mb-1">
                            {locale === "zh" ? JUDGE_META[v.judge].zh : JUDGE_META[v.judge].en}
                            {v.issues.length === 0 && <span className="ml-2 text-green-400">✓</span>}
                          </div>
                          {v.issues.length > 0 && (
                            <ul className="space-y-1 text-xs text-muted-foreground">
                              {v.issues.map((iss, i) => (
                                <li key={i}>
                                  {typeof iss.shotId === "number" && <span className="text-primary mr-1">#{iss.shotId}</span>}
                                  <span className={`mr-1 rounded px-1 text-[10px] ${iss.tier === "invariant" ? "bg-red-500/15 text-red-400" : iss.tier === "default" ? "bg-amber-500/15 text-amber-500" : "bg-muted text-muted-foreground"}`}>
                                    {t(`judgeTier_${iss.tier}`)}
                                  </span>
                                  {iss.issue}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                    </div>
                    {(judgeReport.rewrites.length > 0 || judgeReport.descriptionRewrites.length > 0) && !judgeApplied && (
                      <div className="space-y-2">
                        <div className="text-xs font-medium">{t("judgeRewrites")}</div>
                        {judgeReport.rewrites.map((rw) => {
                          const orig = currentScript?.shots.find((s) => s.shotId === rw.shotId)?.voiceover ?? "";
                          return (
                            <div key={rw.shotId} className="rounded-lg border border-border/60 p-2.5 text-xs space-y-1">
                              <div className="text-muted-foreground line-through decoration-red-400/60">#{rw.shotId} {orig}</div>
                              <div>
                                #{rw.shotId} {rw.voiceover}
                                {rw.tier === "taste" && <span className="ml-1 rounded bg-muted px-1 text-[10px] text-muted-foreground">{t("judgeTasteOnly")}</span>}
                              </div>
                            </div>
                          );
                        })}
                        {judgeReport.descriptionRewrites.map((rw) => {
                          const orig = currentScript?.shots.find((s) => s.shotId === rw.shotId)?.description ?? "";
                          return (
                            <div key={`d${rw.shotId}`} className="rounded-lg border border-border/60 p-2.5 text-xs space-y-1">
                              <div className="text-[10px] text-muted-foreground">{t("judgeDescRewrite")}</div>
                              <div className="text-muted-foreground line-through decoration-red-400/60">#{rw.shotId} {orig}</div>
                              <div>
                                #{rw.shotId} {rw.description}
                                {rw.tier === "taste" && <span className="ml-1 rounded bg-muted px-1 text-[10px] text-muted-foreground">{t("judgeTasteOnly")}</span>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {autoFinishError && (
                <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/5 px-4 py-2.5 text-xs text-red-400">
                  {autoFinishError}
                </div>
              )}
              {/* regenerate errors (e.g. missing LLM key) used to fail silently in this view —
                  render them here with a direct jump to Settings */}
              {genError && (
                <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-500/40 bg-red-500/5 px-4 py-2.5 text-xs text-red-400">
                  <span>{genError}</span>
                  <Link href="/settings?tab=llm" className="shrink-0 text-primary underline underline-offset-2 hover:text-primary/80">
                    {t("goToSettings")}
                  </Link>
                </div>
              )}
              <TabsContent value="timeline" className="mt-0">
                <div className="space-y-3">
                  {readiness && (
                    <Card
                      className={
                        readiness.overall === "ready"
                          ? "border-emerald-500/40 bg-emerald-500/5"
                          : readiness.overall === "needsWork"
                          ? "border-red-500/40 bg-red-500/5"
                          : "border-amber-500/40 bg-amber-500/5"
                      }
                    >
                      <CardContent className="p-4">
                        <div className="flex items-center gap-2 mb-2.5">
                          <span className="text-sm font-semibold">{t("readinessTitle")}</span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                              readiness.overall === "ready"
                                ? "bg-emerald-500/15 text-emerald-500"
                                : readiness.overall === "needsWork"
                                ? "bg-red-500/15 text-red-500"
                                : "bg-amber-500/15 text-amber-500"
                            }`}
                          >
                            {t(
                              readiness.overall === "ready"
                                ? "readinessReady"
                                : readiness.overall === "needsWork"
                                ? "readinessNeedsWork"
                                : "readinessRisky"
                            )}
                          </span>
                        </div>
                        <ul className="space-y-1.5">
                          {readiness.items.map((it) => (
                            <li key={it.key} className="flex items-start gap-2 text-xs">
                              {it.status === "pass" ? (
                                <LuCircleCheck className="w-3.5 h-3.5 text-emerald-500 mt-0.5 shrink-0" />
                              ) : it.status === "fail" ? (
                                <LuCircleX className="w-3.5 h-3.5 text-red-500 mt-0.5 shrink-0" />
                              ) : (
                                <LuTriangleAlert className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" />
                              )}
                              <span
                                className={
                                  it.status === "pass"
                                    ? "text-muted-foreground"
                                    : it.status === "fail"
                                    ? "text-red-400"
                                    : "text-amber-400"
                                }
                              >
                                {it.message}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </CardContent>
                    </Card>
                  )}
                  {adViolations.length > 0 && (
                    <Card className="border-amber-500/40 bg-amber-500/5">
                      <CardContent className="p-4">
                        <div className="flex items-center gap-2 mb-1">
                          <LuTriangleAlert className="w-4 h-4 text-amber-500" />
                          <span className="text-sm font-semibold">{t("adComplianceTitle", { n: adViolations.length })}</span>
                        </div>
                        <p className="text-xs text-muted-foreground mb-2.5">{t("adComplianceHint")}</p>
                        <div className="flex flex-wrap gap-1.5">
                          {adViolations.map((v) => (
                            <span
                              key={v.term}
                              title={v.suggestion}
                              className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs cursor-help"
                            >
                              「{v.term}」· {v.category}
                            </span>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}
                  {currentScript?.shots.map((shot, index) => {
                    const typeInfo = shotTypeLabels[shot.type];
                    return (
                      <Card key={shot.shotId} className="glass-card overflow-hidden">
                        <CardContent className="p-0">
                          <div className="flex">
                            {/* left-side index and type */}
                            <div className="flex flex-col items-center justify-center w-16 py-4 border-r border-border/50 shrink-0">
                              <span className="text-lg font-bold text-muted-foreground/50">{String(index + 1).padStart(2, "0")}</span>
                              <Badge className={`${typeInfo.color} border-0 text-[10px] mt-1`}>{t(typeInfo.labelKey)}</Badge>
                              <span className="text-[10px] text-muted-foreground mt-1">{shot.duration}s</span>
                            </div>
                            {/* right-side content */}
                            <div className="flex-1 p-4">
                              <div className="flex items-start justify-between gap-4">
                                <div className="flex-1">
                                  <p className="text-sm leading-relaxed mb-2">{shot.description}</p>
                                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                                    <span className="flex items-center gap-1">
                                      <LuClock className="w-3 h-3" />
                                      {shot.camera}
                                    </span>
                                    <span className="flex items-center gap-1">
                                      {shot.visualSource === "product_image" ? t("visualProductImage") : shot.visualSource === "ai_generate" ? t("visualAiGenerate") : t("visualUserUpload")}
                                    </span>
                                    {editingShotId !== shot.shotId && (
                                      <button
                                        type="button"
                                        className="flex items-center gap-1 text-primary hover:underline"
                                        disabled={scriptActionsBusy}
                                        onClick={() => startEditShot(shot)}
                                      >
                                        <LuPencil className="w-3 h-3" />
                                        {t("editShot")}
                                      </button>
                                    )}
                                  </div>
                                </div>
                                {/* visual preview: product image shots show the uploaded product photo immediately so users see a visual right away; AI shots have no image yet at this stage */}
                                <div className="w-20 h-14 bg-muted/30 rounded-md shrink-0 overflow-hidden flex items-center justify-center border border-border/30 relative">
                                  {shot.visualSource === "product_image" && projectMeta?.productImages?.[0] ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img
                                      src={projectMeta.productImages[0]}
                                      alt=""
                                      className="absolute inset-0 w-full h-full object-cover"
                                    />
                                  ) : shot.visualSource === "product_image" ? (
                                    <span className="text-[10px] text-muted-foreground">{t("productImageShort")}</span>
                                  ) : (
                                    <LuImage className="w-4 h-4 text-muted-foreground/40" />
                                  )}
                                </div>
                              </div>
                              {/* voiceover copy — inline editable */}
                              {editingShotId === shot.shotId ? (
                                <div className="mt-3 space-y-2 rounded-md border border-primary/30 bg-primary/5 p-2.5">
                                  <div>
                                    <label className="text-[10px] text-muted-foreground">{t("editVoiceoverLabel")}</label>
                                    <Textarea
                                      className="mt-1 min-h-[64px] bg-background/50 text-xs leading-relaxed"
                                      value={editDraft.voiceover}
                                      onChange={(e) => setEditDraft((d) => ({ ...d, voiceover: e.target.value }))}
                                    />
                                  </div>
                                  <div>
                                    <label className="text-[10px] text-muted-foreground">{t("editDescriptionLabel")}</label>
                                    <Textarea
                                      className="mt-1 min-h-[48px] bg-background/50 text-xs leading-relaxed"
                                      value={editDraft.description}
                                      onChange={(e) => setEditDraft((d) => ({ ...d, description: e.target.value }))}
                                    />
                                  </div>
                                  <div className="flex items-center justify-end gap-2">
                                    {editStatus === "failed" && <span className="text-[10px] text-red-400 mr-auto">{t("editSaveFailed")}</span>}
                                    <Button variant="outline" size="sm" className="h-7 text-xs" disabled={editStatus === "saving"} onClick={cancelEditShot}>{tc("cancel")}</Button>
                                    <Button size="sm" className="h-7 text-xs brand-gradient text-white" disabled={scriptActionsBusy} onClick={() => saveEditShot(shot.shotId)}>{tc("save")}</Button>
                                  </div>
                                </div>
                              ) : (
                                shot.voiceover && (
                                  <div className="mt-3 p-2.5 bg-muted/30 rounded-md">
                                    <p className="text-xs text-muted-foreground leading-relaxed">
                                      🎙 {shot.voiceover}
                                    </p>
                                  </div>
                                )
                              )}
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </TabsContent>

              <TabsContent value="text" className="mt-0">
                <Card className="glass-card">
                  <CardContent className="p-6 space-y-4">
                    <h3 className="font-medium text-sm mb-2">{t("fullVoiceover")}</h3>
                    {/* read-only preview: per-shot editing happens in the timeline tab (avoids the old
                        silent-discard where typing here was never saved) */}
                    <Textarea
                      readOnly
                      className="min-h-[300px] bg-background/50 text-sm leading-relaxed cursor-default"
                      value={currentScript?.shots.map((s) => s.voiceover).filter(Boolean).join("\n\n") ?? ""}
                    />
                    <p className="text-[11px] text-muted-foreground">{t("textReadOnlyHint")}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("statsChars", { n: currentScript?.shots.reduce((sum, s) => sum + (s.voiceover?.length || 0), 0) ?? 0 })} ·
                      {t("statsDuration", { n: currentScript?.totalDuration ?? 0 })} ·
                      {t("statsSpeed", { n: Math.round((currentScript?.shots.reduce((sum, s) => sum + (s.voiceover?.length || 0), 0) || 0) / (currentScript?.totalDuration || 1) * 10) / 10 })}
                    </p>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </div>
        </div>
        )}
      </main>

      {historyDialog}

      {/* save template dialog */}
      {showSaveDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <Card className="glass-card w-full max-w-md mx-4">
            <CardContent className="p-6 space-y-4">
              <h3 className="text-base font-semibold">{t("saveTemplateTitle")}</h3>
              <p className="text-xs text-muted-foreground">{t("saveTemplateDesc")}</p>
              <Input
                placeholder={t("templateNamePlaceholder")}
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
              />
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowSaveDialog(false)}>{tc("cancel")}</Button>
                <Button size="sm" className="brand-gradient text-white" onClick={doSaveTemplate} disabled={!templateName.trim()}>{tc("save")}</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" role="alertdialog" aria-modal="true" aria-labelledby="delete-script-title" aria-describedby="delete-script-description">
          <Card className="glass-card mx-4 w-full max-w-md">
            <CardContent className="space-y-4 p-6">
              <h3 id="delete-script-title" className="flex items-center gap-2 text-base font-semibold"><LuTrash2 className="h-4 w-4 text-destructive" />{t("deleteConfirmTitle")}</h3>
              <p className="break-words text-sm font-medium">{deleteTarget.title}</p>
              <p id="delete-script-description" className="text-xs leading-relaxed text-muted-foreground">{t("deleteConfirmDesc")}</p>
              {deleteError && <p role="alert" className="text-xs text-destructive">{deleteError}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" disabled={isDeleting} onClick={() => setDeleteTarget(null)}>{tc("cancel")}</Button>
                <Button variant="destructive" size="sm" disabled={isDeleting} aria-busy={isDeleting} onClick={() => void confirmDelete()}>
                  {isDeleting && <LuLoaderCircle className="mr-1 h-3.5 w-3.5 animate-spin" />}{t(isDeleting ? "deletingScript" : "deleteConfirmOk")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Confirm before switching to a newly generated batch. */}
      {regenConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <Card className="glass-card w-full max-w-md mx-4">
            <CardContent className="p-6 space-y-4">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <LuTriangleAlert className="w-4 h-4 text-amber-400 shrink-0" />
                {t("regenConfirmTitle")}
              </h3>
              <p className="text-xs text-muted-foreground leading-relaxed">{t("regenConfirmDesc")}</p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setRegenConfirmOpen(false)}>{t("regenConfirmCancel")}</Button>
                <Button
                  size="sm"
                  className="brand-gradient text-white"
                  onClick={() => {
                    setRegenConfirmOpen(false);
                    handleGenerate();
                  }}
                >
                  {t("regenConfirmOk")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
