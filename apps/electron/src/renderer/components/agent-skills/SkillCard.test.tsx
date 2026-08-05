import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SkillMeta } from '@copis/shared'
import { SkillCard } from './SkillCard'

describe('SkillCard 图标', () => {
  test('所有技能卡片统一渲染技能市场相同的 Puzzle 图标', () => {
    const skill: SkillMeta = {
      slug: 'weekly-report',
      name: 'weekly-report',
      displayName: '周报月报生成',
      icon: 'sparkles',
      enabled: true,
    }

    const html = renderToStaticMarkup(
      <SkillCard
        skill={skill}
        isBuiltin
        updating={false}
        onOpen={() => undefined}
        onToggle={() => undefined}
        onUpdate={() => undefined}
      />,
    )

    expect(html).toContain('lucide-puzzle')
    expect(html).not.toContain('lucide-sparkles')
    expect(html).toContain('bg-primary/10')
    expect(html).toContain('text-primary')
    expect(html).not.toContain('bg-blue-500/10')
  })
})
