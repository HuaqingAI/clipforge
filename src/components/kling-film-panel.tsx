"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { klingErrorMessage, klingFetch } from "@/lib/kling/client";
import type { KlingFilmOutputSettings, KlingFilmView } from "@/lib/kling/film-types";
import { TASK_FEED_REFRESH_EVENT } from "@/lib/task-feed";

const filmStatus: Record<KlingFilmView["status"], string> = {
  draft: "未启动", running: "镜头处理中", paused: "已暂停", needs_attention: "需要处理", composing: "本地合成中", completed: "已完成", cancelled: "已停止",
};
const shotStatus = { waiting: "等待", generating: "生成 / 入库中", ready: "已就绪", needs_attention: "需要处理" };
const audioStrategySummary: Record<KlingFilmOutputSettings["audioStrategy"], string> = {
  "edge-tts": "Edge 配音替换原声音", "edge-tts-mix": "Edge 配音叠加原声音", native: "优先保留原声音",
};

async function responseData(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new Error(klingErrorMessage(data, "读取历史整片记录失败"));
  return data;
}

interface KlingFilmPanelProps {
  open: boolean; onOpenChange(open: boolean): void; projectId: string; initialRunId?: string;
  onAssetsChanged(): Promise<void> | void; onOpenJob(jobId: string): void;
}

/** Existing paid records remain accessible after full-film generation is retired. */
export function KlingFilmPanel(props: KlingFilmPanelProps) {
  return props.open && props.initialRunId
    ? <KlingFilmHistory key={`${props.projectId}:${props.initialRunId}`} {...props} initialRunId={props.initialRunId} />
    : null;
}

