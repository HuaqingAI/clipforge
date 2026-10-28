/** Browser-only helper for the local CLI. Contains no provider credentials. */
let tokenPromise: Promise<string> | undefined;
async function csrfToken(): Promise<string> {
  tokenPromise ??= fetch("/api/integrations/elevenlabs/session", {
    cache: "no-store", credentials: "same-origin", headers: { "X-Clipforge-ElevenLabs": "1" },
  }).then(async (response) => {
    const body = await response.json();
    if (!response.ok || typeof body.csrfToken !== "string") throw new Error(elevenLabsErrorMessage(body, "无法建立本机 ElevenLabs 会话"));
    return body.csrfToken;
  }).catch((error) => { tokenPromise = undefined; throw error; });
  return tokenPromise;
}

export async function elevenLabsFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Clipforge-ElevenLabs-CSRF", await csrfToken());
  if (init.method && init.method !== "GET" && init.method !== "HEAD") headers.set("Content-Type", "application/json");
  const response = await fetch(input, { ...init, headers, credentials: "same-origin", cache: "no-store" });
  if (response.status === 401) tokenPromise = undefined;
  // Never replay a mutation: a lost response can still represent a billed generation.
  return response;
}
export const elevenLabsLocalFetch = elevenLabsFetch;

export function elevenLabsErrorMessage(body: unknown, fallback = "ElevenLabs 操作失败"): string {
  if (!body || typeof body !== "object") return fallback;
  const error = (body as { error?: unknown }).error;
  return typeof error === "string" ? error : error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : fallback;
}
