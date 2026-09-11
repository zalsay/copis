import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SkillMeta } from '@copis/shared'
import { getSkillCategoryIconClass, SkillCard } from './SkillCard'

describe('SkillCard 图标与分类颜色', () => {
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
  })

  test('getSkillCategoryIconClass 为各分类返回与分类标签完全一致的颜色样式', () => {
    expect(getSkillCategoryIconClass('Copis 功能')).toBe('bg-foreground/10 text-foreground')
    expect(getSkillCategoryIconClass('办公')).toBe('bg-blue-500/12 text-blue-500 dark:text-blue-400')
    expect(getSkillCategoryIconClass('投资')).toBe('bg-red-500/12 text-red-500 dark:text-red-400')
    expect(getSkillCategoryIconClass('其他')).toBe('bg-muted text-muted-foreground')
    expect(getSkillCategoryIconClass(undefined)).toBe('bg-muted text-muted-foreground')
  })

  test('各分类内置技能卡片图标背景和颜色与对应分类图标保持一致', () => {
    const renderCard = (skill: SkillMeta): string =>
      renderToStaticMarkup(
        <SkillCard
          skill={skill}
          isBuiltin
          updating={false}
          onOpen={() => undefined}
          onToggle={() => undefined}
          onUpdate={() => undefined}
        />,
      )

    // 1. 办公分类
    const officeSkill: SkillMeta = {
      slug: 'officecli',
      name: 'officecli',
      displayName: 'Office 文档处理',
      enabled: true,
    }
    const officeHtml = renderCard(officeSkill)
    expect(officeHtml).toContain('bg-blue-500/12')
    expect(officeHtml).toContain('text-blue-500')

    // 2. 投资分类
    const tradingSkill: SkillMeta = {
      slug: 'trading-analysis',
      name: 'trading-analysis',
      displayName: '投资分析',
      enabled: true,
    }
    const tradingHtml = renderCard(tradingSkill)
    expect(tradingHtml).toContain('bg-red-500/12')
    expect(tradingHtml).toContain('text-red-500')

    // 3. Copis 功能分类
    const featureSkill: SkillMeta = {
      slug: 'session-cleaner',
      name: 'session-cleaner',
      displayName: '会话清理',
      enabled: true,
    }
    const featureHtml = renderCard(featureSkill)
    expect(featureHtml).toContain('bg-foreground/10')
    expect(featureHtml).toContain('text-foreground')

    // 4. 其他分类
    const otherSkill: SkillMeta = {
      slug: 'misc-tool',
      name: 'misc-tool',
      displayName: '杂项工具',
      enabled: true,
    }
    const otherHtml = renderCard(otherSkill)
    expect(otherHtml).toContain('bg-muted')
    expect(otherHtml).toContain('text-muted-foreground')
  })
})