function KlingFilmHistory({ onOpenChange, projectId, initialRunId, onAssetsChanged, onOpenJob }: KlingFilmPanelProps & { initialRunId: string }) {
  const [runs, setRuns] = useState<KlingFilmView[]>([]);
  const [view, setView] = useState<KlingFilmView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<KlingFilmView | null>(null);
  const deletedRunIds = useRef(new Set<string>());
  const lock = useRef(false);
  const alive = useRef(false);
  const detailRevision = useRef(0);
  const changed = useRef(onAssetsChanged);
  changed.current = onAssetsChanged;
  const importedSignature = useRef("");

  const loadRuns = useCallback(async () => {
    const data = await responseData(await klingFetch(`/api/integrations/kling/films?projectId=${encodeURIComponent(projectId)}`));
    if (alive.current) setRuns(Array.isArray(data.runs) ? data.runs.filter((run: KlingFilmView) => !deletedRunIds.current.has(run.runId)) : []);
  }, [projectId]);

  const acceptView = useCallback((next: KlingFilmView) => {
    if (!alive.current || deletedRunIds.current.has(next.runId)) return;
    setRuns((previous) => [next, ...previous.filter((item) => item.runId !== next.runId)]);
    setView(next);
    const signature = JSON.stringify([next.runId, next.shots.map((shot) => shot.assetId), next.videoUrl]);
    if (importedSignature.current && importedSignature.current !== signature) void changed.current();
    importedSignature.current = signature;
  }, []);

  const refreshRun = useCallback(async (runId: string) => {
    const revision = ++detailRevision.current;
    const next = await responseData(await klingFetch(`/api/integrations/kling/films/${encodeURIComponent(runId)}`)) as KlingFilmView;
    if (revision === detailRevision.current) acceptView(next);
  }, [acceptView]);

  useEffect(() => {
    alive.current = true;
    void Promise.allSettled([loadRuns(), refreshRun(initialRunId)]).then((results) => {
      if (!alive.current) return;
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") setError(failure.reason instanceof Error ? failure.reason.message : "读取历史整片记录失败");
      setLoading(false);
    });
    return () => { alive.current = false; };
  }, [initialRunId, loadRuns, refreshRun]);

  const currentRunId = view?.runId;
  const watchProgress = Boolean(view && !["draft", "completed", "cancelled"].includes(view.status));
  useEffect(() => {
    if (!currentRunId || !watchProgress || busy) return;
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      void refreshRun(currentRunId).catch((failure) => {
        if (alive.current) setError(failure instanceof Error ? failure.message : "读取历史整片进度失败");
      }).finally(() => { inFlight = false; });
    }, 4000);
    return () => clearInterval(timer);
  }, [currentRunId, watchProgress, busy, refreshRun]);

  async function action(name: "pause" | "cancel") {
    if (!view || lock.current || !view.allowedActions.includes(name)) return;
    lock.current = true; setBusy(true); setError(null);
    const revision = ++detailRevision.current;
    try {
      const data = await responseData(await klingFetch(`/api/integrations/kling/films/${encodeURIComponent(view.runId)}/${name}`, { method: "POST", body: "{}" }));
      if (revision === detailRevision.current) acceptView(data.run);
      window.dispatchEvent(new Event(TASK_FEED_REFRESH_EVENT));
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : "更新历史整片状态失败");
    } finally { if (alive.current) setBusy(false); lock.current = false; }
  }

  async function deleteRecord() {
    if (!deleteTarget || lock.current) return;
    const runId = deleteTarget.runId;
    lock.current = true; setBusy(true); setError(null);
    try {
      await responseData(await klingFetch(`/api/integrations/kling/films/${encodeURIComponent(runId)}`, { method: "DELETE" }));
      deletedRunIds.current.add(runId);
      if (!alive.current) return;
      setRuns((previous) => previous.filter((run) => run.runId !== runId));
      setView((previous) => previous?.runId === runId ? null : previous);
      setDeleteTarget(null);
      window.dispatchEvent(new Event(TASK_FEED_REFRESH_EVENT));
      if (initialRunId === runId) onOpenChange(false);
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : "删除整片记录失败，请重试。");
    } finally { if (alive.current) setBusy(false); lock.current = false; }
  }

  function showFailure(failure: unknown) {
    if (alive.current) setError(failure instanceof Error ? failure.message : String(failure));
  }

  return <Dialog open onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl" showCloseButton={!busy}>
      <DialogHeader><DialogTitle>Kling 历史整片记录</DialogTitle></DialogHeader>
      <p className="text-sm text-muted-foreground">整片生成已下线，可查看已有结果或停止、删除原计划。已提交的镜头可在原任务中查询和保存。</p>
      {error && <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{error}</p>}
      {loading && <p role="status">正在读取历史整片记录…</p>}
      <section aria-label="整片记录" className="space-y-2 rounded-md border p-3">
        <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">本项目历史记录</h3><Button size="sm" variant="ghost" disabled={busy} onClick={() => void loadRuns().catch(showFailure)}>刷新记录</Button></div>
        {!loading && runs.length === 0 && <p className="text-xs text-muted-foreground">没有历史整片记录。</p>}
        {runs.map((run) => <div key={run.runId} className={`flex items-center gap-2 rounded border p-2 text-xs ${view?.runId === run.runId ? "border-primary" : "border-border"}`}>
          <button type="button" disabled={busy} className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-2 text-left" onClick={() => void refreshRun(run.runId).catch(showFailure)}><span>{run.model.displayName} · {new Date(run.createdAt).toLocaleString()}</span><span>{filmStatus[run.status]} · {run.readyShots}/{run.totalShots}</span></button>
          <Button type="button" size="sm" variant="ghost" aria-label={`删除整片记录 ${run.runId}`} disabled={busy || !run.allowedActions.includes("delete")} title={run.allowedActions.includes("delete") ? "删除此历史记录" : "请先停止任务，再删除记录。"} className="shrink-0 text-destructive hover:text-destructive" onClick={() => { setDeleteTarget(run); setError(null); }}>删除</Button>
        </div>)}
        {deleteTarget && <div role="group" aria-label="删除整片记录确认" className="space-y-2 rounded border border-destructive/40 p-3">
          <p className="text-sm font-medium">删除整片记录？</p>
          <p className="text-xs text-muted-foreground">{deleteTarget.model.displayName} · {new Date(deleteTarget.createdAt).toLocaleString()}</p>
          <p className="text-sm">删除后无法恢复此整片计划记录。已生成的镜头素材和成片视频会保留。</p>
          <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => setDeleteTarget(null)}>取消删除</Button><Button size="sm" variant="destructive" disabled={busy} onClick={() => void deleteRecord()}>{busy ? "正在删除…" : "确认删除记录"}</Button></div>
        </div>}
      </section>
      {view && <section className="space-y-3 rounded-md border p-3" aria-label="历史整片详情">
        <div className="flex flex-wrap justify-between gap-2"><h3 className="font-medium">{filmStatus[view.status]} · {view.readyShots}/{view.totalShots} 镜头已就绪</h3><Button variant="ghost" size="sm" disabled={busy} onClick={() => void refreshRun(view.runId).catch(showFailure)}>查询原整片进度</Button></div>
        <p className="break-all text-xs text-muted-foreground">{view.model.displayName} · {view.model.remoteModelId} · {view.output.aspectRatio} · {view.output.resolution} · {audioStrategySummary[view.output.audioStrategy]} · {view.stage}</p>
        {view.warnings.map((warning, index) => <p key={index} className="text-sm text-amber-600">{warning}</p>)}
        {view.error && <p role="alert" className="text-sm text-destructive">{view.error}</p>}
        <div className="space-y-2">{view.shots.map((shot) => <div key={shot.id} className="flex flex-wrap items-start gap-3 rounded border p-2 text-sm">
          {/* eslint-disable-next-line @next/next/no-img-element -- history thumbnails are cached local assets */}
          {shot.keyframeUrl && <img src={shot.keyframeUrl} alt={`镜头 ${shot.shotId} 关键帧`} className="h-20 w-14 rounded object-cover" />}
          <div className="min-w-0 flex-1 space-y-1"><p className="font-medium">镜头 {shot.shotId} · {shot.duration}s · {shotStatus[shot.status]}</p>{shot.error && <p className="text-xs text-destructive">{shot.error}</p>}
            <div className="flex flex-wrap gap-2">{shot.jobId && <Button size="sm" variant="outline" disabled={busy} onClick={() => onOpenJob(shot.jobId!)}>查看镜头 {shot.shotId} 原任务</Button>}{shot.videoUrl && <a href={shot.videoUrl} target="_blank" rel="noreferrer" className="text-xs text-primary underline">播放镜头视频</a>}</div>
          </div>
        </div>)}</div>
        {(view.allowedActions.includes("pause") || view.allowedActions.includes("cancel")) && <div className="space-y-2">
          <div className="flex flex-wrap gap-2">{view.allowedActions.includes("pause") && <Button variant="outline" disabled={busy} onClick={() => void action("pause")}>暂停后续镜头</Button>}{view.allowedActions.includes("cancel") && <Button variant="outline" disabled={busy} onClick={() => void action("cancel")}>停止此整片计划</Button>}</div>
          <p className="text-xs text-muted-foreground">暂停或停止只阻止后续提交，已经提交的云端任务可能继续运行。可打开原镜头任务查询并保存已有结果。</p>
        </div>}
        {view.videoUrl && <div className="space-y-2"><video src={view.videoUrl} poster={view.thumbnailUrl} controls preload="metadata" className="max-h-[28rem] w-full rounded bg-black" /><a href={view.videoUrl} download className="inline-block text-sm text-primary underline">下载整片视频</a></div>}
      </section>}
      {busy && <p role="status" className="text-sm text-muted-foreground">正在处理，请勿重复操作…</p>}
    </DialogContent>
  </Dialog>;
}
