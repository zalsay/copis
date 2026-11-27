import { test, expect } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SharedRoomExecutor } from './shared-room-executor'

class Socket extends EventEmitter {
  sent: any[] = []
  send(raw: string) { this.sent.push(JSON.parse(raw)) }
  close() { this.emit('close') }
  frame(frame: object) { this.emit('message', Buffer.from(JSON.stringify(frame))) }
  ack(command: any, status?: string) { this.frame({ type: 'command.ack', roomId: 'room-1', payload: {requestId:command.payload.requestId, command:command.type, invocationId:command.payload.invocationId, ok:true, ...(status ? {status} : {})} }) }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 20))
const waitFor = async (test:()=>boolean) => { for (let i=0;i<100 && !test();i++) await tick() }
test('Given 受信绑定 When 模型就绪并协商快照和 ready ACK Then 依次确认 accepted/running 后仅执行一次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-executor-')); const socket = new Socket(); let calls = 0; let revoked = 0
  const pictures = [{mimeType:'image/png',bytes:new Uint8Array([1])}]
  let submitted: unknown, downloads = 0
  const executor = new SharedRoomExecutor({userId:'1', deviceId:'dev-1', roomId:'room-1', roomAgentId:'agent-1', workspaceId:'workspace-1', displayName:'助手'}, {
    socket: () => socket as any, replyWithAttachments: async (ids,text,_active,ask) => { downloads++; expect(ids).toEqual(['img']); return {content:await ask(text,pictures),attachmentIds:['generated-pdf']} },
    openModel: async () => ({submit:async (_id, _text, images) => { calls++; submitted = images; return '答案' }, revoke:async () => {revoked++}}), journalDir:dir,
  })
  try {
    await executor.start(); socket.emit('open')
    expect(socket.sent[0].payload.capabilities).toEqual(['agent-ready-v1','invocation-ack-v1'])
    socket.frame({type:'room.snapshot',roomId:'room-1',payload:{room:{roomId:'room-1',hostUserId:1,roomKind:'dsh_shared',status:'active'},capabilities:['agent-ready-v1','invocation-ack-v1'],agents:[{roomAgentId:'agent-1',ownerUserId:1}]}})
    socket.frame({type:'agent.invocation',roomId:'room-1',payload:{invocationId:'history',targetAgentId:'agent-1'}})
    await tick(); expect(socket.sent.some(x=>x.type==='agent.ready')).toBe(false); expect(calls).toBe(0); socket.frame({type:'room.recovery_ready',roomId:'room-1',payload:{}}); await tick(); const ready = socket.sent.at(-1); expect(ready.type).toBe('agent.ready')
    const invocation = {type:'agent.invocation',roomId:'room-1',payload:{invocationId:'inv-1',depth:0,sender:{type:'user',id:'1'},targetAgentId:'agent-1',triggerMessageId:'msg-1',messages:[{messageId:'msg-1',sender:{type:'user',id:'1'},mentionedAgentIds:['agent-1'],text:'你好',attachmentIds:['img']}]}}
    socket.frame(invocation); await tick(); expect(calls).toBe(0)
    socket.ack(ready); socket.frame(invocation); await waitFor(() => socket.sent.at(-1)?.type === 'agent.accepted')
    const accepted = socket.sent.at(-1); expect(accepted.type).toBe('agent.accepted'); expect(calls).toBe(0)
    socket.ack(accepted,'accepted'); await tick(); const running = socket.sent.at(-1); expect(running.type).toBe('agent.running'); expect(calls).toBe(0)
    expect(downloads).toBe(0); socket.ack(running,'running'); await tick(); expect(calls).toBe(1); expect(submitted).toEqual(pictures)
    const completed = socket.sent.at(-1); expect(completed.type).toBe('agent.completed'); expect(completed.payload.content).toBe('答案');expect(completed.payload.attachmentIds).toEqual(['generated-pdf'])
    socket.ack(completed,'completed'); socket.frame(invocation); await tick(); expect(calls).toBe(1)
    await executor.stop(); expect(revoked).toBe(1)
  } finally { await executor.stop(); rmSync(dir,{recursive:true,force:true}) }
})
test('Given 未协商能力或不匹配 owner When 收到快照 Then 不发送 ready', async () => {
  for (const payload of [{capabilities:[],agents:[{roomAgentId:'agent-1',ownerUserId:1}]},{capabilities:['agent-ready-v1','invocation-ack-v1'],agents:[{roomAgentId:'agent-1',ownerUserId:2}]}]) {
    const dir = mkdtempSync(join(tmpdir(), 'room-executor-')); const socket = new Socket()
    const executor = new SharedRoomExecutor({userId:'1',deviceId:'dev-1',roomId:'room-1',roomAgentId:'agent-1',workspaceId:'ws',displayName:'助手'}, {socket:()=>socket as any, openModel:async()=>({submit:async()=>'',revoke:async()=>{}}),journalDir:dir})
    await executor.start(); socket.emit('open'); socket.frame({type:'room.snapshot',roomId:'room-1',payload}); await tick(); expect(socket.sent.some(x=>x.type==='agent.ready')).toBe(false)
    await executor.stop(); rmSync(dir,{recursive:true,force:true})
  }
})

