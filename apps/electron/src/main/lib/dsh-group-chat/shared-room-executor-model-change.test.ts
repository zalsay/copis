import { expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SharedRoomExecutor, type RoomBinding } from './shared-room-executor'
import { SharedRoomExecutorManager } from './shared-room-executor-manager'

const binding:RoomBinding = {userId:'1',deviceId:'dev',roomId:'r',roomAgentId:'a',workspaceId:'w',displayName:'助手'}
const old = {channelId:'c',modelId:'old'}, next = {channelId:'c',modelId:'next'}
const model = (modelSelection=old, submit=async (id:string) => id) => ({modelSelection, submit:mock(submit), revoke:mock(async () => {})})
const until = async (condition:()=>boolean) => {
  for (let i=0; i<500 && !condition(); i++) await Bun.sleep(2)
  expect(condition()).toBe(true)
}
class Socket extends EventEmitter {
  sent:any[] = []
  close = mock(() => this.emit('close'))
  send(raw:string) { this.sent.push(JSON.parse(raw)) }
  frame(type:string,payload:object) { this.emit('message',JSON.stringify({roomId:'r',type,payload})) }
  async command(type:string,id?:string) {
    const find = () => this.sent.find(f=>f.type===type && f.payload.invocationId===id)
    await until(()=>!!find()); return find()
  }
  async ack(type:string,id?:string) {
    const cmd = await this.command(type,id)
    this.frame('command.ack',{command:type,invocationId:id,requestId:cmd.payload.requestId,ok:true,status:type.slice(6)})
  }
  async ready() {
    this.emit('open'); this.frame('room.snapshot',{room:{roomId:'r',hostUserId:1,roomKind:'dsh_shared',status:'active'},agents:[{roomAgentId:'a',ownerUserId:1}],capabilities:['agent-ready-v1','invocation-ack-v1']})
    this.frame('room.recovery_ready',{}); await this.ack('agent.ready')
  }
  invoke(id:string) {
    this.frame('agent.invocation',{invocationId:id,targetAgentId:'a',depth:0,sender:{type:'user',id:'1'},triggerMessageId:id,messages:[{messageId:id,sender:{type:'user',id:'1'},mentionedAgentIds:['a'],text:id}]})
  }
}
function setup(open:(b:RoomBinding)=>Promise<ReturnType<typeof model>>, maxAge?:number) {
  const dir = mkdtempSync(join(tmpdir(),'room-model-change-'))
  let rows = [binding]
  const socket = new Socket(), connect = mock(()=>socket)
  const manager = new SharedRoomExecutorManager({read:()=>rows, retryMs:5,
    create:(b,onStopped,onReady,latest)=>new SharedRoomExecutor(b,{socket:connect,journalDir:dir,onStopped,onReady,modelMaxAgeMs:maxAge,openModel:()=>open(latest())})})
  return {manager,socket,connect, set:(newRows:RoomBinding[])=>{rows=newRows},
    change:(candidate= model(next))=>manager.prepareRoomModelChange(binding,next,async b=>{expect(b.modelSelection).toEqual(next);return candidate}),
    end:async()=>{await manager.stop();rmSync(dir,{recursive:true,force:true})}}
}

test('换模不重连：已 submit 的两条保留旧模型，等待 running ACK 的下一条使用新模型',async()=>{
  const a=Promise.withResolvers<string>(), b=Promise.withResolvers<string>()
  const original=model(old,id=>id==='A'?a.promise:b.promise), candidate=model(next)
  const f=setup(async()=>original)
  try {
    f.manager.refresh();await until(()=>f.connect.mock.calls.length===1)
    expect(f.manager.activeRoomModel(binding)).toBeUndefined();await f.socket.ready()
    for(const id of ['A','B','C']) { f.socket.invoke(id);await f.socket.ack('agent.accepted',id);await f.socket.command('agent.running',id);if(id!=='C')await f.socket.ack('agent.running',id) }
    expect(original.submit).toHaveBeenCalledTimes(2)
    const change=await f.change(candidate)
    change.commit(()=>{expect(f.manager.activeRoomModel(binding)).toEqual(old);f.set([{...binding,modelSelection:next}])});await change.discard()
    f.manager.refresh();expect(f.manager.activeRoomModel(binding)).toEqual(next)
    await f.socket.ack('agent.running','C');expect((await f.socket.command('agent.completed','C')).payload.content).toBe('C');await f.socket.ack('agent.completed','C')
    a.resolve('旧 A');await f.socket.ack('agent.completed','A');expect(original.revoke).not.toHaveBeenCalled()
    b.resolve('旧 B');await f.socket.ack('agent.completed','B');expect(original.revoke).toHaveBeenCalledTimes(1)
    expect(candidate.submit).toHaveBeenCalledTimes(1);expect(candidate.revoke).not.toHaveBeenCalled();expect(f.connect).toHaveBeenCalledTimes(1);expect(f.socket.close).not.toHaveBeenCalled()
  } finally {a.resolve('');b.resolve('');await f.end()}
})

