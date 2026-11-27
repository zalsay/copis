import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import {
  BUILTIN_CHANNEL_DEFINITIONS, COPIS_WORKING_DEEPSEEK_CHANNEL_ID as deepseek,
  getCopisWorkingModelDisplayName, type WorkingCustomModel,
} from '@copis/shared'

const defaultModel = { channelId: deepseek, modelId: 'deepseek-v4-flash' }
const custom = { channelId: 'copis-custom-a', modelId: 'private-model' }
const binding = { roomId: 'r', roomAgentId: 'a', workspaceId: 'w', displayName: '助手', userId: 'owner' }
let settings: { agentChannelId?: string; agentModelId?: string }
let models: WorkingCustomModel[]
let authOwner: string
const privateDetail = 'https://fixture.invalid/?key=private-value'
const baseModel: WorkingCustomModel = { id: 'a', name: '我的模型', modelId: custom.modelId, protocol: 'anthropic-messages', thinkingLevel: 'low', baseUrl: 'https://fixture.invalid', apiKeyConfigured: true }
const readCredential = mock(() => ({ model: baseModel, apiKey: 'private-value' }))
const session = mock(async (_options: unknown) => ({ submit: async () => '完成', revoke: async () => {} }))
const home = mkdtempSync(join(tmpdir(), 'room-native-'))
afterAll(() => rmSync(home, {recursive:true, force:true}))
const moduleEntry = mock(() => '/fixture/bin/dsh')
mock.module('../config-paths', () => ({ getConfigDir: () => '/fixture', getDshHomeDir: () => home, getDesktopModuleEntry: moduleEntry }))
mock.module('../http-api-server', () => ({ getHttpApiInternalToken: () => undefined }))
mock.module('../working-auth-store', () => ({ getWorkingTokenStore: () => ({ getUser: () => ({ id: authOwner }) }), subscribeWorkingIdentity: () => () => {} }))
mock.module('../dsh-model-config', () => ({ resolveDshWorkingReasoningEffort: () => 'low' }))
mock.module('../settings-service', () => ({ getSettings: () => settings }))
mock.module('../working-api-service', () => ({ getWorkingApiClient: () => ({ getIdentityRevision: () => 1, getCachedUser: () => ({ id: 'owner' }) }) }))
const readCatalog = mock((_vip: boolean, owner: string) => ({ categories: [], models: owner === 'owner' ? models : [] }))
mock.module('../working-model-catalog', () => ({ getWorkingModelCatalog: readCatalog, getWorkingCustomModelRuntime: readCredential }))
mock.module('./shared-room-session.mjs', () => ({ createSharedRoomSession: session }))
const { getRoomModelCatalog: catalog, openRoomModelRuntime: open } = await import('./shared-room-model-runtime')

beforeEach(() => {
  settings = {}; models = [baseModel]; authOwner = 'owner'
  readCatalog.mockClear(); readCredential.mockClear(); session.mockClear()
})

test('枚举群主可选项只使用公开候选，排除无凭据和不受支持的路由，不解密或开会话', () => {
  models.push({ ...baseModel, id: 'no-key', apiKeyConfigured: false }, { ...baseModel, id: 'bad-url', baseUrl: privateDetail })
  const builtinOptions = Object.entries(BUILTIN_CHANNEL_DEFINITIONS.groups).flatMap(([channelId, group]) =>
    group.models.map(({ id: modelId, name }) => ({ channelId, modelId, name: getCopisWorkingModelDisplayName(channelId, modelId, name) })))
  expect(catalog('owner')).toEqual({ current: defaultModel, options: [...builtinOptions, { ...custom, name: baseModel.name }] })
  expect(readCatalog).toHaveBeenCalledWith(true, 'owner'); expect(readCredential).not.toHaveBeenCalled(); expect(session).not.toHaveBeenCalled()
})

test('无具体模型时沿用渠道首选；有效的在途模型优先，不受全局设置影响', () => {
  settings = { agentChannelId: custom.channelId }
  expect(catalog('owner').current).toEqual(custom)
  settings.agentModelId = ''
  expect(catalog('owner').current).toEqual(custom)
  settings = { agentChannelId: 'removed' }
  expect(catalog('owner', defaultModel).current).toEqual(defaultModel)
})

test('失效的默认或在途模型不回退冒充成功，仍能改选；不完整覆盖不能被补全', async () => {
  for (const effective of [custom, { channelId: deepseek, modelId: '' }]) {
    models = []
    expect(catalog('owner', effective).current).toBeNull()
    expect(catalog('owner', effective).options).toContainEqual(expect.objectContaining(defaultModel))
    await expect(open({ ...binding, modelSelection: effective })).rejects.toThrow(/选择|配置/)
  }
  settings = { agentChannelId: custom.channelId }
  expect(catalog('owner').current).toBeNull()
  expect(session).not.toHaveBeenCalled()
})

test('账号不一致时拒绝读取目录', () => {
  authOwner = 'changed'
  expect(() => catalog('owner')).toThrow(/账号/); expect(readCatalog).not.toHaveBeenCalled()
})

