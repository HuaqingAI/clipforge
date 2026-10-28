"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TASK_FEED_REFRESH_EVENT } from "@/lib/task-feed";

export type GenerationStatus = "queued" | "running" | "waiting" | "importing" | "completed" | "failed" | "needs_attention" | "cancelled";
export type GenerationItemKind = "video" | "image" | "script" | "storyboard_grid" | "keyframe_refine";
export interface GenerationRunItem {
  id: string;
  kind: GenerationItemKind;
  scriptId?: string | null;
  shotId?: number | null;
  status: GenerationStatus;
  stage?: string | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
}
export interface GenerationRun {
  id: string;
  projectId: string;
  kind: GenerationItemKind | "video_batch" | "keyframe_refine_batch";
  label?: string | null;
  status: GenerationStatus;
  items: GenerationRunItem[];
  total: number;
  done: number;
  failed: number;
  createdAt?: string | number;
  updatedAt?: string | number;
  error?: string | null;
}
export interface GenerationRunInput {
  projectId: string;
  clientRequestId: string;
  kind: GenerationRun["kind"];
  label?: string;
  items: Array<{ kind: GenerationItemKind; scriptId?: string; shotId?: number; request: Record<string, unknown>; asset?: Record<string, unknown> }>;
}
export const GENERATION_RUNS_REFRESH_EVENT = "clipforge:generation-runs-refresh";
export const generationRunActive = (run: Pick<GenerationRun, "status">) => ["queued", "running", "waiting", "importing"].includes(run.status);
const EMPTY_RUNS: GenerationRun[] = [];

function changed() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(GENERATION_RUNS_REFRESH_EVENT));
  window.dispatchEvent(new Event(TASK_FEED_REFRESH_EVENT));
}
async function responseBody(response: Response): Promise<GenerationRun> {
  const body = await response.json().catch(() => null);
  if (!body) throw new Error("后台任务响应无法读取，请刷新任务列表核对提交结果。");
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : body.error?.message || "后台任务请求失败");
  if (!body || typeof body.id !== "string") throw new Error("未收到后台任务编号，请刷新任务列表核对提交结果。");
  return body as GenerationRun;
}
/** Inputs are sent once; execution and result import belong to the server. */
export async function submitGenerationRun(input: GenerationRunInput): Promise<GenerationRun> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error("后台任务提交超时，请刷新任务列表核对提交结果。")); }, 15_000); });
  try {
    const request = fetch("/api/generation-runs", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal: controller.signal,
    }).then(responseBody);
    return await Promise.race([request, deadline]);
  } finally { clearTimeout(timeout); changed(); }
}

export function useGenerationRuns(projectId: string) {
  const [snapshot, setSnapshot] = useState<{ projectId: string; runs: GenerationRun[] }>({ projectId, runs: [] });
  const runs = snapshot.projectId === projectId ? snapshot.runs : EMPTY_RUNS;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    let stopped = false;
    let active: AbortController | null = null;
    let again = false;
    let latest: GenerationRun[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSnapshot({ projectId, runs: [] }); setLoading(true); setError(null);
    async function read() {
      if (stopped || !projectId) { if (!stopped) setLoading(false); return; }
      if (active) { again = true; return; }
      if (timer) clearTimeout(timer);
      const controller = new AbortController(); active = controller;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const request = fetch(`/api/generation-runs?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
          const body = await response.json();
          if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "读取后台任务失败");
          if (!Array.isArray(body.runs)) throw new Error("后台任务列表格式错误");
          return body.runs as GenerationRun[];
        });
        const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error("读取后台任务超时，请重新刷新。")); }, 15_000); });
        const loaded = await Promise.race([request, deadline]);
        if (!stopped && !controller.signal.aborted) { latest = loaded; setSnapshot({ projectId, runs: latest }); setError(null); }
      } catch (failure) {
        if (!stopped) setError(failure instanceof Error ? failure.message : "读取后台任务失败");
      } finally {
        clearTimeout(timeout); active = null;
        if (!stopped) {
          setLoading(false);
          if (again) { again = false; void read(); }
          else if (document.visibilityState !== "hidden") timer = setTimeout(() => void read(), latest.some(generationRunActive) ? 2500 : 10_000);
        }
      }
    }
    const wake = () => {
      if (document.visibilityState === "hidden") { if (timer) clearTimeout(timer); }
      else void read();
    };
    refreshRef.current = read;
    window.addEventListener(GENERATION_RUNS_REFRESH_EVENT, wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    void read();
    return () => {
      stopped = true; active?.abort(); if (timer) clearTimeout(timer);
      refreshRef.current = async () => {};
      window.removeEventListener(GENERATION_RUNS_REFRESH_EVENT, wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [projectId]);
  const submitRun = useCallback(async (input: GenerationRunInput) => {
    const run = await submitGenerationRun(input);
    await refresh();
    return run;
  }, [refresh]);
  const action = useCallback(async (id: string, value: "cancel" | "retry_import") => {
    const run = await responseBody(await fetch(`/api/generation-runs/${encodeURIComponent(id)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: value }),
    }));
    changed(); await refresh(); return run;
  }, [refresh]);
  const cancelRun = useCallback((id: string) => action(id, "cancel"), [action]);
  const retryImport = useCallback((id: string) => action(id, "retry_import"), [action]);
  return { runs, loading: loading || snapshot.projectId !== projectId, error: snapshot.projectId === projectId ? error : null, refresh, submitRun, cancelRun, retryImport };
}
