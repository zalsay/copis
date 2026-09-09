/**
 * Pi Copis 图片生成工具适配器
 *
 * 通过本地 Rust HTTP Gateway 提交 model-request 图片任务并轮询结果。
 * 生成成功后将图片保存为本地附件，返回包含 <generated_images> JSON 元数据与图片内容块的结果。
 *
 * 遵循无 Electron 依赖设计，可直接在 Pi RPC Worker 进程中安全执行。
 */

import { Type } from 'typebox'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { saveAttachment } from '../attachment-storage'
import { getConfigDir } from '../config-paths'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')
type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const DEFAULT_HTTP_API_PORT = 51730
const IMAGE_TASKS_ENDPOINT = '/api/working/image/tasks'
const IMAGE_POLL_INTERVAL_MS = 1000
const IMAGE_POLL_MAX_MS = 5 * 60 * 1000
const MAX_IMAGE_DOWNLOAD_BYTES = 20 * 1024 * 1024
const IMAGE_TASK_STORE_DIR = 'image-generation-tasks'

type PersistedImageTask = {
  version: 1
  taskId: string
  requestId: string
  promptDigest: string
  size: string
  updatedAt: number
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function imageTaskStorePath(taskKey: string): string {
  return `${getConfigDir()}/${IMAGE_TASK_STORE_DIR}/${taskKey}.json`
}

function isPersistedImageTask(value: unknown): value is PersistedImageTask {
  if (!value || typeof value !== 'object') return false
  const task = value as Partial<PersistedImageTask>
  return task.version === 1
    && typeof task.taskId === 'string' && task.taskId.length > 0
    && typeof task.requestId === 'string' && task.requestId.length > 0
    && typeof task.promptDigest === 'string' && /^[a-f0-9]{64}$/.test(task.promptDigest)
    && typeof task.size === 'string'
    && typeof task.updatedAt === 'number'
}

function loadImageTask(taskKey: string): PersistedImageTask | undefined {
  const path = imageTaskStorePath(taskKey)
  if (!existsSync(path)) return undefined
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!isPersistedImageTask(value)) throw new Error('字段不正确')
    return value
  } catch (error) {
    throw new PiImageGenerationToolError(`图片任务恢复记录无效，未重新提交任务: ${error instanceof Error ? error.message : '读取失败'}`)
  }
}

function persistImageTask(taskKey: string, task: PersistedImageTask): void {
  const directory = `${getConfigDir()}/${IMAGE_TASK_STORE_DIR}`
  const path = imageTaskStorePath(taskKey)
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(temporaryPath, JSON.stringify(task), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporaryPath, path)
  } catch (error) {
    throw new PiImageGenerationToolError(
      `图片任务已创建但无法保存恢复记录: ${error instanceof Error ? error.message : '写入失败'}`,
      task.taskId,
    )
  }
}

export interface PiImageGenerationToolOptions {
  sessionId: string
  cwd?: string
  baseUrl?: string
  fetchImpl?: FetchImplementation
  sleepImpl?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  pollIntervalMs?: number
}

export interface ImageGenerationToolInput {
  prompt: string
  size?: string
}

export class PiImageGenerationToolError extends Error {
  readonly taskId?: string

  constructor(message: string, taskId?: string) {
    super(taskId ? `${message}（task_id=${taskId}，可使用 get_image_task 查询原任务）` : message)
    this.name = 'PiImageGenerationToolError'
    this.taskId = taskId
  }
}

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

async function readImageBody(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  if (!response.body) return response.arrayBuffer()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel('图片文件过大')
        throw new Error('图片文件过大')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output.buffer
}

export class PiImageGenerationToolClient {
  private readonly baseUrl: string
  private readonly fetchImpl: FetchImplementation
  private readonly sessionId: string
  private readonly cwd?: string
  private readonly sleepImpl: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  private readonly pollIntervalMs: number

