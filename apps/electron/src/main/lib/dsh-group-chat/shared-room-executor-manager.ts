import type { DshRoomModelSelection } from '@copis/shared'
import type { RoomBinding, RoomModel, SharedRoomExecutor } from './shared-room-executor'

type Managed = Pick<SharedRoomExecutor,'start'|'stop'|'activeModel'|'commitModel'>
export type PreparedRoomModelChange = { commit(persist:()=>void):void; discard():Promise<void> }
type Dependencies = { read:()=>RoomBinding[]; identityRevision?:()=>number; authorize?:(binding:RoomBinding)=>Promise<boolean>; create:(binding:RoomBinding, onStopped:()=>void, onReady:()=>void, latest:()=>RoomBinding)=>Managed; retryMs?:number; retryMaxMs?:number; readyStableMs?:number }
type Entry = { binding:RoomBinding; item?:Managed; timer?:ReturnType<typeof setTimeout>; stableTimer?:ReturnType<typeof setTimeout>; starting:boolean; failures:number }
export const roomRetryDelay = (failures:number, base=5000, max=300000) => Math.min(max, base * 2 ** Math.min(failures, 30))
const keyOf = (b:RoomBinding) => JSON.stringify([b.userId,b.deviceId,b.roomId,b.roomAgentId,b.workspaceId,b.displayName])
const sameModel = (a?:DshRoomModelSelection,b?:DshRoomModelSelection) => a?.channelId === b?.channelId && a?.modelId === b?.modelId
const stale = () => new Error('群智能体绑定或执行器已变化，请重试')
/** 每个绑定独立生命周期；只有身份失效或退出才全量停止。 */
export class SharedRoomExecutorManager {
  private entries = new Map<string,Entry>()
  private changes = new Map<string,{roomId:string}>()
  private paused = new Map<string,number>()
  private closed = false
  private shutdown?:Promise<void>
  private pendingStops = new Set<Promise<unknown>>()
  constructor(private deps:Dependencies) {}
  private localBinding(key:string):RoomBinding {
    const binding = this.deps.read().find(b => keyOf(b) === key)
    if (!binding) throw stale()
    return binding
  }
  activeRoomModel(binding:RoomBinding):DshRoomModelSelection | undefined {
    const key = keyOf(binding), active = this.entries.get(key)?.item?.activeModel
    return active && this.deps.read().some(b => keyOf(b) === key) ? {...active} : undefined
  }
  async prepareRoomModelChange(
    binding:RoomBinding, selection:DshRoomModelSelection, open:(binding:RoomBinding)=>Promise<RoomModel>,
  ):Promise<PreparedRoomModelChange> {
    const key = keyOf(binding), local = this.localBinding(key)
    if (this.closed || this.paused.has(local.roomId)) throw stale()
    const entry = this.entries.get(key), target = entry?.item
    const revision = this.deps.identityRevision?.()
    // 绑定未变也可能已断线重建；不能把旧候选交给后来启动的实例。
    const ticket = {roomId:local.roomId}
    this.changes.set(key,ticket)
    const assertCurrent = () => {
      if (this.changes.get(key) !== ticket || this.entries.get(key) !== entry || entry?.item !== target ||
          this.deps.identityRevision?.() !== revision || !sameModel(this.localBinding(key).modelSelection,local.modelSelection)) throw stale()
    }
    let candidate:RoomModel | undefined
    let cleanup:Promise<void> | undefined
    const discard = () => {
      if (this.changes.get(key) === ticket) this.changes.delete(key)
      if (candidate) {
        cleanup = candidate.revoke()
        candidate = undefined
      }
      return cleanup ?? Promise.resolve()
    }
    try {
      candidate = await open({...local, modelSelection:{...selection}})
      assertCurrent()
      if (!sameModel(candidate.modelSelection,selection)) throw new Error('候选运行时与所选模型不符')
    } catch (error) {
      await discard()
      throw error
    }
    return {
      discard,
      commit(persist) {
        try {
          assertCurrent()
          if (!candidate) throw stale()
          if (target) {
            target.commitModel(candidate,persist)
            candidate = undefined // 已安装的模型由执行器负责撤销。
          } else {
            persist() // 离线只保存选择，并不启动连接。
          }
        } finally { void discard().catch(() => {}) }
      },
    }
  }
  private dispose(key:string, entry:Entry) {
    if (this.entries.get(key) !== entry) return
    this.changes.delete(key)
    this.entries.delete(key)
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.stableTimer) clearTimeout(entry.stableTimer)
    if (entry.item) {
      const stop = entry.item.stop().catch(() => {})
      this.pendingStops.add(stop); void stop.finally(() => this.pendingStops.delete(stop))
    }
  }
  refresh() {
    if (this.closed) return
    let bindings:RoomBinding[]
    try { bindings = this.deps.read() } catch { this.suspend(); return }
    const wanted = new Map(bindings.filter(b => !this.paused.has(b.roomId)).map(b => [keyOf(b),b]))
    for (const [key,entry] of this.entries) if (!wanted.has(key)) this.dispose(key,entry)
    for (const [key,binding] of wanted) {
      if (this.entries.has(key)) continue
      const entry:Entry = {binding,starting:false,failures:0}; this.entries.set(key,entry)
      void this.start(key,entry)
    }
  }
  private retry(key:string,entry:Entry) {
    if (this.closed || this.entries.get(key) !== entry || entry.timer) return
    const delay = roomRetryDelay(entry.failures++,this.deps.retryMs ?? 5000,this.deps.retryMaxMs ?? 300000)
    entry.timer = setTimeout(() => { entry.timer=undefined; void this.start(key,entry) },delay)
  }
  private async start(key:string,entry:Entry) {
    if (this.closed || this.entries.get(key) !== entry || entry.starting || entry.item) return
    entry.starting = true
    const latest = () => this.localBinding(key)
    try {
      if (this.deps.authorize && !await this.deps.authorize(latest())) { this.retry(key,entry); return }
      if (this.closed || this.entries.get(key) !== entry) return
      let item:Managed
      item = this.deps.create(latest(), () => {
        if (this.entries.get(key) !== entry || entry.item !== item) return
        if (entry.stableTimer) { clearTimeout(entry.stableTimer); entry.stableTimer = undefined }
        entry.item = undefined; this.retry(key,entry)
      }, () => {
        if (this.entries.get(key) === entry && entry.item === item) {
          if (entry.stableTimer) clearTimeout(entry.stableTimer)
          entry.stableTimer = setTimeout(() => {
            entry.stableTimer = undefined
            if (this.entries.get(key) === entry && entry.item === item) entry.failures = 0
          },this.deps.readyStableMs ?? 60000)
        }
      },latest)
      this.changes.delete(key)
      entry.item = item
      await item.start()
    } catch {
      const item=entry.item; entry.item=undefined
      if (item) void item.stop().catch(() => {})
      this.retry(key,entry)
    } finally { entry.starting = false }
  }
  pauseRoom(roomId:string) {
    for (const [key,ticket] of this.changes) if (ticket.roomId === roomId) this.changes.delete(key)
    this.paused.set(roomId,(this.paused.get(roomId) ?? 0)+1)
    for (const [key,entry] of this.entries) if (entry.binding.roomId === roomId) this.dispose(key,entry)
  }
  resumeRoom(roomId:string) {
    const count = this.paused.get(roomId) ?? 0
    if (count <= 1) this.paused.delete(roomId); else this.paused.set(roomId,count-1)
    this.refresh()
  }
  suspend() { this.changes.clear(); for (const [key,entry] of this.entries) this.dispose(key,entry) }
  stop():Promise<void> {
    if (this.shutdown) return this.shutdown
    this.closed = true; this.suspend()
    this.shutdown = Promise.allSettled([...this.pendingStops]).then(() => {})
    return this.shutdown
  }
}
