import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, posix, win32 } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DshRoomModelCatalog, DshRoomModelSelection, DshSharedRoomCommand } from '@copis/shared'

import type { RoomBinding } from './shared-room-executor'

type ModelCommand = Extract<DshSharedRoomCommand, {action: 'roomModelOptions' | 'setRoomModel'}>
interface ModelDependencies {
  detail: (roomId: string) => Promise<unknown>
  catalog: (user: string, active?: DshRoomModelSelection) => DshRoomModelCatalog
  active: (binding: RoomBinding) => DshRoomModelSelection | undefined
  prepare: (binding: RoomBinding, selection: DshRoomModelSelection) => Promise<{ commit(persist: () => void): void; discard(): Promise<void> }>
}

type Manage = Extract<DshSharedRoomCommand, {action: 'agentOptions' | 'registerAgent' | 'removeAgent'}>
export type SharedRoomInternalCommand = {action:'internalMarkDshShared';roomId:string;roomAgentId:string;deviceId:string} | {action:'internalRegisterAgent';roomId:string;operationId:string;deviceId:string;displayName:string} | {action:'internalRemoveAgent';roomId:string;operationId:string;deviceId:string;roomAgentId:string} | {action:'internalAgentOperationStatus';roomId:string;operationId:string;deviceId:string}
type Entry = { user: string; device: string; room: string; operation: string; action: 'register'|'remove'; workspace?: string; name?: string; agent?: string; done?: boolean; notFound?: boolean }
type State = {version:1; operations:Entry[]; bindings:{user:string;device:string;room:string;workspace:string;agent:string;name?:string;modelSelection?:DshRoomModelSelection}[]}
const validId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v)
function keys(value: object, allowed: string[]) { return Object.keys(value).every(k => allowed.includes(k)) }

function isActiveHostBinding(raw: unknown, binding: RoomBinding): boolean {
  if (!raw || typeof raw !== 'object' || !('room' in raw) || !('agents' in raw)) return false
  const room = raw.room as Record<string, unknown> | null
  if (room?.roomId !== binding.roomId || room.status !== 'active' || String(room.hostUserId) !== binding.userId) return false
  return Array.isArray(raw.agents) && raw.agents.length === 1 && raw.agents.some(a =>
    a?.roomId === binding.roomId && a.roomAgentId === binding.roomAgentId && String(a.ownerUserId) === binding.userId)
}

