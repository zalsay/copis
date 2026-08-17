/**
 * Shared type definitions for copis
 */

// Placeholder types - will be expanded as needed
export interface Workspace {
  id: string
  name: string
  path: string
}

// 运行时相关类型
export * from './runtime'

// 渠道（AI 供应商）相关类型
export * from './channel'

// 通用附件和模型类型
export * from './attachments'
export * from './model'

// 代理配置相关类型
export * from './proxy'

// Agent 相关类型
export * from './agent'
export * from './reasoning-profile'

// Agent Provider 适配器接口
export * from './agent-provider'

// 环境检测相关类型
export * from './environment'

// 可独立安装和更新的 Copis 功能模块
export * from './functional-module'

// 系统提示词相关类型
export * from './system-prompt'

// Agent 工具（function calling）相关类型
export * from './agent-tool'

// 飞书集成相关类型
export * from './feishu'

// 钉钉集成相关类型
export * from './dingtalk'

// 微信集成相关类型
export * from './wechat'

// 定时任务（Automation）相关类型
export * from './automation'
// 本地任务与日程（Planning）相关类型
export * from './planning'

// Copis Working 客户端相关类型
export * from './working'

// 内嵌 Chromium 网页页签相关类型
export * from './web'

// Copis Memory 长期记忆相关类型
export * from './memory'
// Pi Agent 浏览器工作流相关类型
export * from './browser-workflow'

// 本地文件 HTTP API
export * from './file-api'

// 专家团队工作台与 Rust HTTP API
export * from './expert-team'
