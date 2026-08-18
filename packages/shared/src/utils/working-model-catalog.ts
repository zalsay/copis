/**
 * Composer 自定义模型配置的校验与展示转换。
 *
 * 自定义模型是独立渠道配置：baseUrl、apiKey、modelId、protocol、
 * thinkingLevel 全部持久化并由主进程在 Pi runtime 动态注册时使用。
 * Renderer 只接触不含明文密钥的视图；保存时通过 apiKey 字段提交新密钥。
 */

import type {
  WorkingCustomModelCategory,
  WorkingCustomModelOption,
  WorkingCustomModelProtocol,
  WorkingCustomModelSaveInput,
  WorkingModelCatalog,
  WorkingModelCatalogSaveInput,
} from '../types/working'
import { workingCustomModelChannelIdFor } from '../types/working'
import type { AgentThinkingLevel } from '../types/agent'

const MAX_MODEL_NAME_LENGTH = 64
const MAX_MODEL_ID_LENGTH = 128
const MAX_CATEGORY_NAME_LENGTH = 64
const MAX_API_KEY_LENGTH = 1024
const UNCATEGORIZED_GROUP_KEY = 'custom:uncategorized'
const CUSTOM_CATEGORY_GROUP_KEY_PREFIX = 'custom:category:'

const WORKING_CUSTOM_PROTOCOLS: readonly WorkingCustomModelProtocol[] = [
  'openai-responses',
  'anthropic-messages',
]

const WORKING_THINKING_LEVELS: readonly AgentThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireTrimmedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label}不能为空`)
  if (trimmed.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`)
  return trimmed
}

