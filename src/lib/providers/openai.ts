/**
 * HTH OpenAI 兼容 Provider 实现
 * 支持图片生成（文生图 + 图生图编辑）：GPT Image 系列（2.6 / 2.5 Flare / Sunburst、2、1.5 等），兼容 DALL·E 3/2。
 * 文档参考: https://platform.openai.com/docs/api-reference/images
 *
 * 说明：
 * - 文生图：POST /images/generations（JSON，同步返回）。
 * - 图生图（编辑）：POST /images/edits（multipart/form-data，同步返回），
 *   支持 gpt-image-* 与 dall-e-2；dall-e-3 不支持编辑。
 * - gpt-image-* 系列只返回 base64（b64_json），不支持 response_format；
 *   DALL·E 2/3 支持 response_format=url。本实现统一把 base64 包成 data URI 返回，
 *   下游落库（persistSource）已支持 data: 协议。
 * - gpt-image-2 / 2.5 / 2.6 支持任意分辨率（宽高被 16 整除、比例 1:3~3:1），竖屏带货可直接出 9:16。
 * - MiniMax-H3 视频使用 HTH 的原生 /v2/video_generation 异步接口，成品为可下载直链。
 */

import { BaseProvider, ProviderError } from './base'
import { normalizeOpenAIBaseUrl } from '@/lib/openai-config'
import { OPENAI_MASK_IMAGE_MODELS } from '@/lib/openai-image-capabilities'
import { HTH_VIDEO_MODEL, HTH_VIDEO_DURATIONS, HTH_VIDEO_RESOLUTIONS, HTH_VIDEO_RATIOS, hthVideoResolution, normalizeHTHVideoBaseUrl } from '@/lib/hth-video-config'
import { pickEnumDuration, pickRatio } from './atlas-video-params'
import { generationCheckpoint, GenerationTaskPending } from '@/lib/provider-generation-hooks'
import type {
  ProviderConfig,
  ImageOptions,
  ImageResult,
  VideoOptions,
  VideoResult,
  TaskStatus,
  Model,
  MediaType,
} from './types'

// ==================== OpenAI API 响应类型 ====================

interface OpenAIImageResponse {
  created: number
  data: Array<{
    url?: string
    b64_json?: string
    revised_prompt?: string
  }>
  [key: string]: unknown
}

interface H3Response {
  task_id?: string
  request_id?: string
  error?: { type?: string; message?: string; http_code?: string }
  base_resp?: { status_code?: number; status_msg?: string }
  task?: {
    id?: string
    status?: string
    model?: string
    duration?: number
    content?: { url?: string }
    error?: { code?: string; message?: string }
  }
}

const MASK_IMAGE_MODELS = new Set(OPENAI_MASK_IMAGE_MODELS)
const DEFAULT_HIGH_QUALITY_IMAGE_MODELS = new Set(['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'])

/** Header/chunk validation needs neither a filesystem nor an image decoder. */
function pngInfo(bytes: Buffer): { width: number; height: number; alpha: boolean } | undefined {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  const depth = bytes[24], color = bytes[25]
  const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
  if (!width || !height || !depths[color]?.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) return
  let imageData = false
  for (let offset = 33; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8)
    const next = offset + 12 + length
    if (next > bytes.length) return
    if (type === 'IDAT' && length > 0) imageData = true
    if (type === 'IEND') return length === 0 && imageData && next === bytes.length ? { width, height, alpha: color === 4 || color === 6 } : undefined
    offset = next
  }
}

// ==================== Provider 实现 ====================

export class OpenAIProvider extends BaseProvider {
  readonly name = 'openai'
  readonly displayName = 'HTH'

  constructor(config: ProviderConfig) {
    super({
      ...config,
      baseUrl: normalizeOpenAIBaseUrl(config.baseUrl),
    })
  }

