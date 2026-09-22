import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

mock.module('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }))
mock.module('./http-api-server', () => ({ HTTP_API_HOST: '127.0.0.1', HTTP_API_PORT: 51730, getHttpApiInternalToken: () => 'test-token' }))

const {
  createChatRoomCosService,
  createChatRoomAgentInboxResolver,
} = await import('./chatroom-cos-service')
import type { ChatRoomCosSdk, ChatRoomCosServiceOptions, CosSdkGrant } from './chatroom-cos-service'

const roots: string[] = []

afterEach(() => {
  roots.splice(0).forEach((root) => {
    try { require('node:fs').rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'copis-chatroom-cos-'))
  roots.push(root)
  return root
}

function grant(action: 'upload' | 'download' = 'upload'): CosSdkGrant {
  const now = Math.floor(Date.now() / 1000)
  return {
    attachmentId: 'att-1', bucket: 'bucket-1', region: 'ap-shanghai', objectKey: 'rooms/r1/att-1/a.txt',
    tmpSecretId: 'secret-id', tmpSecretKey: 'secret-key', sessionToken: 'session-token',
    startTime: now - 1, expiredTime: now + 900, action,
  }
}

function baseOptions(overrides: Partial<ChatRoomCosServiceOptions> = {}): ChatRoomCosServiceOptions {
  return {
    grantClient: {
      requestUploadGrant: async () => grant('upload'),
      requestDownloadGrant: async () => grant('download'),
      finalizeUpload: async () => {},
    },
    sdkFactory: () => ({
      sliceUploadFile: async (params) => {
        params.onTaskReady?.('task-1')
        params.onProgress?.({ loaded: 1, total: 2, speed: 1, percent: 0.5 })
        return { ETag: 'etag-1' }
      },
      abortUploadTask: async () => ({}),
      cancelTask: () => {},
      downloadFile: async (params) => {
        params.onProgress?.({ loaded: 2, total: 2, speed: 1, percent: 1 })
        return { ETag: 'etag-download' }
      },
    }),
    fileDialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: false, filePath: undefined }),
    },
    ...overrides,
  }
}

