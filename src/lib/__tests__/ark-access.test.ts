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

it.each([200, 404, 500, 401, 403])("does not claim generation access from an Ark model-list probe (HTTP %s)", async (status) => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status }));
  vi.stubGlobal("fetch", fetchMock);
  const response = await POST(new NextRequest("http://localhost/api/ai/test-provider", {
    method: "POST", headers: { "Accept-Language": "en" }, body: JSON.stringify({ name: "volcengine", apiKey: "test-key" }),
  }));
  const body = await response.json();
  expect(body.status).toBe(status === 401 || status === 403 ? "invalid" : "unknown");
  expect(body.message).toMatch(/permissions|project/);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe("https://ark.cn-beijing.volces.com/api/v3/models");
  expect(fetchMock.mock.calls[0][1].method).toBe("GET");
});

it.each([200, 401, 403, 404, 500])("probes AgentPlan task listing without generating a video (HTTP %s)", async (status) => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ total: 0, items: [] }), { status }));
  vi.stubGlobal("fetch", fetchMock);
  const response = await POST(new NextRequest("http://localhost/api/ai/test-provider", {
    method: "POST",
    body: JSON.stringify({ name: "volcengine", apiKey: "test-plan-key", baseUrl: " https://ark.cn-beijing.volces.com/api/plan/v3/ " }),
  }));
  const body = await response.json();
  expect(body.status).toBe(status === 200 ? "ok" : status === 401 || status === 403 ? "invalid" : "unknown");
  expect(body.message).toContain("AgentPlan");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe("https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks?page_size=1");
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "GET", headers: { Authorization: "Bearer test-plan-key" } });
  expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
});

it("keeps an authenticated non-Ark provider probe successful", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
  const response = await POST(new NextRequest("http://localhost/api/ai/test-provider", {
    method: "POST", body: JSON.stringify({ name: "replicate", apiKey: "test-key" }),
  }));
  expect((await response.json()).status).toBe("ok");
});
