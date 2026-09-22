import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createChatRoomCosService, isChatRoomCosSensitiveText } from './chatroom-cos-service'

const repoRoot = join(import.meta.dir, '../../../../../')
const electronPackage = JSON.parse(readFileSync(join(repoRoot, 'apps/electron/package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  scripts?: Record<string, string>
}
const builder = readFileSync(join(repoRoot, 'apps/electron/electron-builder.yml'), 'utf8')
const rootPackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  devDependencies?: Record<string, string>
  scripts?: Record<string, string>
}

describe('聊天室 COS Electron runtime 边界', () => {
  test('Electron runtime 保留固定版本 SDK，发布脚本仍归根目录', () => {
    expect(electronPackage.dependencies?.['cos-nodejs-sdk-v5']).toBe('3.0.0')
    expect(builder).not.toContain('!node_modules/cos-nodejs-sdk-v5/**')
    expect(electronPackage.scripts?.['publish:functional-modules']).toBeUndefined()
    expect(rootPackage.devDependencies?.['cos-nodejs-sdk-v5']).toBe('3.0.0')
    expect(rootPackage.scripts?.['publish:functional-modules']).toBeDefined()
  })

  test('实际上传和下载调用只向 SDK 传 grant，Renderer 只收到脱敏结果与进度', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-chatroom-boundary-'))
    const sourcePath = join(root, '报告.txt')
    const destinationPath = join(root, '下载.txt')
    writeFileSync(sourcePath, '聊天室附件')
    const credentials: Array<Record<string, string>> = []
    const sdkKeys: string[] = []
    const publicStates: unknown[] = []
    const logs: string[] = []
    const grant = (action: 'upload' | 'download') => ({ attachmentId: 'att-1', bucket: 'private-bucket', region: 'ap-shanghai', objectKey: 'private/att-1', tmpSecretId: 'short-id', tmpSecretKey: 'short-key', sessionToken: 'short-session', startTime: Math.floor(Date.now() / 1000) - 1, expiredTime: Math.floor(Date.now() / 1000) + 300, action })
    const service = createChatRoomCosService({
      fileDialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [sourcePath] }), showSaveDialog: async () => ({ canceled: false, filePath: destinationPath }) },
      grantClient: {
        requestUploadGrant: async () => grant('upload'),
        requestDownloadGrant: async () => grant('download'),
        finalizeUpload: async () => undefined,
      },
      sdkFactory: (input) => {
        credentials.push(input)
        return {
          sliceUploadFile: async (params) => { sdkKeys.push(params.Key); params.onTaskReady?.('upload-task'); params.onProgress?.({ loaded: 10, total: 10, speed: 1, percent: 1 }); return { ETag: 'etag-1' } },
          abortUploadTask: async () => undefined,
          cancelTask: () => undefined,
          downloadFile: async (params) => { sdkKeys.push(params.Key); writeFileSync(params.FilePath, '下载内容'); params.onProgress?.({ loaded: 4, total: 4, speed: 1, percent: 1 }); return { ETag: 'etag-2' } },
        }
      },
      logger: (event) => logs.push(event),
    })
    const off = service.onProgress((state) => publicStates.push(state))
    try {
      const upload = await service.selectAndUpload({ transferId: 'upload-1', roomId: 'room-1' })
      const download = await service.download({ transferId: 'download-1', roomId: 'room-1', attachmentId: 'att-1', target: 'user' })
      expect(upload).toEqual({ transferId: 'upload-1', attachmentId: 'att-1', originalName: '报告.txt', phase: 'ready' })
      expect(download).toEqual({ transferId: 'download-1', attachmentId: 'att-1', phase: 'ready' })
      expect(credentials).toEqual([
        { SecretId: 'short-id', SecretKey: 'short-key', SecurityToken: 'short-session' },
        { SecretId: 'short-id', SecretKey: 'short-key', SecurityToken: 'short-session' },
      ])
      expect(sdkKeys).toEqual(['private/att-1', 'private/att-1'])
      const publicText = JSON.stringify({ upload, download, publicStates, logs })
      expect(publicText).not.toContain('short-id')
      expect(publicText).not.toContain('short-key')
      expect(publicText).not.toContain('short-session')
      expect(publicText).not.toContain('private/att-1')
      expect(publicStates.every((state) => {
        const text = JSON.stringify(state)
        return !text.includes('short-id') && !text.includes('short-key') && !text.includes('short-session') && !text.includes('private/att-1')
      })).toBe(true)
    } finally {
      off()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('敏感凭据和 object key 仍被 Main 边界识别，不能进入公开事件', () => {
    for (const value of ['tmpSecretId', 'tmpSecretKey', 'sessionToken', 'objectKey', 'Authorization']) {
      expect(isChatRoomCosSensitiveText(value)).toBe(true)
    }
  })
})
