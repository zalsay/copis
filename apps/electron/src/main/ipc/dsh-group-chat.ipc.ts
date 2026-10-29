/**
 * DSH 群聊专属 IPC 通道注册层
 * 
 * 严格遵守零交叉原则，使用 DSH_GROUP_CHAT_IPC_CHANNELS，绝不与 chatrooms.ipc.ts 交叉。
 */

import { ipcMain, BrowserWindow } from 'electron'
import {
  DSH_GROUP_CHAT_IPC_CHANNELS,
  type DshCreateGroupInput,
  type DshUpdateGroupInput,
  type DshPostMessageInput,
  type DshCreateTaskInput,
  type DshUpdateTaskInput,
  type DshDecomposeTaskInput,
  type DshGroupChatAgent,
  type DshUpdateAgentModelInput,
} from '@copis/shared'
import { DshGroupChatService } from '../lib/dsh-group-chat/dsh-group-chat-service'

let sharedService: DshGroupChatService | null = null

export function getDshGroupChatService(): DshGroupChatService {
  if (!sharedService) {
    sharedService = new DshGroupChatService()
    // 监听实时事件并广播到渲染进程
    sharedService.addEventListener((event) => {
      const windows = BrowserWindow.getAllWindows()
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send(DSH_GROUP_CHAT_IPC_CHANNELS.EVENT_STREAM, event)
        }
      }
    })
  }
  return sharedService
}

export function registerDshGroupChatIpcHandlers(): void {
  const service = getDshGroupChatService()

  // 0. 创造模式专属工作区
  ipcMain.handle(DSH_GROUP_CHAT_IPC_CHANNELS.LIST_CREATION_WORKSPACES, () => {
    return service.listCreationWorkspaces()
  })

  // 1. 群组与会话管理
  ipcMain.handle(DSH_GROUP_CHAT_IPC_CHANNELS.LIST_GROUPS, () => {
    return service.listGroups()
  })

  ipcMain.handle(DSH_GROUP_CHAT_IPC_CHANNELS.GET_GROUP, (_event, groupId: string) => {
    return service.getGroup(groupId)
  })

  ipcMain.handle(DSH_GROUP_CHAT_IPC_CHANNELS.CREATE_GROUP, (_event, input: DshCreateGroupInput) => {
    return service.createGroup(input)
  })

  ipcMain.handle(DSH_GROUP_CHAT_IPC_CHANNELS.UPDATE_GROUP, (_event, input: DshUpdateGroupInput) => {
    return service.updateGroup(input)
  })

  ipcMain.handle(DSH_GROUP_CHAT_IPC_CHANNELS.DELETE_GROUP, (_event, groupId: string) => {
    return service.deleteGroup(groupId)
  })

  ipcMain.handle(
    DSH_GROUP_CHAT_IPC_CHANNELS.ADD_AGENT,
    (_event, groupId: string, agent: Omit<DshGroupChatAgent, 'addedAt'>) => {
      return service.addAgent(groupId, agent)
    }
  )

  ipcMain.handle(DSH_GROUP_CHAT_IPC_CHANNELS.REMOVE_AGENT, (_event, groupId: string, agentId: string) => {
    return service.removeAgent(groupId, agentId)
  })

  ipcMain.handle(
    DSH_GROUP_CHAT_IPC_CHANNELS.UPDATE_AGENT_RESPONSIBILITY,
    (_event, groupId: string, agentId: string, responsibility: string) => {
      return service.updateAgentResponsibility(groupId, agentId, responsibility)
    }
  )

  ipcMain.handle(
    DSH_GROUP_CHAT_IPC_CHANNELS.UPDATE_AGENT_MODEL,
    (_event, input: DshUpdateAgentModelInput) => {
      return service.updateAgentModel(input)
    }
  )

  ipcMain.handle(DSH_GROUP_CHAT_IPC_CHANNELS.GET_AVAILABLE_MODELS, () => {
    return service.getAvailableModels()
  })

  // 2. 消息流收发与已读标记
  ipcMain.handle(
    DSH_GROUP_CHAT_IPC_CHANNELS.GET_MESSAGES,
    (_event, groupId: string, limit?: number, beforeSeq?: number) => {
      return service.getMessages(groupId, limit, beforeSeq)
    }
  )

  ipcMain.handle(DSH_GROUP_CHAT_IPC_CHANNELS.POST_MESSAGE, (_event, input: DshPostMessageInput) => {
    return service.postMessage(input)
  })

  ipcMain.handle(DSH_GROUP_CHAT_IPC_CHANNELS.MARK_READ, (_event, groupId: string, readSeq: number) => {
    service.markRead(groupId, readSeq)
    return true
  })

  // 3. 任务看板管理
  ipcMain.handle(DSH_GROUP_CHAT_IPC_CHANNELS.GET_TASKS, (_event, groupId: string) => {
    return service.getTasks(groupId)
  })

  ipcMain.handle(DSH_GROUP_CHAT_IPC_CHANNELS.CREATE_TASK, (_event, input: DshCreateTaskInput) => {
    return service.createTask(input)
  })

  ipcMain.handle(DSH_GROUP_CHAT_IPC_CHANNELS.UPDATE_TASK, (_event, input: DshUpdateTaskInput) => {
    return service.updateTask(input)
  })

  ipcMain.handle(DSH_GROUP_CHAT_IPC_CHANNELS.DECOMPOSE_TASKS, (_event, input: DshDecomposeTaskInput) => {
    return service.decomposeTasks(input)
  })

  ipcMain.handle(DSH_GROUP_CHAT_IPC_CHANNELS.ARCHIVE_TASK, (_event, groupId: string, taskId: string) => {
    return service.archiveTask(groupId, taskId)
  })

  // 4. 执行轨迹查询与停止
  ipcMain.handle(DSH_GROUP_CHAT_IPC_CHANNELS.GET_INVOCATION, (_event, groupId: string, invocationId: string) => {
    return service.getInvocation(groupId, invocationId)
  })

  ipcMain.handle(DSH_GROUP_CHAT_IPC_CHANNELS.STOP_INVOCATION, async (_event, groupId: string, invocationId: string) => {
    return service.stopInvocation(groupId, invocationId)
  })
}
