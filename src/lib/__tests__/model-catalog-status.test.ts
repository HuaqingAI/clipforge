// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const catalogCalls = vi.hoisted(() => vi.fn());
vi.mock("@/lib/kling/local-access", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/kling/local-access")>(), assertKlingLocalRequest: vi.fn() }));
vi.mock("@/lib/providers", () => ({ createProvider: ({ name }: { name: string }) => ({ listModels: async (mediaType: string) => {
  catalogCalls(name, mediaType);
  if (name === "failed") throw new Error("secret-api-key https://private.example/token");
  return name === "empty" ? [] : [{ id: "model", provider: name, mediaType, name: "Model", modes: ["text-to-image"] }];
} }) }));
import { POST } from "@/app/api/ai/models/route";
describe("per-provider catalog status", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("preserves successful results and reports redacted partial failure", async () => {
    const response = await POST(new NextRequest("http://localhost/api/ai/models", { method: "POST", body: JSON.stringify({ providers: [{ name: "ready" }, { name: "failed" }, { name: "empty" }], mediaType: "image" }) }));
    const result = await response.json();
    expect(result.models).toHaveLength(1);
    expect(result.providers.map((provider: { status: string }) => provider.status)).toEqual(["ready", "error", "empty"]);
    expect(JSON.stringify(result)).not.toMatch(/secret-api-key|private.example/);
    expect(result.providers.every((provider: { checkedAt: string }) => !!provider.checkedAt)).toBe(true);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects malformed provider input", async () => {
    const response = await POST(new NextRequest("http://localhost/api/ai/models", { method: "POST", body: JSON.stringify({ providers: [null] }) }));
    expect(response.status).toBe(400);
  });
  it.each(["image", "video", undefined])("only reads supported provider catalogs for %s", async (mediaType) => {
    const response = await POST(new NextRequest("http://localhost/api/ai/models", {
      method: "POST", body: JSON.stringify({ providers: ["openai", "kling-cli", "volcengine", "alibaba", "siliconflow"].map((name) => ({ name })), mediaType }),
    }));
    expect(response.status).toBe(200);
    const expected = mediaType === "image" ? [["openai", "image"]] : mediaType === "video" ? [["kling-cli", "video"]] : [["openai", "image"], ["kling-cli", "video"]];
    expect(catalogCalls.mock.calls).toEqual(expected);
    const result = await response.json();
    expect(result.providers.map(({ provider, mediaType }: { provider: string; mediaType: string }) => [provider, mediaType])).toEqual(expected);
  });
});