describe('ChatRoomCosService', () => {
  test('生产 Agent inbox resolver 每次读取当前用户、设备和 room 配置并拒绝归档 Agent', () => {
    let currentUserId: string | undefined = 'host-1'
    let currentDeviceId = 'device-1'
    let room: any = {
      roomId: 'room-1', hostUserId: 'host-1', deviceId: 'device-1', lastProcessedSeq: 0,
      agents: [{ roomAgentId: 'agent-1', archivedAt: undefined }], invocations: [], createdAt: 1, updatedAt: 1,
    }
    const resolver = createChatRoomAgentInboxResolver({
      readRoom: () => room,
      getCurrentUserId: () => currentUserId,
      getDeviceId: () => currentDeviceId,
    })
    const first = resolver('room-1', 'agent-1', 'attachment-1')
    expect(first).toContain('agent-1')
    currentUserId = undefined
    expect(() => resolver('room-1', 'agent-1', 'attachment-1')).toThrow('无权访问')
    currentUserId = 'host-1'
    currentDeviceId = 'device-2'
    expect(() => resolver('room-1', 'agent-1', 'attachment-1')).toThrow('无权访问')
    currentDeviceId = 'device-1'
    room = { ...room, hostUserId: 'replacement-host' }
    expect(() => resolver('room-1', 'agent-1', 'attachment-1')).toThrow('无权访问')
    room = { ...room, hostUserId: 'host-1', agents: [{ roomAgentId: 'agent-1', archivedAt: Date.now() }] }
    expect(() => resolver('room-1', 'agent-1', 'attachment-1')).toThrow('无权访问')
  })

  test('Electron builder 保留 Main COS SDK runtime 依赖', () => {
    const builder = readFileSync(join(import.meta.dir, '../../../electron-builder.yml'), 'utf8')
    expect(builder).not.toContain('!node_modules/cos-nodejs-sdk-v5/**')
  })

  test('Main 选择文件后读取 metadata/SHA256，只请求一次上传授权并 finalize', async () => {
    const root = makeRoot()
    const filePath = join(root, 'a.txt')
    writeFileSync(filePath, 'hello')
    let uploadInput: unknown
    let finalized: unknown
    let sdkParams: Record<string, unknown> | undefined
    const options = baseOptions({
      fileDialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [filePath] }), showSaveDialog: async () => ({ canceled: true }) },
      grantClient: {
        requestUploadGrant: async (input) => { uploadInput = input; return grant('upload') },
        requestDownloadGrant: async () => grant('download'),
        finalizeUpload: async (input) => { finalized = input },
      },
      sdkFactory: (credentials) => {
        expect(credentials).toEqual({ SecretId: 'secret-id', SecretKey: 'secret-key', SecurityToken: 'session-token' })
        return {
          sliceUploadFile: async (params) => { sdkParams = params as unknown as Record<string, unknown>; params.onTaskReady?.('task-1'); return { ETag: 'etag-1' } },
          abortUploadTask: async () => ({}),
          cancelTask: () => {},
          downloadFile: async () => ({ ETag: 'etag' }),
        }
      },
    })
    const service = createChatRoomCosService(options)
    const result = await service.selectAndUpload({ transferId: 'transfer-1', roomId: 'room-1' })

    expect(uploadInput).toEqual({ roomId: 'room-1', originalName: 'a.txt', mimeType: 'text/plain', sizeBytes: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' })
    expect(finalized).toEqual({ roomId: 'room-1', attachmentId: 'att-1', sizeBytes: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', etag: 'etag-1' })
    expect(sdkParams?.Key).toBe('rooms/r1/att-1/a.txt')
    expect(sdkParams?.['x-cos-meta-sha256']).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    expect(result).toEqual({ transferId: 'transfer-1', attachmentId: 'att-1', originalName: 'a.txt', phase: 'ready' })
    expect(JSON.stringify(result)).not.toContain('secret-key')
    expect(JSON.stringify(result)).not.toContain(filePath)
  })

  test('上传使用受控临时快照，hash 与 SDK 读取同一内容并在结束后清理', async () => {
    const root = makeRoot()
    const filePath = join(root, 'snapshot.txt')
    writeFileSync(filePath, 'before-mutation')
    let sdkPath = ''
    let sdkContent = ''
    const service = createChatRoomCosService(baseOptions({
      sdkFactory: () => {
        writeFileSync(filePath, 'after-mutation')
        return {
          sliceUploadFile: async (params) => {
            sdkPath = params.FilePath
            sdkContent = require('node:fs').readFileSync(params.FilePath, 'utf8')
            return { ETag: 'etag-snapshot' }
          },
          abortUploadTask: async () => ({}), cancelTask: () => {}, downloadFile: async () => ({ ETag: 'etag' }),
        }
      },
    }))
    const result = await service.upload({ transferId: 'snapshot-transfer', roomId: 'r-1', filePath })
    expect(result.phase).toBe('ready')
    expect(sdkContent).toBe('before-mutation')
    expect(sdkPath).not.toBe(filePath)
    expect(existsSync(sdkPath)).toBe(false)
  })

  test('拒绝空文件、超过 Rust 256MiB 上限和无效 grant 时间窗口', async () => {
    const root = makeRoot()
    const emptyPath = join(root, 'empty.txt')
    const oversizedPath = join(root, 'oversized.bin')
    writeFileSync(emptyPath, '')
    writeFileSync(oversizedPath, '')
    truncateSync(oversizedPath, 256 * 1024 * 1024 + 1)
    const service = createChatRoomCosService(baseOptions({
      grantClient: {
        requestUploadGrant: async () => ({ ...grant(), expiredTime: Math.floor(Date.now() / 1000) - 1 }),
        requestDownloadGrant: async () => grant('download'), finalizeUpload: async () => {},
      },
    }))
    expect((await service.upload({ transferId: 'empty', roomId: 'r-1', filePath: emptyPath })).errorCode).toBe('cos_transfer_failed')
    expect((await service.upload({ transferId: 'oversized', roomId: 'r-1', filePath: oversizedPath })).errorCode).toBe('cos_transfer_failed')
    const validPath = join(root, 'valid.txt')
    writeFileSync(validPath, 'valid')
    expect((await service.upload({ transferId: 'expired', roomId: 'r-1', filePath: validPath })).errorCode).toBe('cos_transfer_failed')
  })

  test('分片上传把 SDK progress 映射为脱敏 transfer state', async () => {
    const progress: unknown[] = []
    const root = makeRoot()
    const filePath = join(root, 'a.bin')
    writeFileSync(filePath, 'ab')
    const service = createChatRoomCosService(baseOptions({
      fileDialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [filePath] }), showSaveDialog: async () => ({ canceled: true }) },
    }))
    service.onProgress((state) => progress.push(state))
    await service.selectAndUpload({ transferId: 't-1', roomId: 'r-1' })
    expect(progress).toContainEqual({ transferId: 't-1', attachmentId: 'att-1', roomId: 'r-1', originalName: 'a.bin', phase: 'uploading', progress: 0.5 })
    expect(progress.at(-1)).toEqual({ transferId: 't-1', attachmentId: 'att-1', roomId: 'r-1', originalName: 'a.bin', phase: 'ready', progress: 1 })
    expect(JSON.stringify(progress)).not.toContain('objectKey')
  })

  test('取消上传调用 abortUploadTask 且不会 finalize', async () => {
    const root = makeRoot()
    const filePath = join(root, 'a.txt')
    writeFileSync(filePath, 'hello')
    let finalizeCount = 0
    let resolveUpload!: (value: { ETag: string }) => void
    let aborted: unknown
    let taskReady!: () => void
    const taskReadyBarrier = new Promise<void>((resolve) => { taskReady = resolve })
    const service = createChatRoomCosService(baseOptions({
      fileDialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [filePath] }), showSaveDialog: async () => ({ canceled: true }) },
      grantClient: { requestUploadGrant: async () => grant(), requestDownloadGrant: async () => grant('download'), finalizeUpload: async () => { finalizeCount++ } },
      sdkFactory: () => ({
        sliceUploadFile: async (params) => { params.onTaskReady?.('task-cancel'); taskReady(); return new Promise((resolve) => { resolveUpload = resolve }) },
        abortUploadTask: async (params) => { aborted = params; resolveUpload({ ETag: 'late' }); return {} },
        cancelTask: () => {},
        downloadFile: async () => ({ ETag: 'etag' }),
      }),
    }))
    const running = service.upload({ transferId: 't-cancel', roomId: 'r-1', filePath })
    await taskReadyBarrier
    await service.cancel('t-cancel')
    const result = await running
    expect(aborted).toEqual({ Bucket: 'bucket-1', Region: 'ap-shanghai', Key: 'rooms/r1/att-1/a.txt', Level: 'file' })
    expect(finalizeCount).toBe(0)
    expect(result.phase).toBe('cancelled')
  })

  test('hash 尚未完成时取消会阻止授权、SDK 和 finalize', async () => {
    const root = makeRoot()
    const filePath = join(root, 'early.txt')
    writeFileSync(filePath, 'hello')
    let releaseHash!: () => void
    let hashStarted!: () => void
    const hashBarrier = new Promise<void>((resolve) => { hashStarted = resolve })
    const hashRelease = new Promise<void>((resolve) => { releaseHash = resolve })
    let grantCalls = 0
    let sdkCalls = 0
    let finalizeCalls = 0
    const service = createChatRoomCosService(baseOptions({
      fileHasher: async () => { hashStarted(); await hashRelease; return 'a'.repeat(64) },
      grantClient: { requestUploadGrant: async () => { grantCalls++; return grant() }, requestDownloadGrant: async () => grant('download'), finalizeUpload: async () => { finalizeCalls++ } },
      sdkFactory: () => { sdkCalls++; return { sliceUploadFile: async () => ({ ETag: 'etag' }), abortUploadTask: async () => ({}), cancelTask: () => {}, downloadFile: async () => ({ ETag: 'etag' }) } },
    }))
    const running = service.upload({ transferId: 't-before-hash', roomId: 'r-1', filePath })
    await hashBarrier
    await service.cancel('t-before-hash')
    releaseHash()
    const result = await running
    expect(result.phase).toBe('cancelled')
    expect(grantCalls).toBe(0)
    expect(sdkCalls).toBe(0)
    expect(finalizeCalls).toBe(0)
  })

  test('授权请求进行中取消会阻止 SDK 和 finalize', async () => {
    const root = makeRoot()
    const filePath = join(root, 'grant.txt')
    writeFileSync(filePath, 'hello')
    let grantRequested!: () => void
    const grantBarrier = new Promise<void>((resolve) => { grantRequested = resolve })
    let releaseGrant!: (value: CosSdkGrant) => void
    const grantPromise = new Promise<CosSdkGrant>((resolve) => { releaseGrant = resolve })
    let sdkCalls = 0
    let finalizeCalls = 0
    const service = createChatRoomCosService(baseOptions({
      grantClient: { requestUploadGrant: async () => { grantRequested(); return grantPromise }, requestDownloadGrant: async () => grant('download'), finalizeUpload: async () => { finalizeCalls++ } },
      sdkFactory: () => { sdkCalls++; return { sliceUploadFile: async () => ({ ETag: 'etag' }), abortUploadTask: async () => ({}), cancelTask: () => {}, downloadFile: async () => ({ ETag: 'etag' }) } },
    }))
    const running = service.upload({ transferId: 't-before-task', roomId: 'r-1', filePath })
    await grantBarrier
    await service.cancel('t-before-task')
    releaseGrant(grant())
    const result = await running
    expect(result.phase).toBe('cancelled')
    expect(sdkCalls).toBe(0)
    expect(finalizeCalls).toBe(0)
  })

  test('同一 transferId 并发上传不会覆盖 active task', async () => {
    const root = makeRoot()
    const filePath = join(root, 'duplicate.txt')
    writeFileSync(filePath, 'hello')
    let releaseGrant!: (value: CosSdkGrant) => void
    const grantPromise = new Promise<CosSdkGrant>((resolve) => { releaseGrant = resolve })
    let grantRequested!: () => void
    const grantBarrier = new Promise<void>((resolve) => { grantRequested = resolve })
    let grantCalls = 0
    const service = createChatRoomCosService(baseOptions({
      grantClient: { requestUploadGrant: async () => { grantCalls++; grantRequested(); return grantPromise }, requestDownloadGrant: async () => grant('download'), finalizeUpload: async () => {} },
    }))
    const first = service.upload({ transferId: 'same-transfer', roomId: 'r-1', filePath })
    await grantBarrier
    const second = await service.upload({ transferId: 'same-transfer', roomId: 'r-1', filePath })
    expect(second).toEqual({ transferId: 'same-transfer', phase: 'failed', errorCode: 'transfer_in_progress' })
    expect(grantCalls).toBe(1)
    await service.cancel('same-transfer')
    releaseGrant(grant())
    expect((await first).phase).toBe('cancelled')
  })

  test('选择文件对话框期间占用 transferId，取消后不启动上传', async () => {
    const root = makeRoot()
    const filePath = join(root, 'selected.txt')
    writeFileSync(filePath, 'hello')
    let releaseDialog!: (value: { canceled: boolean; filePaths: string[] }) => void
    const dialog = new Promise<{ canceled: boolean; filePaths: string[] }>((resolve) => { releaseDialog = resolve })
    let uploadGrantCalls = 0
    const service = createChatRoomCosService(baseOptions({
      fileDialog: { showOpenDialog: async () => dialog, showSaveDialog: async () => ({ canceled: true }) },
      grantClient: { requestUploadGrant: async () => { uploadGrantCalls++; return grant() }, requestDownloadGrant: async () => grant('download'), finalizeUpload: async () => {} },
    }))
    const first = service.selectAndUpload({ transferId: 'select-lock', roomId: 'r-1' })
    await Promise.resolve()
    expect(await service.upload({ transferId: 'select-lock', roomId: 'r-1', filePath })).toEqual({ transferId: 'select-lock', phase: 'failed', errorCode: 'transfer_in_progress' })
    await service.cancel('select-lock')
    releaseDialog({ canceled: false, filePaths: [filePath] })
    expect(await first).toEqual({ transferId: 'select-lock', phase: 'cancelled', errorCode: 'transfer_cancelled' })
    expect(uploadGrantCalls).toBe(0)
  })

  test('选择文件对话框异常会清理 transferId，后续同 ID 可重试', async () => {
    let calls = 0
    const service = createChatRoomCosService(baseOptions({
      fileDialog: { showOpenDialog: async () => { calls++; throw new Error('dialog_failed') }, showSaveDialog: async () => ({ canceled: true }) },
    }))
    expect((await service.selectAndUpload({ transferId: 'select-error', roomId: 'r-1' })).phase).toBe('failed')
    expect((await service.selectAndUpload({ transferId: 'select-error', roomId: 'r-1' })).phase).toBe('failed')
    expect(calls).toBe(2)
  })

  test('finalize 进行中取消明确失败且不会返回用户取消后的 ready', async () => {
    const root = makeRoot()
    const filePath = join(root, 'finalize.txt')
    writeFileSync(filePath, 'hello')
    let finalizeStarted!: () => void
    const finalizeBarrier = new Promise<void>((resolve) => { finalizeStarted = resolve })
    let releaseFinalize!: () => void
    const finalizeRelease = new Promise<void>((resolve) => { releaseFinalize = resolve })
    const service = createChatRoomCosService(baseOptions({
      grantClient: {
        requestUploadGrant: async () => grant(), requestDownloadGrant: async () => grant('download'),
        finalizeUpload: async () => { finalizeStarted(); await finalizeRelease },
      },
    }))
    const running = service.upload({ transferId: 't-finalize', roomId: 'r-1', filePath })
    await finalizeBarrier
    await expect(service.cancel('t-finalize')).rejects.toThrow('transfer_finalize_in_progress')
    releaseFinalize()
    expect(await running).toEqual({ transferId: 't-finalize', attachmentId: 'att-1', originalName: 'finalize.txt', phase: 'ready' })
  })

  test('下载取消使用 SDK cancelTask，不调用 upload 专用 abort', async () => {
    const root = makeRoot()
    const destination = join(root, 'download-cancel.txt')
    let taskReady!: () => void
    const taskBarrier = new Promise<void>((resolve) => { taskReady = resolve })
    let resolveDownload!: (value: { ETag: string }) => void
    let abortCalls = 0
    let cancelCalls = 0
    const service = createChatRoomCosService(baseOptions({
      grantClient: { requestUploadGrant: async () => grant(), requestDownloadGrant: async () => grant('download'), finalizeUpload: async () => {} },
      sdkFactory: () => ({
        sliceUploadFile: async () => ({ ETag: 'etag' }),
        abortUploadTask: async () => { abortCalls++; return {} },
        cancelTask: () => { cancelCalls++ },
        downloadFile: async (params) => { params.onTaskReady?.('download-task'); taskReady(); return new Promise((resolve) => { resolveDownload = resolve }) },
      }),
    }))
    const running = service.download({ transferId: 'download-cancel', roomId: 'r-1', attachmentId: 'att-1', target: 'user', destinationPath: destination })
    await taskBarrier
    await service.cancel('download-cancel')
    resolveDownload({ ETag: 'late' })
    expect((await running).phase).toBe('cancelled')
    expect(cancelCalls).toBe(1)
    expect(abortCalls).toBe(0)
  })

  test('上传完成后 SDK 晚到 progress 不再向 Renderer 发事件', async () => {
    const root = makeRoot()
    const filePath = join(root, 'late.txt')
    writeFileSync(filePath, 'hello')
    let lateProgress!: (value: { loaded: number; total: number; speed: number; percent: number }) => void
    const progress: unknown[] = []
    const service = createChatRoomCosService(baseOptions({
      sdkFactory: () => ({
        sliceUploadFile: async (params) => { lateProgress = params.onProgress!; return { ETag: 'etag-late' } },
        abortUploadTask: async () => ({}), cancelTask: () => {}, downloadFile: async () => ({ ETag: 'etag' }),
      }),
    }))
    service.onProgress((state) => progress.push(state))
    expect((await service.upload({ transferId: 'late-upload', roomId: 'r-1', filePath })).phase).toBe('ready')
    const count = progress.length
    lateProgress({ loaded: 1, total: 2, speed: 1, percent: 0.5 })
    expect(progress.length).toBe(count)
  })

  test('下载完成后 SDK 晚到 progress 不再向 Renderer 发事件', async () => {
    const root = makeRoot()
    const destination = join(root, 'late-download.txt')
    let lateProgress!: (value: { loaded: number; total: number; speed: number; percent: number }) => void
    const progress: unknown[] = []
    const service = createChatRoomCosService(baseOptions({
      sdkFactory: () => ({
        sliceUploadFile: async () => ({ ETag: 'etag' }), abortUploadTask: async () => ({}), cancelTask: () => {},
        downloadFile: async (params) => { lateProgress = params.onProgress!; return { ETag: 'etag-late-download' } },
      }),
    }))
    service.onProgress((state) => progress.push(state))
    expect((await service.download({ transferId: 'late-download', roomId: 'r-1', attachmentId: 'att-1', target: 'user', destinationPath: destination })).phase).toBe('ready')
    const count = progress.length
    lateProgress({ loaded: 1, total: 2, speed: 1, percent: 0.5 })
    expect(progress.length).toBe(count)
  })

  test('下载只使用服务端 objectKey 并把结果写到 Main 选择的目标', async () => {
    const root = makeRoot()
    const destination = join(root, 'download.txt')
    let sdkParams: Record<string, unknown> | undefined
    const service = createChatRoomCosService(baseOptions({
      grantClient: { requestUploadGrant: async () => grant(), requestDownloadGrant: async () => grant('download'), finalizeUpload: async () => {} },
      fileDialog: { showOpenDialog: async () => ({ canceled: true }), showSaveDialog: async () => ({ canceled: false, filePath: destination }) },
      sdkFactory: () => ({
        sliceUploadFile: async () => ({ ETag: 'etag' }), abortUploadTask: async () => ({}), cancelTask: () => {},
        downloadFile: async (params) => { sdkParams = params as unknown as Record<string, unknown>; return { ETag: 'etag-download' } },
      }),
    }))
    const result = await service.download({ transferId: 't-download', roomId: 'r-1', attachmentId: 'att-1', target: 'user', destinationPath: destination })
    expect(sdkParams).toMatchObject({ Bucket: 'bucket-1', Region: 'ap-shanghai', Key: 'rooms/r1/att-1/a.txt' })
    expect(typeof sdkParams?.FilePath).toBe('string')
    expect(sdkParams?.FilePath).not.toBe(destination)
    expect(existsSync(destination)).toBe(true)
    expect(result).toEqual({ transferId: 't-download', attachmentId: 'att-1', phase: 'ready' })
    expect(JSON.stringify(result)).not.toContain('objectKey')
  })

  test('下载到用户已选目标会完成受控替换', async () => {
    const root = makeRoot()
    const destination = join(root, 'replace.txt')
    writeFileSync(destination, '旧文件必须被用户选择覆盖')
    const service = createChatRoomCosService(baseOptions({
      sdkFactory: () => ({
        sliceUploadFile: async () => ({ ETag: 'etag' }), abortUploadTask: async () => ({}), cancelTask: () => {},
        downloadFile: async (params) => { writeFileSync(params.FilePath, '新文件'); return { ETag: 'etag-replace' } },
      }),
    }))
    expect((await service.download({ transferId: 'replace-target', roomId: 'r-1', attachmentId: 'att-1', target: 'user', destinationPath: destination })).phase).toBe('ready')
    expect(readFileSync(destination, 'utf8')).toBe('新文件')
  })

  test('下载到 Agent inbox 只解析绑定房间的隔离目录', async () => {
    const root = makeRoot()
    const inbox = join(root, 'room-r1', 'agent-a', 'inbox', 'file.txt')
    mkdirSync(join(root, 'room-r1', 'agent-a', 'inbox'), { recursive: true })
    let requestedRoom: string | undefined
    let destination: string | undefined
    const service = createChatRoomCosService(baseOptions({
      fileDialog: { showOpenDialog: async () => ({ canceled: true }), showSaveDialog: async () => ({ canceled: true }) },
      resolveAgentInboxPath: (roomId, roomAgentId, attachmentId) => { requestedRoom = `${roomId}/${roomAgentId}/${attachmentId}`; return inbox },
      sdkFactory: () => ({
        sliceUploadFile: async () => ({ ETag: 'etag' }), abortUploadTask: async () => ({}), cancelTask: () => {},
        downloadFile: async (params) => { destination = params.FilePath; return { ETag: 'etag' } },
      }),
    }))
    await service.download({ transferId: 't-inbox', roomId: 'r-1', attachmentId: 'att-1', target: 'agent_inbox', roomAgentId: 'agent-a' })
    expect(requestedRoom).toBe('r-1/agent-a/att-1')
    expect(destination).not.toBe(inbox)
    expect(destination).toContain('.copis-chatroom-download-')
    expect(existsSync(inbox)).toBe(true)
    expect(destination).not.toContain('attacker.txt')
  })

  test('Agent inbox 在 grant 返回后身份变更时 fail closed，不启动 SDK', async () => {
    const root = makeRoot()
    const destination = join(root, 'inbox', 'attachment.bin')
    mkdirSync(dirname(destination), { recursive: true })
    let identity = 'active'
    let resolverCalls = 0
    let sdkCalls = 0
    const service = createChatRoomCosService(baseOptions({
      grantClient: {
        requestUploadGrant: async () => grant(),
        requestDownloadGrant: async () => grant('download'),
        finalizeUpload: async () => {},
      },
      resolveAgentInboxPath: () => {
        resolverCalls++
        if (identity !== 'active') throw new Error('agent_inbox_forbidden')
        identity = 'logged_out'
        return destination
      },
      sdkFactory: () => {
        sdkCalls++
        return { sliceUploadFile: async () => ({ ETag: 'etag' }), abortUploadTask: async () => ({}), cancelTask: () => {}, downloadFile: async () => ({ ETag: 'etag' }) }
      },
    }))
    const result = await service.download({ transferId: 'grant-aba', roomId: 'r-1', attachmentId: 'att-1', target: 'agent_inbox', roomAgentId: 'agent-a' })
    expect(result.phase).toBe('failed')
    expect(resolverCalls).toBeGreaterThanOrEqual(2)
    expect(sdkCalls).toBe(0)
    expect(existsSync(destination)).toBe(false)
  })

  test('Agent inbox 在 SDK 完成后 Agent 被归档时不执行最终替换并清理临时目录', async () => {
    const root = makeRoot()
    const destination = join(root, 'inbox', 'attachment.bin')
    mkdirSync(dirname(destination), { recursive: true })
    let archived = false
    let resolverCalls = 0
    let temporaryPath: string | undefined
    const service = createChatRoomCosService(baseOptions({
      resolveAgentInboxPath: () => {
        resolverCalls++
        if (archived) throw new Error('agent_archived')
        return destination
      },
      sdkFactory: () => ({
        sliceUploadFile: async () => ({ ETag: 'etag' }), abortUploadTask: async () => ({}), cancelTask: () => {},
        downloadFile: async (params) => {
          temporaryPath = params.FilePath
          writeFileSync(params.FilePath, 'private payload')
          archived = true
          return { ETag: 'etag' }
        },
      }),
    }))
    const result = await service.download({ transferId: 'archive-aba', roomId: 'r-1', attachmentId: 'att-1', target: 'agent_inbox', roomAgentId: 'agent-a' })
    expect(result.phase).toBe('failed')
    expect(resolverCalls).toBeGreaterThanOrEqual(3)
    expect(existsSync(destination)).toBe(false)
    expect(temporaryPath).toBeDefined()
    expect(existsSync(temporaryPath!)).toBe(false)
  })

  test('房间配置替换导致 inbox 目的地变化时不写入新房间', async () => {
    const root = makeRoot()
    const oldDestination = join(root, 'old-room', 'attachment.bin')
    const newDestination = join(root, 'new-room', 'attachment.bin')
    mkdirSync(dirname(oldDestination), { recursive: true })
    mkdirSync(dirname(newDestination), { recursive: true })
    let resolverCalls = 0
    let temporaryPath: string | undefined
    const service = createChatRoomCosService(baseOptions({
      resolveAgentInboxPath: () => {
        resolverCalls++
        return resolverCalls === 1 ? oldDestination : newDestination
      },
      sdkFactory: () => ({
        sliceUploadFile: async () => ({ ETag: 'etag' }), abortUploadTask: async () => ({}), cancelTask: () => {},
        downloadFile: async (params) => {
          temporaryPath = params.FilePath
          writeFileSync(params.FilePath, 'private payload')
          return { ETag: 'etag' }
        },
      }),
    }))
    const result = await service.download({ transferId: 'room-replace-aba', roomId: 'r-1', attachmentId: 'att-1', target: 'agent_inbox', roomAgentId: 'agent-a' })
    expect(result.phase).toBe('failed')
    expect(resolverCalls).toBeGreaterThanOrEqual(2)
    expect(existsSync(oldDestination)).toBe(false)
    expect(existsSync(newDestination)).toBe(false)
    expect(existsSync(temporaryPath!)).toBe(false)
  })

  test('最终 rename 前 Agent 归档时仍清理私有临时文件', async () => {
    const root = makeRoot()
    const destination = join(root, 'inbox', 'attachment.bin')
    mkdirSync(dirname(destination), { recursive: true })
    let resolverCalls = 0
    let temporaryPath: string | undefined
    const service = createChatRoomCosService(baseOptions({
      resolveAgentInboxPath: () => {
        resolverCalls++
        if (resolverCalls >= 5) throw new Error('agent_archived_before_rename')
        return destination
      },
      sdkFactory: () => ({
        sliceUploadFile: async () => ({ ETag: 'etag' }), abortUploadTask: async () => ({}), cancelTask: () => {},
        downloadFile: async (params) => {
          temporaryPath = params.FilePath
          writeFileSync(params.FilePath, 'private payload')
          return { ETag: 'etag' }
        },
      }),
    }))
    const result = await service.download({ transferId: 'rename-aba', roomId: 'r-1', attachmentId: 'att-1', target: 'agent_inbox', roomAgentId: 'agent-a' })
    expect(result.phase).toBe('failed')
    expect(resolverCalls).toBe(5)
    expect(existsSync(destination)).toBe(false)
    expect(existsSync(temporaryPath!)).toBe(false)
  })

  test('下载目标或父目录为 symlink 时 fail closed，不调用 SDK 且不覆盖外部文件', async () => {
    const root = makeRoot()
    const outside = join(root, 'outside')
    mkdirSync(outside)
    const outsideFile = join(outside, 'secret.txt')
    writeFileSync(outsideFile, 'keep')
    const symlinkTarget = join(root, 'link-file.txt')
    symlinkSync(outsideFile, symlinkTarget)
    const outsideDir = join(root, 'outside-dir')
    mkdirSync(outsideDir)
    const symlinkParent = join(root, 'link-dir')
    symlinkSync(outsideDir, symlinkParent)
    let sdkCalls = 0
    const service = createChatRoomCosService(baseOptions({
      sdkFactory: () => {
        sdkCalls++
        return { sliceUploadFile: async () => ({ ETag: 'etag' }), abortUploadTask: async () => ({}), cancelTask: () => {}, downloadFile: async () => ({ ETag: 'etag' }) }
      },
    }))
    expect((await service.download({ transferId: 'symlink-leaf', roomId: 'r-1', attachmentId: 'att-1', target: 'user', destinationPath: symlinkTarget })).phase).toBe('failed')
    expect((await service.download({ transferId: 'symlink-parent', roomId: 'r-1', attachmentId: 'att-1', target: 'user', destinationPath: join(symlinkParent, 'new.txt') })).phase).toBe('failed')
    expect(sdkCalls).toBe(0)
    expect(readFileSync(outsideFile, 'utf8')).toBe('keep')
  })

  test('STS 和 objectKey 不出现在进度、结果、错误和日志', async () => {
    const seen: unknown[] = []
    const root = makeRoot()
    const filePath = join(root, 'a.txt')
    writeFileSync(filePath, 'x')
    const service = createChatRoomCosService(baseOptions({
      logger: (value) => seen.push(value),
      fileDialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [filePath] }), showSaveDialog: async () => ({ canceled: true }) },
      sdkFactory: () => ({ sliceUploadFile: async () => { throw new Error('secret-key objectKey') }, abortUploadTask: async () => ({}), cancelTask: () => {}, downloadFile: async () => ({ ETag: 'e' }) }),
    }))
    const result = await service.selectAndUpload({ transferId: 't-error', roomId: 'r-1' })
    expect(result.phase).toBe('failed')
    expect(JSON.stringify(result)).not.toMatch(/secret-key|objectKey|rooms\/r1/)
    expect(JSON.stringify(seen)).not.toMatch(/secret-key|objectKey|rooms\/r1/)
  })
})
