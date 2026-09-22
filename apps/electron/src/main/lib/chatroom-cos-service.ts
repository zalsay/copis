import COS from 'cos-nodejs-sdk-v5'
import { createHash } from 'node:crypto'
import { createReadStream, lstatSync, mkdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute } from 'node:path'
import { HTTP_API_HOST, HTTP_API_PORT, getHttpApiInternalToken } from './http-api-server'
import type { ChatRoomAttachmentPhase, ChatRoomTransferResult, ChatRoomTransferState } from '@copis/shared'

const MAX_FILE_BYTES = 512 * 1024 * 1024
const SENSITIVE_TEXT = /(?:secret|token|authorization|object.?key|local.?path|absolute.?path)/i

export interface ChatRoomUploadJob {
  transferId: string
  roomId: string
  filePath: string
}

export interface ChatRoomDownloadJob {
  transferId: string
  roomId: string
  attachmentId: string
  target: 'user' | 'agent_inbox'
  /** Main-only path. Renderer never receives or supplies this value. */
  destinationPath?: string
}

export interface CosSdkGrant {
  attachmentId: string
  bucket: string
  region: string
  objectKey: string
  tmpSecretId: string
  tmpSecretKey: string
  sessionToken: string
  startTime: number
  expiredTime: number
  action: 'upload' | 'download'
}

export interface ChatRoomCosGrantClient {
  requestUploadGrant(input: { roomId: string; originalName: string; mimeType: string; sizeBytes: number; sha256: string }): Promise<CosSdkGrant>
  requestDownloadGrant(input: { roomId: string; attachmentId: string }): Promise<CosSdkGrant>
  finalizeUpload(input: { roomId: string; attachmentId: string; sizeBytes: number; sha256: string; etag: string }): Promise<void>
}

export interface ChatRoomCosSdk {
  sliceUploadFile(params: ChatRoomCosUploadParams): Promise<{ ETag?: string }>
  abortUploadTask(params: { UploadId: string; Level: 'task' }): Promise<unknown>
  downloadFile(params: ChatRoomCosDownloadParams): Promise<{ ETag?: string }>
}

export interface ChatRoomCosUploadParams {
  Bucket: string
  Region: string
  Key: string
  FilePath: string
  ContentType?: string
  onTaskReady?: (taskId: string) => void
  onProgress?: (progress: { loaded: number; total: number; speed: number; percent: number }) => void
}

export interface ChatRoomCosDownloadParams {
  Bucket: string
  Region: string
  Key: string
  FilePath: string
  onTaskReady?: (taskId: string) => void
  onProgress?: (progress: { loaded: number; total: number; speed: number; percent: number }) => void
}

export interface ChatRoomCosFileDialog {
  showOpenDialog(): Promise<{ canceled: boolean; filePaths?: string[] }>
  showSaveDialog(): Promise<{ canceled: boolean; filePath?: string }>
}

export interface ChatRoomCosServiceOptions {
  grantClient?: ChatRoomCosGrantClient
  sdkFactory?: (credentials: { SecretId: string; SecretKey: string; SecurityToken: string }) => ChatRoomCosSdk
  fileDialog: ChatRoomCosFileDialog
  resolveAgentInboxPath?: (roomId: string) => string
  fetchImpl?: typeof fetch
  internalTokenProvider?: () => string | null
  apiBaseUrl?: string
  logger?: (event: string) => void
}

export interface ChatRoomCosService {
  selectAndUpload(input: { transferId: string; roomId: string }): Promise<ChatRoomTransferResult>
  upload(input: ChatRoomUploadJob): Promise<ChatRoomTransferResult>
  download(input: ChatRoomDownloadJob): Promise<ChatRoomTransferResult>
  cancel(transferId: string): Promise<void>
  onProgress(listener: (state: ChatRoomTransferState) => void): () => void
}

interface ActiveTransfer {
  taskId?: string
  cancelled: boolean
  attachmentId?: string
  roomId: string
  originalName?: string
  sdk?: ChatRoomCosSdk
}

function stableErrorCode(error: unknown): string {
  if (error instanceof Error && error.message === 'transfer_not_found') return 'transfer_not_found'
  if (error instanceof Error && error.message === 'transfer_cancelled') return 'transfer_cancelled'
  return 'cos_transfer_failed'
}

