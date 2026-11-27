import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DSH_GROUP_CHAT_IPC_CHANNELS } from '@copis/shared'
import { createIpcHarness } from './t2-harness'

// 不得把测试群或工作区写入/读取真实 profile。
const fixture = mkdtempSync(join(tmpdir(), 'copis-group-ipc-'))
mkdirSync(join(fixture, 'storages'))
writeFileSync(join(fixture, 'storages', 'workspace.json'), JSON.stringify({tables: {workspaces: {fixture: {title: '测试空间'}}}}))
mock.module('../lib/config-paths', () => ({
  getDshHomeDir: () => fixture,
  getConfigDir: () => fixture,
  getDshGroupChatsDir: () => join(fixture, 'rooms'),
  getDshGroupChatDir: (id: string) => join(fixture, 'rooms', id),
}))
afterAll(() => rmSync(fixture, { recursive: true, force: true }))

const h = createIpcHarness()
let rejectPreparation = false
const liveSend = mock((_channel: string, _payload: unknown) => {})

// 执行器生命周期单独在定向测试中验证；此处保留真实绑定管理实现。
mock.module('../lib/dsh-group-chat/shared-room-executor-service', () => ({
  startSharedRoomExecutorService: () => {}, suspendSharedRoomExecutors: () => {}, refreshSharedRoomExecutors: () => {},
  activeRoomModel: () => undefined,
  prepareRoomModelChange: async () => {
    if (rejectPreparation) throw new Error('候选模型加载失败')
    return {commit: (persist: () => void) => persist(), discard: () => Promise.resolve()}
  },
  getSharedRoomAgents: () => {
    const { SharedRoomAgents } = require('../lib/dsh-group-chat/shared-room-agents')
    const { getWorkingApiClient } = require('../lib/working-api-service')
    const { getHttpApiInternalToken } = require('../lib/http-api-server')
    const { getOrCreateClientDeviceId } = require('../lib/client-device-id')
    return new SharedRoomAgents(fixture,join(fixture,'bindings.json'),getOrCreateClientDeviceId,
      (user:string, command:unknown) => getWorkingApiClient().sharedRoomCommand(user,command,getHttpApiInternalToken()),
      () => String(getWorkingApiClient().getCachedUser()?.id ?? ''), () => getWorkingApiClient().getIdentityRevision())
  },
}))

mock.module('electron', () => ({
  ipcMain: h.ipcMain,
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: liveSend } },
      { isDestroyed: () => true, webContents: { send: mock(() => {}) } },
    ],
  },
}))

