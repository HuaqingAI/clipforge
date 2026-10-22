/** Browser-only fetch for protected local integration endpoints. No provider credentials. */
let tokenPromise: Promise<string> | undefined;
async function csrfToken(): Promise<string> {
  tokenPromise ??= fetch("/api/integrations/kling/session", {
    cache: "no-store", credentials: "same-origin", headers: { "X-Clipforge-Kling": "1" },
  }).then(async (response) => {
    const body = await response.json();
    if (!response.ok || typeof body.csrfToken !== "string") {
      throw new Error(body.error?.message ?? "无法建立本机 Kling 会话");
    }
    return body.csrfToken;
  }).catch((error) => { tokenPromise = undefined; throw error; });
  return tokenPromise;
}

export async function klingFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Clipforge-Kling-CSRF", await csrfToken());
  if (init.method && init.method !== "GET" && init.method !== "HEAD") headers.set("Content-Type", "application/json");
  const response = await fetch(input, { ...init, headers, credentials: "same-origin", cache: "no-store" });
  if (response.status === 401) tokenPromise = undefined;
  // Mutations are never automatically retried, including session failures.
  return response;
}

export function klingErrorMessage(body: unknown, fallback = "Kling 操作失败"): string {
  if (!body || typeof body !== "object") return fallback;
  const error = (body as { error?: unknown }).error;
  return typeof error === "string" ? error : error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : fallback;
}
