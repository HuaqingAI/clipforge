"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { klingErrorMessage, klingFetch } from "@/lib/kling/client";
import type { KlingFilmOutputSettings, KlingFilmStartRequest, KlingFilmView } from "@/lib/kling/film-types";
import type { KlingPublicStatus } from "@/lib/kling/types";
import { buildImageOptions, resolveDefaultModelTarget, toEditVariant } from "@/lib/gen-params";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { useCharacterStore, type Character } from "@/lib/stores/project-store";
import { characterSheetRequest, hasCharacterSheetInput, hasSameCharacterSheetInput } from "@/lib/character-reference";
import { DEFAULT_FREE_VOICE, FREE_TTS_VOICES } from "@/lib/tts-voices";
import { videoParameterLabel, videoParameterDescription, videoParameterValueLabel } from "@/lib/video-parameter-copy";
import { KLING_MAX_CONCURRENT_SHOTS } from "@/lib/kling/concurrency";
import { KLING_AUDIO_PARAMETER_NAMES, klingModelOptions } from "@/lib/kling/model-options";
import type { VideoPromptSettings } from "@/lib/shot-video-prompt";
import { TASK_FEED_REFRESH_EVENT } from "@/lib/task-feed";
import { isTideweOutdoorProfile, isTideweNativeSpeech } from "@/lib/creative-profiles";
import { resolveNarrationVoice } from "@/lib/narration-voice";
import { useT } from "@/lib/i18n";

const filmStatus: Record<KlingFilmView["status"], string> = {
  draft: "待确认", running: "镜头生成中", paused: "已暂停", needs_attention: "需要恢复", composing: "本地合成中", completed: "已完成", cancelled: "已取消",
};
const shotStatus = { waiting: "等待", generating: "生成 / 入库中", ready: "已就绪", needs_attention: "需要恢复" };
const orchestratedParameters = new Set(["duration", "duration_seconds", "durationSeconds", "duration_sec", ...KLING_AUDIO_PARAMETER_NAMES, "aspect_ratio", "aspectRatio", "ratio"]);
const audioStrategySummary: Record<KlingFilmOutputSettings["audioStrategy"], string> = {
  "edge-tts": "Edge 配音替换原声音",
  "edge-tts-mix": "Edge 配音叠加原声音",
  native: "仅保留镜头原声音",
};

async function responseData(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new Error(klingErrorMessage(data, "整片操作失败"));
  return data;
}

function matchesCurrentPromptSettings(saved?: VideoPromptSettings) {
  const current = useSettingsStore.getState();
  return Boolean(saved && saved.visualLook === current.visualLook && saved.motionIntensity === current.motionIntensity && saved.motionRealism === current.motionRealism);
}

