import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  CHATROOM_IPC_CHANNELS,
  isProvisionChatRoomAgentInput,
  isRemoveChatRoomAgentInput,
  isSyncChatRoomAgentSkillsInput,
  isUpdateChatRoomAgentInput,
  isChatRoomPermissionResponse,
  type ChatRoomAgentLocalConfig,
  type ChatRoomAgentLocalView,
  type ChatRoomLocalRoomConfig,
  type ChatRoomLocalRoomView,
  type ChatRoomPermissionResponse,
  type ChatRoomPermissionRequest,
  type ChatRoomDownloadRequest,
  type ChatRoomTransferResult,
  type ChatRoomTransferState,
} from '@copis/shared'
import { getMainWindow } from '../index'
import { getChatRoomAgentCoordinator, onChatRoomAgentCoordinatorRegistered, type ChatRoomAgentCoordinatorFacade } from '../lib/chatroom-agent-coordinator'
import { getChatRoomAttachmentInboxPath, getChatRoomCosService, type ChatRoomCosService } from '../lib/chatroom-cos-service'
import { ChatRoomWorkspaceStore } from '../lib/chatroom-workspace-store'
import { getOrCreateClientDeviceId } from '../lib/client-device-id'

export interface RegisterChatRoomIpcOptions {
  getCoordinator?: () => ChatRoomAgentCoordinatorFacade
  getMainWindow?: typeof import('../index').getMainWindow
  getCosService?: () => ChatRoomCosService
  /** 校验当前主理人绑定的 Agent，并返回 Main-only inbox 路径。 */
  resolveAgentInboxPath?: (roomId: string, roomAgentId: string, attachmentId: string) => string
}

let registered = false

function assertMainSender(event: IpcMainInvokeEvent, getWindow: typeof getMainWindow): void {
  const mainWindow = getWindow()
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error('不允许的请求来源')
  }
}

function toAgentView(agent: ChatRoomAgentLocalConfig): ChatRoomAgentLocalView {
  return {
    roomAgentId: agent.roomAgentId,
    displayName: agent.displayName,
    sourceWorkspaceId: agent.sourceWorkspaceId,
    channelId: agent.channelId,
    ...(agent.modelId === undefined ? {} : { modelId: agent.modelId }),
    contextMessageCount: agent.contextMessageCount,
    memorySharingEnabled: agent.memorySharingEnabled,
    skillSharingEnabled: agent.skillSharingEnabled,
    ...(agent.skillSnapshotDigest === undefined ? {} : { skillSnapshotDigest: agent.skillSnapshotDigest }),
    archived: agent.archivedAt !== undefined,
  }
}

function toRoomView(room: ChatRoomLocalRoomConfig): ChatRoomLocalRoomView {
  return { roomId: room.roomId, agents: room.agents.map(toAgentView), updatedAt: room.updatedAt }
}

function requireResponse(value: unknown): asserts value is ChatRoomPermissionResponse {
  if (!isChatRoomPermissionResponse(value)) throw new Error('权限响应参数不正确')
}
function requireMethod<T extends (...args: any[]) => any>(value: T | undefined): T {
  if (!value) throw new Error('聊天室协调器尚未初始化')
  return value
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)
}

function isSafeOriginalName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255
    && !/[\\/\u0000-\u001f\u007f]/.test(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
}

function requireTransferInput(value: unknown): asserts value is { transferId: string; roomId: string } {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['transferId', 'roomId'])
    || !isSafeIdentifier(value.transferId) || !isSafeIdentifier(value.roomId)) {
    throw new Error('聊天室传输参数不正确')
  }
}

function requireDownloadInput(value: unknown): asserts value is ChatRoomDownloadRequest {
  if (!isPlainRecord(value) || !isSafeIdentifier(value.transferId) || !isSafeIdentifier(value.roomId) || !isSafeIdentifier(value.attachmentId)) {
    throw new Error('聊天室下载参数不正确')
  }
  if (value.target === 'user') {
    if (!hasExactKeys(value, ['transferId', 'roomId', 'attachmentId', 'target'])) throw new Error('聊天室下载参数不正确')
    return
  }
  if (value.target === 'agent_inbox'
    && hasExactKeys(value, ['transferId', 'roomId', 'attachmentId', 'target', 'roomAgentId'])
    && isSafeIdentifier(value.roomAgentId)) return
  throw new Error('聊天室下载参数不正确')
}

function requireTransferId(value: unknown): asserts value is string {
  if (!isSafeIdentifier(value)) throw new Error('聊天室传输参数不正确')
}

