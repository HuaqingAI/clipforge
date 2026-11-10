// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/ai/test-provider/route";
import { VolcEngineProvider } from "@/lib/providers/volcengine";

afterEach(() => vi.unstubAllGlobals());

it.each(["image", "video"])("explains Ark 403 for %s without retrying or hiding the request ID", async (media) => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    error: { code: "AccessDenied", message: "Request id: ark-request-30" },
  }), { status: 403 }));
  vi.stubGlobal("fetch", fetchMock);
  const provider = new VolcEngineProvider({ name: "volcengine", apiKey: "test-key", baseUrl: "" });
  const options = { modelId: "test-model", prompt: "test" };
  const request = media === "image"
    ? provider.generateImage({ ...options, mode: "text-to-image" })
    : provider.submitVideoTask({ ...options, mode: "text-to-video" });
  await expect(request).rejects.toMatchObject({
    code: "ARK_ACCESS_DENIED", statusCode: 403, provider: "volcengine",
    message: expect.stringContaining("ark-request-30"),
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("points AgentPlan users at the plan endpoint when the standard endpoint rejects their key", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })));
  const provider = new VolcEngineProvider({ name: "volcengine", apiKey: "test-key", baseUrl: "" });
  await expect(provider.generateImage({ modelId: "test", prompt: "test", mode: "text-to-image" }))
    .rejects.toMatchObject({ code: "ARK_AUTH_ERROR", statusCode: 401, message: expect.stringContaining("/api/plan/v3") });
});

it.each([undefined, " https://ark.cn-beijing.volces.com/api/plan/v3/ ", "https://custom.example/api/v3"])("rejects retired Ark probes without a network request for %j", async (baseUrl) => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const response = await POST(new NextRequest("http://localhost/api/ai/test-provider", {
    method: "POST", headers: { "Accept-Language": "en" }, body: JSON.stringify({ name: "volcengine", apiKey: "test-key", baseUrl }),
  }));
  const body = await response.json();
  expect(response.status).toBe(400);
  expect(body.status).toBe("unknown");
  expect(body.message).toContain("disabled");
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each(["alibaba", "siliconflow"])("rejects the retired %s provider even when a custom base is supplied", async (name) => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const response = await POST(new NextRequest("http://localhost/api/ai/test-provider", {
    method: "POST",
    body: JSON.stringify({ name, apiKey: "test-key", baseUrl: "https://custom.example/v1" }),
  }));
  const body = await response.json();
  expect(response.status).toBe(400);
  expect(body.status).toBe("unknown");
  expect(body.message).toContain("已停用");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("keeps an authenticated non-Ark provider probe successful", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
  const response = await POST(new NextRequest("http://localhost/api/ai/test-provider", {
    method: "POST", body: JSON.stringify({ name: "replicate", apiKey: "test-key" }),
  }));
  expect((await response.json()).status).toBe("ok");
});
