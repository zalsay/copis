import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const testDir = join(tmpdir(), `copis-web-profile-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
const profilesPath = join(testDir, 'web-page-profiles.json')
const legacyPath = join(testDir, 'web-project-associations.json')

const actualConfigPaths = await import('./config-paths')
mock.module('./config-paths', () => ({
  ...actualConfigPaths,
  getWebPageProfilesPath: () => profilesPath,
  getWebProjectAssociationsPath: () => legacyPath,
}))

const service = await import('./web-page-profile-service')

describe('网页 Profile 存储与增量同步', () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test('首次读取且无旧数据时返回空列表', () => {
    expect(service.getWebPageProfiles()).toEqual({ profiles: [] })
  })

  test('无新配置但存在旧版 web-project-associations.json 时自动迁移并持久化', () => {
    writeFileSync(legacyPath, JSON.stringify({
      associations: [
        { url: 'https://copis.example.com/project', workspaceId: 'ws-123', updatedAt: 1000 },
      ],
    }))

    const loaded = service.getWebPageProfiles()
    expect(loaded.profiles).toHaveLength(1)
    expect(loaded.profiles[0]).toMatchObject({
      url: 'https://copis.example.com/project',
      domain: 'copis.example.com',
      workspaceId: 'ws-123',
      version: 1,
      isDeleted: false,
    })
    expect(existsSync(profilesPath)).toBe(true)
  })

  test('保存页面 Profile，更新偏好设置与 AI 上下文记忆', () => {
    const created = service.saveWebPageProfile({
      url: 'https://github.com/copis/app',
      workspaceId: 'ws-dev',
      preferences: { zoomFactor: 1.25, readerMode: 'auto' },
      aiContext: { tags: ['开源', '客户端'], customPrompt: '重点关注 PR 评审' },
    })

    expect(created).toMatchObject({
      url: 'https://github.com/copis/app',
      domain: 'github.com',
      workspaceId: 'ws-dev',
      preferences: { zoomFactor: 1.25, readerMode: 'auto' },
      aiContext: { tags: ['开源', '客户端'], customPrompt: '重点关注 PR 评审' },
      version: 1,
      isDeleted: false,
    })

    // 再次更新同一 URL，版本号自增并合并偏好
    const updated = service.saveWebPageProfile({
      url: 'https://github.com/copis/app',
      preferences: { zoomFactor: 1.5 },
    })

    expect(updated.version).toBe(2)
    expect(updated.preferences.zoomFactor).toBe(1.5)
    expect(updated.preferences.readerMode).toBe('auto')
    expect(updated.workspaceId).toBe('ws-dev')
  })

  test('删除页面 Profile 置为墓碑标记，公开快照过滤但 raw 快照保留', () => {
    const saved = service.saveWebPageProfile({ url: 'https://example.com/remove-me' })
    const profileId = saved.id

    const afterRemove = service.removeWebPageProfile(profileId)
    expect(afterRemove.profiles).toHaveLength(0)

    const raw = service.getWebPageProfilesRaw()
    expect(raw.profiles).toHaveLength(1)
    expect(raw.profiles[0]).toMatchObject({
      id: profileId,
      isDeleted: true,
      version: 2,
    })
    expect(raw.profiles[0]!.deletedAt).toBeGreaterThan(0)
  })

  test('applyRemotePageProfileChanges 支持远端增量合并', () => {
    const remoteProfiles = [
      {
        id: 'remote-p1',
        url: 'https://remote-page.com',
        domain: 'remote-page.com',
        workspaceId: 'ws-remote',
        preferences: { zoomFactor: 1.1 },
        aiContext: { summary: '远程网页摘要' },
        createdAt: 100,
        updatedAt: 200,
        version: 1,
        isDeleted: false,
      },
    ]

    const result = service.applyRemotePageProfileChanges(remoteProfiles)
    expect(result.profiles).toHaveLength(1)
    expect(result.profiles[0]!.url).toBe('https://remote-page.com')
    expect(result.profiles[0]!.aiContext.summary).toBe('远程网页摘要')
  })

  test('purgeExpiredPageProfileTombstones 清理过期墓碑', () => {
    const saved = service.saveWebPageProfile({ url: 'https://expire-profile.com' })
    service.removeWebPageProfile(saved.id)

    service.purgeExpiredPageProfileTombstones(0)
    const raw = service.getWebPageProfilesRaw()
    expect(raw.profiles.some((p) => p.id === saved.id)).toBe(false)
  })
})
