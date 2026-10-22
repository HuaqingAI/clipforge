"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { useCharacterStore, type Character } from "@/lib/stores/project-store";
import { characterSheetRequest, hasCharacterSheetInput, hasSameCharacterSheetInput } from "@/lib/character-reference";
import { buildImageOptions, buildVideoOptions, resolveDefaultModelTarget, toEditVariant, type GenModelTarget } from "@/lib/gen-params";
import { isKlingVideoSelection } from "@/lib/assets-view";

interface FilmPreview {
  prompt: string; model: string; shotCount: number; seconds: number; scriptSeconds: number;
  durationOverflow: boolean; modelMaxSeconds: number; referenceImages: number;
  referenceQuota?: { ok: boolean; count: number; limit?: number };
  dialogueWarnings: { index: number; seconds: number; count: number; limit: number }[];
  estimate?: { unitUsd: number; seconds: number; minUsd: number; maxUsd: number; tierMultiplier: number };
}
interface ProjectContext { productImages?: string[]; characterId?: string }
interface SavedTask { id: string; taskId: string; provider: string; model: string; shotId: number | null; mode?: string; error?: string }

function configuration(scriptId: string, presenterId?: string) {
  const s = useSettingsStore.getState();
  return JSON.stringify([scriptId, presenterId, s.defaultVideoModel, s.providers, s.customModels, s.defaultImageModel, s.imageParams, s.videoParams, s.spendCapUsd]);
}
async function dataFrom(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "整片操作失败，请检查任务记录。");
  return data;
}

