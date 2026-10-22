/**
 * VolcEngine (Ark) provider implementation
 * Official API docs:
 * - Image (Seedream) sync: POST /api/v3/images/generations  https://www.volcengine.com/docs/82379/1541523
 * - Video (Seedance) async: POST /api/v3/contents/generations/tasks + GET /tasks/{id}  https://www.volcengine.com/docs/82379/1366799
 * Auth: Authorization: Bearer <ARK_API_KEY>
 * Note: the legacy visual.volcengineapi.com Visual service requires AK/SK signing and is deprecated; all calls now go through Ark.
 */

import { BaseProvider, ProviderError } from './base'
import { ARK_AGENT_PLAN_BASE_URL, ARK_STANDARD_BASE_URL, isArkAgentPlanBase, normalizeArkBaseUrl } from '../ark-config'
import type {
  ProviderConfig,
  ImageOptions,
  ImageResult,
  VideoOptions,
  VideoResult,
  TaskStatus,
  TaskStatusEnum,
  Model,
  MediaType,
} from './types'

// ==================== Ark API response types ====================

/** Image generation response (OpenAI-compatible: data[].url) */
interface ArkImageResponse {
  model?: string
  data?: Array<{ url?: string; b64_json?: string; size?: string }>
  images?: string[] // some API docs return an images array instead; handled for compatibility
  error?: { code?: string; message?: string }
}

/** Video task creation response */
interface ArkTaskCreateResponse {
  id: string
  error?: { code?: string; message?: string }
}

/** Video task query response */
interface ArkTaskQueryResponse {
  id: string
  model?: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  content?: { video_url?: string; last_frame_url?: string }
  generate_audio?: boolean
  error?: { code?: string; message?: string }
}

/** Ark content-role caps (Content Generation API schema; verified against a production integration) */
const ARK_MAX_REFERENCE_IMAGES = 9
const ARK_MAX_REFERENCE_VIDEOS = 3
const ARK_MAX_REFERENCE_AUDIOS = 3

/** Map width/height to an Ark video ratio */
function toRatio(width?: number, height?: number): string {
  const w = width ?? 0
  const h = height ?? 0
  if (w > h) return '16:9'
  if (h > w) return '9:16'
  if (w === h && w > 0) return '1:1'
  return 'adaptive'
}

/** Map width/height to an Ark image size; falls back to "2K" when outside Ark's pixel range (model picks aspect ratio from prompt) */
function toImageSize(width?: number, height?: number): string {
  const w = width ?? 0
  const h = height ?? 0
  const total = w * h
  // Ark total pixel range [2560x1440=3686400, 4096x4096=16777216]
  if (total >= 3686400 && total <= 16777216) return `${w}x${h}`
  return '2K'
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value) ? value : undefined
}

/** Seedance resolution is a tier, separate from the requested aspect ratio. */
function toVideoResolution(width?: number, height?: number): string | undefined {
  if (!width || !height || width <= 0 || height <= 0) return undefined
  const shortSide = Math.min(width, height)
  if (shortSide <= 480) return '480p'
  if (shortSide <= 720) return '720p'
  return '1080p'
}

/** Migrate standard catalog selections when the user switches to the AgentPlan endpoint. */
function toAgentPlanVideoModel(modelId: string): string {
  return modelId.replace(/^doubao-seedance-(2)-(0|5)(-(?:fast|mini))?(?:-\d{6})?$/, (_match, major, minor, variant = '') =>
    `doubao-seedance-${major}.${minor}${variant}`
  )
}

