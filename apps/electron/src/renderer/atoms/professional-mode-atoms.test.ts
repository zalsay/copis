import { describe, expect, mock, test, beforeEach } from 'bun:test'
import { createStore } from 'jotai'
import {
  COPIS_WORKING_CHANNEL_ID,
  COPIS_WORKING_EXPERT_MODEL_ID,
  COPIS_WORKING_FAST_MODEL_ID,
  COPIS_WORKING_GLOBAL_MODEL_ID,
  workingCustomModelChannelIdFor,
} from '@copis/shared'
import {
  professionalModeAtom,
  codexAppServerStatusAtom,
  toggleProfessionalModeAtom,
} from './professional-mode-atoms'
import { selectedModelAtom } from './model-atoms'

describe('Professional Mode Atoms (BDD)', () => {
  let startAppServerMock: ReturnType<typeof mock>
  let stopAppServerMock: ReturnType<typeof mock>
  let updateSettingsMock: ReturnType<typeof mock>

  beforeEach(() => {
    startAppServerMock = mock(async () => ({ running: true, port: 54080, pid: 12345 }))
    stopAppServerMock = mock(async () => {})
    updateSettingsMock = mock(async () => {})

    ;(globalThis as unknown as { window: unknown }).window = {
      electronAPI: {
        startCodexAppServer: startAppServerMock,
        stopCodexAppServer: stopAppServerMock,
        updateSettings: updateSettingsMock,
      },
    }
  })

  test('Given 开启专业模式 When 当前模型为第三方 Provider Then 自动回退至 Copis 默认模型', async () => {
    const store = createStore()
    // 初始状态：未开启，当前选中第三方模型
    store.set(professionalModeAtom, false)
    store.set(selectedModelAtom, {
      channelId: 'third-party-openai',
      modelId: 'gpt-4o',
    })

    // 执行开启
    await store.set(toggleProfessionalModeAtom, true)

    expect(store.get(professionalModeAtom)).toBe(true)
    expect(startAppServerMock).toHaveBeenCalledTimes(1)
    expect(updateSettingsMock).toHaveBeenCalledWith({ professionalMode: true })
    expect(store.get(codexAppServerStatusAtom)).toEqual({ running: true, port: 54080, pid: 12345 })

    // 检查第三方模型是否已被回退到 Copis 默认模型
    const fallbackModel = store.get(selectedModelAtom)
    expect(fallbackModel?.channelId).toBe(COPIS_WORKING_CHANNEL_ID)
    expect(fallbackModel?.modelId).toBe(COPIS_WORKING_FAST_MODEL_ID)
  })

  test('Given 开启专业模式 When 当前模型为 Copis 通识模型 (global) Then 自动回退至 Copis 快速模型 (fast)', async () => {
    const store = createStore()
    store.set(professionalModeAtom, false)
    store.set(selectedModelAtom, {
      channelId: COPIS_WORKING_CHANNEL_ID,
      modelId: COPIS_WORKING_GLOBAL_MODEL_ID,
    })

    await store.set(toggleProfessionalModeAtom, true)

    expect(store.get(professionalModeAtom)).toBe(true)
    const fallbackModel = store.get(selectedModelAtom)
    expect(fallbackModel?.channelId).toBe(COPIS_WORKING_CHANNEL_ID)
    expect(fallbackModel?.modelId).toBe(COPIS_WORKING_FAST_MODEL_ID)
  })

  test('Given 开启专业模式 When 当前模型为 Copis 专家模型 (expert) Then 保留当前专家模型', async () => {
    const store = createStore()
    store.set(professionalModeAtom, false)
    store.set(selectedModelAtom, {
      channelId: COPIS_WORKING_CHANNEL_ID,
      modelId: COPIS_WORKING_EXPERT_MODEL_ID,
    })

    await store.set(toggleProfessionalModeAtom, true)

    expect(store.get(professionalModeAtom)).toBe(true)
    const currentModel = store.get(selectedModelAtom)
    expect(currentModel?.channelId).toBe(COPIS_WORKING_CHANNEL_ID)
    expect(currentModel?.modelId).toBe(COPIS_WORKING_EXPERT_MODEL_ID)
  })

  test('Given 开启专业模式 When 当前模型为自定义模型或 Copis 官方模型 Then 保留当前模型不强制回退', async () => {
    const store = createStore()
    const customChannelId = workingCustomModelChannelIdFor('my-custom-model-id')
    store.set(professionalModeAtom, false)
    store.set(selectedModelAtom, {
      channelId: customChannelId,
      modelId: 'my-custom-model-id',
    })

    await store.set(toggleProfessionalModeAtom, true)

    expect(store.get(professionalModeAtom)).toBe(true)
    // 保持为自定义模型
    expect(store.get(selectedModelAtom)).toEqual({
      channelId: customChannelId,
      modelId: 'my-custom-model-id',
    })
  })

  test('Given 专业模式处于开启状态 When 点击关闭 Then 停止服务并持久化设置', async () => {
    const store = createStore()
    store.set(professionalModeAtom, true)
    store.set(codexAppServerStatusAtom, { running: true, port: 54080 })

    await store.set(toggleProfessionalModeAtom, false)

    expect(store.get(professionalModeAtom)).toBe(false)
    expect(stopAppServerMock).toHaveBeenCalledTimes(1)
    expect(updateSettingsMock).toHaveBeenCalledWith({ professionalMode: false })
    expect(store.get(codexAppServerStatusAtom)).toEqual({ running: false })
  })
})
