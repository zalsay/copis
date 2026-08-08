import type {
  AgentQueueMessageInput,
  AgentSendInput,
  AgentStreamCompletePayload,
  AgentStreamEvent,
  AgentStreamPayload,
} from '@copis/shared'
import {
  COPIS_HTTP_API_HOST,
  COPIS_HTTP_API_PRODUCTION_PORT,
} from '@copis/shared/config'
import { parseAgentSseData, type AgentRpcWorkerFrame } from '../../main/lib/agent-rpc-protocol'
import { withHttpApiWebToken } from './http-api-web-token'

function resolveInitialAgentHttpApiBaseUrl(): string {
  const configuredPort = typeof process !== 'undefined' ? process.env.COPIS_HTTP_API_PORT : undefined
  const parsedPort = Number(configuredPort?.trim())
  const port = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
    ? parsedPort
    : COPIS_HTTP_API_PRODUCTION_PORT
  return `http://${COPIS_HTTP_API_HOST}:${port}`
}

type AgentEventListener = (event: AgentStreamEvent) => void
type AgentCompleteListener = (event: AgentStreamCompletePayload) => void
type AgentErrorListener = (event: { sessionId: string; error: string }) => void
type AgentTitleListener = (event: { sessionId: string; title: string }) => void

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text()
  if (!text) return `Agent HTTP 请求失败（${response.status}）`
  try {
    const parsed: unknown = JSON.parse(text) as unknown
    if (isRecord(parsed) && typeof parsed.error === 'string') return parsed.error
  } catch {
    // 非 JSON 错误正文使用原文。
  }
  return text
}

function isAgentPayload(value: unknown): value is AgentStreamPayload {
  if (!isRecord(value) || (value.kind !== 'sdk_message' && value.kind !== 'copis_event' && value.kind !== 'proma_event')) {
    return false
  }
  return isRecord(value.kind === 'sdk_message' ? value.message : value.event)
}

export class AgentHttpStreamClient {
  private baseUrl = resolveInitialAgentHttpApiBaseUrl()
  private readonly eventListeners = new Set<AgentEventListener>()
  private readonly completeListeners = new Set<AgentCompleteListener>()
  private readonly errorListeners = new Set<AgentErrorListener>()
  private readonly titleListeners = new Set<AgentTitleListener>()

  onEvent(listener: AgentEventListener): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onComplete(listener: AgentCompleteListener): () => void {
    this.completeListeners.add(listener)
    return () => this.completeListeners.delete(listener)
  }

  onError(listener: AgentErrorListener): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  onTitleUpdated(listener: AgentTitleListener): () => void {
    this.titleListeners.add(listener)
    return () => this.titleListeners.delete(listener)
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  async send(input: AgentSendInput): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/api/agent/sessions/${encodeURIComponent(input.sessionId)}/messages`,
      withHttpApiWebToken({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(input),
      }),
    )
    if (!response.ok) throw new Error(await readErrorMessage(response))
    if (!response.body) throw new Error('Agent HTTP 响应没有流式内容')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let completed = false
    try {
      while (true) {
        const next = await reader.read()
        buffer += decoder.decode(next.value, { stream: !next.done })
        buffer = buffer.replace(/\r\n/g, '\n')
        let separator = buffer.indexOf('\n\n')
        while (separator !== -1) {
          const block = buffer.slice(0, separator)
          buffer = buffer.slice(separator + 2)
          const frame = parseAgentSseData(block)
          if (frame) {
            completed = this.dispatchFrame(frame) || completed
          }
          separator = buffer.indexOf('\n\n')
        }
        if (next.done) break
      }
    } finally {
      reader.releaseLock()
    }
    if (!completed) throw new Error('Agent HTTP 流在完成事件前断开')
  }

  async queue(input: AgentQueueMessageInput): Promise<string> {
    const response = await fetch(
      `${this.baseUrl}/api/agent/sessions/${encodeURIComponent(input.sessionId)}/queue`,
      withHttpApiWebToken({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(input),
      }),
    )
    if (!response.ok) throw new Error(await readErrorMessage(response))

    const text = await response.text()
    try {
      const payload: unknown = JSON.parse(text) as unknown
      if (isRecord(payload) && payload.accepted === true && typeof payload.uuid === 'string' && payload.uuid) {
        return payload.uuid
      }
    } catch {
      // queue 接口必须返回 JSON 确认，解析失败统一按协议错误处理。
    }
    throw new Error('Agent queue 响应不正确')
  }

  async stop(sessionId: string): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/api/agent/sessions/${encodeURIComponent(sessionId)}/stop`,
      withHttpApiWebToken({ method: 'POST', headers: { Accept: 'application/json' } }),
    )
    if (!response.ok) throw new Error(await readErrorMessage(response))
  }

  private dispatchFrame(frame: AgentRpcWorkerFrame): boolean {
    if (frame.type === 'event') {
      if (!isAgentPayload(frame.payload)) return false
      const event: AgentStreamEvent = { sessionId: frame.sessionId, payload: frame.payload }
      for (const listener of this.eventListeners) listener(event)
      const payloadEvent = frame.payload.kind === 'sdk_message' ? undefined : frame.payload.event
      if (payloadEvent?.type === 'title_updated') {
        for (const listener of this.titleListeners) {
          listener({ sessionId: frame.sessionId, title: payloadEvent.title })
        }
      }
      return false
    }
    if (frame.type === 'complete') {
      const complete: AgentStreamCompletePayload = {
        sessionId: frame.sessionId,
        stoppedByUser: frame.stoppedByUser,
        ...(frame.startedAt !== undefined ? { startedAt: frame.startedAt } : {}),
        ...(frame.resultSubtype ? { resultSubtype: frame.resultSubtype } : {}),
        ...(frame.resultErrors ? { resultErrors: frame.resultErrors } : {}),
      }
      for (const listener of this.completeListeners) listener(complete)
      return true
    }
    if (frame.type === 'error' || frame.type === 'fatal') {
      if (frame.sessionId) {
        for (const listener of this.errorListeners) listener({ sessionId: frame.sessionId, error: frame.error })
      }
    }
    return false
  }
}

export const agentHttpStreamClient = new AgentHttpStreamClient()

export function configureAgentHttpApiBaseUrl(baseUrl: string): void {
  agentHttpStreamClient.setBaseUrl(baseUrl)
}
