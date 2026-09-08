/**
 * Pi Copis 图片生成工具适配器
 *
 * 通过本地 Rust HTTP Gateway (/api/working/image) 调用 Copis 后端图片生成与计费服务。
 * 生成成功后将图片保存为本地附件，返回包含 <generated_images> JSON 元数据与图片内容块的结果。
 *
 * 遵循无 Electron 依赖设计，可直接在 Pi RPC Worker 进程中安全执行。
 */

import { Type } from 'typebox'
import { randomUUID } from 'node:crypto'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { saveAttachment } from '../attachment-storage'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')
type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const DEFAULT_HTTP_API_PORT = 51730
const WORKING_IMAGE_ENDPOINT = '/api/working/image'

export interface PiImageGenerationToolOptions {
  sessionId: string
  baseUrl?: string
  fetchImpl?: FetchImplementation
}

export interface ImageGenerationToolInput {
  prompt: string
  size?: string
}

export class PiImageGenerationToolError extends Error {}

function resolveBaseUrl(value: string | undefined): string {
  if (value?.trim()) return value.replace(/\/$/, '')
  const configuredPort = Number.parseInt(process.env.COPIS_HTTP_API_PORT ?? '', 10)
  const port = Number.isSafeInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535
    ? configuredPort
    : DEFAULT_HTTP_API_PORT
  return `http://127.0.0.1:${port}`
}

/** 从 data URL 中提取纯 base64 数据 */
export function base64FromDataUrl(dataUrl: string): string | null {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) return null
  return dataUrl.slice(commaIndex + 1)
}

/** 根据 base64 头字节推测媒体类型 */
export function detectBase64ImageType(base64: string): string {
  const head = base64.replace(/\s+/g, '').slice(0, 16)
  if (head.startsWith('/9j/')) return 'image/jpeg'
  if (head.startsWith('iVBORw0KGgo')) return 'image/png'
  if (head.startsWith('UklGR')) return 'image/webp'
  if (head.startsWith('R0lGOD')) return 'image/gif'
  return 'image/png'
}

/** 根据媒体类型获取文件扩展名 */
export function extensionForMediaType(mediaType: string): string {
  switch (mediaType) {
    case 'image/jpeg': return '.jpg'
    case 'image/webp': return '.webp'
    case 'image/gif': return '.gif'
    default: return '.png'
  }
}

export class PiImageGenerationToolClient {
  private readonly baseUrl: string
  private readonly fetchImpl: FetchImplementation
  private readonly sessionId: string

