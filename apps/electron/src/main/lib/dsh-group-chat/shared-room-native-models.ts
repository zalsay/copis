import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { getDshHomeDir } from '../config-paths'
import { getWorkingModelCatalog, getWorkingCustomModelRuntime } from '../working-model-catalog'
import { dshAccountKeyRef, readDshProfilePatch } from '../dsh-profile-patch'
import { workingCustomModelChannelIdFor, type WorkingCustomModel, type WorkingCustomModelProtocol } from '@copis/shared'

export const NATIVE_CHANNEL_PREFIX = 'dsh-native-'
export type RoomProtocol = WorkingCustomModelProtocol | 'openai-completions' | 'google-generative-ai'
export class RoomModelError extends Error {}
export function supportsRoomEndpoint(protocol: unknown, address: unknown): protocol is RoomProtocol {
  if (typeof address !== 'string' || typeof protocol !== 'string' ||
      !['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'].includes(protocol)) return false
  try {
    const url = new URL(address)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}

type NativeModel = {
  channelId: string; modelId: string; name: string; baseURL: string; protocol: RoomProtocol; ref: string; accountChannel?: string
  modelConfig: Record<string, unknown>; reasoning?: string
}

/** 仅枚举原生设置显式保存的自定义路由，不加载插件、环境变量或密钥文件。 */
export function nativeRoomModels(owner: string, accountModels: WorkingCustomModel[]): NativeModel[] {
  try {
    const patch = readDshProfilePatch(join(getDshHomeDir(), 'profiles', 'copis', 'cordis.patch.yml'))
    const entries = patch.filter(e => e?.id === 'llm-pi-ai')
    if (entries.length !== 1 || entries[0].disabled) return []
    const result: NativeModel[] = []
    const accounts = new Map(accountModels.filter(m => m.apiKeyConfigured).map(m => [workingCustomModelChannelIdFor(m.id), m]))
    for (const [route, p] of Object.entries<any>(entries[0].config?.providers ?? {})) {
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(route)) continue
      // 只允许 DSH 原生编辑器为此路由生成的专用凭据引用；不代读宿主或其他渠道的密钥。
      const account = accounts.get(route)
      if (!account && /^(?:copis(?:-|$)|deepseek$)/.test(route)) continue
      const ref = account ? dshAccountKeyRef(owner, account.id) : `${route.toUpperCase().replace(/-/g, '_')}_API_KEY`
      if (p?.apiKeyEnv !== ref || !supportsRoomEndpoint(p.api, p.baseURL) || !Array.isArray(p.models)) continue
      if (account && (account.protocol !== p.api || account.baseUrl.replace(/\/+$/, '') !== p.baseURL.replace(/\/+$/, ''))) continue
      for (const model of p.models) {
        if (typeof model?.id !== 'string' || !model.id.trim() || model.id === account?.modelId) continue
        const name = typeof model.name === 'string' && model.name.trim() || model.id
        const providerName = typeof p.displayName === 'string' && p.displayName.trim() || route
        // 只投影当前模型的能力，不把整个 provider 或其中的 headers 交给群会话。
        const modelConfig = {
          name,
          input: model.input ?? p.defaultInput ?? ['text'],
          contextWindow: model.contextWindow ?? p.defaultContextWindow,
          maxTokens: model.maxTokens ?? p.defaultMaxTokens,
          reasoningEfforts: model.reasoningEfforts,
          compat: model.compat ?? p.compat,
        }
        result.push({
          channelId: NATIVE_CHANNEL_PREFIX + route, modelId: model.id, name: `DSH · ${providerName} · ${name}`,
          protocol: p.api, baseURL: p.baseURL, ref, accountChannel: account && route, modelConfig, reasoning: p.reasoning,
        })
      }
    }
    return result
  } catch { return [] } // 原生 profile 不可用不应影响 Copis 内置和账号模型。
}

function nativeKey(ref: string): string {
  try {
    const fd = openSync(join(getDshHomeDir(), '.credentials.yaml'), 'r')
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error()
      const doc = parseDocument(readFileSync(fd, 'utf8'))
      const key = doc.getIn(['refs', ref])
      if (!doc.errors.length && doc.get('version') === 1 && typeof key === 'string' && key.trim()) return key
    } finally { closeSync(fd) }
  } catch { /* 不公开文件路径、密钥或 YAML 解析错误。 */ }
  throw new RoomModelError('DSH 模型凭据不可用，请在 DSH 模型设置中检查 API Key')
}

export function nativeRoomRoute(owner: string, channelId: string, modelId: string) {
  const lookup = () => nativeRoomModels(owner, getWorkingModelCatalog(true, owner).models).find(m => m.channelId === channelId && m.modelId === modelId)
  const model = lookup()
  if (!model) throw new RoomModelError('所选 DSH 模型已失效')
  return {
    protocol: model.protocol, baseURL: model.baseURL, reasoning: model.reasoning, modelConfig: model.modelConfig,
    readKey() {
      const current = lookup()
      if (!current || current.baseURL !== model.baseURL || current.protocol !== model.protocol || current.ref !== model.ref)
        throw new RoomModelError('所选 DSH 模型配置已变更，请重新选择')
      if (current.accountChannel) {
        // 托管渠道仍由当前 Copis 账号解密；绝不使用 DSH 文件里的托管密钥副本。
        try {
          const {model: trusted, apiKey} = getWorkingCustomModelRuntime(current.accountChannel, true, owner)
          if (trusted.protocol === model.protocol && trusted.baseUrl.replace(/\/+$/, '') === model.baseURL.replace(/\/+$/, '')) return apiKey
        } catch { /* 不公开账号目录的错误细节。 */ }
        throw new RoomModelError('DSH 模型的账号凭据不可用')
      }
      return nativeKey(current.ref)
    },
  }
}
