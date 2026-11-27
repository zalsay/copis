import type { DshRoomModelSelection } from '@copis/shared'
import { app } from 'electron'
import WebSocket from 'ws'
import {createRequire} from 'node:module'
import { join, dirname, resolve } from 'node:path'
import { getConfigDir, getDshHomeDir, getDesktopModuleEntry } from '../config-paths'
import { getOrCreateClientDeviceId } from '../client-device-id'
import { getHttpApiInternalToken } from '../http-api-server'
import { getWorkingApiClient } from '../working-api-service'
import { getWorkingTokenStore, subscribeWorkingIdentity } from '../working-auth-store'
import { SharedRoomAgents } from './shared-room-agents'
import { SharedRoomExecutor, type RoomBinding } from './shared-room-executor'
import { SharedRoomExecutorManager, type PreparedRoomModelChange } from './shared-room-executor-manager'
import {replyWithFiles} from './room-file-reply'
import { createAttachmentTransfer } from './attachment-transfer'
import { authorizeRoomBinding } from './shared-room-authority'

let agents:SharedRoomAgents | undefined
let manager:SharedRoomExecutorManager | undefined
let unsubscribe:(()=>void) | undefined
let unsubscribeClient:(()=>void) | undefined
let reconcileTimer:ReturnType<typeof setInterval> | undefined
export function getSharedRoomAgents():SharedRoomAgents {
  return agents ??= new SharedRoomAgents(getDshHomeDir(),join(getConfigDir(),'dsh-shared-room-agents.json'),getOrCreateClientDeviceId,
    (user, command) => getWorkingApiClient().sharedRoomCommand(user,command,getHttpApiInternalToken()),
    () => { const user = getWorkingApiClient().getCachedUser(); return user ? String(user.id) : undefined },
    () => getWorkingApiClient().getIdentityRevision())
}
function endpoint():string {
  const configured = process.env.COPIS_BACKEND_URL
  if (!configured) throw new Error('共享群后端尚未准备')
  const url = new URL(configured)
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error('共享群后端地址不可信')
  url.protocol = 'wss:'
  url.pathname = `${url.pathname.replace(/\/$/,'')}/api/chatrooms/v2/ws`
  return url.toString()
}
async function openModel(binding:RoomBinding) {
  const { openRoomModelRuntime } = await import('./shared-room-model-runtime')
  return openRoomModelRuntime(binding)
}
function getManager():SharedRoomExecutorManager {
  if (manager) return manager
  const client = getWorkingApiClient()
  return manager = new SharedRoomExecutorManager({
    identityRevision:() => client.getIdentityRevision(),
    read:() => { const user = client.getCachedUser(); return user && getWorkingTokenStore().getToken() ? getSharedRoomAgents().executorBindings(String(user.id)) : [] },
    authorize: async binding => {
      const revision = client.getIdentityRevision()
      const current = () => client.getIdentityRevision() === revision && String(client.getCachedUser()?.id ?? '') === binding.userId && getSharedRoomAgents().executorBindings(binding.userId).some(b => b.roomId === binding.roomId && b.roomAgentId === binding.roomAgentId && b.workspaceId === binding.workspaceId && b.deviceId === binding.deviceId)
      return authorizeRoomBinding(binding,
        () => client.sharedRoomCommand(binding.userId,{action:'detail',roomId:binding.roomId},getHttpApiInternalToken()),
        trusted => client.sharedRoomCommand(trusted.userId,{action:'internalMarkDshShared',roomId:trusted.roomId,roomAgentId:trusted.roomAgentId,deviceId:trusted.deviceId},getHttpApiInternalToken()),current)
    },
    create:(binding,onStopped,onReady,latest) => new SharedRoomExecutor(binding,{
      journalDir:join(getConfigDir(),'dsh-shared-invocation-claims'), onStopped, onReady,
      openModel:() => openModel(latest()),
      replyWithAttachments:async(ids,text,assertActive,ask) => {
        const transfer=createAttachmentTransfer({revision:()=>client.getIdentityRevision(),command:cmd=>client.sharedRoomCommand(binding.userId,cmd,getHttpApiInternalToken())})
        const files=await transfer.downloadInvocationFiles(binding.roomId,ids,assertActive)
        return replyWithFiles(text,files,{assertActive,ask,decode:()=>{
          const entry=getDesktopModuleEntry('dsh');if(!entry)throw new Error('DSH 模块未就绪')
          return createRequire(resolve(dirname(entry),'../runtime/package.json'))('sharp')
        },upload:(name,bytes)=>transfer.upload({roomId:binding.roomId,name,bytes,mimeType:'application/pdf'},assertActive)})
      },
      socket:() => {
        const url = endpoint()
        const token = getWorkingTokenStore().getToken()
        if (!token || String(client.getCachedUser()?.id ?? '') !== binding.userId) throw new Error('共享群认证不可用')
        return new WebSocket(url,{headers:{Authorization:`Bearer ${token}`},followRedirects:false,handshakeTimeout:10000,maxPayload:128*1024})
      },
    }),
  })
}
export function activeRoomModel(binding:RoomBinding):DshRoomModelSelection | undefined {
  return manager?.activeRoomModel(binding)
}
export function prepareRoomModelChange(binding:RoomBinding, selection:DshRoomModelSelection):Promise<PreparedRoomModelChange> {
  return getManager().prepareRoomModelChange(binding,selection,openModel)
}
export function startSharedRoomExecutorService():void {
  if (reconcileTimer) return
  const service = getManager(), client = getWorkingApiClient()
  unsubscribe = subscribeWorkingIdentity(id => {
    if (String(id ?? '') !== String(client.getCachedUser()?.id ?? '')) manager?.suspend()
    queueMicrotask(() => manager?.refresh())
  })
  unsubscribeClient = client.subscribeIdentity(() => { manager?.suspend(); queueMicrotask(() => manager?.refresh()) })
  reconcileTimer = setInterval(() => manager?.refresh(),30000)
  app.once('before-quit', () => { if (reconcileTimer) clearInterval(reconcileTimer); unsubscribe?.(); unsubscribeClient?.(); void manager?.stop() })
  service.refresh()
}
export function suspendSharedRoomExecutors(roomId:string):void { manager?.pauseRoom(roomId) }
export function refreshSharedRoomExecutors(roomId?:string):void { if (roomId) manager?.resumeRoom(roomId); else manager?.refresh() }

export async function stopSharedRoomExecutorService():Promise<void> { if (reconcileTimer) clearInterval(reconcileTimer); unsubscribe?.(); unsubscribeClient?.(); await manager?.stop() }