export function KlingFilmPanel({ open, onOpenChange, projectId, scriptId, profileId, defaultModel, presenterId, initialRunId, onAssetsChanged, onOpenJob, creativeProfile }: {
  open: boolean; onOpenChange(open: boolean): void; projectId: string; scriptId: string; profileId?: string; defaultModel?: string;
  presenterId?: string; initialRunId?: string; onAssetsChanged(): Promise<void> | void; onOpenJob(jobId: string): void;
  creativeProfile?: unknown;
}) {
  const tt = useT("tidewe");
  const [status, setStatus] = useState<KlingPublicStatus | null>(null);
  const [selectionKey, setSelectionKey] = useState("");
  const [options, setOptions] = useState<Record<string, string | number | boolean>>({});
  const [parameterWarnings, setParameterWarnings] = useState<string[]>([]);
  const defaultGenerationResolution = useSettingsStore((settings) => settings.videoParams.resolution);
  const visualLook = useSettingsStore((settings) => settings.visualLook);
  const motionIntensity = useSettingsStore((settings) => settings.motionIntensity);
  const motionRealism = useSettingsStore((settings) => settings.motionRealism);
  const [output, setOutput] = useState<KlingFilmOutputSettings>({ resolution: "720p", aspectRatio: "9:16", audioStrategy: "edge-tts", voice: DEFAULT_FREE_VOICE, subtitles: true });
  const tidewe = isTideweOutdoorProfile(creativeProfile);
  const tideweNativeSpeech = isTideweNativeSpeech(creativeProfile);
  const [reuseVideos, setReuseVideos] = useState(true);
  const [runs, setRuns] = useState<KlingFilmView[]>([]);
  const [view, setView] = useState<KlingFilmView | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [imageConfirmed, setImageConfirmed] = useState(false);
  const [actionConfirmed, setActionConfirmed] = useState(false);
  const [retryShotId, setRetryShotId] = useState<number | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<KlingFilmView | null>(null);
  const deletedRunIds = useRef(new Set<string>());
  const lock = useRef(false);
  const revision = useRef(0);
  const changed = useRef(onAssetsChanged);
  changed.current = onAssetsChanged;
  const importedSignature = useRef("");
  const startId = useRef<{ planId: string; requestId: string } | null>(null);
  const alive = useRef(false);
  const latestContext = useRef("");
  latestContext.current = JSON.stringify([defaultModel, profileId, scriptId, presenterId, visualLook, motionIntensity, motionRealism, tideweNativeSpeech]);
  const model = status?.models.find((item) => item.selectionKey === selectionKey);
  const editableParameters = model?.parameters.filter((parameter) => !orchestratedParameters.has(parameter.name)) ?? [];
  const active = Boolean(view && view.status !== "draft");
  const formDisabled = busy || active || uncertain;

  const loadRuns = useCallback(async () => {
    const data = await responseData(await klingFetch(`/api/integrations/kling/films?projectId=${encodeURIComponent(projectId)}`));
    setRuns(Array.isArray(data.runs) ? data.runs.filter((run: KlingFilmView) => !deletedRunIds.current.has(run.runId)) : []);
  }, [projectId]);

  const acceptView = useCallback((next: KlingFilmView) => {
    if (deletedRunIds.current.has(next.runId)) return;
    setRuns((previous) => [next, ...previous.filter((item) => item.runId !== next.runId)]);
    if (next.status === "draft" && !matchesCurrentPromptSettings(next.promptSettings)) {
      setView(null); setConfirmed(false); setImageConfirmed(false);
      setError("此草稿缺少提示词设置，或与当前视觉风格、运镜强度、运动真实感设置不同，请重新预览整片计划。");
      return;
    }
    setView(next);
    const signature = JSON.stringify([next.runId, next.shots.map((shot) => shot.assetId), next.videoUrl]);
    if (importedSignature.current && importedSignature.current !== signature) void changed.current();
    importedSignature.current = signature;
  }, []);

  const refreshRun = useCallback(async (runId: string) => {
    const next = await responseData(await klingFetch(`/api/integrations/kling/films/${encodeURIComponent(runId)}`)) as KlingFilmView;
    acceptView(next); setUncertain(false);
    return next;
  }, [acceptView]);

  useEffect(() => {
    if (!open) return;
    alive.current = true;
    let cancelled = false;
    setLoading(true); setError(null); setConfirmed(false); setImageConfirmed(false); setActionConfirmed(false); setRetryShotId(null);
    const settings = useSettingsStore.getState();
    setOutput({ resolution: settings.defaultResolution, aspectRatio: tidewe ? "9:16" : settings.defaultAspectRatio, audioStrategy: tideweNativeSpeech ? "native" : "edge-tts", voice: resolveNarrationVoice(creativeProfile), subtitles: isTideweOutdoorProfile(creativeProfile) ? creativeProfile.composeSnapshot?.subtitles !== false : true });
    void Promise.allSettled([
      klingFetch(`/api/integrations/kling/status${profileId ? `?profileId=${encodeURIComponent(profileId)}` : ""}`).then(responseData),
      loadRuns(),
      ...(initialRunId ? [refreshRun(initialRunId)] : []),
    ]).then(([statusResult, runsResult, recoveryResult]) => {
      if (cancelled) return;
      if (statusResult.status === "fulfilled") setStatus(statusResult.value as KlingPublicStatus);
      setSelectionKey(defaultModel ?? "");
      const failure = [statusResult, runsResult, recoveryResult].find((result) => result?.status === "rejected");
      if (failure?.status === "rejected") setError(failure.reason instanceof Error ? failure.reason.message : "读取整片记录失败");
    }).catch((failure) => { if (!cancelled) setError(failure instanceof Error ? failure.message : "读取 Kling 环境失败"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; alive.current = false; };
  }, [open, profileId, defaultModel, initialRunId, loadRuns, refreshRun, creativeProfile, tidewe, tideweNativeSpeech]);

  useEffect(() => {
    if (!model) return;
    const mapped = klingModelOptions({
      ...model,
      parameters: model.parameters.filter((parameter) => !orchestratedParameters.has(parameter.name)),
    }, { resolution: defaultGenerationResolution });
    setOptions(mapped.options);
    setParameterWarnings(mapped.warnings);
  }, [model, defaultGenerationResolution]);

  useEffect(() => {
    setConfirmed(false); setImageConfirmed(false); revision.current++;
    setView((previous) => previous?.status === "draft" ? null : previous);
  }, [selectionKey, options, output, reuseVideos, presenterId, scriptId, defaultModel, profileId, visualLook, motionIntensity, motionRealism]);

  const currentRunId = view?.runId;
  const watchProgress = Boolean(view && !["draft", "completed", "cancelled"].includes(view.status));
  useEffect(() => {
    if (!open || !currentRunId || !watchProgress) return;
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      void refreshRun(currentRunId).catch((failure) => setError(failure instanceof Error ? failure.message : "读取整片进度失败"))
        .finally(() => { inFlight = false; });
    }, 4000);
    return () => clearInterval(timer);
  }, [open, currentRunId, watchProgress, refreshRun]);

  const missingParameter = editableParameters.find((parameter) => parameter.required && (options[parameter.name] === undefined || options[parameter.name] === ""));

  async function preview() {
    if (lock.current || !model?.available || model.selectionKey !== defaultModel || !scriptId || !status?.loggedIn || missingParameter) return;
    lock.current = true; setBusy(true); setError(null); setConfirmed(false); setImageConfirmed(false);
    const currentRevision = revision.current;
    const context = latestContext.current;
    try {
      const promptSettings: VideoPromptSettings = { visualLook, motionIntensity, motionRealism };
      const next = await responseData(await klingFetch("/api/integrations/kling/films/preview", { method: "POST", body: JSON.stringify({ projectId, scriptId, profileId: model.profileId, selectionKey: model.selectionKey, options, reuseExistingVideos: reuseVideos, output: tideweNativeSpeech ? { ...output, audioStrategy: "native" } : output, promptSettings }) })) as KlingFilmView;
      if (alive.current && currentRevision === revision.current && context === latestContext.current) acceptView(next);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "预览失败"); }
    finally { lock.current = false; setBusy(false); }
  }

  async function prepareKeyframes() {
    if (!view || !matchesCurrentPromptSettings(view.promptSettings) || view.model.selectionKey !== defaultModel || !model?.available || !view.missingKeyframes.length || !imageConfirmed || lock.current) return;
    lock.current = true; setBusy(true); setError(null); setImageConfirmed(false); setConfirmed(false);
    const context = latestContext.current;
    const preparationRevision = revision.current;
    let presenterSnapshot: Character | undefined;
    function assertPreparing() {
      if (!alive.current || latestContext.current !== context || revision.current !== preparationRevision) throw new Error("页面或默认模型已变化，已停止后续图片生成。请重新打开整片计划核对。");
      if (presenterSnapshot && !hasSameCharacterSheetInput(presenterSnapshot, useCharacterStore.getState().characters.find((item) => item.id === presenterSnapshot!.id))) throw new Error("主播参考图或外貌描述已变化，已停止使用旧定妆照，请重新预览后生成。");
    }
    try {
      const settings = useSettingsStore.getState();
      const imageTarget = await resolveDefaultModelTarget(settings.providers, settings.defaultImageModel, settings.customModels, "image");
      if (!imageTarget) throw new Error("请先在设置中配置可用的图片模型；不会自动替换到其他收费平台。");
      const project = await responseData(await fetch(`/api/project/${projectId}`));
      const selectedPresenterId = isTideweOutdoorProfile(project.creativeProfile) ? "" : presenterId || project.characterId || "";
      const library = useCharacterStore.getState();
      const presenter = selectedPresenterId ? library.characters.find((item) => item.id === selectedPresenterId) : undefined;
      if (selectedPresenterId && !presenter) throw new Error("所选主播在人物库中不存在，请重新选择主播后再准备关键帧。");
      presenterSnapshot = presenter;
      let sheet = presenter?.referenceImages?.[0];
      if (presenter && !sheet && hasCharacterSheetInput(presenter)) {
        assertPreparing();
        const sheetData = await responseData(await fetch("/api/characters/sheet", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...characterSheetRequest(presenter), provider: imageTarget.provider, model: imageTarget.model, apiKey: imageTarget.apiKey, baseUrl: imageTarget.baseUrl, options: buildImageOptions({ ...settings.imageParams, aspectRatio: "1:1", count: 1 }) }) }));
        if (typeof sheetData.url !== "string" || !sheetData.url) throw new Error("主播定妆照生成失败，已停止后续关键帧和视频生成。");
        assertPreparing();
        sheet = sheetData.url;
        library.updateCharacter(presenter.id, { referenceImages: [sheet!, ...(presenter.referenceImages ?? []).slice(1)] });
      }
      if (presenter && !sheet) throw new Error("所选主播没有可用定妆照，已停止；请先补齐人物参考。");
      const productImages: string[] = Array.isArray(project.productImages) ? project.productImages : [];
      assertPreparing();
      await responseData(await fetch(`/api/project/${projectId}/storyboard-grid`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scriptId, provider: imageTarget.provider, model: sheet || productImages.length ? toEditVariant(imageTarget.model) : imageTarget.model, apiKey: imageTarget.apiKey, baseUrl: imageTarget.baseUrl, ...(sheet && { characterSheetUrl: sheet }), productImageUrls: productImages, reuseExisting: true, preserveExisting: true, options: buildImageOptions({ ...settings.imageParams, aspectRatio: output.aspectRatio, count: 1 }) }) }));
      await changed.current();
      setView(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "准备关键帧失败，请先检查原任务；再次生成可能再次计费。"); }
    finally { lock.current = false; setBusy(false); }
  }

  async function start() {
    if (!view || !matchesCurrentPromptSettings(view.promptSettings) || view.model.selectionKey !== defaultModel || !model?.available || view.status !== "draft" || view.missingKeyframes.length || !confirmed || lock.current || uncertain) return;
    lock.current = true; setBusy(true); setError(null);
    if (startId.current?.planId !== view.runId) startId.current = { planId: view.runId, requestId: crypto.randomUUID() };
    const request: KlingFilmStartRequest = { planId: view.runId, planHash: view.planHash, clientRequestId: startId.current.requestId, explicitConfirmation: true, billingAcknowledgement: { policyRevision: "film-credits-v1", acceptedForPlanHash: view.planHash } };
    try {
      const data = await responseData(await klingFetch("/api/integrations/kling/films", { method: "POST", body: JSON.stringify(request) }));
      acceptView(data.run);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "启动结果待核对");
      setUncertain(true);
      try { await refreshRun(view.runId); await loadRuns(); } catch { /* Keep the recovery button; do not resubmit. */ }
    } finally { setConfirmed(false); setBusy(false); lock.current = false; }
  }

  async function action(name: string, shotId?: number) {
    if (!view || lock.current || ((name === "resume" || name === "retry-shot") && !actionConfirmed)) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      const body = name === "resume" || name === "retry-shot"
        ? { explicitConfirmation: true, planHash: view.planHash, billingAcknowledgement: { policyRevision: "film-credits-v1", acceptedForPlanHash: view.planHash }, ...(shotId !== undefined && { shotId }) } : {};
      const data = await responseData(await klingFetch(`/api/integrations/kling/films/${encodeURIComponent(view.runId)}/${name}`, { method: "POST", body: JSON.stringify(body) }));
      acceptView(data.run); setRetryShotId(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "恢复失败"); }
    finally { setBusy(false); lock.current = false; setActionConfirmed(false); }
  }

  async function deleteRecord() {
    if (!deleteTarget || lock.current) return;
    const runId = deleteTarget.runId;
    lock.current = true; setBusy(true); setError(null);
    try {
      await responseData(await klingFetch(`/api/integrations/kling/films/${encodeURIComponent(runId)}`, { method: "DELETE" }));
      deletedRunIds.current.add(runId);
      setRuns((previous) => previous.filter((run) => run.runId !== runId));
      setView((previous) => previous?.runId === runId ? null : previous);
      if (view?.runId === runId) {
        setConfirmed(false); setImageConfirmed(false); setActionConfirmed(false);
        setRetryShotId(null); setUncertain(false);
        startId.current = null; importedSignature.current = "";
        revision.current++;
      }
      setDeleteTarget(null);
      window.dispatchEvent(new Event(TASK_FEED_REFRESH_EVENT));
      if (initialRunId === runId) onOpenChange(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "删除整片记录失败，请重试。");
    } finally { setBusy(false); lock.current = false; }
  }

  return <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl" showCloseButton={!busy}>
      <DialogHeader><DialogTitle>整片自动编排</DialogTitle></DialogHeader>
      <p className="text-sm text-muted-foreground">复用已有素材，按脚本顺序逐镜头生成、保存，最后在本机合成。关闭页面或重启服务后可从本地记录恢复。</p>
      {error && <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{error}</p>}
      {loading && <p role="status">正在读取账号和本地整片记录…</p>}
      <section aria-label="整片记录" className="space-y-2 rounded-md border p-3">
        <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">本项目整片记录</h3><Button size="sm" variant="ghost" disabled={busy} onClick={() => void loadRuns().catch((failure) => setError(String(failure)))}>刷新记录</Button></div>
        {runs.length === 0 && <p className="text-xs text-muted-foreground">还没有整片任务。</p>}
        {runs.map((run) => <div key={run.runId} className={`flex items-center gap-2 rounded border p-2 text-xs ${view?.runId === run.runId ? "border-primary" : "border-border"}`}>
          <button type="button" disabled={busy} className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-2 text-left" onClick={() => { setConfirmed(false); setImageConfirmed(false); setActionConfirmed(false); setRetryShotId(null); void refreshRun(run.runId).catch((failure) => setError(String(failure))); }}><span>{run.model.displayName} · {new Date(run.createdAt).toLocaleString()}</span><span>{filmStatus[run.status]} · {run.readyShots}/{run.totalShots}</span></button>
          <Button type="button" size="sm" variant="ghost" aria-label={`删除整片记录 ${run.runId}`} disabled={busy || !run.allowedActions.includes("delete")} title={run.allowedActions.includes("delete") ? "删除此整片计划记录" : ["draft", "completed", "cancelled"].includes(run.status) ? "整片记录正在处理，请稍后刷新。" : "请先停止此整片计划，再删除记录。"} className="shrink-0 text-destructive hover:text-destructive" onClick={() => { setDeleteTarget(run); setError(null); }}>删除</Button>
        </div>)}
        {deleteTarget && <div role="group" aria-label="删除整片记录确认" className="space-y-2 rounded border border-destructive/40 p-3">
          <p className="text-sm font-medium">删除整片记录？</p>
          <p className="text-xs text-muted-foreground">{deleteTarget.model.displayName} · {new Date(deleteTarget.createdAt).toLocaleString()}</p>
          <p className="text-sm">删除后无法恢复此整片计划记录。已生成的镜头素材和成片视频会保留。</p>
          <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => setDeleteTarget(null)}>取消删除</Button><Button size="sm" variant="destructive" disabled={busy} onClick={() => void deleteRecord()}>{busy ? "正在删除…" : "确认删除记录"}</Button></div>
        </div>}
        {active && <Button size="sm" variant="outline" disabled={busy || uncertain} onClick={() => { setView(null); setActionConfirmed(false); setRetryShotId(null); }}>新建整片计划</Button>}
      </section>
      {!active && <>
        {status && !status.loggedIn && <p>请先在 <Link href="/settings" className="text-primary underline">设置页</Link> 检测并登录 Kling CLI。</p>}
        {status?.loggedIn && <>
          <p className="text-xs text-muted-foreground">账号：{status.profile?.accountSummary?.displayName ?? status.profile?.label ?? "当前账号"}</p>
          <p className="break-all text-sm">默认视频模型：{model?.displayName ?? defaultModel ?? "未设置"} <Link href="/settings?tab=video" className="text-primary underline">前往设置修改</Link></p>
          {!model?.available && <p role="alert" className="text-sm text-amber-600">{model?.disabledReason ?? "设置中的默认视频模型在当前账号不可用。请到设置 → 视频生成 → 默认视频模型重新选择。"}</p>}
          {model && <div className="grid gap-3 sm:grid-cols-2">{editableParameters.map((parameter) => <label key={parameter.name} className="space-y-1 text-sm"><span>{videoParameterLabel(parameter.name)}{parameter.required ? " *" : ""}</span>{parameter.allowedValues || parameter.type === "boolean" ? <select aria-label={`整片参数 ${videoParameterLabel(parameter.name)}`} className="w-full rounded border bg-background p-2" value={String(options[parameter.name] ?? "")} disabled={formDisabled} onChange={(event) => { const value = (parameter.allowedValues ?? [true, false]).find((item) => String(item) === event.target.value); setOptions((previous) => { const next = { ...previous }; if (value === undefined) delete next[parameter.name]; else next[parameter.name] = value; return next; }); }}><option value="">使用平台默认值</option>{(parameter.allowedValues ?? [true, false]).map((value) => <option key={String(value)} value={String(value)}>{videoParameterValueLabel(parameter.name, value)}</option>)}</select> : <input aria-label={`整片参数 ${videoParameterLabel(parameter.name)}`} className="w-full rounded border bg-background p-2" type={parameter.type === "number" ? "number" : "text"} value={String(options[parameter.name] ?? "")} disabled={formDisabled} onChange={(event) => setOptions((previous) => { const next = { ...previous }; if (!event.target.value) delete next[parameter.name]; else next[parameter.name] = parameter.type === "number" ? Number(event.target.value) : event.target.value; return next; })} />}{videoParameterDescription(parameter) && <p className="text-xs text-muted-foreground">{videoParameterDescription(parameter)}</p>}</label>)}</div>}
          {parameterWarnings.map((warning) => <p key={warning} role="status" className="text-xs text-amber-600">{warning}</p>)}
          <p className="text-xs text-muted-foreground">镜头时长按脚本选择足够长的官方档位，声音和画幅由整片输出设置控制。每镜头实际参数会在计划中展示。</p>
          {tideweNativeSpeech && <p className="text-xs text-muted-foreground">{tt("nativeSpeechHint")}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm"><span>合成画幅</span><select aria-label="整片画幅" className="w-full rounded border bg-background p-2" value={output.aspectRatio} disabled={formDisabled} onChange={(event) => setOutput((previous) => ({ ...previous, aspectRatio: event.target.value as KlingFilmOutputSettings["aspectRatio"] }))}>{["9:16", "16:9", "1:1"].map((value) => <option key={value}>{value}</option>)}</select></label>
            <label className="space-y-1 text-sm"><span>合成分辨率</span><select aria-label="整片分辨率" className="w-full rounded border bg-background p-2" value={output.resolution} disabled={formDisabled} onChange={(event) => setOutput((previous) => ({ ...previous, resolution: event.target.value as KlingFilmOutputSettings["resolution"] }))}><option>720p</option><option>1080p</option></select></label>
            <label className="space-y-1 text-sm"><span>声音策略</span><select aria-label="整片声音策略" className="w-full rounded border bg-background p-2" value={output.audioStrategy} disabled={formDisabled || tidewe} onChange={(event) => setOutput((previous) => ({ ...previous, audioStrategy: event.target.value as KlingFilmOutputSettings["audioStrategy"] }))}><option value="edge-tts">免费 Edge 配音，替换镜头原声音</option><option value="edge-tts-mix">免费 Edge 配音，叠加镜头原声音</option><option value="native">保留镜头原声音，不补配音</option></select></label>
            {output.audioStrategy !== "native" && <label className="space-y-1 text-sm"><span>配音音色</span><select aria-label="整片配音音色" className="w-full rounded border bg-background p-2" value={output.voice} disabled={formDisabled} onChange={(event) => setOutput((previous) => ({ ...previous, voice: event.target.value }))}>{FREE_TTS_VOICES.filter((voice) => !tidewe || voice.lang.startsWith("en-")).map((voice) => <option key={voice.value} value={voice.value}>{voice.label}</option>)}</select></label>}
          </div>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={output.subtitles} disabled={formDisabled} onChange={(event) => setOutput((previous) => ({ ...previous, subtitles: event.target.checked }))} />按脚本台词添加字幕</label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={reuseVideos} disabled={formDisabled} onChange={(event) => setReuseVideos(event.target.checked)} />复用当前脚本已选用的视频素材</label>
          <Button variant="outline" disabled={busy || uncertain || !model?.available || !scriptId || !!missingParameter} onClick={() => void preview()}>预览整片计划（不生成、不计费）</Button>
          {missingParameter && <p className="text-xs text-amber-600">请填写必填参数：{videoParameterLabel(missingParameter.name)}</p>}
        </>}
      </>}
      {view && <section className="space-y-3 rounded-md border p-3" aria-label="整片计划">
        <div className="flex flex-wrap justify-between gap-2"><h3 className="font-medium">{filmStatus[view.status]} · {view.readyShots}/{view.totalShots} 镜头已就绪</h3><Button variant="ghost" size="sm" disabled={busy} onClick={() => void refreshRun(view.runId).catch((failure) => setError(String(failure)))}>查询原整片进度</Button></div>
        <p className="break-all text-xs text-muted-foreground">{view.model.displayName} · {view.model.remoteModelId} · {view.model.tool} · {view.output.aspectRatio} · {view.output.resolution} · {audioStrategySummary[view.output.audioStrategy]} · {view.stage}</p>
        {view.warnings.map((warning, index) => <p key={index} className="text-sm text-amber-600">{warning}</p>)}
        {view.error && <p role="alert" className="text-sm text-destructive">{view.error}</p>}
        <div className="space-y-2">{view.shots.map((shot) => <div key={shot.id} className="flex flex-wrap items-start gap-3 rounded border p-2 text-sm">{shot.keyframeUrl && <img src={shot.keyframeUrl} alt={`镜头 ${shot.shotId} 关键帧`} className="h-20 w-14 rounded object-cover" />}<div className="min-w-0 flex-1 space-y-1"><p className="font-medium">镜头 {shot.shotId} · {shot.source === "reuse" ? "复用已有视频" : "新建视频任务"} · {shot.duration}s{shot.generationDuration !== undefined ? `（生成 ${shot.generationDuration}s）` : ""} · {shotStatus[shot.status]}</p><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">实际提交的提示词</summary><p className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed">{shot.prompt}</p></details><p className="break-all text-xs text-muted-foreground">{JSON.stringify(shot.options)}</p>{shot.missingKeyframe && <p className="text-xs text-amber-600">缺少关键帧；补图前不会提交此镜头视频。</p>}{shot.error && <p className="text-xs text-destructive">{shot.error}</p>}<div className="flex flex-wrap gap-2">{shot.jobId && <Button size="sm" variant="outline" disabled={busy} onClick={() => onOpenJob(shot.jobId!)}>查看 / 恢复镜头 {shot.shotId} 原任务</Button>}{shot.videoUrl && <a href={shot.videoUrl} target="_blank" rel="noreferrer" className="text-xs text-primary underline">播放镜头视频</a>}{active && shot.allowedActions?.includes("retry-shot") && <Button size="sm" variant="outline" disabled={busy} onClick={() => { setRetryShotId(shot.shotId); setActionConfirmed(false); }}>准备重试镜头 {shot.shotId}（重新计费）</Button>}</div></div></div>)}</div>
        {view.status === "draft" && view.missingKeyframes.length > 0 && <div className="space-y-2 rounded border border-amber-500/40 p-3"><p className="text-sm">缺少镜头 {view.missingKeyframes.join("、")} 的关键帧。可使用已配置图片模型生成一张分镜图，仅保存缺图镜头，保留已有关键帧和视频。若所选主播没有定妆照，还会先生成一张定妆照。</p><p className="text-xs text-muted-foreground">图片和定妆照由图片平台单独计费；本应用未获得准确报价。这里只准备图片，完成后需重新预览和确认视频任务。</p><label className="flex items-start gap-2 text-sm"><input aria-label="确认关键帧图片计费" type="checkbox" checked={imageConfirmed} disabled={busy || uncertain} onChange={(event) => setImageConfirmed(event.target.checked)} />我确认使用当前图片模型补齐关键帧及必要的主播定妆照，可能产生图片费用。</label><Button disabled={busy || uncertain || !imageConfirmed || view.model.selectionKey !== defaultModel || !model?.available} onClick={() => void prepareKeyframes()}>确认补齐关键帧（图片另计费）</Button></div>}
        {view.status === "draft" && view.missingKeyframes.length === 0 && <div className="space-y-2 rounded border border-amber-500/40 p-3"><p className="text-sm">本计划将提交 {view.billableShotCount} 个新视频任务，同一账号最多同时生成 {KLING_MAX_CONCURRENT_SHOTS} 个镜头，复用 {view.totalShots - view.billableShotCount} 个已有视频，随后本地合成。Kling 积分单价和余额未获得准确报价，实际扣费以账号为准。</p><label className="flex items-start gap-2 text-sm"><input aria-label="确认整片视频计费" type="checkbox" checked={confirmed} disabled={busy || uncertain} onChange={(event) => setConfirmed(event.target.checked)} />我已核对全部镜头、模型、参数和声音策略，授权按此计划生成，确认新视频任务可能扣除 Kling 积分。</label><Button disabled={busy || uncertain || !confirmed || view.model.selectionKey !== defaultModel || !model?.available} onClick={() => void start()}>确认生成整片（{view.billableShotCount} 个积分任务）</Button></div>}
        {uncertain && <p className="text-sm text-amber-600">启动结果待核对。请查询原整片进度或从本地记录打开任务，避免重复提交。</p>}
        {active && <div className="space-y-3"><div className="flex flex-wrap gap-2">{view.allowedActions.includes("pause") && <Button variant="outline" disabled={busy} onClick={() => void action("pause")}>暂停后续镜头</Button>}{view.allowedActions.includes("retry-compose") && <Button variant="outline" disabled={busy} onClick={() => void action("retry-compose")}>重试本地合成（不生成视频）</Button>}{view.allowedActions.includes("cancel") && <Button variant="outline" disabled={busy} onClick={() => void action("cancel")}>停止此整片计划</Button>}</div>
          <p className="text-xs text-muted-foreground">暂停或停止只阻止后续提交，已经提交的云端任务可能继续运行和扣费。已知任务 ID 或视频保存失败时，请打开原任务查询 / 保存，再恢复编排。</p>
          {(view.allowedActions.includes("resume") || retryShotId !== null) && <div className="space-y-2 rounded border border-amber-500/40 p-3"><p className="text-sm">{retryShotId !== null ? `重试镜头 ${retryShotId} 会创建新视频任务，可能再次扣除积分。仅原任务已明确失败或未提交时允许重试。` : "恢复将先核对原任务，继续尚未提交的镜头；这些新任务可能扣除积分。"}</p><label className="flex items-start gap-2 text-sm"><input aria-label="确认整片恢复计费" type="checkbox" checked={actionConfirmed} disabled={busy} onChange={(event) => setActionConfirmed(event.target.checked)} />我确认按原计划继续，并承担本次新提交视频的 Kling 积分费用。</label><Button disabled={busy || !actionConfirmed} onClick={() => void action(retryShotId !== null ? "retry-shot" : "resume", retryShotId ?? undefined)}>{retryShotId !== null ? `确认重新生成镜头 ${retryShotId}（可能再次扣积分）` : "确认恢复并继续未完成镜头"}</Button>{retryShotId !== null && <Button variant="ghost" disabled={busy} onClick={() => { setRetryShotId(null); setActionConfirmed(false); }}>取消重试选择</Button>}</div>}
        </div>}
        {view.videoUrl && <div className="space-y-2"><video src={view.videoUrl} poster={view.thumbnailUrl} controls preload="metadata" className="max-h-[28rem] w-full rounded bg-black" /><a href={view.videoUrl} download className="inline-block text-sm text-primary underline">下载整片视频</a></div>}
      </section>}
      {busy && <p role="status" className="text-sm text-muted-foreground">正在处理，请勿重复操作…</p>}
    </DialogContent>
  </Dialog>;
}