test('Given accepted 被拒绝 When 收到私有拒绝 ACK Then 关闭且不执行模型或发送伪造终态', async () => {
  const dir = mkdtempSync(join(tmpdir(),'room-executor-')); const socket = new Socket(); let calls=0
  const executor = new SharedRoomExecutor({userId:'1',deviceId:'d',roomId:'room-1',roomAgentId:'agent-1',workspaceId:'w',displayName:'n'},{socket:()=>socket as any,openModel:async()=>({submit:async()=>{calls++;return 'x'},revoke:async()=>{}}),journalDir:dir})
  try {
    await executor.start(); socket.emit('open'); socket.frame({type:'room.snapshot',roomId:'room-1',payload:{room:{roomId:'room-1',hostUserId:1,roomKind:'dsh_shared',status:'active'},capabilities:['agent-ready-v1','invocation-ack-v1'],agents:[{roomAgentId:'agent-1',ownerUserId:1}]}}); socket.frame({type:'room.recovery_ready',roomId:'room-1',payload:{}}); await tick(); socket.ack(socket.sent.at(-1)); await tick()
    socket.frame({type:'agent.invocation',roomId:'room-1',payload:{invocationId:'i',depth:0,sender:{type:'user',id:'1'},targetAgentId:'agent-1',triggerMessageId:'m',messages:[{messageId:'m',sender:{type:'user',id:'1'},mentionedAgentIds:['agent-1'],text:'t'}]}}); await tick()
    const command=socket.sent.at(-1); socket.frame({type:'command.ack',roomId:'room-1',payload:{requestId:command.payload.requestId,command:command.type,invocationId:'i',ok:false,errorCode:'forbidden'}}); await tick()
    expect(calls).toBe(0); expect(socket.sent.some(x=>x.type==='agent.failed')).toBe(false)
  } finally {await executor.stop();rmSync(dir,{recursive:true,force:true})}
})

