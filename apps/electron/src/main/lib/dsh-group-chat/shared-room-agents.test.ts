import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SharedRoomAgents } from './shared-room-agents'

test('Given RC2 工作区 When 注册、重放、切换账号和移除 Then 仅本地绑定且网络不含路径或工作区 ID', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-agent-'))
  try {
    mkdirSync(join(root, 'dsh', 'storages'), {recursive:true})
    writeFileSync(join(root, 'dsh', 'storages', 'workspace.json'), JSON.stringify({unit:{name:'workspace',version:2},global:{initialized:true,workspaceIds:['workspace-1']},tables:{workspaces:{'workspace-1':{title:'助理',path:'/private',sessionIds:['secret']},extra:{title:'不在列表'}}}}))
    const requests: any[] = []
    const send = async (_user: string, cmd: any) => { requests.push(cmd); return {roomAgentId:'agent-1'} }
    const service = new SharedRoomAgents(join(root,'dsh'), join(root,'bindings.json'), () => 'device-1', send, () => '7')
    expect(await service.command('7',{action:'agentOptions',roomId:'room-1'})).toEqual([{id:'workspace-1',name:'助理'}])
    expect(await service.command('7',{action:'registerAgent',roomId:'room-1',workspaceId:'workspace-1',operationId:'op-1'})).toEqual({roomAgentId:'agent-1'})
    expect(await service.command('7',{action:'agentOptions',roomId:'room-1'})).toEqual([{id:'workspace-1',name:'助理',roomAgentId:'agent-1'}])
    await service.command('7',{action:'registerAgent',roomId:'room-1',workspaceId:'workspace-1',operationId:'op-1'})
    expect(JSON.stringify(requests)).not.toContain('/private')
    expect(JSON.stringify(requests)).not.toContain('workspace-1')
    expect(() => service.command('8',{action:'agentOptions',roomId:'room-1'})).toThrow()
    await service.command('7',{action:'removeAgent',roomId:'room-1',roomAgentId:'agent-1',operationId:'op-2'})
    expect(await service.command('7',{action:'agentOptions',roomId:'room-1'})).toEqual([{id:'workspace-1',name:'助理'}])
  } finally { rmSync(root,{recursive:true,force:true}) }
})

