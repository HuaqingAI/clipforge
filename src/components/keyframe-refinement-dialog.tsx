"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { AssetImagePreview } from "@/app/project/[id]/assets/_components/asset-image-preview";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { resolveCharacterReferenceModel } from "@/lib/character-reference-model";
import { useLocale } from "@/lib/i18n";
import { submitGenerationRun, useGenerationRuns, type GenerationRun, type GenerationRunInput, type GenerationStatus } from "@/lib/hooks/use-generation-runs";
import {
  KEYFRAME_REPAIR_ISSUES,
  type KeyframeRefinementCandidate,
  type KeyframeRefinementResolution,
  type KeyframeRepairIssue,
} from "@/lib/keyframe-refinement";

export interface KeyframeRefinementDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  projectId: string;
  scriptId: string;
  shots: Array<{ assetId: string; shotId: number; imageUrl: string; description: string }>;
  initialShotId?: number;
  modelTarget: { provider: string; model: string; apiKey: string; baseUrl?: string } | null;
  onApplied(): Promise<void>;
  onBusyChange?(busy: boolean): void;
}

const COPY = {
  zh: {
    background: "确认后整批进入后台任务，可关闭窗口或切换项目继续创作；生成结果需手动采用。",
    submitting: "正在登记后台任务", submitted: "已进入后台任务，可关闭窗口或切换项目。", retry: "重试核对本批次", frozen: "本批次分镜和参数已锁定，重试会核对同一任务；请先核对后台任务再新建另一批次。", refreshTasks: "刷新后台任务", task: "查看后台任务",
    title: "高清关键帧精修", intro: "以裁剪后的单镜图片为基础，修复手脚、重复物体和商品结构，尽量保持人物、服装、构图与光线一致。",
    model: "本次精修模型", noModel: "请先在设置中配置可编辑图片的模型。", choose: "选择需要精修的分镜", all: "全选", none: "取消全选", shot: "分镜", missing: "缺少可用原图，请先生成或上传关键帧。",
    issues: "需要修复的问题", instructions: "补充修复说明", placeholder: "例如：去掉身后多余的椅子；修复可见腿部连接并保留自然遮挡；修正手指，保持原有手势。", resolution: "目标清晰度", dimensions: "以平台支持的实际输出尺寸为准。", cost: "每个所选分镜会新增一次图片生成费用，按当前平台和模型计费。点击下方生成按钮后才会提交；结果需手动采用。", generate: "生成高清候选", generating: "正在精修", selected: "已选", count: "镜", history: "已保存候选", loading: "正在读取候选…", refresh: "刷新已保存候选", original: "原图", candidate: "精修候选", current: "当前关键帧", apply: "采用为关键帧", restore: "恢复原图为关键帧", noCandidates: "生成后可在这里对比原图与高清候选，满意后再采用。", loadFailed: "读取已保存候选失败，请重试。", generateFailed: "图片精修失败，请稍后手动重试。", uncertain: "本次生成结果尚不明确。请先刷新已保存候选并核对结果，避免重复付费。", checked: "我已核对候选，允许重新生成", applyFailed: "采用关键帧失败，请刷新后重试。", applied: "已采用此关键帧", saved: "候选已保存，尚未采用", skipped: "上一镜生成结果不明，剩余分镜尚未提交。", preview: "查看大图", close: "完成", applyRefreshFailed: "关键帧已采用，列表刷新失败，请刷新页面查看。", retryHistory: "读取候选成功后可开始生成。", limited: "实际输出低于所选清晰度目标，请对照原图检查效果。",
  },
  en: {
    background: "The complete selection runs in the background after confirmation. Close this window or switch projects; apply candidates manually when ready.",
    submitting: "Registering background task", submitted: "Queued in the background. You can close this window or switch projects.", retry: "Check this submission again", frozen: "This submission's frames and settings are frozen. Retry checks the same task; review background tasks before starting another submission.", refreshTasks: "Refresh background tasks", task: "View background task",
    title: "Refine HD keyframes", intro: "Repair hands, anatomy, duplicate objects and product structure from each cropped frame, aiming to preserve identity, clothing, composition and lighting.",
    model: "Refinement model", noModel: "Configure an image editing model in Settings first.", choose: "Choose frames to refine", all: "Select all", none: "Clear selection", shot: "Shot", missing: "No source image. Generate or upload a keyframe first.",
    issues: "What should be repaired?", instructions: "Additional repair instructions", placeholder: "For example: remove the extra chair behind the person; repair visible leg connections while keeping natural occlusion; correct fingers without changing the gesture.", resolution: "Target resolution", dimensions: "Actual output dimensions depend on the platform.", cost: "Each selected shot adds one image generation charge at the current platform's rates. Requests start only when you click Generate. Review and apply the results manually.", generate: "Generate HD candidates", generating: "Refining", selected: "Selected", count: "shots", history: "Saved candidates", loading: "Loading candidates…", refresh: "Refresh saved candidates", original: "Original", candidate: "Refined candidate", current: "Current keyframe", apply: "Use as keyframe", restore: "Restore original keyframe", noCandidates: "Compare the original with the HD candidates here, then apply the result you prefer.", loadFailed: "Could not load saved candidates. Please try again.", generateFailed: "Image refinement failed. Please retry manually.", uncertain: "The generation outcome is unclear. Refresh and check saved candidates before generating again to avoid a duplicate charge.", checked: "I checked the candidates; allow generation again", applyFailed: "Could not apply the keyframe. Refresh and try again.", applied: "Keyframe applied", saved: "Candidate saved; not applied", skipped: "The previous shot's outcome is unclear. Remaining shots were not submitted.", preview: "Preview full image", close: "Done", applyRefreshFailed: "The keyframe was applied, but the list could not refresh. Reload the page to view it.", retryHistory: "Load saved candidates successfully before generating.", limited: "The actual output is below the selected resolution target. Compare it with the original before applying.",
  },
} as const;