test('Given 已领取但终态未知 When 新连接收到相同 invocation Then 不重跑模型', async () => {
  const dir = mkdtempSync(join(tmpdir(),'room-executor-')); let calls = 0
  const binding={userId:'1',deviceId:'d',roomId:'room-1',roomAgentId:'agent-1',workspaceId:'w',displayName:'n'}
  const invocation={type:'agent.invocation',roomId:'room-1',payload:{invocationId:'replay',depth:0,sender:{type:'user',id:'1'},targetAgentId:'agent-1',triggerMessageId:'m',messages:[{messageId:'m',sender:{type:'user',id:'1'},mentionedAgentIds:['agent-1'],text:'t'}]}}
  async function ready() {
    const socket=new Socket(); const executor=new SharedRoomExecutor(binding,{socket:()=>socket as any,openModel:async()=>({submit:async()=>{calls++;return 'x'},revoke:async()=>{}}),journalDir:dir})
    await executor.start();socket.emit('open');socket.frame({type:'room.snapshot',roomId:'room-1',payload:{room:{roomId:'room-1',hostUserId:1,status:'active',roomKind:'dsh_shared'},capabilities:['agent-ready-v1','invocation-ack-v1'],agents:[{roomAgentId:'agent-1',ownerUserId:1}]}});socket.frame({type:'room.recovery_ready',roomId:'room-1',payload:{}});await tick();socket.ack(socket.sent.at(-1));await tick();return {socket,executor}
  }
  try {
    const first=await ready();first.socket.frame(invocation);await tick();expect(first.socket.sent.at(-1).type).toBe('agent.accepted');await first.executor.stop()
    const second=await ready();second.socket.frame(invocation);await tick();expect(second.socket.sent.some(x=>x.type==='agent.accepted')).toBe(false);expect(calls).toBe(0);await second.executor.stop()
  } finally {rmSync(dir,{recursive:true,force:true})}
})

test('Given 模型尚在准备 When 身份切换撤销 Then 不创建 socket 并销毁迟到的模型', async () => {
  const dir=mkdtempSync(join(tmpdir(),'room-executor-')); let release!:()=>void; const gate=new Promise<void>(r=>release=r);let sockets=0, revoked=0
  const executor=new SharedRoomExecutor({userId:'1',deviceId:'d',roomId:'r',roomAgentId:'a',workspaceId:'w',displayName:'n'},{socket:()=>{sockets++;return new Socket() as any},openModel:async()=>{await gate;return {submit:async()=>'',revoke:async()=>{revoked++}}},journalDir:dir})
  const starting=executor.start();await executor.stop();release();await starting
  expect(sockets).toBe(0);expect(revoked).toBe(1);rmSync(dir,{recursive:true,force:true})
})

test('Given 已确认 running When 模型失败 Then 发送失败并等待服务端确认', async () => {
  const dir=mkdtempSync(join(tmpdir(),'room-executor-'));const socket=new Socket()
  const executor=new SharedRoomExecutor({userId:'1',deviceId:'d',roomId:'room-1',roomAgentId:'agent-1',workspaceId:'w',displayName:'n'},{socket:()=>socket as any,openModel:async()=>({submit:async()=>{throw new Error('secret')},revoke:async()=>{}}),journalDir:dir})
  try {
    await executor.start();socket.emit('open');socket.frame({type:'room.snapshot',roomId:'room-1',payload:{room:{roomId:'room-1',hostUserId:1,status:'active',roomKind:'dsh_shared'},capabilities:['agent-ready-v1','invocation-ack-v1'],agents:[{roomAgentId:'agent-1',ownerUserId:1}]}});socket.frame({type:'room.recovery_ready',roomId:'room-1',payload:{}});await tick();socket.ack(socket.sent.at(-1));await tick()
    socket.frame({type:'agent.invocation',roomId:'room-1',payload:{invocationId:'i',depth:0,sender:{type:'user',id:'1'},targetAgentId:'agent-1',triggerMessageId:'m',messages:[{messageId:'m',sender:{type:'user',id:'1'},mentionedAgentIds:['agent-1'],text:'t'}]}});await tick();socket.ack(socket.sent.at(-1),'accepted');await tick();socket.ack(socket.sent.at(-1),'running');await tick()
    const failed=socket.sent.at(-1);expect(failed.type).toBe('agent.failed');expect(failed.payload.failureCode).toBe('execution_failed');expect(JSON.stringify(failed)).not.toContain('secret');socket.ack(failed,'failed')
  } finally {await executor.stop();rmSync(dir,{recursive:true,force:true})}
})

