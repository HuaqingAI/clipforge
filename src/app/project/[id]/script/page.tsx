"use client";

import { useState, useEffect, useRef } from "react";
import { useParams } from "next/navigation";
import { useGenerationRuns, generationRunActive } from "@/lib/hooks/use-generation-runs";
import { GenerationRunsPanel } from "@/components/generation-runs-panel";
import { LuWand, LuClock, LuImage, LuArrowRight, LuLoaderCircle, LuTriangleAlert, LuPencil, LuTrash2, LuHistory } from "react-icons/lu";
import Link from "next/link";
import Image from "next/image";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { Shot } from "@/lib/db/schema";
import { JUDGE_META, type JudgeReport } from "@/lib/script-judge";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { useT, useLocale } from "@/lib/i18n";
import { friendlyError } from "@/lib/friendly-error";
import { abortable, currentScriptOptions, generateProjectScripts, type SavedScript as DbScript } from "@/lib/script-generation-client";
import { ProjectHeader } from "@/components/project-header";
import { ScriptHistoryDialog } from "@/components/script-history-dialog";
import { TideweCopyEditor } from "@/components/tidewe-copy-editor";
import { TideweCopyInput, type TideweCopySource } from "@/components/tidewe-copy-input";
import { TideweProjectSettings } from "@/components/tidewe-project-settings";
import { normalizeProductFacts } from "@/lib/tidewe/facts";
import { tideweCopyInputError } from "@/lib/tidewe/copy-input";
import type { ProductFacts, TideweCopyDocument } from "@/lib/tidewe/types";
import {
  resolveCreativeProfile,
  sanitizeCreativeProfileDrafts,
  type ProjectCreativeProfile,
  type ArchivedCreativeProfile,
  type ProjectCreativeProfileDrafts,
  type CreativeProfileSnapshot,
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
  tidewe_outdoor: "styleTidewe",
};

interface ProjectMeta {
  productName: string;
  category: string;
  description: string;
  productImages: string[];
  videoMode: string;
  creativeProfile: ProjectCreativeProfile | ArchivedCreativeProfile;
  creativeProfileDrafts: ProjectCreativeProfileDrafts;
  creativeConfigRevision: number;
  productFacts?: ProductFacts;
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
    ...parsedDrafts,
  };
  if (creativeProfile.creationType === "tidewe_outdoor") {
    creativeProfileDrafts.tidewe_outdoor = creativeProfile;
  }
  return {
    productName: typeof project.productName === "string" ? project.productName : "",
    category: typeof project.productCategory === "string" ? project.productCategory : "",
    description: typeof project.productDescription === "string" ? project.productDescription : "",
    productFacts: normalizeProductFacts(parseJsonRecord(project.productFacts)),
    productImages: Array.isArray(project.productImages) ? project.productImages.filter((image): image is string => typeof image === "string") : [],
    videoMode: creativeProfile.videoMode,
    creativeProfile,
    creativeProfileDrafts,
    creativeConfigRevision: typeof project.creativeConfigRevision === "number" && Number.isSafeInteger(project.creativeConfigRevision)
      ? project.creativeConfigRevision
      : 0,
  };
}