test('Given 请求结果未知 When 重启重放 Then 保留原始名称并且已完成的重放不会恢复已移除绑定', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-agent-replay-'))
  try {
    mkdirSync(join(root,'storages'))
    const file = join(root,'storages','workspace.json')
    const store = (name:string) => writeFileSync(file,JSON.stringify({unit:{name:'workspace',version:2},global:{workspaceIds:['ws']},tables:{workspaces:{ws:{title:name}}}}))
    store('原名')
    const calls:any[]=[]
    let fail = true
    const send = async (_user:string, cmd:any) => { calls.push(cmd); if (fail) throw new Error('网络中断'); return {roomAgentId:'a'} }
    const make = () => new SharedRoomAgents(root,join(root,'bindings.json'),()=> 'dev',send,()=> '7')
    const register = {action:'registerAgent',roomId:'r',workspaceId:'ws',operationId:'op'} as const
    await expect(make().command('7',register)).rejects.toThrow('网络中断')
    store('新名'); fail = false
    await make().command('7',register)
    expect(calls[1].displayName).toBe('原名')
    await make().command('7',{action:'removeAgent',roomId:'r',roomAgentId:'a',operationId:'remove'})
    await make().command('7',register)
    expect(await make().command('7',{action:'agentOptions',roomId:'r'})).toEqual([{id:'ws',name:'新名'}])
    expect(calls).toHaveLength(3)
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('Given 不可信额外字段 When 请求管理 Then 拒绝伪造设备和内部字段', async () => {
  const root = mkdtempSync(join(tmpdir(),'shared-agent-invalid-'))
  try {
    const send = async () => {throw new Error('不应访问网络')}
    const service = new SharedRoomAgents(root,join(root,'bindings.json'),()=> 'dev',send,()=> '7')
    await expect(service.command('7',{action:'agentOptions',deviceId:'fake'} as any)).rejects.toThrow('参数无效')
    await expect(service.command('7',{action:'registerAgent',roomId:'r',workspaceId:'ws',operationId:'op',deviceId:'fake'} as any)).rejects.toThrow('参数无效')
    expect(await service.command('7',{action:'agentOptions'})).toEqual([])
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('Given 队列中账号 A 切到 B 又切回 A When 旧请求开始 Then 身份代次拒绝执行', async () => {
  const root = mkdtempSync(join(tmpdir(),'shared-agent-identity-'))
  try {
    let generation = 1
    let release!:()=>void
    const gate = new Promise<void>(resolve => { release = resolve })
    mkdirSync(join(root,'storages'))
    writeFileSync(join(root,'storages','workspace.json'),JSON.stringify({unit:{name:'workspace',version:2},global:{workspaceIds:['ws']},tables:{workspaces:{ws:{title:'助理'}}}}))
    let calls = 0
    const service = new SharedRoomAgents(root,join(root,'bindings.json'),()=> 'dev',async()=>{ calls++; await gate; return {roomAgentId:'a'} },()=> '7',()=>generation)
    const first = service.command('7',{action:'registerAgent',roomId:'r',workspaceId:'ws',operationId:'one'})
    await new Promise(resolve => setTimeout(resolve, 0))
    const queued = service.command('7',{action:'agentOptions',roomId:'r'})
    generation += 2; release()
    await expect(first).rejects.toThrow('账号已切换')
    await expect(queued).rejects.toThrow('账号已切换')
    expect(calls).toBe(1)
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('Given 标题缺失或已删除的工作区 When 加载选项 Then 只使用 basename 或已绑定旧名且限制名称字节数', async () => {
  const root = mkdtempSync(join(tmpdir(),'shared-agent-name-'))
  try {
    mkdirSync(join(root,'storages'))
    const file = join(root,'storages','workspace.json')
    const write = (ids:string[], entries:object) => writeFileSync(file,JSON.stringify({unit:{name:'workspace',version:2},global:{workspaceIds:ids},tables:{workspaces:entries}}))
    write(['ws','long'],{ws:{path:'/private/可用名称'},long:{title:'中'.repeat(43)}})
    const service = new SharedRoomAgents(root,join(root,'bindings.json'),()=> 'dev',async()=>({roomAgentId:'agent'}),()=> '7')
    expect(await service.command('7',{action:'agentOptions',roomId:'r'})).toEqual([{id:'ws',name:'可用名称'}])
    await service.command('7',{action:'registerAgent',roomId:'r',workspaceId:'ws',operationId:'one'})
    write([], {})
    expect(await service.command('7',{action:'agentOptions',roomId:'r'})).toEqual([{id:'ws',name:'可用名称',roomAgentId:'agent'}])
    await expect(service.command('7',{action:'registerAgent',roomId:'r',workspaceId:'ws',operationId:'two'})).rejects.toThrow('工作区不存在')
    await service.command('7',{action:'removeAgent',roomId:'r',roomAgentId:'agent',operationId:'three'})
    expect(await service.command('7',{action:'agentOptions',roomId:'r'})).toEqual([])
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('Given 注册响应丢失并重启 When 新登记意图 Then 查询旧回执并恢复绑定而不重发旧操作', async () => {
  const root = mkdtempSync(join(tmpdir(),'shared-agent-recover-'))
  try {
    mkdirSync(join(root,'storages'))
    writeFileSync(join(root,'storages','workspace.json'),JSON.stringify({unit:{name:'workspace',version:2},global:{workspaceIds:['ws']},tables:{workspaces:{ws:{title:'助理'}}}}))
    const calls:any[]=[]
    const send = async (_user:string, cmd:any) => { calls.push(cmd); if (cmd.action === 'internalRegisterAgent') throw new Error('响应丢失'); return {roomAgentId:'agent'} }
    const make = () => new SharedRoomAgents(root,join(root,'bindings.json'),()=> 'dev',send,()=> '7')
    await expect(make().command('7',{action:'registerAgent',roomId:'r',workspaceId:'ws',operationId:'old'})).rejects.toThrow('响应丢失')
    expect(await make().command('7',{action:'registerAgent',roomId:'r',workspaceId:'ws',operationId:'new'})).toEqual({roomAgentId:'agent'})
    expect(await make().command('7',{action:'registerAgent',roomId:'r',workspaceId:'ws',operationId:'new'})).toEqual({roomAgentId:'agent'})
    expect(calls.map(c=>c.action)).toEqual(['internalRegisterAgent','internalAgentOperationStatus'])
    expect(await make().command('7',{action:'agentOptions',roomId:'r'})).toEqual([{id:'ws',name:'助理',roomAgentId:'agent'}])
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('Given 旧登记状态暂不可查 When 新登记意图 Then 不重复提交登记', async () => {
  const root = mkdtempSync(join(tmpdir(),'shared-agent-unknown-'))
  try {
    mkdirSync(join(root,'storages'))
    writeFileSync(join(root,'storages','workspace.json'),JSON.stringify({unit:{name:'workspace',version:2},global:{workspaceIds:['ws']},tables:{workspaces:{ws:{title:'助理'}}}}))
    const calls:string[]=[]
    const send = async (_user:string, cmd:any) => {calls.push(cmd.action); throw new Error('结果未知')}
    const make = () => new SharedRoomAgents(root,join(root,'bindings.json'),()=> 'dev',send,()=> '7')
    await expect(make().command('7',{action:'registerAgent',roomId:'r',workspaceId:'ws',operationId:'old'})).rejects.toThrow('结果未知')
    await expect(make().command('7',{action:'registerAgent',roomId:'r',workspaceId:'ws',operationId:'new'})).rejects.toThrow('结果未知')
    expect(calls).toEqual(['internalRegisterAgent','internalAgentOperationStatus'])
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('Given 明确回执不存在 When 新用户登记 Then 才允许新操作，其他错误不允许', async () => {
  const root = mkdtempSync(join(tmpdir(),'shared-agent-notfound-'))
  try {
    mkdirSync(join(root,'storages')); writeFileSync(join(root,'storages','workspace.json'),JSON.stringify({unit:{name:'workspace',version:2},global:{workspaceIds:['ws']},tables:{workspaces:{ws:{title:'助理'}}}}))
    const calls:string[]=[]
    const send = async (_user:string, cmd:any) => {calls.push(cmd.action); if (cmd.operationId === 'old' && cmd.action === 'internalRegisterAgent') throw new Error('网络断开'); if (cmd.action === 'internalAgentOperationStatus') throw Object.assign(new Error('不存在'),{status:404,code:'management_operation_not_found'}); return {roomAgentId:'agent'} }
    const make = () => new SharedRoomAgents(root,join(root,'bindings.json'),()=> 'dev',send,()=> '7')
    await expect(make().command('7',{action:'registerAgent',roomId:'r',workspaceId:'ws',operationId:'old'})).rejects.toThrow()
    expect(await make().command('7',{action:'registerAgent',roomId:'r',workspaceId:'ws',operationId:'new'})).toEqual({roomAgentId:'agent'})
    expect(calls).toEqual(['internalRegisterAgent','internalAgentOperationStatus','internalRegisterAgent'])
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('Given 群已满且旧注册结果未知 When 加载房间选项 Then 仅读回执并恢复绑定', async () => {
  const root = mkdtempSync(join(tmpdir(),'shared-agent-options-recover-'))
  try {
    mkdirSync(join(root,'storages')); writeFileSync(join(root,'storages','workspace.json'),JSON.stringify({unit:{name:'workspace',version:2},global:{workspaceIds:['ws']},tables:{workspaces:{ws:{title:'助理'}}}}))
    const calls:string[]=[]
    const send = async (_user:string, cmd:any) => {calls.push(cmd.action); if (cmd.action === 'internalRegisterAgent') throw new Error('断开'); return {roomAgentId:'agent'}}
    const make = () => new SharedRoomAgents(root,join(root,'bindings.json'),()=> 'dev',send,()=> '7')
    await expect(make().command('7',{action:'registerAgent',roomId:'r',workspaceId:'ws',operationId:'old'})).rejects.toThrow()
    expect(await make().command('7',{action:'agentOptions',roomId:'r'})).toEqual([{id:'ws',name:'助理',roomAgentId:'agent'}])
    expect(calls).toEqual(['internalRegisterAgent','internalAgentOperationStatus'])
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('Given 查询得到其他 404 或 403 When 加载房间选项 Then 保持未知且不重发登记', async () => {
  for (const failure of [{status:404,code:'room_not_found'},{status:403,code:'forbidden'}]) {
    const root = mkdtempSync(join(tmpdir(),'shared-agent-options-error-'))
    try {
      mkdirSync(join(root,'storages')); writeFileSync(join(root,'storages','workspace.json'),JSON.stringify({unit:{name:'workspace',version:2},global:{workspaceIds:['ws']},tables:{workspaces:{ws:{title:'助理'}}}}))
      const calls:string[]=[]
      const send = async (_user:string, cmd:any) => {calls.push(cmd.action); throw Object.assign(new Error('不可确认'), cmd.action === 'internalAgentOperationStatus' ? failure : {})}
      const make = () => new SharedRoomAgents(root,join(root,'bindings.json'),()=> 'dev',send,()=> '7')
      await expect(make().command('7',{action:'registerAgent',roomId:'r',workspaceId:'ws',operationId:'old'})).rejects.toThrow()
      await expect(make().command('7',{action:'agentOptions',roomId:'r'})).rejects.toThrow('不可确认')
      expect(calls).toEqual(['internalRegisterAgent','internalAgentOperationStatus'])
    } finally {rmSync(root,{recursive:true,force:true})}
  }
})

test('Given 本机受信绑定 When 账号或设备不匹配或工作区删除 Then 不返回执行器绑定', async () => {
  const root = mkdtempSync(join(tmpdir(),'shared-agent-bindings-'))
  try {
    mkdirSync(join(root,'storages'))
    const workspace = join(root,'storages','workspace.json')
    writeFileSync(workspace,JSON.stringify({unit:{name:'workspace',version:2},global:{workspaceIds:['ws']},tables:{workspaces:{ws:{title:'助手'}}}}))
    const service = new SharedRoomAgents(root,join(root,'bindings.json'),()=> 'dev',async()=>({roomAgentId:'agent'}),()=> '7')
    await service.command('7',{action:'registerAgent',roomId:'room',workspaceId:'ws',operationId:'op'})
    expect(service.executorBindings('7')).toEqual([{userId:'7',deviceId:'dev',roomId:'room',roomAgentId:'agent',workspaceId:'ws',displayName:'助手'}])
    expect(service.executorBindings('8')).toEqual([])
    writeFileSync(workspace,JSON.stringify({unit:{name:'workspace',version:2},global:{workspaceIds:[]},tables:{workspaces:{}}}))
    expect(service.executorBindings('7')).toEqual([])
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('Given 可信群解散成功 When 清理绑定 Then 仅移除该账号该群绑定并保留操作记录', async () => {
  const root=mkdtempSync(join(tmpdir(),'shared-agent-dissolve-')); const path=join(root,'bindings.json')
  try {
    writeFileSync(path,JSON.stringify({version:1,operations:[{user:'7',device:'d',room:'r',operation:'op',action:'register',workspace:'w',agent:'a',done:true}],bindings:[{user:'7',device:'d',room:'r',workspace:'w',agent:'a'},{user:'7',device:'d',room:'other',workspace:'w',agent:'b'},{user:'8',device:'d',room:'r',workspace:'w',agent:'c'}]}))
    const service=new SharedRoomAgents(root,path,()=> 'd',async()=>({}),()=> '7',()=>1)
    await service.removeRoomBindings('7','r',1)
    const {readFileSync}=await import('node:fs');const state=JSON.parse(readFileSync(path,'utf8'))
    expect(state.operations).toHaveLength(1);expect(state.bindings.map((b:any)=>`${b.user}/${b.room}`)).toEqual(['7/other','8/r'])
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('Given 群解散期间账号代次改变 When 清理旧回执 Then 拒绝清理并保留绑定', async () => {
  const root=mkdtempSync(join(tmpdir(),'shared-agent-dissolve-switch-'));const path=join(root,'bindings.json')
  try {
    const initial={version:1,operations:[],bindings:[{user:'7',device:'d',room:'r',workspace:'w',agent:'a'}]}
    writeFileSync(path,JSON.stringify(initial));const service=new SharedRoomAgents(root,path,()=> 'd',async()=>({}),()=> '7',()=>2)
    expect(()=>service.removeRoomBindings('7','r',1)).toThrow('账号已切换')
    const {readFileSync}=await import('node:fs');expect(JSON.parse(readFileSync(path,'utf8'))).toEqual(initial)
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('换模准备期间切号再切回，丢弃候选并保留原绑定', async () => {
  const root = mkdtempSync(join(tmpdir(), 'room-model-epoch-'))
  const file = join(root, 'bindings.json')
  const old = {channelId:'channel1', modelId:'old'}, next = {channelId:'channel2', modelId:'new'}
  let epoch = 1, discarded = 0, committed = 0
  const arrived = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  try {
    mkdirSync(join(root, 'storages'))
    writeFileSync(join(root,'storages','workspace.json'),JSON.stringify({unit:{name:'workspace',version:2},global:{workspaceIds:['ws']},tables:{workspaces:{ws:{title:'测试'}}}}))
    writeFileSync(file, JSON.stringify({version:1, operations:[], bindings:[{user:'7',device:'dev',room:'r',workspace:'ws',agent:'a',modelSelection:old}]}))
    const registry = new SharedRoomAgents(root,file,()=> 'dev',async()=>{throw Error('意外写入')},()=> '7',()=>epoch)
    const save = registry.modelCommand('7', {action:'setRoomModel',roomId:'r',roomAgentId:'a',...next}, 1, {
      detail: async () => ({room:{roomId:'r',status:'active',hostUserId:7},agents:[{roomId:'r',ownerUserId:7,roomAgentId:'a'}]}),
      catalog: () => ({current:old,options:[{...next,name:'新模型'}]}), active: () => old,
      prepare:async () => {arrived.resolve();await gate.promise;return {commit:()=>{committed++},discard:async()=>{discarded++}}},
    })
    await arrived.promise; epoch += 2; gate.resolve()
    await expect(save).rejects.toThrow('账号已切换')
    expect([committed,discarded]).toEqual([0,1])
    expect(registry.executorBindings('7')[0]?.modelSelection).toEqual(old)
  } finally {gate.resolve();rmSync(root,{recursive:true,force:true})}
})
