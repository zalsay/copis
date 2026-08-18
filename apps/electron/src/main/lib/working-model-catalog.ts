/**
 * VIP 自定义模型目录服务。
 *
 * 模型目录与加密 API Key 按 Working 账号保存在 ~/.copis/working-model-catalog.json。
 * Renderer 只能看到 apiKeyConfigured，不能读取加密密文，也不能通过通用设置更新
 * 绕过专用保存流程。旧版 settings.json 字段只用于一次性兼容迁移。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { safeStorage } from 'electron'
import type {
  Channel,
  WorkingCustomModel,
  WorkingModelCatalog,
  WorkingModelCatalogSaveInput,
  WorkingUser,
} from '@copis/shared'
import {
  EMPTY_WORKING_MODEL_CATALOG,
  isWorkingCustomModelChannelId,
  normalizeWorkingModelCatalogInput,
  toWorkingModelCatalogView,
  workingCustomModelChannelIdFor,
  workingCustomModelIdFromChannelId,
  workingCustomModelProtocolToProvider,
} from '@copis/shared'
import type { AppSettings } from '../../types'
import { getWorkingModelCatalogPath } from './config-paths'
import { getSettings, updateSettings } from './settings-service'

export class WorkingModelCatalogAccessError extends Error {
  readonly code = 'vip_required'

  constructor() {
    super('仅 VIP 用户可使用模型管理')
    this.name = 'WorkingModelCatalogAccessError'
  }
}

export function assertWorkingModelCatalogVip(isVip: boolean): void {
  if (!isVip) throw new WorkingModelCatalogAccessError()
}

/** 将 Working 用户 ID 归一化为本地模型目录的归属键。 */
export function getWorkingModelCatalogOwnerId(
  user: Pick<WorkingUser, 'id' | 'userId'> | null | undefined,
): string | undefined {
  const id = user?.id ?? user?.userId
  return id === undefined || id === null ? undefined : String(id)
}

interface WorkingModelCatalogAccountRecord {
  catalog: WorkingModelCatalog
  apiKeys: Record<string, string>
}

interface WorkingModelCatalogStore {
  version: 1
  accounts: Record<string, WorkingModelCatalogAccountRecord>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function createEmptyWorkingModelCatalogStore(): WorkingModelCatalogStore {
  return { version: 1, accounts: {} }
}

function encryptApiKey(apiKey: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统不支持安全存储，无法保存 API Key')
  }
  try {
    return safeStorage.encryptString(apiKey).toString('base64')
  } catch (error) {
    console.error('[模型管理] 加密 API Key 失败:', error)
    throw new Error('保存 API Key 失败，请稍后重试')
  }
}

function decryptApiKey(encryptedApiKey: string): string | undefined {
  if (!encryptedApiKey || !safeStorage.isEncryptionAvailable()) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(encryptedApiKey, 'base64'))
  } catch (error) {
    console.error('[模型管理] 解密 API Key 失败:', error)
    return undefined
  }
}

function readNormalizedCatalog(settings: AppSettings): WorkingModelCatalogSaveInput {
  if (!settings.workingModelCatalog) return { ...EMPTY_WORKING_MODEL_CATALOG }
  try {
    return normalizeWorkingModelCatalogInput(settings.workingModelCatalog)
  } catch (error) {
    console.warn('[模型管理] 已忽略损坏的模型目录:', error)
    return { ...EMPTY_WORKING_MODEL_CATALOG }
  }
}

function normalizeEncryptedApiKeys(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(([, encrypted]) => typeof encrypted === 'string' && encrypted.length > 0),
  )
}

function getEncryptedApiKeys(settings: AppSettings): Record<string, string> {
  return normalizeEncryptedApiKeys(settings.workingModelApiKeys)
}

function readWorkingModelCatalogStore(): WorkingModelCatalogStore {
  const filePath = getWorkingModelCatalogPath()
  if (!existsSync(filePath)) return createEmptyWorkingModelCatalogStore()

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.accounts)) {
      return createEmptyWorkingModelCatalogStore()
    }

    const accounts: Record<string, WorkingModelCatalogAccountRecord> = {}
    for (const [ownerId, value] of Object.entries(parsed.accounts)) {
      if (!isRecord(value) || !isRecord(value.catalog)) continue
      try {
        const catalog = normalizeWorkingModelCatalogInput(value.catalog)
        const apiKeys = normalizeEncryptedApiKeys(value.apiKeys)
        accounts[ownerId] = {
          catalog: toWorkingModelCatalogView(catalog, apiKeys),
          apiKeys,
        }
      } catch (error) {
        console.warn(`[模型管理] 已忽略账号 ${ownerId} 的损坏模型目录:`, error)
      }
    }
    return { version: 1, accounts }
  } catch (error) {
    console.warn('[模型管理] 读取模型目录文件失败:', error)
    return createEmptyWorkingModelCatalogStore()
  }
}

