import type { BrowserRecordingEvent } from '@copis/shared'
import { getHttpApiInternalToken, HTTP_API_HOST, HTTP_API_PORT } from './http-api-server'

const MAX_RECORDING_CONTENT_BYTES = 8 * 1024 * 1024

export interface RustBrowserRecordingStartInput {
  recordingId: string
  recordingDirectory: string
  sessionId: string
  workspaceSlug: string
  startTabAlias: string
  startUrl: string
  startedAt: number
}

function assertPathComponent(value: string, field: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${field} 参数不正确`)
  return value
}

function recordingPath(input: Pick<RustBrowserRecordingStartInput, 'workspaceSlug' | 'recordingId'>, action: string): string {
  const workspaceSlug = assertPathComponent(input.workspaceSlug, 'workspaceSlug')
  const recordingId = assertPathComponent(input.recordingId, 'recordingId')
  return `/internal/browser-workflows/recordings/${workspaceSlug}/${recordingId}/${action}`
}

async function request(
  method: 'GET' | 'POST',
  path: string,
  body?: string,
): Promise<string> {
  const token = getHttpApiInternalToken()
  if (!token) throw new Error('Rust HTTP API 尚未启动')

  const maxAttempts = method === 'GET' ? 3 : 1
  let lastError: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await fetch(`http://${HTTP_API_HOST}:${HTTP_API_PORT}${path}`, {
        method,
        headers: {
          'X-Copis-Internal-Token': token,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      })
      const responseBody = await response.text()
      if (!response.ok) {
        throw new Error(`Rust 录制 API 请求失败（${response.status}）：${responseBody.slice(0, 400)}`)
      }
      return responseBody
    } catch (error) {
      lastError = error
      if (attempt < maxAttempts - 1) await new Promise<void>((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
    } finally {
      clearTimeout(timeout)
    }
  }
  throw new Error(`Rust 录制 API 不可用：${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

export async function startRustBrowserRecording(input: RustBrowserRecordingStartInput): Promise<void> {
  await request(
    'POST',
    recordingPath(input, 'start'),
    JSON.stringify({
      kind: 'recording_started',
      recordingId: input.recordingId,
      recordingDirectory: input.recordingDirectory,
      sessionId: input.sessionId,
      startTabAlias: input.startTabAlias,
      startUrl: input.startUrl,
      startedAt: input.startedAt,
    }),
  )
}

export async function appendRustBrowserRecordingEvent(
  input: Pick<RustBrowserRecordingStartInput, 'workspaceSlug' | 'recordingId'>,
  event: BrowserRecordingEvent,
): Promise<void> {
  await request('POST', recordingPath(input, 'event'), JSON.stringify(event))
}

export async function finishRustBrowserRecording(
  input: Pick<RustBrowserRecordingStartInput, 'workspaceSlug' | 'recordingId'>,
): Promise<void> {
  await request('POST', recordingPath(input, 'finish'))
}

export async function cancelRustBrowserRecording(
  input: Pick<RustBrowserRecordingStartInput, 'workspaceSlug' | 'recordingId'>,
): Promise<void> {
  await request('POST', recordingPath(input, 'cancel'))
}

export async function releaseRustBrowserRecording(
  input: Pick<RustBrowserRecordingStartInput, 'workspaceSlug' | 'recordingId'>,
): Promise<void> {
  await request('POST', recordingPath(input, 'release'))
}

export async function readRustBrowserRecording(
  input: Pick<RustBrowserRecordingStartInput, 'workspaceSlug' | 'recordingId'>,
): Promise<string> {
  const content = await request('GET', recordingPath(input, 'content'))
  if (Buffer.byteLength(content, 'utf8') > MAX_RECORDING_CONTENT_BYTES) {
    throw new Error('网页操作 JSONL 超过 Agent 可处理的大小限制')
  }
  return content
}
