import type { SavedAssetRow } from "@/lib/assets-view";
import type { Shot } from "@/lib/db/schema";

export const ASSET_PAGE_REQUEST_TIMEOUT_MS = 10_000;
export const ASSET_PAGE_RETRY_DELAY_MS = 300;

export interface AssetPageProject {
  id?: string;
  name?: string | null;
  productName?: string | null;
  productImages?: string[] | null;
  contentType?: string | null;
  productCategory?: string | null;
  creativeProfile?: unknown;
  creativeConfigRevision?: number | null;
  creativeIntent?: unknown;
  visualBible?: unknown;
  characterId?: string | null;
}

export interface AssetPageScript {
  id?: string;
  selected?: boolean | null;
  shots?: Shot[] | null;
  title?: string | null;
  scriptHash?: string;
  copyDocument?: { pacingVersion?: string } | null;
}

export interface AssetPageSnapshot {
  project: AssetPageProject;
  scripts: AssetPageScript[];
  savedAssets: SavedAssetRow[];
}

export class AssetPageLoadError extends Error {
  constructor(
    public readonly code: "timeout" | "network" | "response" | "invalid",
    public readonly status?: number,
  ) {
    super(`Asset page load failed: ${code}${status ? ` (${status})` : ""}`);
    this.name = "AssetPageLoadError";
  }
}

const abortError = () => new DOMException("Asset page load cancelled", "AbortError");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isSavedAssetRow = (value: unknown): value is SavedAssetRow =>
  isRecord(value) && typeof value.shotId === "number" && Number.isFinite(value.shotId);
const isAssetPageScript = (value: unknown): value is AssetPageScript =>
  isRecord(value)
  && (value.id == null || typeof value.id === "string")
  && (value.selected == null || typeof value.selected === "boolean")
  && (value.title == null || typeof value.title === "string")
  && (value.scriptHash == null || typeof value.scriptHash === "string")
  && (value.shots == null || (Array.isArray(value.shots) && value.shots.every((shot: unknown) =>
    isRecord(shot) && typeof shot.shotId === "number" && Number.isFinite(shot.shotId))));

async function readJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) throw new AssetPageLoadError("response", response.status);
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new AssetPageLoadError("invalid");
    throw error;
  }
}

/** The deadline includes reading response bodies, even if a fetch mock/server ignores abort. */
async function loadAttempt(projectId: string, parentSignal: AbortSignal): Promise<AssetPageSnapshot> {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(abortError());
  parentSignal.addEventListener("abort", onParentAbort, { once: true });
  if (parentSignal.aborted) onParentAbort();
  const timeout = setTimeout(() => controller.abort(new AssetPageLoadError("timeout")), ASSET_PAGE_REQUEST_TIMEOUT_MS);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
  });
  try {
    const base = `/api/project/${encodeURIComponent(projectId)}`;
    const data = Promise.all([
      readJson(base, controller.signal),
      readJson(`${base}/scripts`, controller.signal),
      readJson(`${base}/assets`, controller.signal),
    ]).then(([project, scripts, savedAssets]): AssetPageSnapshot => {
      if (!isRecord(project) || "error" in project
        || !Array.isArray(scripts) || !scripts.every(isAssetPageScript)
        || !Array.isArray(savedAssets) || !savedAssets.every(isSavedAssetRow)) {
        throw new AssetPageLoadError("invalid");
      }
      return { project, scripts, savedAssets };
    });
    return await Promise.race([data, aborted]);
  } catch (error) {
    // Stop sibling requests when one fails; their results must not escape this attempt.
    controller.abort(error);
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", onParentAbort);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

function retryDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ASSET_PAGE_RETRY_DELAY_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function loadWithRetry(projectId: string, signal: AbortSignal): Promise<AssetPageSnapshot> {
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw abortError();
    try {
      return await loadAttempt(projectId, signal);
    } catch (cause) {
      if (signal.aborted) throw abortError();
      const error = cause instanceof AssetPageLoadError ? cause : new AssetPageLoadError("network");
      const transient = error.code === "timeout" || error.code === "network"
        || (error.code === "response" && (error.status === 408 || error.status === 429 || (error.status ?? 0) >= 500));
      if (attempt > 0 || !transient) throw error;
      await retryDelay(signal);
    }
  }
}

interface InFlight {
  projectId: string;
  controller: AbortController;
  promise: Promise<AssetPageSnapshot>;
  cleanupSignals: Array<() => void>;
}

/**
 * One loader belongs to one page instance. Concurrent loads share their pending
 * snapshot; they do not queue a later refresh or cache completed snapshots.
 * Switching project/cancel aborts the old load. A supplied signal cancels the
 * shared operation, so all callers observe the same cancellation.
 */
export function createAssetPageLoader() {
  let inFlight: InFlight | null = null;
  const cancel = () => {
    const previous = inFlight;
    inFlight = null;
    previous?.controller.abort(abortError());
  };
  return {
    cancel,
    load(projectId: string, options?: { signal?: AbortSignal }): Promise<AssetPageSnapshot> {
      const signal = options?.signal;
      if (signal?.aborted) return Promise.reject(abortError());
      if (inFlight && inFlight.projectId !== projectId) cancel();
      if (!inFlight) {
        const controller = new AbortController();
        const cleanupSignals: Array<() => void> = [];
        const operation: InFlight = {
          projectId,
          controller,
          cleanupSignals,
          promise: loadWithRetry(projectId, controller.signal).finally(() => {
            cleanupSignals.forEach((cleanup) => cleanup());
            if (inFlight === operation) inFlight = null;
          }),
        };
        inFlight = operation;
      }
      const operation = inFlight;
      if (signal) {
        const onAbort = () => {
          if (inFlight === operation) cancel();
          else operation.controller.abort(abortError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        operation.cleanupSignals.push(() => signal.removeEventListener("abort", onAbort));
      }
      return operation.promise;
    },
  };
}
