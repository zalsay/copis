import { afterEach, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { DshSharedRoomCommand } from '@copis/shared'
import { workingAuthStateAtom } from '@/atoms/working-atoms'
import { roomDirectoryAction, roomDirectoryAtom } from './shared-room-directory'

const previousWindow = globalThis.window
afterEach(() => { Object.assign(globalThis, { window: previousWindow }) })
const room = { roomId: 'created', name: '协作群', hostUserId: 11, status: 'active' }
const agents = ['策划', '美术', '开发'].map((name, i) => ({ id: `w${i}`, name }))
const submit = { kind: 'submit', name: '协作群', code: 'ABCD', agents: agents.slice(0, 1) } as const
function setup(command: (c: DshSharedRoomCommand) => Promise<unknown>) {
  const store = createStore()
  const login = (id: string) => store.set(workingAuthStateAtom, {
    authenticated: true, backendUrl: 'fixture', user: { id },
  })
  Object.assign(globalThis, { window: { electronAPI: { dshGroupChat: {
    sharedRoomCommand: (id: string, c: DshSharedRoomCommand) => {
      expect(id).toBe('11')
      return command(c)
    },
  } } } })
  login('11')
  void store.set(roomDirectoryAction, { kind: 'create' })
  return { store, login }
}

test('创建只接受恰好一个工作区，空选或超限不会创建房间', async () => {
  const calls: DshSharedRoomCommand[] = []
  const { store } = setup(async c => { calls.push(c); return room })
  for (const selection of [[], agents.slice(0, 2), agents, [{ id: ' ', name: '无效' }]]) {
    await store.set(roomDirectoryAction, { ...submit, agents: selection })
  }
  expect(calls).toEqual([])
})

test('登记失败保留群与表单；重复提交不重建群，重试使用原选择与操作 ID', async () => {
  const calls: DshSharedRoomCommand[] = []
  let retry = false
  const { store } = setup(async c => {
    calls.push(c)
    if (c.action === 'create') return room
    if (c.action !== 'registerAgent') throw Error('意外请求')
    if (!retry && c.workspaceId === 'w0') throw Error('超时')
    return { roomAgentId: `member-${c.workspaceId}` }
  })
  const first = store.set(roomDirectoryAction, submit)
  await store.set(roomDirectoryAction, submit)
  await first
  expect(store.get(roomDirectoryAtom)).toMatchObject({ form: 'create', busy: false, rooms: [{ id: room.roomId }] })
  expect(store.get(roomDirectoryAtom).error).toContain('超时')
  retry = true
  await store.set(roomDirectoryAction, { ...submit, agents: agents.slice(1) })
  expect(store.get(roomDirectoryAtom)).toMatchObject({ form: null, selected: room.roomId, busy: false, error: '' })
  expect(calls.filter(c => c.action === 'create')).toHaveLength(1)
  const registered = calls.filter(c => c.action === 'registerAgent')
  expect(registered.map(c => c.workspaceId)).toEqual(['w0', 'w0'])
  expect(registered.every(c => c.roomId === room.roomId && !!c.operationId)).toBe(true)
  expect(registered[1]).toEqual(registered[0])
})

for (const step of ['create', 'registerAgent'] as const) {
  test(`在 ${step} 等待回执时 A→B→A，不继续后续步骤、不写回新目录`, async () => {
    const started = Promise.withResolvers<void>(), response = Promise.withResolvers<unknown>()
    const calls: string[] = []
    const { store, login } = setup(async c => {
      calls.push(c.action)
      if (c.action === step) { started.resolve(); return response.promise }
      return room
    })
    const pending = store.set(roomDirectoryAction, submit)
    await Promise.race([started.promise, pending])
    login('22'); login('11')
    response.resolve(step === 'create' ? room : { roomAgentId: 'member' })
    await pending
    expect(calls).toEqual(step === 'create' ? ['create'] : ['create', 'registerAgent'])
    expect(store.get(roomDirectoryAtom)).toMatchObject({ rooms: [], form: null, selected: null, busy: false })
  })
}
