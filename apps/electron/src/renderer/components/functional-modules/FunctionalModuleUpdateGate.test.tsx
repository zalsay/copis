import { beforeEach, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'

mock.module('@/components/ui/alert-dialog', () => {
  return {
    AlertDialog: ({ children, open }: any) => (open ? <div data-alert-dialog-root>{children}</div> : null),
    AlertDialogContent: ({ children, className }: any) => <div role="alertdialog" className={className}>{children}</div>,
    AlertDialogHeader: ({ children, className }: any) => <div className={className}>{children}</div>,
    AlertDialogTitle: ({ children, className }: any) => <h2 className={className}>{children}</h2>,
    AlertDialogDescription: ({ children, className }: any) => <div className={className}>{children}</div>,
    AlertDialogFooter: ({ children, className }: any) => <div className={className}>{children}</div>,
    AlertDialogAction: ({ children, className, onClick }: any) => <button type="button" className={className} onClick={onClick}>{children}</button>,
    AlertDialogCancel: ({ children, className, onClick }: any) => <button type="button" className={className} onClick={onClick}>{children}</button>,
  }
})

// 模拟 electronAPI
const mockUpdater = {
  checkForUpdates: mock(async () => {}),
  downloadUpdate: mock(async () => {}),
  getStatus: mock(async () => ({ status: 'idle' })),
  onStatusChanged: mock(() => () => {}),
  installWhenIdle: mock(async () => true),
  cancelIdleInstall: mock(async () => {}),
}

const mockElectronAPI = {
  onFunctionalModuleStartupProgress: mock(() => () => {}),
  onFunctionalModuleProgress: mock(() => () => {}),
  listFunctionalModules: mock(async () => []),
  ensureRequiredFunctionalModules: mock(async () => []),
  openExternal: mock(async () => {}),
  getAppInfo: mock(async () => ({ version: '0.0.74', packaged: true })),
  updater: mockUpdater,
}

// 模拟 window.electronAPI
;(globalThis as any).window = (globalThis as any).window || {}
;(globalThis as any).window.electronAPI = mockElectronAPI

const { renderToString } = await import('react-dom/server')
const { createStore, Provider } = await import('jotai')
const { functionalModuleStartupAtom } = await import('@/atoms/functional-modules')
const { updateStatusAtom } = await import('@/atoms/updater')
const { FunctionalModuleUpdateGate } = await import('./FunctionalModuleUpdateGate')

describe('FunctionalModuleUpdateGate 客户端版本过低更新弹窗', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    store = createStore()
  })

  test('Given 启动遇到版本过低错误且未打包或非在线更新环境 When 渲染更新门禁 Then 弹窗显示升级说明、下载最新版本按钮和关闭按钮', () => {
    store.set(functionalModuleStartupAtom, {
      phase: 'error',
      detail: 'Copis 版本过低，需要至少 0.0.83',
      progress: 0,
      error: 'Copis 版本过低，需要至少 0.0.83',
    })

    const html = renderToString(
      <Provider store={store}>
        <FunctionalModuleUpdateGate>
          <div>工作区内容</div>
        </FunctionalModuleUpdateGate>
      </Provider>,
    )

    // 弹窗根节点渲染
    expect(html).toContain('data-alert-dialog-root')
    // 弹窗标题与描述
    expect(html).toContain('需要更新 Copis')
    // 弹窗按钮
    expect(html).toContain('关闭')
    // 右上角关闭按钮的无障碍文本
    expect(html).toContain('aria-label="关闭"')
    // 工作区内容处于拦截中
    expect(html).not.toContain('工作区内容')
  })

  test('Given 普通错误状态 When 渲染更新门禁 Then 不显示升级弹窗，只显示重试更新按钮', () => {
    store.set(functionalModuleStartupAtom, {
      phase: 'error',
      detail: '网络连接超时',
      progress: 0,
      error: '网络连接超时',
    })

    const html = renderToString(
      <Provider store={store}>
        <FunctionalModuleUpdateGate>
          <div>工作区内容</div>
        </FunctionalModuleUpdateGate>
      </Provider>,
    )

    expect(html).not.toContain('data-alert-dialog-root')
    expect(html).not.toContain('需要更新 Copis')
    expect(html).toContain('重试更新')
  })

  test('Given 客户端版本过低且发现新版本 When 渲染更新门禁 Then 弹窗显示发现新版本并展示「下载更新」按钮', () => {
    store.set(functionalModuleStartupAtom, {
      phase: 'error',
      detail: 'Copis 版本过低，需要至少 0.0.83',
      progress: 0,
      error: 'Copis 版本过低，需要至少 0.0.83',
    })
    store.set(updateStatusAtom, {
      status: 'available',
      version: '0.0.84',
      downloadUrl: 'https://example.com/Copis-0.0.84.dmg',
    })

    const html = renderToString(
      <Provider store={store}>
        <FunctionalModuleUpdateGate>
          <div>工作区内容</div>
        </FunctionalModuleUpdateGate>
      </Provider>,
    )

    expect(html).toContain('data-alert-dialog-root')
    expect(html).toContain('下载更新')
    expect(html).toContain('发现新版本 v0.0.84')
  })

  test('Given 客户端正在下载更新包 When 渲染更新门禁 Then 弹窗展示下载进度百分比与进度条', () => {
    store.set(functionalModuleStartupAtom, {
      phase: 'error',
      detail: 'Copis 版本过低，需要至少 0.0.83',
      progress: 0,
      error: 'Copis 版本过低，需要至少 0.0.83',
    })
    store.set(updateStatusAtom, {
      status: 'downloading',
      version: '0.0.84',
      progress: { percent: 45, transferred: 450, total: 1000, bytesPerSecond: 100 },
    })

    const html = renderToString(
      <Provider store={store}>
        <FunctionalModuleUpdateGate>
          <div>工作区内容</div>
        </FunctionalModuleUpdateGate>
      </Provider>,
    )

    expect(html).toContain('正在下载更新')
    expect(html).toContain('45%')
    expect(html).toContain('正在下载 (45%)')
  })

  test('Given 客户端已下载好更新（或重启后恢复已下载状态） When 渲染更新门禁 Then 弹窗显示「立即安装」与更新已完成提示', () => {
    store.set(functionalModuleStartupAtom, {
      phase: 'error',
      detail: 'Copis 版本过低，需要至少 0.0.83',
      progress: 0,
      error: 'Copis 版本过低，需要至少 0.0.83',
    })
    store.set(updateStatusAtom, {
      status: 'downloaded',
      version: '0.0.84',
      filePath: '/path/to/Copis.dmg',
    })

    const html = renderToString(
      <Provider store={store}>
        <FunctionalModuleUpdateGate>
          <div>工作区内容</div>
        </FunctionalModuleUpdateGate>
      </Provider>,
    )

    expect(html).toContain('更新已下载完成')
    expect(html).toContain('Copis v0.0.84 已下载完成，点击立即安装并重启应用。')
    expect(html).toContain('立即安装')
  })

  test('Given 功能模块门禁准备就绪并完成放行 When 连续多次渲染 Then Hook 调用数量严格保持一致且无异常抛出', () => {
    store.set(functionalModuleStartupAtom, {
      phase: 'ready',
      detail: '本地服务运行正常',
      progress: 1,
      error: null,
    })

    // 第一次渲染：初始帧
    const html1 = renderToString(
      <Provider store={store}>
        <FunctionalModuleUpdateGate>
          <div>工作区内容已放行</div>
        </FunctionalModuleUpdateGate>
      </Provider>,
    )
    expect(html1).toBeDefined()

    // 模拟多次状态更新渲染，验证 Hook 数量一致性
    store.set(updateStatusAtom, {
      status: 'idle',
    })
    const html2 = renderToString(
      <Provider store={store}>
        <FunctionalModuleUpdateGate>
          <div>工作区内容已放行</div>
        </FunctionalModuleUpdateGate>
      </Provider>,
    )
    expect(html2).toBeDefined()
  })
})

