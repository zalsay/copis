import { describe, expect, test, beforeEach, mock } from 'bun:test'
import { createStore } from 'jotai'
import type { ProxyConfig, SystemProxyDetectResult } from '@copis/shared'
import {
  proxyConfigAtom,
  loadProxyConfigAtom,
  updateProxyConfigAtom,
  detectSystemProxyAtom,
  systemProxyDetectResultAtom,
  detectingSystemProxyAtom,
} from './proxy-atoms'

describe('proxy-atoms 代理状态管理', () => {
  let store: ReturnType<typeof createStore>
  let mockGetProxySettings: ReturnType<typeof mock>
  let mockUpdateProxySettings: ReturnType<typeof mock>
  let mockDetectSystemProxy: ReturnType<typeof mock>

  const defaultMockConfig: ProxyConfig = {
    enabled: true,
    mode: 'system',
    manualUrl: '',
  }

  beforeEach(() => {
    store = createStore()
    mockGetProxySettings = mock(async () => defaultMockConfig)
    mockUpdateProxySettings = mock(async (_config: ProxyConfig) => {})
    mockDetectSystemProxy = mock(async (): Promise<SystemProxyDetectResult> => ({
      success: true,
      proxyUrl: 'http://127.0.0.1:7890',
      message: '检测到系统代理: http://127.0.0.1:7890',
    }))

    // 模拟 window.electronAPI
    ;(globalThis as any).window = {
      electronAPI: {
        getProxySettings: mockGetProxySettings,
        updateProxySettings: mockUpdateProxySettings,
        detectSystemProxy: mockDetectSystemProxy,
      },
    }
  })

  test('Given loadProxyConfigAtom When 触发加载 Then 正确拉取主进程代理配置并更新 proxyConfigAtom', async () => {
    await store.set(loadProxyConfigAtom)
    const config = store.get(proxyConfigAtom)
    expect(config).toEqual(defaultMockConfig)
    expect(mockGetProxySettings).toHaveBeenCalled()
  })

  test('Given updateProxyConfigAtom When 更新配置 Then 调用主进程保存并更新本地状态', async () => {
    const nextConfig: ProxyConfig = {
      enabled: true,
      mode: 'manual',
      manualUrl: 'http://127.0.0.1:8888',
    }
    await store.set(updateProxyConfigAtom, nextConfig)
    expect(mockUpdateProxySettings).toHaveBeenCalledWith(nextConfig)
    expect(store.get(proxyConfigAtom)).toEqual(nextConfig)
  })

  test('Given detectSystemProxyAtom When 触发系统代理检测 Then 正确调用并记录检测结果', async () => {
    const result = await store.set(detectSystemProxyAtom)
    expect(result.success).toBe(true)
    expect(result.proxyUrl).toBe('http://127.0.0.1:7890')
    expect(store.get(systemProxyDetectResultAtom)).toEqual(result)
    expect(store.get(detectingSystemProxyAtom)).toBe(false)
  })
})