test('dsh-group-chat IPC handlers should register all DSH_GROUP_CHAT_IPC_CHANNELS correctly', async () => {
  const { registerDshGroupChatIpcHandlers } = await import('../ipc/dsh-group-chat.ipc')
  registerDshGroupChatIpcHandlers()

  const expectedChannels = [
    DSH_GROUP_CHAT_IPC_CHANNELS.SHARED_ROOM_COMMAND,
    DSH_GROUP_CHAT_IPC_CHANNELS.LIST_CREATION_WORKSPACES,
    DSH_GROUP_CHAT_IPC_CHANNELS.LIST_GROUPS,
    DSH_GROUP_CHAT_IPC_CHANNELS.GET_GROUP,
    DSH_GROUP_CHAT_IPC_CHANNELS.CREATE_GROUP,
    DSH_GROUP_CHAT_IPC_CHANNELS.UPDATE_GROUP,
    DSH_GROUP_CHAT_IPC_CHANNELS.DELETE_GROUP,
    DSH_GROUP_CHAT_IPC_CHANNELS.ADD_AGENT,
    DSH_GROUP_CHAT_IPC_CHANNELS.REMOVE_AGENT,
    DSH_GROUP_CHAT_IPC_CHANNELS.UPDATE_AGENT_RESPONSIBILITY,
    DSH_GROUP_CHAT_IPC_CHANNELS.UPDATE_AGENT_MODEL,
    DSH_GROUP_CHAT_IPC_CHANNELS.GET_AVAILABLE_MODELS,
    DSH_GROUP_CHAT_IPC_CHANNELS.GET_MESSAGES,
    DSH_GROUP_CHAT_IPC_CHANNELS.POST_MESSAGE,
    DSH_GROUP_CHAT_IPC_CHANNELS.MARK_READ,
    DSH_GROUP_CHAT_IPC_CHANNELS.GET_TASKS,
    DSH_GROUP_CHAT_IPC_CHANNELS.CREATE_TASK,
    DSH_GROUP_CHAT_IPC_CHANNELS.UPDATE_TASK,
    DSH_GROUP_CHAT_IPC_CHANNELS.DECOMPOSE_TASKS,
    DSH_GROUP_CHAT_IPC_CHANNELS.ARCHIVE_TASK,
    DSH_GROUP_CHAT_IPC_CHANNELS.GET_INVOCATION,
    DSH_GROUP_CHAT_IPC_CHANNELS.STOP_INVOCATION,
  ]

  const registeredChannels = new Set(h.ipcMain.handle.mock.calls.map((call) => call[0]))

  for (const channel of expectedChannels) {
    expect(registeredChannels.has(channel)).toBeTrue()
  }

  // 模拟调用 CREATE_GROUP
  const createdGroup: any = await h.invoke(DSH_GROUP_CHAT_IPC_CHANNELS.CREATE_GROUP, {}, {
    name: 'IPC 测试组',
    description: '通过 IPC 创建的群组',
  })
  expect(createdGroup.id).toStartWith('grp_')
  expect(createdGroup.name).toBe('IPC 测试组')

  // 模拟调用 LIST_GROUPS
  const groups: any = await h.invoke(DSH_GROUP_CHAT_IPC_CHANNELS.LIST_GROUPS, {})
  expect(groups.length).toBeGreaterThan(0)
  expect(groups.some((g: any) => g.id === createdGroup.id)).toBeTrue()

  // 模拟调用 POST_MESSAGE
  const msg: any = await h.invoke(DSH_GROUP_CHAT_IPC_CHANNELS.POST_MESSAGE, {}, {
    groupId: createdGroup.id,
    text: '通过 IPC 发送的消息',
  })
  expect(msg.seq).toBe(1)
  expect(msg.text).toBe('通过 IPC 发送的消息')

  // 模拟调用 GET_TASKS（创建群后初始化版本自增为 2）
  const taskBoard: any = await h.invoke(DSH_GROUP_CHAT_IPC_CHANNELS.GET_TASKS, {}, createdGroup.id)
  expect(taskBoard.revision).toBe(2)

  // 模拟调用 LIST_CREATION_WORKSPACES
  const workspaces: any = await h.invoke(DSH_GROUP_CHAT_IPC_CHANNELS.LIST_CREATION_WORKSPACES, {})
  expect(Array.isArray(workspaces)).toBeTrue()
  expect(workspaces.length).toBeGreaterThan(0)
})


test('共享群 IPC 只接受主窗口顶层，不把内部令牌交给渲染进程', async () => {
  const contents = { mainFrame: {} }
  const command = mock(async () => ['room-1'])
  mock.module('../index', () => ({getMainWindow: () => ({isDestroyed: () => false, webContents: contents})}))
  mock.module('../lib/http-api-server', () => ({getHttpApiInternalToken: () => 'internal-fixture'}))
  mock.module('../lib/working-api-service', () => ({getWorkingApiClient: () => ({sharedRoomCommand: command})}))
  const { registerDshGroupChatIpcHandlers } = await import('../ipc/dsh-group-chat.ipc')
  registerDshGroupChatIpcHandlers()
  const channel = DSH_GROUP_CHAT_IPC_CHANNELS.SHARED_ROOM_COMMAND
  for (const event of [{sender: contents, senderFrame: {}}, {sender: {}, senderFrame: contents.mainFrame}]) {
    await expect(h.invoke(channel, event, '7', {action:'list'})).rejects.toThrow('主窗口顶层')
  }
  expect(command).not.toHaveBeenCalled()
  expect(await h.invoke(channel, {sender: contents, senderFrame: contents.mainFrame}, '7', {action:'list'})).toEqual(['room-1'])
  expect(command).toHaveBeenCalledWith('7', {action:'list'}, 'internal-fixture')
  const remove = {action:'removeMember', roomId:'room1', memberId:8}
  await h.invoke(channel, {sender: contents, senderFrame: contents.mainFrame}, '7', remove)
  expect(command).toHaveBeenCalledWith('7', remove, 'internal-fixture')
})

