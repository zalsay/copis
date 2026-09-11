import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

interface BuiltinMcpManifest {
  servers: Array<{
    id: string
    description: string
  }>
}

const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../main/lib/builtin-mcp/default-mcp.json'), 'utf8'),
) as BuiltinMcpManifest
const detailSheetSource = readFileSync(join(import.meta.dir, 'BuiltinMcpDetailSheet.tsx'), 'utf8')
const imageServer = manifest.servers.find((server) => server.id === 'nano-banana')
const automationServer = manifest.servers.find((server) => server.id === 'automation')
const collaborationServer = manifest.servers.find((server) => server.id === 'collaboration')

test('Copis 图片生成 已从内置 MCP 清单中移除', () => {
  expect(imageServer).toBeUndefined()
  expect(manifest.servers.some((s) => s.id === 'nano-banana')).toBe(false)
})

test('内置 MCP 列表描述使用用户友好的文案', () => {
  expect(automationServer?.description).toBe('创建、查看、更新、删除和立即运行 Copis 持久化定时任务。')
  expect(collaborationServer?.description).toBe('创建、等待、读取和停止真实可见的 Copis 协作子 Agent 会话。')
})

test('内置 MCP 详情配置说明无需额外凭据', () => {
  expect(detailSheetSource).toContain("description: '协作子 Agent 使用当前项目、会话和权限上下文，无需填写额外凭据。'")
  expect(detailSheetSource).toContain("description: '自动任务 MCP 直接使用 Copis 本地任务服务，无需填写额外凭据。'")
})
