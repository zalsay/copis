import { describe, expect, test } from 'bun:test'
import { parseBuiltinSkillMarkdown } from './builtin-skill-catalog-parser'

describe('内置 Skill 目录元数据解析', () => {
  test('解析 frontmatter 并默认标记为已启用', () => {
    const skill = parseBuiltinSkillMarkdown(
      '---\nname: writing-plans\ndisplayName: 编写实施计划\ndescription: 编写实施计划\ngroup: 系统内置\nicon: puzzle\nversion: "1.0.3"\n---\n\n正文',
      'writing-plans',
    )

    expect(skill).toEqual({
      slug: 'writing-plans',
      name: 'writing-plans',
      displayName: '编写实施计划',
      description: '编写实施计划',
      group: '系统内置',
      icon: 'puzzle',
      version: '1.0.3',
      enabled: true,
    })
  })

  test('解析包含 category 的 frontmatter', () => {
    const skill = parseBuiltinSkillMarkdown(
      '---\nname: trading-cn-risk\ndisplayName: A股风控与投研\ndescription: A股风控\ngroup: 系统内置\ncategory: 投资\nversion: "1.0.0"\n---\n\n正文',
      'trading-cn-risk',
    )

    expect(skill.category).toBe('投资')
  })
})
