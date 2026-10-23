import { abortable } from "@/lib/script-generation-client";
import type { VideoPromptContext, VideoPromptPreview, VideoPromptRequest } from "@/lib/video-prompt-request";

export type ServerVideoPrompt = VideoPromptPreview & { promptContext: VideoPromptContext };

/** Fetch the complete execution prompt. The browser displays this text without rewriting it. */
export async function fetchVideoPrompt(projectId: string, request: VideoPromptRequest, signal?: AbortSignal): Promise<ServerVideoPrompt> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("读取视频提示词超时，请重试。")), 15_000);
  try {
    return await abortable((async () => {
      const response = await fetch(`/api/project/${encodeURIComponent(projectId)}/video-prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "读取视频提示词失败，请重试。");
      if (typeof data?.prompt !== "string" || !data.prompt.trim() || typeof data.negativePrompt !== "string"
        || typeof data.contextKey !== "string" || !data.contextKey || data.scriptId !== request.scriptId || data.shotId !== request.shotId
        || !data.controlPlan || typeof data.controlPlan !== "object") {
        throw new Error("后端未返回有效的视频提示词，请重试。");
      }
      return { ...data, promptContext: { ...request, contextKey: data.contextKey } };
    })(), controller.signal);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
    controller.abort();
  }
}
