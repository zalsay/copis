import { describe, expect, test } from 'bun:test'
import {
  BUILTIN_SKILL_CATEGORIES,
  resolveBuiltinSkillCategory,
  type SkillMeta,
} from '@copis/shared'

describe('Copis 内置 Skill 分类契约', () => {
  test('支持且仅支持四个标准分类', () => {
    expect(BUILTIN_SKILL_CATEGORIES).toEqual(['Copis 功能', '办公', '投资', '其他'])
  })

  test('显式设置 category 时优先使用显式分类', () => {
    const meta: SkillMeta = {
      slug: 'custom-tool',
      name: 'Custom Tool',
      category: '投资',
      enabled: true,
    }
    expect(resolveBuiltinSkillCategory(meta)).toBe('投资')

    const officeMeta: SkillMeta = {
      slug: 'my-office-skill',
      name: 'Office Skill',
      category: '办公',
      enabled: true,
    }
    expect(resolveBuiltinSkillCategory(officeMeta)).toBe('办公')
  })

  test('基金股市相关 5 大 Skill 均被归类为「投资」', () => {
    const tradingSlugs = [
      'trading-cn-risk',
      'trading-us-risk',
      'trading-hk-risk',
      'trading-fund-analysis',
      'trading-company-analysis',
    ]

    for (const slug of tradingSlugs) {
      expect(resolveBuiltinSkillCategory({ slug })).toBe('投资')
    }
  })

  test('办公类内置 Skill 正确归类为「办公」', () => {
    const officeSlugs = [
      'officecli',
      'dashi-ppt',
      'pdf',
      'agently-mail',
      'summarize-workflow',
      'writing-plans',
      'executing-plans',
    ]

    for (const slug of officeSlugs) {
      expect(resolveBuiltinSkillCategory({ slug })).toBe('办公')
    }
  })

  test('Copis 核心功能相关 Skill 正确归类为「Copis 功能」', () => {
    const coreSlugs = [
      'automation',
      'browser-page-control',
      'browser-workflow-automation',
      'custom-expert-team',
      'deepseek-v4-flash-vision-rag',
      'find-skills',
      'session-cleaner',
      'skill-creator',
      'alipay-authenticate-wallet',
      'alipay-payment-skill',
    ]

    for (const slug of coreSlugs) {
      expect(resolveBuiltinSkillCategory({ slug })).toBe('Copis 功能')
    }
  })

  test('未知或其他未知 slug 降级为「其他」', () => {
    expect(resolveBuiltinSkillCategory({ slug: 'random-unclassified-skill' })).toBe('其他')
  })
})
