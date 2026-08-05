import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let associationsPath: string
let service: typeof import('./web-project-association-service')

mock.module('./config-paths', () => ({
  getWebProjectAssociationsPath: () => associationsPath,
}))

mock.module('./agent-workspace-manager', () => ({
  getAgentWorkspace: (id: string) => id === 'workspace-default' || id === 'workspace-other'
    ? {
        id,
        name: id === 'workspace-default' ? '默认项目' : '其他项目',
        slug: id === 'workspace-default' ? 'default' : 'other',
        createdAt: 1,
        updatedAt: 1,
      }
    : undefined,
}))

beforeAll(async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'copis-web-project-associations-'))
  associationsPath = join(tempDir, 'web-project-associations.json')
  service = await import('./web-project-association-service')
})

beforeEach(() => {
  rmSync(associationsPath, { force: true })
})

afterAll(() => {
  rmSync(associationsPath, { force: true })
  rmSync(join(associationsPath, '..'), { recursive: true, force: true })
})

describe('网页与 Agent 项目关联', () => {
  test('首次读取 HTTP 页面时没有关联', () => {
    expect(service.getWebPageProjectAssociation('https://example.com/docs')).toBeNull()
  })

  test('保存关联并写入本地 JSON，再次读取可恢复项目', () => {
    const saved = service.saveWebPageProjectAssociation({
      url: 'https://example.com/docs',
      workspaceId: 'workspace-default',
    })

    expect(saved).toMatchObject({
      url: 'https://example.com/docs',
      workspaceId: 'workspace-default',
    })
    expect(existsSync(associationsPath)).toBe(true)
    expect(JSON.parse(readFileSync(associationsPath, 'utf-8'))).toEqual({ associations: [saved] })
    expect(service.getWebPageProjectAssociation('https://example.com/docs')).toEqual(saved)
  })

  test('同一页面改选项目时只保留最近一次关联', () => {
    service.saveWebPageProjectAssociation({ url: 'https://example.com/docs', workspaceId: 'workspace-default' })
    const saved = service.saveWebPageProjectAssociation({ url: 'https://example.com/docs', workspaceId: 'workspace-other' })

    expect(saved.workspaceId).toBe('workspace-other')
    expect(JSON.parse(readFileSync(associationsPath, 'utf-8')).associations).toHaveLength(1)
  })

  test('拒绝非 HTTP(S) 地址和不存在的项目', () => {
    expect(() => service.saveWebPageProjectAssociation({ url: 'file:///tmp/page.html', workspaceId: 'workspace-default' })).toThrow('仅支持 HTTP 或 HTTPS')
    expect(() => service.saveWebPageProjectAssociation({ url: 'https://example.com', workspaceId: 'missing' })).toThrow('项目不存在')
    expect(service.getWebPageProjectAssociation('about:blank')).toBeNull()
  })
})