test('Given 模型授权即将过期 When 长时间空闲 Then 原连接重新准备模型且不虚报在线', async () => {
  const dir=mkdtempSync(join(tmpdir(),'room-executor-'));const socket=new Socket();let revoked=0,opened=0,stopped=0
  const executor=new SharedRoomExecutor({userId:'1',deviceId:'d',roomId:'r',roomAgentId:'a',workspaceId:'w',displayName:'n'},{socket:()=>socket as any,openModel:async()=>{opened++;return {submit:async()=>'',revoke:async()=>{revoked++}}},journalDir:dir,modelMaxAgeMs:50,onStopped:()=>{stopped++}})
  try {await executor.start();await new Promise(r=>setTimeout(r,70));expect(opened).toBe(2);expect(revoked).toBe(1);expect(stopped).toBe(0)} finally {await executor.stop();rmSync(dir,{recursive:true,force:true})}
})

test('Given A 正在思考 When 普通成员退群或群名分享码变化 Then 不撤销执行器', async () => {
  const dir=mkdtempSync(join(tmpdir(),'room-executor-'));const socket=new Socket();let release!:()=>void;const gate=new Promise<void>(r=>release=r);let revoked=0
  const executor=new SharedRoomExecutor({userId:'1',deviceId:'d',roomId:'room-1',roomAgentId:'agent-1',workspaceId:'w',displayName:'n'},{socket:()=>socket as any,openModel:async()=>({submit:async()=>{await gate;return 'done'},revoke:async()=>{revoked++}}),journalDir:dir})
  try {
    await executor.start();socket.emit('open');socket.frame({type:'room.snapshot',roomId:'room-1',payload:{room:{roomId:'room-1',hostUserId:1,status:'active',roomKind:'dsh_shared'},capabilities:['agent-ready-v1','invocation-ack-v1'],agents:[{roomAgentId:'agent-1',ownerUserId:1}]}});socket.frame({type:'room.recovery_ready',roomId:'room-1',payload:{}});await tick();socket.ack(socket.sent.at(-1));await tick()
    socket.frame({type:'agent.invocation',roomId:'room-1',payload:{invocationId:'i',depth:0,sender:{type:'user',id:'2'},targetAgentId:'agent-1',triggerMessageId:'m',messages:[{messageId:'m',sender:{type:'user',id:'2'},mentionedAgentIds:['agent-1'],text:'t'}]}});await tick();socket.ack(socket.sent.at(-1),'accepted');await tick();socket.ack(socket.sent.at(-1),'running');await tick()
    socket.frame({type:'member.removed',roomId:'room-1',payload:{roomId:'room-1',userId:3}});socket.frame({type:'room.updated',roomId:'room-1',payload:{roomId:'room-1',name:'新群名',shareCode:'A123',status:'active',roomKind:'dsh_shared'}});socket.frame({type:'agent.updated',roomId:'room-1',payload:{roomId:'room-1',roomAgentId:'other',status:'disabled'}});await tick()
    expect(revoked).toBe(0);release();await tick();expect(socket.sent.at(-1).type).toBe('agent.completed');socket.ack(socket.sent.at(-1),'completed')
  } finally {release();await executor.stop();rmSync(dir,{recursive:true,force:true})}
})

test('Given 调用期间服务端判定该调用失败 When 模型稍后完成 Then 不发送完成且其他队列不受影响', async () => {
  const dir=mkdtempSync(join(tmpdir(),'room-executor-'));const socket=new Socket();let release!:()=>void;const gate=new Promise<void>(r=>release=r);let revoked=0
  const executor=new SharedRoomExecutor({userId:'1',deviceId:'d',roomId:'room-1',roomAgentId:'agent-1',workspaceId:'w',displayName:'n'},{socket:()=>socket as any,openModel:async()=>({submit:async()=>{await gate;return 'done'},revoke:async()=>{revoked++}}),journalDir:dir})
  try {
    await executor.start();socket.emit('open');socket.frame({type:'room.snapshot',roomId:'room-1',payload:{room:{roomId:'room-1',hostUserId:1,status:'active',roomKind:'dsh_shared'},capabilities:['agent-ready-v1','invocation-ack-v1'],agents:[{roomAgentId:'agent-1',ownerUserId:1}]}});socket.frame({type:'room.recovery_ready',roomId:'room-1',payload:{}});await tick();socket.ack(socket.sent.at(-1));await tick()
    socket.frame({type:'agent.invocation',roomId:'room-1',payload:{invocationId:'i',depth:0,sender:{type:'user',id:'2'},targetAgentId:'agent-1',triggerMessageId:'m',messages:[{messageId:'m',sender:{type:'user',id:'2'},mentionedAgentIds:['agent-1'],text:'t'}]}});await tick();socket.ack(socket.sent.at(-1),'accepted');await tick();socket.ack(socket.sent.at(-1),'running');await tick()
    socket.frame({type:'agent.failed',roomId:'room-1',payload:{invocationId:'i',failureCode:'sender_left'}});release();await tick()
    expect(socket.sent.some(x=>x.type==='agent.completed')).toBe(false);expect(revoked).toBe(0)
  } finally {release();await executor.stop();rmSync(dir,{recursive:true,force:true})}
})