export default function ScriptPage() {
  const t = useT("script");
  const tt = useT("tidewe");
  const tc = useT("common");
  const locale = useLocale();
  const { id } = useParams<{ id: string }>();
  const { runs: generationRuns, loading: generationRunsLoading, error: generationRunsError } = useGenerationRuns(id);
  const scriptRuns = generationRuns.filter((run) => run.items.some((item) => item.kind === "script"));
  const scriptRunActive = scriptRuns.some(generationRunActive);
  const scriptRunBlocked = scriptRunActive || scriptRuns.some((run) => run.status === "needs_attention");
  const completedScriptRuns = scriptRuns.filter((run) => run.status === "completed").map((run) => run.id).sort().join(",");
  const [selectedScript, setSelectedScript] = useState(0);
  const [scripts, setScripts] = useState<
    { id: string; title: string; styleType: string; totalDuration: number; shots: Shot[]; copyDocument?: TideweCopyDocument | null; scriptHash?: string; creativeProfileSnapshot?: CreativeProfileSnapshot | null }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [projectName, setProjectName] = useState("");
  // project metadata: reused when re-generating the script from the empty state
  const [projectMeta, setProjectMeta] = useState<ProjectMeta | null>(null);
  const [creativeConfigSaving, setCreativeConfigSaving] = useState(false);
  const [localGenerating, setIsGenerating] = useState(false);
  const isGenerating = localGenerating || scriptRunActive;
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
  const [tideweCopySource, setTideweCopySource] = useState<TideweCopySource>("ai");
  const [tideweCopyText, setTideweCopyText] = useState("");
  const [tideweSceneDescription, setTideweSceneDescription] = useState("");
  const tideweCopyDraftTouched = useRef(false);
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
  const judgeAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    setIsGenerating(false);
    setIsDeleting(false);
    setIsSelecting(false);
    setSelectionError("");
    setHistoryOpen(false);
    setDeleteTarget(null);
    setDeleteError("");
    setJudging(false);
    setJudgeApplying(false);
    setTideweCopySource("ai");
    setTideweCopyText("");
    setTideweSceneDescription("");
    tideweCopyDraftTouched.current = false;
    return () => {
      generationAbort.current?.abort();
      generationAbort.current = null;
      generationInFlight.current = false;
      deletionAbort.current?.abort();
      deletionAbort.current = null;
      selectionAbort.current?.abort();
      selectionAbort.current = null;
      judgeAbort.current?.abort();
      judgeAbort.current = null;
    };
  }, [id]);

  // TIDEWE uses the same durable generation flow for AI and supplied English copy.
  const handleGenerate = async () => {
    if (!projectMeta || projectMeta.creativeProfile.creationType !== "tidewe_outdoor" || generationRunsLoading || generationRunsError || scriptRunBlocked || creativeConfigSaving || generationInFlight.current || deletionAbort.current || selectionAbort.current || judgeAbort.current || judging || judgeApplying || editStatus === "saving") return;
    const manualTideweCopy = projectMeta.creativeProfile.creationType === "tidewe_outdoor" && tideweCopySource === "manual";
    const copyError = manualTideweCopy ? tideweCopyInputError(tideweCopyText) : undefined;
    if (copyError) {
      setGenError(tt(copyError));
      return;
    }
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
      const payload = {
            projectId: id,
            ...(projectMeta.creativeProfile.creationType === "tidewe_outdoor" && { requestId: crypto.randomUUID(), expectedCreativeConfigRevision: projectMeta.creativeConfigRevision, count: 1, ...(scripts[selectedScript]?.scriptHash && { sourceScriptId: scripts[selectedScript].id, expectedScriptHash: scripts[selectedScript].scriptHash }) }),
            ...(manualTideweCopy && { copyText: tideweCopyText }),
            ...(projectMeta.creativeProfile.creationType === "tidewe_outdoor" && !manualTideweCopy && tideweSceneDescription.trim() && { sceneDescription: tideweSceneDescription.trim() }),
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
        endpoint: "/api/llm/script", payload, projectId: id, knownScriptIds: scripts.map((script) => script.id),
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
          copyDocument: script.copyDocument,
          scriptHash: script.scriptHash,
          creativeProfileSnapshot: script.creativeProfileSnapshot,
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
    if (!deleteTarget || deletionAbort.current || generationInFlight.current || selectionAbort.current || judgeAbort.current || judging || judgeApplying || editStatus === "saving") return;
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
        copyDocument: script.copyDocument,
        scriptHash: script.scriptHash,
        creativeProfileSnapshot: script.creativeProfileSnapshot,
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
              copyDocument: s.copyDocument,
              scriptHash: s.scriptHash,
              creativeProfileSnapshot: s.creativeProfileSnapshot,
            }))
          );
          // default to the script marked as selected
          const selIdx = dbScripts.findIndex((s) => s.selected);
          setSelectedScript(selIdx >= 0 ? selIdx : 0);
          const selected = dbScripts[selIdx >= 0 ? selIdx : 0];
          if (!tideweCopyDraftTouched.current && selected.styleType === "tidewe_outdoor" && selected.copyDocument?.source === "user_provided") {
            setTideweCopySource("manual");
            setTideweCopyText(selected.copyDocument.text);
          }
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
  }, [id, completedScriptRuns]);

  const currentScript = scripts[selectedScript];

  const isTideweProject = projectMeta?.creativeProfile.creationType === "tidewe_outdoor";
  // Confirm before replacing the current alternatives; saved revisions remain in project history.
  const [regenConfirmOpen, setRegenConfirmOpen] = useState(false);

  // ---- selection persistence: switching the active variant must be written to the DB, otherwise
  // downstream steps (assets/video/export) read `selected` from the DB and use a different script ----
  const [selectionTip, setSelectionTip] = useState(false);
  const persistSelection = async (index: number) => {
    if (generationInFlight.current || deletionAbort.current || selectionAbort.current || judgeAbort.current || judging || judgeApplying || editStatus === "saving") return;
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
      const response = await abortable(fetch(`/api/project/${id}/scripts`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedScriptId: target.id }),
        signal: controller.signal,
      }), controller.signal);
      if (!response.ok) {
        const data: unknown = await abortable(response.json().catch(() => null), controller.signal);
        const errorKey = isRecord(data) && data.code === "CREATIVE_PROFILE_MISMATCH"
          ? "selectionTypeMismatch"
          : null;
        const message = isRecord(data) && typeof data.error === "string" && data.error.trim()
          ? data.error
          : t("selectionFailed");
        throw new Error(errorKey ? t(errorKey) : message);
      }
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
    if (generationInFlight.current || deletionAbort.current || selectionAbort.current || judgeAbort.current || judging || judgeApplying || editStatus === "saving" || creativeConfigSaving) {
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
        copyDocument: script.copyDocument,
        scriptHash: script.scriptHash,
        creativeProfileSnapshot: script.creativeProfileSnapshot,
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
    if (generationInFlight.current || deletionAbort.current || selectionAbort.current || judgeAbort.current || judging || judgeApplying || editStatus === "saving") return;
    setEditingShotId(shot.shotId);
    setEditDraft({ voiceover: shot.voiceover ?? "", description: shot.description ?? "" });
    setEditStatus("");
  };
  const cancelEditShot = () => {
    if (editStatus === "saving") return;
    setEditingShotId(null);
    setEditStatus("");
  };
  // Reports and open edits belong to a script ID; regeneration may retain the same list index.
  useEffect(() => {
    setJudgeReport(null);
    setJudgeError("");
    setJudgeApplied(false);
    setEditingShotId(null);
    setEditStatus("");
  }, [currentScript?.id]);

  // Review and apply operations share a synchronous guard so repeated clicks cannot overlap.
  const runJudge = async () => {
    if (!currentScript || generationInFlight.current || deletionAbort.current || selectionAbort.current || judgeAbort.current || judging || judgeApplying || creativeConfigSaving || editStatus === "saving") return;
    const controller = new AbortController();
    judgeAbort.current = controller;
    setJudging(true);
    setJudgeError("");
    setJudgeReport(null);
    setJudgeApplied(false);
    try {
      const res = await fetch(`/api/project/${id}/script-judge`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scriptId: currentScript.id,
          llmConfig: { baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model },
        }),
      });
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (!res.ok) throw new Error(data.error || t("judgeFailed"));
      setJudgeReport(data as JudgeReport);
    } catch (e) {
      if (!controller.signal.aborted) setJudgeError(e instanceof Error ? e.message : t("judgeFailed"));
    } finally {
      if (judgeAbort.current === controller) {
        judgeAbort.current = null;
        setJudging(false);
      }
    }
  };

  const applyJudgeAdvice = async () => {
    if (!currentScript || !judgeReport || judgeApplied || generationInFlight.current || deletionAbort.current || selectionAbort.current || judgeAbort.current || judging || judgeApplying || creativeConfigSaving || editStatus === "saving") return;
    if (!judgeReport.verdicts.some((verdict) => verdict.issues.some((issue) => issue.tier === "invariant" || issue.tier === "default"))) return;
    if (!judgeReport.sourceScriptHash || (currentScript.scriptHash && currentScript.scriptHash !== judgeReport.sourceScriptHash)) {
      setJudgeError(t("judgeReportStale"));
      return;
    }
    const controller = new AbortController();
    judgeAbort.current = controller;
    setJudgeApplying(true);
    setJudgeError("");
    try {
      const res = await fetch(`/api/project/${id}/script-judge/apply`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scriptId: currentScript.id,
          expectedScriptHash: judgeReport.sourceScriptHash,
          report: judgeReport,
          llmConfig: { baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model },
        }),
      });
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (!res.ok) throw new Error(data.error || t("judgeApplyFailed"));
      if (data.script?.id !== currentScript.id || !data.script.scriptHash || !Array.isArray(data.script.shots) || (isTideweProject && !data.script.copyDocument)) throw new Error(t("judgeApplyFailed"));
      setScripts((previous) => previous.map((row) => row.id === currentScript.id ? { ...row, ...data.script } : row));
      setEditingShotId(null);
      setEditStatus("");
      setJudgeApplied(true);
    } catch (cause) {
      if (!controller.signal.aborted) setJudgeError(cause instanceof Error ? cause.message : t("judgeApplyFailed"));
    } finally {
      if (judgeAbort.current === controller) {
        judgeAbort.current = null;
        setJudgeApplying(false);
      }
    }
  };

  const saveEditShot = async (shotId: number) => {
    if (!currentScript || generationInFlight.current || deletionAbort.current || selectionAbort.current || judgeAbort.current || judging || judgeApplying || editStatus === "saving") return;
    setEditStatus("saving");
    // optimistic local update so the timeline reflects the edit immediately
    setScripts((prev) =>
      prev.map((s) =>
        s.id === currentScript.id
          ? { ...s, shots: s.shots.map((sh) => (sh.shotId === shotId ? { ...sh, ...(!isTideweProject && { voiceover: editDraft.voiceover.trim() }), description: editDraft.description.trim() } : sh)) }
          : s
      )
    );
    try {
      const res = await fetch(`/api/project/${id}/scripts`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scriptId: currentScript.id, ...(isTideweProject ? { expectedScriptHash: currentScript.scriptHash, expectedCreativeConfigRevision: projectMeta?.creativeConfigRevision, shotTexts: [{ shotId, description: editDraft.description }] } : { shotTexts: [{ shotId, voiceover: editDraft.voiceover, description: editDraft.description }] }) }),
      });
      if (!res.ok) throw new Error("save failed");
      const data = await res.json();
      if (isTideweProject && !data.script?.scriptHash) throw new Error(tt("missingHash"));
      if (data.script) {
        setScripts((previous) => previous.map((row) => row.id === currentScript.id ? { ...row, ...data.script } : row));
      }
      setEditStatus("saved");
      setEditingShotId(null);
      setTimeout(() => setEditStatus(""), 1500);
    } catch {
      if (isTideweProject) setScripts((previous) => previous.map((row) => row.id === currentScript.id ? currentScript : row));
      setEditStatus("failed");
    }
  };

  // slim context strip (shared by loading, empty and normal states); global chrome lives in AppShell
  const saveTideweCopy = async (copyText: string) => {
    if (generationRunsLoading || generationRunsError || scriptRunBlocked) return;
    if (!currentScript?.scriptHash || !projectMeta) throw new Error(tt("missingHash"));
    if (!llm.apiKey) throw new Error(tt("missingLlm"));
    if (generationInFlight.current || deletionAbort.current || selectionAbort.current || judgeAbort.current || judging || judgeApplying || creativeConfigSaving || editStatus === "saving") return;
    generationInFlight.current = true;
    const controller = new AbortController(); generationAbort.current = controller;
    setEditStatus("saving");
    try {
      const rows = await generateProjectScripts({
        endpoint: `/api/project/${id}/scripts`, method: "PATCH", projectId: id,
        knownScriptIds: scripts.map((row) => row.id), signal: controller.signal,
        messages: { failed: tt("saveFailed"), reload: t("errorReloadScripts"), unconfirmed: t("errorGenerationUnconfirmed") },
        payload: { scriptId: currentScript.id, expectedScriptHash: currentScript.scriptHash,
          expectedCreativeConfigRevision: projectMeta.creativeConfigRevision, requestId: crypto.randomUUID(), copyText,
          llmConfig: { provider: llm.provider, baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model, visionModel: llm.visionModel } },
      });
      const options = currentScriptOptions(rows);
      if (!options.length) throw new Error(t("errorReloadScripts"));
      setScripts(options.map((row) => ({ id: row.id, title: row.title ?? t("untitledScript"), styleType: row.styleType, totalDuration: row.totalDuration ?? 0, shots: row.shots ?? [], copyDocument: row.copyDocument, scriptHash: row.scriptHash, creativeProfileSnapshot: row.creativeProfileSnapshot })));
      setSelectedScript(Math.max(0, options.findIndex((row) => row.selected)));
      tideweCopyDraftTouched.current = true;
      setTideweCopySource("manual");
      setTideweCopyText(copyText);
      setEditStatus("saved");
    } catch (cause) { setEditStatus("failed"); throw cause; }
    finally { if (generationAbort.current === controller) { generationAbort.current = null; generationInFlight.current = false; } }
  };

  const scriptActionsBusy = generationRunsLoading || Boolean(generationRunsError) || scriptRunBlocked || isGenerating || isDeleting || isSelecting || judging || judgeApplying || editStatus === "saving";
  const judgeHasActionableAdvice = judgeReport?.verdicts.some((verdict) => verdict.issues.some((issue) => issue.tier === "invariant" || issue.tier === "default")) ?? false;
  const judgeHasSuggestions = judgeReport ? judgeReport.verdicts.some((verdict) => verdict.issues.length > 0) || judgeReport.rewrites.length > 0 || judgeReport.descriptionRewrites.length > 0 : false;
  const manualTideweCopy = isTideweProject && tideweCopySource === "manual";
  const generationDisabled = !isTideweProject || scriptActionsBusy || creativeConfigSaving || Boolean(manualTideweCopy && tideweCopyInputError(tideweCopyText));
  const tideweGenerationInput = isTideweProject ? (
    <Card className="glass-card mb-5 w-full text-left">
      <CardContent className="space-y-4 p-5">
        <TideweCopyInput id="tidewe-custom-copy-text" source={tideweCopySource} text={tideweCopyText} sceneDescription={tideweSceneDescription} onSourceChange={(source) => { tideweCopyDraftTouched.current = true; setTideweCopySource(source); }} onTextChange={(text) => { tideweCopyDraftTouched.current = true; setTideweCopyText(text); }} onSceneDescriptionChange={(description) => { tideweCopyDraftTouched.current = true; setTideweSceneDescription(description); }} disabled={scriptActionsBusy || creativeConfigSaving} />
        {scripts.length > 0 && <div className="flex justify-end">
          <Button variant="outline" size="sm" disabled={generationDisabled} aria-busy={isGenerating} onClick={() => setRegenConfirmOpen(true)}>
            {isGenerating ? <LuLoaderCircle className="mr-1 h-3.5 w-3.5 animate-spin" /> : <LuWand className="mr-1 h-3.5 w-3.5" />}
            {manualTideweCopy ? tt(isGenerating ? "copyInputGenerating" : "copyInputGenerate") : t(isGenerating ? "regenerating" : "regenerate")}
          </Button>
        </div>}
      </CardContent>
    </Card>
  ) : null;
  const historyButton = (
    <Button variant="outline" size="sm" className="text-xs" disabled={scriptActionsBusy || creativeConfigSaving} onClick={() => setHistoryOpen(true)}>
      <LuHistory className="mr-1 h-3.5 w-3.5" />{t("historyButton")}
    </Button>
  );
  const historyDialog = historyOpen ? (
    <ScriptHistoryDialog key={id} projectId={id} busy={scriptActionsBusy || creativeConfigSaving} onClose={() => setHistoryOpen(false)} onRestore={restoreHistoricalScript} />
  ) : null;
  const headerBar = <>
    <ProjectHeader projectName={projectName || t("defaultProjectName")} />
    <div className="mx-auto max-w-6xl px-6 pt-4"><GenerationRunsPanel projectId={id} /></div>
  </>;
  const creativeProfileSummary = projectMeta ? (
    <Card className="glass-card mb-5">
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">{t("creativeTypeTitle")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("creativeTypeDesc")}</p>
          </div>
          <Badge variant="outline" className="h-auto rounded-lg border-primary/50 bg-primary/10 px-3 py-2 text-primary">
            {t(isTideweProject ? "styleTidewe" : "archivedCreativeType")}
          </Badge>
        </div>

        {projectMeta.creativeProfile.creationType === "tidewe_outdoor" && <TideweProjectSettings
          key={`${id}-${projectMeta.creativeConfigRevision}`}
          projectId={id} revision={projectMeta.creativeConfigRevision} facts={projectMeta.productFacts}
          profile={projectMeta.creativeProfile} drafts={projectMeta.creativeProfileDrafts}
          disabled={scriptActionsBusy || creativeConfigSaving}
          onBusyChange={setCreativeConfigSaving} onSaved={(project) => setProjectMeta(projectMetaFromResponse(project))}
        />}
        {isTideweProject && projectMeta.productImages.length > 0 && (
          <section aria-label={t("productReferencesTitle")} className="mt-4 border-t border-border/50 pt-4">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium">{t("productReferencesTitle")}</span>
              <span className="text-muted-foreground">{t("productReferencesCount", { n: projectMeta.productImages.length })}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {projectMeta.productImages.map((url, index) => (
                <a
                  key={`${url}-${index}`}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={t("viewProductReference", { n: index + 1 })}
                  className="relative h-20 w-20 shrink-0 overflow-hidden rounded-md border border-border/50 bg-muted/30 hover:border-primary/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  <Image src={url} alt={t("productReferenceAlt", { n: index + 1 })} fill unoptimized sizes="80px" className="object-contain" />
                </a>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{t("productReferencesHint")}</p>
          </section>
        )}
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

  if (projectMeta && !isTideweProject) {
    return (
      <div className="min-h-screen grid-bg">
        {headerBar}
        <main className="mx-auto max-w-3xl space-y-5 px-6 py-8">
          <p className="text-sm text-muted-foreground">{t("archivedProjectDescription")}</p>
          <Link href="/project/new"><Button>{t("createTideweProject")}</Button></Link>
          {scripts.map((script) => (
            <Card key={script.id} className="glass-card">
              <CardContent className="space-y-3 p-5">
                <h2 className="text-sm font-semibold">{script.title}</h2>
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                  {script.copyDocument?.text ?? script.shots.map((shot) => shot.voiceover).filter(Boolean).join("\n\n")}
                </p>
              </CardContent>
            </Card>
          ))}
        </main>
      </div>
    );
  }

  // Projects with no saved script can generate using either TIDEWE copy source.
  if (scripts.length === 0) {
    return (
      <div className="min-h-screen grid-bg">
        {headerBar}
        <div className={`mx-auto ${isTideweProject ? "max-w-3xl" : "max-w-md"} flex flex-col items-center justify-center py-28 px-6 text-center`}>
          <div className="w-full text-left">{creativeProfileSummary}</div>
          {tideweGenerationInput}
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
            <Button onClick={handleGenerate} disabled={generationDisabled} aria-busy={isGenerating} className="brand-gradient text-white">
              {isGenerating ? (
                <>
                  <LuLoaderCircle className="w-4 h-4 mr-2 animate-spin" />
                  {manualTideweCopy ? tt("copyInputGenerating") : tc("generating")}
                </>
              ) : (
                <>
                  <LuWand className="w-4 h-4 mr-2" />
                  {manualTideweCopy ? tt("copyInputGenerate") : t("generateScript")}
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


  return (
    <div className="min-h-screen grid-bg">
      {headerBar}
      <main className="mx-auto max-w-7xl px-6 py-8">
        {creativeProfileSummary}
        {tideweGenerationInput}
        {isTideweProject && currentScript?.copyDocument && <TideweCopyEditor key={`${currentScript.id}:${currentScript.scriptHash}`} document={currentScript.copyDocument} busy={scriptActionsBusy || creativeConfigSaving} onSave={saveTideweCopy} />}
        {/* breakpoint choice: a failed/interrupted server-side run offers resume (default) or a
            clean restart — the beginner never loses a half-finished chain to a closed tab again */}

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

              </CardContent>
            </Card>

            {genError && (
              <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-500/40 bg-red-500/5 px-4 py-2.5 text-xs text-red-400">
                <span>{genError}</span>
                <Link href="/settings?tab=llm" className="shrink-0 text-primary underline underline-offset-2 hover:text-primary/80">
                  {t("goToSettings")}
                </Link>
              </div>
            )}
            <div className="flex flex-col items-center gap-3">
              <div className="grid w-full gap-2">

                <Link href={`/project/${id}/assets`} className="w-full">
                  <Button size="lg" className="w-full brand-gradient text-white" disabled={!currentScript}>
                    {t("nextStepAssets")}
                    <LuArrowRight className="w-4 h-4 ml-1" />
                  </Button>
                </Link>
              </div>

              <div className="flex flex-wrap items-center gap-3">

                {historyButton}
                <Button variant="ghost" size="sm" className="text-xs text-muted-foreground hover:text-destructive" disabled={scriptActionsBusy} onClick={() => { setDeleteTarget(currentScript); setDeleteError(""); }}>
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
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" aria-label={`${t("deleteScript")} ${script.title}`} title={t("deleteScript")} disabled={scriptActionsBusy} onClick={(event) => { event.stopPropagation(); setDeleteTarget(script); setDeleteError(""); }}>
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
                  <Button
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
                    </Button>

                  <Link href={`/project/${id}/assets`}>
                    <Button className="brand-gradient text-white text-sm">
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
                        ) : judgeHasActionableAdvice ? (
                          <Button size="sm" className="h-7 text-xs brand-gradient text-white" disabled={scriptActionsBusy || creativeConfigSaving} onClick={applyJudgeAdvice}>
                            {judgeApplying ? t("judgeAdviceApplying") : t("judgeApplyAdvice")}
                          </Button>
                        ) : judgeHasSuggestions ? (
                          <span className="text-xs text-muted-foreground">{t("judgeTasteOnly")}</span>
                        ) : (
                          <span className="text-xs text-green-400">{t("judgeAllPass")}</span>
                        )}
                        <Button variant="outline" size="sm" className="h-7 text-xs" disabled={scriptActionsBusy} onClick={() => setJudgeReport(null)}>{tc("cancel")}</Button>
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
                                    <label className="text-[10px] text-muted-foreground">{isTideweProject ? tt("shotCopyHint") : t("editVoiceoverLabel")}</label>
                                    <Textarea
                                      lang={isTideweProject ? "en-US" : undefined}
                                      className="mt-1 min-h-[64px] bg-background/50 text-xs leading-relaxed"
                                      readOnly={isTideweProject}
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
                                    <p lang={isTideweProject ? "en-US" : undefined} className="text-xs text-muted-foreground leading-relaxed">
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
                      lang={isTideweProject ? "en-US" : undefined}
                      className="min-h-[300px] bg-background/50 text-sm leading-relaxed cursor-default"
                      value={currentScript?.copyDocument?.text ?? currentScript?.shots.map((s) => s.voiceover).filter(Boolean).join("\n\n") ?? ""}
                    />
                    <p className="text-[11px] text-muted-foreground">{isTideweProject ? tt("shotCopyHint") : t("textReadOnlyHint")}</p>
                    <p className="text-xs text-muted-foreground">
                      {isTideweProject ? tt("wordCount", { n: currentScript?.copyDocument?.wordCount ?? 0 }) : t("statsChars", { n: currentScript?.shots.reduce((sum, s) => sum + (s.voiceover?.length || 0), 0) ?? 0 })} ·
                      {t("statsDuration", { n: currentScript?.totalDuration ?? 0 })}

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
                  disabled={generationDisabled}
                  onClick={() => {
                    setRegenConfirmOpen(false);
                    handleGenerate();
                  }}
                >
                  {manualTideweCopy ? tt("copyInputGenerate") : t("regenConfirmOk")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
