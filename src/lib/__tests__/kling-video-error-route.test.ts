// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { KlingCliResult } from "@/lib/kling/types";

const mocks = vi.hoisted(() => ({ assertLocalRequest: vi.fn(), createJob: vi.fn(), jobView: vi.fn() }));

vi.mock("@/lib/kling/local-access", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/kling/local-access")>(),
  assertKlingLocalRequest: mocks.assertLocalRequest,
}));
vi.mock("@/lib/kling/jobs", () => ({ createKlingJob: mocks.createJob }));
vi.mock("@/lib/kling/repository", () => ({ klingJobView: mocks.jobView }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/providers", () => ({ createProvider: vi.fn() }));
vi.mock("@/lib/ai-tasks", () => ({ recordAiTask: vi.fn(), updateAiTask: vi.fn() }));

import { POST } from "@/app/api/ai/video/route";
import { KlingError } from "@/lib/kling/errors";

const rawResult: KlingCliResult = {
  exitCode: 1,
  signal: null,
  stdout: "internal-stdout-with-access-token",
  stderr: "internal-stderr-with-private-credential-path",
  json: { access_token: "internal-oauth-secret" },
  timedOut: false,
  aborted: false,
};

function request() {
  return new NextRequest("http://localhost/api/ai/video", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "kling-cli", projectId: "fixture-project", shotId: 1 }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.assertLocalRequest.mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("Kling video submission failure responses", () => {
  it.each([
    ["TIDEWE_NATIVE_AUDIO_UNSUPPORTED", "当前 Kling 模型不支持原生音频，请选择支持英语真人口播的模型。"],
    ["TIDEWE_NATIVE_DURATION_UNSUPPORTED", "当前 Kling 模型支持的时长不足以完成本镜真人口播，请选择支持更长时长的模型。"],
    ["PREMIUM_CG_PRODUCT_REFERENCE_REQUIRED", "高端产品 CG 需要至少一张已保存的产品参考图。"],
  ])("preserves actionable submission validation for %s without CLI diagnostics", async (code, message) => {
    mocks.createJob.mockRejectedValueOnce(new KlingError(code, message, 422, rawResult));

    const response = await POST(request());

    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: { code, message, retryable: false } });
    expect(mocks.createJob).toHaveBeenCalledOnce();
    expect(mocks.jobView).not.toHaveBeenCalled();
  });

  it.each([
    ["KLING_PROFILE_BUSY", "当前账号正在执行其他操作，请稍后重试。"],
    ["CREATIVE_CONFIG_STALE", "创作配置已变更，请重新确认分镜。"],
  ])("preserves recovery metadata for existing %s errors", async (code, message) => {
    mocks.createJob.mockRejectedValueOnce(Object.assign(new KlingError(code, message, 409, rawResult), {
      jobId: "fixture-job",
      retryable: true,
    }));

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code, message, retryable: true }, jobId: "fixture-job" });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("logs unexpected submission reasons with credentials redacted and hides diagnostics from the browser", async () => {
    mocks.createJob.mockRejectedValueOnce(Object.assign(
      new Error([
        "spawn EACCES C:\\fixture-private-user\\.credentials",
        "access_token=fixture-access-secret",
        "Authorization: Bearer fixture-bearer-secret",
        "https://signed-fixture.invalid/video?signature=fixture-url-secret",
      ].join("\n")),
      { code: "EACCES", result: rawResult },
    ));

    const response = await POST(request());

    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload).toMatchObject({ error: { code: "KLING_INTERNAL_ERROR", retryable: false } });
    expect(JSON.stringify(payload)).not.toMatch(/EACCES|private|credentials|fixture-|internal-|access_token/);
    expect(console.error).toHaveBeenCalledOnce();
    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).toContain("EACCES");
    expect(logged).not.toMatch(/fixture-(?:access|bearer|url)-secret|fixture-private-user|\.credentials|signed-fixture\.invalid/);
    expect(mocks.jobView).not.toHaveBeenCalled();
  });

  it("handles null thrown by the submission dependency", async () => {
    mocks.createJob.mockRejectedValueOnce(null);

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "KLING_INTERNAL_ERROR" } });
  });
});
