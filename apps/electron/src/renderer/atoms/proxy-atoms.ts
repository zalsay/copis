/**
 * 代理配置状态管理
 *
 * 使用 Jotai 管理全局代理配置，支持系统代理自动检测和手动配置。
 */

import { atom } from 'jotai'
import type { ProxyConfig, SystemProxyDetectResult } from '@copis/shared'

/**
 * 代理配置 Atom
 *
 * 从主进程获取，支持系统代理和手动配置两种模式。
 */
export const proxyConfigAtom = atom<ProxyConfig | null>(null)

/**
 * 最近一次系统代理检测结果
 */
export const systemProxyDetectResultAtom = atom<SystemProxyDetectResult | null>(null)

/**
 * 系统代理检测中状态
 */
export const detectingSystemProxyAtom = atom<boolean>(false)

/**
 * 代理配置保存中状态
 */
export const savingProxyConfigAtom = atom<boolean>(false)

/**
 * 加载代理配置
 */
export const loadProxyConfigAtom = atom(null, async (get, set) => {
  try {
    const config = await window.electronAPI.getProxySettings()
    set(proxyConfigAtom, config)
    return config
  } catch (error) {
    console.error('[代理配置] 加载失败:', error)
    return null
  }
})

/**
 * 更新代理配置
 */
export const updateProxyConfigAtom = atom(
  null,
  async (get, set, config: ProxyConfig) => {
    set(savingProxyConfigAtom, true)
    try {
      await window.electronAPI.updateProxySettings(config)
      set(proxyConfigAtom, config)
    } catch (error) {
      console.error('[代理配置] 更新失败:', error)
      throw error
    } finally {
      set(savingProxyConfigAtom, false)
    }
  }
)

/**
 * 检测系统代理
 */
export const detectSystemProxyAtom = atom(
  null,
  async (get, set): Promise<SystemProxyDetectResult> => {
    set(detectingSystemProxyAtom, true)
    try {
      const result = await window.electronAPI.detectSystemProxy()
      set(systemProxyDetectResultAtom, result)
      return result
    } catch (error) {
      console.error('[代理配置] 系统代理检测失败:', error)
      const errorResult: SystemProxyDetectResult = {
        success: false,
        message: error instanceof Error ? error.message : '系统代理检测异常',
      }
      set(systemProxyDetectResultAtom, errorResult)
      return errorResult
    } finally {
      set(detectingSystemProxyAtom, false)
    }
  }
)
