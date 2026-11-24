import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, truncateSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
mock.module('electron', () => ({ net: { fetch: async () => new Response('unused') } }))
const { prepareDshMediaPreview } = await import('./dsh-media-service')
const { revokeCopisFileUrl, handleCopisFileRequest } = await import('./local-file-protocol')
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'copis-dsh-media-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('Given 中文 MP3 或 MP4 绝对路径 When 主进程准备预览 Then 返回类型和不透明单文件 URL', () => {
  for (const [name, kind, mimeType] of [['试听.mp3', 'audio', 'audio/mpeg'], ['sample.MP4', 'video', 'video/mp4']]) {
    const path = join(dir, name!); writeFileSync(path, 'data')
    const r = prepareDshMediaPreview(path, 31)
    expect(r).toMatchObject({ success: true, kind, mimeType })
    if (r.success) { expect(r.url).toMatch(/^copis-file:\/\/[a-f0-9-]+$/); expect(r.url).not.toContain(dir); revokeCopisFileUrl(r.url, 31) }
  }
})
test('Given 大于文本和图片预览上限的媒体 When 准备 Then 不读取整文件且允许流式预览', async () => {
  const path = join(dir, 'large.mp4'); writeFileSync(path, ''); truncateSync(path, 64*1024*1024)
  const r = prepareDshMediaPreview(path, 32)
  expect(r.success).toBe(true)
  if (r.success) {
    const response = await handleCopisFileRequest(new Request(r.url, { headers: { Range: 'bytes=0-3' } }))
    expect(response.status).toBe(206); expect((await response.arrayBuffer()).byteLength).toBe(4); revokeCopisFileUrl(r.url, 32)
  }
})
test('Given 空路径、相对路径、目录、文件缺失或非媒体扩展 When 准备 Then 不发放文件令牌', () => {
  const text = join(dir, 'secret.txt'); writeFileSync(text, 'private')
  const folder = join(dir, 'folder.mp4'); mkdirSync(folder)
  for (const path of ['', 'relative.mp4', dir, folder, join(dir, 'gone.mp3'), text]) expect(prepareDshMediaPreview(path, 33).success).toBe(false)
})

test('Given mp4 名称的符号链接指向非媒体文件 When 准备 Then 按真实目标拒绝而不是发放文本文件令牌', () => {
  const path = join(dir, 'secret.txt'); writeFileSync(path, 'not media')
  const alias = join(dir, 'alias.mp4'); symlinkSync(path, alias)
  expect(prepareDshMediaPreview(alias, 34).success).toBe(false)
})
