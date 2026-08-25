import type { AgentSessionMeta } from '../types/agent'

/**
 * 判断会话元数据或运行来源是否属于 App 连接器（飞书 / 微信 / 钉钉）
 */
export function isAppConnectorSession(
  sessionMeta?: Pick<AgentSessionMeta, 'source' | 'feishuDedicated' | 'wechatDedicated' | 'dingtalkDedicated'> | null,
  externalSource?: string,
): boolean {
  if (
    externalSource === 'feishu' ||
    externalSource === 'wechat' ||
    externalSource === 'dingtalk' ||
    externalSource === 'bridge'
  ) {
    return true
  }
  if (!sessionMeta) return false
  return (
    sessionMeta.source === 'feishu' ||
    sessionMeta.source === 'wechat' ||
    sessionMeta.source === 'dingtalk' ||
    sessionMeta.source === 'bridge' ||
    sessionMeta.feishuDedicated === true ||
    sessionMeta.wechatDedicated === true ||
    sessionMeta.dingtalkDedicated === true
  )
}
