"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { klingJobStatus } from "@/components/kling-job-detail";
import { klingErrorMessage, klingFetch } from "@/lib/kling/client";
import type { KlingJobView } from "@/lib/kling/job-types";

function deletionBlocked(job: KlingJobView): boolean {
  return !job.allowedActions?.includes("delete");
}

export function KlingJobsList({ jobs, onOpenJob, onRefresh, onDeleted }: {
  jobs: KlingJobView[];
  onOpenJob(jobId: string): void;
  onRefresh(): Promise<void>;
  onDeleted(jobId: string): Promise<void>;
}) {
  const [pending, setPending] = useState<KlingJobView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deletingRef = useRef(false);
  const current = pending && jobs.find((job) => job.jobId === pending.jobId);
  const confirmationJob = current ?? pending;
  const cloudTaskUnfinished = confirmationJob && confirmationJob.submissionState !== "not_submitted"
    && (["prepared", "submitting", "submission_unknown"].includes(confirmationJob.submissionState)
      || !["completed", "failed", "cancelled"].includes(confirmationJob.remoteState));

  async function deleteJob() {
    if (!pending || !current || deletionBlocked(current) || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true); setError(null);
    try {
      const response = await klingFetch(`/api/integrations/kling/jobs/${encodeURIComponent(pending.jobId)}`, { method: "DELETE" });
      const body = await response.json();
      if (!response.ok) throw new Error(klingErrorMessage(body, "删除任务失败，请重试。"));
      await onDeleted(pending.jobId);
      setPending(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "删除任务失败，请重试。");
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  }

  return <>
    {jobs.length > 0 && <section aria-label="Kling 视频任务" className="mb-5 space-y-2 rounded-xl border border-border/60 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Kling 单镜头任务</h3>
        <button type="button" className="text-xs text-primary" onClick={() => void onRefresh()}>刷新本地记录</button>
      </div>
      {jobs.map((job) => <div key={job.jobId} className={`flex min-h-11 items-center gap-2 rounded-lg border p-2 text-xs ${job.blockedReason || job.submissionState === "submission_unknown" || job.importState === "failed" ? "border-amber-500/40 bg-amber-500/5" : "border-border/50"}`}>
        <button type="button" className="flex min-h-8 min-w-0 flex-1 flex-wrap items-center justify-between gap-2 text-left" onClick={() => onOpenJob(job.jobId)}>
          <span>镜头 {job.shotId} · {job.modelId}</span>
          <span className="font-medium">{klingJobStatus(job)} · 查看 / 恢复</span>
        </button>
        <button type="button" aria-label={`删除镜头 ${job.shotId} 的任务`} className="shrink-0 rounded-md px-2 py-1.5 text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40" disabled={deleting || deletionBlocked(job)} title={deletionBlocked(job) ? "任务正在处理或被其他任务使用，暂不能删除" : "删除本地任务和生成的视频"} onClick={() => { setPending(job); setError(null); }}>删除</button>
      </div>)}
    </section>}
    <Dialog open={pending !== null} onOpenChange={(open) => { if (!open && !deletingRef.current) { setPending(null); setError(null); } }}>
      <DialogContent showCloseButton={!deleting}>
        <DialogHeader><DialogTitle>删除任务？</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">将删除镜头 {pending?.shotId} 的本地任务记录，停止自动查询，并清理该任务已生成的本地视频。此操作无法撤销。</p>
        {cloudTaskUnfinished && <p className="text-sm text-amber-600">云端任务可能继续运行，删除不等于取消云端生成。</p>}
        {current && deletionBlocked(current) && <p role="alert" className="text-sm text-destructive">任务正在处理或被其他任务使用，暂不能删除。</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={deleting} onClick={() => { setPending(null); setError(null); }}>取消</Button>
          <Button type="button" variant="destructive" disabled={deleting || !current || deletionBlocked(current)} onClick={() => void deleteJob()}>{deleting ? "正在删除…" : "确认删除"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