  constructor(options: PiImageGenerationToolOptions) {
    this.sessionId = options.sessionId
    this.cwd = options.cwd
    this.baseUrl = resolveBaseUrl(options.baseUrl)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.sleepImpl = options.sleepImpl ?? ((milliseconds, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('The operation was aborted', 'AbortError'))
        return
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, milliseconds)
      const onAbort = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(new DOMException('The operation was aborted', 'AbortError'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    }))
    this.pollIntervalMs = Math.max(0, options.pollIntervalMs ?? IMAGE_POLL_INTERVAL_MS)
  }

  async execute(input: ImageGenerationToolInput, signal?: AbortSignal, requestId?: string): Promise<{
    text: string
    base64: string
    mediaType: string
    meta: Array<{ filename: string; path: string; mediaType: string }>
  }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), IMAGE_POLL_MAX_MS)
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) controller.abort()
    try {
      controller.signal.throwIfAborted()
      return await this.executeWithSignal(input, controller.signal, requestId)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private async executeWithSignal(input: ImageGenerationToolInput, signal?: AbortSignal, requestId?: string): Promise<{
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
    const toolCallId = requestId?.trim()
    const taskKey = toolCallId ? sha256(`${this.sessionId}\u0000${toolCallId}`) : undefined
    const stableRequestId = taskKey ? `img_${taskKey}` : `img_${randomUUID().replaceAll('-', '')}`
    const promptDigest = sha256(`${prompt}\u0000${size}`)
    const stored = taskKey ? loadImageTask(taskKey) : undefined
    if (stored && (stored.promptDigest !== promptDigest || stored.size !== size || stored.requestId !== stableRequestId)) {
      throw new PiImageGenerationToolError('同一图片工具调用的提示词或尺寸已变化，拒绝恢复到其他任务', stored.taskId)
    }

    let response: Response
    if (stored?.taskId) {
      response = new Response(JSON.stringify({ data: { task_id: stored.taskId, status: 'running' } }), { status: 202 })
    } else try {
      response = await this.fetchImpl(`${this.baseUrl}${IMAGE_TASKS_ENDPOINT}`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          size: size || undefined,
          sessionId: this.sessionId,
          request_id: stableRequestId,
        }),
      })
    } catch (error) {
      if (signal?.aborted) throw error
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
      const detail = typeof payload?.detail === 'string' && payload.detail.trim() && !errorMsg.includes(payload.detail.trim())
        ? `: ${payload.detail.trim()}`
        : ''
      throw new PiImageGenerationToolError(`${errorMsg}${detail}`)
    }

    const task = await this.waitForImageTask(payload ?? {}, signal, taskKey, stableRequestId, promptDigest, size)
    return this.renderTask(task, signal)
  }

  async getTask(id: string, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(60_000)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const task = await this.fetchTask(id, combined)
    if (task.status === 'completed') return this.renderTask(task, combined)
    if (task.status === 'failed') throw new PiImageGenerationToolError(String(task.error || '图片生成任务失败'), id)
    if (task.status !== 'running' && task.status !== 'queued') throw new PiImageGenerationToolError('图片任务状态异常', id)
    return { text: `图片任务 ${id} 状态：${task.status}。稍后使用 get_image_task 查询，勿重复生成。`, base64: '', mediaType: '', meta: [] }
  }

  async listTasks(sessionId?: string, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(30_000)
    const response = await this.fetchImpl(`${this.baseUrl}${IMAGE_TASKS_ENDPOINT}${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''}`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    const payload = await response.json() as Record<string, unknown>
    if (!response.ok) throw new PiImageGenerationToolError(String(payload.error || '查询图片任务列表失败'))
    return payload
  }

  private async fetchTask(id: string, signal?: AbortSignal, refresh = false): Promise<Record<string, unknown>> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new PiImageGenerationToolError('task_id 格式不正确')
    const response = await this.fetchImpl(`${this.baseUrl}${IMAGE_TASKS_ENDPOINT}/${id}${refresh ? '?refresh=1' : ''}`, { signal })
    const payload = await response.json() as Record<string, unknown>
    if (!response.ok) throw new PiImageGenerationToolError(String(payload.error || `图片任务查询失败 (${response.status})`), id)
    const task = (payload.data ?? payload) as Record<string, unknown>
    if (task.task_id !== id) throw new PiImageGenerationToolError('图片任务响应 ID 不匹配', id)
    return task
  }

  private async renderTask(task: Record<string, unknown>, signal?: AbortSignal) {

    let dataUrl = typeof task.data_url === 'string'
      ? task.data_url
      : typeof task.dataUrl === 'string'
        ? task.dataUrl
        : undefined
    if (!dataUrl) {
      const imageUrl = typeof task.image_url === 'string'
        ? task.image_url
        : typeof task.imageUrl === 'string'
          ? task.imageUrl
          : undefined
      if (imageUrl?.trim()) {
        try {
          let imgResp = await this.fetchImpl(imageUrl, { signal })
          if ((imgResp.status === 401 || imgResp.status === 403) && taskId(task)) {
            const refreshed = await this.fetchTask(taskId(task)!, signal, true)
            if (typeof refreshed.image_url === 'string') imgResp = await this.fetchImpl(refreshed.image_url, { signal })
          }
          if (imgResp.ok) {
            const contentLength = Number(imgResp.headers.get('content-length') ?? '')
            if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_DOWNLOAD_BYTES) {
              throw new Error('图片文件过大')
            }
            const buffer = await readImageBody(imgResp, MAX_IMAGE_DOWNLOAD_BYTES)
            const mime = imgResp.headers.get('content-type') || 'image/png'
            const b64 = Buffer.from(buffer).toString('base64')
            dataUrl = `data:${mime};base64,${b64}`
          }
        } catch (error) {
          if (signal?.aborted) throw new PiImageGenerationToolError('图片下载已取消或超时', taskId(task))
          // ignore error and fall through
        }
      }
    }
    if (!dataUrl) {
      throw new PiImageGenerationToolError('Copis 后端未返回生成的图片数据', typeof task.task_id === 'string' ? task.task_id : undefined)
    }

    const imageBase64 = base64FromDataUrl(dataUrl)
    if (!imageBase64) {
      throw new PiImageGenerationToolError('Copis 后端返回的图片数据无效')
    }

    const rawContentType = typeof task.content_type === 'string'
      ? task.content_type
      : typeof task.contentType === 'string'
        ? task.contentType
        : undefined
    const mediaType = rawContentType?.trim() || detectBase64ImageType(imageBase64)
    const ext = extensionForMediaType(mediaType)

    const attachmentResult = saveAttachment({
      conversationId: this.sessionId,
      filename: `copis-image-${randomUUID().slice(0, 8)}${ext}`,
      mediaType,
      data: imageBase64,
    })

    if (this.cwd && existsSync(this.cwd)) {
      try {
        const workspaceFilePath = join(this.cwd, attachmentResult.attachment.filename)
        writeFileSync(workspaceFilePath, Buffer.from(imageBase64, 'base64'))
      } catch (err) {
        console.warn('[PiImageGenerationTool] 同步图片到工作区失败:', err)
      }
    }

    const deductedTokens = typeof task.deducted_tokens === 'number'
      ? task.deducted_tokens
      : typeof task.deductedTokens === 'number'
        ? task.deductedTokens
        : undefined
    const balanceAfter = typeof task.balance_after === 'number'
      ? task.balance_after
      : typeof task.balanceAfter === 'number'
        ? task.balanceAfter
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

  private async waitForImageTask(initial: Record<string, unknown>, signal?: AbortSignal, taskKey?: string, requestId?: string, promptDigest?: string, size?: string): Promise<Record<string, unknown>> {
    const unwrap = (value: Record<string, unknown>): Record<string, unknown> => {
      const data = value.data
      return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : value
    }
    let task = unwrap(initial)
    const taskId = typeof task.task_id === 'string' ? task.task_id.trim() : ''
    if (!taskId) throw new PiImageGenerationToolError('Copis 后端未返回图片任务 ID')
    if (taskKey && requestId && promptDigest !== undefined && size !== undefined) {
      persistImageTask(taskKey, { version: 1, taskId, requestId, promptDigest, size, updatedAt: Date.now() })
    }
    const started = Date.now()
    while (true) {
      const status = typeof task.status === 'string' ? task.status : ''
      if (status === 'completed') return task
      if (status === 'failed') {
        const error = typeof task.error === 'string' && task.error.trim() ? task.error : '图片生成任务失败'
        throw new PiImageGenerationToolError(error, taskId)
      }
      if (status !== 'queued' && status !== 'running') {
        throw new PiImageGenerationToolError(`图片生成任务状态异常: ${status || 'unknown'}`, taskId)
      }
      if (Date.now() - started >= IMAGE_POLL_MAX_MS) {
        throw new PiImageGenerationToolError('图片生成任务等待超时', taskId)
      }
      try {
        await this.sleepImpl(this.pollIntervalMs, signal)
      } catch (error) {
        if (signal?.aborted) throw new PiImageGenerationToolError('图片任务等待已取消或超时', taskId)
        throw error
      }
      let response: Response
      try {
        response = await this.fetchImpl(`${this.baseUrl}${IMAGE_TASKS_ENDPOINT}/${encodeURIComponent(taskId)}`, { signal })
      } catch (error) {
        if (signal?.aborted) throw new PiImageGenerationToolError('图片任务查询已取消或超时', taskId)
        const message = error instanceof Error ? error.message : '服务未响应'
        throw new PiImageGenerationToolError(`Copis 图片任务查询失败: ${message}`, taskId)
      }
      let text: string
      try {
        text = await response.text()
      } catch (error) {
        if (signal?.aborted) throw new PiImageGenerationToolError('图片任务响应读取已取消或超时', taskId)
        throw new PiImageGenerationToolError('图片任务响应读取失败', taskId)
      }
      let payload: unknown
      try { payload = text ? JSON.parse(text) : undefined } catch { throw new PiImageGenerationToolError('Copis 图片任务响应不是有效 JSON', taskId) }
      if (!response.ok) {
        const error = payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).error === 'string'
          ? String((payload as Record<string, unknown>).error)
          : `图片任务查询失败 (${response.status})`
        throw new PiImageGenerationToolError(error, taskId)
      }
      task = unwrap((payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>)
      const returnedTaskId = typeof task.task_id === 'string' ? task.task_id.trim() : ''
      if (returnedTaskId !== taskId) {
        throw new PiImageGenerationToolError('图片任务响应 ID 不匹配', taskId)
      }
    }
  }
}