function sanitizeTransferResult(value: unknown): ChatRoomTransferResult {
  if (!isPlainRecord(value) || !isSafeIdentifier(value.transferId)
    || (value.phase !== 'ready' && value.phase !== 'failed' && value.phase !== 'cancelled')) {
    throw new Error('聊天室传输结果不正确')
  }
  const result: ChatRoomTransferResult = { transferId: value.transferId, phase: value.phase }
  if (value.attachmentId !== undefined) {
    if (!isSafeIdentifier(value.attachmentId)) throw new Error('聊天室传输结果不正确')
    result.attachmentId = value.attachmentId
  }
  if (value.originalName !== undefined) {
    if (!isSafeOriginalName(value.originalName)) throw new Error('聊天室传输结果不正确')
    result.originalName = value.originalName
  }
  if (value.errorCode !== undefined) {
    if (typeof value.errorCode !== 'string' || value.errorCode.length === 0 || value.errorCode.length > 128) throw new Error('聊天室传输结果不正确')
    result.errorCode = value.errorCode
  }
  return result
}

function sanitizeTransferState(value: unknown): ChatRoomTransferState | undefined {
  if (!isPlainRecord(value) || !isSafeIdentifier(value.transferId) || !isSafeIdentifier(value.roomId)
    || typeof value.progress !== 'number' || !Number.isFinite(value.progress)
    || typeof value.phase !== 'string') return undefined
  const phases = new Set(['waiting_authorization', 'uploading', 'validating', 'ready', 'downloading', 'failed', 'cancelled'])
  if (!phases.has(value.phase)) return undefined
  const state: ChatRoomTransferState = {
    transferId: value.transferId,
    roomId: value.roomId,
    phase: value.phase as ChatRoomTransferState['phase'],
    progress: Math.max(0, Math.min(1, value.progress)),
  }
  if (value.attachmentId !== undefined && isSafeIdentifier(value.attachmentId)) state.attachmentId = value.attachmentId
  if (value.originalName !== undefined && isSafeOriginalName(value.originalName)) state.originalName = value.originalName
  if (value.errorCode !== undefined && typeof value.errorCode === 'string' && value.errorCode.length > 0 && value.errorCode.length <= 128) state.errorCode = value.errorCode
  return state
}

function defaultResolveAgentInboxPath(roomId: string, roomAgentId: string, attachmentId: string): string {
  if (!isSafeIdentifier(attachmentId)) throw new Error('聊天室下载参数不正确')
  const { getWorkingApiClient } = require('../lib/working-api-service') as typeof import('../lib/working-api-service')
  const room = new ChatRoomWorkspaceStore().read(roomId)
  const userId = getWorkingApiClient().getCachedUser()?.id
  const deviceId = getOrCreateClientDeviceId()
  if (!room || room.hostUserId !== (userId === undefined ? undefined : String(userId)) || room.deviceId !== deviceId) throw new Error('聊天室 Agent 收件箱无权访问')
  const agent = room.agents.find((candidate) => candidate.roomAgentId === roomAgentId && candidate.archivedAt === undefined)
  if (!agent) throw new Error('聊天室 Agent 收件箱无权访问')
  return getChatRoomAttachmentInboxPath(roomId, agent.roomAgentId, attachmentId)
}

function toChatRoomPermissionRequestView(value: unknown): ChatRoomPermissionRequest | undefined {
  if (!isPlainRecord(value)) return undefined
  const stringFields = ['roomId', 'roomAgentId', 'invocationId', 'traceId', 'requestId', 'toolName', 'summary'] as const
  if (stringFields.some((key) => typeof value[key] !== 'string' || value[key].length === 0 || value[key].length > 200_000)) return undefined
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt < value.createdAt) return undefined
  const sender = value.originalSender
  if (!isPlainRecord(sender) || (sender.type !== 'user' && sender.type !== 'agent') || typeof sender.id !== 'string' || sender.id.length === 0 || typeof sender.displayName !== 'string' || sender.displayName.length === 0) return undefined
  if (!Array.isArray(value.invocationChain)) return undefined
  const invocationChain = value.invocationChain.map((entry) => {
    if (!isPlainRecord(entry) || typeof entry.agentId !== 'string' || typeof entry.invocationId !== 'string' || entry.agentId.length === 0 || entry.invocationId.length === 0) return undefined
    return { agentId: entry.agentId, invocationId: entry.invocationId }
  })
  if (invocationChain.some((entry) => entry === undefined)) return undefined
  return {
    roomId: value.roomId as string,
    roomAgentId: value.roomAgentId as string,
    invocationId: value.invocationId as string,
    traceId: value.traceId as string,
    originalSender: { type: sender.type as 'user' | 'agent', id: sender.id as string, displayName: sender.displayName as string },
    invocationChain: invocationChain as Array<{ agentId: string; invocationId: string }>,
    requestId: value.requestId as string,
    toolName: value.toolName as string,
    summary: value.summary as string,
    createdAt: value.createdAt as number,
    expiresAt: value.expiresAt as number,
  }
}