function writeWorkingModelCatalogStore(store: WorkingModelCatalogStore): void {
  try {
    writeFileSync(getWorkingModelCatalogPath(), JSON.stringify(store, null, 2), 'utf-8')
  } catch (error) {
    console.error('[模型管理] 写入模型目录文件失败:', error)
    throw new Error('写入模型配置失败')
  }
}

function getLegacyAccountRecord(
  settings: AppSettings,
  ownerId: string | undefined,
): WorkingModelCatalogAccountRecord | undefined {
  if (!ownerId || settings.workingModelCatalogOwnerId !== ownerId || !settings.workingModelCatalog) {
    return undefined
  }
  const apiKeys = getEncryptedApiKeys(settings)
  return {
    catalog: toWorkingModelCatalogView(readNormalizedCatalog(settings), apiKeys),
    apiKeys,
  }
}

function readWorkingModelCatalogAccount(
  settings: AppSettings,
  ownerId: string | undefined,
): { store: WorkingModelCatalogStore; account?: WorkingModelCatalogAccountRecord } {
  const store = readWorkingModelCatalogStore()
  if (!ownerId) return { store }

  const account = store.accounts[ownerId] ?? getLegacyAccountRecord(settings, ownerId)
  return { store, account }
}

function buildCatalogView(settings: AppSettings, ownerId?: string): WorkingModelCatalog | undefined {
  return readWorkingModelCatalogAccount(settings, ownerId?.trim()).account?.catalog
}

/** 获取 Renderer 可见的模型目录；调用方必须先完成 VIP 校验。 */
export function getWorkingModelCatalog(isVip: boolean, ownerId?: string): WorkingModelCatalog {
  assertWorkingModelCatalogVip(isVip)
  return buildCatalogView(getSettings(), ownerId) ?? { models: [], categories: [] }
}

/**
 * 保存模型目录与 API Key。
 *
 * apiKey 未提供表示保留原密钥；空字符串表示清除原密钥。删除模型时同步
 * 删除对应密钥，避免本地配置长期积累已失效凭据。
 */
export function saveWorkingModelCatalog(value: unknown, isVip: boolean, ownerId?: string): WorkingModelCatalog {
  assertWorkingModelCatalogVip(isVip)
  if (!ownerId?.trim()) throw new Error('无法识别当前 Working 账号，无法保存模型配置')
  const input = normalizeWorkingModelCatalogInput(value)
  const currentSettings = getSettings()
  const normalizedOwnerId = ownerId.trim()
  const { store, account: currentAccount } = readWorkingModelCatalogAccount(currentSettings, normalizedOwnerId)
  const legacyOwnerId = currentSettings.workingModelCatalogOwnerId
  const legacyAccount = getLegacyAccountRecord(currentSettings, legacyOwnerId)
  if (legacyOwnerId && legacyAccount && !store.accounts[legacyOwnerId]) {
    store.accounts[legacyOwnerId] = legacyAccount
  }
  const previousKeys = currentAccount?.apiKeys ?? {}
  const nextKeys: Record<string, string> = {}

  for (const model of input.models) {
    if (model.apiKey !== undefined) {
      if (model.apiKey === '') continue
      nextKeys[model.id] = encryptApiKey(model.apiKey)
      continue
    }
    const previousKey = previousKeys[model.id]
    if (previousKey) nextKeys[model.id] = previousKey
  }

  const catalog = toWorkingModelCatalogView(input, nextKeys)
  store.accounts[normalizedOwnerId] = { catalog, apiKeys: nextKeys }
  writeWorkingModelCatalogStore(store)
  // 清理旧版 settings.json 字段；旧字段仅用于向新账号分桶文件迁移。
  updateSettings({
    workingModelCatalog: undefined,
    workingModelCatalogOwnerId: undefined,
    workingModelApiKeys: undefined,
  })
  return catalog
}

