import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  CHATROOM_IPC_CHANNELS,
  isProvisionChatRoomAgentInput,
  isRemoveChatRoomAgentInput,
  isSyncChatRoomAgentSkillsInput,
  isUpdateChatRoomAgentInput,
  type ChatRoomAgentLocalConfig,
  type ChatRoomAgentLocalView,
  type ChatRoomLocalRoomConfig,
  type ChatRoomLocalRoomView,
  type ChatRoomPermissionResponse,
} from '@copis/shared'
import { getMainWindow } from '../index'
import { getChatRoomAgentCoordinator, onChatRoomAgentCoordinatorRegistered, type ChatRoomAgentCoordinatorFacade } from '../lib/chatroom-agent-coordinator'

export interface RegisterChatRoomIpcOptions {
  getCoordinator?: () => ChatRoomAgentCoordinatorFacade
  getMainWindow?: typeof import('../index').getMainWindow
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('权限响应参数不正确')
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 2 || typeof record.requestId !== 'string' || !record.requestId.trim()
    || (record.behavior !== 'allow' && record.behavior !== 'deny')) throw new Error('权限响应参数不正确')
}
function requireMethod<T extends (...args: any[]) => any>(value: T | undefined): T {
  if (!value) throw new Error('聊天室协调器尚未初始化')
  return value
}

export function registerChatRoomIpcHandlers(options: RegisterChatRoomIpcOptions = {}): void {
  if (registered) return
  registered = true
  const getCoordinator = options.getCoordinator ?? getChatRoomAgentCoordinator
  const getWindow = options.getMainWindow ?? getMainWindow
  const invoke = (channel: string, handler: (event: IpcMainInvokeEvent, value?: unknown) => unknown): void => {
    ipcMain.handle(channel, handler)
  }
  invoke(CHATROOM_IPC_CHANNELS.LIST_LOCAL_ROOMS, (event) => {
    assertMainSender(event, getWindow)
    const rooms = getCoordinator().listLocalRooms?.() ?? []
    return rooms.map(toRoomView)
  })
  invoke(CHATROOM_IPC_CHANNELS.PROVISION_AGENT, async (event, value) => {
    assertMainSender(event, getWindow)
    if (!isProvisionChatRoomAgentInput(value)) throw new Error('聊天室 Agent 参数不正确')
    return toAgentView(await requireMethod(getCoordinator().provisionAgent)?.call(getCoordinator(), value))
  })
  invoke(CHATROOM_IPC_CHANNELS.UPDATE_AGENT, async (event, value) => {
    assertMainSender(event, getWindow)
    if (!isUpdateChatRoomAgentInput(value)) throw new Error('聊天室 Agent 更新参数不正确')
    return toAgentView(await requireMethod(getCoordinator().updateAgent)?.call(getCoordinator(), value))
  })
  invoke(CHATROOM_IPC_CHANNELS.REMOVE_AGENT, async (event, value) => {
    assertMainSender(event, getWindow)
    if (!isRemoveChatRoomAgentInput(value)) throw new Error('聊天室 Agent 删除参数不正确')
    await requireMethod(getCoordinator().removeAgent)?.call(getCoordinator(), value)
  })
  invoke(CHATROOM_IPC_CHANNELS.SYNC_AGENT_SKILLS, async (event, value) => {
    assertMainSender(event, getWindow)
    if (!isSyncChatRoomAgentSkillsInput(value)) throw new Error('聊天室 Skill 参数不正确')
    return toAgentView(await requireMethod(getCoordinator().syncAgentSkills)?.call(getCoordinator(), value))
  })
  invoke(CHATROOM_IPC_CHANNELS.RESPOND_PERMISSION, async (event, value) => {
    assertMainSender(event, getWindow)
    requireResponse(value)
    await requireMethod(getCoordinator().respondToPermission)?.call(getCoordinator(), value)
  })
  const attachPushListeners = (coordinator: ChatRoomAgentCoordinatorFacade): void => {
    coordinator.onPermissionRequested?.((request) => {
    const win = getWindow()
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(CHATROOM_IPC_CHANNELS.PERMISSION_REQUESTED, request)
    })
    coordinator.onLocalConfigChanged?.((room) => {
    const win = getWindow()
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(CHATROOM_IPC_CHANNELS.LOCAL_CONFIG_CHANGED, toRoomView(room))
    })
  }
  try { attachPushListeners(getCoordinator()) } catch { /* 协调器稍后注册 */ }
  onChatRoomAgentCoordinatorRegistered(attachPushListeners)
}

export const toChatRoomAgentLocalView = toAgentView
export const toChatRoomLocalRoomView = toRoomView
