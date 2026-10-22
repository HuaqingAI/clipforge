// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/ai/test-provider/route";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function probe(response: Response, baseUrl = "https://gateway.test/v1") {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  const result = await POST(new NextRequest("http://localhost/api/ai/test-provider", {
    method: "POST",
    body: JSON.stringify({ name: "openai", apiKey: "test-key", baseUrl }),
  }));
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(expect.any(String), expect.objectContaining({
    method: "GET",
    headers: { Authorization: "Bearer test-key" },
    body: undefined,
  }));
  expect(result.status).toBe(200);
  return { result: await result.json() as { status: string; message: string }, fetchMock };
}

describe("OpenAI read-only provider probe", () => {
  it("does not treat an HTML homepage with HTTP 200 as a successful API connection", async () => {
    const { result } = await probe(new Response("<!doctype html><html>PRIVATE_UPSTREAM_PAGE</html>", {
      headers: { "Content-Type": "text/html" },
    }));
    expect(result.status).toBe("unknown");
    expect(result.message).toContain("Base URL");
    expect(result.message).toContain("/v1");
    expect(result.message).not.toContain("PRIVATE_UPSTREAM_PAGE");
    expect(result.message).not.toContain("<html>");
  });

  it.each([
    ["malformed JSON", "{broken"],
    ["empty response", ""],
    ["missing model list", JSON.stringify({ object: "list" })],
    ["invalid model list", JSON.stringify({ data: {} })],
    ["empty model list", JSON.stringify({ data: [] })],
  ])("reports unknown for %s instead of a false success", async (_name, body) => {
    const { result } = await probe(new Response(body, { headers: { "Content-Type": "application/json" } }));
    expect(result.status).toBe("unknown");
    expect(result.message).toContain("Base URL");
    expect(result.message).toContain("/v1");
  });

  it("validates model-list JSON but explains that image editing and model permission remain unverified", async () => {
    const { result, fetchMock } = await probe(Response.json({ object: "list", data: [{ id: "gpt-image-2" }] }));
    expect(fetchMock.mock.calls[0][0]).toBe("https://gateway.test/v1/models");
    expect(result.status).toBe("ok");
    expect(result.message).toContain("模型列表");
    expect(result.message).toContain("/images/edits");
    expect(result.message).toContain("尚未验证");
  });

  it("keeps an authentication rejection invalid without exposing upstream content", async () => {
    const { result } = await probe(new Response("PRIVATE_AUTH_DETAIL", { status: 401 }));
    expect(result.status).toBe("invalid");
    expect(result.message).not.toContain("PRIVATE_AUTH_DETAIL");
  });

  it("normalizes the known HTH homepage URL before its single GET /models request", async () => {
    const { fetchMock, result } = await probe(Response.json({ data: [{ id: "gpt-image-2" }] }), "https://hth.huaqing.run/");
    expect(fetchMock.mock.calls[0][0]).toBe("https://hth.huaqing.run/v1/models");
    expect(result.status).toBe("ok");
  });

  it("does not retry non-success responses through a billable endpoint", async () => {
    const { result } = await probe(new Response("PRIVATE_ERROR", { status: 404 }));
    expect(result.status).toBe("unknown");
    expect(result.message).toContain("HTTP 404");
    expect(result.message).toContain("/v1");
    expect(result.message).not.toContain("PRIVATE_ERROR");
  });
});
