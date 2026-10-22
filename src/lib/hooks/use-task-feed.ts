"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EMPTY_TASK_FEED, TASK_FEED_REFRESH_EVENT, parseTaskFeed, type TaskFeed } from "@/lib/task-feed";

export const TASK_ACTIVE_POLL_MS = 15_000;
export const TASK_IDLE_POLL_MS = 30_000;
export const TASK_REQUEST_TIMEOUT_MS = 10_000;

/** 始终发现新任务；后台暂停、回到页面立即刷新，同一时刻只有一个读取请求。 */
export function useTaskFeed() {
  const [state, setState] = useState<{ feed: TaskFeed; loading: boolean; error: boolean; updatedAt: number | null }>({
    feed: EMPTY_TASK_FEED, loading: true, error: false, updatedAt: null,
  });
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    let stopped = false;
    let current = EMPTY_TASK_FEED;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: AbortController | null = null;
    let refreshQueued = false;
    const visible = () => document.visibilityState !== "hidden";
    const schedule = () => {
      if (timer) clearTimeout(timer);
      if (stopped || !visible()) return;
      timer = setTimeout(() => void read(), current.active.length || current.attention.length ? TASK_ACTIVE_POLL_MS : TASK_IDLE_POLL_MS);
    };
    async function read() {
      if (stopped || active || !visible()) return;
      if (timer) clearTimeout(timer);
      const controller = new AbortController();
      active = controller;
      refreshQueued = false;
      setState((previous) => ({ ...previous, loading: true }));
      const timeout = setTimeout(() => controller.abort(), TASK_REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch("/api/tasks", { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("TASK_FEED_UNAVAILABLE");
        const feed = parseTaskFeed(await response.json());
        if (stopped || refreshQueued) return;
        if (controller.signal.aborted) throw new Error("TASK_FEED_TIMEOUT");
        current = feed;
        setState({ feed, loading: false, error: false, updatedAt: Date.now() });
      } catch {
        if (!stopped && !refreshQueued) setState((previous) => ({ ...previous, loading: false, error: true }));
      } finally {
        clearTimeout(timeout);
        active = null;
        if (!stopped && refreshQueued && visible()) void read();
        else schedule();
      }
    }
    const wake = () => { if (visible()) void read(); else if (timer) clearTimeout(timer); };
    // A local mutation invalidates any response already in flight. Coalesce notifications
    // into one follow-up read so a deleted task cannot return from an older response.
    const invalidate = () => { refreshQueued = true; void read(); };
    refreshRef.current = () => void read();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    window.addEventListener(TASK_FEED_REFRESH_EVENT, invalidate);
    timer = setTimeout(() => void read(), 0);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      active?.abort();
      refreshRef.current = () => {};
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener(TASK_FEED_REFRESH_EVENT, invalidate);
    };
  }, []);
  return { ...state, refresh };
}
