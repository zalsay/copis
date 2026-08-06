/**
 * Agent 工具配置服务
 *
 * 管理 ~/.copis/chat-tools.json 的读写。
 * 存储工具开关状态、凭据和自定义工具定义。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { getChatToolsConfigPath } from './config-paths'
import type { AgentToolsFileConfig, AgentToolState, AgentToolMeta } from '@copis/shared'

/** 默认配置 */
const DEFAULT_CONFIG: AgentToolsFileConfig = {
  toolStates: {
    'web-search': { enabled: false },
    'nano-banana': { enabled: false },
  },
  toolCredentials: {},
  customTools: [],
}

/**
 * 读取工具配置
 */
export function getAgentToolsConfig(): AgentToolsFileConfig {
  const filePath = getChatToolsConfigPath()

  if (!existsSync(filePath)) {
    return structuredClone(DEFAULT_CONFIG)
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as Partial<AgentToolsFileConfig>
    return {
      toolStates: { ...DEFAULT_CONFIG.toolStates, ...data.toolStates },
      toolCredentials: data.toolCredentials ?? {},
      customTools: data.customTools ?? [],
    }
  } catch (error) {
    console.error('[Agent 工具配置] 读取失败:', error)
    return structuredClone(DEFAULT_CONFIG)
  }
}

/**
 * 保存工具配置
 */
export function saveAgentToolsConfig(config: AgentToolsFileConfig): void {
  const filePath = getChatToolsConfigPath()
  try {
    writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8')
    console.log('[Agent 工具配置] 已保存')
  } catch (error) {
    console.error('[Agent 工具配置] 保存失败:', error)
    throw new Error('保存 Agent 工具配置失败')
  }
}

/**
 * 更新单个工具的开关状态
 */
export function updateAgentToolState(toolId: string, state: AgentToolState): void {
  const config = getAgentToolsConfig()
  config.toolStates[toolId] = state
  saveAgentToolsConfig(config)
}

/**
 * 更新工具凭据
 */
export function updateAgentToolCredentials(toolId: string, credentials: Record<string, string>): void {
  const config = getAgentToolsConfig()
  config.toolCredentials[toolId] = credentials
  saveAgentToolsConfig(config)
}

/**
 * 获取工具开关状态（不存在时返回默认关闭）
 */
export function getAgentToolState(toolId: string): AgentToolState {
  const config = getAgentToolsConfig()
  return config.toolStates[toolId] ?? { enabled: false }
}

/**
 * 获取工具凭据
 */
export function getAgentToolCredentials(toolId: string): Record<string, string> {
  const config = getAgentToolsConfig()
  return config.toolCredentials[toolId] ?? {}
}

/**
 * 添加自定义工具
 */
export function addCustomAgentTool(meta: AgentToolMeta): void {
  const config = getAgentToolsConfig()
  // 去重
  config.customTools = config.customTools.filter((t) => t.id !== meta.id)
  config.customTools.push(meta)
  config.toolStates[meta.id] = { enabled: false }
  saveAgentToolsConfig(config)
}

/**
 * 删除自定义工具
 */
export function deleteCustomAgentTool(toolId: string): void {
  const config = getAgentToolsConfig()
  config.customTools = config.customTools.filter((t) => t.id !== toolId)
  delete config.toolStates[toolId]
  delete config.toolCredentials[toolId]
  saveAgentToolsConfig(config)
}
