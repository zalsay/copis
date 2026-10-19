import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { parseHTML } from 'linkedom'
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import type { FunctionalModuleProgressPayload, FunctionalModuleStatus } from '@copis/shared'
import { functionalModuleBusyAtom, functionalModuleProgressAtom, functionalModuleStatusesAtom } from '@/atoms/functional-modules'
import { AboutUpdatesSettings } from './AboutUpdatesSettings'

const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
const chrome: FunctionalModuleStatus = {
  name: 'chrome-desktop-cli', displayName: 'Chrome 桌面自动化', installed: true,
  version: '1.0.0', path: '/local/chrome', availableVersion: null,
  updateAvailable: false, required: false, error: null,
}
const globals = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator }
let root: Root | null = null
let store: ReturnType<typeof createStore>
let onProgress: (progress: FunctionalModuleProgressPayload) => void
let resolveInstall!: (status: FunctionalModuleStatus) => void
let api: ReturnType<typeof createApi>

function createApi() {
  return {
    getAppInfo: mock(async () => ({ version: '1.0.0', packaged: false })),
    listFunctionalModules: mock(async () => [chrome]),
    onFunctionalModuleProgress: mock((callback: typeof onProgress) => { onProgress = callback; return () => {} }),
    checkFunctionalModule: mock(async (name: string) => ({
      ...chrome, name, availableVersion: '1.1.0', updateAvailable: true,
    })),
    installFunctionalModule: mock((_input: unknown) => new Promise<FunctionalModuleStatus>(resolve => { resolveInstall = resolve })),
  }
}

beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, { window, document: window.document, navigator: { platform: 'MacIntel' }, IS_REACT_ACT_ENVIRONMENT: true })
  store = createStore()
  api = createApi()
  window.electronAPI = api as any
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = null
  Object.assign(globalThis, globals)
})

async function renderAbout() {
  root = createRoot(document.getElementById('root')!)
  await act(async () => { root?.render(<Provider store={store}><AboutUpdatesSettings /></Provider>) })
}

function chromeRow() {
  return [...document.querySelectorAll('h4')]
    .find(item => item.textContent === 'Chrome 桌面自动化')?.closest('.rounded-lg') ?? null
}

async function clickWithin(element: Element, label: string) {
  const button = [...element.querySelectorAll('button')].find(item => item.textContent?.includes(label))
  expect(button).toBeDefined()
  await act(async () => { button!.click() })
}

describe('关于/更新页整合本地能力交互', () => {
  test('Given 关于页展示已安装 Chrome When 检查全部并安装更新 Then 页面联动显示版本、Jotai忙碌与下载进度', async () => {
    await renderAbout()
    expect(document.body.textContent).toContain('主程序和本地能力组件统一在此管理')
    expect(chromeRow()).not.toBeNull()

    const checkAll = [...document.querySelectorAll('button')].find(item => item.textContent?.includes('检查全部组件更新'))
    expect(checkAll).toBeDefined()
    await act(async () => { checkAll!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(api.checkFunctionalModule).toHaveBeenCalledWith('chrome-desktop-cli')
    expect(chromeRow()!.textContent).toContain('可更新至 v1.1.0')

    await clickWithin(chromeRow()!, '更新')
    expect(api.installFunctionalModule).toHaveBeenCalledWith({ name: 'chrome-desktop-cli' })
    expect(store.get(functionalModuleBusyAtom)['chrome-desktop-cli']).toBe(true)
    await act(async () => {
      onProgress({ name: 'chrome-desktop-cli', phase: 'download', detail: '正在下载', progress: 0.63 })
    })
    expect(store.get(functionalModuleProgressAtom)['chrome-desktop-cli']?.progress).toBe(0.63)
    expect(chromeRow()!.textContent).toContain('63%')
    expect(chromeRow()!.textContent).toContain('正在下载更新')

    await act(async () => { resolveInstall({ ...chrome, version: '1.1.0', availableVersion: null, updateAvailable: false }) })
    expect(store.get(functionalModuleBusyAtom)['chrome-desktop-cli']).toBe(false)
    expect(store.get(functionalModuleStatusesAtom)['chrome-desktop-cli']?.version).toBe('1.1.0')
    expect(chromeRow()!.textContent).toContain('已准备好（v1.1.0）')
  })
})
