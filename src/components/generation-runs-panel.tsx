"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import Link from "next/link";
import { generationRunActive, generationRunDeletable, rememberDeletedGenerationRuns, useGenerationRuns, type GenerationRun, type GenerationStatus } from "@/lib/hooks/use-generation-runs";

const statusLabels: Record<GenerationStatus, string> = { queued: "排队中", running: "生成中", waiting: "等待平台", importing: "保存中", completed: "已完成", failed: "失败", needs_attention: "需要处理", cancelled: "已取消" };
const kindLabels = { video_batch: "批量转动态", video: "镜头视频", image: "镜头图片", storyboard_grid: "九宫格分镜", script: "脚本文案", keyframe_refine: "关键帧精修", keyframe_refine_batch: "批量关键帧精修" };
const stageLabels: Record<string, string> = { starting: "准备生成", submitting: "提交平台", cloud_running: "平台生成中", importing: "保存素材", queued: "等待开始", waiting: "等待平台", completed: "已完成" };

function refinementCandidatePath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/api/files/")) return null;
  let decoded = value;
  try {
    for (let index = 0; index < 3; index += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch { return null; }
  if (!decoded.startsWith("/api/files/") || /[\\?#\u0000-\u001f]/.test(decoded) || decoded.split("/").some((segment) => segment === "." || segment === "..") || /%[0-9a-f]{2}/i.test(decoded)) return null;
  return value;
}

export function GenerationRunsPanel({ projectId, onCompleted }: { projectId: string; onCompleted?(run: GenerationRun): void | Promise<void> }) {
  return <GenerationRunsSession key={projectId} projectId={projectId} onCompleted={onCompleted} />;
}

function GenerationRunsSession({ projectId, onCompleted }: { projectId: string; onCompleted?(run: GenerationRun): void | Promise<void> }) {
  const { runs, loading, error, refresh, cancelRun, retryImport, deleteRun, clearFinished, isRunDeleted } = useGenerationRuns(projectId);
  const requestedId = useSearchParams().get("runId");
  const [linked, setLinked] = useState<GenerationRun | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const actionLock = useRef(false);
  const alive = useRef(true);
  const signatures = useRef(new Map<string, string>());
  const completed = useRef(onCompleted); completed.current = onCompleted;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!requestedId || isRunDeleted(requestedId) || runs.some((run) => run.id === requestedId)) { setLinked(null); return; }
    const controller = new AbortController();
    void fetch(`/api/generation-runs/${encodeURIComponent(requestedId)}`, { signal: controller.signal, cache: "no-store" }).then(async (response) => {
      const run = await response.json();
      if (response.status === 410 && !controller.signal.aborted) { rememberDeletedGenerationRuns(projectId, [requestedId]); setLinked(null); return; }
      if (!response.ok) throw new Error(typeof run.error === "string" ? run.error : "找不到后台任务");
      if (!controller.signal.aborted && run.projectId === projectId && !isRunDeleted(run.id)) setLinked(run);
    }).catch((failure) => { if (!controller.signal.aborted) setActionError(failure instanceof Error ? failure.message : "读取后台任务失败"); });
    return () => controller.abort();
  }, [requestedId, runs, projectId, isRunDeleted]);
  useEffect(() => {
    for (const run of linked ? [linked, ...runs] : runs) {
      if (run.projectId !== projectId || isRunDeleted(run.id)) continue;
      const signature = JSON.stringify(run.items.filter((item) => item.status === "completed").map((item) => [item.id, item.result]));
      if (signature !== "[]" && signatures.current.get(run.id) !== signature) {
        signatures.current.set(run.id, signature);
        void Promise.resolve(completed.current?.(run)).catch(() => { if (alive.current) setActionError("任务已完成，刷新素材失败，请重新读取。"); });
      }
    }
  }, [runs, linked, projectId, isRunDeleted]);
  const shown = (linked && !runs.some((run) => run.id === linked.id) ? [linked, ...runs] : runs).filter((run) => run.projectId === projectId && !isRunDeleted(run.id));
  const cleanable = shown.filter(generationRunDeletable);
  async function actOn(run: GenerationRun, action: "cancel" | "retry_import" | "delete") {
    if (actionLock.current || (action === "delete" && !generationRunDeletable(run))) return;
    actionLock.current = true; setBusy(`${action}:${run.id}`); setActionError(null); setNotice(null);
    try {
      if (action === "delete") { await deleteRun(run.id); if (alive.current) { setLinked((current) => current?.id === run.id ? null : current); setNotice("任务记录已删除，生成素材已保留。"); } }
      else await (action === "cancel" ? cancelRun(run.id) : retryImport(run.id));
    }
    catch (failure) { if (alive.current) setActionError(failure instanceof Error ? failure.message : "操作失败"); }
    finally { actionLock.current = false; if (alive.current) setBusy(null); }
  }
  async function cleanup() {
    if (actionLock.current) return;
    actionLock.current = true; setBusy("cleanup"); setActionError(null); setNotice(null);
    try {
      const result = await clearFinished();
      if (alive.current) { setLinked((current) => current && isRunDeleted(current.id) ? null : current); setConfirmCleanup(false); setNotice(`已清理 ${result.deletedCount} 条任务记录，生成素材已保留。`); }
    } catch (failure) { if (alive.current) setActionError(failure instanceof Error ? failure.message : "清理任务记录失败"); }
    finally { actionLock.current = false; if (alive.current) setBusy(null); }
  }
  return <section aria-label="项目后台任务" className="mb-5 space-y-3 rounded-xl border border-border/60 bg-card/50 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-medium">后台任务</h2><p className="text-xs text-muted-foreground">可切换项目继续创作，回来后自动恢复全部批次进度。删除记录不影响生成素材。</p></div><div className="flex gap-2"><Button size="sm" variant="outline" disabled={!!busy || loading || !cleanable.length} onClick={() => { setActionError(null); setConfirmCleanup(true); }}>清理已完成和失败</Button><Button size="sm" variant="outline" onClick={() => void refresh()}>刷新任务</Button></div></div>
    {(error || actionError) && <p role="alert" className="text-xs text-amber-600">{actionError || error}</p>}
    {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
    {!shown.length && <p className="text-xs text-muted-foreground">{loading ? "正在读取后台任务…" : "暂无后台任务"}</p>}
    {shown.map((run) => {
      const failed = run.items.filter((item) => item.status === "failed").length;
      const attention = run.items.filter((item) => item.status === "needs_attention").length;
      return <div key={run.id} className="flex items-start gap-2 rounded-lg border border-border/60 p-3">
      <details open={requestedId === run.id ? true : undefined} className="min-w-0 flex-1" data-run-id={run.id}>
      <summary className="cursor-pointer text-sm"><span>{run.label || kindLabels[run.kind]} · {statusLabels[run.status]} · {run.done}/{run.total}</span>{failed > 0 && <span className="ml-2 text-amber-600">失败 {failed}</span>}{attention > 0 && <span className="ml-2 text-amber-600">需处理 {attention}</span>}</summary>
      <div className="mt-3 space-y-2">{run.items.map((item) => {
        const jobId = item.result?.childJobId || item.result?.jobId;
        const asset = item.result?.asset as { filePath?: unknown } | undefined;
        const candidate = item.kind === "keyframe_refine" && item.status === "completed" ? refinementCandidatePath(asset?.filePath) : null;
        return <div key={item.id} className="rounded bg-muted/30 p-2 text-xs"><p>{item.shotId != null ? `镜头 ${item.shotId}` : kindLabels[item.kind]} · {statusLabels[item.status]}{item.stage && stageLabels[item.stage] ? ` · ${stageLabels[item.stage]}` : ""}</p>{item.scriptId && <p className="text-muted-foreground">脚本版本：{item.scriptId}</p>}{item.error && <p role="alert" className="text-amber-600">{item.error}</p>}{typeof jobId === "string" && <Link className="text-primary underline" href={`/project/${encodeURIComponent(projectId)}/assets?klingJob=${encodeURIComponent(jobId)}`}>查看原镜头任务</Link>}{candidate && <a className="block text-primary underline" href={candidate} target="_blank" rel="noopener noreferrer">查看精修候选</a>}</div>;
      })}
        <div className="flex gap-2">{generationRunActive(run) && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void actOn(run, "cancel")}>停止未提交镜头</Button>}{["needs_attention", "failed"].includes(run.status) && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void actOn(run, "retry_import")}>恢复保存</Button>}</div>
      </div>
    </details>
    {generationRunDeletable(run) && <Button size="sm" variant="outline" className="shrink-0" aria-label={`删除任务记录 ${run.id}`} disabled={!!busy} onClick={() => void actOn(run, "delete")}>{busy === `delete:${run.id}` ? "正在删除…" : "删除记录"}</Button>}
    </div>;
    })}
    <Dialog open={confirmCleanup} onOpenChange={(open) => { if (!actionLock.current) setConfirmCleanup(open); }}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader><DialogTitle>清理当前项目的任务记录？</DialogTitle><DialogDescription>仅清理全部镜头均已完成或失败的任务记录，生成素材会保留。运行中、需要处理和已取消的任务不会清理。</DialogDescription></DialogHeader>
        {actionError && <p role="alert" className="text-xs text-amber-600">{actionError}</p>}
        <DialogFooter><Button variant="outline" disabled={!!busy} onClick={() => setConfirmCleanup(false)}>取消清理</Button><Button variant="destructive" disabled={!!busy} onClick={() => void cleanup()}>{busy === "cleanup" ? "正在清理…" : "确认清理"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
