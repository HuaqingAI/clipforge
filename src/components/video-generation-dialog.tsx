"use client";

import { useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { videoParameterLabel, videoParameterValueLabel } from "@/lib/video-parameter-copy";
import { validateVideoPrompt } from "@/lib/video-prompt";

/** Shared confirmation surface for the configured video provider. */
export function VideoGenerationDialog({ open, onOpenChange, shotId, modelLabel, busy = false, children }: {
  open: boolean; onOpenChange(open: boolean): void; shotId?: number; modelLabel: string; busy?: boolean; children: ReactNode;
}) {
  return <Dialog open={open} onOpenChange={(value) => { if (!busy) onOpenChange(value); }}>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl" showCloseButton={!busy}>
      <DialogHeader><DialogTitle>确认镜头 {shotId} 视频生成</DialogTitle></DialogHeader>
      <p className="text-xs text-muted-foreground">使用设置页的默认视频模型。请核对提示词、关联图片和参数后确认生成。</p>
      <div className="rounded-md border bg-muted/20 p-3 text-sm"><span className="text-muted-foreground">默认视频模型：</span><span aria-label="默认视频模型" className="break-all">{modelLabel}</span></div>
      {children}
    </DialogContent>
  </Dialog>;
}

export class VideoGenerationFailure extends Error {
  constructor(message: string, readonly uncertain = false, readonly taskId?: string) { super(message); }
}

export function ApiShotGenerator({ shotId, modelLabel, prompt, images, options, onOpenChange, onGenerate, onRefreshTasks }: {
  shotId: number; modelLabel: string; prompt: string; images: Array<{ label: string; url: string }>;
  options: Record<string, unknown>; onOpenChange(open: boolean): void;
  onGenerate(): Promise<void>; onRefreshTasks(): Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<VideoGenerationFailure | null>(null);
  const lock = useRef(false);
  const promptIssues = validateVideoPrompt(prompt);
  async function submit() {
    if (!confirmed || promptIssues.length || busy || lock.current || failure?.uncertain || failure?.taskId) return;
    lock.current = true; setBusy(true); setFailure(null);
    try { await onGenerate(); onOpenChange(false); }
    catch (error) {
      const next = error instanceof VideoGenerationFailure ? error : new VideoGenerationFailure(error instanceof Error ? error.message : "视频生成结果待核对", true);
      setFailure(next);
      if (next.uncertain || next.taskId) await onRefreshTasks();
    } finally { lock.current = false; setBusy(false); setConfirmed(false); }
  }
  const needsRecovery = Boolean(failure?.uncertain || failure?.taskId);
  return <VideoGenerationDialog open onOpenChange={onOpenChange} shotId={shotId} modelLabel={modelLabel} busy={busy}>
    <label className="space-y-1 text-sm"><span>实际提交的提示词</span><textarea aria-label="视频提示词" rows={12} className="min-h-64 w-full rounded-md border bg-background p-2 leading-relaxed" value={prompt} readOnly /></label>
    {promptIssues.length > 0 && <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive"><p>请修改分镜内容或生成设置后再提交：</p><ul className="list-inside list-disc">{promptIssues.map((issue) => <li key={issue.code}>{issue.message}</li>)}</ul></div>}
    <div className="flex flex-wrap gap-3">{images.map((image, index) => <figure key={`${image.label}-${index}`} className="space-y-1 text-xs"><img src={image.url} alt={image.label} className="h-24 max-w-40 rounded border object-contain" /><figcaption>{image.label}</figcaption></figure>)}</div>
    <div className="rounded-md border p-3 text-sm"><p className="mb-2 font-medium">实际生成参数</p><dl className="grid gap-2 sm:grid-cols-2">{Object.entries(options).filter(([, value]) => value !== undefined && value !== "").map(([name, value]) => <div key={name}><dt className="inline text-muted-foreground">{videoParameterLabel(name)}：</dt><dd className="inline break-all">{videoParameterValueLabel(name, value)}</dd></div>)}</dl></div>
    <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3"><p className="text-sm">此操作会向当前视频平台提交生成任务，可能产生费用。实际扣费以平台为准。</p><label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={confirmed} disabled={busy || needsRecovery} onChange={(event) => setConfirmed(event.target.checked)} />我已核对当前镜头、模型、图片和参数，确认本次生成可能产生费用。</label></div>
    {failure && <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{failure.message}{failure.taskId && <span className="block break-all">任务 ID：{failure.taskId}</span>}</p>}
    {needsRecovery ? <div className="space-y-2"><p className="text-sm text-amber-600">请先核对原任务并通过任务恢复入口查询结果，避免重复付费生成。</p><Button variant="outline" onClick={() => void onRefreshTasks()}>核对任务列表</Button></div> : <Button disabled={!confirmed || busy || promptIssues.length > 0} onClick={() => void submit()}>{busy ? "正在生成视频，请勿重复操作…" : "确认生成此镜头（可能计费）"}</Button>}
  </VideoGenerationDialog>;
}