  /**
   * 生成图片（同步接口）
   * 有参考图 / image-to-image 走编辑接口，否则走文生图。
   */
  async generateImage(options: ImageOptions): Promise<ImageResult> {
    const references = this.imageReferences(options)
    if (options.maskImageUrl !== undefined) {
      if (!MASK_IMAGE_MODELS.has(options.modelId)) throw this.rejectedBeforeSubmission('当前图片模型不支持蒙版编辑，请选择支持的 GPT Image 编辑模型', 'MASK_MODEL_UNSUPPORTED')
      if (!references.length) throw this.rejectedBeforeSubmission('蒙版编辑需要第一张源图，不能用于无参考图的文生图', 'MASK_SOURCE_REQUIRED')
      if (typeof options.maskImageUrl !== 'string' || !options.maskImageUrl.trim()) throw this.rejectedBeforeSubmission('蒙版图片地址无效', 'BAD_MASK')
    }
    if (options.mode === 'image-to-image' || references.length > 0) {
      return this.editImage(options, references)
    }
    return this.textToImage(options)
  }

  /** Return a paid receipt before polling so background jobs can resume it safely. */
  async submitVideoTask(options: VideoOptions): Promise<{ taskId: string; modelId: string }> {
    const body = this.h3VideoBody(options)
    let response: H3Response
    try {
      response = await this.request<H3Response>('/v2/video_generation', {
        method: 'POST', body, baseUrl: normalizeHTHVideoBaseUrl(this.config.baseUrl),
      })
    } catch (error) {
      // MiniMax's typed validation/balance responses reject before creating work.
      if (error instanceof ProviderError && [402, 413, 415, 422].includes(error.statusCode ?? 0)) error.submissionRejected = true
      throw error
    }
    // A receipt always wins over an accompanying error: work may already be paid.
    if (typeof response.task_id === 'string' && response.task_id.trim()) {
      const taskId = response.task_id
      generationCheckpoint({ taskId, modelId: HTH_VIDEO_MODEL, provider: this.name, submissionState: 'acknowledged' })
      return { taskId, modelId: HTH_VIDEO_MODEL }
    }
    if (response.error || (response.base_resp && response.base_resp.status_code !== 0)) {
      const failure = this.rejectedBeforeSubmission(response.error?.message ?? response.base_resp?.status_msg ?? 'MiniMax-H3 任务被拒绝', response.error?.type ?? 'H3_SUBMIT_REJECTED')
      failure.requestId = response.request_id
      throw failure
    }
    throw new ProviderError('MiniMax-H3 没有返回任务编号，请先核对平台任务记录，勿直接重复提交', 'INVALID_RESPONSE', this.name)
  }

  async generateVideo(options: VideoOptions): Promise<VideoResult> {
    const { taskId } = await this.submitVideoTask(options)
    try {
      const status = await this.waitForTask(taskId, { interval: 5000 })
      return this.requireResult(status.result) as VideoResult
    } catch (error) {
      if (error instanceof GenerationTaskPending) throw error
      const failure = error instanceof ProviderError ? error : new ProviderError(error instanceof Error ? error.message : 'MiniMax-H3 查询失败', 'STATUS_UNKNOWN', this.name)
      failure.taskId = taskId
      throw failure
    }
  }

  async waitForTask(taskId: string, options: { interval?: number; maxAttempts?: number } = {}): Promise<TaskStatus> {
    const status = await super.waitForTask(taskId, options)
    if (status.status === 'cancelled') {
      const failure = new ProviderError(status.error ?? 'MiniMax-H3 视频任务已取消', 'TASK_FAILED', this.name)
      failure.taskId = taskId
      throw failure
    }
    return status
  }

