import { describe, expect, test } from 'bun:test'
import { resolvePiWorkerLaunch, resolvePiWorkerRuntime } from './pi-worker-launch'

describe('Pi Worker 启动入口', () => {
  test('Given 打包版 Copis When 定位 Worker Then 使用自包含 CLI 二进制', () => {
    expect(resolvePiWorkerLaunch({
      isPackaged: true,
      bundledCliPath: 'C:\\Program Files\\Copis\\resources\\bin\\win32-x64\\copis.exe',
      developmentCandidates: [],
      exists: () => true,
    })).toEqual({
      kind: 'executable',
      path: 'C:\\Program Files\\Copis\\resources\\bin\\win32-x64\\copis.exe',
    })
  })

  test('Given 开发模式 When 定位 Worker Then 保留 Node.js 脚本入口', () => {
    expect(resolvePiWorkerLaunch({
      isPackaged: false,
      developmentCandidates: ['/repo/apps/electron/dist/pi-rpc-worker.cjs'],
      exists: (path) => path.endsWith('pi-rpc-worker.cjs'),
    })).toEqual({
      kind: 'script',
      path: '/repo/apps/electron/dist/pi-rpc-worker.cjs',
    })
  })

  test('Given 开发模式有 Bun When 选择 Worker runtime Then 使用 Bun 执行脚本', () => {
    expect(resolvePiWorkerRuntime({
      isPackaged: false,
      bunPath: '/Users/test/.bun/bin/bun',
    })).toEqual({
      path: '/Users/test/.bun/bin/bun',
      useSystemRuntime: true,
    })
  })

  test('Given 打包模式 When 选择 Worker runtime Then 不覆盖自包含二进制', () => {
    expect(resolvePiWorkerRuntime({
      isPackaged: true,
      bunPath: '/Users/test/.bun/bin/bun',
    })).toBeUndefined()
  })
})
