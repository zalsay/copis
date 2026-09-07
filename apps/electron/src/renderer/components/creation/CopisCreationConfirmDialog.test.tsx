import { describe, expect, test, mock } from 'bun:test'
import * as React from 'react'

mock.module('@/components/ui/dialog', () => {
  return {
    Dialog: ({ children, open }: any) => (open ? <div data-dialog-root>{children}</div> : null),
    DialogContent: ({ children, className }: any) => <div role="dialog" className={className}>{children}</div>,
    DialogHeader: ({ children, className }: any) => <div className={className}>{children}</div>,
    DialogTitle: ({ children, className }: any) => <h2 className={className}>{children}</h2>,
    DialogDescription: ({ children, className, asChild }: any) => asChild ? children : <div className={className}>{children}</div>,
    DialogFooter: ({ children, className }: any) => <div className={className}>{children}</div>,
  }
})

const { renderToString } = await import('react-dom/server')
const { createStore, Provider } = await import('jotai')
const { CopisCreationConfirmDialog } = await import('./CopisCreationConfirmDialog')
const { creationModeSkipConfirmAtom } = await import('@/atoms/app-mode')

describe('CopisCreationConfirmDialog 进入创造模式确认弹窗', () => {
  test('Given open 为 true When 渲染弹窗 Then 包含自我迭代提示、崩溃稳定性警示与不再提醒选项', () => {
    const store = createStore()
    const onOpenChange = mock(() => {})
    const onConfirm = mock(() => {})

    const html = renderToString(
      <Provider store={store}>
        <CopisCreationConfirmDialog
          open={true}
          onOpenChange={onOpenChange}
          onConfirm={onConfirm}
        />
      </Provider>,
    )

    expect(html).toContain('进入 Copis 创造模式')
    expect(html).toContain('创造模式专为 Copis 自我进化设计')
    expect(html).toContain('自我迭代与稳定性提示')
    expect(html).toContain('深层源码实验与热更新修改可能导致程序逻辑异常、界面闪退或意外崩溃')
    expect(html).toContain('下次进入创造模式时不再提醒')
    expect(html).toContain('取消')
    expect(html).toContain('确认进入创造模式')
  })

  test('Given open 为 false When 渲染弹窗 Then 不渲染弹窗正文', () => {
    const store = createStore()
    const onOpenChange = mock(() => {})
    const onConfirm = mock(() => {})

    const html = renderToString(
      <Provider store={store}>
        <CopisCreationConfirmDialog
          open={false}
          onOpenChange={onOpenChange}
          onConfirm={onConfirm}
        />
      </Provider>,
    )

    expect(html).not.toContain('进入 Copis 创造模式')
    expect(html).not.toContain('确认进入创造模式')
  })

  test('Given creationModeSkipConfirmAtom 状态管理 When 用户勾选不再提醒 Then atom 被正确持久化', () => {
    const store = createStore()
    expect(store.get(creationModeSkipConfirmAtom)).toBe(false)

    store.set(creationModeSkipConfirmAtom, true)
    expect(store.get(creationModeSkipConfirmAtom)).toBe(true)
  })

  test('Given 确认弹窗 When 渲染 Then 图标容器与按钮使用 creation-ui-primary 强调色体系', () => {
    const store = createStore()
    const html = renderToString(
      <Provider store={store}>
        <CopisCreationConfirmDialog
          open={true}
          onOpenChange={() => {}}
          onConfirm={() => {}}
        />
      </Provider>,
    )

    expect(html).toContain('bg-[var(--creation-ui-primary-background)]')
    expect(html).toContain('text-[var(--creation-ui-primary)]')
    expect(html).toContain('accent-[var(--creation-ui-primary)]')
    expect(html).toContain('bg-[var(--creation-ui-primary)]')
  })
})