  async getTaskStatus(taskId: string): Promise<TaskStatus> {
    const response = await this.request<H3Response>(`/v2/query/video_generation/${encodeURIComponent(taskId)}`, {
      baseUrl: normalizeHTHVideoBaseUrl(this.config.baseUrl),
    })
    if (response.error || (response.base_resp && response.base_resp.status_code !== 0)) {
      const failure = new ProviderError(response.error?.message ?? response.base_resp?.status_msg ?? 'MiniMax-H3 查询失败', response.error?.type ?? 'H3_QUERY_ERROR', this.name)
      failure.taskId = taskId
      failure.requestId = response.request_id
      throw failure
    }
    const task = response.task
    const statuses: Record<string, TaskStatus['status']> = { queued: 'pending', running: 'processing', succeeded: 'completed', failed: 'failed', cancelled: 'cancelled' }
    const status = task?.status && statuses[task.status]
    if (!task || !status) {
      const failure = new ProviderError('MiniMax-H3 返回的任务状态无效，请继续查询原任务', 'INVALID_RESPONSE', this.name)
      failure.taskId = taskId
      throw failure
    }
    const result: TaskStatus = { taskId, status }
    if (status === 'completed' && typeof task.content?.url === 'string' && /^https?:\/\//i.test(task.content.url)) {
      result.result = { taskId, modelId: task.model || HTH_VIDEO_MODEL, videoUrls: [task.content.url], hasAudio: true, duration: task.duration }
    }
    if (status === 'failed' || status === 'cancelled') {
      result.error = [task.error?.code, task.error?.message ?? (status === 'cancelled' ? '视频任务已取消' : '视频生成失败')].filter(Boolean).join(': ')
      result.errorCode = status === 'cancelled' ? 'TASK_CANCELLED' : 'TASK_FAILED'
    }
    return result
  }

