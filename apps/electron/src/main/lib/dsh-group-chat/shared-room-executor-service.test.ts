import { expect, test } from 'bun:test'

// 单独进程替换 Electron 和模型模块，不污染其他执行器测试或读取本机账号。
test('服务未启动时也能验证、保存选择，但不连接且不报告在线；账号变化则拒绝落盘', () => {
  const run = Bun.spawnSync([process.execPath,'-e',`
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    const binding = {userId:'1',deviceId:'d',roomId:'r',roomAgentId:'a',workspaceId:'w',displayName:'助手'}
    const selection = {channelId:'channel',modelId:'model'}
    let rows = [binding], revision = 0, revoked = 0
    mock.module('electron',()=>({app:{once(){throw Error('不应启动服务')}}}))
    mock.module('ws',()=>({default:class {constructor(){throw Error('不应连接')}}}))
    mock.module('../working-api-service',()=>({getWorkingApiClient:()=>({getCachedUser:()=>({id:1}),getIdentityRevision:()=>revision})}))
    mock.module('../working-auth-store',()=>({getWorkingTokenStore:()=>({getToken:()=>'token'}),subscribeWorkingIdentity(){throw Error('不应启动服务')}}))
    mock.module('../config-paths',()=>({getConfigDir:()=>'.',getDshHomeDir:()=>'.'}))
    mock.module('../http-api-server',()=>({getHttpApiInternalToken:()=>''}))
    mock.module('../client-device-id',()=>({getOrCreateClientDeviceId:()=>'d'}))
    mock.module('./shared-room-agents',()=>({SharedRoomAgents:class {executorBindings(user){assert.equal(user,'1');return rows}}}))
    mock.module('./shared-room-model-runtime',()=>({openRoomModelRuntime:async b=>{
      assert.deepEqual(b,{...binding,modelSelection:selection})
      return {modelSelection:selection,submit:async()=>'',revoke:async()=>{revoked++}}
    }}))
    const service = await import('./shared-room-executor-service')
    const prepare = ()=>service.prepareRoomModelChange(binding,selection)
    const first = await prepare(); first.commit(()=>{rows=[{...binding,modelSelection:selection}]});await first.discard()
    assert.equal(service.activeRoomModel(binding),undefined);assert.equal(revoked,1)
    const stale = await prepare(); revision++; let wrote = false
    assert.throws(()=>stale.commit(()=>{wrote=true}));await stale.discard()
    assert.equal(wrote,false);assert.equal(revoked,2);await service.stopSharedRoomExecutorService()
  `],{cwd:import.meta.dir})
  expect(run.stderr.toString()).toBe(''); expect(run.exitCode).toBe(0)
})
