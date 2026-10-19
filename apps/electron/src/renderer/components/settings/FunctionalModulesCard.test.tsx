import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { parseHTML } from 'linkedom'
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import type { FunctionalModuleProgressPayload, FunctionalModuleStatus } from '@copis/shared'
import { functionalModuleBusyAtom, functionalModuleProgressAtom, functionalModuleStatusesAtom } from '@/atoms/functional-modules'
import { FunctionalModulesCard } from './FunctionalModulesCard'

const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
const chrome: FunctionalModuleStatus = {
  name: 'chrome-desktop-cli', displayName: 'Chrome 桌面自动化', installed: false,
  version: null, path: null, availableVersion: null, updateAvailable: false, required: false, error: null,
}
const globals = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator }
let root: Root | null = null
let store: ReturnType<typeof createStore>
let modules: FunctionalModuleStatus[]
let onProgress: (progress: FunctionalModuleProgressPayload) => void
let resolveInstall: (status: FunctionalModuleStatus) => void
let api: ReturnType<typeof createApi>

function createApi() {
  return {
    listFunctionalModules: mock(async () => modules),
    onFunctionalModuleProgress: mock((callback: typeof onProgress) => { onProgress = callback; return () => {} }),
    installFunctionalModule: mock((_input: unknown) => new Promise<FunctionalModuleStatus>(resolve => { resolveInstall = resolve })),
    checkFunctionalModule: mock(async (_name: unknown): Promise<FunctionalModuleStatus> => ({ ...chrome, installed: true, version: '0.1.0', availableVersion: '0.2.0', updateAvailable: true })),
  }
}

beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, { window, document: window.document, navigator: { platform: 'MacIntel' }, IS_REACT_ACT_ENVIRONMENT: true })
  store = createStore()
  modules = [chrome]
  api = createApi()
  window.electronAPI = api as any
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = null
  Object.assign(globalThis, globals)
})

async function renderCard() {
  root = createRoot(document.getElementById('root')!)
  await act(async () => { root?.render(<Provider store={store}><FunctionalModulesCard /></Provider>) })
}

function chromeRow() {
  const title = [...document.querySelectorAll('h4')].find(item => item.textContent === 'Chrome 桌面自动化')
  return title?.closest('.rounded-lg') ?? null
}

async function clickChromeAction(label: string) {
  const button = [...chromeRow()!.querySelectorAll('button')].find(item => item.textContent?.includes(label))
  expect(button).toBeDefined()
  await act(async () => { button!.click() })
}