export class SharedRoomAgents {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private root:string, private file:string, private device:()=>string, private send:(user:string, command:SharedRoomInternalCommand)=>Promise<unknown>, private currentUser:()=>string | undefined, private identityRevision:()=>number = () => 0) {}
  command(user:string, command:Manage, revision = this.identityRevision()): Promise<unknown> {
    if (!user || this.currentUser() !== user || this.identityRevision() !== revision) throw new Error('共享群账号已切换，请重新打开')
    const run = this.tail.then(() => this.execute(user, command, revision))
    this.tail = run.catch(() => {})
    return run
  }
  /** 只在群解散回执已确认且身份代次未变化时调用，不删除重放记录。 */
  removeRoomBindings(user:string, roomId:string, revision:number):Promise<void> {
    if (!validId(roomId) || !user || this.currentUser() !== user || this.identityRevision() !== revision) throw new Error('共享群账号已切换或参数无效')
    const run = this.tail.then(() => {
      if (this.currentUser() !== user || this.identityRevision() !== revision) throw new Error('共享群账号已切换，已丢弃旧响应')
      const state = this.read()
      const bindings = state.bindings.filter(binding => binding.user !== user || binding.room !== roomId)
      if (bindings.length !== state.bindings.length) { state.bindings = bindings; this.write(state) }
    })
    this.tail = run.catch(() => {})
    return run
  }
  /** 仅恢复当前账号、当前设备且仍存在的工作区绑定。 */
  executorBindings(user:string): RoomBinding[] {
    if (!user || this.currentUser() !== user) return []
    const device = this.device()
    const state = this.read()
    const workspaces = this.workspaces()
    return state.bindings.flatMap(binding => {
      if (!binding || binding.user !== user || binding.device !== device || !validId(binding.room) || !validId(binding.agent) || !validId(binding.workspace)) return []
      if (state.operations.some(op => op && op.user === user && op.device === device && op.room === binding.room && op.agent === binding.agent && op.action === 'remove' && !op.done && !op.notFound)) return []
      if (state.bindings.filter(other => other && other.user === user && other.device === device && other.room === binding.room && (other.agent === binding.agent || other.workspace === binding.workspace)).length !== 1) return []
      const workspace = workspaces.find(w => w.id === binding.workspace)
      if (!workspace) return []
      return [{userId:user,deviceId:device,roomId:binding.room,roomAgentId:binding.agent,workspaceId:binding.workspace,displayName:binding.name || workspace.name,...(binding.modelSelection ? { modelSelection: binding.modelSelection } : {})}]
    })
  }
  /** 与登记、移除共用串行队列，准备模型期间不能把选择写到已替换的绑定。 */
  modelCommand(user: string, command: ModelCommand, revision: number, deps: ModelDependencies) {
    const run = this.tail.then(() => this.manageModel(user, command, revision, deps))
    this.tail = run.catch(() => {})
    return run
  }
  private async manageModel(user: string, command: ModelCommand, revision: number, deps: ModelDependencies) {
    const editing = command.action === 'setRoomModel'
    if (!validId(command.roomId) || !validId(command.roomAgentId) ||
        !keys(command, ['action', 'roomId', 'roomAgentId', ...(editing ? ['modelId', 'channelId'] : [])]))
      throw new Error('群智能体模型参数无效')
    const currentBinding = () => {
      if (!user || this.currentUser() !== user || this.identityRevision() !== revision) throw new Error('共享群账号已切换')
      const match = this.executorBindings(user).find(b => b.roomId === command.roomId && b.roomAgentId === command.roomAgentId)
      if (!match) throw new Error('只能在共享此智能体的群主设备上修改模型')
      return match
    }
    const binding = currentBinding()
    const authorize = async () => {
      const detail = await deps.detail(binding.roomId)
      const current = currentBinding()
      if (current.deviceId !== binding.deviceId || current.workspaceId !== binding.workspaceId || !isActiveHostBinding(detail, binding))
        throw new Error('群主权限或智能体绑定已变化，请重新打开管理菜单')
    }
    await authorize()
    const catalog = deps.catalog(user, deps.active(binding) ?? binding.modelSelection)
    if (!editing) return catalog
    if (!catalog.options.some(o => o.channelId === command.channelId && o.modelId === command.modelId))
      throw new Error('所选模型不在当前账号可用的回答模型中')
    const selection = { channelId: command.channelId, modelId: command.modelId }
    const prepared = await deps.prepare(binding, selection)
    try {
      await authorize()
      prepared.commit(() => {
        currentBinding()
        const state = this.read()
        const record = state.bindings.find(b => b.user === user && b.device === binding.deviceId &&
          b.room === binding.roomId && b.agent === binding.roomAgentId && b.workspace === binding.workspaceId)
        if (!record) throw new Error('群智能体绑定已变化')
        record.modelSelection = selection
        this.write(state)
      })
      return selection
    } catch (error) {
      await prepared.discard()
      throw error
    }
  }
  private read(): State {
    try {
      const value = JSON.parse(readFileSync(this.file,'utf8'))
      if (value.version !== 1 || !Array.isArray(value.operations) || !Array.isArray(value.bindings)) throw new Error('格式错误')
      return value
    } catch (error: any) {
      if (error.code === 'ENOENT') return {version:1, operations:[], bindings:[]}
      throw new Error('共享群本地绑定配置无法读取')
    }
  }
  private write(state:State) {
    mkdirSync(dirname(this.file), {recursive:true, mode:0o700})
    const temp = `${this.file}.${randomUUID()}.tmp`
    try { writeFileSync(temp, JSON.stringify(state), {mode:0o600, flag:'wx'}); renameSync(temp,this.file) } finally { rmSync(temp,{force:true}) }
  }
  private workspaces(): {id:string;name:string}[] {
    let data: any
    try { data = JSON.parse(readFileSync(join(this.root,'storages','workspace.json'),'utf8')) }
    catch (error:any) { if (error.code === 'ENOENT') return []; throw new Error('DSH 工作区配置无法读取') }
    if (data?.unit?.name !== 'workspace' || data?.unit?.version !== 2 || !Array.isArray(data?.global?.workspaceIds) || !data?.tables?.workspaces) throw new Error('DSH 工作区配置格式无效')
    return data.global.workspaceIds.flatMap((id:unknown) => {
      if (!validId(id)) return []
      const record = data.tables.workspaces[id]
      const path = record?.path
      let name = typeof record?.title === 'string' ? record.title.trim() : ''
      if (!name && typeof path === 'string') {
        if (posix.isAbsolute(path)) name = posix.basename(path)
        else if (win32.isAbsolute(path)) name = win32.basename(path)
      }
      return name && name !== '.' && name !== '..' && !/[\/\\]/.test(name) && !/\p{Cc}/u.test(name) && Buffer.byteLength(name,'utf8') <= 128 ? [{id,name}] : []
    })
  }
  private async recover(state:State, pending:Entry, revision:number): Promise<string | undefined> {
    let receipt: any
    try {
      receipt = await this.send(pending.user,{action:'internalAgentOperationStatus',roomId:pending.room,operationId:pending.operation,deviceId:pending.device})
    } catch (error: any) {
      if (this.currentUser() !== pending.user || this.identityRevision() !== revision) throw new Error('共享群账号已切换，已丢弃旧响应')
      if (error?.status === 404 && error?.code === 'management_operation_not_found') {
        pending.notFound = true
        this.write(state)
        return undefined
      }
      throw error
    }
    if (this.currentUser() !== pending.user || this.identityRevision() !== revision) throw new Error('共享群账号已切换，已丢弃旧响应')
    if (!receipt || !validId(receipt.roomAgentId)) throw new Error('共享群管理回执无效')
    pending.agent = receipt.roomAgentId; pending.done = true
    state.bindings = state.bindings.filter(b => !(b.user === pending.user && b.device === pending.device && b.room === pending.room && b.workspace === pending.workspace))
    state.bindings.push({user:pending.user,device:pending.device,room:pending.room,workspace:pending.workspace!,agent:pending.agent!,name:pending.name})
    this.write(state)
    return pending.agent
  }
  private async execute(user:string, command:Manage, revision:number): Promise<unknown> {
    if (this.currentUser() !== user || this.identityRevision() !== revision) throw new Error('共享群账号已切换，请重新打开')
    const device = this.device()
    if (!validId(device) || !command || typeof command !== 'object') throw new Error('共享群参数无效')
    const state = this.read()
    if (command.action === 'agentOptions') {
      if (!keys(command,['action','roomId']) || (command.roomId !== undefined && !validId(command.roomId))) throw new Error('共享群参数无效')
      if (command.roomId) {
        for (const pending of state.operations.filter(e => e.user === user && e.device === device && e.room === command.roomId && e.action === 'register' && !e.done && !e.notFound)) {
          await this.recover(state, pending, revision)
        }
      }
      const workspaces = this.workspaces()
      const options = workspaces.map(w => {
        const binding = state.bindings.find(b => b.user === user && b.device === device && b.room === command.roomId && b.workspace === w.id)
        return binding ? {...w,roomAgentId:binding.agent} : w
      })
      for (const binding of state.bindings) {
        if (binding.user !== user || binding.device !== device || binding.room !== command.roomId || workspaces.some(w => w.id === binding.workspace)) continue
        const name = binding.name ?? state.operations.find(e => e.user === user && e.device === device && e.room === binding.room && e.workspace === binding.workspace && e.agent === binding.agent && e.done)?.name
        if (name) options.push({id:binding.workspace,name,roomAgentId:binding.agent})
      }
      return options
    }
    if (!validId(command.roomId) || !validId(command.operationId)) throw new Error('共享群参数无效')
    const register = command.action === 'registerAgent'
    if (register ? !keys(command,['action','roomId','workspaceId','operationId']) || !validId(command.workspaceId) : command.action !== 'removeAgent' || !keys(command,['action','roomId','roomAgentId','operationId']) || !validId(command.roomAgentId)) throw new Error('共享群参数无效')
    const action = register ? 'register' : 'remove'
    let entry = state.operations.find(e => e.user === user && e.device === device && e.room === command.roomId && e.operation === command.operationId)
    if (entry && (entry.action !== action || (register ? entry.workspace !== command.workspaceId : entry.agent !== command.roomAgentId))) throw new Error('共享群操作标识冲突')
    if (!entry && register) {
      const pending = state.operations.find(e => e.user === user && e.device === device && e.room === command.roomId && e.action === 'register' && e.workspace === command.workspaceId && !e.done && !e.notFound)
      if (pending) {
        const agent = await this.recover(state, pending, revision)
        if (agent) {
          state.operations.push({...pending, operation:command.operationId})
          this.write(state)
          return {roomAgentId:agent}
        }
      }
    }
    if (!entry) {
      const workspace = register ? this.workspaces().find(w => w.id === command.workspaceId) : undefined
      if (register && !workspace) throw new Error('工作区不存在或不可用')
      entry = {user, device, room:command.roomId, operation:command.operationId, action, ...(workspace ? {workspace:workspace.id,name:workspace.name} : {agent:command.action === 'removeAgent' ? command.roomAgentId : undefined})}
      state.operations.push(entry); this.write(state)
    }
    if (entry.done) return {roomAgentId:entry.agent}
    const request:SharedRoomInternalCommand = entry.action === 'register'
      ? {action:'internalRegisterAgent',roomId:entry.room,operationId:entry.operation,deviceId:device,displayName:entry.name!}
      : {action:'internalRemoveAgent',roomId:entry.room,operationId:entry.operation,deviceId:device,roomAgentId:entry.agent!}
    const response = await this.send(user,request) as any
    if (this.currentUser() !== user || this.identityRevision() !== revision) throw new Error('共享群账号已切换，已丢弃旧响应')
    if (!response || !validId(response.roomAgentId) || (entry.action === 'remove' && response.roomAgentId !== entry.agent)) throw new Error('共享群管理回执无效')
    entry.agent = response.roomAgentId; entry.done = true
    state.bindings = state.bindings.filter(b => !(b.user === user && b.device === device && b.room === entry!.room && (entry!.action === 'register' ? b.workspace === entry!.workspace : b.agent === entry!.agent)))
    if (entry.action === 'register') state.bindings.push({user,device,room:entry.room,workspace:entry.workspace!,agent:entry.agent!,name:entry.name})
    this.write(state)
    return {roomAgentId:entry.agent}
  }
}
