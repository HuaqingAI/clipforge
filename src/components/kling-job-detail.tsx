"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { klingErrorMessage, klingFetch } from "@/lib/kling/client";
import type { KlingJobView } from "@/lib/kling/job-types";

const SUBMISSION: Record<string, string> = { prepared: "待确认首次提交", submitting: "正在上传并提交", acknowledged: "云端已受理", not_submitted: "未提交", submission_unknown: "提交结果不明，请先核对" };
const REMOTE: Record<string, string> = { not_started: "尚未受理", pending: "排队中", processing: "生成中", completed: "生成完成", failed: "生成失败", cancelled: "已取消", unknown: "状态待核对" };
const IMPORT: Record<string, string> = { not_ready: "等待云端结果", pending: "等待保存", importing: "保存中", completed: "已保存到本地", partial: "部分作品未保存", failed: "本地保存失败" };

export function klingJobStatus(job: KlingJobView): string {
  if (job.submissionState === "submission_unknown" || job.submissionState === "prepared" || job.submissionState === "submitting" || job.submissionState === "not_submitted") return SUBMISSION[job.submissionState];
  if (job.blockedReason) return "需要处理";
  if (job.remoteState === "completed") return IMPORT[job.importState] ?? job.importState;
  return REMOTE[job.remoteState] ?? job.remoteState;
}

/** Submission ambiguity and unfinished imports stay blocking after a page refresh. */
export function klingJobBlocksSubmission(job: KlingJobView): boolean {
  return job.submissionState === "prepared" || job.submissionState === "submitting" || job.submissionState === "submission_unknown"
    || (job.submissionState === "acknowledged" && !["failed", "cancelled"].includes(job.remoteState) && job.importState !== "completed");
}

