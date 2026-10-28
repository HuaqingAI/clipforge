"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { VideoGenerationDialog } from "@/components/video-generation-dialog";
import type { AssetItem } from "@/lib/assets-view";
import { klingErrorMessage, klingFetch } from "@/lib/kling/client";
import type { KlingPublicStatus } from "@/lib/kling/types";
import type { KlingSubmitRequest } from "@/lib/kling/job-types";
import { KLING_AUDIO_PARAMETER_NAMES, klingAudioParameterValue, klingModelOptions } from "@/lib/kling/model-options";
import { videoParameterLabel, videoParameterDescription, videoParameterValueLabel } from "@/lib/video-parameter-copy";
import { KLING_MAX_CONCURRENT_SHOTS } from "@/lib/kling/concurrency";
import { validateVideoPrompt } from "@/lib/video-prompt";
import type { VideoPromptContext } from "@/lib/video-prompt-request";
import type { BatchMotionDraft } from "@/lib/batch-motion";

const FRAME_INPUTS = [{ name: "firstFrame", label: "首帧" }, { name: "tailFrame", label: "尾帧" }] as const;

function mergeStatus(previous: KlingPublicStatus | null, next: KlingPublicStatus): KlingPublicStatus {
  if (!previous || previous.profile?.id !== next.profile?.id || previous.profile?.authRevision !== next.profile?.authRevision || previous.profile?.catalogRevision !== next.profile?.catalogRevision) return next;
  return { ...next, models: next.models.map((model) => {
    const existing = previous.models.find((item) => item.selectionKey === model.selectionKey);
    return existing && JSON.stringify(existing) === JSON.stringify(model) ? existing : model;
  }) };
}

function hasVerifiedCatalog(status: KlingPublicStatus, profileId?: string, selectionKey?: string): boolean {
  const profile = status.profile;
  return Boolean(status.loggedIn && status.configured && profile && (!profileId || profile.id === profileId)
    && !profile.disabledAt && profile.environmentState === "ready" && profile.authState === "authenticated"
    && profile.principalKey && profile.catalogRevision && profile.catalogCheckedAt
    && status.models.some((model) => model.selectionKey === selectionKey && model.profileId === profile.id && model.catalogRevision === profile.catalogRevision));
}

