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

test('图片生成的列表描述使用用户友好的内置服务文案', () => {
  expect(imageServer?.description).toBe('使用 Copis 内置的图片生成服务，登录 Copis 后即可生成图片。')
  expect(imageServer?.description).not.toContain('edu-api')
  expect(imageServer?.description).not.toContain('为 Agent 提供')
})

test('图片生成详情说明无需额外配置', () => {
  expect(detailSheetSource).toContain("source: 'Copis 内置服务'")
  expect(detailSheetSource).toContain("description: '登录 Copis 后即可使用图片生成功能，无需额外配置。'")
  expect(detailSheetSource).not.toContain('Copis 后端（edu-api）')
})
