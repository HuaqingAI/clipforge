"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { VideoGenerationFailure } from "@/components/video-generation-dialog";
import { prepareBatchMotionKling, type BatchMotionShot } from "@/lib/batch-motion";
import { klingAudioPrompt } from "@/lib/kling/audio-prompt";
import { klingErrorMessage, klingFetch } from "@/lib/kling/client";
import { KLING_MAX_CONCURRENT_SHOTS } from "@/lib/kling/concurrency";
import type { KlingSubmitRequest } from "@/lib/kling/job-types";
import type { KlingPublicStatus } from "@/lib/kling/types";
import { videoParameterLabel, videoParameterValueLabel } from "@/lib/video-parameter-copy";
import { validateVideoPrompt } from "@/lib/video-prompt";

type RowStatus = "pending" | "submitting" | "submitted" | "completed" | "failed" | "uncertain";
type Row = BatchMotionShot & { selected: boolean; state: RowStatus; message?: string; taskId?: string };
const stateLabel: Record<RowStatus, string> = { pending: "待提交", submitting: "正在提交", submitted: "已提交", completed: "已完成", failed: "提交失败", uncertain: "提交结果待核对" };

function verifiedCatalog(status: KlingPublicStatus, profileId: string | undefined, selectionKey: string) {
  const profile = status.profile;
  return Boolean(status.loggedIn && status.configured && profile && (!profileId || profile.id === profileId)
    && !profile.disabledAt && profile.environmentState === "ready" && profile.authState === "authenticated"
    && profile.principalKey && profile.catalogRevision && profile.catalogCheckedAt
    && status.models.some((model) => model.selectionKey === selectionKey && model.profileId === profile.id && model.catalogRevision === profile.catalogRevision && model.available));
}