/** Keep Ark's image rejection tied to the exact submitted image, without retrying it. */
function explainInputImageRejection(error: ProviderError, body: unknown): ProviderError | undefined {
  const jsonStart = error.message.indexOf('{')
  if (jsonStart < 0) return undefined
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(error.message.slice(jsonStart)) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (!payload || typeof payload !== 'object') return undefined
  const detail = payload.error
  if (!detail || typeof detail !== 'object') return undefined
  const upstream = detail as Record<string, unknown>
  const code = typeof upstream.code === 'string' ? upstream.code : ''
  if (!code.startsWith('InputImageSensitiveContentDetected')) return undefined
  const message = typeof upstream.message === 'string' ? upstream.message : ''
  const param = typeof upstream.param === 'string' ? upstream.param : undefined
  const indexMatch = (param ?? '').match(/\bcontent\[(\d+)\]/i) ?? message.match(/\bcontent\[(\d+)\]/i)
  const parsedIndex = indexMatch ? Number(indexMatch[1]) : undefined
  const contentIndex = Number.isSafeInteger(parsedIndex) ? parsedIndex : undefined
  const content = body && typeof body === 'object' && 'content' in body && Array.isArray(body.content)
    ? body.content as Array<Record<string, unknown>>
    : []
  const input = contentIndex === undefined ? undefined : content[contentIndex]
  const imageNumber = input?.type === 'image_url'
    ? content.slice(0, contentIndex! + 1).filter((item) => item.type === 'image_url').length
    : undefined
  const inputRole = typeof input?.role === 'string' ? input.role : undefined
  const roleLabel = inputRole === 'first_frame' ? '首帧图' : inputRole === 'last_frame' ? '尾帧图' : inputRole === 'reference_image' ? '参考图' : undefined
  const inputLabel = imageNumber === undefined ? '输入图片' : `第 ${imageNumber} 张输入图片`
  const location = [contentIndex === undefined ? undefined : `content[${contentIndex}]`, roleLabel].filter(Boolean).join('，')
  const requestId = [upstream.request_id, upstream.requestId, payload.request_id, payload.requestId]
    .find((value): value is string => typeof value === 'string' && value.length > 0)
    ?? message.match(/request\s*id\s*:\s*([a-zA-Z0-9-]+)/i)?.[1]
  const privacyRejection = code === 'InputImageSensitiveContentDetected.PrivacyInformation'
  const reason = privacyRejection
    ? /real\s+(?:person|people|human)|真人|真实人物/i.test(message)
      ? '平台判定可能包含真人肖像，当前接口未接受该图片'
      : '平台判定可能包含隐私内容，当前接口未接受该图片'
    : '该图片未通过平台的输入内容审核'
  const explained = new ProviderError(
    `方舟拒绝${inputLabel}${location ? `（${location}）` : ''}：${reason}。请查看这张图片，并按方舟所选模型的图片使用要求更换素材。平台错误码：${code}${requestId ? `。Request id: ${requestId}` : ''}`,
    code,
    error.provider,
    error.statusCode
  )
  explained.requestId = requestId
  explained.param = param
  explained.contentIndex = contentIndex
  explained.referenceImageNumber = imageNumber
  explained.inputRole = inputRole
  return explained
}

export class VolcEngineProvider extends BaseProvider {
  readonly name = 'volcengine'
  readonly displayName = '火山引擎'

  constructor(config: ProviderConfig) {
    super({
      ...config,
      baseUrl: normalizeArkBaseUrl(config.baseUrl),
    })
  }

