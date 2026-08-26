import { describe, expect, test } from 'bun:test'
import { COPIS_STARTER_FEATURES } from './NewSessionFeatureChips'

describe('NewSessionFeatureChips', () => {
  test('必须包含 Copis 的 5 大核心主打功能快捷入口', () => {
    const titles = COPIS_STARTER_FEATURES.map((f) => f.title)
    expect(titles).toContain('学习网页操作')
    expect(titles).toContain('生成工作流')
    expect(titles).toContain('定时任务')
    expect(titles).toContain('创作个人工作台')
    expect(titles).toContain('专家团队')
    expect(COPIS_STARTER_FEATURES).toHaveLength(5)
  })

  test('每个入口都具备完整 title, description 与可执行 prompt', () => {
    for (const feature of COPIS_STARTER_FEATURES) {
      expect(feature.id).toBeTruthy()
      expect(feature.title).toBeTruthy()
      expect(feature.description).toBeTruthy()
      expect(feature.prompt).toBeTruthy()
      expect(feature.icon).toBeDefined()
    }
  })
})