test('Given ready 已确认 When 心跳周期到达 Then 发送当前绑定 agent 的 lease 续期帧', async () => {
  const dir=mkdtempSync(join(tmpdir(),'room-executor-'));const socket=new Socket()
  const executor=new SharedRoomExecutor({userId:'1',deviceId:'d',roomId:'room-1',roomAgentId:'agent-1',workspaceId:'w',displayName:'n'},{socket:()=>socket as any,openModel:async()=>({submit:async()=>'',revoke:async()=>{}}),journalDir:dir,heartbeatMs:10})
  try {await executor.start();socket.emit('open');socket.frame({type:'room.snapshot',roomId:'room-1',payload:{room:{roomId:'room-1',hostUserId:1,status:'active',roomKind:'dsh_shared'},capabilities:['agent-ready-v1','invocation-ack-v1'],agents:[{roomAgentId:'agent-1',ownerUserId:1}]}});socket.frame({type:'room.recovery_ready',roomId:'room-1',payload:{}});await tick();socket.ack(socket.sent.at(-1));await tick();expect(socket.sent).toContainEqual({type:'agent.heartbeat',roomId:'room-1',payload:{roomAgentId:'agent-1'}})} finally {await executor.stop();rmSync(dir,{recursive:true,force:true})}
})

test('Given A 单条失败 When 服务端释放 B 且确认 A failed Then B 在同一连接成功', async () => {
  for (const failure of ['throw','empty','oversize'] as const) {
    const dir=mkdtempSync(join(tmpdir(),'room-task-failure-'));const socket=new Socket();let revoked=0;const submitted:string[]=[]
    const executor=new SharedRoomExecutor({userId:'1',deviceId:'d',roomId:'room-1',roomAgentId:'agent-1',workspaceId:'w',displayName:'n'}, {
      socket:()=>socket as any, journalDir:dir,
      openModel:async()=>({submit:async(id)=>{submitted.push(id);if(id==='A' && failure==='throw') throw new Error('临时失败');if(id==='A' && failure==='empty') return ' ';return 'B 的回复'},revoke:async()=>{revoked++}}),
    })
    const invocation=(id:string,text:string)=>({type:'agent.invocation',roomId:'room-1',payload:{invocationId:id,depth:0,sender:{type:'user',id:'1'},targetAgentId:'agent-1',triggerMessageId:`m${id}`,messages:[{messageId:`m${id}`,sender:{type:'user',id:'1'},mentionedAgentIds:['agent-1'],text}]}})
    try {
      await executor.start();socket.emit('open');socket.frame({type:'room.snapshot',roomId:'room-1',payload:{room:{roomId:'room-1',hostUserId:1,status:'active',roomKind:'dsh_shared'},capabilities:['agent-ready-v1','invocation-ack-v1'],agents:[{roomAgentId:'agent-1',ownerUserId:1}]}});socket.frame({type:'room.recovery_ready',roomId:'room-1',payload:{}});await waitFor(()=>socket.sent.some(x=>x.type==='agent.ready'));socket.ack(socket.sent.at(-1));await tick()
      socket.frame(invocation('A',failure==='oversize'?'x'.repeat(32769):'A'))
      await waitFor(()=>socket.sent.at(-1)?.type==='agent.accepted');socket.ack(socket.sent.at(-1),'accepted')
      await waitFor(()=>socket.sent.at(-1)?.type==='agent.running');socket.ack(socket.sent.at(-1),'running')
      await waitFor(()=>socket.sent.at(-1)?.type==='agent.failed');const failed=socket.sent.at(-1);expect(failed.payload.invocationId).toBe('A')
      // 服务端可在 failed ACK 入队前投递下一条已提交任务。
      socket.frame(invocation('B','B'));socket.ack(failed,'failed')
      await waitFor(()=>socket.sent.some(x=>x.type==='agent.accepted' && x.payload.invocationId==='B'))
      const accepted=socket.sent.find(x=>x.type==='agent.accepted' && x.payload.invocationId==='B');expect(accepted).toBeDefined();socket.ack(accepted,'accepted')
      await waitFor(()=>socket.sent.some(x=>x.type==='agent.running' && x.payload.invocationId==='B'))
      const running=socket.sent.find(x=>x.type==='agent.running' && x.payload.invocationId==='B');expect(running).toBeDefined();socket.ack(running,'running')
      await waitFor(()=>socket.sent.some(x=>x.type==='agent.completed' && x.payload.invocationId==='B'))
      const completed=socket.sent.find(x=>x.type==='agent.completed' && x.payload.invocationId==='B');expect(completed?.payload.content).toBe('B 的回复');socket.ack(completed,'completed')
      expect(submitted).toEqual(failure==='oversize'?['B']:['A','B']);expect(revoked).toBe(0)
    } finally {await executor.stop();rmSync(dir,{recursive:true,force:true})}
  }
})

