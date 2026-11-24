import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const fetchFile = mock(async (_url: string) => new Response('legacy'))
mock.module('electron', () => ({ net: { fetch: fetchFile } }))
const { handleCopisFileRequest, registerCopisFilePath, registerCopisDirectoryPath, revokeCopisFileUrl, revokeCopisFilesForOwner } = await import('./local-file-protocol')
let dir: string
const now = Date.now
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'copis-protocol-')); fetchFile.mockClear() })
afterEach(() => { Date.now = now; rmSync(dir, { recursive: true, force: true }) })

test('Given 受管 MP4 token When Range 请求 Then 保持令牌鉴权并返回 206', async () => {
  const path = join(dir, '片段.mp4'); writeFileSync(path, '0123456789')
  const url = registerCopisFilePath(path, 7)
  expect(url).not.toContain('mp4')
  const r = await handleCopisFileRequest(new Request(url, { headers: { Range: 'bytes=3-6' } }))
  expect(r.status).toBe(206); expect(await r.text()).toBe('3456'); expect(fetchFile).not.toHaveBeenCalled()
  expect(revokeCopisFileUrl(url, 8)).toBe(false)
  expect(revokeCopisFileUrl(url, 7)).toBe(true)
  expect((await handleCopisFileRequest(new Request(url))).status).toBe(404)
})
test('Given owner 销毁 When 批量撤销 Then 只撤销该 owner 的文件', async () => {
  const path = join(dir, '试听.mp3'); writeFileSync(path, 'audio')
  const a = registerCopisFilePath(path, 11), b = registerCopisFilePath(path, 12)
  expect(revokeCopisFilesForOwner(11)).toBe(1)
  expect((await handleCopisFileRequest(new Request(a))).status).toBe(404)
  const r = await handleCopisFileRequest(new Request(b)); expect(r.status).toBe(200); await r.body?.cancel()
  revokeCopisFileUrl(b, 12)
})
test('Given 过期 token、伪造 URL 或文件 token 子路径 When 请求 Then 一律拒绝', async () => {
  const path = join(dir, 'a.mp3'); writeFileSync(path, 'audio'); const url = registerCopisFilePath(path, 13)
  expect(revokeCopisFileUrl(url.replace('copis-file:', 'https:'), 13)).toBe(false)
  expect((await handleCopisFileRequest(new Request(url+'/extra'))).status).toBe(404)
  const time = now(); Date.now = () => time + 3_600_001
  expect((await handleCopisFileRequest(new Request(url))).status).toBe(404)
})
test('Given 文件被换成符号链接或目录内存在越界链接 When 访问 Then 不泄露边界外内容', async () => {
  const root = join(dir, 'root'); mkdirSync(root)
  const outside = join(dir, 'outside.mp3'); writeFileSync(outside, 'outside')
  const path = join(root, 'a.mp3'); writeFileSync(path, 'selected')
  const fileUrl = registerCopisFilePath(path, 15); rmSync(path); symlinkSync(outside, path)
  expect((await handleCopisFileRequest(new Request(fileUrl))).status).toBe(403)
  const directoryUrl = registerCopisDirectoryPath(root)
  expect((await handleCopisFileRequest(new Request(directoryUrl+'/a.mp3'))).status).toBe(403)
})
test('Given 原有 HTML 文件预览 When 请求 Then 继续使用既有 Electron net.fetch', async () => {
  const path = join(dir, 'index.html'); writeFileSync(path, '<h1>test</h1>')
  const r = await handleCopisFileRequest(new Request(registerCopisFilePath(path)))
  expect(await r.text()).toBe('legacy'); expect(fetchFile).toHaveBeenCalledTimes(1)
})
