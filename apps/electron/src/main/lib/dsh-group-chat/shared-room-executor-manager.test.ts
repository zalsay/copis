import { expect, test, jest } from 'bun:test'
import { SharedRoomExecutorManager } from './shared-room-executor-manager'

const noModel = {activeModel:undefined,commitModel:()=>{ throw new Error('测试未配置模型') }}

test('Given 会话切换 When 旧模型仍在准备 Then 立即撤销旧运行时且不会启动旧连接', async () => {
  let user = '1'; let release!:()=>void; const gate = new Promise<void>(r=>release=r); const events:string[] = []
  const manager = new SharedRoomExecutorManager({
    read:()=> user ? [{userId:user,deviceId:'d',roomId:'r',roomAgentId:'a',workspaceId:'w',displayName:'n'}] : [],
    create: binding => ({...noModel,start:async()=>{ events.push(`start:${binding.userId}`); await gate; events.push(`ready:${binding.userId}`) },stop:async()=>{ events.push(`stop:${binding.userId}`) }}),
  })
  manager.refresh(); await Promise.resolve(); user = ''; manager.refresh(); await Promise.resolve(); release(); await new Promise(r=>setTimeout(r,10))
  expect(events).toContain('stop:1'); await manager.stop()
})

test('Given A 在执行且 B 断线重试 When B 重试或移除 Then A 不被停止或重建', async () => {
  const a={userId:'1',deviceId:'d',roomId:'A',roomAgentId:'a',workspaceId:'wa',displayName:'A'}
  const b={...a,roomId:'B',roomAgentId:'b',workspaceId:'wb',displayName:'B'}
  let bindings=[a,b];const starts:string[]=[];const stops:string[]=[];const callbacks:Record<string,()=>void>={}
  const manager=new SharedRoomExecutorManager({read:()=>bindings,retryMs:5,create:(binding,onStopped)=>{
    starts.push(binding.roomId);callbacks[binding.roomId]=onStopped
    return {...noModel,start:async()=>{},stop:async()=>{stops.push(binding.roomId)}}
  }})
  manager.refresh();await new Promise(r=>setTimeout(r,10));const onStopped = callbacks.B; if (!onStopped) throw new Error('B 未启动'); onStopped();await new Promise(r=>setTimeout(r,25))
  expect(starts.filter(x=>x==='A')).toHaveLength(1);expect(starts.filter(x=>x==='B').length).toBeGreaterThan(1);expect(stops).not.toContain('A')
  manager.pauseRoom('B');bindings=[a];manager.resumeRoom('B');await new Promise(r=>setTimeout(r,10));expect(stops).not.toContain('A');expect(starts.filter(x=>x==='A')).toHaveLength(1)
  await manager.stop()
})

test('Given 授权多次失败 When 计算重试 Then 指数增长并达到上限', async () => {
  const { roomRetryDelay } = await import('./shared-room-executor-manager')
  expect([0,1,2,3,20].map(n => roomRetryDelay(n,5000,300000))).toEqual([5000,10000,20000,40000,300000])
})


test('Given 房间离线或刚 ready 即断线 When 持续刷新 Then 单房间按指数退避且刷新不重置', async () => {
  jest.useFakeTimers()
  const binding={userId:'1',deviceId:'d',roomId:'r',roomAgentId:'a',workspaceId:'w',displayName:'n'}
  let starts=0; let disconnect:()=>void=()=>{}
  const manager=new SharedRoomExecutorManager({read:()=>[binding],retryMs:100,retryMaxMs:400,readyStableMs:1000,create:(_binding,onStopped,onReady)=>({...noModel,start:async()=>{starts++;disconnect=onStopped;onReady()},stop:async()=>{}})})
  try {
    manager.refresh();await Promise.resolve();expect(starts).toBe(1)
    disconnect();jest.advanceTimersByTime(99);manager.refresh();await Promise.resolve();expect(starts).toBe(1)
    jest.advanceTimersByTime(1);await Promise.resolve();expect(starts).toBe(2)
    disconnect();jest.advanceTimersByTime(199);await Promise.resolve();expect(starts).toBe(2)
    jest.advanceTimersByTime(1);await Promise.resolve();expect(starts).toBe(3)
    disconnect();jest.advanceTimersByTime(399);await Promise.resolve();expect(starts).toBe(3)
    jest.advanceTimersByTime(1);await Promise.resolve();expect(starts).toBe(4)
  } finally {await manager.stop();jest.useRealTimers()}
})

test('断线退避期间更新本地绑定，重试授权与新实例都读取最新选择',async()=>{
  const binding={userId:'1',deviceId:'dev',roomId:'r',roomAgentId:'a',workspaceId:'w',displayName:'助手'}
  const selection={channelId:'c',modelId:'new'}
  let current:import('./shared-room-executor').RoomBinding=binding, disconnect!:()=>void
  const authorized:unknown[]=[], started:unknown[]=[]
  const manager=new SharedRoomExecutorManager({read:()=>[current],retryMs:5,
    authorize:async b=>{authorized.push(b.modelSelection);return true},
    create:(b,onStopped)=>({...noModel,start:async()=>{disconnect=onStopped;started.push(b.modelSelection)},stop:async()=>{}})})
  try {
    manager.refresh();await Promise.resolve();disconnect();current={...binding,modelSelection:selection}
    for(let i=0;i<100 && started.length<2;i++)await Bun.sleep(2)
    expect(started).toEqual([undefined,selection]);expect(authorized).toEqual(started)
  } finally {await manager.stop()}
})