test('共享群 IPC 禁止渲染进程直接调用内部智能体管理命令', async () => {
  const contents = { mainFrame: {} }
  const command = mock(async () => ({}))
  mock.module('../index', () => ({getMainWindow: () => ({isDestroyed: () => false, webContents: contents})}))
  mock.module('../lib/http-api-server', () => ({getHttpApiInternalToken: () => 'internal-fixture'}))
  mock.module('../lib/working-api-service', () => ({getWorkingApiClient: () => ({sharedRoomCommand: command})}))
  const { registerDshGroupChatIpcHandlers } = await import('../ipc/dsh-group-chat.ipc')
  registerDshGroupChatIpcHandlers()
  await expect(h.invoke(DSH_GROUP_CHAT_IPC_CHANNELS.SHARED_ROOM_COMMAND, {sender:contents,senderFrame:contents.mainFrame}, '7', {action:'internalRegisterAgent', deviceId:'forged'})).rejects.toThrow()
  await expect(h.invoke(DSH_GROUP_CHAT_IPC_CHANNELS.SHARED_ROOM_COMMAND, {sender:contents,senderFrame:contents.mainFrame}, '7', {action:'internalMarkDshShared',roomId:'room1',roomAgentId:'agent1',deviceId:'forged'})).rejects.toThrow()
  expect(command).not.toHaveBeenCalled()
})

test('共享群 IPC 根据可信设备与本地工作区转换注册请求', async () => {
  writeFileSync(join(fixture,'storages','workspace.json'), JSON.stringify({unit:{name:'workspace',version:2},global:{workspaceIds:['fixture']},tables:{workspaces:{fixture:{title:'测试空间',path:'/private'}}}}))
  const contents = {mainFrame:{}}
  const send = mock(async () => ({roomAgentId:'agent1'}))
  mock.module('../index', () => ({getMainWindow: () => ({isDestroyed: () => false, webContents: contents})}))
  mock.module('../lib/http-api-server', () => ({getHttpApiInternalToken: () => 'internal-fixture'}))
  mock.module('../lib/client-device-id', () => ({getOrCreateClientDeviceId: () => 'device1'}))
  mock.module('../lib/working-api-service', () => ({getWorkingApiClient: () => ({getCachedUser: () => ({id:7}), getIdentityRevision: () => 1, sharedRoomCommand:send})}))
  const { registerDshGroupChatIpcHandlers } = await import('../ipc/dsh-group-chat.ipc')
  registerDshGroupChatIpcHandlers()
  const result = await h.invoke(DSH_GROUP_CHAT_IPC_CHANNELS.SHARED_ROOM_COMMAND,{sender:contents,senderFrame:contents.mainFrame},'7',{action:'registerAgent',roomId:'room1',workspaceId:'fixture',operationId:'op1'})
  expect(result).toEqual({roomAgentId:'agent1'})
  expect(send).toHaveBeenCalledWith('7',{action:'internalRegisterAgent',roomId:'room1',operationId:'op1',deviceId:'device1',displayName:'测试空间'},'internal-fixture')
})

test('共享群解散仅在匹配成功回执后清除本地绑定', async () => {
  const {readFileSync} = await import('node:fs')
  const path=join(fixture,'bindings.json');const binding={user:'7',device:'device1',room:'room1',workspace:'fixture',agent:'agent1'}
  const reset = () => writeFileSync(path,JSON.stringify({version:1,operations:[{user:'7',device:'device1',room:'room1',operation:'op',action:'register',workspace:'fixture',agent:'agent1',done:true}],bindings:[binding]}))
  const contents={mainFrame:{}}; let response:unknown={roomId:'other'};let fail=false
  mock.module('../index',()=>({getMainWindow:()=>({isDestroyed:()=>false,webContents:contents})}))
  mock.module('../lib/http-api-server',()=>({getHttpApiInternalToken:()=> 'internal-fixture'}))
  mock.module('../lib/client-device-id',()=>({getOrCreateClientDeviceId:()=> 'device1'}))
  mock.module('../lib/working-api-service',()=>({getWorkingApiClient:()=>({getCachedUser:()=>({id:7}),getIdentityRevision:()=>1,sharedRoomCommand:async()=>{if(fail) throw new Error('offline');return response}})}))
  const {registerDshGroupChatIpcHandlers}=await import('../ipc/dsh-group-chat.ipc');registerDshGroupChatIpcHandlers()
  const invoke=()=>h.invoke(DSH_GROUP_CHAT_IPC_CHANNELS.SHARED_ROOM_COMMAND,{sender:contents,senderFrame:contents.mainFrame},'7',{action:'dissolve',roomId:'room1'})
  reset(); await expect(invoke()).rejects.toThrow('回执不匹配');expect(JSON.parse(readFileSync(path,'utf8')).bindings).toHaveLength(1)
  fail=true;await expect(invoke()).rejects.toThrow('offline');expect(JSON.parse(readFileSync(path,'utf8')).bindings).toHaveLength(1)
  fail=false;response={roomId:'room1'};await invoke();const state=JSON.parse(readFileSync(path,'utf8'));expect(state.bindings).toHaveLength(0);expect(state.operations).toHaveLength(1)
})