/**
 * 通用 settings IPC/HTTP 更新的过滤器。
 * 自定义模型必须通过 saveWorkingModelCatalog 保存，防止明文 API Key 被
 * 误写入 settings.json；敏感字段也不能被外部设置更新注入。
 */
export function filterWorkingModelCatalogUpdate(
  updates: Partial<AppSettings>,
  isVip: boolean,
  ownerId?: string,
): Partial<AppSettings> {
  const record = updates as Record<string, unknown>
  if (record.workingModelApiKeys !== undefined) {
    throw new Error('模型 API Key 只能通过模型管理保存')
  }
  if (record.workingModelCatalogOwnerId !== undefined) {
    throw new Error('模型目录归属只能由当前 Working 账号决定')
  }
  if (record.workingModelCatalog !== undefined) {
    assertWorkingModelCatalogVip(isVip)
    throw new Error('模型目录只能通过模型管理保存')
  }
  assertWorkingCustomModelSelection(
    typeof record.agentChannelId === 'string' ? record.agentChannelId : undefined,
    typeof record.agentModelId === 'string' ? record.agentModelId : undefined,
    isVip,
    ownerId,
  )
  return updates
}

/**
 * 对外返回设置时移除密钥字段，并按 VIP 状态隐藏模型目录。
 * 该函数同时用于 Electron IPC 与浏览器 HTTP API，形成统一的脱敏边界。
 */
export function redactWorkingModelCatalog(settings: AppSettings, isVip: boolean, ownerId?: string): AppSettings {
  const {
    workingModelApiKeys: _keys,
    workingModelCatalog: _catalog,
    workingModelCatalogOwnerId: _ownerId,
    ...safeSettings
  } = settings
  const catalog = isVip ? buildCatalogView(settings, ownerId) : undefined
  if (!catalog) return safeSettings
  return {
    ...safeSettings,
    workingModelCatalog: catalog,
  }
}

export interface WorkingCustomModelRuntime {
  model: WorkingCustomModel
  apiKey: string
  channel: Channel
}

/**
 * 根据 Composer 使用的虚拟渠道 ID解析真实运行配置。
 * 每次运行都重新读取设置和密钥，保证删除/修改模型后旧 UI 选择不会越权。
 */
export function getWorkingCustomModelRuntime(
  channelId: string,
  isVip: boolean,
  ownerId?: string,
): WorkingCustomModelRuntime {
  assertWorkingModelCatalogVip(isVip)
  const customModelId = workingCustomModelIdFromChannelId(channelId)
  if (!customModelId) throw new Error(`自定义模型渠道不正确: ${channelId}`)

  const settings = getSettings()
  const account = readWorkingModelCatalogAccount(settings, ownerId?.trim()).account
  const model = account?.catalog.models.find((item) => item.id === customModelId)
  if (!model) throw new Error('自定义模型不存在，请刷新模型管理')

  const encryptedApiKey = account?.apiKeys[model.id]
  const apiKey = encryptedApiKey ? decryptApiKey(encryptedApiKey) : undefined
  if (!apiKey) throw new Error(`自定义模型「${model.name}」尚未配置 API Key`)

  const provider = workingCustomModelProtocolToProvider(model.protocol)
  const now = Date.now()
  const channel: Channel = {
    id: workingCustomModelChannelIdFor(model.id),
    name: model.name,
    provider,
    baseUrl: model.baseUrl,
    apiKey: '',
    models: [{
      id: model.modelId,
      name: model.name,
      enabled: true,
      source: 'manual',
    }],
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }

  return { model, apiKey, channel }
}

/**
 * 校验会话/设置写入的自定义模型选择。
 *
 * 自定义渠道不能只在真正运行时校验，否则非 VIP 或过期 Model ID 仍会被
 * 持久化到会话索引和 settings.json，下一次启动再恢复成无效状态。
 */
export function assertWorkingCustomModelSelection(
  channelId: string | undefined,
  modelId: string | undefined,
  isVip: boolean,
  ownerId?: string,
): void {
  if (!isWorkingCustomModelChannelId(channelId)) return

  const runtime = getWorkingCustomModelRuntime(channelId, isVip, ownerId)
  if (modelId !== undefined && modelId !== runtime.model.modelId) {
    throw new Error('自定义模型 ID 已更新，请刷新模型管理后重试')
  }
}
