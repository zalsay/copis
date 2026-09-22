import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }))
mock.module('./http-api-server', () => ({ HTTP_API_HOST: '127.0.0.1', HTTP_API_PORT: 51730, getHttpApiInternalToken: () => 'test-token' }))

const {
  createChatRoomCosService,
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
    expect(aborted).toEqual({ UploadId: 'task-cancel', Bucket: 'bucket-1', Region: 'ap-shanghai', Key: 'rooms/r1/att-1/a.txt', Level: 'task' })
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
    expect(sdkParams).toMatchObject({ Bucket: 'bucket-1', Region: 'ap-shanghai', Key: 'rooms/r1/att-1/a.txt', FilePath: destination })
    expect(result).toEqual({ transferId: 't-download', attachmentId: 'att-1', phase: 'ready' })
    expect(JSON.stringify(result)).not.toContain('objectKey')
  })

  test('下载到 Agent inbox 只解析绑定房间的隔离目录', async () => {
    const root = makeRoot()
    const inbox = join(root, 'room-r1', 'agent-a', 'inbox', 'file.txt')
    let requestedRoom: string | undefined
    let destination: string | undefined
    const service = createChatRoomCosService(baseOptions({
      fileDialog: { showOpenDialog: async () => ({ canceled: true }), showSaveDialog: async () => ({ canceled: true }) },
      resolveAgentInboxPath: (roomId) => { requestedRoom = roomId; return inbox },
      sdkFactory: () => ({
        sliceUploadFile: async () => ({ ETag: 'etag' }), abortUploadTask: async () => ({}), cancelTask: () => {},
        downloadFile: async (params) => { destination = params.FilePath; return { ETag: 'etag' } },
      }),
    }))
    await service.download({ transferId: 't-inbox', roomId: 'r-1', attachmentId: 'att-1', target: 'agent_inbox', destinationPath: join(root, 'attacker.txt') })
    expect(requestedRoom).toBe('r-1')
    expect(destination).toBe(inbox)
    expect(destination).not.toContain('attacker.txt')
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