describe('功能模块设置复用现有 Chrome 安装与更新交互', () => {
  test('Given macOS 主进程未返回 Chrome 模块 When 载入列表 Then 不展示缓存残留的 Chrome 卡片', async () => {
    modules = []
    store.set(functionalModuleStatusesAtom, { 'chrome-desktop-cli': chrome })
    await renderCard()
    expect(chromeRow() === null).toBe(true)
  })

  for (const platform of ['Win32', 'Linux x86_64']) {
    test(`Given ${platform} When 主进程或缓存包含 Chrome 状态 Then 不展示 macOS 模块`, async () => {
      Object.assign(globalThis, { navigator: { platform } })
      await renderCard()
      expect(chromeRow() === null).toBe(true)
    })
  }

  test('Given macOS 未安装 Chrome 组件 When 点击安装并收到进度 Then 使用 Jotai 展示下载进度及安装结果', async () => {
    await renderCard()
    expect(chromeRow() !== null).toBe(true)
    expect(chromeRow()!.textContent).not.toContain('必需')
    await clickChromeAction('安装')
    expect(api.installFunctionalModule).toHaveBeenCalledWith({ name: 'chrome-desktop-cli' })
    expect(store.get(functionalModuleBusyAtom)['chrome-desktop-cli']).toBe(true)
    await act(async () => {
      onProgress({ name: 'chrome-desktop-cli', phase: 'download', detail: '下载', progress: 0.42 })
    })
    expect(store.get(functionalModuleProgressAtom)['chrome-desktop-cli']?.progress).toBe(0.42)
    expect(chromeRow()!.textContent).toContain('42%')
    expect(chromeRow()!.textContent).toContain('正在下载更新')
    await act(async () => { resolveInstall({ ...chrome, installed: true, version: '0.1.0' }) })
    expect(store.get(functionalModuleBusyAtom)['chrome-desktop-cli']).toBe(false)
    expect(chromeRow()!.textContent).toContain('已准备好（v0.1.0）')
    expect(chromeRow()!.textContent).toContain('检查更新')
  })

  test('Given 本地能力含已占用组件 When 点击检查全部 Then 跳过繁忙项、逐项检查且单项失败不阻止其他检查', async () => {
    const resolvePendingChecks: Array<(status: FunctionalModuleStatus) => void> = []
    api.checkFunctionalModule.mockImplementation(async (name: unknown) => {
      if (name === 'node-runtime' || name === 'chrome-desktop-cli') {
        return await new Promise<FunctionalModuleStatus>(resolve => { resolvePendingChecks.push(resolve) })
      }
      if (name === 'agently-cli') throw new Error('清单暂不可用')
      return { ...chrome, name: name as string, installed: true, version: '1.0.0', availableVersion: '1.1.0', updateAvailable: true }
    })
    store.set(functionalModuleBusyAtom, { 'codex-cli': true })
    await renderCard()

    const checkAll = [...document.querySelectorAll('button')].find(item => item.textContent?.includes('检查全部组件更新'))
    expect(checkAll).toBeDefined()
    await act(async () => { checkAll!.click() })

    expect(api.checkFunctionalModule).toHaveBeenCalled()
    expect(api.checkFunctionalModule.mock.calls.map(([name]) => name)).not.toContain('codex-cli')
    expect(api.installFunctionalModule).not.toHaveBeenCalled()
    expect(checkAll!.hasAttribute('disabled')).toBe(true)
    const checksStarted = api.checkFunctionalModule.mock.calls.length
    await act(async () => { checkAll!.click() })
    expect(api.checkFunctionalModule.mock.calls).toHaveLength(checksStarted)
    expect(store.get(functionalModuleBusyAtom)['node-runtime']).toBe(true)
    expect(store.get(functionalModuleBusyAtom)['chrome-desktop-cli']).toBe(true)

    await act(async () => {
      resolvePendingChecks.forEach((resolve, index) => resolve({
        ...chrome, name: index === 0 ? 'node-runtime' : 'chrome-desktop-cli', installed: true, version: '1.0.0',
        ...(index === 1 ? { availableVersion: '1.1.0', updateAvailable: true } : {}),
      }))
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    expect(store.get(functionalModuleBusyAtom)['node-runtime']).toBe(false)
    expect(store.get(functionalModuleBusyAtom)['agently-cli']).toBe(false)
    expect(store.get(functionalModuleStatusesAtom)['agently-cli']?.error).toBe('清单暂不可用')
    expect(store.get(functionalModuleStatusesAtom)['chrome-desktop-cli']?.availableVersion).toBe('1.1.0')
    expect(checkAll!.hasAttribute('disabled')).toBe(false)
  })

  test('Given 批量检查仍在进行 When 离开后重进关于页 Then 保留批量忙碌状态且不重复检查', async () => {
    let finish!: (status: FunctionalModuleStatus) => void
    api.checkFunctionalModule.mockImplementation(async (name: unknown) => {
      if (name === 'chrome-desktop-cli') return await new Promise<FunctionalModuleStatus>(resolve => { finish = resolve })
      return { ...chrome, name: name as string }
    })
    await renderCard()
    const first = [...document.querySelectorAll('button')].find(item => item.textContent?.includes('检查全部组件更新'))!
    await act(async () => { first.click() })
    const started = api.checkFunctionalModule.mock.calls.length
    await act(async () => { root?.unmount() })
    root = null
    await renderCard()
    const again = [...document.querySelectorAll('button')].find(item => item.textContent?.includes('检查全部组件更新'))!
    expect(again.hasAttribute('disabled')).toBe(true)
    await act(async () => { again.click() })
    expect(api.checkFunctionalModule.mock.calls).toHaveLength(started)
    await act(async () => { finish(chrome) })
    expect(again.hasAttribute('disabled')).toBe(false)
  })

  test('Given 已安装 Chrome 组件 When 检查更新并安装新版 Then 保留现有更新操作与版本展示', async () => {
    modules = [{ ...chrome, installed: true, version: '0.1.0' }]
    await renderCard()
    await clickChromeAction('检查更新')
    expect(api.checkFunctionalModule).toHaveBeenCalledWith('chrome-desktop-cli')
    expect(chromeRow()!.textContent).toContain('可更新至 v0.2.0')
    await clickChromeAction('更新')
    await act(async () => { resolveInstall({ ...chrome, installed: true, version: '0.2.0' }) })
    expect(chromeRow()!.textContent).toContain('已准备好（v0.2.0）')
  })
})
