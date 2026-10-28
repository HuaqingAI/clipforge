import { submitGenerationRun, type GenerationRun } from "@/lib/hooks/use-generation-runs";
import type { Shot } from "@/lib/db/schema";
import type { TideweCopyDocument } from "@/lib/tidewe/types";
import type { CreativeProfileSnapshot } from "@/lib/creative-profiles";

export interface SavedScript {
  id: string;
  version?: number;
  title: string | null;
  styleType: string;
  totalDuration: number | null;
  shots: Shot[];
  selected: boolean | null;
  copyDocument?: TideweCopyDocument | null;
  scriptHash?: string;
  creativeProfileSnapshot?: CreativeProfileSnapshot | null;
  generationMetadata?: { requestId?: string } | null;
}

/** A generation produces several alternatives sharing one version; older versions are history. */
export function currentScriptOptions<T extends { version?: number; selected?: boolean | null }>(rows: T[]): T[] {
  if (rows.length === 0) return rows;
  const versionOf = (row: T) => row.version ?? 1;
  const selected = rows.find((row) => row.selected);
  // No selection also represents an intentionally emptied batch after deleting its last option.
  if (!selected) return [];
  const currentVersion = versionOf(selected);
  return rows.filter((row) => versionOf(row) === currentVersion);
}

interface GenerationOptions {
  endpoint: string;
  method?: "POST" | "PATCH";
  payload: unknown;
  projectId: string;
  knownScriptIds: string[];
  signal: AbortSignal;
  messages: { failed: string; reload: string; unconfirmed: string };
  requestId?: string;
}

function isSavedScripts(value: unknown): value is SavedScript[] {
  return Array.isArray(value) && value.every((row) => row && typeof row.id === "string"
    && typeof row.styleType === "string" && Array.isArray(row.shots));
}

// Also settle when a transport never finishes reading its response body.
export function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Submit once. Leaving the page stops observation while the durable server task continues. */
export async function generateProjectScripts(options: GenerationOptions): Promise<SavedScript[]> {
  const { signal, projectId, messages } = options;
  if (signal.aborted) throw signal.reason;
  const payload = options.payload && typeof options.payload === "object" ? options.payload as Record<string, unknown> : {};
  const requestId = options.requestId ?? (typeof payload.requestId === "string" ? payload.requestId : crypto.randomUUID());
  let run = await submitGenerationRun({
    projectId, clientRequestId: requestId, kind: "script",
    items: [{ kind: "script", ...(typeof payload.sourceScriptId === "string" || typeof payload.scriptId === "string" ? { scriptId: String(payload.sourceScriptId ?? payload.scriptId) } : {}),
      request: { ...payload, projectId, generationEndpoint: options.endpoint, generationMethod: options.method ?? "POST" } }],
  });
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error(messages.unconfirmed)), 10 * 60_000);
  const readResult = async (value: GenerationRun): Promise<SavedScript[]> => {
    const result = value.items.find((item) => item.kind === "script")?.result;
    // A delayed generation can be saved as history while another script remains selected.
    // Its result contains only the new rows, so read canonical selection before updating UI.
    if (result?.historical !== true && isSavedScripts(result?.scripts) && result.scripts.some((row) => row.selected)) return result.scripts;
    const response = await fetch(`/api/project/${projectId}/scripts`, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(messages.reload);
    const rows: unknown = await response.json();
    if (!isSavedScripts(rows)) throw new Error(messages.reload);
    return rows;
  };
  try {
    while (!controller.signal.aborted) {
      if (run.status === "completed") return await abortable(readResult(run), controller.signal);
      if (["failed", "needs_attention", "cancelled"].includes(run.status)) {
        throw new Error(run.items.find((item) => item.error)?.error || run.error || messages.failed);
      }
      await abortable(new Promise((resolve) => setTimeout(resolve, 1500)), controller.signal);
      const response = await fetch(`/api/generation-runs/${encodeURIComponent(run.id)}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(messages.reload);
      run = await abortable(response.json(), controller.signal) as GenerationRun;
    }
    throw controller.signal.reason;
  } finally {
    clearTimeout(timeout); signal.removeEventListener("abort", cancel); controller.abort();
  }
}