export function KlingJobDetail({ jobId, open, onOpenChange, onChanged }: { jobId: string | null; open: boolean; onOpenChange(open: boolean): void; onChanged?(): void }) {
  const [job, setJob] = useState<KlingJobView | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generationId, setGenerationId] = useState("");
  const [candidate, setCandidate] = useState<{ token: string; summary: { generationId: string; status: string; modelId?: string } } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [adoptConfirmed, setAdoptConfirmed] = useState(false);
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
  const currentJobId = useRef(jobId);
  currentJobId.current = jobId;

  const refresh = useCallback(async () => {
    if (!jobId) return;
    const response = await klingFetch(`/api/integrations/kling/jobs/${encodeURIComponent(jobId)}`);
    const body = await response.json();
    if (!response.ok) throw new Error(klingErrorMessage(body));
    if (currentJobId.current === jobId) setJob(body.job ?? body);
  }, [jobId]);

  useEffect(() => {
    if (!open || !jobId) return;
    let cancelled = false;
    setLoading(true); setJob(null); setError(null); setCandidate(null); setConfirmed(false); setAdoptConfirmed(false); setGenerationId(""); setDiagnosticsCopied(false);
    void refresh().catch((failure) => { if (!cancelled) setError(failure instanceof Error ? failure.message : "读取任务失败"); }).finally(() => { if (!cancelled) setLoading(false); });
    const timer = setInterval(() => { void refresh().catch(() => undefined); }, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [open, jobId, refresh]);

  async function action(name: string, payload: unknown = {}) {
    if (!jobId || busy) return;
    setBusy(name); setError(null);
    try {
      const response = await klingFetch(`/api/integrations/kling/jobs/${encodeURIComponent(jobId)}/${name}`, { method: "POST", body: JSON.stringify(payload) });
      const body = await response.json();
      if (!response.ok) throw new Error(klingErrorMessage(body));
      if (name === "bind" && typeof body.candidateToken === "string") setCandidate({ token: body.candidateToken, summary: body.candidate });
      else { setCandidate(null); await refresh(); onChanged?.(); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "操作失败"); }
    finally { setBusy(null); }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>Kling 单镜头任务</DialogTitle></DialogHeader>
      {loading && <p role="status">正在读取本地任务记录…</p>}
      {error && <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{error}</p>}
      {job && <>
        <div className="space-y-1 text-sm">
          <p className="font-medium">镜头 {job.shotId} · {klingJobStatus(job)}</p>
          <p className="break-all text-xs text-muted-foreground">本地作业：{job.jobId}</p>
          <p className="break-all text-xs text-muted-foreground">云端任务：{job.remoteGenerationId ?? "尚未取得任务 ID"}</p>
          <p className="text-xs text-muted-foreground">账号：{job.accountLabel ?? job.profileId} · {job.modelId} · {job.tool === "image_to_video" ? "图生视频" : "文生视频"}</p>
          <p className="text-xs text-muted-foreground">提交：{SUBMISSION[job.submissionState]} · 云端：{REMOTE[job.remoteState]} · 本地：{IMPORT[job.importState]}</p>
          {job.lastCheckedAt && <p className="text-xs text-muted-foreground">最后核对：{new Date(job.lastCheckedAt).toLocaleString()}</p>}
        </div>
        {(job.blockedReason || job.lastError) && <p role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">{job.lastError?.message ?? job.blockedReason}{job.lastError?.code && <span className="ml-2 text-xs">({job.lastError.code})</span>}</p>}
        {job.submissionState === "submission_unknown" && <p className="rounded-md bg-amber-500/10 p-3 text-sm">尚未取得可靠提交回执，暂时无法确认是否已受理。请先在原账号核对任务；如有已有任务，可在下方绑定任务 ID。当前镜头普通生成已暂停。</p>}
        <details className="rounded-md border p-3 text-xs">
          <summary className="cursor-pointer">CLI 返回与错误</summary>
          {job.cliDiagnostics ? <div className="mt-3 space-y-3">
            <p className="text-muted-foreground">已隐藏凭据与链接。记录时间：{new Date(job.cliDiagnostics.recordedAt).toLocaleString()}</p>
            <p>退出码：{job.cliDiagnostics.exitCode ?? "未取得"} · 耗时：{(job.cliDiagnostics.durationMs / 1000).toFixed(1)} 秒 · 超时：{job.cliDiagnostics.timedOut ? "是" : "否"} · 已取消：{job.cliDiagnostics.aborted ? "是" : "否"}{job.cliDiagnostics.signal ? ` · 信号：${job.cliDiagnostics.signal}` : ""}</p>
            {job.cliDiagnostics.submission && <p>失败阶段：{{ startup: "启动前检查或进程启动", upload: "参考图片上传", validation: "模型与输入校验", submission: "视频生成提交" }[job.cliDiagnostics.submission.phase]} · {job.cliDiagnostics.submission.reason}</p>}
            {job.cliDiagnostics.error && <div><p className="font-medium">执行异常</p><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-2">{job.cliDiagnostics.error}</pre></div>}
            <div><p className="font-medium">标准输出 stdout</p><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-2">{job.cliDiagnostics.stdout || "（无标准输出）"}</pre></div>
            {!job.cliDiagnostics.stdout && job.cliDiagnostics.responseJson && <div><p className="font-medium">返回 JSON</p><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-2">{job.cliDiagnostics.responseJson}</pre></div>}
            <div><p className="font-medium">错误输出 stderr</p><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-2">{job.cliDiagnostics.stderr || "（无错误输出）"}</pre></div>
            {job.cliDiagnostics.truncated && <p className="text-muted-foreground">输出过长，已保留开头与末尾，中段已截断。</p>}
            <Button size="sm" variant="outline" onClick={() => {
              const text = JSON.stringify({ jobId: job.jobId, remoteGenerationId: job.remoteGenerationId, submissionState: job.submissionState, ...job.cliDiagnostics }, null, 2);
              if (!navigator.clipboard?.writeText) { setError("复制失败，请直接选择并复制上方诊断内容。"); return; }
              void navigator.clipboard.writeText(text).then(() => setDiagnosticsCopied(true)).catch(() => setError("复制失败，请直接选择并复制上方诊断内容。"));
            }}>{diagnosticsCopied ? "已复制诊断信息" : "复制诊断信息"}</Button>
          </div> : <p className="mt-3 text-muted-foreground">此历史任务未保存 CLI 返回与错误；后续提交会保留诊断信息。</p>}
        </details>
        <details className="rounded-md border p-3 text-xs"><summary className="cursor-pointer">查看原始提示词、参数和输入</summary><p className="mt-3 whitespace-pre-wrap break-words">{job.prompt}</p><pre className="mt-2 overflow-auto">{JSON.stringify(job.options, null, 2)}</pre><div className="mt-2 flex flex-wrap gap-2">{job.inputSummary.map((input, index) => <div key={`${input.hash}-${index}`} className="max-w-36"><p>{input.role}</p>{input.sourceUrl?.startsWith("/api/files/") && <img src={input.sourceUrl} alt={`原始输入 ${index + 1}`} className="mt-1 max-h-32 rounded object-contain" />}<p className="mt-1 truncate text-[10px] text-muted-foreground" title={input.hash}>SHA256 {input.hash}</p></div>)}</div></details>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void refresh().catch((failure) => setError(String(failure)))}>刷新本地记录</Button>
          {job.allowedActions.includes("query") && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void action("query")}>查询原云端任务</Button>}
          {job.allowedActions.includes("import") && <Button size="sm" disabled={!!busy} onClick={() => void action("import")}>重试保存原视频</Button>}
          {(job.allowedActions.includes("pause-query") || job.allowedActions.includes("pause_query")) && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void action("pause-query")}>暂停自动查询</Button>}
          {(job.allowedActions.includes("resume-query") || job.allowedActions.includes("resume_query")) && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void action("resume-query")}>恢复自动查询</Button>}
          {job.allowedActions.includes("dismiss") && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void action("dismiss")}>隐藏提醒</Button>}
          {job.allowedActions.includes("cancel-prepared") && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void action("cancel-prepared", { explicitConfirmation: true })}>取消未提交作业（不计费）</Button>}
        </div>
        <p className="text-xs text-muted-foreground">查询和恢复保存使用原任务，不会创建新生成。暂停查询不会取消云端任务。</p>
        {job.allowedActions.includes("continue") && <div className="space-y-3 rounded-md border border-amber-500/40 p-3"><p className="text-sm">此作业尚未派发。继续将首次提交原快照，并按 Kling 账号规则扣除积分。</p><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我已核对原模型、输入与参数，确认可能产生费用。</label><Button size="sm" disabled={!!busy || !confirmed} onClick={() => { const requestId = crypto.randomUUID(); void action("continue", { explicitConfirmation: true, clientRequestId: requestId, billingAcknowledgement: { policyRevision: "credits-v1", acceptedForRequestId: requestId } }); }}>确认并首次提交（消耗积分）</Button></div>}
        {(job.allowedActions.includes("bind") || job.allowedActions.includes("bind_generation_id")) && <div className="space-y-3 rounded-md border p-3"><p className="text-sm font-medium">核对并绑定已有 Kling 任务</p><p className="text-xs text-muted-foreground">使用生成时的原账号输入任务 ID。先预览核对，再明确绑定。</p><div className="flex gap-2"><input aria-label="已有 Kling 任务 ID" className="min-w-0 flex-1 rounded border bg-background p-2 text-sm" value={generationId} onChange={(event) => { setGenerationId(event.target.value); setCandidate(null); }} /><Button size="sm" variant="outline" disabled={!!busy || !generationId.trim()} onClick={() => void action("bind", { action: "preview", generationId: generationId.trim() })}>核对任务</Button></div>{candidate && <div className="space-y-2 text-xs"><p className="break-all">任务 {candidate.summary.generationId} · {candidate.summary.status} · {candidate.summary.modelId ?? "请核对原模型"}</p><Button size="sm" disabled={!!busy} onClick={() => void action("bind", { action: "confirm", candidateToken: candidate.token, explicitConfirmation: true })}>我确认这是原任务，绑定并恢复</Button></div>}</div>}
        {job.outputs.length > 0 && <div className="space-y-4"><p className="font-medium">视频作品</p>{job.outputs.map((output) => <div key={output.outputId} className="space-y-2 rounded-md border p-3">{output.videoUrl && <video src={output.videoUrl} poster={output.thumbnailUrl} controls preload="metadata" playsInline className="max-h-80 w-full rounded bg-black" />}<p className="text-xs">{output.imported ? output.selected ? "已用于当前镜头" : "已保存为备选，当前镜头未替换" : "尚未保存到本地"}</p>{output.videoUrl && <a href={output.videoUrl} download className="mr-3 inline-block text-xs text-primary underline">下载本地视频</a>}{output.imported && !output.selected && <Button size="sm" variant="outline" disabled={!!busy || (output.selectionOutcome === "detached" && !adoptConfirmed)} onClick={() => void action(`outputs/${encodeURIComponent(output.outputId)}/select`, { adoptCurrentContext: adoptConfirmed })}>替换当前镜头</Button>}{!output.selected && output.imported && <label className="flex gap-2 text-xs"><input type="checkbox" checked={adoptConfirmed} onChange={(event) => setAdoptConfirmed(event.target.checked)} />若原脚本修订已变化，我确认将此视频采用为当前脚本同号镜头的新候选。</label>}</div>)}</div>}
        {busy && <p role="status" className="text-xs text-muted-foreground">正在处理…</p>}
      </>}
    </DialogContent>
  </Dialog>;
}
