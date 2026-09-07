import React from 'react'

export interface CordisContext {
  slots: {
    inject(name: string, callback: () => any): void
    register(metadata: { name: string; id?: string; order?: number; locale?: string }, component: React.ComponentType<any>): any
  }
}

/**
 * DSH 客户端插件统一入口
 */
export function apply(ctx: CordisContext): void {
  // 1. 在输入框停靠区 (Composer Dock) 注入自定义状态指示条
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register({
      name: 'conversation.composer.dock',
      id: 'template-status-badge',
      order: 100,
    }, ComposerDockBadge)
  )
}

function ComposerDockBadge(): React.JSX.Element {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '2px 8px',
        fontSize: '12px',
        borderRadius: '6px',
        backgroundColor: 'var(--creation-ui-primary-background, rgb(108 0 204 / 15%))',
        color: 'var(--creation-ui-primary, #6C00CC)',
        border: '1px solid color-mix(in srgb, var(--creation-ui-primary, #6C00CC) 30%, transparent)',
        userSelect: 'none',
      }}
      title="来自 Agent 自进化的自定义插件"
    >
      <span>⚡ 创造模式扩展生效中</span>
    </div>
  )
}