  /** Ark authenticates with a Bearer API key */
  protected getAuthHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.apiKey}` }
  }

  /** Explain Ark authorization failures without retrying a paid generation request. */
  protected async request<T = unknown>(
    path: string,
    options: Parameters<BaseProvider['request']>[1] = {}
  ): Promise<T> {
    try {
      return await super.request<T>(path, options)
    } catch (error) {
      if (error instanceof ProviderError && (error.statusCode === 401 || error.statusCode === 403)) {
        const agentPlan = isArkAgentPlanBase(this.config.baseUrl)
        const accessMode = agentPlan ? 'Agent Plan' : 'standard Ark'
        const guidance = error.statusCode === 401
          ? `Check that your API key matches the ${accessMode} endpoint. Agent Plan keys use ${ARK_AGENT_PLAN_BASE_URL}; standard Ark keys use ${ARK_STANDARD_BASE_URL}. Access Key ID/Secret credentials are not API keys.`
          : `Check that your ${accessMode} API key has access to the requested model and project, and that its plan or quota is available. A successful connection test does not prove model access.`
        throw new ProviderError(
          `${guidance} Current Base URL: ${this.config.baseUrl}. Upstream error: ${error.message}`,
          error.statusCode === 403 ? 'ARK_ACCESS_DENIED' : 'ARK_AUTH_ERROR',
          this.name,
          error.statusCode
        )
      }
      if (error instanceof ProviderError) {
        const explained = explainInputImageRejection(error, options.body)
        if (explained) throw explained
      }
      throw error
    }
  }

  /**
   * Generate an image (Seedream — synchronous, no polling needed)
   */
  async generateImage(options: ImageOptions): Promise<ImageResult> {
    // Older persisted settings occasionally contain `seed: ""`. Ark decodes seed as int64
    // and returns a cryptic 400 when that empty string is forwarded, so only accept real numbers.
    const extra = { ...(options.extra ?? {}) }
    const seed = finiteInteger(options.seed) ?? finiteInteger(extra.seed)
    delete extra.seed
    delete extra.image
    const referenceImages = (options.referenceImageUrls ?? []).filter(
      (url): url is string => typeof url === 'string' && url.trim().length > 0
    )
    const image = referenceImages.length > 1
      ? referenceImages
      : referenceImages[0] ?? options.referenceImageUrl
    const body: Record<string, unknown> = {
      model: options.modelId,
      prompt: options.prompt,
      size: toImageSize(options.width, options.height),
      response_format: 'url',
      watermark: false,
      // image-to-image / edit: pass image (URL or base64)
      ...(image && { image }),
      ...(seed != null && { seed }),
      ...extra,
    }

    const resp = await this.request<ArkImageResponse>('/images/generations', {
      method: 'POST',
      body,
    })

    if (resp.error) {
      throw new ProviderError(
        `火山方舟图像生成失败: ${resp.error.message ?? resp.error.code}`,
        resp.error.code ?? 'ARK_IMAGE_ERROR',
        this.name
      )
    }

    // Prefer data[].url; fall back to images[] string array for compatibility
    const urls = (resp.data?.map((d) => d.url).filter(Boolean) as string[]) ?? []
    if (urls.length === 0 && Array.isArray(resp.images)) {
      urls.push(...resp.images)
    }
    if (urls.length === 0) {
      throw new ProviderError('图像生成成功但未返回 URL', 'NO_RESULT', this.name)
    }

    return {
      taskId: 'sync',
      imageUrls: urls,
      modelId: options.modelId,
    }
  }

  /**
   * Build the content array per the Ark Content Generation API role protocol:
   * Frame conditioning and multimodal references are separate input modes. When an
   * older caller supplies both, carry its frame images as ordinary references in
   * first/last/reference order so existing @ImageN prompt mappings remain valid.
   */
  private buildVideoContent(options: VideoOptions): Array<Record<string, unknown>> {
    let text = options.prompt
    if (options.audioEnabled && options.audioPrompt && !text.includes(options.audioPrompt)) {
      text = `${text}。${options.audioPrompt}`
    } else if (options.audioEnabled && options.voiceover && !options.audioPrompt) {
      text = `${options.prompt}。旁白：「${options.voiceover}」`
    }
    const content: Array<Record<string, unknown>> = [{ type: 'text', text }]
    const isUrl = (url: unknown): url is string => typeof url === 'string' && url.trim().length > 0
    const validUrls = (urls: string[] | undefined) => (urls ?? []).filter(isUrl)
    const images = validUrls(options.referenceImageUrls).slice(0, ARK_MAX_REFERENCE_IMAGES)
    const videos = validUrls(options.referenceVideoUrls).slice(0, ARK_MAX_REFERENCE_VIDEOS)
    const audios = validUrls(options.referenceAudioUrls).slice(0, ARK_MAX_REFERENCE_AUDIOS)
    const referenceMode = images.length > 0 || videos.length > 0 || audios.length > 0
    const frames = [options.firstFrameUrl, options.lastFrameUrl].filter(isUrl)
    if (referenceMode && frames.length + images.length > ARK_MAX_REFERENCE_IMAGES) {
      throw new ProviderError(
        `方舟参考模式最多接收 ${ARK_MAX_REFERENCE_IMAGES} 张图片（包括转为参考图的首尾帧），请减少参考图片后再生成`,
        'TOO_MANY_REFERENCE_IMAGES',
        this.name
      )
    }
    if (isUrl(options.firstFrameUrl)) {
      content.push({ type: 'image_url', image_url: { url: options.firstFrameUrl }, role: referenceMode ? 'reference_image' : 'first_frame' })
    }
    if (isUrl(options.lastFrameUrl)) {
      content.push({ type: 'image_url', image_url: { url: options.lastFrameUrl }, role: referenceMode ? 'reference_image' : 'last_frame' })
    }
    for (const url of images) {
      content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
    }
    for (const url of videos) {
      content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
    }
    for (const url of audios) {
      content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })
    }
    return content
  }

  /**
   * Phase 1 of the two-phase contract (paid-task safety): submit and return the task ID
   * immediately so the caller can persist it BEFORE polling — a lost poll then recovers
   * the paid task instead of double-billing a resubmit.
   */
  async submitVideoTask(options: VideoOptions): Promise<{ taskId: string; modelId: string }> {
    const modelId = isArkAgentPlanBase(this.config.baseUrl)
      ? toAgentPlanVideoModel(options.modelId)
      : options.modelId
    const resolution = toVideoResolution(options.width, options.height)
    const extra = { ...(options.extra ?? {}) }
    const seed = finiteInteger(options.seed) ?? finiteInteger(extra.seed)
    delete extra.seed
    const body: Record<string, unknown> = {
      ratio: toRatio(options.width, options.height),
      ...(resolution && { resolution }),
      ...(options.duration != null && { duration: options.duration }),
      generate_audio: options.audioEnabled ?? false,
      watermark: false,
      // always ask for the clip's real final frame — it feeds tail-frame chaining and
      // sequential continuation past the single-call duration cap
      return_last_frame: true,
      ...(seed != null && { seed }),
      ...extra,
      model: modelId,
      // Reserved protocol fields cannot be replaced by persisted extra.content.
      content: this.buildVideoContent(options),
    }

    const created = await this.request<ArkTaskCreateResponse>(
      '/contents/generations/tasks',
      { method: 'POST', body }
    )
    if (created.error || !created.id) {
      throw new ProviderError(
        `火山方舟视频任务创建失败: ${created.error?.message ?? '未返回任务 ID'}`,
        created.error?.code ?? 'ARK_TASK_ERROR',
        this.name
      )
    }
    return { taskId: created.id, modelId }
  }

  /**
   * Generate a video (Seedance — async task + polling). Prefer submitVideoTask +
   * waitForTask when the task ID must be persisted before polling.
   */
  async generateVideo(options: VideoOptions): Promise<VideoResult> {
    const { taskId, modelId } = await this.submitVideoTask(options)
    const finalStatus = await this.pollTaskStatus(taskId, { interval: 5000 })
    const result = this.requireResult(finalStatus.result) as VideoResult
    result.modelId = modelId
    return result
  }

  /**
   * Query task status (video async tasks only)
   */
  async getTaskStatus(taskId: string): Promise<TaskStatus> {
    const data = await this.request<ArkTaskQueryResponse>(
      `/contents/generations/tasks/${taskId}`
    )
    const status = this.mapStatus(data.status)

    const taskStatus: TaskStatus = { taskId: data.id, status }

    if (status === 'completed' && data.content?.video_url) {
      taskStatus.result = {
        taskId: data.id,
        videoUrls: [data.content.video_url],
        modelId: data.model ?? '',
        hasAudio: data.generate_audio,
        // real final frame (return_last_frame:true) — the seam primitive for chaining
        ...(data.content.last_frame_url && { lastFrameUrl: data.content.last_frame_url }),
      }
    }
    if (status === 'failed') {
      taskStatus.error = data.error?.message
      taskStatus.errorCode = data.error?.code
    }
    return taskStatus
  }

  /** Map Ark task status to unified status */
  private mapStatus(s: ArkTaskQueryResponse['status']): TaskStatusEnum {
    switch (s) {
      case 'queued':
        return 'pending'
      case 'running':
        return 'processing'
      case 'succeeded':
        return 'completed'
      case 'failed':
        return 'failed'
      case 'cancelled':
        return 'cancelled'
      default:
        return 'processing'
    }
  }

  /**
   * Fetch available model list.
   * VolcEngine Ark models use the doubao- prefix; you can also create inference endpoints in the console and call them by endpoint ID.
   * Source: https://www.volcengine.com/docs/82379
   */
  async listModels(mediaType?: MediaType): Promise<Model[]> {
    if (isArkAgentPlanBase(this.config.baseUrl)) {
      if (mediaType === 'image') return []
      // These aliases were verified with the AgentPlan task API. Image access is not
      // inferred from standard Ark's catalog or a successful connection probe.
      return [
        ['doubao-seedance-2.5', 'Seedance 2.5'],
        ['doubao-seedance-2.0', 'Seedance 2.0'],
        ['doubao-seedance-2.0-fast', 'Seedance 2.0 Fast'],
        ['doubao-seedance-2.0-mini', 'Seedance 2.0 Mini'],
      ].map<Model>(([id, name]) => ({
        id,
        name,
        description: '方舟 AgentPlan 视频模型（套餐专用接口）',
        modes: ['text-to-video', 'image-to-video'],
        mediaType: 'video',
        provider: this.name,
        supportsAudio: true,
      }))
    }
    const models: Model[] = [
      // ==================== Video generation (Seedance) ====================
      {
        // Announced 2026-07-31; Ark API access is rolling out gradually — accounts
        // without access yet should stay on 2.0 (id verified against Ark pricing mirrors)
        id: 'doubao-seedance-2-5-260628',
        name: 'Seedance 2.5',
        description: '字节豆包视频生成 2.5，4-30 秒原生音频/人声（方舟陆续开放中，未开通可先用 2.0）',
        modes: ['text-to-video', 'image-to-video'],
        mediaType: 'video',
        provider: this.name,
        supportsAudio: true,
      },
      {
        id: 'doubao-seedance-2-0-260128',
        name: 'Seedance 2.0',
        description: '字节豆包视频生成 2.0，电影级画质，支持原生音频',
        modes: ['text-to-video', 'image-to-video'],
        mediaType: 'video',
        provider: this.name,
        supportsAudio: true,
      },
      {
        id: 'doubao-seedance-1-0-pro-250528',
        name: 'Seedance 1.0 Pro',
        description: '豆包视频 1.0 Pro，文/图生视频',
        modes: ['text-to-video', 'image-to-video'],
        mediaType: 'video',
        provider: this.name,
      },
      // ==================== Image generation (Seedream) ====================
      {
        id: 'doubao-seedream-5-0-260128',
        name: 'Seedream 5.0',
        description: '豆包图像 5.0，强中文理解、排版与质感（带货商品图佳）',
        modes: ['text-to-image', 'image-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
      {
        id: 'doubao-seedream-4-0-250828',
        name: 'Seedream 4.0',
        description: '豆包图像 4.0，多图参考输入，商品保真编辑',
        modes: ['text-to-image', 'image-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
    ]

    if (mediaType) return models.filter((m) => m.mediaType === mediaType)
    return models
  }
}