type Shot = KeyframeRefinementDialogProps["shots"][number];
type History = { candidates: KeyframeRefinementCandidate[]; loading: boolean; loaded: boolean; error?: string };
type ShotResult = { message: string; failed?: boolean };

const TASK_LABELS: Record<"zh" | "en", Record<GenerationStatus, string>> = {
  zh: { queued: "排队中", running: "正在精修", waiting: "等待平台", importing: "正在保存候选", completed: "精修完成，候选已保存", failed: "精修失败", needs_attention: "需要处理，请在后台任务中恢复保存或核对原任务", cancelled: "已取消" },
  en: { queued: "Queued", running: "Refining", waiting: "Waiting for provider", importing: "Saving candidates", completed: "Refinement complete; candidate saved", failed: "Refinement failed", needs_attention: "Needs attention; recover the saved result or check the original task", cancelled: "Cancelled" },
};

const RETRY_HISTORY_COPY = { zh: "重试读取候选", en: "Retry loading candidates" } as const;

function initialCandidate(shot: Shot): KeyframeRefinementCandidate {
  return { id: shot.assetId, shotId: shot.shotId, filePath: shot.imageUrl, sourceKeyframeUrl: null, derivedFromAssetId: null, selected: true };
}

function originalCandidate(candidates: KeyframeRefinementCandidate[], sourceId: string) {
  let source = candidates.find((item) => item.id === sourceId);
  const visited = new Set<string>();
  while (source?.prompt?.startsWith("[keyframe-refine-v1]") && !visited.has(source.id)) {
    visited.add(source.id);
    const parent = candidates.find((item) => item.id === source?.derivedFromAssetId || item.filePath === source?.sourceKeyframeUrl);
    if (!parent) break;
    source = parent;
  }
  return source ?? candidates.find((item) => !item.prompt?.startsWith("[keyframe-refine-v1]"));
}

function errorText(body: unknown, fallback: string) {
  if (!body || typeof body !== "object") return fallback;
  const value = body as { error?: unknown; message?: unknown };
  return typeof value.error === "string" ? value.error : typeof value.message === "string" ? value.message : fallback;
}

