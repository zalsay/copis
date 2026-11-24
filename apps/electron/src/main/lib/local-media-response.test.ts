import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createLocalMediaResponse } from './local-media-response'

let dir: string
let file: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'copis-media-')); file = join(dir, '中文 sample.MP4'); writeFileSync(file, '0123456789') })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const request = (headers: Record<string, string> = {}, method = 'GET') => new Request('copis-file://test', { headers, method })

test('Given MP4 文件 When 普通 GET Then 按流返回视频 MIME 和完整长度', async () => {
  const r = (await createLocalMediaResponse(request(), file))!
  expect(r.status).toBe(200)
  expect(r.headers.get('content-type')).toBe('video/mp4')
  expect(r.headers.get('accept-ranges')).toBe('bytes')
  expect(r.headers.get('content-length')).toBe('10')
  expect(await r.text()).toBe('0123456789')
})
for (const [range, expected, contentRange] of [['bytes=2-5', '2345', 'bytes 2-5/10'], ['bytes=7-', '789', 'bytes 7-9/10'], ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=8-99', '89', 'bytes 8-9/10'], ['bytes=-99', '0123456789', 'bytes 0-9/10']] as const) {
  test(`Given 有效单区间 ${range} When 请求媒体 Then 返回精确 206 字节段`, async () => {
    const r = (await createLocalMediaResponse(request({ Range: range }), file))!
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe(contentRange)
    expect(r.headers.get('content-length')).toBe(String(expected.length))
    expect(await r.text()).toBe(expected)
  })
}
for (const range of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=0-1,4-5', 'items=0-1', 'bytes=9007199254740992-', 'bytes=-']) {
  test(`Given 无效区间 ${range} When 请求媒体 Then 返回 416 而不读取整文件`, async () => {
    const r = (await createLocalMediaResponse(request({ Range: range }), file))!
    expect(r.status).toBe(416)
    expect(r.headers.get('content-range')).toBe('bytes */10')
    expect(r.body).toBeNull()
  })
}
test('Given HEAD 和 MP3 When 获取元数据 Then 无响应体且 MIME 正确', async () => {
  const mp3 = join(dir, '试听.mp3'); writeFileSync(mp3, 'audio')
  const r = (await createLocalMediaResponse(request({ Range: 'bytes=1-2' }, 'HEAD'), mp3))!
  expect(r.status).toBe(200)
  expect(r.headers.get('content-type')).toBe('audio/mpeg')
  expect(r.headers.get('content-length')).toBe('5')
  expect(r.body).toBeNull()
})
test('Given 空媒体文件或文件消失 When 请求 Then 不产生无效流或未处理异常', async () => {
  writeFileSync(file, '')
  const empty = (await createLocalMediaResponse(request(), file))!
  expect(empty.status).toBe(200); expect(await empty.text()).toBe('')
  const ranged = (await createLocalMediaResponse(request({ Range: 'bytes=0-' }), file))!
  expect(ranged.status).toBe(416)
  rmSync(file)
  expect((await createLocalMediaResponse(request(), file))!.status).toBe(404)
})
test('Given 非媒体文件或不允许的方法 When 处理 Then 保留既有非媒体路径且拒绝写操作', async () => {
  expect(await createLocalMediaResponse(request(), join(dir, 'index.html'))).toBeUndefined()
  expect((await createLocalMediaResponse(request({}, 'POST'), file))!.status).toBe(405)
})

test('Given 大文件流适配到 Web stream When 建立背压 Then 按字节而非 chunk 个数限制队列', async () => {
  const original = Readable.toWeb
  let captured: Parameters<typeof Readable.toWeb>[1]
  Readable.toWeb = (stream, options) => { captured = options; return original(stream, options) }
  try {
    const r = (await createLocalMediaResponse(request(), file))!
    await r.body?.cancel()
    expect(captured?.strategy?.highWaterMark).toBe(64 * 1024)
    expect(captured?.strategy?.size?.(new Uint8Array(37))).toBe(37)
  } finally { Readable.toWeb = original }
})
