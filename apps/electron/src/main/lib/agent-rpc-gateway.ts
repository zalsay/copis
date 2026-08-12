import type {
  AgentMessage,
  AgentQueueMessageInput,
  AgentSendInput,
  AgentStreamCompletePayload,
  AgentStreamEvent,
  AgentStreamPayload,
  CopisPermissionMode,
} from '@copis/shared'
import {
  COPIS_HTTP_API_HOST,
  resolveCopisHttpApiPort,
} from '@copis/shared/config'
import { parseAgentSseData, type AgentRpcWorkerFrame } from './agent-rpc-protocol'

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
const INTERNAL_TOKEN_HEADER = 'X-Copis-Internal-Token'

export interface AgentRpcGatewayCallbacks {
  onEvent?: (event: AgentStreamEvent) => void
  onError: (error: string) => void
  onComplete: (messages?: AgentMessage[], complete?: AgentStreamCompletePayload) => void
  onTitleUpdated: (title: string) => void
  onRunStarted?: (startedAt: number) => void
}

export interface AgentRpcGatewayOptions {
  baseUrl?: string
  fetchImpl?: FetchImplementation
}

function resolveBaseUrl(value: string | undefined): string {
  if (value?.trim()) return value.replace(/\/$/, '')
  const port = resolveCopisHttpApiPort({
    configuredPort: process.env.COPIS_HTTP_API_PORT,
    isPackaged: process.env.COPIS_PACKAGED === '1',
  })
  return `http://${COPIS_HTTP_API_HOST}:${port}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAgentPayload(value: unknown): value is AgentStreamPayload {
  if (!isRecord(value) || (value.kind !== 'sdk_message' && value.kind !== 'copis_event' && value.kind !== 'proma_event')) {
    return false
  }
  return isRecord(value.kind === 'sdk_message' ? value.message : value.event)
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text()
  if (!text) return `Agent HTTP 请求失败（${response.status}）`
  try {
    const parsed: unknown = JSON.parse(text)
    if (isRecord(parsed) && typeof parsed.error === 'string') return parsed.error
  } catch {
    // 非 JSON 错误正文使用原文。
  }
  return text
}

function toComplete(frame: Extract<AgentRpcWorkerFrame, { type: 'complete' }>): AgentStreamCompletePayload {
  return {
    sessionId: frame.sessionId,
    stoppedByUser: frame.stoppedByUser,
    ...(frame.startedAt !== undefined ? { startedAt: frame.startedAt } : {}),
    ...(frame.resultSubtype ? { resultSubtype: frame.resultSubtype } : {}),
    ...(frame.resultErrors ? { resultErrors: frame.resultErrors } : {}),
  }
}

export class AgentRpcGateway {
  private readonly baseUrl: string
  private readonly fetchImpl: FetchImplementation

  constructor(options: AgentRpcGatewayOptions = {}) {
    this.baseUrl = resolveBaseUrl(options.baseUrl)
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async isActive(sessionId: string): Promise<boolean> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/api/agent/sessions/${encodeURIComponent(sessionId)}/status`,
      { headers: { Accept: 'application/json' } },
    )
    if (!response.ok) throw new Error(await readErrorMessage(response))
    const payload: unknown = await response.json()
    if (isRecord(payload) && typeof payload.active === 'boolean') return payload.active
    throw new Error('Pi Worker 状态响应不正确')
  }

  async hasActiveSessions(): Promise<boolean> {
    return (await this.activeSessionIds()).length > 0
  }

  async activeSessionIds(): Promise<string[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/agent/workers/status`, {
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) throw new Error(await readErrorMessage(response))
    const payload: unknown = await response.json()
    if (isRecord(payload) && Array.isArray(payload.activeSessionIds)
      && payload.activeSessionIds.every((sessionId) => typeof sessionId === 'string')) {
      return payload.activeSessionIds
    }
    throw new Error('Pi Worker 列表响应不正确')
  }

  async run(input: AgentSendInput, callbacks: AgentRpcGatewayCallbacks): Promise<void> {
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/api/agent/sessions/${encodeURIComponent(input.sessionId)}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(input),
        },
      )
      if (!response.ok) throw new Error(await readErrorMessage(response))
      if (!response.body) throw new Error('Agent HTTP 响应没有流式内容')
      callbacks.onRunStarted?.(input.startedAt ?? Date.now())

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let completed: AgentStreamCompletePayload | undefined
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
              const result = this.dispatchFrame(frame, callbacks)
              if (result) completed = result
            }
            separator = buffer.indexOf('\n\n')
          }
          if (next.done) break
        }
      } finally {
        reader.releaseLock()
      }

      if (!completed) throw new Error('Agent HTTP 流在完成事件前断开')
      callbacks.onComplete(undefined, completed)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      callbacks.onError(message)
      throw error
    }
  }

  async queue(input: AgentQueueMessageInput): Promise<string> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/api/agent/sessions/${encodeURIComponent(input.sessionId)}/queue`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(input),
      },
    )
    if (!response.ok) throw new Error(await readErrorMessage(response))
    const payload: unknown = await response.json()
    if (isRecord(payload) && payload.accepted === true && typeof payload.uuid === 'string' && payload.uuid) {
      return payload.uuid
    }
    throw new Error('Agent queue 响应不正确')
  }

  async stop(sessionId: string): Promise<void> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/api/agent/sessions/${encodeURIComponent(sessionId)}/stop`,
      { method: 'POST', headers: { Accept: 'application/json' } },
    )
    if (!response.ok) throw new Error(await readErrorMessage(response))
  }

  async stopAll(): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/agent/workers/stop-all`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) throw new Error(await readErrorMessage(response))
  }

  async updatePermissionMode(
    sessionId: string,
    mode: CopisPermissionMode,
    internalToken: string,
  ): Promise<boolean> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/internal/agent/files/permission-mode`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        [INTERNAL_TOKEN_HEADER]: internalToken,
      },
      body: JSON.stringify({ sessionId, permissionMode: mode }),
    })
    if (response.ok) {
      const payload: unknown = await response.json()
      if (isRecord(payload) && typeof payload.updated === 'boolean') return payload.updated
      throw new Error('Pi Worker 权限模式响应不正确')
    }
    const body = await response.text()
    try {
      const payload: unknown = JSON.parse(body)
      if (isRecord(payload) && payload.code === 'agent_policy_not_found') return false
      if (isRecord(payload) && typeof payload.error === 'string') throw new Error(payload.error)
    } catch (error) {
      if (error instanceof Error) throw error
    }
    throw new Error(body || `Agent HTTP 请求失败（${response.status}）`)
  }

  private dispatchFrame(
    frame: AgentRpcWorkerFrame,
    callbacks: AgentRpcGatewayCallbacks,
  ): AgentStreamCompletePayload | undefined {
    if (frame.type === 'event') {
      if (!isAgentPayload(frame.payload)) return undefined
      const event: AgentStreamEvent = { sessionId: frame.sessionId, payload: frame.payload }
      callbacks.onEvent?.(event)
      if (frame.payload.kind !== 'sdk_message' && frame.payload.event.type === 'title_updated') {
        callbacks.onTitleUpdated(frame.payload.event.title)
      }
      return undefined
    }
    if (frame.type === 'complete') return toComplete(frame)
    if (frame.type === 'error' || frame.type === 'fatal') {
      callbacks.onError(frame.error)
    }
    return undefined
  }
}

export const agentRpcGateway = new AgentRpcGateway()
