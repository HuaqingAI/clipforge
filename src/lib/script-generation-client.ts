import type { Shot } from "@/lib/db/schema";

export interface SavedScript {
  id: string;
  title: string | null;
  styleType: string;
  totalDuration: number | null;
  shots: Shot[];
  selected: boolean | null;
}

interface GenerationOptions {
  endpoint: string;
  payload: unknown;
  projectId: string;
  knownScriptIds: string[];
  signal: AbortSignal;
  messages: { failed: string; reload: string; unconfirmed: string };
}

function isSavedScripts(value: unknown): value is SavedScript[] {
  return Array.isArray(value) && value.every((row) => row && typeof row.id === "string"
    && typeof row.styleType === "string" && Array.isArray(row.shots));
}

// Also settle when a transport never finishes reading its response body.
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Observe saved results independently of the long-running generation request. */
export async function generateProjectScripts(options: GenerationOptions): Promise<SavedScript[]> {
  const { endpoint, payload, projectId, signal, messages } = options;
  const knownIds = new Set(options.knownScriptIds);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  const deadline = setTimeout(() => controller.abort(new Error(messages.unconfirmed)), 10 * 60_000);

  const readScripts = async () => {
    const readController = new AbortController();
    const cancel = () => readController.abort(controller.signal.reason);
    if (controller.signal.aborted) cancel();
    else controller.signal.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(() => readController.abort(new Error(messages.reload)), 15_000);
    try {
      return await abortable((async () => {
        const response = await fetch(`/api/project/${projectId}/scripts`, {
          cache: "no-store", signal: readController.signal,
        });
        if (!response.ok) throw new Error(messages.reload);
        const rows: unknown = await response.json();
        if (!isSavedScripts(rows)) throw new Error(messages.reload);
        return rows;
      })(), readController.signal);
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", cancel);
      readController.abort();
    }
  };

  const request = async () => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || messages.failed);
    // Both generation routes return persisted scripts, so no second request is needed.
    if (isSavedScripts(data?.scripts) && data.scripts.length > 0) return data.scripts;
    const rows = await readScripts();
    if (rows.length === 0) throw new Error(messages.reload);
    return rows;
  };

  const observe = async () => {
    while (!controller.signal.aborted) {
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(controller.signal.reason); };
        const timer = setTimeout(() => {
          controller.signal.removeEventListener("abort", cancel);
          resolve();
        }, 2500);
        controller.signal.addEventListener("abort", cancel, { once: true });
      });
      try {
        const rows = await readScripts();
        // Old selections and archived results from a changed creative profile are not completion.
        if (rows.some((row) => row.selected && !knownIds.has(row.id))) return rows;
      } catch {
        // A transient read failure must not interrupt the generation request.
      }
    }
    throw controller.signal.reason;
  };

  try {
    return await abortable(Promise.race([request(), observe()]), controller.signal);
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
