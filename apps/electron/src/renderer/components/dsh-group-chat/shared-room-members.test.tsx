import { expect, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import { parseHTML } from 'linkedom'
import { workingAuthStateAtom } from '@/atoms/working-atoms'
import type { DshSharedRoomCommand } from '@copis/shared'
import { DshGroupChatView } from './DshGroupChatView'

for (const account of ['11', '22']) test(`成员列表：${account === '11' ? '群主确认后移除，失败可重试' : '普通成员只读'}，智能体置顶且不计人数`, async () => {
  const { window: w } = parseHTML('<html><body><div id="root"></div></body></html>')
  const old = {window:globalThis.window, document:globalThis.document, IS_REACT_ACT_ENVIRONMENT:Reflect.get(globalThis,'IS_REACT_ACT_ENVIRONMENT')}
  Object.assign(globalThis, {window:w, document:w.document, IS_REACT_ACT_ENVIRONMENT:true})
  w.HTMLElement.prototype.scrollIntoView = () => {}
  const room = {roomId:'r', name:'共享群', hostUserId:11, status:'active'}
  const agents = [{roomId:'r',roomAgentId:'a',ownerUserId:11,displayName:'小研',availability:'offline'}]
  let attempts = 0
  let memberIds = [11,22]
  Object.assign(w, {electronAPI:{dshGroupChat:{sharedRoomCommand: async (_:string, c:DshSharedRoomCommand) => {
    if (c.action === 'list') return [room]
    if (c.action === 'detail') return {room, agents, memberIds}
    if (c.action === 'messages' || c.action === 'events') return []
    if (c.action === 'removeMember') {
      expect(c).toEqual({action:'removeMember',roomId:'r',memberId:22})
      if (++attempts === 1) throw new Error('暂时无法移除')
      memberIds = [11]; return {roomId:'r',memberId:22}
    }
    throw new Error(c.action)
  }}}})
  const store = createStore()
  store.set(workingAuthStateAtom,{authenticated:true,backendUrl:'fixture',user:{id:account}})
  const el = w.document.getElementById('root')!, root = createRoot(el)
  const panel = () => el.querySelector('[aria-label="群成员列表"]')
  const button = (label:string) => Array.from(el.querySelectorAll('button')).find(b => b.textContent?.trim() === label)!
  const click = (label:string) => act(async () => button(label).click())
  try {
    await act(async () => root.render(<Provider store={store}><DshGroupChatView /></Provider>))
    expect(panel()).toBeNull()
    await click('成员 · 2')
    expect(panel()!.textContent).toMatch(/小研.*用户 11.*群主.*用户 22/)
    const remove = panel()!.querySelectorAll('button[aria-label^="移除用户"]')
    expect(remove.length).toBe(account === '11' ? 1 : 0)
    if (account === '11') {
      const start = () => act(async () => el.querySelector<HTMLElement>('[aria-label="移除用户 22"]')!.click())
      await start(); await click('取消'); expect(attempts).toBe(0)
      await start(); await click('确认移除'); expect(panel()!.textContent).toContain('暂时无法移除'); expect(button('成员 · 2')).toBeTruthy()
      await click('确认移除'); expect(panel()!.textContent).not.toContain('用户 22'); expect(attempts).toBe(2)
    }
    await click(account === '11' ? '成员 · 1' : '成员 · 2'); expect(panel()).toBeNull()
  } finally { await act(async () => root.unmount()); Object.assign(globalThis,old) }
})