function taskId(task: Record<string, unknown>): string | undefined {
  return typeof task.task_id === 'string' && task.task_id.trim() ? task.task_id.trim() : undefined
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
    async execute(toolCallId, params, signal) {
      const input = (params ?? {}) as ImageGenerationToolInput
      const result = await client.execute(input, signal, toolCallId)

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

  const queryDefinition = sdk.defineTool({
    name: 'get_image_task',
    label: '查询图片任务',
    description: '按 task_id 查询已提交图片任务。完成后下载并展示图片；未完成返回状态。不重新生成或扣费。超时后使用此工具恢复。',
    parameters: Type.Object({ task_id: Type.String({ description: '已提交的图片任务 ID' }) }),
    async execute(_toolCallId, params, signal) {
      const result = await client.getTask((params as { task_id: string }).task_id, signal)
      const content: AgentToolResult<unknown>['content'] = [{ type: 'text', text: result.text }]
      if (result.base64) content.push({ type: 'image', data: result.base64, mimeType: result.mediaType })
      return { content, details: { generatedAttachments: result.meta } }
    },
  }) as unknown as ToolDefinition
  const listDefinition = sdk.defineTool({
    name: 'list_image_tasks',
    label: '图片任务列表',
    description: '查找当前登录账号最近 100 个本地图片任务的 task_id，可按 session_id 筛选。列表状态是本地快照，使用 get_image_task 查询最新状态并取回图片。',
    parameters: Type.Object({ session_id: Type.Optional(Type.String({ description: '可选的 Copis 会话 ID' })) }),
    async execute(_toolCallId, params, signal) {
      const payload = await client.listTasks((params as { session_id?: string }).session_id, signal)
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], details: {} }
    },
  }) as unknown as ToolDefinition
  return [definition, queryDefinition, listDefinition].map(tool => ({ ...tool, executionMode: 'sequential' as const }))
}
