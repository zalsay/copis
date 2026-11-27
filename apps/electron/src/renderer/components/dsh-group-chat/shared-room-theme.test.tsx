import { expect, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { Provider, createStore } from 'jotai'
import postcss from 'postcss'
import { parseHTML } from 'linkedom'
import { workingAuthStateAtom } from '@/atoms/working-atoms'
import type { DshSharedRoomCommand } from '@copis/shared'
import { DshGroupChatView } from './DshGroupChatView'

// 走真实目录和消息流；名称也叫「思考中」，避免按文案误选名称或整行。
for (const [availability, label] of [['busy', '思考中'], ['online', '空闲'], ['offline', '离线']] as const) {
  test(`共享群顶栏：${label}，名称和排队数保持静态`, async () => {
    const { window: w } = parseHTML('<html><body><div id="root"></div></body></html>')
    const old = {
      window: globalThis.window,
      document: globalThis.document,
      IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT'),
    }
    const room = { roomId: 'r', roomKind: 'dsh_shared', name: '共享群', hostUserId: 1, status: 'active' }
    const agent = { roomId: 'r', roomAgentId: 'a', ownerUserId: 1, displayName: '思考中', queuedCount: 2, availability }
    const message = { roomId: 'r', messageId: 'm', seq: 1, senderType: 'user', senderUserId: 1, content: '消息', createdAt: '2026-11-26T00:00:00Z' }
    const sharedRoomCommand = async (_: string, cmd: DshSharedRoomCommand) => {
      switch (cmd.action) {
        case 'list': return [room]
        case 'detail': return { room, agents: [agent] }
        case 'messages': return [message]
        case 'events': return []
        default: throw new Error(`意外请求：${cmd.action}`)
      }
    }
    Object.assign(globalThis, { window: w, document: w.document, IS_REACT_ACT_ENVIRONMENT: true })
    w.HTMLElement.prototype.scrollIntoView = () => {}
    Object.assign(w, { electronAPI: { dshGroupChat: { sharedRoomCommand } } })
    const store = createStore()
    store.set(workingAuthStateAtom, { authenticated: true, backendUrl: 'fixture', user: { id: '1' } })
    const host = w.document.getElementById('root')!
    const root = createRoot(host)
    try {
      await act(async () => root.render(<Provider store={store}><DshGroupChatView /></Provider>))
      const status = host.querySelector('header [role="status"]')!
      expect(Array.from(status.children, e => e.textContent)).toEqual(['思考中', label, '排队 2'])
      const animated = host.querySelectorAll('.dsh-room-thinking')
      expect(animated.length).toBe(availability === 'busy' ? 1 : 0)
      if (availability === 'busy') expect(animated[0]).toBe(status.children[1])
      expect(host.querySelector('.dsh-room-pane .dsh-room-bubble')?.textContent).toBe('消息')
      expect(host.querySelector('.dsh-room-composer [role="textbox"]')).not.toBeNull()
      await act(async () => Simulate.click(host.querySelector('[aria-label="群聊管理"]')!))
      expect(host.querySelector('[role="menu"]')?.className).toContain('bg-[var(--copis-search-panel-bg)]')
    } finally {
      await act(async () => root.unmount())
      Object.assign(globalThis, old)
    }
  })
}

test('局部色板匹配 CLAUDE_DARK_THEME；文字窄高光向右扫过后停顿，仅正常动效模式启用', async () => {
  const css = await Bun.file(new URL('./shared-room-theme.css', import.meta.url)).text()
  const sheet = postcss.parse(css)
  const palette = { canvas: '#141414', surface: '#212121', text: '#f4f4f4', accent: '#d97757' }
  for (const [token, color] of Object.entries(palette)) {
    expect(css).toContain(`--room-${token}: ${color};`)
  }
  sheet.walkRules(rule => {
    if (rule.parent?.type === 'atrule' && rule.parent.name === 'keyframes') return
    for (const selector of rule.selectors) expect(selector).toMatch(/^\.dsh-room-pane(?: |$)/)
  })
  const animations: string[] = []
  sheet.walkDecls(decl => {
    if (decl.prop !== 'animation' && !(decl.prop === 'color' && decl.value === 'transparent')) return
    const rule = decl.parent
    expect(rule?.type === 'rule' && rule.selector).toBe('.dsh-room-pane .dsh-room-thinking')
    const media = rule?.parent
    expect(media?.type === 'atrule' && media.params).toContain('(prefers-reduced-motion: no-preference)')
    if (decl.prop === 'animation') animations.push(decl.value)
  })
  expect(animations).toHaveLength(1)
  expect(animations[0]).toContain('dsh-room-thinking-sweep')
  expect(css).toContain('background-clip: text')
  expect(css).toMatch(/46%.*50%.*54%/)
  // 渐变比文字宽时，背景位置由 100% 到 0% 才是从左向右。
  expect(css).toContain('background-size: 240% 100%')
  expect(css).toMatch(/0%\s*\{\s*background-position: 100% 50%/)
  expect(css).toMatch(/60%,\s*100%\s*\{\s*background-position: 0% 50%/)
})