test('回答模型只允许本机群主修改；保存只作用于目标绑定，加载或权限复核失败不覆盖', async () => {
  const {readFileSync} = await import('node:fs')
  const path = join(fixture, 'bindings.json')
  const bindings = ['r','other'].map(room => ({user:'7',device:'device1',workspace:'fixture',room,agent:'a'}))
  writeFileSync(path, JSON.stringify({version:1,operations:[],bindings}))
  writeFileSync(join(fixture,'storages','workspace.json'), JSON.stringify({unit:{name:'workspace',version:2},global:{workspaceIds:['fixture']},tables:{workspaces:{fixture:{title:'测试空间'}}}}))
  const contents = {mainFrame:{}}
  let host = 7, reads = 0, revokeAfter = Infinity
  const first = { channelId:'builtin', modelId:'a' }, next = { channelId:'owner-custom', modelId:'custom/b' }
  const options = [{...first,name:'当前模型'}, {...next,name:'新模型'}]
  mock.module('../lib/dsh-group-chat/shared-room-model-runtime', () => ({getRoomModelCatalog: (_user:string, effective?: typeof next) => ({current:effective ?? first,options})}))
  mock.module('../index',()=>({getMainWindow:()=>({isDestroyed:()=>false,webContents:contents})}))
  mock.module('../lib/http-api-server',()=>({getHttpApiInternalToken:()=> 'test'}))
  mock.module('../lib/client-device-id',()=>({getOrCreateClientDeviceId:()=> 'device1'}))
  mock.module('../lib/working-api-service',()=>({getWorkingApiClient:()=>({getCachedUser:()=>({id:7}),getIdentityRevision:()=>1,
    sharedRoomCommand:async (_user:string,c:{action:string;roomId:string})=>{
      expect(c).toEqual({action:'detail',roomId:'r'}); reads++
      return {room:{roomId:'r',hostUserId:reads>revokeAfter?8:host,status:'active'},agents:[{roomId:'r',ownerUserId:7,roomAgentId:'a'}]}
    }})}))
  const {registerDshGroupChatIpcHandlers}=await import('../ipc/dsh-group-chat.ipc'); registerDshGroupChatIpcHandlers()
  const invoke = (command:object) => h.invoke(DSH_GROUP_CHAT_IPC_CHANNELS.SHARED_ROOM_COMMAND,{sender:contents,senderFrame:contents.mainFrame},'7',{roomId:'r',roomAgentId:'a',...command})
  const list = {action:'roomModelOptions'}, set = {action:'setRoomModel', ...next}
  host=8; await expect(invoke(list)).rejects.toThrow(); await expect(invoke(set)).rejects.toThrow()
  host=7; await expect(invoke({...set,roomAgentId:'foreign'})).rejects.toThrow()
  expect(await invoke(list)).toEqual({current:first,options})
  await expect(invoke({...set,channelId:'unlisted'})).rejects.toThrow()
  await expect(invoke({...set,apiKey:'forged'})).rejects.toThrow()
  rejectPreparation = true; await expect(invoke(set)).rejects.toThrow('候选模型加载失败'); rejectPreparation = false
  revokeAfter=reads+1; await expect(invoke(set)).rejects.toThrow(); revokeAfter=Infinity
  expect(JSON.parse(readFileSync(path, 'utf8')).bindings).toEqual(bindings)
  expect(await invoke(set)).toEqual(next)
  expect(await invoke(list)).toEqual({current:next,options})
  expect(JSON.parse(readFileSync(path, 'utf8')).bindings).toEqual([{...bindings[0], modelSelection:next},bindings[1]])
})

