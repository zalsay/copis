import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { DshRoomModelSelection } from '@copis/shared'
import type { RoomImage } from './attachment-transfer'
import { readRoomInvocation, type RoomInvocation } from './shared-room-invocation'

export type RoomBinding = { userId:string; deviceId:string; roomId:string; roomAgentId:string; workspaceId:string; displayName:string; modelSelection?:DshRoomModelSelection }
export type RoomModel = { modelSelection?:DshRoomModelSelection; submit(id:string, prompt:string, images?:RoomImage[]):Promise<string>; revoke():Promise<void> }
type Socket = { on(event:string, listener:(...args:any[])=>void):unknown; send(data:string):void; close():void }
type Dependencies = { loadImages?:(ids:string[],assertActive:()=>void)=>Promise<RoomImage[]>; socket:()=>Socket; openModel:(binding:RoomBinding)=>Promise<RoomModel>; journalDir:string; onStopped?:()=>void; onReady?:()=>void; ackTimeoutMs?:number; modelMaxAgeMs?:number; heartbeatMs?:number }
type ModelSlot = { runtime:RoomModel; users:number }
class CommandRejected extends Error { constructor(readonly code:string) { super('共享群命令未获确认') } }
type Pending = { command:string; invocationId?:string; resolve:(status:string)=>void; reject:(error:Error)=>void; timer:ReturnType<typeof setTimeout> }