export function BatchMotionPanel({ open, onOpenChange, projectId, scriptId, modelLabel, selectionKey, profileId, provider, shots, valid, onRefreshTasks, onSubmitted, onUncertain, onBusyChange }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  projectId: string;
  scriptId: string;
  modelLabel: string;
  selectionKey: string;
  profileId?: string;
  provider: string;
  shots: BatchMotionShot[];
  valid: boolean;
  onRefreshTasks(): Promise<void>;
  onSubmitted(shotId: number, jobId?: string): void;
  onUncertain?(shotId: number, taskId?: string): void;
  onBusyChange?(busy: boolean): void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<KlingPublicStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const session = useRef("");
  const lock = useRef(false);
  const alive = useRef(true);
  const isKling = provider === "kling-cli";
  const currentValid = useRef(valid);
  currentValid.current = valid;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    if (!open) { session.current = ""; return; }
    const key = JSON.stringify([projectId, scriptId, selectionKey, profileId, provider]);
    if (session.current === key || lock.current) return;
    session.current = key;
    setRows(shots.map((shot) => ({ ...shot, selected: Boolean(shot.draft && !shot.disabledReason), state: "pending" })));
    setConfirmed(false); setError(null);
  }, [open, projectId, scriptId, selectionKey, profileId, provider, shots]);

  useEffect(() => {
    if (!open || !isKling) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshNeeded = true;
    let refreshFailed = false;
    setStatus(null); setLoading(true); setError(null); setNotice(null);
    const poll = async () => {
      try {
        const response = await klingFetch(`/api/integrations/kling/status${profileId ? `?profileId=${encodeURIComponent(profileId)}` : ""}`, { signal: controller.signal });
        let next = await response.json() as KlingPublicStatus;
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error(klingErrorMessage(next));
        if (refreshNeeded && next.loggedIn && next.profile?.id) {
          try {
            const refreshed = await klingFetch("/api/integrations/kling/refresh", { method: "POST", body: JSON.stringify({ profileId: next.profile.id, credits: false }), signal: controller.signal });
            const body = await refreshed.json();
            if (controller.signal.aborted) return;
            if (!refreshed.ok) {
              if (body?.error?.code === "KLING_PROFILE_BUSY") {
                setStatus(!refreshFailed && verifiedCatalog(next, profileId, selectionKey) ? next : null);
                setNotice("Kling 正在处理其他操作，模型刷新将自动重试；已验证的模型可继续使用。");
                return;
              }
              throw new Error(klingErrorMessage(body));
            }
            next = body as KlingPublicStatus; refreshNeeded = false; refreshFailed = false;
          } catch (failure) {
            refreshFailed = true; setStatus(null); setNotice(null); throw failure;
          }
        }
        if (!controller.signal.aborted) { setStatus(next); setError(null); setNotice(null); }
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "读取 Kling 模型失败");
      } finally {
        if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(poll, 5000); }
      }
    };
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [open, isKling, profileId, selectionKey]);

  const model = status?.models.find((item) => item.selectionKey === selectionKey && item.profileId === status.profile?.id && item.catalogRevision === status.profile?.catalogRevision);
  const modelConfiguration = JSON.stringify([model, status?.profile?.authRevision, status?.profile?.principalKey]);
  const latestModelConfiguration = useRef(modelConfiguration);
  latestModelConfiguration.current = modelConfiguration;
  useEffect(() => { setConfirmed(false); }, [modelConfiguration, valid]);
  const compatible = Boolean(model?.available && model.tool === "image_to_video" && model.capabilities.image);
  const modelReady = !isKling || Boolean(status && verifiedCatalog(status, profileId, selectionKey) && compatible);
  const capacity = status?.concurrency;
  const remaining = capacity ? Math.max(0, Math.min(KLING_MAX_CONCURRENT_SHOTS, capacity.max) - capacity.active) : 0;
  const unresolved = rows.some((row) => row.state === "uncertain");
  function rowIssue(row: Row) {
    if (row.disabledReason) return row.disabledReason;
    if (!row.draft?.firstFrameUrl) return "请先生成此分镜的关键帧";
    if (isKling && model) return prepareBatchMotionKling(row.draft, model).error;
    return validateVideoPrompt(klingAudioPrompt(row.draft.prompt, false)).map((issue) => issue.message).join(" ");
  }
  const eligible = rows.filter((row) => ["pending", "failed"].includes(row.state) && !rowIssue(row));
  const selected = eligible.filter((row) => row.selected);
  const capacityBlocked = isKling && (!capacity || capacity.blockedByUnknownSubmission || selected.length > remaining);
  const canSubmit = Boolean(valid && scriptId && selected.length && confirmed && modelReady && !loading && !busy && !capacityBlocked && !unresolved);
  const successCount = rows.filter((row) => row.state === "submitted" || row.state === "completed").length;
  const failedCount = rows.filter((row) => row.state === "failed" || row.state === "uncertain").length;
  const started = rows.some((row) => row.state !== "pending");

  function updateRow(shotId: number, update: Partial<Row>) {
    setRows((previous) => previous.map((row) => row.asset.shotId === shotId ? { ...row, ...update } : row));
  }

  async function submit() {
    if (!canSubmit || lock.current) return;
    lock.current = true; setBusy(true); onBusyChange?.(true); setConfirmed(false); setError(null);
    const submissionModelConfiguration = modelConfiguration;
    try {
      for (const row of selected) {
        if (!alive.current) break;
        if (isKling && submissionModelConfiguration !== latestModelConfiguration.current) { setError("Kling 账号或模型目录已更改，请关闭后重新打开批量转动态。"); break; }
        if (!currentValid.current) { setError("视频模型或生成设置已更改，请关闭后重新打开批量转动态。"); break; }
        const draft = row.draft!;
        if (draft.validate && !draft.validate()) { setError(`分镜 ${row.asset.shotId} 的素材或生成设置已更改，请关闭后重新打开批量转动态。`); break; }
        updateRow(row.asset.shotId, { state: "submitting", message: undefined, taskId: undefined });
        let uncertain = false;
        try {
          if (isKling && model) {
            const prepared = prepareBatchMotionKling(draft, model);
            const clientRequestId = crypto.randomUUID();
            const request: KlingSubmitRequest = {
              provider: "kling-cli", profileId: model.profileId, clientRequestId, executionScope: "single-shot", projectId, scriptId,
              shotId: row.asset.shotId, selectionKey: model.selectionKey, mode: "image-to-video", prompt: prepared.prompt, options: prepared.options,
              imageUrl: prepared.images[0], ...(prepared.images.length > 1 && { referenceImageUrls: prepared.images.slice(1) }),
              ...(prepared.lastImageUrl && { lastImageUrl: prepared.lastImageUrl }), expectedSelectedAssetId: row.asset.assetId ?? null,
              billingAcknowledgement: { policyRevision: "credits-v1", acceptedForRequestId: clientRequestId },
            };
            uncertain = true;
            const response = await klingFetch("/api/ai/video", { method: "POST", body: JSON.stringify(request) });
            const body = await response.json();
            const jobId = typeof body.jobId === "string" ? body.jobId : typeof body.error?.jobId === "string" ? body.error.jobId : undefined;
            if (response.ok && jobId) {
              updateRow(row.asset.shotId, { state: "submitted", taskId: jobId, selected: false });
              setStatus((previous) => previous?.concurrency ? { ...previous, concurrency: { ...previous.concurrency, active: previous.concurrency.active + 1 } } : previous);
              onSubmitted(row.asset.shotId, jobId); continue;
            }
            // Error job IDs can identify another shot's unresolved account task.
            // Keep them for reconciliation without reporting this shot as submitted.
            if (!response.ok && jobId) throw new VideoGenerationFailure(klingErrorMessage(body, "提交被已有任务阻止，请先核对任务列表"), true, jobId);
            if (!response.ok) { uncertain = response.status >= 500; throw new Error(klingErrorMessage(body, "提交失败")); }
            throw new Error("未取得本地作业 ID，请先核对任务列表");
          }
          uncertain = true;
          await draft.generate();
          updateRow(row.asset.shotId, { state: "completed", selected: false });
          onSubmitted(row.asset.shotId);
        } catch (failure) {
          const knownFailure = failure instanceof VideoGenerationFailure ? failure : null;
          if (knownFailure) uncertain = knownFailure.uncertain || Boolean(knownFailure.taskId);
          updateRow(row.asset.shotId, { state: uncertain ? "uncertain" : "failed", message: failure instanceof Error ? failure.message : "提交结果待核对", taskId: knownFailure?.taskId });
          if (uncertain) { onUncertain?.(row.asset.shotId, knownFailure?.taskId); break; }
        }
      }
    } finally {
      try { await onRefreshTasks(); } catch { setError("任务列表刷新失败，请通过任务恢复入口核对结果。"); }
      lock.current = false; setBusy(false); onBusyChange?.(false);
    }
  }

  return <Dialog open={open} onOpenChange={(value) => { if (!lock.current) onOpenChange(value); }}>
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl" showCloseButton={!busy}>
      <DialogHeader><DialogTitle>批量转动态</DialogTitle></DialogHeader>
      <p className="text-sm text-muted-foreground">勾选要转动态的分镜，使用各自的当前关键帧生成视频。</p>
      <p className="break-all text-xs text-muted-foreground">视频模型：{modelLabel}</p>
      {loading && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" />正在读取当前账号可用模型…</p>}
      {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!valid && <p role="alert" className="text-sm text-amber-600">视频模型或生成设置已更改，请关闭后重新打开批量转动态。</p>}
      {isKling && !loading && !modelReady && <p role="alert" className="text-sm text-amber-600">请在设置页登录当前 Kling 账号，并选择该账号可用的图生视频模型。</p>}
      {isKling && capacity && <p role="status" className="text-xs text-muted-foreground">当前账号生成名额：{capacity.active} / {Math.min(capacity.max, KLING_MAX_CONCURRENT_SHOTS)}，还可提交 {remaining} 个镜头。</p>}
      {isKling && !loading && !capacity && <p role="alert" className="text-sm text-amber-600">暂未取得账号生成名额，请等待状态刷新。</p>}
      {capacity?.blockedByUnknownSubmission && <p role="alert" className="text-sm text-amber-600">此账号有提交结果不明的任务，请先核对原任务再继续。</p>}
      {isKling && capacity && selected.length > remaining && <p role="alert" className="text-sm text-amber-600">已选 {selected.length} 个分镜，当前还可提交 {remaining} 个，请减少勾选或等待已有任务完成。</p>}
      <div className="flex items-center justify-between gap-2"><p className="text-sm">已选 {selected.length} / {eligible.length} 个可提交分镜</p><div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy || !eligible.length || unresolved} onClick={() => { const ids = new Set(eligible.map((row) => row.asset.shotId)); setRows((previous) => previous.map((row) => ids.has(row.asset.shotId) ? { ...row, selected: true } : row)); setConfirmed(false); }}>全选</Button><Button size="sm" variant="ghost" disabled={busy || !selected.length} onClick={() => { setRows((previous) => previous.map((row) => ({ ...row, selected: false }))); setConfirmed(false); }}>取消全选</Button></div></div>
      <div className="space-y-3">{rows.map((row) => {
        const issue = rowIssue(row);
        const selectable = ["pending", "failed"].includes(row.state) && !issue;
        const prepared = isKling && row.draft && model ? prepareBatchMotionKling(row.draft, model) : undefined;
        const parameters = prepared?.options ?? row.draft?.options ?? {};
        return <div key={row.asset.shotId} className="rounded-lg border p-3" data-shot-id={row.asset.shotId}>
          <div className="flex gap-3"><input aria-label={`选择分镜 ${row.asset.shotId}`} type="checkbox" className="mt-1" checked={row.selected && selectable} disabled={busy || !selectable || unresolved} onChange={(event) => { updateRow(row.asset.shotId, { selected: event.target.checked }); setConfirmed(false); }} />
            {row.draft?.firstFrameUrl && <img src={row.draft.firstFrameUrl} alt={`分镜 ${row.asset.shotId} 当前关键帧`} className="h-24 w-16 shrink-0 rounded bg-muted object-contain" />}
            <div className="min-w-0 flex-1 space-y-1"><p className="flex items-center gap-2 text-sm font-medium">分镜 {String(row.asset.shotId).padStart(2, "0")}<span className="text-xs font-normal text-muted-foreground">{row.state === "submitting" && <Loader2 className="mr-1 inline size-3 animate-spin" />}{stateLabel[row.state]}</span></p><p className="text-sm">{row.asset.description}</p><p className="text-xs text-muted-foreground">{Object.entries(parameters).filter(([name, value]) => /duration|resolution|aspect|ratio|quality/i.test(name) && value !== undefined).map(([name, value]) => `${videoParameterLabel(name)}：${videoParameterValueLabel(name, value)}`).join(" · ")}</p>
              {(issue || row.message) && <p role="alert" className="text-xs text-destructive">{row.message || issue}</p>}{row.taskId && <p className="break-all text-xs text-muted-foreground">任务 ID：{row.taskId}</p>}
              {prepared?.warnings.map((warning) => <p key={warning} className="text-xs text-amber-600">{warning}</p>)}
            </div></div>
          {row.draft && <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">查看本分镜提示词与参考图</summary><p className="mt-2 whitespace-pre-wrap break-words">{prepared?.prompt ?? klingAudioPrompt(row.draft.prompt, false)}</p><div className="mt-2 flex flex-wrap gap-2">{[...new Set([row.draft.lastFrameUrl, ...row.draft.referenceImages].filter((url): url is string => Boolean(url) && url !== row.draft!.firstFrameUrl))].map((url, index) => <img key={url} src={url} alt={`分镜 ${row.asset.shotId} 参考图片 ${index + 1}`} className="h-16 max-w-24 rounded object-contain" />)}</div></details>}
        </div>;
      })}</div>
      {!rows.length && <p className="text-sm text-muted-foreground">暂无可转动态的分镜，请先生成关键帧。</p>}
      {started && <p role="status" className="text-sm">已提交或完成 {successCount} 个，失败或待核对 {failedCount} 个。{busy && "正在处理所选分镜，请勿重复操作…"}</p>}
      {unresolved ? <div className="space-y-2"><p className="text-sm text-amber-600">请先通过任务恢复入口核对原任务，避免重复提交。</p><Button variant="outline" disabled={busy} onClick={() => void onRefreshTasks().catch(() => setError("任务列表刷新失败，请稍后重试。"))}>核对任务列表</Button></div> : <>
        <label className="flex items-start gap-2 rounded-md border border-amber-500/30 p-3 text-sm"><input aria-label="确认批量生成费用" type="checkbox" className="mt-1" checked={confirmed} disabled={busy || !selected.length} onChange={(event) => setConfirmed(event.target.checked)} />我已核对所选分镜、模型和参考图，确认本次生成可能产生费用。</label>
        <Button disabled={!canSubmit} onClick={() => void submit()}>{busy ? <><Loader2 className="size-4 animate-spin" />批量提交中…</> : `确认提交 ${selected.length} 个分镜转动态`}</Button>
      </>}
    </DialogContent>
  </Dialog>;
}