test('Given 任务失败 When 服务端拒绝 failed ACK Then 关闭不确定的连接', async () => {
  const dir=mkdtempSync(join(tmpdir(),'room-failed-ack-'));const socket=new Socket();let revoked=0
  const executor=new SharedRoomExecutor({userId:'1',deviceId:'d',roomId:'room-1',roomAgentId:'agent-1',workspaceId:'w',displayName:'n'},{socket:()=>socket as any,openModel:async()=>({submit:async()=>{throw new Error('失败')},revoke:async()=>{revoked++}}),journalDir:dir})
  try {
    await executor.start();socket.emit('open');socket.frame({type:'room.snapshot',roomId:'room-1',payload:{room:{roomId:'room-1',hostUserId:1,status:'active',roomKind:'dsh_shared'},capabilities:['agent-ready-v1','invocation-ack-v1'],agents:[{roomAgentId:'agent-1',ownerUserId:1}]}});socket.frame({type:'room.recovery_ready',roomId:'room-1',payload:{}});await waitFor(()=>socket.sent.some(x=>x.type==='agent.ready'));socket.ack(socket.sent.at(-1));await tick()
    socket.frame({type:'agent.invocation',roomId:'room-1',payload:{invocationId:'A',depth:0,sender:{type:'user',id:'1'},targetAgentId:'agent-1',triggerMessageId:'m',messages:[{messageId:'m',sender:{type:'user',id:'1'},mentionedAgentIds:['agent-1'],text:'A'}]}})
    await waitFor(()=>socket.sent.at(-1)?.type==='agent.accepted');socket.ack(socket.sent.at(-1),'accepted');await waitFor(()=>socket.sent.at(-1)?.type==='agent.running');socket.ack(socket.sent.at(-1),'running');await waitFor(()=>socket.sent.at(-1)?.type==='agent.failed')
    const failed=socket.sent.at(-1);socket.frame({type:'command.ack',roomId:'room-1',payload:{requestId:failed.payload.requestId,command:'agent.failed',invocationId:'A',ok:false,errorCode:'forbidden'}});await waitFor(()=>revoked===1);expect(revoked).toBe(1)
  } finally {await executor.stop();rmSync(dir,{recursive:true,force:true})}
})