function requireHttpUrl(value: unknown, label: string): string {
  const url = requireTrimmedString(value, label, 2048)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`${label}必须是有效的 HTTP(S) 地址`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label}必须是有效的 HTTP(S) 地址`)
  }
  return url
}

function normalizeCategory(value: unknown): WorkingCustomModelCategory {
  if (!isRecord(value)) throw new Error('分类格式不正确')
  return {
    id: requireTrimmedString(value.id, '分类 ID', MAX_MODEL_ID_LENGTH),
    name: requireTrimmedString(value.name, '分类名称', MAX_CATEGORY_NAME_LENGTH),
  }
}

function normalizeProtocol(value: unknown): WorkingCustomModelProtocol {
  if (value === undefined || value === null || value === '') return 'openai-responses'
  const protocol = typeof value === 'string' ? value.trim() : value
  if (typeof protocol !== 'string' || !WORKING_CUSTOM_PROTOCOLS.includes(protocol as WorkingCustomModelProtocol)) {
    throw new Error('协议必须是 openai-responses 或 anthropic-messages')
  }
  return protocol as WorkingCustomModelProtocol
}

function normalizeThinkingLevel(value: unknown): AgentThinkingLevel {
  if (value === undefined || value === null || value === '') return 'high'
  const thinkingLevel = typeof value === 'string' ? value.trim() : value
  if (typeof thinkingLevel !== 'string' || !WORKING_THINKING_LEVELS.includes(thinkingLevel as AgentThinkingLevel)) {
    throw new Error('thinkingLevel 取值不合法')
  }
  return thinkingLevel as AgentThinkingLevel
}

function normalizeModel(value: unknown): WorkingCustomModelSaveInput {
  if (!isRecord(value)) throw new Error('模型配置格式不正确')
  const categoryId = value.categoryId === undefined || value.categoryId === null || value.categoryId === ''
    ? undefined
    : requireTrimmedString(value.categoryId, '分类 ID', MAX_MODEL_ID_LENGTH)
  const apiKey = value.apiKey === undefined
    ? undefined
    : typeof value.apiKey === 'string' && value.apiKey.trim() === ''
      ? ''
      : requireTrimmedString(value.apiKey, 'API Key', MAX_API_KEY_LENGTH)
  return {
    id: requireTrimmedString(value.id, '模型 ID', MAX_MODEL_ID_LENGTH),
    name: requireTrimmedString(value.name, '模型名称', MAX_MODEL_NAME_LENGTH),
    ...(categoryId ? { categoryId } : {}),
    baseUrl: requireHttpUrl(value.baseUrl, 'Base URL'),
    modelId: requireTrimmedString(value.modelId, '模型 ID', MAX_MODEL_ID_LENGTH),
    protocol: normalizeProtocol(value.protocol),
    thinkingLevel: normalizeThinkingLevel(value.thinkingLevel),
    ...(apiKey !== undefined ? { apiKey } : {}),
  }
}

/**
 * 校验并归一化模型管理配置。
 *
 * 校验模型 ID 唯一、分类 ID/名称唯一；模型引用的分类必须存在。
 */
export function normalizeWorkingModelCatalogInput(value: unknown): WorkingModelCatalogSaveInput {
  if (!isRecord(value)) throw new Error('模型配置格式不正确')

  const categories = Array.isArray(value.categories)
    ? value.categories.map(normalizeCategory)
    : []
  const categoryIds = new Set<string>()
  const categoryNames = new Set<string>()
  for (const category of categories) {
    if (categoryIds.has(category.id)) throw new Error(`分类 ID 重复: ${category.id}`)
    if (categoryNames.has(category.name)) throw new Error(`分类名称重复: ${category.name}`)
    categoryIds.add(category.id)
    categoryNames.add(category.name)
  }

  const models = Array.isArray(value.models) ? value.models.map(normalizeModel) : []
  const modelIds = new Set<string>()
  for (const model of models) {
    if (modelIds.has(model.id)) throw new Error(`模型 ID 重复: ${model.id}`)
    modelIds.add(model.id)
    if (model.categoryId !== undefined && !categoryIds.has(model.categoryId)) {
      throw new Error(`模型引用的分类不存在: ${model.categoryId}`)
    }
  }

  return { categories, models }
}

/** 兼容主进程与浏览器桥接使用的简短命名。 */
export const normalizeWorkingModelCatalog = normalizeWorkingModelCatalogInput

/**
 * 将持久化模型与密钥状态转换为 Renderer 可见配置。
 *
 * Renderer 只会看到 apiKeyConfigured，不会看到明文或加密密文。
 */
export function toWorkingModelCatalogView(
  catalog: WorkingModelCatalogSaveInput,
  encryptedApiKeys: Record<string, string>,
): WorkingModelCatalog {
  return {
    categories: catalog.categories,
    models: catalog.models.map((model) => {
      const { apiKey: _apiKey, ...viewModel } = model
      return {
        ...viewModel,
        apiKeyConfigured: Boolean(encryptedApiKeys[model.id]),
      }
    }),
  }
}

/**
 * 将模型管理配置转换为模型选择器选项，按分类分组展示。
 *
 * 每个自定义模型使用独立的虚拟渠道 ID；选择后由主进程按该 ID 在
 * Pi runtime 动态注册渠道，协议与思考深度随请求生效。
 */
export function workingModelCatalogToOptions(
  catalog: WorkingModelCatalog,
  channelName = '自定义模型',
): WorkingCustomModelOption[] {
  const categories = new Map(catalog.categories.map((category) => [category.id, category]))

  return catalog.models.filter((model) => model.apiKeyConfigured).map((model) => {
    const category = model.categoryId ? categories.get(model.categoryId) : undefined
    return {
      channelId: workingCustomModelChannelIdFor(model.id),
      channelName,
      modelId: model.modelId,
      modelName: model.name,
      provider: model.protocol === 'anthropic-messages' ? 'anthropic-compatible' : 'openai-responses',
      categoryId: model.categoryId,
      categoryName: category?.name,
      groupKey: model.categoryId
        ? `${CUSTOM_CATEGORY_GROUP_KEY_PREFIX}${model.categoryId}`
        : UNCATEGORIZED_GROUP_KEY,
      groupName: category?.name ?? '未分类',
      thinkingLevel: model.thinkingLevel,
      protocol: model.protocol,
    }
  })
}

export function workingCustomModelProtocolToProvider(
  protocol: WorkingCustomModelProtocol,
): 'openai-responses' | 'anthropic-compatible' {
  return protocol === 'anthropic-messages' ? 'anthropic-compatible' : 'openai-responses'
}