/** A new source set creates a fresh session so an old response cannot replace a newer keyframe. */
export function KeyframeRefinementDialog(props: KeyframeRefinementDialogProps) {
  if (!props.open) return null;
  const sourceKey = JSON.stringify([props.projectId, props.scriptId, props.initialShotId, props.shots.map((shot) => [shot.shotId, shot.assetId, shot.imageUrl, shot.description])]);
  return <RefinementSession key={sourceKey} {...props} />;
}

function RefinementSession({ onOpenChange, projectId, scriptId, shots: inputShots, initialShotId, modelTarget, onApplied, onBusyChange }: KeyframeRefinementDialogProps) {
  const [shots] = useState(inputShots);
  const locale = useLocale() === "en" ? "en" : "zh";
  const copy = COPY[locale];
  const [selected, setSelected] = useState<number[]>(() => shots.filter((shot) => shot.assetId && shot.imageUrl && (initialShotId === undefined || shot.shotId === initialShotId)).map((shot) => shot.shotId));
  const [issues, setIssues] = useState<KeyframeRepairIssue[]>(["hands", "anatomy", "duplicates", "product"]);
  const [instructions, setInstructions] = useState("");
  const [resolution, setResolution] = useState<KeyframeRefinementResolution>("2k");
  const [histories, setHistories] = useState<Record<number, History>>(() => Object.fromEntries(shots.map((shot) => [shot.shotId, { candidates: shot.assetId && shot.imageUrl ? [initialCandidate(shot)] : [], loading: true, loaded: false }])));
  const [results, setResults] = useState<Record<number, ShotResult>>({});
  const [previewIds, setPreviewIds] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [submission, setSubmission] = useState<GenerationRunInput | null>(null);
  const [submissionError, setSubmissionError] = useState<string>();
  const [submittedNotice, setSubmittedNotice] = useState(false);
  const [accepted, setAccepted] = useState<GenerationRun[]>([]);
  const { runs, loading: tasksLoading, error: tasksError, refresh: refreshTasks } = useGenerationRuns(projectId);
  const [applyError, setApplyError] = useState<string>();
  const alive = useRef(true);
  const lock = useRef(false);
  const historyVersions = useRef(new Map<number, number>());
  const completedVersions = useRef(new Map<string, string>());
  const busyCallback = useRef(onBusyChange);
  useEffect(() => { busyCallback.current = onBusyChange; }, [onBusyChange]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (lock.current) busyCallback.current?.(false); }; }, []);

  const endpoint = `/api/project/${encodeURIComponent(projectId)}/keyframe-refine`;
  const loadHistory = useCallback(async (shot: Shot) => {
    const version = (historyVersions.current.get(shot.shotId) ?? 0) + 1;
    historyVersions.current.set(shot.shotId, version);
    setHistories((state) => ({ ...state, [shot.shotId]: { ...state[shot.shotId], loading: true, error: undefined } }));
    try {
      const response = await fetch(`${endpoint}?${new URLSearchParams({ scriptId, shotId: String(shot.shotId) })}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(errorText(body, copy.loadFailed));
      if (!Array.isArray(body.candidates)) throw new Error(copy.loadFailed);
      if (!alive.current || historyVersions.current.get(shot.shotId) !== version) return;
      const candidates = (body.candidates as KeyframeRefinementCandidate[]).filter((item) => item.shotId === shot.shotId && item.id && item.filePath);
      if (!candidates.some((item) => item.id === shot.assetId) && shot.assetId && shot.imageUrl) candidates.unshift(initialCandidate(shot));
      setHistories((state) => ({ ...state, [shot.shotId]: { candidates, loading: false, loaded: true } }));
    } catch (error) {
      if (!alive.current || historyVersions.current.get(shot.shotId) !== version) return;
      setHistories((state) => ({ ...state, [shot.shotId]: { ...state[shot.shotId], loading: false, loaded: false, error: error instanceof Error ? error.message : copy.loadFailed } }));
    }
  }, [endpoint, scriptId, copy.loadFailed]);

  useEffect(() => { for (const shot of shots) void loadHistory(shot); }, [shots, loadHistory]);

  const refinementRuns = useMemo(() => [...accepted.filter((run) => !runs.some((current) => current.id === run.id)), ...runs]
    .filter((run) => run.projectId === projectId && run.items.some((item) => item.kind === "keyframe_refine" && item.scriptId === scriptId)), [accepted, runs, projectId, scriptId]);
  const blockedShots = useMemo(() => new Set(refinementRuns.flatMap((run) => run.items.filter((item) => item.kind === "keyframe_refine" && item.scriptId === scriptId && item.shotId != null && ["queued", "running", "waiting", "importing", "needs_attention"].includes(item.status)).map((item) => item.shotId!))), [refinementRuns, scriptId]);
  const shotTasks = useMemo(() => {
    const tasks = new Map<number, { run: GenerationRun; item: GenerationRun["items"][number] }>();
    for (const run of refinementRuns) for (const item of run.items) {
      if (item.kind === "keyframe_refine" && item.scriptId === scriptId && item.shotId != null && !tasks.has(item.shotId)) tasks.set(item.shotId, { run, item });
    }
    return tasks;
  }, [refinementRuns, scriptId]);
  useEffect(() => {
    for (const run of refinementRuns) for (const item of run.items) {
      if (item.kind !== "keyframe_refine" || item.scriptId !== scriptId || item.status !== "completed") continue;
      const shot = shots.find((candidate) => candidate.shotId === item.shotId);
      const signature = JSON.stringify(item.result ?? {});
      if (!shot || completedVersions.current.get(item.id) === signature) continue;
      completedVersions.current.set(item.id, signature);
      const output = item.result?.resolution as { width?: number; height?: number; limited?: boolean } | undefined;
      setResults((state) => ({ ...state, [shot.shotId]: { message: `${copy.saved}${output?.width && output?.height ? ` · ${output.width} × ${output.height}` : ""}${output?.limited ? ` · ${copy.limited}` : ""}` } }));
      void loadHistory(shot);
    }
  }, [refinementRuns, scriptId, shots, loadHistory, copy.saved, copy.limited]);

  function setWorking(value: boolean) {
    lock.current = value;
    if (alive.current) { setBusy(value); busyCallback.current?.(value); }
  }

  const editModel = modelTarget ? resolveCharacterReferenceModel(modelTarget.provider, modelTarget.model, 1) : null;

  async function generate() {
    if (lock.current || !canGenerate) return;
    const chosen = shots.filter((shot) => selected.includes(shot.shotId) && !blockedShots.has(shot.shotId));
    const snapshot: GenerationRunInput = submission ?? {
      projectId, clientRequestId: crypto.randomUUID(), kind: chosen.length === 1 ? "keyframe_refine" : "keyframe_refine_batch",
      label: locale === "zh" ? `关键帧精修 · ${chosen.length} 镜` : `Keyframe refinement · ${chosen.length} shots`,
      items: chosen.map((shot) => ({ kind: "keyframe_refine", scriptId, shotId: shot.shotId, request: { scriptId, shotId: shot.shotId, sourceAssetId: shot.assetId, sourceImageUrl: shot.imageUrl, ...modelTarget, model: editModel?.ok ? editModel.modelId : "", issues: [...issues], instructions, resolution } })),
    };
    setSubmission(snapshot); setSubmissionError(undefined); setSubmittedNotice(false);
    setWorking(true); setApplyError(undefined);
    try {
      const run = await submitGenerationRun(snapshot);
      if (!alive.current) return;
      setAccepted((previous) => [run, ...previous.filter((item) => item.id !== run.id)]);
      const submittedShots = new Set(snapshot.items.map((item) => item.shotId));
      setSelected((previous) => previous.filter((shotId) => !submittedShots.has(shotId)));
      setResults((previous) => Object.fromEntries(Object.entries(previous).filter(([shotId]) => !submittedShots.has(Number(shotId)))));
      setSubmission(null); setSubmittedNotice(true);
    } catch (error) {
      if (alive.current) setSubmissionError(error instanceof Error ? error.message : copy.generateFailed);
    } finally { setWorking(false); }
  }

  async function apply(candidate: KeyframeRefinementCandidate) {
    if (lock.current || !alive.current) return;
    setWorking(true); setApplyError(undefined);
    let applied = false;
    try {
      const response = await fetch(`/api/project/${encodeURIComponent(projectId)}/assets`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assetId: candidate.id }) });
      const body = await response.json();
      if (!response.ok) throw new Error(errorText(body, copy.applyFailed));
      if (!alive.current) return;
      applied = true;
      setHistories((state) => ({ ...state, [candidate.shotId]: { ...state[candidate.shotId], candidates: state[candidate.shotId].candidates.map((item) => ({ ...item, selected: item.id === candidate.id })) } }));
      setResults((state) => ({ ...state, [candidate.shotId]: { message: copy.applied } }));
      await onApplied();
    } catch (error) {
      if (alive.current) setApplyError(applied ? copy.applyRefreshFailed : error instanceof Error ? error.message : copy.applyFailed);
    } finally { setWorking(false); }
  }

  const readyShots = shots.filter((shot) => shot.assetId && shot.imageUrl);
  const selectedReady = shots.filter((shot) => selected.includes(shot.shotId) && !blockedShots.has(shot.shotId));
  const failedSelectedHistories = selectedReady.filter((shot) => histories[shot.shotId]?.error && !histories[shot.shotId]?.loading);
  const firstHistoryFailure = failedSelectedHistories[0];
  const canGenerate = !!submission || (!tasksLoading && !tasksError && !!editModel?.ok && !!scriptId && (issues.length > 0 || !!instructions.trim()) && selectedReady.length > 0 && selectedReady.every((shot) => shot.assetId && shot.imageUrl && histories[shot.shotId]?.loaded && !histories[shot.shotId]?.loading));

  return <Dialog open onOpenChange={(value) => { if (!lock.current) onOpenChange(value); }}>
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl" showCloseButton={!busy}>
      <DialogHeader><DialogTitle>{copy.title}</DialogTitle></DialogHeader>
      <p className="text-sm text-muted-foreground">{copy.intro}</p>
      <p className="text-xs text-muted-foreground">{copy.background}</p>
      <div className="rounded-lg border bg-muted/20 p-3 text-sm"><p className="text-xs text-muted-foreground">{copy.model}</p>{modelTarget ? <><p aria-label={copy.model} className="mt-1 break-all font-medium">{modelTarget.provider} / {editModel?.ok ? editModel.modelId : modelTarget.model}</p>{!editModel?.ok && <p role="alert" className="mt-1 text-xs text-amber-600">{locale === "zh" ? "当前模型不支持图片精修，请在设置中选择支持参考图的 GPT Image 或 Seedream 模型。" : "This model does not support image refinement. Select a reference-capable GPT Image or Seedream model in Settings."}</p>}</> : <p role="alert" className="text-amber-600">{copy.noModel}</p>}</div>
      <fieldset disabled={busy || !!submission} className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><legend className="font-medium">{copy.choose} · {copy.selected} {selectedReady.length} / {readyShots.length} {copy.count}</legend><div className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => setSelected(readyShots.filter((shot) => !blockedShots.has(shot.shotId)).map((shot) => shot.shotId))}>{copy.all}</Button><Button size="sm" variant="ghost" onClick={() => setSelected([])}>{copy.none}</Button></div></div>
        <div className="grid max-h-48 gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">{shots.map((shot) => <label key={shot.shotId} className={`flex items-center gap-2 rounded-lg border p-2 ${selected.includes(shot.shotId) && !blockedShots.has(shot.shotId) ? "border-primary/60 bg-primary/5" : ""}`}><input type="checkbox" aria-label={`${copy.shot} ${shot.shotId}`} checked={selected.includes(shot.shotId) && !blockedShots.has(shot.shotId)} disabled={!shot.assetId || !shot.imageUrl || blockedShots.has(shot.shotId)} onChange={(event) => setSelected((state) => event.target.checked ? [...state, shot.shotId] : state.filter((item) => item !== shot.shotId))} />{shot.imageUrl && <Image unoptimized width={48} height={64} src={shot.imageUrl} alt="" className="h-16 w-12 rounded object-cover" />}<span className="min-w-0 text-xs"><span className="block font-medium">{copy.shot} {String(shot.shotId).padStart(2, "0")}</span><span className="line-clamp-2 text-muted-foreground">{shot.assetId && shot.imageUrl ? shot.description : copy.missing}</span></span></label>)}</div>
        <div><p className="mb-2 text-sm font-medium">{copy.issues}</p><div className="flex flex-wrap gap-2">{KEYFRAME_REPAIR_ISSUES.map((issue) => <label key={issue.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs"><input type="checkbox" checked={issues.includes(issue.id)} onChange={(event) => setIssues((state) => event.target.checked ? [...state, issue.id] : state.filter((item) => item !== issue.id))} />{issue.label[locale]}</label>)}</div></div>
        <label className="block space-y-1 text-sm"><span>{copy.instructions}</span><textarea aria-label={copy.instructions} className="min-h-20 w-full rounded-lg border bg-background p-2 text-sm" maxLength={2000} value={instructions} placeholder={copy.placeholder} onChange={(event) => setInstructions(event.target.value)} /></label>
        <div className="flex flex-wrap items-center gap-3 text-sm"><label>{copy.resolution}<select aria-label={copy.resolution} className="ml-2 rounded-md border bg-background p-2" value={resolution} onChange={(event) => setResolution(event.target.value as KeyframeRefinementResolution)}><option value="2k">2K</option><option value="4k">4K</option></select></label><span className="text-xs text-muted-foreground">{copy.dimensions}</span></div>
      </fieldset>
      {(tasksError || tasksLoading) && <div className="space-y-2"><p role={tasksError ? "alert" : "status"} className="text-xs text-amber-600">{tasksError || `${copy.refreshTasks}…`}</p>{tasksError && <Button size="sm" variant="outline" disabled={busy} onClick={() => void refreshTasks()}>{copy.refreshTasks}</Button>}</div>}
      {submissionError && <div className="space-y-1"><p role="alert" className="text-xs text-destructive">{submissionError}</p><p className="text-xs text-amber-600">{copy.frozen}</p></div>}
      {submittedNotice && <p role="status" className="text-xs text-muted-foreground">{copy.submitted}</p>}
      <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"><p className="text-xs leading-relaxed">{copy.cost}</p><Button disabled={busy || !canGenerate} onClick={() => void generate()}>{busy ? copy.submitting : submission ? copy.retry : `${copy.generate} · ${selectedReady.length} ${copy.count}`}</Button>{firstHistoryFailure ? <div className="space-y-2"><p role="alert" className="text-xs text-destructive">{copy.shot} {String(firstHistoryFailure.shotId).padStart(2, "0")}：{histories[firstHistoryFailure.shotId].error}</p><Button size="sm" variant="outline" disabled={busy} onClick={() => { for (const shot of failedSelectedHistories) void loadHistory(shot); }}>{RETRY_HISTORY_COPY[locale]}</Button></div> : selectedReady.some((shot) => !histories[shot.shotId]?.loaded) && <p className="text-xs text-muted-foreground">{copy.retryHistory}</p>}</div>
      {applyError && <p role="alert" className="text-sm text-destructive">{applyError}</p>}
      <div className="space-y-5">{shots.map((shot) => {
        const history = histories[shot.shotId];
        const candidates = history?.candidates ?? [];
        const original = originalCandidate(candidates, shot.assetId);
        const refined = candidates.filter((item) => item.id !== original?.id && item.prompt?.startsWith("[keyframe-refine-v1]"));
        const preview = refined.find((item) => item.id === previewIds[shot.shotId]) ?? refined.at(-1);
        const result = results[shot.shotId];
        const task = shotTasks.get(shot.shotId);
        return <section key={shot.shotId} aria-label={`${copy.shot} ${shot.shotId} ${copy.history}`} className="space-y-3 rounded-xl border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{copy.shot} {String(shot.shotId).padStart(2, "0")} · {copy.history}</h3><Button size="sm" variant="outline" disabled={busy || history?.loading} onClick={() => void loadHistory(shot)}>{copy.refresh}</Button></div>
          {history?.loading && <p role="status" className="text-xs text-muted-foreground">{copy.loading}</p>}
          {history?.error && <p role="alert" className="text-xs text-destructive">{history.error}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2"><p className="text-xs text-muted-foreground">{copy.original}{original?.selected ? ` · ${copy.current}` : ""}</p>{original ? <><AssetImagePreview src={original.filePath} alt={`${copy.shot} ${shot.shotId} ${copy.original}`} shotId={shot.shotId} title={`${copy.shot} ${shot.shotId} ${copy.original} · ${copy.preview}`} className="block w-full rounded-lg"><Image unoptimized width={640} height={640} src={original.filePath} alt={`${copy.shot} ${shot.shotId} ${copy.original}`} className="h-64 w-full rounded-lg bg-black/20 object-contain sm:h-80" /></AssetImagePreview><Button variant="outline" size="sm" disabled={busy || original.selected} onClick={() => void apply(original)}>{copy.restore}</Button></> : <p className="text-xs text-muted-foreground">{copy.missing}</p>}</div>
            <div className="space-y-2"><p className="text-xs text-muted-foreground">{copy.candidate}{preview?.selected ? ` · ${copy.current}` : ""}</p>{preview ? <><AssetImagePreview src={preview.filePath} alt={`${copy.shot} ${shot.shotId} ${copy.candidate}`} shotId={shot.shotId} title={`${copy.shot} ${shot.shotId} ${copy.candidate} · ${copy.preview}`} className="block w-full rounded-lg"><Image unoptimized width={640} height={640} src={preview.filePath} alt={`${copy.shot} ${shot.shotId} ${copy.candidate}`} className="h-64 w-full rounded-lg bg-black/20 object-contain sm:h-80" /></AssetImagePreview><div className="flex flex-wrap gap-2"><select aria-label={`${copy.shot} ${shot.shotId} ${copy.candidate}`} disabled={busy} value={preview.id} className="min-w-0 flex-1 rounded-md border bg-background p-1 text-xs" onChange={(event) => setPreviewIds((state) => ({ ...state, [shot.shotId]: event.target.value }))}>{refined.map((item, index) => <option key={item.id} value={item.id}>{copy.candidate} {index + 1}{item.selected ? ` · ${copy.current}` : ""}</option>)}</select><Button size="sm" disabled={busy || preview.selected} onClick={() => void apply(preview)}>{copy.apply}</Button></div></> : <div className="flex h-64 items-center justify-center rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground sm:h-80">{copy.noCandidates}</div>}</div>
          </div>
          {result && <p role={result.failed ? "alert" : "status"} className={`text-xs ${result.failed ? "text-destructive" : "text-muted-foreground"}`}>{result.message}</p>}
          {task && <div className="space-y-1 text-xs" aria-label={`${copy.shot} ${shot.shotId} ${copy.task}`}><p role={task.item.error ? "alert" : "status"}>{TASK_LABELS[locale][task.item.status]}{task.item.error ? ` · ${task.item.error}` : ""}</p><a href={`/project/${encodeURIComponent(projectId)}/assets?runId=${encodeURIComponent(task.run.id)}`} className="text-primary underline">{copy.task}</a></div>}
        </section>;
      })}</div>
      <div className="flex justify-end"><Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{copy.close}</Button></div>
    </DialogContent>
  </Dialog>;
}