test('离线先验证后持久化；绑定消失、落盘失败、discard 或目标启动均不能误提交',async()=>{
  const f=setup(async b=>model(b.modelSelection));const persist=mock(()=>{})
  try {
    for(const cause of ['discard','disk','removed','starting','offline'] as const) {
      const candidate=model(next), change=await f.change(candidate)
      if(cause==='disk') expect(()=>change.commit(()=>{throw Error('disk')})).toThrow('disk')
      if(cause==='removed') f.set([])
      if(cause==='starting') f.manager.refresh()
      if(cause==='offline') {change.commit(()=>{persist();f.set([{...binding,modelSelection:next}])});expect(f.manager.activeRoomModel(binding)).toBeUndefined()}
      else if(cause!=='disk') {if(cause==='discard')await change.discard();expect(()=>change.commit(persist)).toThrow()}
      await change.discard();await change.discard();expect(candidate.revoke).toHaveBeenCalledTimes(1)
      if(cause==='starting'){f.manager.pauseRoom('r');f.set([]);f.manager.resumeRoom('r')}
      if(cause!=='offline')f.set([binding])
    }
    expect(persist).toHaveBeenCalledTimes(1)
    const previous = f.connect.mock.calls.length
    f.manager.refresh();await until(()=>f.connect.mock.calls.length>previous);await f.socket.ready();expect(f.manager.activeRoomModel(binding)).toEqual(next)
  } finally {await f.end()}
})

for(const late of ['启动','续签'] as const) for(const result of ['成功','失败'] as const) test(`${late}旧请求迟到${result}不覆盖显式换模、不阻塞队列或关闭连接`,async()=>{
  const opened:RoomBinding[]=[], gate=Promise.withResolvers<ReturnType<typeof model>>(), stale=model(), candidate=model(next)
  const f=setup(async b=>{opened.push(b);return opened.length===(late==='启动'?1:2)?gate.promise:model(b.modelSelection)},80)
  try {
    f.manager.refresh();await until(()=>opened.length===1)
    if(late==='续签'){await until(()=>f.connect.mock.calls.length===1);await f.socket.ready();await until(()=>opened.length===2);f.socket.invoke('queued')}
    const change=await f.change(candidate);change.commit(()=>f.set([{...binding,modelSelection:next}]))
    if(late==='启动'){expect(f.manager.activeRoomModel(binding)).toBeUndefined();await until(()=>f.connect.mock.calls.length===1);await f.socket.ready()}
    else {await f.socket.ack('agent.accepted','queued');await f.socket.ack('agent.running','queued');await f.socket.ack('agent.completed','queued')}
    if(result==='成功')gate.resolve(stale);else gate.reject(new Error('旧授权失败'))
    await until(()=>opened.at(-1)?.modelSelection?.modelId===next.modelId)
    expect(f.manager.activeRoomModel(binding)).toEqual(next);expect(f.connect).toHaveBeenCalledTimes(1);expect(f.socket.close).not.toHaveBeenCalled();expect(stale.revoke.mock.calls.length).toBe(result==='成功'?1:0)
  } finally {gate.resolve(stale);await f.end()}
})

test('在线提交必须先落盘；关闭已开始但旧运行时未清理完毕时拒绝提交',async()=>{
  const gate=Promise.withResolvers<void>(), original=model(), candidate=model(next)
  original.revoke.mockImplementation(()=>gate.promise)
  const f=setup(async()=>original), persist=mock(()=>{})
  try {
    f.manager.refresh();await until(()=>f.connect.mock.calls.length===1);await f.socket.ready()
    const failed=await f.change(candidate)
    expect(()=>failed.commit(()=>{throw Error('disk')})).toThrow('disk');await failed.discard()
    expect(f.manager.activeRoomModel(binding)).toEqual(old);expect(candidate.revoke).toHaveBeenCalledTimes(1);expect(original.revoke).not.toHaveBeenCalled()
    const second=model(next), change=await f.change(second)
    f.socket.emit('close');expect(f.manager.activeRoomModel(binding)).toBeUndefined()
    expect(()=>change.commit(persist)).toThrow();await change.discard();expect(second.revoke).toHaveBeenCalledTimes(1);expect(persist).not.toHaveBeenCalled()
  } finally {gate.resolve();await f.end()}
})

test('准备期间绑定已替换或运行时返回了其他模型，不交付可提交的候选',async()=>{
  const f=setup(async()=>model()), gate=Promise.withResolvers<ReturnType<typeof model>>()
  try {
    const mismatch=model();await expect(f.change(mismatch)).rejects.toThrow();expect(mismatch.revoke).toHaveBeenCalledTimes(1)
    const pending=f.manager.prepareRoomModelChange(binding,next,()=>gate.promise)
    f.set([{...binding,workspaceId:'another'}]);const late=model(next);gate.resolve(late)
    await expect(pending).rejects.toThrow();expect(late.revoke).toHaveBeenCalledTimes(1);expect(f.connect).not.toHaveBeenCalled()
  } finally {await f.end()}
})

test('启动开模已失败但管理器尚未重试时不能向旧实例提交',async()=>{
  const opening=Promise.withResolvers<ReturnType<typeof model>>(), persist=mock(()=>{})
  const f=setup(()=>opening.promise), candidate=model(next)
  try {
    f.manager.refresh();const change=await f.change(candidate)
    opening.reject(Error('初始授权失败'));await Promise.resolve()
    expect(()=>change.commit(persist)).toThrow();await change.discard()
    expect(persist).not.toHaveBeenCalled();expect(candidate.revoke).toHaveBeenCalledTimes(1)
  } finally {await f.end()}
})
