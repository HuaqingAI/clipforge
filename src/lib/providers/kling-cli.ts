import type { AIProvider, ImageOptions, ImageResult, MediaType, Model, ProviderConfig, TaskStatus, VideoOptions, VideoResult } from "./types";
import { ProviderError } from "./base";

/** Catalog-only adapter. All billable commands must enter the durable Kling job service. */
export class KlingCliProvider implements AIProvider {
  readonly name = "kling-cli";
  readonly displayName = "Kling 官方 CLI";
  catalogMetadata: AIProvider["catalogMetadata"];

  constructor(private readonly config: ProviderConfig) {}

  private guardedEntry(): never {
    throw new ProviderError("Kling CLI 请使用单镜头生成与原任务恢复入口。", "KLING_JOB_SERVICE_REQUIRED", this.name, 422);
  }

  async generateImage(options: ImageOptions): Promise<ImageResult> { void options; return this.guardedEntry(); }
  async generateVideo(options: VideoOptions): Promise<VideoResult> { void options; return this.guardedEntry(); }
  async submitVideoTask(options: VideoOptions): Promise<{ taskId: string; modelId: string }> { void options; return this.guardedEntry(); }
  async getTaskStatus(taskId: string): Promise<TaskStatus> { void taskId; return this.guardedEntry(); }

  async listModels(mediaType?: MediaType, options?: { refresh?: boolean }): Promise<Model[]> {
    if (mediaType === "image") return [];
    const { getPublicKlingStatus } = await import("@/lib/kling/profiles");
    let status = getPublicKlingStatus(this.config.profileId);
    if (!status.profile) throw new ProviderError("请先配置本机 Kling CLI。", "KLING_NOT_CONFIGURED", this.name, 503);
    if (status.profile.disabledAt) throw new ProviderError("此 Kling 配置已停用。", "KLING_PROFILE_DISABLED", this.name, 409);
    if (status.profile.environmentState !== "ready") throw new ProviderError("请先在设置页检测 Kling CLI 环境。", "KLING_ENVIRONMENT_UNAVAILABLE", this.name, 503);
    if (!status.loggedIn) throw new ProviderError("请先在设置页登录 Kling 原账号。", "KLING_AUTH_REQUIRED", this.name, 401);
    const expired = !status.profile.catalogCheckedAt || Date.now() - status.profile.catalogCheckedAt > 5 * 60_000;
    if (options?.refresh || expired) {
      const { refreshProfile } = await import("@/lib/kling/auth");
      await refreshProfile(status.profile.id);
      status = getPublicKlingStatus(status.profile.id);
      if (!status.loggedIn) throw new ProviderError("Kling 登录已失效，请重新登录原账号。", "KLING_AUTH_REQUIRED", this.name, 401);
    }
    this.catalogMetadata = { source: options?.refresh || expired ? "live" : "cache", updatedAt: new Date(status.profile!.catalogCheckedAt ?? Date.now()).toISOString() };
    return status.models.map((descriptor): Model => ({
      id: descriptor.selectionKey,
      name: `${descriptor.displayName} · ${descriptor.tool === "image_to_video" ? "图生视频" : "文生视频"}`,
      description: descriptor.description,
      modes: [descriptor.tool === "image_to_video" ? "image-to-video" : "text-to-video"],
      mediaType: "video", provider: this.name, supportsAudio: descriptor.capabilities.audio,
      extra: { ...descriptor },
    }));
  }
}