export function KlingShotGenerator({ open, onOpenChange, projectId, scriptId, profileId, defaultModel, asset, preparedPrompt, promptContext, negativePrompt, firstFrameUrl, lastFrameUrl, defaultParameters, referenceImages, frameChoices, onFramesChange, onSubmitted, onRefreshTasks }: {
  open: boolean; onOpenChange(open: boolean): void; projectId: string; scriptId: string; profileId?: string; defaultModel?: string;
  preparedPrompt: string; firstFrameUrl?: string; lastFrameUrl?: string;
  promptContext?: VideoPromptContext; negativePrompt?: string;
  defaultParameters?: Record<string, unknown>;
  frameChoices?: Array<{ label: string; url: string }>;
  onFramesChange?(firstFrameUrl: string, lastFrameUrl?: string): Promise<BatchMotionDraft>;
  asset: AssetItem | null; referenceImages: string[]; onSubmitted(jobId: string): void; onRefreshTasks(): Promise<void>;
}) {
  const [status, setStatus] = useState<KlingPublicStatus | null>(null);
  const [options, setOptions] = useState<Record<string, string | number | boolean>>( {} );
  const [parameterWarnings, setParameterWarnings] = useState<string[]>([]);
  const [inputUrls, setInputUrls] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [catalogNotice, setCatalogNotice] = useState<string | null>(null);
  const [frameReview, setFrameReview] = useState<BatchMotionDraft | null>(null);
  const [reviewingFrames, setReviewingFrames] = useState(false);
  const [frameReviewFailed, setFrameReviewFailed] = useState(false);
  const frameReviewVersion = useRef(0);
  const submitLock = useRef(false);
  const model = status?.models.find((item) => item.selectionKey === defaultModel);
  const sourceFrame = firstFrameUrl;
  const imageChoices = useMemo(() => [...new Map([
    ...(sourceFrame ? [{ label: "当前镜头原始关键帧", url: sourceFrame }] : []),
    ...(frameChoices ?? []),
    ...[lastFrameUrl, ...referenceImages].filter((value): value is string => Boolean(value)).map((url, index) => ({ label: `可选图片 ${index + 1}`, url })),
  ].map((choice) => [choice.url, choice])).values()], [sourceFrame, lastFrameUrl, referenceImages, frameChoices]);

  useEffect(() => {
    if (!open || !asset) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshNeeded = true;
    let refreshFailed = false;
    setLoading(true); setStatus(null); setError(null); setStatusError(null); setCatalogNotice(null); setConfirmed(false); setUncertain(false); setSubmitting(false); submitLock.current = false;
    const poll = async () => {
      try {
        const response = await klingFetch(`/api/integrations/kling/status${profileId ? `?profileId=${encodeURIComponent(profileId)}` : ""}`, { signal: controller.signal });
        const body = await response.json() as KlingPublicStatus;
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error(klingErrorMessage(body));
        let next = body;
        if (refreshNeeded && next.loggedIn && next.profile?.id) {
          try {
            // Model discovery shares the CLI lock with submissions and queries; credits are unrelated.
            const refreshed = await klingFetch("/api/integrations/kling/refresh", {
              method: "POST", body: JSON.stringify({ profileId: next.profile.id, credits: false }), signal: controller.signal,
            });
            const refreshedBody = await refreshed.json();
            if (controller.signal.aborted) return;
            if (!refreshed.ok) {
              if (refreshedBody?.error?.code === "KLING_PROFILE_BUSY") {
                const cached = next;
                const usableCache = !refreshFailed && hasVerifiedCatalog(cached, profileId, defaultModel);
                setStatus((previous) => usableCache ? mergeStatus(previous, cached) : null);
                if (!refreshFailed) setStatusError(null);
                setCatalogNotice("Kling 正在处理其他操作，模型刷新将自动重试；已有可用模型时可继续确认镜头。");
                return;
              }
              throw new Error(klingErrorMessage(refreshedBody));
            }
            next = refreshedBody as KlingPublicStatus;
            refreshNeeded = false;
            refreshFailed = false;
          } catch (failure) {
            if (controller.signal.aborted) return;
            // Only lock contention permits cached options. An authentication/model error must block them.
            refreshFailed = true;
            setStatus(null); setCatalogNotice(null);
            throw failure;
          }
        }
        if (!controller.signal.aborted) {
          setStatus((previous) => mergeStatus(previous, next));
          setStatusError(null); setCatalogNotice(null);
        }
      } catch (failure) {
        if (!controller.signal.aborted) setStatusError(failure instanceof Error ? failure.message : "读取 Kling 模型失败");
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          // Schedule after completion so slow CLI calls cannot overlap with another refresh attempt.
          timer = setTimeout(poll, 5000);
        }
      }
    };
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [open, asset, preparedPrompt, promptContext, negativePrompt, sourceFrame, profileId, defaultModel]);

  const modelConfiguration = JSON.stringify([model, status?.profile?.authRevision, status?.profile?.principalKey]);
  useEffect(() => {
    setConfirmed(false);
  }, [modelConfiguration]);

  useEffect(() => {
    if (!model) { setConfirmed(false); return; }
    const mapped = klingModelOptions(model, { ...defaultParameters, audioEnabled: undefined });
    setOptions(mapped.options); setParameterWarnings(mapped.warnings);
    frameReviewVersion.current++;
    setInputUrls({ firstFrame: sourceFrame ?? "", tailFrame: "" });
    setFrameReview(null); setReviewingFrames(false); setFrameReviewFailed(false); setConfirmed(false);
    return () => { frameReviewVersion.current++; };
  }, [model, sourceFrame, defaultParameters, open]);

  async function changeFrame(name: "firstFrame" | "tailFrame", value: string) {
    const next = { ...inputUrls, [name]: value };
    setInputUrls(next); setConfirmed(false); setFrameReviewFailed(false); setError(null);
    const version = ++frameReviewVersion.current;
    if (!onFramesChange || !next.firstFrame) return;
    setReviewingFrames(true);
    try {
      const reviewed = await onFramesChange(next.firstFrame, next.tailFrame || undefined);
      if (version === frameReviewVersion.current) { setFrameReview(reviewed); setConfirmed(false); }
    } catch (failure) {
      if (version === frameReviewVersion.current) {
        setFrameReviewFailed(true);
        setError(failure instanceof Error ? failure.message : "更新首尾帧提示词失败，请重新选择图片。");
      }
    } finally {
      if (version === frameReviewVersion.current) setReviewingFrames(false);
    }
  }

  function changeParameter(name: string, value: string | number | boolean | undefined) {
    setOptions((previous) => { const next = { ...previous }; if (value === undefined) delete next[name]; else next[name] = value; return next; }); setConfirmed(false);
  }

  const audioParameters = model?.parameters.filter((parameter) => KLING_AUDIO_PARAMETER_NAMES.includes(parameter.name)) ?? [];
  const reviewedContext = frameReview?.promptContext ?? promptContext;
  const reviewedNegativePrompt = frameReview?.negativePrompt ?? negativePrompt;
  const generateAudio = reviewedContext?.generateAudio ?? defaultParameters?.audioEnabled !== false;
  const audioSettings = model
    ? klingModelOptions({ ...model, parameters: audioParameters.filter((parameter) => klingAudioParameterValue(parameter, generateAudio) !== undefined) }, { audioEnabled: generateAudio })
    : { options: {}, warnings: [], unsupportedSettings: [] };
  const negativeSettings = model && reviewedNegativePrompt !== undefined
    ? klingModelOptions({ ...model, parameters: model.parameters.filter((parameter) => ["negative_prompt", "negativePrompt"].includes(parameter.name)) }, { negativePrompt: reviewedNegativePrompt })
    : { options: {}, warnings: [], unsupportedSettings: [] };
  const submissionOptions = { ...Object.fromEntries(Object.entries(options).filter(([name]) => !KLING_AUDIO_PARAMETER_NAMES.includes(name))), ...negativeSettings.options, ...audioSettings.options };
  const submissionPrompt = frameReview?.prompt ?? preparedPrompt;
  const promptIssues = validateVideoPrompt(submissionPrompt);
  const warnings = [...parameterWarnings, ...negativeSettings.warnings, ...audioSettings.warnings];
  const missingInput = !inputUrls.firstFrame?.trim();
  const capacity = status?.concurrency;
  const capacityBlocked = Boolean(capacity && (capacity.blockedByUnknownSubmission || capacity.active >= capacity.max));
  const canSubmit = Boolean(status?.loggedIn && status.configured !== false && !status.profile?.disabledAt && (!profileId || !status.profile?.id || status.profile.id === profileId) && model && confirmed && submissionPrompt && !promptIssues.length && !missingInput && scriptId && !submitting && !reviewingFrames && !frameReviewFailed && !uncertain && !capacityBlocked);

  async function submit() {
    if (!canSubmit || !model || !asset || submitLock.current) return;
    submitLock.current = true; setSubmitting(true); setError(null);
    const clientRequestId = crypto.randomUUID();
    const request: KlingSubmitRequest = {
      provider: "kling-cli", profileId: model.profileId, clientRequestId, executionScope: "single-shot", projectId, scriptId, shotId: asset.shotId,
      selectionKey: model.selectionKey, mode: model.tool === "image_to_video" ? "image-to-video" : "text-to-video", prompt: submissionPrompt, options: submissionOptions,
      ...(reviewedContext && { promptContext: reviewedContext }),
      imageUrl: inputUrls.firstFrame.trim(),
      ...(inputUrls.tailFrame?.trim() && { lastImageUrl: inputUrls.tailFrame.trim() }),
      expectedSelectedAssetId: asset.assetId ?? null,
      billingAcknowledgement: { policyRevision: "credits-v1", acceptedForRequestId: clientRequestId },
    };
    let requiresReconciliation = true;
    try {
      const response = await klingFetch("/api/ai/video", { method: "POST", body: JSON.stringify(request) });
      const body = await response.json();
      if (!response.ok) {
        if (typeof body.jobId === "string" || typeof body.error?.jobId === "string") { onSubmitted(body.jobId ?? body.error.jobId); return; }
        // A definite 4xx before dispatch can be corrected. Timeouts/5xx require task reconciliation.
        requiresReconciliation = response.status >= 500;
        if (response.status >= 500) setUncertain(true);
        throw new Error(klingErrorMessage(body, "提交失败，请先核对任务列表"));
      }
      if (typeof body.jobId !== "string") { setUncertain(true); throw new Error("未取得本地作业 ID，请先核对任务列表"); }
      onSubmitted(body.jobId);
    } catch (failure) {
      if (requiresReconciliation) setUncertain(true);
      setError(failure instanceof Error ? failure.message : "提交结果待核对");
      await onRefreshTasks();
    } finally { setSubmitting(false); submitLock.current = false; setConfirmed(false); }
  }

  return <VideoGenerationDialog open={open} onOpenChange={onOpenChange} shotId={asset?.shotId} modelLabel={model ? `${model.displayName} · ${model.remoteModelId} · ${model.tool}` : defaultModel || "未设置默认视频模型"} busy={submitting}>
      <p className="text-xs text-muted-foreground">本次生成当前镜头。同一 Kling 账号最多同时生成 {KLING_MAX_CONCURRENT_SHOTS} 个镜头；提交后可继续确认其他镜头。原素材保留，任务可恢复。</p>
      {capacity && <p role="status" className="text-xs text-muted-foreground">当前账号生成名额：{capacity.active} / {capacity.max}（含待提交镜头）</p>}
      {capacityBlocked && <p role="alert" className="text-sm text-amber-600">{capacity?.blockedByUnknownSubmission ? "此账号有提交结果不明的任务，请先核对原任务再继续。" : `当前账号已占用全部 ${capacity?.max} 个生成名额，请等待镜头完成后再提交。`}</p>}
      {loading && <p role="status">正在读取当前账号可用模型…</p>}
      {catalogNotice && <p role="status" className="text-xs text-muted-foreground">{catalogNotice}</p>}
      {(error || statusError) && <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{error || statusError}</p>}
      {promptIssues.length > 0 && <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive"><p>请修改分镜内容或生成设置后再提交：</p><ul className="list-inside list-disc">{promptIssues.map((issue) => <li key={issue.code}>{issue.message}</li>)}</ul></div>}
      {status && !status.loggedIn && <p className="text-sm">请先在 <Link className="text-primary underline" href="/settings">设置页</Link> 完成 Kling 环境检测和登录。</p>}
      {status?.loggedIn && <>
        <p className="text-xs text-muted-foreground">账号：{status.profile?.accountSummary?.displayName ?? status.profile?.label ?? "当前 Kling 账号"}</p>
        {!model && <p role="alert" className="text-sm text-amber-600">设置页的默认视频模型不在当前账号目录中，请返回设置页刷新模型并重新选择默认模型。</p>}
      </>}
      {model && <>
        <p className="break-all text-xs text-muted-foreground">实际模型：{model.remoteModelId} · {model.tool}</p>
        {warnings.length > 0 && <ul className="space-y-1 text-xs text-amber-600">{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
        {FRAME_INPUTS.map((slot) => <div key={slot.name} className="space-y-2 rounded-md border p-3"><label className="space-y-1 text-sm"><span>{slot.label}</span><select aria-label={`Kling ${slot.label}`} value={inputUrls[slot.name] ?? ""} className="w-full rounded-md border bg-background p-2" disabled={submitting || uncertain || reviewingFrames} onChange={(event) => { void changeFrame(slot.name, event.target.value); }}><option value="">不使用图片</option>{imageChoices.map(({ url, label }) => <option key={url} value={url}>{label}</option>)}</select></label>{inputUrls[slot.name] && <img src={inputUrls[slot.name]} alt={`${slot.label}图片`} className="max-h-32 max-w-full rounded object-contain" />}</div>)}
        {reviewingFrames && <p role="status" className="text-xs text-muted-foreground">正在更新首尾帧对应的提示词…</p>}
        <label className="space-y-1 text-sm"><span>实际提交的提示词</span><textarea aria-label="Kling 视频提示词" rows={12} className="min-h-64 w-full rounded-md border bg-background p-2 leading-relaxed" value={submissionPrompt} readOnly /></label>
        <div className="grid gap-3 sm:grid-cols-2">{model.parameters.filter((parameter) => !KLING_AUDIO_PARAMETER_NAMES.includes(parameter.name) && (negativePrompt === undefined || !["negative_prompt", "negativePrompt"].includes(parameter.name))).map((parameter) => <label key={parameter.name} className="space-y-1 text-sm"><span>{videoParameterLabel(parameter.name)}</span>{parameter.allowedValues ? <select aria-label={`Kling 参数 ${videoParameterLabel(parameter.name)}`} className="w-full rounded-md border bg-background p-2" value={String(options[parameter.name] ?? "")} disabled={submitting || uncertain} onChange={(event) => changeParameter(parameter.name, event.target.value === "" ? undefined : parameter.allowedValues!.find((value) => String(value) === event.target.value) ?? (parameter.type === "number" ? Number(event.target.value) : event.target.value))}><option value="">使用平台默认值</option>{options[parameter.name] !== undefined && !parameter.allowedValues.includes(options[parameter.name]) && <option value={String(options[parameter.name])}>{videoParameterValueLabel(parameter.name, options[parameter.name])}</option>}{parameter.allowedValues.map((value) => <option key={String(value)} value={String(value)}>{videoParameterValueLabel(parameter.name, value)}</option>)}</select> : parameter.type === "boolean" ? <select aria-label={`Kling 参数 ${videoParameterLabel(parameter.name)}`} className="w-full rounded-md border bg-background p-2" value={options[parameter.name] === undefined ? "" : String(options[parameter.name])} disabled={submitting || uncertain} onChange={(event) => changeParameter(parameter.name, event.target.value === "" ? undefined : event.target.value === "true")}><option value="">使用平台默认值</option><option value="true">开启</option><option value="false">关闭</option></select> : <input aria-label={`Kling 参数 ${videoParameterLabel(parameter.name)}`} className="w-full rounded-md border bg-background p-2" type={parameter.type === "number" ? "number" : "text"} value={String(options[parameter.name] ?? "")} disabled={submitting || uncertain} onChange={(event) => changeParameter(parameter.name, event.target.value === "" ? undefined : parameter.type === "number" ? Number(event.target.value) : event.target.value)} />}{videoParameterDescription(parameter) && <p className="text-xs text-muted-foreground">{videoParameterDescription(parameter)}</p>}</label>)}</div>
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3"><p className="text-sm">此操作调用 Kling 官方账号生成视频，可能消耗积分。实际扣费以 Kling 为准；本应用未获得精确积分报价时不会把费用显示为免费。</p><label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={confirmed} disabled={submitting || uncertain || reviewingFrames} onChange={(event) => setConfirmed(event.target.checked)} />我已核对当前镜头、模型、图片和参数，确认本次生成可能扣除 Kling 积分。</label></div>
        {missingInput && <p className="text-xs text-amber-600">请为图生视频添加一张输入图片。</p>}
      </>}
      {uncertain ? <div className="space-y-2"><p className="text-sm text-amber-600">本机提交结果待核对，请先刷新任务列表，找到原任务后继续查询或恢复保存。</p><Button variant="outline" onClick={() => void onRefreshTasks()}>核对任务列表</Button></div> : <Button disabled={!canSubmit} onClick={() => void submit()}>{submitting ? "正在登记作业，请勿重复操作…" : "确认生成此镜头（消耗积分）"}</Button>}
  </VideoGenerationDialog>;
}