  constructor(options: PiImageGenerationToolOptions) {
    this.sessionId = options.sessionId
    this.baseUrl = resolveBaseUrl(options.baseUrl)
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async execute(input: ImageGenerationToolInput, signal?: AbortSignal): Promise<{
    text: string
    base64: string
    mediaType: string
    meta: Array<{ filename: string; path: string; mediaType: string }>
  }> {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    if (!prompt) {
      throw new PiImageGenerationToolError('prompt 参数缺失：请描述要生成的图片内容')
    }

    const size = typeof input.size === 'string' ? input.size.trim() : ''

    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${WORKING_IMAGE_ENDPOINT}`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          size: size || undefined,
          run_id: this.sessionId,
        }),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '服务未响应'
      throw new PiImageGenerationToolError(`Copis 图片生成服务连接失败: ${message}`)
    }

    const text = await response.text()
    let payload: Record<string, unknown> | undefined
    try {
      payload = text ? (JSON.parse(text) as Record<string, unknown>) : undefined
    } catch {
      throw new PiImageGenerationToolError('Copis 图片生成服务响应不是有效 JSON')
    }

    if (!response.ok) {
      const errorMsg = typeof payload?.error === 'string'
        ? payload.error
        : typeof payload?.message === 'string'
          ? payload.message
          : `图片生成请求失败 (${response.status})`
      throw new PiImageGenerationToolError(errorMsg)
    }

    const dataUrl = typeof payload?.data_url === 'string'
      ? payload.data_url
      : typeof payload?.dataUrl === 'string'
        ? payload.dataUrl
        : undefined
    if (!dataUrl) {
      throw new PiImageGenerationToolError('Copis 后端未返回生成的图片数据')
    }

    const imageBase64 = base64FromDataUrl(dataUrl)
    if (!imageBase64) {
      throw new PiImageGenerationToolError('Copis 后端返回的图片数据无效')
    }

    const rawContentType = typeof payload?.content_type === 'string'
      ? payload.content_type
      : typeof payload?.contentType === 'string'
        ? payload.contentType
        : undefined
    const mediaType = rawContentType?.trim() || detectBase64ImageType(imageBase64)
    const ext = extensionForMediaType(mediaType)

    const attachmentResult = saveAttachment({
      conversationId: this.sessionId,
      filename: `copis-image-${randomUUID().slice(0, 8)}${ext}`,
      mediaType,
      data: imageBase64,
    })

    const deductedTokens = typeof payload?.deducted_tokens === 'number'
      ? payload.deducted_tokens
      : typeof payload?.deductedTokens === 'number'
        ? payload.deductedTokens
        : undefined
    const balanceAfter = typeof payload?.balance_after === 'number'
      ? payload.balance_after
      : typeof payload?.balanceAfter === 'number'
        ? payload.balanceAfter
        : undefined

    const deductionText = deductedTokens && deductedTokens > 0
      ? `（消耗 ${deductedTokens} 钻石${balanceAfter != null ? `，余额 ${balanceAfter}` : ''}）`
      : ''

    const meta = [{
      filename: attachmentResult.attachment.filename,
      path: attachmentResult.attachment.localPath,
      mediaType: attachmentResult.attachment.mediaType,
    }]

    const resultText = `图片已成功生成（1 张）${deductionText}\n\n<generated_images>\n${JSON.stringify(meta)}\n</generated_images>`

    return {
      text: resultText,
      base64: imageBase64,
      mediaType,
      meta,
    }
  }
}

export function buildPiImageGenerationTools(
  sdk: PiSdk,
  options: PiImageGenerationToolOptions,
): ToolDefinition[] {
  const client = new PiImageGenerationToolClient(options)

  const definition = sdk.defineTool({
    name: 'generate_image',
    label: 'Copis 图片生成',
    description: `基于 Copis 后端（edu-api）的图片生成服务生成图片，计费由后端完成。

**使用时机**：用户要求生成图片、画图、生图、出图，生成插图/配图/海报/封面/头像时调用。

**提示词要求**：把用户需求整理成清晰、安全、可执行的英文/中文提示词，按顺序包含：
1. 主体、场景、动作；
2. 风格（卡通、手绘、简约、水彩、像素、写实、信息图等）；
3. 构图、光线、比例与尺寸；
4. must_include 必含元素与 avoid 避开元素。
图片文字易错，如非用户明确要求，提示词中明确要求“画面中不出现文字”。

**参数说明**：
- prompt：要生成的图片内容的详细描述。
- size：生成尺寸，如 1024x1024（默认）、1536x1024、1280x720；头像默认 1:1，海报默认 3:4。

**安全与真实性**：
- 不生成成人化、血腥、恐怖、仇恨、危险操作、自伤或隐私诱导内容。
- 不复刻受版权保护角色、商标形象或真实人物肖像；改写为 legally distinct 的原创角色或泛化描述。
- 不编造图片 URL 或本地路径，只使用工具真实返回的图片。`,
    promptSnippet: 'generate_image: 根据详细提示词生成真实图片。在用户请求生图或配图时主动调用。',
    parameters: Type.Object({
      prompt: Type.String({ description: '要生成的图片内容的详细描述' }),
      size: Type.Optional(Type.String({ description: '生成尺寸，如 1024x1024（默认）、1536x1024、1280x720' })),
    }),
    async execute(_toolCallId, params, signal) {
      const input = (params ?? {}) as ImageGenerationToolInput
      const result = await client.execute(input, signal)

      const content: AgentToolResult<unknown>['content'] = [
        { type: 'text', text: result.text } as { type: 'text'; text: string },
        {
          type: 'image',
          data: result.base64,
          mimeType: result.mediaType,
        } as { type: 'image'; data: string; mimeType: string },
      ]

      return {
        content,
        details: { generatedAttachments: result.meta },
      } as unknown as AgentToolResult<unknown>
    },
  }) as unknown as ToolDefinition

  return [{ ...definition, executionMode: 'sequential' as const }]
}