/** 单个本地绑定对应一个连接；所有 ACK 和调用只属于当前连接。 */
export class SharedRoomExecutor {
  private socket?:Socket
  private model?:ModelSlot
  private draining = new Set<ModelSlot>()
  private stopped = false
  private ready = false
  private snapshotSeen = false
  private recovered = false
  private pending = new Map<string, Pending>()
  private active = new Set<string>()
  private failed = new Set<string>()
  private heartbeat?:ReturnType<typeof setInterval>
  private handshake?:ReturnType<typeof setTimeout>
  private modelExpiry?:ReturnType<typeof setTimeout>
  private renewalNeeded = false
  private opening?:PromiseWithResolvers<void>
  private stopping?:Promise<void>
  constructor(private binding:RoomBinding, private deps:Dependencies) {}
  async start():Promise<void> {
    await this.openReplacement()
    if (this.stopped) return
    try {
      const socket = this.socket = this.deps.socket()
      this.handshake = setTimeout(() => { void this.stop() }, 15000)
      socket.on('open', () => {
        if (!this.stopped) this.send({type:'subscribe',payload:{roomIds:[this.binding.roomId],afterSeq:{[this.binding.roomId]:0},deviceId:this.binding.deviceId,capabilities:['agent-ready-v1','invocation-ack-v1']}})
      })
      socket.on('message', (data:unknown) => { void this.onMessage(data).catch(() => this.stop()) })
      socket.on('error', () => { void this.stop() })
      socket.on('close', () => { void this.stop() })
    } catch (error) { await this.stop(); throw error }
  }
  private send(value:object) { if (this.stopped || !this.socket) throw new Error('共享群连接不可用'); this.socket.send(JSON.stringify(value)) }
  private command(command:string, payload:Record<string,unknown>, invocationId?:string):Promise<string> {
    const requestId = randomUUID()
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('共享群确认超时')); void this.stop() }, this.deps.ackTimeoutMs ?? 10000)
      this.pending.set(requestId,{command, invocationId, resolve,reject,timer})
      try { this.send({type:command,roomId:this.binding.roomId,payload:{...payload,requestId}}) }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error) }
    })
  }
  private async onMessage(data:unknown) {
    if (this.stopped) return
    let frame:any
    try { const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data); if (Buffer.byteLength(raw) > 128*1024) throw new Error(); frame = JSON.parse(raw) } catch { await this.stop(); return }
    if (!frame || typeof frame !== 'object') { await this.stop(); return }
    if (frame.type === 'error') { await this.stop(); return }
    if (frame.roomId !== this.binding.roomId) return
    if (frame.type === 'command.ack') {
      const p = frame.payload; const pending = this.pending.get(p?.requestId)
      if (!pending || p.command !== pending.command || (pending.invocationId && p.invocationId !== pending.invocationId)) return
      clearTimeout(pending.timer); this.pending.delete(p.requestId)
      if (p.ok !== true) pending.reject(new CommandRejected(typeof p.errorCode === 'string' ? p.errorCode : ''))
      else {
        if (pending.command === 'agent.ready') { this.ready = true; if (this.handshake) clearTimeout(this.handshake); this.deps.onReady?.() }
        pending.resolve(typeof p.status === 'string' ? p.status : '')
      }
      return
    }
    if (frame.type === 'room.snapshot') {
      if (this.snapshotSeen) return
      this.snapshotSeen = true
      const p = frame.payload
      const agents = Array.isArray(p?.agents) && p.agents.length === 1 ? p.agents.filter((a:any) => a?.roomAgentId === this.binding.roomAgentId) : []
      const room = p?.room
      if (!Array.isArray(p?.capabilities) || !['agent-ready-v1','invocation-ack-v1'].every(c => p.capabilities.includes(c)) || room?.roomId !== this.binding.roomId || String(room?.hostUserId) !== this.binding.userId || room?.roomKind !== 'dsh_shared' || room?.status !== 'active' || agents.length !== 1 || String(agents[0].ownerUserId) !== this.binding.userId || agents[0].status === 'disabled') { await this.stop(); return }
      return
    }
    if (frame.type === 'room.recovery_ready' && this.snapshotSeen && !this.recovered) {
      this.recovered = true
      await this.command('agent.ready',{roomAgentId:this.binding.roomAgentId})
      if (this.stopped) return
      this.ready = true
      this.heartbeat = setInterval(() => { try { this.send({type:'agent.heartbeat',roomId:this.binding.roomId,payload:{roomAgentId:this.binding.roomAgentId}}) } catch { void this.stop() } }, this.deps.heartbeatMs ?? 60000)
      return
    }
    if (this.recovered) {
      const p = frame.payload
      const hostRemoved = frame.type === 'member.removed' && String(p?.userId ?? '') === this.binding.userId
      const agentDisabled = frame.type === 'agent.updated' && p?.roomAgentId === this.binding.roomAgentId && p?.status === 'disabled'
      const roomRevoked = frame.type === 'room.updated' && ((typeof p?.status === 'string' && p.status !== 'active') || (typeof p?.roomKind === 'string' && p.roomKind !== 'dsh_shared'))
      if (hostRemoved || agentDisabled || roomRevoked) { await this.stop(); return }
    }
    if (frame.type === 'agent.failed' && typeof frame.payload?.invocationId === 'string' && this.active.has(frame.payload.invocationId)) { this.failed.add(frame.payload.invocationId); return }
    if (frame.type !== 'agent.invocation' || !this.ready) return
    const invocation = readRoomInvocation(this.binding, frame)
    if (!invocation || this.active.has(invocation.invocationId)) return
    this.active.add(invocation.invocationId)
    void this.run(invocation).finally(() => { this.active.delete(invocation.invocationId); this.failed.delete(invocation.invocationId); if (this.renewalNeeded && !this.active.size) this.renewModel() })
  }
  private scheduleModelRenewal() {
    // Rust capability 有效期两小时；提前一小时在空闲期准备替代模型。
    this.modelExpiry = setTimeout(() => {
      this.renewalNeeded = true
      if (!this.active.size) this.renewModel()
    },this.deps.modelMaxAgeMs ?? 60 * 60 * 1000)
  }
  get activeModel():DshRoomModelSelection | undefined {
    return this.ready && !this.stopped ? this.model?.runtime.modelSelection : undefined
  }
  commitModel(candidate:RoomModel, persist:()=>void) {
    if (this.stopped) throw new Error('共享群执行器已停止')
    persist()
    this.installModel(candidate)
  }
  private installModel(runtime:RoomModel) {
    const old = this.model
    this.model = {runtime, users:0}
    // 显式切换同时唤醒等待启动/续签的任务；迟到的 open 只清理自己的结果。
    this.opening?.resolve(); this.opening = undefined
    this.renewalNeeded = false
    if (this.modelExpiry) clearTimeout(this.modelExpiry)
    this.scheduleModelRenewal()
    if (old) {
      if (old.users) this.draining.add(old)
      else void old.runtime.revoke().catch(() => {})
    }
  }
  private openReplacement():Promise<void> {
    const request = this.opening = Promise.withResolvers<void>()
    void (async () => {
      try {
        const candidate = await this.deps.openModel(this.binding)
        if (this.stopped || this.opening !== request) await candidate.revoke()
        else this.installModel(candidate)
      } catch (error) {
        if (!this.stopped && this.opening === request) {
          // 当前授权已经失败，同步停止接受提交，不留给重试回调一个假在线窗口。
          void this.stop()
          request.reject(error)
        }
      } finally {
        if (this.opening === request) this.opening = undefined
        request.resolve()
      }
    })()
    return request.promise
  }
  private renewModel() {
    if (this.stopped || this.opening || !this.renewalNeeded) return
    this.renewalNeeded = false
    void this.openReplacement().catch(() => {})
  }
  private async submit({invocationId:id, text, attachmentIds}: RoomInvocation):Promise<string> {
    const slot = this.model!
    slot.users++
    try {
      if (!attachmentIds?.length) return await slot.runtime.submit(id,text)
      const assertActive = () => { if (this.stopped || this.failed.has(id)) throw new Error('群调用已撤销') }
      if (!this.deps.loadImages) throw new Error('群附件服务不可用')
      const images = await this.deps.loadImages(attachmentIds, assertActive)
      assertActive()
      return await slot.runtime.submit(id,text,images)
    }
    finally {
      if (--slot.users === 0 && this.draining.delete(slot)) void slot.runtime.revoke().catch(() => {})
    }
  }
  private async claim(id:string):Promise<boolean> {
    const key = createHash('sha256').update(JSON.stringify([this.binding.userId,this.binding.deviceId,this.binding.roomId,this.binding.roomAgentId,id])).digest('hex')
    await mkdir(this.deps.journalDir,{recursive:true,mode:0o700})
    try { const file = await open(join(this.deps.journalDir,key),'wx',0o600); try { await file.sync() } finally { await file.close() }; return true }
    catch (error:any) { if (error?.code === 'EEXIST') return false; throw error }
  }
  private async run(invocation:RoomInvocation) {
    const id = invocation.invocationId
    try {
      if (this.opening) await this.opening.promise
      if (!await this.claim(id) || this.stopped) return
      const accepted = await this.command('agent.accepted',{invocationId:id},id)
      if (accepted !== 'accepted' && accepted !== 'running') throw new Error('共享群领取状态未确认')
      if (this.failed.has(id)) return
      const running = await this.command('agent.running',{invocationId:id},id)
      if (this.failed.has(id)) return
      if (running !== 'running' || this.stopped || !this.model) throw new Error('共享群运行状态未确认')
    } catch (error) { if (!this.failed.has(id) && !(error instanceof CommandRejected && error.code === 'invocation_state_conflict')) await this.stop(); return }
    let text:string
    try {
      if (invocation.text.length > 32768) throw new Error('共享群消息超过模型上限')
      text = await this.submit(invocation)
      if (this.stopped || this.failed.has(id)) return
      if (typeof text !== 'string' || !text.trim()) throw new Error('共享群模型返回为空')
    } catch {
      if (!this.stopped && !this.failed.has(id)) {
        try { const status = await this.command('agent.failed',{invocationId:id,failureCode:'execution_failed'},id); if (status !== 'failed') throw new Error() }
        catch { await this.stop() }
      }
      return
    }
    try {
      const status = await this.command('agent.completed',{invocationId:id,content:text,mentionAgentIds:[],attachmentIds:[],clientMessageId:randomUUID()},id)
      if (status !== 'completed') throw new Error('共享群完成状态未确认')
    } catch (error) { if (!this.failed.has(id) && !(error instanceof CommandRejected && error.code === 'invocation_state_conflict')) await this.stop() }
  }
  stop():Promise<void> {
    if (this.stopping) return this.stopping
    this.stopped = true; this.ready = false
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.handshake) clearTimeout(this.handshake)
    if (this.modelExpiry) clearTimeout(this.modelExpiry)
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('共享群连接已关闭')) }
    this.pending.clear()
    const socket = this.socket; this.socket = undefined
    const slots = [...this.draining]; if (this.model) slots.push(this.model)
    this.draining.clear(); this.model = undefined
    this.stopping = Promise.allSettled(slots.map(slot => slot.runtime.revoke())).then(() => this.deps.onStopped?.())
    try { socket?.close() } catch {}
    return this.stopping
  }
}