test('明确选择只打开指定模型，返回具体二元组；凭据、适配器错误不暴露底层细节', async () => {
  settings = { agentChannelId: 'obsolete' }
  const selected = { ...binding, modelSelection: custom }
  const runtime = await open(selected)
  expect(runtime.modelSelection).toEqual(custom)
  expect(session.mock.calls[0]?.[0]).toMatchObject({ provider: custom.channelId, model: custom.modelId })
  await runtime.revoke()
  for (const [fail, reason] of [[() => readCredential.mockImplementationOnce(() => { throw Error(privateDetail) }), /凭据/], [() => session.mockRejectedValueOnce(Error(privateDetail)), /适配器/]] as const) {
    fail()
    const error = await open(selected).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toMatch(reason); expect((error as Error).message).not.toContain('fixture')
  }
})


test('本地模块读取异常不暴露底层路径或地址', async () => {
  moduleEntry.mockImplementationOnce(() => { throw Error(privateDetail) })
  await expect(open(binding)).rejects.toThrow(/运行时/)
})

test('适配器异步加载期间凭据被撤回，释放新会话而不是报告切换成功', async () => {
  const revoke = mock(async () => {})
  session.mockImplementationOnce(async () => {
    readCredential.mockImplementationOnce(() => { throw Error(privateDetail) })
    return { submit: async () => '完成', revoke }
  })
  await expect(open({ ...binding, modelSelection: custom })).rejects.toThrow(/凭据/)
  expect(revoke).toHaveBeenCalledTimes(1)
})


test('群主直接选 DSH 设置里的模型：仅列公开名称，复用原生密钥，删除后不回落', async () => {
  const profile = join(home, 'profiles/copis'); mkdirSync(profile, {recursive:true})
  const file = join(profile, 'cordis.patch.yml'), creds = join(home, '.credentials.yaml')
  const provider = { displayName:'家庭服务', api:'openai-responses', baseURL:'https://fixture.invalid/v1', apiKeyEnv:'FAMILY_API_KEY', models:[{id:'ours',name:'家用',input:['text']}] }
  writeFileSync(file, JSON.stringify([{id:'llm-pi-ai',config:{providers:{family:provider,
    spoof:{...provider,apiKeyEnv:'COPIS_API_KEY'}, 'copis-working-test':provider,
    unsupported:{...provider,api:'other'}, bad:{...provider,baseURL:'https://fixture.invalid/?key=private'},
  }}}]))
  const choice = { channelId:'dsh-native-family',modelId:'ours' }
  const options = catalog('owner').options.filter(o => o.channelId.startsWith('dsh-native-'))
  expect(options).toEqual([{...choice,name:'DSH · 家庭服务 · 家用'}])
  expect(catalog('owner').current).toEqual(defaultModel)
  const selected = {...binding,modelSelection:choice}
  await expect(open(selected)).rejects.toThrow(/凭据/)
  const saveKey = (key:string) => writeFileSync(creds,JSON.stringify({version:1,refs:{FAMILY_API_KEY:key}}),{mode:0o600})
  saveKey('fixture-native'); const runtime = await open(selected)
  const {transport} = session.mock.calls.at(-1)![0] as {transport:{baseURL:string;readKey:()=>string}}
  expect(transport.baseURL).toBe(provider.baseURL); expect(transport.readKey()).toBe('fixture-native')
  saveKey('rotated'); expect(transport.readKey()).toBe('rotated'); expect(readCredential).not.toHaveBeenCalled()
  writeFileSync(file,'[]'); expect(catalog('owner',choice).current).toBeNull(); expect(transport.readKey).toThrow(/变更|失效/)
  await runtime.revoke()
})

test('原生设置在已有 Copis 自定义渠道追加模型：不重复托管条目，账号或地址不符不借用凭据', async () => {
  const {createHash} = await import('node:crypto')
  const profile = join(home, 'profiles/copis'); mkdirSync(profile,{recursive:true})
  const ref = 'COPIS_DSH_CUSTOM_'+createHash('sha256').update('owner:a').digest('hex').toUpperCase()
  const save = (baseURL:string) => writeFileSync(join(profile,'cordis.patch.yml'),JSON.stringify([{id:'llm-pi-ai',config:{providers:{[custom.channelId]:{
    displayName:'已有服务', apiKeyEnv:ref, baseURL, api:baseModel.protocol, models:[{id:custom.modelId},{id:'extra',name:'附加'}]
  }}}}]))
  save(baseModel.baseUrl)
  const choice = {channelId:'dsh-native-'+custom.channelId,modelId:'extra'}
  const opts = () => catalog('owner').options.filter(o => o.channelId.startsWith('dsh-native-'))
  expect(opts()).toEqual([{...choice,name:'DSH · 已有服务 · 附加'}])
  await open({...binding,modelSelection:choice})
  const {transport} = session.mock.calls.at(-1)![0] as {transport:{readKey:()=>string}}
  expect(transport.readKey()).toBe('private-value'); expect(readCredential).toHaveBeenCalledWith(custom.channelId,true,'owner')
  save('https://elsewhere.invalid'); expect(opts()).toEqual([]); expect(transport.readKey).toThrow()
  save(baseModel.baseUrl); models=[]; expect(opts()).toEqual([]); expect(transport.readKey).toThrow()
})
