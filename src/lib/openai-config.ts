/** The API base shared by OpenAI image generation and its read-only connection probe. */
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

export function normalizeOpenAIBaseUrl(baseUrl?: string): string {
  const base = baseUrl?.trim().replace(/\/+$/, "") || OPENAI_BASE_URL;
  try {
    const url = new URL(base);
    let path = url.pathname.replace(/\/+$/, "");
    // Accept a copied image endpoint while retaining custom gateway prefixes.
    path = path.replace(/\/images\/(?:edits|generations)$/, "");
    // These hosts serve their website at / and their OpenAI API at /v1.
    // HTH's /v1/models was verified with a read-only request; do not infer paths
    // for arbitrary self-hosted gateways that may intentionally use a root API.
    if (!path && ["api.openai.com", "hth.huaqing.run"].includes(url.hostname.toLowerCase())) {
      path = "/v1";
    }
    url.pathname = path;
    return url.toString().replace(/\/$/, "");
  } catch {
    return base;
  }
}
