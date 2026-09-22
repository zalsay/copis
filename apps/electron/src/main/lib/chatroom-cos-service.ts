import COS from 'cos-nodejs-sdk-v5'
import { createHash } from 'node:crypto'
import { constants, closeSync, createReadStream, createWriteStream, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { HTTP_API_HOST, HTTP_API_PORT, getHttpApiInternalToken } from './http-api-server'
import type { ChatRoomAttachmentPhase, ChatRoomTransferResult, ChatRoomTransferState } from '@copis/shared'

const MAX_FILE_BYTES = 256 * 1024 * 1024
const MAX_GRANT_TTL_SECONDS = 60 * 60
const GRANT_CLOCK_SKEW_SECONDS = 60
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
  abortUploadTask(params: { UploadId: string; Bucket: string; Region: string; Key: string; Level: 'task' }): Promise<unknown>
  cancelTask(taskId: string): void
  downloadFile(params: ChatRoomCosDownloadParams): Promise<{ ETag?: string }>
}

export interface ChatRoomCosUploadParams {
  Bucket: string
  Region: string
  Key: string
  FilePath: string
  ContentType?: string
  'x-cos-meta-sha256': string
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
  /** 仅供 Main 测试注入；生产默认使用流式 SHA-256。 */
  fileHasher?: (filePath: string) => Promise<string>
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
  kind: 'upload' | 'download'
  bucket?: string
  region?: string
  objectKey?: string
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

interface UploadSnapshot {
  filePath: string
  sizeBytes: number
  originalName: string
  sha256: string
  cleanup(): void
}

function sameFileIdentity(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
}

async function createUploadSnapshot(filePath: string): Promise<UploadSnapshot> {
  if (!isAbsolute(filePath) || /[\u0000\u0001-\u001f\u007f]/.test(filePath)) throw new Error('file_path_invalid')
  const linkStats = lstatSync(filePath)
  if (!linkStats.isFile()) throw new Error('file_not_regular')
  let sourceFd: number | undefined
  let tempFd: number | undefined
  let tempDir: string | undefined
  try {
    sourceFd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const initial = fstatSync(sourceFd)
    if (!initial.isFile()) throw new Error('file_not_regular')
    if (initial.size <= 0) throw new Error('file_empty')
    if (initial.size > MAX_FILE_BYTES) throw new Error('file_too_large')
    tempDir = mkdtempSync(join(tmpdir(), '.copis-chatroom-upload-'))
    const snapshotPath = join(tempDir, 'snapshot')
    tempFd = openSync(snapshotPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    const hash = createHash('sha256')
    const digestTransform = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    await pipeline(
      createReadStream(filePath, { fd: sourceFd, autoClose: false }),
      digestTransform,
      createWriteStream(snapshotPath, { fd: tempFd, autoClose: false }),
    )
    fsyncSync(tempFd)
    const finalSource = fstatSync(sourceFd)
    if (!sameFileIdentity(initial, finalSource)) throw new Error('file_changed')
    const snapshotStats = statSync(snapshotPath)
    if (snapshotStats.size !== initial.size) throw new Error('file_snapshot_invalid')
    const originalName = basename(filePath)
    if (!originalName || originalName === '.' || originalName === '..') throw new Error('file_name_invalid')
    if (!tempDir) throw new Error('file_snapshot_invalid')
    const cleanupDir = tempDir
    closeSync(tempFd)
    tempFd = undefined
    closeSync(sourceFd)
    sourceFd = undefined
    return {
      filePath: snapshotPath,
      sizeBytes: initial.size,
      originalName,
      sha256: hash.digest('hex'),
      cleanup: () => rmSync(cleanupDir, { recursive: true, force: true }),
    }
  } catch (error) {
    if (tempFd !== undefined) { try { closeSync(tempFd) } catch {} }
    if (sourceFd !== undefined) { try { closeSync(sourceFd) } catch {} }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
    throw error
  }
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
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isSafeInteger(value.startTime) || !Number.isSafeInteger(value.expiredTime)
    || value.expiredTime <= value.startTime
    || value.startTime > now + GRANT_CLOCK_SKEW_SECONDS
    || value.startTime < now - GRANT_CLOCK_SKEW_SECONDS
    || value.expiredTime <= now
    || value.expiredTime - value.startTime > MAX_GRANT_TTL_SECONDS) throw new Error('cos_grant_invalid')
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

  async function cancelUploadTask(transfer: ActiveTransfer, taskId: string): Promise<void> {
    transfer.sdk?.cancelTask(taskId)
    if (!transfer.sdk || !transfer.bucket || !transfer.region || !transfer.objectKey) return
    try {
      // SDK 的 abortUploadTask 需要完整对象定位；本地 task id 是 SDK 暴露的唯一可用任务标识。
      await transfer.sdk.abortUploadTask({
        UploadId: taskId, Bucket: transfer.bucket, Region: transfer.region, Key: transfer.objectKey, Level: 'task',
      })
    } catch {
      // 本地任务已取消；远端清理失败不把敏感 SDK 错误暴露给 Renderer。
      safeLogger(logger, 'transfer_abort_failed')
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
    if (active.has(input.transferId)) return resultFailed(input.transferId, 'transfer_in_progress')
    const transfer: ActiveTransfer = { cancelled: false, roomId: input.roomId, kind: 'upload' }
    active.set(input.transferId, transfer)
    let authorized: CosSdkGrant | undefined
    let snapshot: UploadSnapshot | undefined
    try {
      snapshot = await createUploadSnapshot(input.filePath)
      transfer.originalName = snapshot.originalName
      const sha256 = await (options.fileHasher ?? (async () => snapshot!.sha256))(snapshot.filePath)
      if (transfer.cancelled) throw new Error('transfer_cancelled')
      emit(progressState(transfer, input.transferId, 'waiting_authorization', 0))
      authorized = validateGrant(await grantClient.requestUploadGrant({ roomId: input.roomId, originalName: snapshot.originalName, mimeType: mimeTypeFor(snapshot.originalName), sizeBytes: snapshot.sizeBytes, sha256 }), 'upload')
      transfer.attachmentId = authorized.attachmentId
      transfer.bucket = authorized.bucket
      transfer.region = authorized.region
      transfer.objectKey = authorized.objectKey
      if (transfer.cancelled) throw new Error('transfer_cancelled')
      emit(progressState(transfer, input.transferId, 'uploading', 0))
      transfer.sdk = sdkFactory({ SecretId: authorized.tmpSecretId, SecretKey: authorized.tmpSecretKey, SecurityToken: authorized.sessionToken })
      const uploadResult = await transfer.sdk.sliceUploadFile({
        Bucket: authorized.bucket, Region: authorized.region, Key: authorized.objectKey, FilePath: snapshot.filePath,
        ContentType: mimeTypeFor(snapshot.originalName), 'x-cos-meta-sha256': sha256,
        onTaskReady: (taskId) => {
          transfer.taskId = taskId
          if (transfer.cancelled) void cancelUploadTask(transfer, taskId)
        },
        onProgress: (value) => emit(progressState(transfer, input.transferId, 'uploading', clampProgress(value.percent))),
      })
      if (transfer.cancelled) throw new Error('transfer_cancelled')
      const etag = typeof uploadResult?.ETag === 'string' && uploadResult.ETag ? uploadResult.ETag : undefined
      if (!etag) throw new Error('cos_upload_missing_etag')
      emit(progressState(transfer, input.transferId, 'validating', 1))
      await grantClient.finalizeUpload({ roomId: input.roomId, attachmentId: authorized.attachmentId, sizeBytes: snapshot.sizeBytes, sha256, etag })
      emit(progressState(transfer, input.transferId, 'ready', 1))
      return { transferId: input.transferId, attachmentId: authorized.attachmentId, originalName: snapshot.originalName, phase: 'ready' }
    } catch (error) {
      return fail(input.transferId, transfer, error)
    } finally {
      active.delete(input.transferId)
      transfer.sdk = undefined
      transfer.taskId = undefined
      transfer.bucket = undefined
      transfer.region = undefined
      transfer.objectKey = undefined
      clearGrant(authorized)
      try { snapshot?.cleanup() } catch { safeLogger(logger, 'transfer_cleanup_failed') }
    }
  }

  async function selectAndUpload(input: { transferId: string; roomId: string }): Promise<ChatRoomTransferResult> {
    if (active.has(input.transferId)) return resultFailed(input.transferId, 'transfer_in_progress')
    const selected = await options.fileDialog.showOpenDialog()
    if (selected.canceled || !selected.filePaths?.[0]) return { transferId: input.transferId, phase: 'cancelled', errorCode: 'transfer_cancelled' }
    return upload({ transferId: input.transferId, roomId: input.roomId, filePath: selected.filePaths[0] })
  }

  async function download(input: ChatRoomDownloadJob): Promise<ChatRoomTransferResult> {
    assertSafeIdentifier(input.transferId, 'transfer_id')
    assertSafeIdentifier(input.roomId, 'room_id')
    assertSafeIdentifier(input.attachmentId, 'attachment_id')
    if (active.has(input.transferId)) return resultFailed(input.transferId, 'transfer_in_progress')
    const transfer: ActiveTransfer = { cancelled: false, roomId: input.roomId, kind: 'download' }
    active.set(input.transferId, transfer)
    let authorized: CosSdkGrant | undefined
    try {
      emit(progressState(transfer, input.transferId, 'waiting_authorization', 0))
      authorized = validateGrant(await grantClient.requestDownloadGrant({ roomId: input.roomId, attachmentId: input.attachmentId }), 'download')
      if (authorized.attachmentId !== input.attachmentId) throw new Error('cos_grant_invalid')
      transfer.attachmentId = authorized.attachmentId
      transfer.bucket = authorized.bucket
      transfer.region = authorized.region
      transfer.objectKey = authorized.objectKey
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
        onTaskReady: (taskId) => {
          transfer.taskId = taskId
          if (transfer.cancelled && transfer.sdk) transfer.sdk.cancelTask(taskId)
        },
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
      transfer.bucket = undefined
      transfer.region = undefined
      transfer.objectKey = undefined
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
        if (transfer.kind === 'upload') {
          await cancelUploadTask(transfer, transfer.taskId)
        } else {
          transfer.sdk.cancelTask(transfer.taskId)
        }
      }
    },
    onProgress(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
}

export function isChatRoomCosSensitiveText(value: unknown): boolean {
  return typeof value === 'string' && SENSITIVE_TEXT.test(value)
}
