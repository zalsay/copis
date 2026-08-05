import { describe, expect, test } from 'bun:test'
import { rebuildSkillMd } from './skillMdUtils'

describe('Skill frontmatter 重写', () => {
  test('新增并清除 displayName 时保留其他元数据和正文', () => {
    const source = '---\nname: example\ndescription: 示例 Skill\n---\n\n正文'
    const withDisplayName = rebuildSkillMd(source, { displayName: '示例技能' })

    expect(withDisplayName).toContain('displayName: 示例技能')
    expect(withDisplayName).toContain('name: example')
    expect(withDisplayName).toContain('description: 示例 Skill')
    expect(withDisplayName).toContain('\n正文')

    const cleared = rebuildSkillMd(withDisplayName, { displayName: '' })
    expect(cleared).not.toContain('displayName:')
    expect(cleared).toContain('name: example')
    expect(cleared).toContain('\n正文')
  })
})
