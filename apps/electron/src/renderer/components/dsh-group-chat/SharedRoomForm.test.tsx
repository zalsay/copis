import { expect, test } from 'bun:test'
import { Provider, createStore, useAtomValue } from 'jotai'
import { parseHTML } from 'linkedom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { workingAuthStateAtom } from '@/atoms/working-atoms'
import type { DshSharedRoomCommand } from '@copis/shared'
import { roomDirectoryAction, roomDirectoryAtom } from './shared-room-directory'
import { readRoomAgentOptions } from './RoomAgentPicker'
import { SharedRoomForm } from './SharedRoomForm'

function Harness() {
  const { form } = useAtomValue(roomDirectoryAtom)
  return form && <SharedRoomForm form={form} userId="11" />
}

test('加入不读取候选；创建可重载候选，登记超时保留原表单并只重试失败项', async () => {
  const { window: w } = parseHTML('<html><body><div id="root"></div></body></html>')
  const previous = { window: globalThis.window, document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT') }
  Object.assign(globalThis, { window: w, document: w.document, IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(w.HTMLElement.prototype, {
    showModal(this: HTMLElement) { this.setAttribute('open', '') }, close(this: HTMLElement) { this.removeAttribute('open') },
  })
  const calls: DshSharedRoomCommand[] = []
  const options = ['美术', '编剧', '音效', '场记'].map((name, i) => ({ id: `w${i}`, name }))
  let loads = 0, registrations = 0
  Object.assign(w, { electronAPI: { dshGroupChat: { sharedRoomCommand: async (user: string, c: DshSharedRoomCommand) => {
    expect(user).toBe('11')
    calls.push(c)
    if (c.action === 'agentOptions') {
      if (++loads === 1) throw new Error('候选加载失败')
      return options
    }
    if (c.action === 'create') return { roomId: 'r', name: c.name, hostUserId: 11, status: 'active' }
    if (c.action === 'registerAgent') {
      if (++registrations === 1) throw new Error('登记超时')
      return { roomAgentId: 'registered-' + c.workspaceId }
    }
    throw Error('意外请求')
  } } } })
  const el = w.document.getElementById('root')!, root = createRoot(el as unknown as HTMLElement)
  const store = createStore()
  const input = (name: string) => el.querySelector(`input[aria-label="${name}"]`) as unknown as HTMLInputElement
  const button = (text: string) => Array.from(el.querySelectorAll('button')).find(b => b.textContent === text)!
  const submit = () => act(async () => Simulate.submit(el.querySelector('form') as unknown as HTMLFormElement))
  try {
    store.set(workingAuthStateAtom, { authenticated: true, backendUrl: 'fixture', user: { id: '11' } })
    await store.set(roomDirectoryAction, { kind: 'join' })
    await act(async () => root.render(<Provider store={store}><Harness /></Provider>))
    expect(el.querySelector('dialog[open]')?.textContent).toContain('加入群聊')
    expect(calls).toEqual([])
    await act(async () => { await store.set(roomDirectoryAction, { kind: 'create' }) })
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('候选加载失败')
    await act(async () => button('重新加载').click())
    expect(input('美术').closest('fieldset')?.textContent).toContain('成员 @ 后由群主设备依次回答，使用群主的模型额度，不共享本机文件。')
    const code = input('四位分享码').value
    expect(code).toMatch(/^[A-Z0-9]{4}$/)
    await act(async () => { const node = input('共享群名称'); node.value = '创作'; Simulate.change(node) })
    expect(button('创建').disabled).toBe(true)
    await submit()
    expect(calls.some(c => c.action === 'create')).toBe(false)
    for (const name of ['美术', '编剧']) await act(async () => Simulate.change(input(name)))
    expect(input('美术').checked).toBe(false)
    expect(input('编剧').checked).toBe(true)
    await act(async () => Simulate.change(input('编剧')))
    expect(button('创建').disabled).toBe(true)
    await act(async () => Simulate.change(input('编剧')))
    await submit()
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('编剧：登记超时')
    expect(input('四位分享码').value).toBe(code)
    expect(input('共享群名称').value).toBe('创作')
    expect(input('共享群名称').disabled).toBe(true)
    expect(input('编剧').checked).toBe(true)
    await submit()
    expect(el.querySelector('dialog')).toBeNull()
    expect(calls.map(c => c.action)).toEqual(['agentOptions', 'agentOptions', 'create', 'registerAgent', 'registerAgent'])
    expect(calls.at(-1)).toEqual(calls[3])
    expect(calls[3]).toMatchObject({ workspaceId: 'w1' })
  } finally {
    await act(async () => root.unmount())
    Object.assign(globalThis, previous)
  }
})

test('候选仅保留约定字段；非法房间智能体 ID 和重复工作区不能用于选择', () => {
  const plain = { id: 'one', name: '助教' }, bound = { id: 'two', name: '审阅', roomAgentId: 'member' }
  expect(readRoomAgentOptions([{ ...plain, extra: true }, { ...bound, localPath: '/private' }])).toEqual([plain, bound])
  for (const roomAgentId of [7, null, ' ']) {
    expect(() => readRoomAgentOptions([{ ...plain, roomAgentId }])).toThrow()
  }
  expect(() => readRoomAgentOptions([plain, plain])).toThrow()
})
