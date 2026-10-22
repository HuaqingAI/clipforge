// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KlingCliProvider } from "@/lib/providers/kling-cli";
import type { KlingPublicStatus } from "@/lib/kling/types";

const state = vi.hoisted(() => ({ status: {} as KlingPublicStatus, refresh: vi.fn() }));
vi.mock("@/lib/kling/profiles", () => ({ getPublicKlingStatus: vi.fn(() => state.status) }));
vi.mock("@/lib/kling/auth", () => ({ refreshProfile: state.refresh }));

const provider = () => new KlingCliProvider({ name: "kling-cli", apiKey: "", baseUrl: "", profileId: "profile-1" });

describe("Kling catalog-only provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.status = { configured: true, loggedIn: true, profiles: [], profile: { id: "profile-1", environmentState: "ready", catalogCheckedAt: Date.now() } as KlingPublicStatus["profile"], models: [{ selectionKey: '["kling-cli","text_to_video","remote"]', provider: "kling-cli", profileId: "profile-1", region: "global", tool: "text_to_video", remoteModelId: "remote", displayName: "Live model", catalogRevision: "rev", available: true, parameters: [], inputSlots: [], capabilities: { image: false, tailFrame: false, multiImage: false, audio: false } }] };
  });

  it("never exposes CLI models in an image catalog", async () => {
    expect(await provider().listModels("image")).toEqual([]);
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("preserves tool, account, and capability descriptors without model-name guessing", async () => {
    const models = await provider().listModels("video");
    expect(models[0]).toMatchObject({ id: state.status.models[0].selectionKey, provider: "kling-cli", modes: ["text-to-video"], supportsAudio: false, extra: { profileId: "profile-1", tool: "text_to_video", remoteModelId: "remote", capabilities: { tailFrame: false } } });
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("fails a logged-out account without returning static models", async () => {
    state.status.loggedIn = false;
    await expect(provider().listModels("video")).rejects.toMatchObject({ code: "KLING_AUTH_REQUIRED" });
  });

  it("requires the durable job service for billable submission and task lookup", async () => {
    const instance = provider();
    await expect(instance.generateVideo({ modelId: "remote", mode: "text-to-video", prompt: "hello" })).rejects.toMatchObject({ code: "KLING_JOB_SERVICE_REQUIRED" });
    await expect(instance.submitVideoTask({ modelId: "remote", mode: "text-to-video", prompt: "hello" })).rejects.toMatchObject({ code: "KLING_JOB_SERVICE_REQUIRED" });
    await expect(instance.getTaskStatus("task-id")).rejects.toMatchObject({ code: "KLING_JOB_SERVICE_REQUIRED" });
  });
});
