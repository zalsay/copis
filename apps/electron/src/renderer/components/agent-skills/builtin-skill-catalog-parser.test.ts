import { describe, expect, test } from 'bun:test'
import { parseBuiltinSkillMarkdown } from './builtin-skill-catalog-parser'

describe('内置 Skill 目录元数据解析', () => {
  test('解析 frontmatter 并默认标记为已启用', () => {
    const skill = parseBuiltinSkillMarkdown(
      '---\nname: writing-plans\ndescription: 编写实施计划\ngroup: 系统内置\nversion: "1.0.3"\n---\n\n正文',
      'writing-plans',
    )

    expect(skill).toEqual({
      slug: 'writing-plans',
      name: 'writing-plans',
      description: '编写实施计划',
      group: '系统内置',
      version: '1.0.3',
      enabled: true,
    })
  })
})
