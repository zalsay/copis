import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const rendererRoot = import.meta.dir
const entrySource = readFileSync(join(rendererRoot, 'main.tsx'), 'utf8')
const welcomeComposerSource = readFileSync(join(rendererRoot, 'components', 'welcome', 'WelcomeComposer.tsx'), 'utf8')

describe('Composer 默认模型', () => {
  test('Given 首次打开 Copis When 初始化新会话默认值 Then 选择 DeepSeek Flash', () => {
    expect(entrySource).toContain('COPIS_WORKING_DEEPSEEK_CHANNEL_ID')
    expect(entrySource).toContain('COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID')
    expect(entrySource).toContain('setAgentChannelId(COPIS_WORKING_DEEPSEEK_CHANNEL_ID)')
    expect(entrySource).toContain('setAgentModelId(COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID)')
    expect(entrySource).not.toContain('setAgentModelId(COPIS_WORKING_FAST_MODEL_ID)')
  })

  test('Given 欢迎页 Composer When 尚未选择模型 Then 默认选择 DeepSeek Flash', () => {
    const selectedModelStart = welcomeComposerSource.indexOf('const [selectedModel, setSelectedModel]')
    const selectedModelEnd = welcomeComposerSource.indexOf('const selectedModelId', selectedModelStart)
    const selectedModelSource = welcomeComposerSource.slice(selectedModelStart, selectedModelEnd)

    expect(selectedModelSource).toContain('channelId: COPIS_WORKING_DEEPSEEK_CHANNEL_ID')
    expect(selectedModelSource).toContain('modelId: COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID')
  })
})
