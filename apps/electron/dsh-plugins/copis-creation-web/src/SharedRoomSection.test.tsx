import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { parseHTML } from 'linkedom'
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SharedRoomSection } from './SharedRoomSection'

const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
const globals = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator }
let root: Root
let host: HTMLElement
const open = mock((_tab?: string) => {})
const directory = mock((_tab: 'refresh' | 'sidebar-sync' | `manage:${string}`) => {})

beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { location: { origin: 'https://example.test' } })
  Object.assign(window.HTMLElement.prototype, { showPopover() {} })
  host = window.document.getElementById('root') as unknown as HTMLElement
  root = createRoot(host)
  open.mockClear(); directory.mockClear()
})
afterEach(async () => {
  await act(async () => root.unmount())
  Object.assign(globalThis, globals)
})
const render = (wide: boolean) => act(async () => root.render(<SharedRoomSection wide={wide} active={false} open={open} directory={directory} />))
const send = (rooms: unknown[]) => act(async () => window.dispatchEvent(Object.assign(new window.Event('message'), { data: {
  type: 'COPIS_SHARED_ROOM_SIDEBAR', epoch: 3, rooms, selected: null, status: 'ready', busy: false,
} })))
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
const description = (element: HTMLElement) => document.getElementById(element.getAttribute('aria-describedby') || '')?.textContent

test('Given 群目录快照 When 只有严格 true 未读 Then 群名对齐、红点和无障碍描述准确且原操作不变', async () => {
  await render(true)
  await send([
    { id: 'a', name: '产品讨论', unread: true, actions: ['copy'] },
    { id: 'b', name: '技术讨论', unread: false, actions: [] },
    { id: 'c', name: '设计讨论', unread: 'true', actions: [] },
    { id: 'd', name: '公共讨论', actions: [] },
  ])
  const first = button('产品讨论'); const second = button('技术讨论')
  expect(first.querySelector('.copis-room-unread-slot')).not.toBeNull()
  expect(second.querySelector('.copis-room-unread-slot')).not.toBeNull()
  expect(first.querySelector('.copis-room-unread-dot')).not.toBeNull()
  for (const label of ['技术讨论', '设计讨论', '公共讨论']) {
    expect(button(label).querySelector('.copis-room-unread-dot')).toBeNull()
    expect(button(label).hasAttribute('aria-describedby')).toBe(false)
  }
  expect(description(first)).toBe('有未读消息')
  expect(first.querySelector('svg')).toBeNull()
  expect(button('群聊操作')).toBeTruthy()
  expect(button('管理「产品讨论」')).toBeTruthy()
  await act(async () => first.click())
  expect(open).toHaveBeenLastCalledWith('room:a')
  await act(async () => button('管理「产品讨论」').click())
  await act(async () => button('复制分享码').click())
  expect(directory).toHaveBeenLastCalledWith('manage:3:copy:a')
  await act(async () => button('群聊操作').click())
  await act(async () => button('创建群聊').click())
  expect(open).toHaveBeenLastCalledWith('create')
  await send([{ id: 'a', name: '产品讨论', unread: false, actions: [] }])
  expect(button('产品讨论').querySelector('.copis-room-unread-dot')).toBeNull()
  expect(button('产品讨论').hasAttribute('aria-describedby')).toBe(false)
})

test('Given 群中有未读 When 目录折叠或窄栏 Then 入口聚合红点且已读后清除', async () => {
  await render(true)
  await send([{ id: 'a', name: '产品讨论', unread: true, actions: [] }])
  const toggle = button('群聊协作')
  expect(toggle.querySelector('.copis-room-unread-dot')).toBeNull()
  await act(async () => toggle.click())
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(toggle.querySelector('.copis-room-unread-dot')).not.toBeNull()
  expect(description(toggle)).toBe('有未读消息')
  expect(open).not.toHaveBeenCalled()
  await render(false)
  const rail = button('群聊协作')
  expect(rail.querySelector('.copis-room-unread-dot')).not.toBeNull()
  expect(description(rail)).toBe('有未读消息')
  await act(async () => rail.click())
  expect(open).toHaveBeenLastCalledWith()
  await send([{ id: 'a', name: '产品讨论', unread: 1, actions: [] }])
  expect(rail.querySelector('.copis-room-unread-dot')).toBeNull()
  expect(rail.hasAttribute('aria-describedby')).toBe(false)
})