function safeLogger(logger: ((event: string) => void) | undefined, event: string): void {
  try { logger?.(event) } catch {}
}

function mimeTypeFor(name: string): string {
  const ext = extname(name).toLowerCase()
  const known: Record<string, string> = {
    '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.pdf': 'application/pdf',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.csv': 'text/csv', '.zip': 'application/zip',
  }
  return known[ext] ?? 'application/octet-stream'
}

function assertSafeIdentifier(value: string, label: string): void {
  if (!value || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label}_invalid`)
}

function assertUploadFile(filePath: string): { sizeBytes: number; originalName: string } {
  if (!isAbsolute(filePath) || /[\u0000\u0001-\u001f\u007f]/.test(filePath)) throw new Error('file_path_invalid')
  const linkStats = lstatSync(filePath)
  if (!linkStats.isFile()) throw new Error('file_not_regular')
  const stats = statSync(filePath)
  if (stats.size > MAX_FILE_BYTES) throw new Error('file_too_large')
  const originalName = basename(filePath)
  if (!originalName || originalName === '.' || originalName === '..') throw new Error('file_name_invalid')
  return { sizeBytes: stats.size, originalName }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', resolve)
  })
  return hash.digest('hex')
}

function clampProgress(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function resultFailed(transferId: string, errorCode: string): ChatRoomTransferResult {
  return { transferId, phase: 'failed', errorCode }
}

function progressState(input: ActiveTransfer, transferId: string, phase: ChatRoomAttachmentPhase, progress: number): ChatRoomTransferState {
  return {
    transferId, roomId: input.roomId, phase, progress,
    ...(input.attachmentId ? { attachmentId: input.attachmentId } : {}),
    ...(input.originalName ? { originalName: input.originalName } : {}),
  }
}

function validateGrant(raw: unknown, action: CosSdkGrant['action']): CosSdkGrant {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('cos_grant_invalid')
  const value = raw as Record<string, unknown>
  const strings = ['attachmentId', 'bucket', 'region', 'objectKey', 'tmpSecretId', 'tmpSecretKey', 'sessionToken'] as const
  for (const key of strings) {
    if (typeof value[key] !== 'string' || !value[key] || /[\u0000-\u001f\u007f]/.test(value[key] as string)) throw new Error('cos_grant_invalid')
  }
  if (value.action !== action || typeof value.startTime !== 'number' || typeof value.expiredTime !== 'number') throw new Error('cos_grant_invalid')
  if (!Number.isSafeInteger(value.startTime) || !Number.isSafeInteger(value.expiredTime) || value.expiredTime <= value.startTime) throw new Error('cos_grant_invalid')
  return {
    attachmentId: value.attachmentId as string, bucket: value.bucket as string, region: value.region as string,
    objectKey: value.objectKey as string, tmpSecretId: value.tmpSecretId as string,
    tmpSecretKey: value.tmpSecretKey as string, sessionToken: value.sessionToken as string,
    startTime: value.startTime, expiredTime: value.expiredTime, action,
  }
}

function clearGrant(grant: CosSdkGrant | undefined): void {
  if (!grant) return
  grant.tmpSecretId = ''
  grant.tmpSecretKey = ''
  grant.sessionToken = ''
  grant.objectKey = ''
}

function createHttpGrantClient(options: Required<Pick<ChatRoomCosServiceOptions, 'fetchImpl' | 'internalTokenProvider' | 'apiBaseUrl'>>): ChatRoomCosGrantClient {
  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const token = options.internalTokenProvider()
    if (!token) throw new Error('internal_token_unavailable')
    const response = await options.fetchImpl(`${options.apiBaseUrl}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-copis-internal-token': token }, body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error('cos_authorization_failed')
    const parsed: unknown = await response.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('cos_grant_invalid')
    return parsed as Record<string, unknown>
  }
  return {
    requestUploadGrant: async (input) => validateGrant(await post('/api/internal/chatrooms/cos/upload-grant', { roomId: input.roomId, fileName: input.originalName, mimeType: input.mimeType, sizeBytes: input.sizeBytes, sha256: input.sha256 }), 'upload'),
    requestDownloadGrant: async (input) => validateGrant(await post('/api/internal/chatrooms/cos/download-grant', input), 'download'),
    finalizeUpload: async (input) => { await post('/api/internal/chatrooms/cos/finalize', input) },
  }
}

