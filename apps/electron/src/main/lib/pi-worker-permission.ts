import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { PiWorkerRunConfig } from './agent-rpc-protocol'

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export function createChatroomCanUseTool(config: PiWorkerRunConfig, fetchImpl: FetchImpl = fetch) {
  return async (toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal; toolUseID: string; description?: string }) => {
    if (config.query.capabilityProfile !== 'chatroom') return { behavior: 'allow' as const, updatedInput: input }
    const sensitive = new Set(['BrowserPageObserve', 'BrowserPageClick', 'BrowserPageType', 'BrowserPageNavigate', 'WebSearch', 'WebFetch', 'mcp__alipay_bot', 'mcp__agent_mail', 'mcp__working_payment', 'RealPath'])
    if (sensitive.has(toolName)) return { behavior: 'deny' as const, message: '聊天室运行时未授予该敏感能力。' }
    const path = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : ''
    const root = config.query.cwd ?? ''
    const rel = path && root ? relative(root, resolve(root, path)) : '..'
    if (['Read', 'Edit', 'Write', 'MultiEdit'].includes(toolName) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return { behavior: 'allow' as const, updatedInput: input }
    if (['memory_recall', 'memory_read'].includes(toolName)) return { behavior: 'allow' as const, updatedInput: input }
    const token = process.env.COPIS_PI_FILE_API_TOKEN
    if (!token || options.signal.aborted) return { behavior: 'deny' as const, message: '聊天室权限通道不可用' }
    try {
      const response = await fetchImpl(`http://127.0.0.1:${process.env.COPIS_HTTP_API_PORT ?? '51730'}/api/internal/agent/permission`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Copis-Agent-File-Token': token }, body: JSON.stringify({ sessionId: config.sessionId, requestId: options.toolUseID, toolName, toolInput: input, description: options.description }), signal: options.signal })
      const value = await response.json() as { behavior?: unknown; message?: unknown }
      if (!response.ok || (value.behavior !== 'allow' && value.behavior !== 'deny')) return { behavior: 'deny' as const, message: '主理人权限响应无效' }
      return value.behavior === 'allow' ? { behavior: 'allow' as const, updatedInput: input } : { behavior: 'deny' as const, message: typeof value.message === 'string' ? value.message : '主理人拒绝了操作' }
    } catch { return { behavior: 'deny' as const, message: '主理人权限通道已断开' } }
  }
}
