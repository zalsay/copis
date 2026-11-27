/** 仅由 verify-dsh-queue.py 在临时目录运行。两个临时身份、真实 WS 和 RC2，适配器完全离线。 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { SharedRoomAgents } from '../../apps/electron/src/main/lib/dsh-group-chat/shared-room-agents'
import { SharedRoomExecutorManager } from '../../apps/electron/src/main/lib/dsh-group-chat/shared-room-executor-manager'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { SharedRoomExecutor } from '../../apps/electron/src/main/lib/dsh-group-chat/shared-room-executor'
import { createSharedRoomSession } from '../../apps/electron/src/main/lib/dsh-group-chat/shared-room-session.mjs'

const f = JSON.parse(process.env.COPIS_QUEUE_FIXTURE!)
assert.equal(new URL(f.url).hostname, '127.0.0.1')
const binding = { userId: String(f.userId), deviceId: f.deviceId, roomId: f.roomId, roomAgentId: f.agentId, workspaceId:'fixture', displayName:'Build' }
const runtimeDir = process.env.COPIS_DSH_RC2_RUNTIME!
const resolve = createRequire(join(runtimeDir,'package.json')).resolve
const { LlmAdapter } = await import(pathToFileURL(resolve('@deepseek-ai/dsh-llm')).href)
const WebSocket = createRequire(join(process.env.COPIS_QUEUE_ROOT!, 'apps/electron/package.json'))('ws')
const api = f.url + '/api/chatrooms/v2/rooms/' + binding.roomId
async function call(path:string, payload?:object, cookie=f.memberCookie) {
  const r = await fetch(api + path, {method:payload?'POST':'GET', headers:{Cookie:cookie,'Content-Type':'application/json'}, body:payload?JSON.stringify(payload):undefined})
  assert.equal(r.status,200,`${path}: HTTP ${r.status}`)
  return (await r.json()).data
}
const status = async (cookie=f.memberCookie) => (await call('', undefined, cookie)).agents[0]
const post = (seq:number, mention=true, cookie=f.memberCookie) => call('/messages',{content:`问题 ${seq}`,clientMessageId:`probe-${seq}`,mentionAgentIds:mention?[f.agentId]:[],attachmentIds:[]},cookie)
async function until(predicate:()=>Promise<boolean>|boolean, label:string) {
  for(let i=0;i<100;i++){if(await predicate())return; await delay(100)}
  throw Error(`等待超时：${label}`)
}
const seen:string[]=[]
let release = 0
class OfflineAdapter extends LlmAdapter {
  constructor(private readonly servedModel: string) { super() }
  async resolveModel(provider:string, model:string){return {id:model,name:model,provider}}
  async *stream(options:any){
    const input=JSON.stringify(options.messages.at(-1)), question = /问题 [123]/.exec(input)?.[0]
    assert.ok(question, '只应处理指定的触发文本'); assert.equal(options.tools?.length??0,0)
    seen.push(question); const n=seen.length
    await until(()=>release>=n || options.signal.aborted, '释放测试模型')
    if(options.signal.aborted)return
    const text=`${this.servedModel} 回答 ${n}`
    yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}}
  }
}
const home = process.env.HOME!
const initial = {channelId:'probe', modelId:'旧模型'}, desired = {channelId:'probe', modelId:'新模型'}
mkdirSync(join(home, 'storages'))
writeFileSync(join(home, 'storages/workspace.json'), JSON.stringify({unit:{name:'workspace',version:2},global:{workspaceIds:['fixture']},tables:{workspaces:{fixture:{title:'Build'}}}}))
const file = join(home, 'test-bindings.json')
writeFileSync(file, JSON.stringify({version:1,operations:[],bindings:[{user:binding.userId,device:binding.deviceId,room:f.roomId,workspace:'fixture',agent:f.agentId}]}))
const registry = new SharedRoomAgents(home, file, () => f.deviceId, async () => {throw Error('换模型不应登记或移除智能体')}, () => binding.userId)
async function open(b: typeof binding & { modelSelection?: typeof initial }) {
  const modelSelection = b.modelSelection ?? initial
  const session = await createSharedRoomSession({runtimeDir,provider:modelSelection.channelId,model:modelSelection.modelId,
    adapter:new OfflineAdapter(modelSelection.modelId),documents:[],responsibility:'',journalDir:join(home,'session'),ownerId:b.userId,roomId:b.roomId,agentId:b.roomAgentId})
  return { ...session, modelSelection }
}
let connections = 0
const manager = new SharedRoomExecutorManager({ read:() => registry.executorBindings(binding.userId),
  create:(b,onStopped,onReady,latest) => new SharedRoomExecutor(b, {journalDir:join(home,'executor'),onStopped,onReady,
    socket:() => { connections++; return new WebSocket(f.url.replace(/^http:/,'ws:')+'/api/chatrooms/v2/ws',{headers:{Cookie:f.hostCookie}}) },
    openModel:()=>open(latest()),
  }),
})
try {
  manager.refresh(); await until(async()=>(await status()).availability==='online','设备真实就绪')
  assert.equal((await post(0,false)).invocations.length,0)
  await post(1);await until(()=>seen.length===1,'第一条进入 RC2')
  await post(2,true,f.hostCookie);await post(2,true,f.hostCookie);await post(3)
  const saved = await registry.modelCommand(binding.userId, {action:'setRoomModel',roomId:f.roomId,roomAgentId:f.agentId,...desired}, 0, {
    detail:() => call('',undefined,f.hostCookie), active:b=>manager.activeRoomModel(b),
    catalog:(_user,current) => ({current:current ?? initial, options:[initial,desired].map(m=>({...m,name:m.modelId}))}),
    prepare:(b,selection)=>manager.prepareRoomModelChange(b,selection,open),
  })
  assert.deepEqual(saved, desired); manager.refresh()
  for(let i=1;i<=3;i++){
    await until(()=>seen.length===i,`第 ${i} 条进入 RC2`)
    const state = await status(); assert.equal(state.availability,'busy');assert.equal(state.queuedCount,3-i)
    const hostState=await status(f.hostCookie); assert.equal(hostState.availability,state.availability); assert.equal(hostState.queuedCount,state.queuedCount)
    release=i
  }
  await until(async()=>(await status()).availability==='online','回到空闲')
  assert.equal((await status()).queuedCount,0)
  assert.deepEqual(seen,['问题 1','问题 2','问题 3'])
  assert.deepEqual((await call('/messages')).filter((m:any)=>m.senderType==='agent').map((m:any)=>m.content),['旧模型 回答 1','新模型 回答 2','新模型 回答 3'])
  assert.equal(connections,1, '换模不应重连或清空队列')
}finally{release=4;await manager.stop()}
await until(async()=>(await status()).availability==='offline','群主离线')
assert.equal((await post(4)).invocations.length,0)
console.log('PASS: 双身份 WS → RC2 → 顺序回复；在途使用旧模型、等待项使用新模型；排队 2→1→0，重放不重复，离线不入队。')
