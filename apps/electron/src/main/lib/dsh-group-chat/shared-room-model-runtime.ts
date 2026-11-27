import { dirname, join, resolve } from 'node:path'
import {
  type DshRoomModelSelection,
  COPIS_WORKING_MODEL_ENDPOINT_PATH,
  isWorkingCustomModelChannelId,
} from '@copis/shared'
import { getConfigDir, getDesktopModuleEntry } from '../config-paths'
import { resolveDshWorkingReasoningEffort } from '../dsh-model-config'
import { getHttpApiInternalToken } from '../http-api-server'
import { getWorkingApiClient } from '../working-api-service'
import { subscribeWorkingIdentity } from '../working-auth-store'
import { getWorkingCustomModelRuntime } from '../working-model-catalog'
import type { RoomImage } from './attachment-transfer'
import { createSharedRoomSession } from './shared-room-session.mjs'
import { RoomModelError, assertRoomModelOwner, getRoomModelCatalog, supportsRoomCustomModel } from './shared-room-model-catalog'

import { NATIVE_CHANNEL_PREFIX, nativeRoomRoute, type RoomProtocol } from './shared-room-native-models'

export { getRoomModelCatalog }

type Binding = {
  modelSelection?: DshRoomModelSelection
  userId: string
  roomId: string
  roomAgentId: string
  workspaceId: string
  displayName: string
}
type RoomSession = { submit(id: string, prompt: string, images?: RoomImage[]): Promise<string>; revoke(): Promise<void> }
type Route = {
  protocol: RoomProtocol
  reasoning?: string
  baseURL: string
  readKey: () => string
  modelConfig?: Record<string, unknown>
  release?: () => Promise<void>
}
const grantUnavailable = () => new RoomModelError('内置模型的本机授权服务不可用，请确认已登录且服务已就绪')

async function roomGrant(base: string, command: object) {
  try {
    const token = getHttpApiInternalToken()
    if (!token || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw grantUnavailable()
    const response = await fetch(`${base}/api/internal/shared-room-model-capability`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', 'X-Copis-Internal-Token': token },
      body: JSON.stringify(command),
    })
    if (response.ok) return await response.json()
  } catch { /* 网络、地址及授权响应细节不向调用方公开。 */ }
  throw grantUnavailable()
}

async function resolveRoute({ channelId: provider, modelId: model }: DshRoomModelSelection, owner: string): Promise<Route> {
  if (provider.startsWith(NATIVE_CHANNEL_PREFIX)) return nativeRoomRoute(owner, provider, model)
  if (isWorkingCustomModelChannelId(provider)) {
    // 只解密此群主选中的一条模型凭据。
    const read = () => {
      try {
        return getWorkingCustomModelRuntime(provider, true, owner)
      } catch {
        throw new RoomModelError('自定义模型配置已移除或凭据无法读取')
      }
    }
    const { model: config } = read()
    if (model !== config.modelId || !supportsRoomCustomModel(config)) throw new RoomModelError('所选自定义模型的配置已失效')
    return {
      baseURL: config.baseUrl,
      protocol: config.protocol,
      reasoning: config.thinkingLevel,
      readKey() {
        const current = read()
        if (current.model.modelId !== model || current.model.baseUrl !== config.baseUrl || current.model.protocol !== config.protocol)
          throw new RoomModelError('所选自定义模型的配置已变更')
        return current.apiKey
      },
    }
  }
  const base = getWorkingApiClient().baseUrl
  const grant = await roomGrant(base, {
    action: 'issue',
    userId: owner,
    modelId: model,
    reasoningEffort: resolveDshWorkingReasoningEffort(),
  })
  // 旧版 Rust 不支持窄授权时绝不退回长期 DSH capability。
  const capability = grant?.capability
  if (typeof capability !== 'string' || !/^cwm_room_[a-f0-9]{64}$/.test(capability)) throw grantUnavailable()
  return {
    protocol: 'openai-responses',
    baseURL: base + COPIS_WORKING_MODEL_ENDPOINT_PATH,
    readKey: () => capability,
    release: async () => {
      await roomGrant(base, { action: 'revoke', capability })
    },
  }
}