export function createChatRoomCosService(options: ChatRoomCosServiceOptions): ChatRoomCosService {
  const grantClient = options.grantClient ?? createHttpGrantClient({
    fetchImpl: options.fetchImpl ?? fetch,
    internalTokenProvider: options.internalTokenProvider ?? getHttpApiInternalToken,
    apiBaseUrl: options.apiBaseUrl ?? `http://${HTTP_API_HOST}:${HTTP_API_PORT}`,
  })
  const sdkFactory = options.sdkFactory ?? ((credentials) => new COS(credentials) as unknown as ChatRoomCosSdk)
  const listeners = new Set<(state: ChatRoomTransferState) => void>()
  const active = new Map<string, ActiveTransfer>()
  const logger = options.logger

  const emit = (state: ChatRoomTransferState): void => {
    for (const listener of [...listeners]) {
      try { listener(state) } catch {}
    }
  }

  const fail = (transferId: string, input: ActiveTransfer, error: unknown): ChatRoomTransferResult => {
    const code = stableErrorCode(error)
    safeLogger(logger, code)
    if (code === 'transfer_cancelled' || input.cancelled) {
      emit(progressState(input, transferId, 'cancelled', 0))
      return { transferId, ...(input.attachmentId ? { attachmentId: input.attachmentId } : {}), ...(input.originalName ? { originalName: input.originalName } : {}), phase: 'cancelled', errorCode: 'transfer_cancelled' }
    }
    emit(progressState(input, transferId, 'failed', 0))
    return { transferId, ...(input.originalName ? { originalName: input.originalName } : {}), phase: 'failed', errorCode: code }
  }

  async function upload(input: ChatRoomUploadJob): Promise<ChatRoomTransferResult> {
    assertSafeIdentifier(input.transferId, 'transfer_id')
    assertSafeIdentifier(input.roomId, 'room_id')
    const transfer: ActiveTransfer = { cancelled: false, roomId: input.roomId }
    active.set(input.transferId, transfer)
    let authorized: CosSdkGrant | undefined
    try {
      const metadata = assertUploadFile(input.filePath)
      transfer.originalName = metadata.originalName
      const sha256 = await sha256File(input.filePath)
      if (transfer.cancelled) throw new Error('transfer_cancelled')
      emit(progressState(transfer, input.transferId, 'waiting_authorization', 0))
      authorized = validateGrant(await grantClient.requestUploadGrant({ roomId: input.roomId, originalName: metadata.originalName, mimeType: mimeTypeFor(metadata.originalName), sizeBytes: metadata.sizeBytes, sha256 }), 'upload')
      transfer.attachmentId = authorized.attachmentId
      if (transfer.cancelled) throw new Error('transfer_cancelled')
      emit(progressState(transfer, input.transferId, 'uploading', 0))
      transfer.sdk = sdkFactory({ SecretId: authorized.tmpSecretId, SecretKey: authorized.tmpSecretKey, SecurityToken: authorized.sessionToken })
      const uploadResult = await transfer.sdk.sliceUploadFile({
        Bucket: authorized.bucket, Region: authorized.region, Key: authorized.objectKey, FilePath: input.filePath,
        ContentType: mimeTypeFor(metadata.originalName),
        onTaskReady: (taskId) => {
          transfer.taskId = taskId
          if (transfer.cancelled && transfer.sdk) void transfer.sdk.abortUploadTask({ UploadId: taskId, Level: 'task' }).catch(() => {})
        },
        onProgress: (value) => emit(progressState(transfer, input.transferId, 'uploading', clampProgress(value.percent))),
      })
      if (transfer.cancelled) throw new Error('transfer_cancelled')
      const etag = typeof uploadResult?.ETag === 'string' && uploadResult.ETag ? uploadResult.ETag : undefined
      if (!etag) throw new Error('cos_upload_missing_etag')
      emit(progressState(transfer, input.transferId, 'validating', 1))
      await grantClient.finalizeUpload({ roomId: input.roomId, attachmentId: authorized.attachmentId, sizeBytes: metadata.sizeBytes, sha256, etag })
      emit(progressState(transfer, input.transferId, 'ready', 1))
      return { transferId: input.transferId, attachmentId: authorized.attachmentId, originalName: metadata.originalName, phase: 'ready' }
    } catch (error) {
      return fail(input.transferId, transfer, error)
    } finally {
      active.delete(input.transferId)
      transfer.sdk = undefined
      transfer.taskId = undefined
      clearGrant(authorized)
    }
  }

  async function selectAndUpload(input: { transferId: string; roomId: string }): Promise<ChatRoomTransferResult> {
    const selected = await options.fileDialog.showOpenDialog()
    if (selected.canceled || !selected.filePaths?.[0]) return { transferId: input.transferId, phase: 'cancelled', errorCode: 'transfer_cancelled' }
    return upload({ transferId: input.transferId, roomId: input.roomId, filePath: selected.filePaths[0] })
  }

  async function download(input: ChatRoomDownloadJob): Promise<ChatRoomTransferResult> {
    assertSafeIdentifier(input.transferId, 'transfer_id')
    assertSafeIdentifier(input.roomId, 'room_id')
    assertSafeIdentifier(input.attachmentId, 'attachment_id')
    const transfer: ActiveTransfer = { cancelled: false, roomId: input.roomId }
    active.set(input.transferId, transfer)
    let authorized: CosSdkGrant | undefined
    try {
      emit(progressState(transfer, input.transferId, 'waiting_authorization', 0))
      authorized = validateGrant(await grantClient.requestDownloadGrant({ roomId: input.roomId, attachmentId: input.attachmentId }), 'download')
      if (authorized.attachmentId !== input.attachmentId) throw new Error('cos_grant_invalid')
      transfer.attachmentId = authorized.attachmentId
      let destinationPath: string | undefined
      if (input.target === 'agent_inbox') {
        if (!options.resolveAgentInboxPath) throw new Error('agent_inbox_unavailable')
        destinationPath = options.resolveAgentInboxPath(input.roomId)
      } else {
        destinationPath = input.destinationPath
        if (!destinationPath) {
          const selected = await options.fileDialog.showSaveDialog()
          if (selected.canceled || !selected.filePath) throw new Error('transfer_cancelled')
          destinationPath = selected.filePath
        }
      }
      if (!destinationPath || !isAbsolute(destinationPath) || /[\u0000\u0001-\u001f\u007f]/.test(destinationPath)) throw new Error('destination_path_invalid')
      mkdirSync(dirname(destinationPath), { recursive: true })
      if (transfer.cancelled) throw new Error('transfer_cancelled')
      emit(progressState(transfer, input.transferId, 'downloading', 0))
      transfer.sdk = sdkFactory({ SecretId: authorized.tmpSecretId, SecretKey: authorized.tmpSecretKey, SecurityToken: authorized.sessionToken })
      const result = await transfer.sdk.downloadFile({
        Bucket: authorized.bucket, Region: authorized.region, Key: authorized.objectKey, FilePath: destinationPath,
        onTaskReady: (taskId) => { transfer.taskId = taskId },
        onProgress: (value) => emit(progressState(transfer, input.transferId, 'downloading', clampProgress(value.percent))),
      })
      if (transfer.cancelled) throw new Error('transfer_cancelled')
      if (!result?.ETag) throw new Error('cos_download_missing_etag')
      emit(progressState(transfer, input.transferId, 'ready', 1))
      return { transferId: input.transferId, attachmentId: authorized.attachmentId, phase: 'ready' }
    } catch (error) {
      return fail(input.transferId, transfer, error)
    } finally {
      active.delete(input.transferId)
      transfer.sdk = undefined
      transfer.taskId = undefined
      clearGrant(authorized)
    }
  }

  return {
    selectAndUpload,
    upload,
    download,
    async cancel(transferId) {
      const transfer = active.get(transferId)
      if (!transfer) throw new Error('transfer_not_found')
      transfer.cancelled = true
      if (transfer.sdk && transfer.taskId) {
        await transfer.sdk.abortUploadTask({ UploadId: transfer.taskId, Level: 'task' })
      }
    },
    onProgress(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
}

export function isChatRoomCosSensitiveText(value: unknown): boolean {
  return typeof value === 'string' && SENSITIVE_TEXT.test(value)
}
