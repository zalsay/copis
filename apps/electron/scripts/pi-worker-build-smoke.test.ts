import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyCompiledPiWorker } from './pi-worker-build-smoke'

let fixtureRoot: string
let workerFile: string

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'copis-worker-smoke-test-'))
  workerFile = join(fixtureRoot, 'worker.ts')
  writeFileSync(workerFile, `
import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'
const mode = process.argv[2]
// Rust 启动的 Worker 会一直保留 stdin；提前 EOF 会使运行中止。
process.stdin.on('end', () => { if (mode !== 'ignore-stop') process.exit(2) })
createInterface({ input: process.stdin }).once('line', async line => {
  const { config } = JSON.parse(line)
  if (mode === 'no-request') process.exit(0)
  if (mode === 'ignore-stop') {
    process.on('SIGTERM', () => {})
    writeFileSync(process.argv[3], JSON.stringify({ pid: process.pid, cwd: process.cwd() }))
    setInterval(() => {}, 1000)
    return
  }
  const names = [
    'ChromeDesktopStart', 'ChromeDesktopObserve', 'ChromeDesktopClick',
    'ChromeDesktopScroll', 'ChromeDesktopType', 'ChromeDesktopPress', 'ChromeDesktopStop',
  ]
  if (mode === 'missing-tool') names.splice(names.indexOf('ChromeDesktopClick'), 1)
  await fetch(config.query.baseUrl + '/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tools: names.map(name => ({ type: 'function', function: { name } })) }),
  })
  process.exit(0)
})
`)
})

afterEach(() => rmSync(fixtureRoot, { recursive: true, force: true }))

describe('自包含 Pi Worker 构建 smoke', () => {
  test('Given Worker 仅通过 run 配置接收 capability When 模型请求包含 7 个 Chrome 工具 Then smoke 通过且不提前关闭 stdin', async () => {
    await verifyCompiledPiWorker(process.execPath, [workerFile, 'complete'])
  })

  test('Given Worker 能启动但未注册 Click When 模型请求到达 Then 构建失败并列出缺失工具', async () => {
    await expect(verifyCompiledPiWorker(process.execPath, [workerFile, 'missing-tool']))
      .rejects.toThrow('ChromeDesktopClick')
  })

  test('Given Worker 超时且忽略终止信号 When smoke 失败 Then 强制终止并等待退出后清理临时目录', async () => {
    const stateFile = join(fixtureRoot, 'worker-state.json')
    let pid: number | undefined
    try {
      await expect(verifyCompiledPiWorker(process.execPath, [workerFile, 'ignore-stop', stateFile], 1000))
        .rejects.toThrow('超时')
      const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { pid: number; cwd: string }
      pid = state.pid
      expect(existsSync(state.cwd)).toBe(false)
      expect(() => process.kill(state.pid, 0)).toThrow()
    } finally {
      // 红灯阶段也不让复现进程泄漏到后续测试。
      if (!pid && existsSync(stateFile)) pid = JSON.parse(readFileSync(stateFile, 'utf8')).pid
      if (pid) { try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ } }
    }
  }, 5000)

  test('Given 二进制无法启动 When smoke 检查 Then 及时失败并回收 fixture', async () => {
    await expect(verifyCompiledPiWorker(join(fixtureRoot, 'missing-worker'))).rejects.toThrow('ENOENT')
  })

  test('Given Worker 未向模型发出请求便正常退出 When 检查产物 Then 不得误判为 smoke 成功', async () => {
    await expect(verifyCompiledPiWorker(process.execPath, [workerFile, 'no-request']))
      .rejects.toThrow('未向本机模型 fixture 发送请求')
  })
})
