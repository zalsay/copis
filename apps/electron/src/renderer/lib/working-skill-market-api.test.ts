import { describe, expect, test } from 'bun:test'
import type { WorkingExpertSkillMarketItem } from '@copis/shared'
import { mapInstalledMarketSkills } from './working-skill-market-api'

function marketItem(overrides: Partial<WorkingExpertSkillMarketItem> = {}): WorkingExpertSkillMarketItem {
  return {
    id: 12,
    slug: 'weekly-report',
    name: '周报生成',
    description: '生成结构化周报',
    category: 'office-efficiency',
    accent: 'emerald',
    version: '1.2.0',
    installed: true,
    installedAt: '2026-08-05T10:00:00.000Z',
    sourceProvider: 'skillhub',
    syncStatus: 'ready',
    localInstalled: true,
    localVersion: '1.0.0',
    ...overrides,
  }
}

describe('Working 技能市场与 Agent 技能列表映射', () => {
  test('只把当前项目已安装的市场 Skill 映射为本地 Skill，并保留更新信息', () => {
    const skills = mapInstalledMarketSkills([
      marketItem(),
      marketItem({ id: 13, slug: 'not-installed', localInstalled: false, localVersion: undefined }),
    ])

    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({
      slug: 'weekly-report',
      name: '周报生成',
      description: '生成结构化周报',
      group: 'office-efficiency',
      version: '1.0.0',
      enabled: true,
      hasUpdate: true,
      marketSource: {
        id: 12,
        slug: 'weekly-report',
        version: '1.2.0',
        sourceProvider: 'skillhub',
        installedAt: '2026-08-05T10:00:00.000Z',
      },
    })
  })
})