export function registerChatRoomIpcHandlers(options: RegisterChatRoomIpcOptions = {}): void {
  if (registered) return
  registered = true
  const getCoordinator = options.getCoordinator ?? getChatRoomAgentCoordinator
  const getWindow = options.getMainWindow ?? getMainWindow
  const cosService = options.getCosService?.() ?? getChatRoomCosService()
  const resolveAgentInboxPath = options.resolveAgentInboxPath ?? defaultResolveAgentInboxPath
  const invoke = (channel: string, handler: (event: IpcMainInvokeEvent, value?: unknown) => unknown): void => {
    ipcMain.handle(channel, handler)
  }
  cosService.onProgress((value) => {
    const state = sanitizeTransferState(value)
    const win = getWindow()
    if (state && win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(CHATROOM_IPC_CHANNELS.TRANSFER_PROGRESS, state)
    }
  })
  invoke(CHATROOM_IPC_CHANNELS.LIST_LOCAL_ROOMS, (event) => {
    assertMainSender(event, getWindow)
    const rooms = getCoordinator().listLocalRooms?.() ?? []
    return rooms.map(toRoomView)
  })
  invoke(CHATROOM_IPC_CHANNELS.PROVISION_AGENT, async (event, value) => {
    assertMainSender(event, getWindow)
    if (!isProvisionChatRoomAgentInput(value)) throw new Error('聊天室 Agent 参数不正确')
    const coordinator = getCoordinator()
    return toAgentView(await requireMethod(coordinator.provisionAgent).call(coordinator, value))
  })
  invoke(CHATROOM_IPC_CHANNELS.UPDATE_AGENT, async (event, value) => {
    assertMainSender(event, getWindow)
    if (!isUpdateChatRoomAgentInput(value)) throw new Error('聊天室 Agent 更新参数不正确')
    const coordinator = getCoordinator()
    return toAgentView(await requireMethod(coordinator.updateAgent).call(coordinator, value))
  })
  invoke(CHATROOM_IPC_CHANNELS.REMOVE_AGENT, async (event, value) => {
    assertMainSender(event, getWindow)
    if (!isRemoveChatRoomAgentInput(value)) throw new Error('聊天室 Agent 删除参数不正确')
    const coordinator = getCoordinator()
    await requireMethod(coordinator.removeAgent).call(coordinator, value)
  })
  invoke(CHATROOM_IPC_CHANNELS.SYNC_AGENT_SKILLS, async (event, value) => {
    assertMainSender(event, getWindow)
    if (!isSyncChatRoomAgentSkillsInput(value)) throw new Error('聊天室 Skill 参数不正确')
    const coordinator = getCoordinator()
    return toAgentView(await requireMethod(coordinator.syncAgentSkills).call(coordinator, value))
  })
  invoke(CHATROOM_IPC_CHANNELS.RESPOND_PERMISSION, async (event, value) => {
    assertMainSender(event, getWindow)
    requireResponse(value)
    const coordinator = getCoordinator()
    await requireMethod(coordinator.respondToPermission).call(coordinator, value)
  })
  invoke(CHATROOM_IPC_CHANNELS.SELECT_AND_UPLOAD, async (event, value) => {
    assertMainSender(event, getWindow)
    requireTransferInput(value)
    return sanitizeTransferResult(await cosService.selectAndUpload(value))
  })
  invoke(CHATROOM_IPC_CHANNELS.START_DOWNLOAD, async (event, value) => {
    assertMainSender(event, getWindow)
    requireDownloadInput(value)
    if (value.target === 'agent_inbox') resolveAgentInboxPath(value.roomId, value.roomAgentId, value.attachmentId)
    return sanitizeTransferResult(await cosService.download(value))
  })
  invoke(CHATROOM_IPC_CHANNELS.CANCEL_TRANSFER, async (event, value) => {
    assertMainSender(event, getWindow)
    requireTransferId(value)
    await cosService.cancel(value)
  })
  let detachPushListeners: (() => void) | undefined
  const attachPushListeners = (coordinator: ChatRoomAgentCoordinatorFacade | undefined): void => {
    detachPushListeners?.()
    detachPushListeners = undefined
    if (!coordinator) return
    let attached = true
    const detachPermission = coordinator.onPermissionRequested?.((request) => {
    if (!attached) return
    const win = getWindow()
    const safeRequest = toChatRoomPermissionRequestView(request)
    if (safeRequest && win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(CHATROOM_IPC_CHANNELS.PERMISSION_REQUESTED, safeRequest)
    })
    const detachConfig = coordinator.onLocalConfigChanged?.((room) => {
    if (!attached) return
    const win = getWindow()
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(CHATROOM_IPC_CHANNELS.LOCAL_CONFIG_CHANGED, toRoomView(room))
    })
    detachPushListeners = () => { attached = false; detachPermission?.(); detachConfig?.() }
  }
  onChatRoomAgentCoordinatorRegistered(attachPushListeners)
}

export const toChatRoomAgentLocalView = toAgentView
export const toChatRoomLocalRoomView = toRoomView
