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

  test('Given 未登录初始化请求与登录请求并发 When 账号发生变化 Then 旧请求不能覆盖当前账号模型', () => {
    const modelInitializerStart = entrySource.indexOf('const workingModelRequestIdRef')
    const settingsInitializerMarker = 'const initialWorkingModelRequestId = workingModelRequestIdRef.current'
    const modelInitializerEnd = entrySource.indexOf(settingsInitializerMarker, modelInitializerStart)
    const modelInitializerSource = entrySource.slice(modelInitializerStart, modelInitializerEnd)

    expect(modelInitializerSource).toContain('window.electronAPI.getWorkingModelCatalog()')
    expect(modelInitializerSource).toContain('requestId !== workingModelRequestIdRef.current')
    expect(modelInitializerSource).toContain('getWorkingAccountKey(store.get(workingAuthStateAtom)) !== accountKey')
    expect(entrySource).toContain('model.apiKeyConfigured')
  })

  test('Given 通用设置请求返回 When 初始化 Working 默认模型 Then 不使用旧目录结果写入模型 atom', () => {
    const settingsInitializerMarker = 'const initialWorkingModelRequestId = workingModelRequestIdRef.current'
    const settingsInitializerStart = entrySource.indexOf(settingsInitializerMarker)
    const settingsInitializerEnd = entrySource.indexOf('  // 工作区切换时重置能力缓存', settingsInitializerStart)
    const settingsInitializerSource = entrySource.slice(settingsInitializerStart, settingsInitializerEnd)

    expect(settingsInitializerSource).not.toContain('settings.workingModelCatalog')
    expect(settingsInitializerSource).not.toContain('setAgentChannelId(')
    expect(settingsInitializerSource).not.toContain('setAgentModelId(')
    expect(settingsInitializerSource).toContain('initialWorkingModelRequestId === workingModelRequestIdRef.current')
  })
})