/** 仅供已核对绑定的主进程执行端调用。工作区 ID 不是文件访问授权。 */
export async function openRoomModelRuntime(binding: Binding): Promise<RoomSession & { modelSelection: DshRoomModelSelection }> {
  try {
    return await openBoundRuntime(binding)
  } catch (error) {
    if (error instanceof RoomModelError) throw error
    throw new RoomModelError('共享模型运行时初始化失败，请检查本机模块与账号配置')
  }
}

async function openBoundRuntime(binding: Binding) {
  const { userId, roomId, roomAgentId, workspaceId, displayName } = binding
  if (
    [userId, roomId, roomAgentId, workspaceId, displayName].some(
      (id) => typeof id !== 'string' || !id.trim() || id.length > 128,
    )
  )
    throw new RoomModelError('缺少有效的群主或智能体绑定')
  const client = getWorkingApiClient()
  const revision = client.getIdentityRevision()
  let revoked = false
  const assertActive = () => {
    if (revoked || client.getIdentityRevision() !== revision) throw new RoomModelError('共享已撤回或群主账号已切换')
    assertRoomModelOwner(userId)
  }
  assertActive()
  const { current: modelSelection } = getRoomModelCatalog(userId, binding.modelSelection)
  if (!modelSelection) throw new RoomModelError('所选模型配置不可用，请重新选择有凭据的可用模型')
  const entry = getDesktopModuleEntry('dsh')
  if (!entry) throw new RoomModelError('共享模型所需的 DSH 运行时未安装或未激活')
  let route: Route | undefined
  let session: RoomSession | undefined
  let unsubscribe: (() => void) | undefined
  let disposing: Promise<void> | undefined
  function revoke() {
    revoked = true
    unsubscribe?.()
    return (disposing ??= Promise.all([session?.revoke(), route?.release?.()]).then(() => {}))
  }
  try {
    route = await resolveRoute(modelSelection, userId)
    assertActive()
    if (modelSelection.channelId.startsWith(NATIVE_CHANNEL_PREFIX)) route.readKey()
    // 本文件和 session 静态打入 main.cjs；只有已激活模块内的 RC2 包走原生 ESM import。
    const active: RoomSession = await createSharedRoomSession({
      runtimeDir: resolve(dirname(entry), '../runtime'),
      provider: modelSelection.channelId,
      model: modelSelection.modelId,
      transport: {
        protocol: route.protocol,
        baseURL: route.baseURL,
        reasoning: route.reasoning,
        modelConfig: route.modelConfig,
        readKey: route.readKey,
        assertActive,
      },
      documents: [],
      responsibility: displayName,
      ownerId: userId,
      roomId,
      agentId: roomAgentId,
      journalDir: join(getConfigDir(), 'shared-room-model-invocations'),
    }).catch(() => { throw new RoomModelError('共享模型适配器加载失败，请检查 DSH 模块版本与模型凭据') })
    session = active
    assertActive()
    // 适配器异步注册期间配置可能被移除；交给执行端前再核对选中的路由。
    if (isWorkingCustomModelChannelId(modelSelection.channelId) || modelSelection.channelId.startsWith(NATIVE_CHANNEL_PREFIX)) route.readKey()
    unsubscribe = subscribeWorkingIdentity((id) => {
      if (String(id ?? '') !== userId) void revoke().catch(() => {})
    })
    return {
      modelSelection,
      async submit(id: string, prompt: string, images?: RoomImage[]) {
        assertActive()
        const answer = await active.submit(id, prompt, images)
        assertActive()
        return answer
      },
      revoke,
    }
  } catch (error) {
    await revoke().catch(() => {})
    throw error
  }
}
