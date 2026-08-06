import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Channel, FileAttachment } from '@copis/shared'
import type { ImageAttachmentData, ProviderRequest, StreamRequestInput } from '@copis/core'

interface CapturedImage {
  attachment: FileAttachment
  image: ImageAttachmentData
}

const channel: Channel = {
  id: 'vision-channel',
  name: '视觉模型',
  provider: 'openai',
  baseUrl: 'https://vision.example.test/v1',
  apiKey: 'encrypted',
  models: [{ id: 'vision-model', name: 'Vision Model', enabled: true }],
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
}

const capturedImages: CapturedImage[] = []
let providerCalls = 0

mock.module('@copis/core', () => ({
  getAdapter: () => ({
    buildStreamRequest: (input: StreamRequestInput): ProviderRequest => {
      providerCalls++
      const attachment = input.attachments?.[0]
      const image = input.readImageAttachments(input.attachments)[0]
      if (!attachment || !image) throw new Error('视觉助手请求缺少图片')
      capturedImages.push({ attachment, image })
      return { url: 'https://vision.example.test/stream', headers: {}, body: '{}' }
    },
  }),
  streamSSE: async () => ({
    content: '{"answer":"ok","observations":[],"limitations":[]}',
    reasoning: '',
    thinkingBlocks: [],
    toolCalls: [],
  }),
}))

mock.module('./channel-manager', () => ({
  getChannelById: (channelId: string) => channelId === channel.id ? channel : undefined,
  resolveChannelRuntimeApiKey: async () => 'vision-api-key',
}))

mock.module('./settings-service', () => ({
  getSettings: () => ({
    visionRelay: { enabled: true, channelId: channel.id, modelId: 'vision-model' },
  }),
}))

mock.module('./proxy-fetch', () => ({
  getFetchFn: () => fetch,
}))

mock.module('./proxy-settings-service', () => ({
  getEffectiveProxyUrl: async () => undefined,
}))

mock.module('./adapters/pi-model-registry', () => ({
  resolvePiImageInputCapability: async () => 'supported',
}))

let inspectImageWithVisionRelay: typeof import('./vision-relay-service').inspectImageWithVisionRelay
let tempDir = ''

beforeAll(async () => {
  ({ inspectImageWithVisionRelay } = await import('./vision-relay-service'))
})

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  tempDir = ''
  capturedImages.length = 0
  providerCalls = 0
})

function writeAuthorizedImage(filename: string, data: Buffer): string {
  tempDir = mkdtempSync(join(tmpdir(), 'copis-vision-relay-'))
  const imagePath = join(tempDir, filename)
  writeFileSync(imagePath, data)
  return imagePath
}

async function inspectAuthorizedImage(imagePath: string) {
  return inspectImageWithVisionRelay({ imagePath, allowedRoots: [tempDir] })
}

describe('Vision Relay 原图转发', () => {
  test('Given 已授权 PNG When 视觉助手外发 Then 保留原始文件名、MIME 和字节', async () => {
    const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWPgUbIAAACkAGfNzc0uAAAAAElFTkSuQmCC', 'base64')
    const imagePath = writeAuthorizedImage('diagram.png', data)

    expect(await inspectAuthorizedImage(imagePath)).toMatchObject({ ok: true })
    expect(capturedImages).toEqual([{
      attachment: expect.objectContaining({ filename: 'diagram.png', mediaType: 'image/png', size: data.length }),
      image: { mediaType: 'image/png', data: data.toString('base64') },
    }])
  })

  test('Given 已授权 JPEG When 视觉助手外发 Then 保留原始文件名、MIME 和字节', async () => {
    const data = Buffer.from('/9j/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAB//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AI7wDwF3/9k=', 'base64')
    const imagePath = writeAuthorizedImage('camera.jpeg', data)

    expect(await inspectAuthorizedImage(imagePath)).toMatchObject({ ok: true })
    expect(capturedImages).toEqual([{
      attachment: expect.objectContaining({ filename: 'camera.jpeg', mediaType: 'image/jpeg', size: data.length }),
      image: { mediaType: 'image/jpeg', data: data.toString('base64') },
    }])
  })

  for (const extension of ['gif', 'webp', 'bmp', 'svg']) {
    test(`Given ${extension.toUpperCase()} When 视觉助手外发 Then 拒绝未支持格式`, async () => {
      const imagePath = writeAuthorizedImage(`unsupported.${extension}`, Buffer.from('not-an-image'))

      expect(await inspectAuthorizedImage(imagePath)).toMatchObject({ ok: false, code: 'VISION_UNSUPPORTED_IMAGE' })
      expect(providerCalls).toBe(0)
    })
  }
})
