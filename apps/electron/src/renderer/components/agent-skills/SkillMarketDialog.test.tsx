import { describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

interface DialogMockProps {
  children?: React.ReactNode
}

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children }: DialogMockProps) => <div>{children}</div>,
  DialogContent: ({ children }: DialogMockProps) => <div>{children}</div>,
  DialogHeader: ({ children }: DialogMockProps) => <div>{children}</div>,
  DialogTitle: ({ children }: DialogMockProps) => <div>{children}</div>,
}))

mock.module('@/lib/working-skill-market-api', () => ({
  installWorkingSkill: async () => undefined,
  listWorkingSkillMarket: async () => [],
  uninstallWorkingSkill: async () => undefined,
}))

const { SkillMarketDialog } = await import('./SkillMarketDialog')

describe('技能市场当前项目', () => {
  test('直接使用 Agent 技能页传入的当前项目，不显示二次选择器', () => {
    const html = renderToStaticMarkup(
      <SkillMarketDialog
        open
        onOpenChange={() => undefined}
        currentWorkspaceSlug="current-project"
        currentWorkspaceName="默认项目"
        onChanged={() => undefined}
      />,
    )

    expect(html).toContain('技能市场暂时没有可用内容')
    expect(html).toContain('默认项目')
    expect(html).not.toContain('从 Working 官方技能市场安装专家能力到当前项目')
    expect(html).not.toContain('目标项目')
    expect(html).not.toContain('role="combobox"')
  })
})
