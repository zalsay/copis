import { describe, expect, test } from 'bun:test'
import {
  COPIS_STARTER_FEATURES,
  COPIS_BROWSER_STARTER_FEATURES,
  COPIS_INVESTMENT_STARTER_FEATURES,
} from './NewSessionFeatureChips'

describe('NewSessionFeatureChips', () => {
  test('必须包含 Copis 的核心主打功能快捷入口', () => {
    const titles = COPIS_STARTER_FEATURES.map((f) => f.title)
    expect(titles).toContain('学习网页操作')
    expect(titles).toContain('生成工作流')
    expect(titles).toContain('定时任务')
    expect(titles).toContain('创作个人工作台')
    expect(titles).toContain('专家团队')
    expect(titles).toContain('形成记忆')
    expect(COPIS_STARTER_FEATURES).toHaveLength(6)
    expect(COPIS_STARTER_FEATURES[2]?.title).toBe('形成记忆')
  })

  test('浏览器面板必须包含「总结网页」与「学习你的操作，下次自动执行」两个专用胶囊 Tag', () => {
    const titles = COPIS_BROWSER_STARTER_FEATURES.map((f) => f.title)
    expect(titles).toContain('总结网页')
    expect(titles).toContain('学习你的操作，下次自动执行')
    expect(COPIS_BROWSER_STARTER_FEATURES).toHaveLength(2)
  })

  test('投资工作台必须包含「综合诊断」、「风控核查」、「形态透视」、「基本面」四个快捷指令', () => {
    const titles = COPIS_INVESTMENT_STARTER_FEATURES.map((f) => f.title)
    expect(titles).toEqual(['综合诊断', '风控核查', '形态透视', '基本面'])
    expect(COPIS_INVESTMENT_STARTER_FEATURES).toHaveLength(4)
  })

  test('每个入口都具备完整 title, description 与可执行 prompt', () => {
    for (const feature of [
      ...COPIS_STARTER_FEATURES,
      ...COPIS_BROWSER_STARTER_FEATURES,
      ...COPIS_INVESTMENT_STARTER_FEATURES,
    ]) {
      expect(feature.id).toBeTruthy()
      expect(feature.title).toBeTruthy()
      expect(feature.description).toBeTruthy()
      expect(feature.prompt).toBeTruthy()
      expect(feature.icon).toBeDefined()
    }
  })
})