/** Ark keeps its native multi-shot request, behind the same preview/confirm/recover flow. */
export function ArkFilmPanel({ open, onOpenChange, projectId, scriptId, presenterId, initialTaskId, onAssetsChanged }: {
  open: boolean; onOpenChange(open: boolean): void; projectId: string; scriptId: string;
  presenterId?: string; initialTaskId?: string; onAssetsChanged(): Promise<void> | void;
}) {
  const settings = useSettingsStore();
  const [preview, setPreview] = useState<FilmPreview | null>(null);
  const [project, setProject] = useState<ProjectContext | null>(null);
  const [target, setTarget] = useState<GenModelTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [overCapAck, setOverCapAck] = useState(false);
  const [inputBlocked, setInputBlocked] = useState(false);
  const [rejected, setRejected] = useState<{ url: string; kind: string; shotId?: number } | null>(null);
  const [savedTasks, setSavedTasks] = useState<SavedTask[]>([]);
  const [recordsLoaded, setRecordsLoaded] = useState(false);
  const [taskId, setTaskId] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [videoUrl, setVideoUrl] = useState("");
  const lock = useRef(false);
  const frozen = useRef("");
  const frozenTarget = useRef<GenModelTarget | null>(null);
  const alive = useRef(false);
  const configurationEpoch = useRef(0);
  const currentConfig = configuration(scriptId, presenterId);
  const invalidated = Boolean(preview && currentConfig !== frozen.current);
  const hasTask = Boolean(taskId || uncertain || videoUrl || savedTasks.length);
  const productImages = project?.productImages?.filter((url) => typeof url === "string" && url.trim()) ?? [];

  useEffect(() => { configurationEpoch.current++; setConfirmed(false); setOverCapAck(false); }, [currentConfig]);

  async function loadTasks() {
    setRecordsLoaded(false);
    const rows = await dataFrom(await fetch(`/api/ai/tasks?projectId=${encodeURIComponent(projectId)}&active=1`));
    setSavedTasks(Array.isArray(rows) ? rows.filter((row: SavedTask) => row.provider !== "kling-cli" && row.shotId == null && row.mode === "video-to-video") : []);
    setRecordsLoaded(true);
  }

  useEffect(() => {
    if (!open) return;
    alive.current = true;
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(`/api/project/${projectId}`);
        const next = await dataFrom(response);
        if (!cancelled) setProject(next);
        const rows = await dataFrom(await fetch(`/api/ai/tasks?projectId=${encodeURIComponent(projectId)}&active=1`));
        if (!cancelled) { setSavedTasks(Array.isArray(rows) ? rows.filter((row: SavedTask) => row.provider !== "kling-cli" && row.shotId == null && row.mode === "video-to-video") : []); setRecordsLoaded(true); }
      } catch (failure) { if (!cancelled) setError(failure instanceof Error ? failure.message : "读取整片记录失败"); }
    }
    void load();
    return () => { cancelled = true; alive.current = false; };
  }, [open, projectId]);

  function assertConfiguration() {
    if (!alive.current) throw new Error("整片面板已关闭，已停止后续生成。已提交的任务可从原记录恢复。");
    if (configuration(scriptId, presenterId) !== frozen.current) throw new Error("设置或脚本已变化，请重新预览整片计划后确认生成。");
  }
  async function fetchPreview(videoTarget: GenModelTarget) {
    const library = useCharacterStore.getState();
    const selectedPresenterId = presenterId || project?.characterId;
    const presenter = library.characters.find((item) => item.id === selectedPresenterId);
    if (selectedPresenterId && !presenter) throw new Error("所选主播在人物库中不存在，请重新选择后再预览。");
    return await dataFrom(await fetch(`/api/project/${projectId}/storyboard-film`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scriptId, dryRun: true, provider: videoTarget.provider, model: videoTarget.model, baseUrl: videoTarget.baseUrl,
        options: buildVideoOptions(settings.videoParams), ...(presenter && { characterSheetUrl: presenter.referenceImages?.[0] ?? "planned" }) }),
    })) as FilmPreview;
  }
  async function previewPlan() {
    if (lock.current || hasTask || !recordsLoaded || !project) return;
    lock.current = true; setBusy(true); setError(""); setConfirmed(false); setOverCapAck(false); setStage("正在预览整片计划…");
    const signature = configuration(scriptId, presenterId);
    const epoch = configurationEpoch.current;
    try {
      const s = useSettingsStore.getState();
      const resolved = await resolveDefaultModelTarget(s.providers, s.defaultVideoModel, s.customModels, "video");
      if (!resolved || resolved.provider === "kling-cli") throw new Error("默认视频模型不可用或已更改，请到设置 → 视频生成 → 默认视频模型中选择，再重新打开整片编排。");
      const next = await fetchPreview(resolved);
      if (signature !== configuration(scriptId, presenterId) || epoch !== configurationEpoch.current) throw new Error("设置已变化，请重新预览。");
      if (next.model !== resolved.model) throw new Error("预览模型与设置不一致，请检查默认视频模型。");
      frozen.current = signature; frozenTarget.current = resolved; setTarget(resolved); setPreview(next);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "预览失败"); }
    finally { setBusy(false); lock.current = false; }
  }

  async function generate(regenerateGrid = false) {
    if (!preview || !confirmed || lock.current || hasTask || !recordsLoaded || (inputBlocked && !regenerateGrid)) return;
    lock.current = true; setBusy(true); setError("");
    const epoch = configurationEpoch.current;
    let presenterSnapshot: Character | undefined;
    function assertAuthorized() {
      assertConfiguration();
      if (epoch !== configurationEpoch.current) throw new Error("设置已变化，本次确认已撤销，请重新预览后确认。");
      if (presenterSnapshot && !hasSameCharacterSheetInput(presenterSnapshot, useCharacterStore.getState().characters.find((item) => item.id === presenterSnapshot!.id))) throw new Error("主播参考图或外貌描述已变化，已停止使用旧定妆照，请重新预览后生成。");
    }
    let filmSubmitted = false;
    try {
      assertAuthorized();
      const videoTarget = frozenTarget.current;
      if (!videoTarget) throw new Error("请重新预览默认视频模型。");
      const latestSettings = useSettingsStore.getState();
      const availableTarget = await resolveDefaultModelTarget(latestSettings.providers, latestSettings.defaultVideoModel, latestSettings.customModels, "video");
      assertAuthorized();
      if (!availableTarget || availableTarget.model !== videoTarget.model || availableTarget.provider !== videoTarget.provider) throw new Error("默认视频模型当前不可用，请检查设置并重新预览。");
      setStage("正在核对整片计划…");
      const fresh = await fetchPreview(videoTarget);
      if (JSON.stringify(fresh) !== JSON.stringify(preview)) {
        setPreview(fresh); setConfirmed(false); throw new Error("脚本、费用或参考素材已变化，请核对新计划并重新确认。");
      }
      const s = useSettingsStore.getState();
      const imageTarget = await resolveDefaultModelTarget(s.providers, s.defaultImageModel, s.customModels, "image");
      if (!imageTarget) throw new Error("请先在设置中配置可用的默认图片模型。");
      assertAuthorized();
      const library = useCharacterStore.getState();
      const selectedPresenterId = presenterId || project?.characterId;
      const presenter = library.characters.find((item) => item.id === selectedPresenterId);
      if (selectedPresenterId && !presenter) throw new Error("所选主播在人物库中不存在，已停止后续生成。");
      presenterSnapshot = presenter;
      let sheet = presenter?.referenceImages?.[0];
      if (presenter && !sheet && hasCharacterSheetInput(presenter)) {
        setStage("正在生成主播定妆照…"); assertAuthorized();
        const data = await dataFrom(await fetch("/api/characters/sheet", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...characterSheetRequest(presenter), provider: imageTarget.provider, model: imageTarget.model, apiKey: imageTarget.apiKey, baseUrl: imageTarget.baseUrl, options: buildImageOptions({ ...s.imageParams, aspectRatio: "1:1", count: 1 }) }) }));
        if (typeof data.url !== "string" || !data.url) throw new Error("主播定妆照生成失败，已停止后续生成。");
        assertAuthorized();
        sheet = data.url; library.updateCharacter(presenter.id, { referenceImages: [sheet!, ...(presenter.referenceImages ?? []).slice(1)] });
      }
      if (presenter && !sheet) throw new Error("所选主播没有可用定妆照，已停止后续生成。");
      setStage("正在准备分镜关键帧…"); assertAuthorized();
      await dataFrom(await fetch(`/api/project/${projectId}/storyboard-grid`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scriptId, provider: imageTarget.provider, model: sheet || productImages.length ? toEditVariant(imageTarget.model) : imageTarget.model, apiKey: imageTarget.apiKey, baseUrl: imageTarget.baseUrl, ...(sheet && { characterSheetUrl: sheet }), productImageUrls: productImages, reuseExisting: !regenerateGrid, options: buildImageOptions({ ...s.imageParams, aspectRatio: s.videoParams.aspectRatio, count: 1 }) }) }));
      await onAssetsChanged(); setInputBlocked(false); setRejected(null);
      setStage("正在生成整片，任务受理后会保存恢复记录…"); assertAuthorized();
      filmSubmitted = true;
      const response = await fetch(`/api/project/${projectId}/storyboard-film`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scriptId, provider: videoTarget.provider, model: preview.model, expectedPrompt: preview.prompt, apiKey: videoTarget.apiKey, baseUrl: videoTarget.baseUrl, spendCapUsd: s.spendCapUsd, acknowledgeOverCap: overCapAck, ...(sheet && { characterSheetUrl: sheet }), options: buildVideoOptions(s.videoParams) }) });
      const data = await response.json().catch(() => null);
      if (!data) { setUncertain(true); throw new Error("提交结果待核对，请查询原任务记录后恢复。"); }
      if (!response.ok) {
        if (typeof data.errorCode === "string" && data.errorCode.startsWith("InputImageSensitiveContentDetected")) { setInputBlocked(true); setRejected(data.rejectedReference ?? null); }
        if (data.recoverable && data.taskId) setTaskId(data.taskId);
        else if (response.status >= 500 && !data.taskId) setUncertain(true);
        throw new Error(data.error || "整片生成失败");
      }
      if (!data.url) { setUncertain(true); throw new Error("未取得视频地址，请先核对原任务。"); }
      setVideoUrl(data.url); setStage("已完成"); await onAssetsChanged();
    } catch (failure) {
      if (filmSubmitted && failure instanceof TypeError) setUncertain(true);
      setError(failure instanceof Error ? failure.message : "整片生成失败");
      if (filmSubmitted) await loadTasks().catch(() => {});
    } finally { setBusy(false); setConfirmed(false); lock.current = false; }
  }

  async function recoverTask(task: SavedTask) {
    if (lock.current) return;
    const provider = useSettingsStore.getState().providers[task.provider];
    if (!provider?.apiKey) { setError("请在设置中配置原任务所属平台的 API Key，再恢复原任务。"); return; }
    lock.current = true; setBusy(true); setError(""); setTaskId(task.taskId); setStage("正在查询 / 保存原整片任务…");
    setTarget({ provider: task.provider, model: task.model, apiKey: provider.apiKey, baseUrl: provider.baseUrl });
    try {
      const response = await fetch(`/api/project/${projectId}/storyboard-film`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "recover", taskId: task.taskId, provider: task.provider, apiKey: provider.apiKey, baseUrl: provider.baseUrl }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (data.recoverable === false) setTaskId("");
        throw new Error(data.error || "查询原任务失败，请稍后恢复。");
      }
      if (typeof data.url === "string") { setVideoUrl(data.url); setUncertain(false); setStage("已完成"); await onAssetsChanged(); }
      else setStage("原任务仍在生成中，请稍后再次查询。");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "恢复原整片失败"); }
    finally { await loadTasks().catch(() => {}); setBusy(false); lock.current = false; }
  }

  const overCap = Boolean(preview?.estimate && settings.spendCapUsd > 0 && preview.estimate.maxUsd > settings.spendCapUsd);
  const blocked = invalidated || !preview || preview.durationOverflow || preview.referenceQuota?.ok === false || (overCap && !overCapAck) || hasTask;
  return <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl" showCloseButton={!busy}>
      <DialogHeader><DialogTitle>整片自动编排</DialogTitle></DialogHeader>
      <p className="text-sm text-muted-foreground">按脚本准备关键帧，再由当前模型一次生成整片。先预览并确认费用，生成结果会保存到项目。</p>
      <p className="break-all text-sm">{hasTask ? "原任务模型" : "默认视频模型"}：{target?.model ?? (hasTask ? savedTasks.find((task) => task.taskId === initialTaskId)?.model ?? savedTasks[0]?.model : undefined) ?? (settings.defaultVideoModel || "未设置")} <Link href="/settings?tab=video" className="text-primary underline">前往设置修改</Link></p>
      {error && <p role="alert" className="rounded border border-destructive/40 p-3 text-sm text-destructive">{error}</p>}
      {invalidated && !hasTask && <p role="status" className="text-sm text-amber-600">默认模型或参数已变化，请重新预览后确认。</p>}
      <section aria-label="整片记录" className="space-y-2 rounded border p-3">
        <div className="flex items-center justify-between"><h3 className="text-sm font-medium">本项目整片记录</h3><Button size="sm" variant="ghost" disabled={busy} onClick={() => void loadTasks().catch((failure) => setError(String(failure)))}>刷新记录</Button></div>
        {savedTasks.length === 0 && <p className="text-xs text-muted-foreground">没有待恢复的整片任务。</p>}
        {!recordsLoaded && <p role="status" className="text-xs text-muted-foreground">正在核对待恢复任务…</p>}
        {savedTasks.map((task) => <div key={task.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-xs"><span>{task.model} · 原任务 {task.taskId}</span><Button size="sm" variant="outline" disabled={busy} onClick={() => void recoverTask(task)}>查看 / 恢复原任务</Button></div>)}
        {(taskId || uncertain) && <p className="text-sm text-amber-600">{taskId ? `原任务 ${taskId} 已保存。` : "提交结果待核对。"}请在素材页查询原任务，避免重复提交。<Link href={`/project/${projectId}/assets`} className="ml-1 underline">查看 / 恢复原任务</Link></p>}
      </section>
      {!hasTask && <Button variant="outline" disabled={busy || !recordsLoaded || !project || !scriptId || isKlingVideoSelection(settings.defaultVideoModel)} onClick={() => void previewPlan()}>预览整片计划（不生成、不计费）</Button>}
      {preview && !hasTask && <section aria-label="整片计划" className="space-y-3 rounded border p-3">
        <p className="text-sm">{preview.model} · {preview.shotCount} 个镜头 · {preview.seconds}s · {preview.referenceImages} 张参考图 · {settings.videoParams.aspectRatio} · {settings.videoParams.resolution}</p>
        {productImages.length > 0 && <div className="space-y-2"><p className="text-xs text-muted-foreground">已关联 {productImages.length} 张商品图</p><div className="flex flex-wrap gap-2">{productImages.map((url, index) => <img key={`${url}-${index}`} src={url} alt={`商品参考图 ${index + 1}`} className="h-20 w-16 rounded object-contain" />)}</div></div>}
        {rejected && <a href={rejected.url} target="_blank" rel="noreferrer" className="block text-sm text-primary underline"><img src={rejected.url} alt={rejected.kind === "character-sheet" ? "被拒绝的人物定妆照" : `被拒绝的镜头 ${rejected.shotId} 关键帧`} className="h-32 w-24 object-contain" />查看被拒绝的图片</a>}
        {preview.durationOverflow && <p className="text-sm text-destructive">脚本 {preview.scriptSeconds}s 超过所选模型整片上限 {preview.modelMaxSeconds}s，请缩短脚本或到设置选择其他模型。</p>}
        {preview.referenceQuota?.ok === false && <p className="text-sm text-destructive">参考图 {preview.referenceQuota.count} 张，超过模型上限 {preview.referenceQuota.limit} 张。</p>}
        {preview.dialogueWarnings?.length > 0 && <p className="text-xs text-amber-600">镜头 {preview.dialogueWarnings.map((item) => item.index + 1).join("、")} 的台词较密，可能影响音画同步。</p>}
        <details className="rounded border p-3 text-xs"><summary>实际提交的提示词</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap">{preview.prompt}</pre></details>
        <div className="space-y-2 rounded border border-amber-500/40 p-3 text-sm">
          <p>{preview.estimate ? `预计视频费用 $${preview.estimate.minUsd.toFixed(2)}–$${preview.estimate.maxUsd.toFixed(2)}，以平台实际计费为准。` : "视频费用未获得准确报价，实际计费以所选平台为准。"} 分镜图及必要的主播定妆照由图片平台另行计费；失败重试会尽量复用已有九宫格。</p>
          {overCap && <label className="flex gap-2"><input aria-label="允许超过整片预算" type="checkbox" checked={overCapAck} disabled={busy} onChange={(event) => setOverCapAck(event.target.checked)} />我确认本次费用可能超过 ${settings.spendCapUsd} 的预算。</label>}
          <label className="flex items-start gap-2"><input aria-label="确认整片视频计费" type="checkbox" checked={confirmed} disabled={busy || invalidated || hasTask} onChange={(event) => setConfirmed(event.target.checked)} />我已核对脚本、默认模型、图片和参数，确认生成可能产生图片与视频费用。</label>
          <Button disabled={busy || blocked || !confirmed || inputBlocked} onClick={() => void generate()}>确认生成整片（可能计费）</Button>
          {inputBlocked && <Button variant="outline" disabled={busy || blocked || !confirmed} onClick={() => void generate(true)}>重新绘制分镜并生成视频（图片和视频重新计费）</Button>}
        </div>
      </section>}
      {busy && <p role="status" className="text-sm text-muted-foreground">{stage} 请勿重复操作。</p>}
      {!busy && taskId && !videoUrl && stage && <p role="status" className="text-sm text-muted-foreground">{stage}</p>}
      {videoUrl && <div className="space-y-2"><video src={videoUrl} controls preload="metadata" className="max-h-[28rem] w-full rounded bg-black" /><a href={videoUrl} download className="text-sm text-primary underline">下载整片视频</a><Link href={`/project/${projectId}/export`} className="ml-4 text-sm text-primary underline">查看项目成片</Link></div>}
    </DialogContent>
  </Dialog>;
}
