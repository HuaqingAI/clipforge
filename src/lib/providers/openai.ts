/**
 * OpenAI 官方 Provider 实现
 * 支持图片生成（文生图 + 图生图编辑）：GPT Image 系列（2.5 Flare / Sunburst、2、1.5 等），兼容 DALL·E 3/2。
 * 文档参考: https://platform.openai.com/docs/api-reference/images
 *
 * 说明：
 * - 文生图：POST /images/generations（JSON，同步返回）。
 * - 图生图（编辑）：POST /images/edits（multipart/form-data，同步返回），
 *   支持 gpt-image-* 与 dall-e-2；dall-e-3 不支持编辑。
 * - gpt-image-* 系列只返回 base64（b64_json），不支持 response_format；
 *   DALL·E 2/3 支持 response_format=url。本实现统一把 base64 包成 data URI 返回，
 *   下游落库（persistSource）已支持 data: 协议。
 * - gpt-image-2 / 2.5 支持任意分辨率（宽高被 16 整除、比例 1:3~3:1），竖屏带货可直接出 9:16。
 * - 视频（Sora）下载需鉴权（GET /v1/videos/{id}/content 带 Bearer），
 *   而本应用素材落库走的是无鉴权直链下载，故暂不接入 OpenAI 视频，generateVideo 直接报错。
 */

import { BaseProvider, ProviderError } from './base'
import { normalizeOpenAIBaseUrl } from '@/lib/openai-config'
import { OPENAI_MASK_IMAGE_MODELS } from '@/lib/openai-image-capabilities'
import type {
  ProviderConfig,
  ImageOptions,
  ImageResult,
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

const MASK_IMAGE_MODELS = new Set(OPENAI_MASK_IMAGE_MODELS)

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
  readonly displayName = 'OpenAI'

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

  /**
   * 生成视频（暂不支持）
   * OpenAI Sora 的成片需鉴权下载，本应用素材落库走无鉴权直链，故暂未接入。
   */
  async generateVideo(): Promise<VideoResult> {
    throw this.rejectedBeforeSubmission(
      'OpenAI 暂未接入视频生成（Sora），请改用 fal.ai / Replicate / 火山引擎 / 阿里百炼 等视频平台',
      'NOT_SUPPORTED',
    )
  }

  /**
   * 查询任务状态
   * 图片为同步生成，无异步任务可查
   */
  async getTaskStatus(): Promise<TaskStatus> {
    throw new ProviderError('OpenAI 图片为同步生成，无需查询任务状态', 'NOT_SUPPORTED', this.name)
  }

  /**
   * 获取可用模型列表（2026 当前 GPT Image 系列，均支持文生图 + 图生图编辑）
   */
  async listModels(mediaType?: MediaType): Promise<Model[]> {
    if (mediaType === 'video') return []

    const models: Model[] = [
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

    return models
  }

  // ==================== 私有方法 ====================

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
      if (options.quality === 'xhigh' && !/^gpt-image-2\.5-(?:sunburst|flare)(?:-\d{4}-\d{2}-\d{2})?$/.test(options.modelId)) {
        throw this.rejectedBeforeSubmission('xhigh 图片质量仅支持 GPT Image 2.5 Sunburst / Flare', 'IMAGE_QUALITY_UNSUPPORTED')
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
    // gpt-image-2 / 2.5（含日期版本）：支持任意分辨率，按真实比例就近取（带货可直接出 9:16）
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
   * Explicit high-resolution canvases follow GPT Image 2/2.5's documented limits:
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
