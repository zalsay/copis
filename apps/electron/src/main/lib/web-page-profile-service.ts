/**
 * 网页 Profile 存储与画像管理服务。
 *
 * 管理网页个性化偏好、项目关联及 AI 画像记忆。
 * 本地存储于 ~/.copis/web-page-profiles.json，同时平滑迁移旧版 web-project-associations.json。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  SaveWebPageProfileInput,
  WebPageDisplayPreferences,
  WebPageAiContext,
  WebPageProfile,
  WebPageProfileChange,
  WebPageProfilesSnapshot,
} from '@copis/shared'
import {
  getWebPageProfilesStoragePath,
  getWebProjectAssociationsStoragePath,
} from './web-sync-account-storage'

const profileChangeListeners = new Set<() => void>()

/** 注册网页 Profile 本地变更监听器。 */
export function addPageProfileChangeListener(listener: () => void): () => void {
  profileChangeListeners.add(listener)
  return () => {
    profileChangeListeners.delete(listener)
  }
}

function notifyPageProfileChangeListeners(): void {
  for (const listener of profileChangeListeners) {
    try {
      listener()
    } catch (error) {
      console.error('[网页Profile] 变更监听回调失败:', error)
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeHttpUrl(value: string): string {
  const url = new URL(value.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('网页 Profile 仅支持 HTTP 或 HTTPS 网页')
  }
  return url.toString()
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function parsePreferences(value: unknown): WebPageDisplayPreferences {
  if (!isRecord(value)) return {}
  const preferences: WebPageDisplayPreferences = {}
  if (typeof value.zoomFactor === 'number' && Number.isFinite(value.zoomFactor)) {
    preferences.zoomFactor = value.zoomFactor
  }
  if (value.readerMode === 'auto' || value.readerMode === 'enabled' || value.readerMode === 'disabled') {
    preferences.readerMode = value.readerMode
  }
  if (typeof value.customCss === 'string') {
    preferences.customCss = value.customCss
  }
  if (value.deviceMode === 'desktop' || value.deviceMode === 'mobile') {
    preferences.deviceMode = value.deviceMode
  }
  return preferences
}

function parseAiContext(value: unknown): WebPageAiContext {
  if (!isRecord(value)) return {}
  const aiContext: WebPageAiContext = {}
  if (typeof value.summary === 'string') {
    aiContext.summary = value.summary
  }
  if (Array.isArray(value.tags)) {
    aiContext.tags = value.tags.filter((tag): tag is string => typeof tag === 'string' && !!tag.trim())
  }
  if (Array.isArray(value.keyInsights)) {
    aiContext.keyInsights = value.keyInsights.filter((item): item is string => typeof item === 'string' && !!item.trim())
  }
  if (typeof value.customPrompt === 'string') {
    aiContext.customPrompt = value.customPrompt
  }
  return aiContext
}

function isProfile(value: unknown): value is WebPageProfile {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string'
    && typeof value.url === 'string'
    && typeof value.domain === 'string'
    && (value.workspaceId === null || typeof value.workspaceId === 'string')
    && typeof value.createdAt === 'number'
    && typeof value.updatedAt === 'number'
  )
}

function readLegacyAssociations(): WebPageProfile[] {
  const legacyPath = getWebProjectAssociationsStoragePath()
  if (!existsSync(legacyPath)) return []

  try {
    const parsed: unknown = JSON.parse(readFileSync(legacyPath, 'utf-8'))
    const raw = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.associations)
        ? parsed.associations
        : []

    return raw.flatMap((item): WebPageProfile[] => {
      if (!isRecord(item) || typeof item.url !== 'string' || typeof item.workspaceId !== 'string') return []
      let normalizedUrl: string
      try {
        normalizedUrl = normalizeHttpUrl(item.url)
      } catch {
        return []
      }
      const updatedAt = typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now()
      return [{
        id: randomUUID(),
        url: normalizedUrl,
        domain: extractDomain(normalizedUrl),
        workspaceId: item.workspaceId,
        preferences: {},
        aiContext: {},
        createdAt: updatedAt,
        updatedAt,
        version: 1,
        isDeleted: false,
      }]
    })
  } catch (error) {
    console.warn('[网页Profile] 迁移旧版页面关联失败:', error)
    return []
  }
}

function readSnapshot(): WebPageProfilesSnapshot {
  const path = getWebPageProfilesStoragePath()
  if (!existsSync(path)) {
    // 自动兼容并迁移旧版 web-project-associations.json
    const legacy = readLegacyAssociations()
    if (legacy.length > 0) {
      const snapshot: WebPageProfilesSnapshot = { profiles: legacy }
      writeSnapshot(snapshot, false)
      return snapshot
    }
    return { profiles: [] }
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    const raw = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.profiles)
        ? parsed.profiles
        : []

    const seenIds = new Set<string>()
    const profiles: WebPageProfile[] = []

    for (const item of raw) {
      if (!isRecord(item)) continue
      if (
        typeof item.id !== 'string'
        || typeof item.url !== 'string'
        || typeof item.createdAt !== 'number'
      ) continue

      const id = item.id.trim()
      if (!id || seenIds.has(id)) continue
      seenIds.add(id)

      let normalizedUrl: string
      try {
        normalizedUrl = normalizeHttpUrl(item.url)
      } catch {
        continue
      }

      const domain = typeof item.domain === 'string' && item.domain.trim() ? item.domain.trim() : extractDomain(normalizedUrl)
      const workspaceId = typeof item.workspaceId === 'string' && item.workspaceId.trim() ? item.workspaceId.trim() : null
      const preferences = parsePreferences(item.preferences)
      const aiContext = parseAiContext(item.aiContext)
      const createdAt = item.createdAt
      const updatedAt = typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : createdAt
      const version = typeof item.version === 'number' && Number.isFinite(item.version) ? item.version : 1
      const isDeleted = typeof item.isDeleted === 'boolean' ? item.isDeleted : false
      const deletedAt = typeof item.deletedAt === 'number' && Number.isFinite(item.deletedAt) ? item.deletedAt : undefined

      profiles.push({
        id,
        url: normalizedUrl,
        domain,
        workspaceId,
        preferences,
        aiContext,
        createdAt,
        updatedAt,
        version,
        isDeleted,
        ...(deletedAt !== undefined ? { deletedAt } : {}),
      })
    }

    return { profiles }
  } catch (error) {
    console.warn('[网页Profile] 读取配置失败，将使用空列表:', error)
    return { profiles: [] }
  }
}

function writeSnapshot(snapshot: WebPageProfilesSnapshot, notify = true): WebPageProfilesSnapshot {
  const path = getWebPageProfilesStoragePath()
  mkdirSync(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8')
  try {
    renameSync(tempPath, path)
  } catch (error) {
    rmSync(tempPath, { force: true })
    throw error
  }
  if (notify) {
    notifyPageProfileChangeListeners()
  }
  return snapshot
}

/** 获取全部活跃网页 Profile（过滤已删除项）。 */
export function getWebPageProfiles(): WebPageProfilesSnapshot {
  const snapshot = readSnapshot()
  return {
    profiles: snapshot.profiles.filter((p) => !p.isDeleted),
  }
}

/** 获取完整网页 Profile 快照（包含墓碑项，供同步服务使用）。 */
export function getWebPageProfilesRaw(): WebPageProfilesSnapshot {
  return readSnapshot()
}

/** 根据页面 URL 查找对应的网页 Profile。 */
export function getWebPageProfile(url: string): WebPageProfile | null {
  let normalizedUrl: string
  try {
    normalizedUrl = normalizeHttpUrl(url)
  } catch {
    return null
  }

  const active = getWebPageProfiles().profiles
  // 精确 URL 优先
  const exact = active.find((item) => item.url === normalizedUrl)
  if (exact) return exact

  // 跨路径同域名兜底匹配（若有相同域名的配置）
  const targetDomain = extractDomain(normalizedUrl)
  if (!targetDomain) return null
  return active.find((item) => item.domain === targetDomain) ?? null
}

/** 保存或更新网页 Profile；以规范化 URL 为唯一标识。 */
export function saveWebPageProfile(input: SaveWebPageProfileInput): WebPageProfile {
  if (!input || typeof input !== 'object' || typeof input.url !== 'string') {
    throw new Error('网页 Profile 参数不正确')
  }

  const normalizedUrl = normalizeHttpUrl(input.url)
  const domain = extractDomain(normalizedUrl)
  const current = readSnapshot()
  const existing = current.profiles.find((p) => p.url === normalizedUrl)
  const now = Date.now()

  let savedProfile: WebPageProfile

  if (existing) {
    savedProfile = {
      ...existing,
      domain,
      workspaceId: input.workspaceId !== undefined ? (input.workspaceId?.trim() || null) : existing.workspaceId,
      preferences: {
        ...existing.preferences,
        ...(input.preferences ? parsePreferences(input.preferences) : {}),
      },
      aiContext: {
        ...existing.aiContext,
        ...(input.aiContext ? parseAiContext(input.aiContext) : {}),
      },
      updatedAt: now,
      version: (existing.version ?? 1) + 1,
      isDeleted: false,
      deletedAt: undefined,
    }
    writeSnapshot({
      profiles: current.profiles.map((p) => (p.id === existing.id ? savedProfile : p)),
    })
  } else {
    savedProfile = {
      id: randomUUID(),
      url: normalizedUrl,
      domain,
      workspaceId: input.workspaceId?.trim() || null,
      preferences: parsePreferences(input.preferences),
      aiContext: parseAiContext(input.aiContext),
      createdAt: now,
      updatedAt: now,
      version: 1,
      isDeleted: false,
    }
    writeSnapshot({
      profiles: [savedProfile, ...current.profiles],
    })
  }

  return savedProfile
}

/** 删除指定网页 Profile（软删除标记墓碑）。 */
export function removeWebPageProfile(profileId: string): WebPageProfilesSnapshot {
  const current = readSnapshot()
  const target = current.profiles.find((p) => p.id === profileId)
  if (!target) return getWebPageProfiles()

  const now = Date.now()
  writeSnapshot({
    profiles: current.profiles.map((p) =>
      p.id === profileId
        ? {
          ...p,
          isDeleted: true,
          deletedAt: now,
          updatedAt: now,
          version: (p.version ?? 1) + 1,
        }
        : p,
    ),
  })
  return getWebPageProfiles()
}

/** 批量合并远端增量变更（供同步服务调用）。 */
export function applyRemotePageProfileChanges(remoteProfiles: WebPageProfileChange[]): WebPageProfilesSnapshot {
  const current = readSnapshot()
  const profileMap = new Map(current.profiles.map((p) => [p.id, { ...p }]))

  for (const remote of remoteProfiles) {
    const existing = profileMap.get(remote.id)
    if (!existing) {
      profileMap.set(remote.id, { ...remote })
    } else if (remote.updatedAt >= (existing.updatedAt ?? existing.createdAt)) {
      profileMap.set(remote.id, { ...remote })
    }
  }

  return writeSnapshot({ profiles: Array.from(profileMap.values()) }, false)
}

/** 定时清理超过保留期的本地墓碑记录（默认 30 天）。 */
export function purgeExpiredPageProfileTombstones(maxAgeMs = 30 * 24 * 60 * 60 * 1000): void {
  const current = readSnapshot()
  const threshold = Date.now() - maxAgeMs
  const profiles = current.profiles.filter((p) => !p.isDeleted || (p.deletedAt ?? 0) > threshold)
  if (profiles.length !== current.profiles.length) {
    writeSnapshot({ profiles }, false)
  }
}