  /**
   * 获取可用模型列表（2026 当前 GPT Image 系列，均支持文生图 + 图生图编辑）
   */
  async listModels(mediaType?: MediaType): Promise<Model[]> {
    const models: Model[] = [
      {
        id: HTH_VIDEO_MODEL,
        name: 'MiniMax-H3',
        description: '文生视频与首尾帧图生视频，768P / 2K，4–15 秒，原生立体声',
        modes: ['text-to-video', 'image-to-video'],
        mediaType: 'video',
        provider: this.name,
        supportsAudio: true,
      },
      {
        id: 'gpt-image-2.6-flare',
        name: 'GPT Image 2.6 Flare',
        description: '快速、高质量的图片生成，支持文生图与多参考图编辑，默认高质量输出',
        modes: ['text-to-image', 'image-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
      {
        id: 'gpt-image-2.6-sunburst',
        name: 'GPT Image 2.6 Sunburst',
        description: '注重细节、复杂构图与编辑精度，支持多参考图编辑，默认高质量输出',
        modes: ['text-to-image', 'image-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
      {
        id: 'gpt-image-2.5-flare',
        name: 'GPT Image 2.5 Flare',
        description: '快速、高质量的日常生图，支持文生图与参考图编辑',
        modes: ['text-to-image', 'image-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
      {
        id: 'gpt-image-2.5-sunburst',
        name: 'GPT Image 2.5 Sunburst',
        description: '注重图像编辑精度，支持文生图与多参考图编辑',
        modes: ['text-to-image', 'image-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
      {
        id: 'gpt-image-2',
        name: 'GPT Image 2',
        description: '支持任意分辨率（含 9:16 竖屏）、文字渲染与商品保真图生图',
        modes: ['text-to-image', 'image-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
      {
        id: 'gpt-image-1.5',
        name: 'GPT Image 1.5',
        description: '更快更省的 GPT Image 模型，支持图生图编辑',
        modes: ['text-to-image', 'image-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
    ]

    return mediaType ? models.filter((model) => model.mediaType === mediaType) : models
  }

  // ==================== 私有方法 ====================

  private h3VideoBody(options: VideoOptions): Record<string, unknown> {
    if (options.modelId !== HTH_VIDEO_MODEL) throw this.rejectedBeforeSubmission('HTH 视频生成当前仅支持 MiniMax-H3', 'NOT_SUPPORTED')
    if (!['text-to-video', 'image-to-video'].includes(options.mode)) throw this.rejectedBeforeSubmission('HTH MiniMax-H3 当前支持文生视频与首尾帧图生视频', 'MODE_UNSUPPORTED')
    if (typeof options.prompt !== 'string' || !options.prompt.trim() || options.prompt.length > 7000) throw this.rejectedBeforeSubmission('MiniMax-H3 提示词须为 1–7000 个字符', 'BAD_PROMPT')
    if (options.referenceImageUrls?.length || options.referenceVideoUrls?.length || options.referenceAudioUrls?.length || options.referenceVideoUrl) throw this.rejectedBeforeSubmission('HTH MiniMax-H3 当前仅接入首尾帧模式，不能混用参考图片、视频或音频', 'REFERENCE_MODE_UNSUPPORTED')
    const frames = [options.firstFrameUrl, options.lastFrameUrl]
    for (const frame of frames) {
      if (frame !== undefined && (typeof frame !== 'string' || !/^(?:https?:\/\/|data:image\/(?:png|jpe?g|webp);base64,)/i.test(frame))) throw this.rejectedBeforeSubmission('MiniMax-H3 首尾帧须为图片 URL 或 Base64 图片', 'BAD_REFERENCE')
      if (frame?.startsWith('data:') && frame.length > 42 * 1024 * 1024) throw this.rejectedBeforeSubmission('MiniMax-H3 首尾帧图片不能超过 30MB', 'REFERENCE_TOO_LARGE')
    }
    if (options.mode === 'image-to-video' && !options.firstFrameUrl) throw this.rejectedBeforeSubmission('MiniMax-H3 图生视频需要首帧图片', 'BAD_REFERENCE')
    if (options.mode === 'text-to-video' && frames.some(Boolean)) throw this.rejectedBeforeSubmission('提供首尾帧图片时必须使用图生视频模式', 'MODE_MISMATCH')
    const requested = options.duration ?? 5
    const minimum = options.minimumDuration ?? 0
    if (!Number.isFinite(requested) || requested <= 0 || !Number.isFinite(minimum) || minimum < 0) throw this.rejectedBeforeSubmission('MiniMax-H3 视频时长无效', 'BAD_DURATION')
    const duration = pickEnumDuration(HTH_VIDEO_DURATIONS.filter((value) => value >= minimum), requested)
    if (duration === undefined) throw this.rejectedBeforeSubmission('MiniMax-H3 单次最长 15 秒，无法满足镜头要求的最短时长', 'MINIMUM_DURATION_UNSUPPORTED')
    const extra = options.extra ?? {}
    if (Object.keys(extra).some((key) => !['resolution', 'ratio', 'aigc_watermark'].includes(key))) throw this.rejectedBeforeSubmission('MiniMax-H3 高级参数仅支持 resolution、ratio 与 aigc_watermark', 'UNSUPPORTED_PARAMETER')
    const width = options.width ?? 1280, height = options.height ?? 720
    if (![width, height].every((value) => Number.isFinite(value) && value > 0)) throw this.rejectedBeforeSubmission('MiniMax-H3 视频尺寸无效', 'BAD_DIMENSIONS')
    const resolution = extra.resolution ?? hthVideoResolution(width, height)
    if (typeof resolution !== 'string' || !HTH_VIDEO_RESOLUTIONS.includes(resolution)) throw this.rejectedBeforeSubmission('MiniMax-H3 分辨率仅支持 768P 或 2K', 'BAD_RESOLUTION')
    const ratio = extra.ratio ?? (options.firstFrameUrl ? 'adaptive' : pickRatio(HTH_VIDEO_RATIOS, width, height))
    if (typeof ratio !== 'string' || (!HTH_VIDEO_RATIOS.includes(ratio) && !(ratio === 'adaptive' && options.firstFrameUrl))) throw this.rejectedBeforeSubmission('MiniMax-H3 画幅比例无效，纯文本生成不能使用 adaptive', 'BAD_RATIO')
    if (extra.aigc_watermark !== undefined && typeof extra.aigc_watermark !== 'boolean') throw this.rejectedBeforeSubmission('aigc_watermark 必须为布尔值', 'BAD_WATERMARK')
    const content: Record<string, unknown>[] = [{ type: 'text', text: options.prompt }]
    if (options.firstFrameUrl) content.push({ type: 'image_url', image_url: { url: options.firstFrameUrl }, role: 'first_frame' })
    if (options.lastFrameUrl) content.push({ type: 'image_url', image_url: { url: options.lastFrameUrl }, role: 'last_frame' })
    // H3 always creates native audio. No unsupported audio/negative-prompt/seed fields are sent.
    return { model: HTH_VIDEO_MODEL, content, duration, resolution, ratio, ...(extra.aigc_watermark !== undefined && { aigc_watermark: extra.aigc_watermark }) }
  }

  /** 文生图：POST /images/generations（JSON） */
  private async textToImage(options: ImageOptions): Promise<ImageResult> {
    const model = options.modelId
    const isGptImage = model.startsWith('gpt-image')
    const isDalle3 = model.startsWith('dall-e-3')
    const imageControls = this.explicitImageControls(options)

    const body: Record<string, unknown> = {
      model,
      prompt: options.prompt,
      // DALL·E 3 仅支持 n=1；其余按请求数量（gpt-image 支持多张）
      n: isDalle3 ? 1 : (options.count ?? 1),
      size: this.pickSize(model, options.width, options.height, options.imageResolution),
      // 仅 DALL·E 系列支持 response_format；gpt-image-* 恒返回 b64_json，不能传该字段
      ...(isGptImage ? {} : { response_format: 'url' }),
      ...(DEFAULT_HIGH_QUALITY_IMAGE_MODELS.has(model) ? { quality: 'high' } : {}),
      ...options.extra,
      ...imageControls,
    }

    const response = await this.request<OpenAIImageResponse>('/images/generations', {
      method: 'POST',
      body,
      timeout: this.imageTimeout(options),
    })

    return this.mapResult(model, response)
  }

  /** 图生图（编辑）：POST /images/edits（multipart） */
  private async editImage(options: ImageOptions, references: string[]): Promise<ImageResult> {
    const model = options.modelId
    const imageControls = this.explicitImageControls(options)
    if (model.startsWith('dall-e-3')) {
      throw this.rejectedBeforeSubmission('DALL·E 3 不支持图生图（图片编辑），请改用 gpt-image-1', 'NOT_SUPPORTED')
    }
    if (references.length === 0) {
      throw this.rejectedBeforeSubmission('图生图缺少参考图', 'BAD_REFERENCE')
    }

    const isDalle2 = model.startsWith('dall-e-2')
    if (isDalle2 && references.length > 1) {
      throw this.rejectedBeforeSubmission('DALL·E 2 仅支持一张参考图，请改用 GPT Image 系列以保留全部人物与商品参考', 'NOT_SUPPORTED')
    }
    const images = await Promise.all(references.map((reference) => this.fetchReferenceImage(reference))).catch((error) => {
      // Reference downloads happen before the task-creating image edit POST.
      if (error instanceof ProviderError) { error.submissionRejected = true; throw error }
      throw this.rejectedBeforeSubmission(`参考图读取失败: ${error instanceof Error ? error.message : String(error)}`, 'BAD_REFERENCE')
    })
    let mask: Blob | undefined
    if (options.maskImageUrl !== undefined) {
      try {
        const uploaded = await this.fetchReferenceImage(options.maskImageUrl.trim())
        if (uploaded.blob.size >= 4 * 1024 * 1024) throw this.rejectedBeforeSubmission('蒙版 PNG 必须小于 4MB', 'MASK_TOO_LARGE')
        const maskBytes = Buffer.from(await uploaded.blob.arrayBuffer())
        const maskInfo = pngInfo(maskBytes)
        if (!maskInfo || !maskInfo.alpha) throw this.rejectedBeforeSubmission('蒙版必须是带透明通道的有效 PNG（RGBA 或灰度加 alpha），alpha 为 0 的区域表示需要编辑', 'BAD_MASK')
        const sourceInfo = pngInfo(Buffer.from(await images[0].blob.arrayBuffer()))
        if (!sourceInfo) throw this.rejectedBeforeSubmission('当前蒙版编辑仅支持 PNG 源图，请先将第一张源图转换为 PNG；无蒙版的全图编辑不受影响', 'MASK_SOURCE_UNSUPPORTED')
        if (maskInfo.width !== sourceInfo.width || maskInfo.height !== sourceInfo.height) throw this.rejectedBeforeSubmission('蒙版尺寸必须与第一张 PNG 源图完全一致', 'MASK_DIMENSIONS_MISMATCH')
        mask = new Blob([new Uint8Array(maskBytes)], { type: 'image/png' })
      } catch (error) {
        if (error instanceof ProviderError) { error.submissionRejected = true; throw error }
        throw this.rejectedBeforeSubmission(`蒙版读取失败: ${error instanceof Error ? error.message : String(error)}`, 'BAD_MASK')
      }
    }

    const form = new FormData()
    form.append('model', model)
    form.append('prompt', options.prompt)
    form.append('n', String(isDalle2 ? 1 : (options.count ?? 1)))
    form.append('size', this.pickSize(model, options.width, options.height, options.imageResolution))
    if (DEFAULT_HIGH_QUALITY_IMAGE_MODELS.has(model) && imageControls.quality === undefined) form.append('quality', 'high')
    for (const [field, value] of Object.entries(imageControls)) form.append(field, value)
    // gpt-image-* 用数组字段 image[]；dall-e-2 用单字段 image
    for (const { blob, filename } of images) {
      form.append(isDalle2 ? 'image' : 'image[]', blob, filename)
    }
    if (mask) form.append('mask', mask, 'mask.png')
    // 仅 dall-e-2 支持 response_format；gpt-image-* 恒返回 b64_json
    if (isDalle2) form.append('response_format', 'url')

    const response = await this.postMultipart<OpenAIImageResponse>('/images/edits', form, this.imageTimeout(options))
    return this.mapResult(model, response)
  }

  /** New controls are opt-in; legacy DALL·E requests retain their existing parameter contract. */
  private explicitImageControls(options: ImageOptions): Record<string, string> {
    if (!options.modelId.startsWith('gpt-image') && options.modelId !== 'chatgpt-image-latest') return {}
    const fields: Record<string, string> = {}
    if (options.quality !== undefined) {
      if (!['auto', 'low', 'medium', 'high', 'xhigh'].includes(options.quality)) {
        throw this.rejectedBeforeSubmission('图片质量选项无效', 'BAD_IMAGE_QUALITY')
      }
      if (options.quality === 'xhigh' && !/^gpt-image-2\.[56]-(?:sunburst|flare)(?:-\d{4}-\d{2}-\d{2})?$/.test(options.modelId)) {
        throw this.rejectedBeforeSubmission('xhigh 图片质量仅支持 GPT Image 2.5 / 2.6 Sunburst / Flare', 'IMAGE_QUALITY_UNSUPPORTED')
      }
      fields.quality = options.quality
    }
    if (options.outputFormat !== undefined) {
      if (!['png', 'jpeg', 'webp'].includes(options.outputFormat)) {
        throw this.rejectedBeforeSubmission('图片输出格式选项无效', 'BAD_IMAGE_OUTPUT_FORMAT')
      }
      fields.output_format = options.outputFormat
    }
    return fields
  }

  /** Ordered multi-image references take precedence; retain the legacy single-image input. */
  private imageReferences(options: ImageOptions): string[] {
    const references = (options.referenceImageUrls ?? [])
      .filter((reference) => typeof reference === 'string' && reference.trim().length > 0)
    if (references.length > 0) return references
    const single = options.referenceImageUrl?.trim()
    return single ? [single] : []
  }

  /** Larger canvases can take longer; ordinary images retain their two-minute limit. */
  private imageTimeout(options: ImageOptions): number {
    return options.imageResolution === '2k' || options.imageResolution === '4k' ? 300000 : 120000
  }

  /** 解析图片响应：url 直接用，b64_json 包成 data URI */
  private mapResult(model: string, response: OpenAIImageResponse): ImageResult {
    const mime = response.output_format === 'jpeg' ? 'image/jpeg' : response.output_format === 'webp' ? 'image/webp' : 'image/png'
    const imageUrls = (response.data ?? [])
      .map((d) => d.url ?? (d.b64_json ? `data:${mime};base64,${d.b64_json}` : undefined))
      .filter((u): u is string => Boolean(u))

    if (imageUrls.length === 0) {
      throw new ProviderError('生成成功但未返回图片数据', 'NO_RESULT', this.name)
    }

    return {
      taskId: `openai-img-${response.created ?? Date.now()}`,
      imageUrls,
      modelId: model,
    }
  }

  /**
   * 把参考图（data URI 或 http(s) URL）取成 Blob，供 multipart 上传
   */
  private async fetchReferenceImage(ref: string): Promise<{ blob: Blob; filename: string }> {
    if (ref.startsWith('data:')) {
      const comma = ref.indexOf(',')
      if (comma === -1) throw new ProviderError('参考图 data URI 解析失败', 'BAD_REFERENCE', this.name)
      const mime = ref.slice(5, comma).split(';')[0] || 'image/png'
      const buf = Buffer.from(ref.slice(comma + 1), 'base64')
      return { blob: new Blob([new Uint8Array(buf)], { type: mime }), filename: `image.${this.extFromMime(mime)}` }
    }
    const resp = await fetch(ref)
    if (!resp.ok) throw new ProviderError(`参考图下载失败: ${resp.status}`, 'BAD_REFERENCE', this.name)
    const blob = await resp.blob()
    const mime = blob.type || resp.headers.get('content-type') || 'image/png'
    return { blob, filename: `image.${this.extFromMime(mime)}` }
  }

  /** multipart POST：不手动设 Content-Type，让 fetch 自动带 boundary */
  private async postMultipart<T>(path: string, form: FormData, timeoutMs = 120000): Promise<T> {
    const url = `${this.config.baseUrl}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let submissionRejected = false
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        body: form,
        signal: controller.signal,
      })
      submissionRejected = !resp.ok && [400, 401, 403, 429].includes(resp.status)
      const responseText = await resp.text()
      let response: T
      try {
        response = JSON.parse(responseText) as T
      } catch {
        const contentType = resp.headers.get('content-type') || '未声明 Content-Type'
        const isHtml = /text\/html/i.test(contentType) || /^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(responseText)
        // Keep credentials, query strings and the returned webpage out of diagnostics.
        let endpoint = path
        try {
          const requestUrl = new URL(url)
          endpoint = `${requestUrl.origin}${requestUrl.pathname}`
        } catch {
          /* The static endpoint path is enough if the configured URL cannot be parsed. */
        }
        throw new ProviderError(
          `API 响应异常（HTTP ${resp.status}，${contentType}）：${isHtml ? '服务返回 HTML 网页，而非图片 API 的 JSON' : responseText.trim() ? '服务返回的内容不是有效 JSON' : '服务返回空响应'}。请求地址：${endpoint}。请检查 Base URL 是否为 API 接入地址，并确认服务支持 POST ${path} 图生图接口。`,
          'INVALID_RESPONSE',
          this.name,
          resp.status
        )
      }
      if (!resp.ok) {
        throw new ProviderError(
          `API 请求失败: ${resp.status} ${resp.statusText} - ${responseText}`,
          'API_ERROR',
          this.name,
          resp.status
        )
      }
      return response
    } catch (e) {
      if (e instanceof ProviderError) {
        if (submissionRejected) e.submissionRejected = true
        throw e
      }
      const isTimeout = e instanceof DOMException && e.name === 'AbortError'
      const failure = new ProviderError(
        isTimeout ? `请求超时（${timeoutMs}ms）` : `网络请求异常: ${e instanceof Error ? e.message : String(e)}`,
        isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
        this.name
      )
      if (submissionRejected) failure.submissionRejected = true
      throw failure
    } finally {
      clearTimeout(timer)
    }
  }

  private rejectedBeforeSubmission(message: string, code: string): ProviderError {
    const failure = new ProviderError(message, code, this.name)
    failure.submissionRejected = true
    return failure
  }

  /** MIME → 文件扩展名 */
  private extFromMime(mime: string): string {
    if (mime.includes('webp')) return 'webp'
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
    return 'png'
  }

  /**
   * 把请求的宽高映射成 OpenAI 各模型允许的 size 字符串（按横/竖/方就近取值）
   */
  private pickSize(model: string, width?: number, height?: number, imageResolution?: ImageOptions['imageResolution']): string {
    const w = width ?? 1024
    const h = height ?? 1024
    const ratio = w / h
    // DALL·E 3 允许：1024x1024 / 1792x1024 / 1024x1792
    if (model.startsWith('dall-e-3')) {
      if (ratio > 1.2) return '1792x1024'
      if (ratio < 0.83) return '1024x1792'
      return '1024x1024'
    }
    // DALL·E 2 仅方图
    if (model.startsWith('dall-e-2')) return '1024x1024'
    // gpt-image-2 / 2.5 / 2.6（含日期版本）：支持任意分辨率，按真实比例就近取（带货可直接出 9:16）
    if (model.startsWith('gpt-image-2')) {
      if (imageResolution === '2k' || imageResolution === '4k') {
        return this.fitHighResolutionSize(w, h, imageResolution === '4k' ? 3840 : 2048)
      }
      return this.fitArbitrarySize(w, h)
    }
    // 其余 gpt-image-*（1 / 1.5 / mini）：标准三档 1024x1024 / 1536x1024 / 1024x1536
    if (ratio > 1.2) return '1536x1024'
    if (ratio < 0.83) return '1024x1536'
    return '1024x1024'
  }

  /**
   * gpt-image-2 任意分辨率适配：把长边收到 1536（控成本/时延），
   * 宽高对齐到 16 的倍数，并把比例夹到 1:3 ~ 3:1（API 约束）
   */
  private fitArbitrarySize(width: number, height: number): string {
    const LONG = 1536
    let w = width
    let h = height
    const longest = Math.max(w, h)
    if (longest > LONG) {
      const s = LONG / longest
      w *= s
      h *= s
    }
    const round16 = (n: number) => Math.max(256, Math.round(n / 16) * 16)
    w = round16(w)
    h = round16(h)
    // 比例夹到 1:3 ~ 3:1
    if (w / h > 3) w = round16(h * 3)
    if (h / w > 3) h = round16(w * 3)
    return `${w}x${h}`
  }

  /**
   * Explicit high-resolution canvases follow GPT Image 2/2.5/2.6's documented limits:
   * /16 sides, at most 3840 per edge, 1:3..3:1, and 655,360..8,294,400 pixels.
   * Preserve exact common ratios so a portrait grid divides into portrait cells.
   * https://developers.openai.com/api/docs/guides/image-generation
   */
  private fitHighResolutionSize(width: number, height: number, maxSide: number): string {
    const minPixels = 655360
    const maxPixels = 8294400
    let w = Number.isSafeInteger(width) && width > 0 ? width : 1024
    let h = Number.isSafeInteger(height) && height > 0 ? height : 1024
    if (w / h > 3) w = h * 3
    if (h / w > 3) h = w * 3

    const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b)
    const divisor = gcd(w, h)
    const baseW = (w / divisor) * 16
    const baseH = (h / divisor) * 16
    const basePixels = baseW * baseH
    const minMultiple = Math.ceil(Math.sqrt(minPixels / basePixels))
    const maxMultiple = Math.min(
      Math.floor(maxSide / Math.max(baseW, baseH)),
      Math.floor(Math.sqrt(maxPixels / basePixels))
    )
    if (maxMultiple >= minMultiple) {
      const multiple = Math.max(minMultiple, Math.min(maxMultiple, Math.round(w / baseW)))
      return `${baseW * multiple}x${baseH * multiple}`
    }

    // Unusual ratios can require an exact /16 base larger than the API allows.
    // Choose the nearest legal canvas while retaining the requested proportions.
    const ratio = w / h
    let scale = Math.min(1, maxSide / Math.max(w, h), Math.sqrt(maxPixels / (w * h)))
    scale = Math.max(scale, Math.sqrt(minPixels / (w * h)))
    const targetW = w * scale
    const targetH = h * scale
    let bestW = 1024
    let bestH = 1024
    let bestDistance = Infinity
    for (let candidateW = 16; candidateW <= maxSide; candidateW += 16) {
      const minH = Math.ceil(Math.max(minPixels / candidateW, candidateW / 3) / 16) * 16
      const maxH = Math.floor(Math.min(maxPixels / candidateW, candidateW * 3, maxSide) / 16) * 16
      if (minH > maxH) continue
      const candidateH = Math.max(minH, Math.min(maxH, Math.round(candidateW / ratio / 16) * 16))
      const distance = (candidateW / targetW - 1) ** 2 + (candidateH / targetH - 1) ** 2
      if (distance < bestDistance) {
        bestW = candidateW
        bestH = candidateH
        bestDistance = distance
      }
    }
    return `${bestW}x${bestH}`
  }
}
