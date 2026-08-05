import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { SaveWebPageProjectAssociationInput, WebPageProjectAssociation } from '@copis/shared'
import { getWebProjectAssociationsPath } from './config-paths'
import { getAgentWorkspace } from './agent-workspace-manager'

interface StoredAssociations {
  associations: WebPageProjectAssociation[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isAssociation(value: unknown): value is WebPageProjectAssociation {
  if (!isRecord(value)) return false
  return typeof value.url === 'string'
    && typeof value.workspaceId === 'string'
    && typeof value.updatedAt === 'number'
}

function normalizeHttpUrl(value: string): string {
  const url = new URL(value.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('页面项目关联仅支持 HTTP 或 HTTPS 网页')
  }
  return url.toString()
}

function readAssociations(): WebPageProjectAssociation[] {
  const path = getWebProjectAssociationsPath()
  if (!existsSync(path)) return []

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    const raw = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.associations)
        ? parsed.associations
        : []
    return raw.filter(isAssociation)
  } catch (error) {
    console.warn('[网页项目关联] 读取配置失败，将使用空关联列表:', error)
    return []
  }
}

function writeAssociations(associations: WebPageProjectAssociation[]): void {
  const path = getWebProjectAssociationsPath()
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  const payload: StoredAssociations = { associations }
  writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
  try {
    renameSync(tempPath, path)
  } catch (error) {
    rmSync(tempPath, { force: true })
    throw error
  }
}

/** 查找当前页面上次关联的 Agent 项目。 */
export function getWebPageProjectAssociation(url: string): WebPageProjectAssociation | null {
  let normalizedUrl: string
  try {
    normalizedUrl = normalizeHttpUrl(url)
  } catch {
    return null
  }

  return readAssociations().find((item) => item.url === normalizedUrl) ?? null
}

/** 保存页面与 Agent 项目的关联；同一 URL 只保留最近一次选择。 */
export function saveWebPageProjectAssociation(input: SaveWebPageProjectAssociationInput): WebPageProjectAssociation {
  if (!input || typeof input !== 'object') throw new Error('页面项目关联参数不正确')
  if (typeof input.workspaceId !== 'string' || !input.workspaceId.trim()) {
    throw new Error('页面项目关联缺少项目 ID')
  }

  const workspace = getAgentWorkspace(input.workspaceId)
  if (!workspace) throw new Error('页面项目关联的项目不存在')

  const normalizedUrl = normalizeHttpUrl(input.url)
  const association: WebPageProjectAssociation = {
    url: normalizedUrl,
    workspaceId: workspace.id,
    updatedAt: Date.now(),
  }
  const next = readAssociations().filter((item) => item.url !== normalizedUrl)
  next.push(association)
  writeAssociations(next)
  return association
}