test('附件 IPC 拒绝非顶层、账号不匹配和 Renderer 直接调用内部授权', async () => {
  const contents = { mainFrame: {} }
  const send = mock(async () => ({}))
  mock.module('../index', () => ({getMainWindow: () => ({isDestroyed: () => false, webContents: contents})}))
  mock.module('../lib/http-api-server', () => ({getHttpApiInternalToken: () => 'internal-fixture'}))
  mock.module('../lib/working-api-service', () => ({getWorkingApiClient: () => ({getCachedUser: () => ({id:7}), getIdentityRevision: () => 1, sharedRoomCommand: send})}))
  const {registerDshGroupChatIpcHandlers} = await import('../ipc/dsh-group-chat.ipc')
  registerDshGroupChatIpcHandlers()
  const invoke = (event: object, user: string, command: object) => h.invoke(DSH_GROUP_CHAT_IPC_CHANNELS.SHARED_ROOM_COMMAND, event, user, command)
  const top = {sender:contents,senderFrame:contents.mainFrame}
  await expect(invoke({sender:contents,senderFrame:{}},'7',{action:'downloadAttachment',roomId:'r',attachmentId:'a'})).rejects.toThrow()
  await expect(invoke(top,'8',{action:'downloadAttachment',roomId:'r',attachmentId:'a'})).rejects.toThrow()
  await expect(invoke(top,'7',{action:'downloadAttachment',roomId:'r',attachmentId:'a',objectKey:'forged'})).rejects.toThrow()
  for (const action of ['internalAttachmentUpload','internalAttachmentDownload','internalAttachmentFinalize']) await expect(invoke(top,'7',{action,roomId:'r'})).rejects.toThrow()
  expect(send).not.toHaveBeenCalled()
})

test('共享群已读仅在主窗口前台提交，后台返回 null 且不影响未读查询', async () => {
  const contents = {mainFrame:{}}
  let focused = true, visible = true, minimized = false
  const main = {isDestroyed: () => false, webContents: contents, isFocused: () => focused, isVisible: () => visible, isMinimized: () => minimized}
  const send = mock(async (_user: string, command: unknown) => command)
  mock.module('../index', () => ({getMainWindow: () => main}))
  mock.module('../lib/http-api-server', () => ({getHttpApiInternalToken: () => 'internal-fixture'}))
  mock.module('../lib/working-api-service', () => ({getWorkingApiClient: () => ({sharedRoomCommand: send})}))
  const {registerDshGroupChatIpcHandlers} = await import('../ipc/dsh-group-chat.ipc')
  registerDshGroupChatIpcHandlers()
  const event = {sender:contents, senderFrame:contents.mainFrame}
  const call = (command: unknown) => h.invoke(DSH_GROUP_CHAT_IPC_CHANNELS.SHARED_ROOM_COMMAND, event, '7', command)
  const read = {action:'readRoom', roomId:'room-1', seq:4}
  for (const state of [[false,true,false],[true,false,false],[true,true,true]]) {
    ;[focused,visible,minimized] = state as [boolean,boolean,boolean]
    expect(await call(read)).toBeNull()
  }
  expect(send).not.toHaveBeenCalled()
  await expect(h.invoke(DSH_GROUP_CHAT_IPC_CHANNELS.SHARED_ROOM_COMMAND, {sender: contents, senderFrame: {}}, '7', read)).rejects.toThrow('主窗口顶层')
  expect(await call({action:'unreadEvents',roomId:'room-1',afterSeq:0})).toEqual({action:'unreadEvents',roomId:'room-1',afterSeq:0})
  ;[focused,visible,minimized] = [true,true,false]
  expect(await call(read)).toEqual(read)
  expect(send).toHaveBeenCalledWith('7', read, 'internal-fixture')
  for (const bad of [{...read,seq:-1},{...read,seq:1.5},{...read,seq:Number.MAX_SAFE_INTEGER+1},{...read,roomId:'../r'},{...read,extra:true}]) {
    await expect(call(bad)).rejects.toThrow('参数无效')
  }
})
