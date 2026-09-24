import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { parseHTML } from 'linkedom'
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import type { ChatRoomSummary } from '@copis/shared'
import { ChatroomSidebarRow } from './ChatroomSidebarRow'

const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
let root: Root | null = null

beforeEach(() => {
  const parsed = parseHTML('<html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, { window: parsed.window, document: parsed.window.document, navigator: parsed.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })
})
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = null })

const room: ChatRoomSummary = { roomId: 'room-1', name: '协作室', role: 'member', hostUserId: '7', status: 'active', memberCount: 2, unreadCount: 0, connectionStatus: 'connected' }

describe('聊天室侧栏列表项', () => {
  test('房间摘要离线但实时连接已建立时，侧栏显示已连接', async () => {
    root = createRoot(document.getElementById('root')!)
    await act(async () => root?.render(<ChatroomSidebarRow room={{ ...room, connectionStatus: 'offline' }} connectionStatus="connected" action="delete" busy={false} onOpen={() => undefined} onRequestClose={() => undefined} />))
    expect(document.querySelector('.copis-working-chatroom-copy small')?.textContent).toBe('已连接')
  })
  test('右侧关闭按钮独立于打开按钮，点击删除不打开房间', async () => {
    const calls: string[] = []
    root = createRoot(document.getElementById('root')!)
    await act(async () => root?.render(<ChatroomSidebarRow room={room} action="delete" busy={false} onOpen={() => calls.push('open')} onRequestClose={() => calls.push('close')} />))
    const buttons = [...document.querySelectorAll('button')]
    expect(buttons).toHaveLength(2)
    expect(buttons[0]?.parentElement).toBe(buttons[1]?.parentElement)
    expect(buttons[1]?.getAttribute('aria-label')).toContain('删除聊天室')
    await act(async () => Simulate.click(buttons[1]!))
    expect(calls).toEqual(['close'])
    await act(async () => Simulate.click(buttons[0]!))
    expect(calls).toEqual(['close', 'open'])
  })

  test('成员和旧空房间显示各自的关闭含义', async () => {
    root = createRoot(document.getElementById('root')!)
    await act(async () => root?.render(<ChatroomSidebarRow room={room} action="leave" busy={false} onOpen={() => undefined} onRequestClose={() => undefined} />))
    expect(document.querySelectorAll('button')[1]?.getAttribute('aria-label')).toContain('退出聊天室')
    await act(async () => root?.render(<ChatroomSidebarRow room={{ ...room, roomId: '' }} action="local" busy={false} onOpen={() => undefined} onRequestClose={() => undefined} />))
    expect(document.querySelectorAll('button')[1]?.getAttribute('aria-label')).toContain('移除无效聊天室')
  })

  test('支持激活态并融入容器整体背景，关闭按钮与打开按钮在同一 entry 容器中', async () => {
    root = createRoot(document.getElementById('root')!)
    await act(async () => root?.render(<ChatroomSidebarRow room={room} action="delete" busy={false} active={true} onOpen={() => undefined} onRequestClose={() => undefined} />))
    const entry = document.querySelector<HTMLElement>('.copis-working-chatroom-entry')
    expect(entry).not.toBeNull()
    expect(entry?.classList.contains('active')).toBe(true)
    const closeBtn = document.querySelector<HTMLElement>('.copis-working-chatroom-close')
    expect(closeBtn).not.toBeNull()
    expect(closeBtn?.parentElement).toBe(entry)
  })
})
