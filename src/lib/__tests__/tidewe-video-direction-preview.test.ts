// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({ preview: vi.fn(), prepare: vi.fn(), rows: [] as Array<{ id: string; shots: Array<{ shotId: number; description: string }> }> }));
vi.mock("@/lib/server/video-prompt", () => ({
  previewProjectVideoPrompt: state.preview,
  VideoPromptError: class VideoPromptError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } },
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ all: () => state.rows }) }) }) }) }));
vi.mock("@/lib/current-script", () => ({ resolveCurrentScript: (rows: unknown[]) => rows[0] }));
vi.mock("@/lib/server/tidewe-video-direction", async (original) => ({ ...await original<typeof import("@/lib/server/tidewe-video-direction")>(), prepareTideweVideoDirections: state.prepare }));

import { POST } from "@/app/api/project/[id]/video-prompt/route";
import { VideoPromptError } from "@/lib/server/video-prompt";
import { TideweVideoDirectionError } from "@/lib/server/tidewe-video-direction";

const config = { baseUrl: "https://text.invalid/v1", apiKey: "preparation-only-secret", model: "text-model" };
const preview = { prompt: "Approved English video direction.", contextKey: "review-hash" };
const body = { scriptId: "script", shotId: 2, llmConfig: config };
const run = (value = body) => POST(new NextRequest("http://localhost/api/project/project/video-prompt", { method: "POST", body: JSON.stringify(value) }), { params: Promise.resolve({ id: "project" }) });

beforeEach(() => {
  state.rows = [{ id: "script", shots: [{ shotId: 2, description: "现有手指轻按一次。" }] }];
  state.preview.mockReset().mockReturnValue(preview);
  state.prepare.mockReset().mockResolvedValue(undefined);
});

describe("video preview English preparation boundary", () => {
  it("reuses a compiled/cached direction without calling a text model", async () => {
    expect(await (await run()).json()).toEqual(preview);
    expect(state.prepare).not.toHaveBeenCalled();
  });
  it("prepares only a validated missing direction, then rechecks and returns the compiler result", async () => {
    state.preview.mockImplementationOnce(() => { throw new TideweVideoDirectionError("TIDEWE_VIDEO_DIRECTION_REQUIRED", "Prepare first"); });
    const response = await run();
    expect(response.status).toBe(200);
    expect(state.prepare).toHaveBeenCalledWith([state.rows[0].shots[0]], config);
    expect(state.preview).toHaveBeenCalledTimes(2);
    expect(await response.json()).toEqual(preview);
  });
  it("does not translate an invalid review and refuses edits made while preparation is running", async () => {
    state.preview.mockImplementationOnce(() => { throw new VideoPromptError("SCRIPT_CONTEXT_CHANGED", "Changed", 409); });
    expect((await run()).status).toBe(409);
    expect(state.prepare).not.toHaveBeenCalled();
    state.preview.mockImplementationOnce(() => { throw new TideweVideoDirectionError("TIDEWE_VIDEO_DIRECTION_REQUIRED", "Prepare first"); })
      .mockImplementationOnce(() => { throw new VideoPromptError("SCRIPT_CONTEXT_CHANGED", "Changed during preparation", 409); });
    const response = await run();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "SCRIPT_CONTEXT_CHANGED" });
  });
  it("returns a clear preparation failure before any video submission", async () => {
    state.preview.mockImplementationOnce(() => { throw new TideweVideoDirectionError("TIDEWE_VIDEO_DIRECTION_REQUIRED", "Prepare first"); });
    state.prepare.mockRejectedValueOnce(new TideweVideoDirectionError("TIDEWE_VIDEO_DIRECTION_MODEL_REQUIRED", "请配置文字模型。"));
    const response = await run();
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "请配置文字模型。", code: "TIDEWE_VIDEO_DIRECTION_MODEL_REQUIRED" });
    expect(state.preview).toHaveBeenCalledOnce();
  });
});
