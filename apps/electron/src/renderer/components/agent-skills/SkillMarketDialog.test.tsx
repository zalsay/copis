import { describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentWorkspace } from '@copis/shared'

interface DialogMockProps {
  children?: React.ReactNode
}

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children }: DialogMockProps) => <div>{children}</div>,
  DialogContent: ({ children }: DialogMockProps) => <div>{children}</div>,
  DialogDescription: ({ children }: DialogMockProps) => <div>{children}</div>,
  DialogHeader: ({ children }: DialogMockProps) => <div>{children}</div>,
  DialogTitle: ({ children }: DialogMockProps) => <div>{children}</div>,
}))

mock.module('@/lib/working-skill-market-api', () => ({
  installWorkingSkill: async () => undefined,
  listWorkingSkillMarket: async () => [],
  uninstallWorkingSkill: async () => undefined,
}))

const { SkillMarketDialog } = await import('./SkillMarketDialog')

const workspaces: AgentWorkspace[] = [
  {
    id: 'current-id',
    name: '当前项目',
    slug: 'current-project',
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'other-id',
    name: '其他项目',
    slug: 'other-project',
    createdAt: 2,
    updatedAt: 2,
  },
]

describe('技能市场目标项目选择', () => {
  test('打开技能市场时不默认当前项目，必须先选择目标项目', () => {
    const html = renderToStaticMarkup(
      <SkillMarketDialog
        open
        onOpenChange={() => undefined}
        workspaces={workspaces}
        onChanged={() => undefined}
      />,
    )

    expect(html).toContain('选择目标项目')
    expect(html).toContain('请选择项目（必选）')
  })
})
