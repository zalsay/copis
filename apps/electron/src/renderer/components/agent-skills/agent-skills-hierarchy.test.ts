import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const componentSources = Object.fromEntries(
  ['AgentSkillsView.tsx', 'SkillCard.tsx', 'SkillDetailSheet.tsx'].map((fileName) => [
    fileName,
    readFileSync(join(import.meta.dir, fileName), 'utf8'),
  ]),
)
const viewSource = componentSources['AgentSkillsView.tsx']
const skillUiSource = Object.values(componentSources).join('\n')

describe('Agent Skills 页面层级契约', () => {
  test('只保留两个顶级区块并平铺 Skills 卡片', () => {
    expect(viewSource).toContain('title="我的 Skills"')
    expect(viewSource).toContain('title="Copis 内置"')
    expect(viewSource).toContain('skills.map((skill) => (')
    expect(viewSource).toContain('grid gap-3 sm:grid-cols-2 lg:grid-cols-3')
  })

  test('不再依赖二级分组或 AI 分类入口', () => {
    expect(viewSource).not.toContain('groupSkills')
    expect(viewSource).not.toContain('collapsedGroups')
    expect(viewSource).not.toContain('AI 分类')
    expect(viewSource).not.toContain('handleClassifySkills')
    expect(viewSource).not.toContain('buildSkillClassificationPrompt')
    expect(viewSource).not.toContain('useCreateSession')
    expect(viewSource).not.toContain('agentPendingPromptAtom')
  })

  test('Skills UI 统一使用 Copis 内置来源文案', () => {
    expect(skillUiSource).not.toContain('COPIS 内置')
    expect(skillUiSource).toContain('Copis 内置')
  })
})
