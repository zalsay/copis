import { expect, test } from 'bun:test'
import { parseHTML } from 'linkedom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import type { DshRoomModelCatalog, DshSharedRoomCommand } from '@copis/shared'
import { RoomRosterDialog } from './RoomRosterDialog'

const current = { channelId: 'one', modelId: 'm' }
const alternative = { channelId: 'two', modelId: 'm' }
const modelOptions = { current, options: [{ ...current, name: '模型甲' }, { ...alternative, name: '模型乙' }] }
type WriteAction = 'registerAgent' | 'removeAgent' | 'setRoomModel'

// 只有 A、B、C 属于本机；其余 ID 模拟其他设备共享的成员。
async function withRoster(initial: string[], exercise: (ui: {
  text: () => string; input: (id: string) => HTMLInputElement; select: (id: string) => Promise<void>
  closed: () => boolean; canSave: () => boolean; save: () => Promise<void>; failNext: (action: WriteAction) => void
  writes: DshSharedRoomCommand[]; members: Set<string>; reads: DshSharedRoomCommand[]
  picker: () => HTMLButtonElement | null; labels: () => Promise<(string | null)[]>; choose: (index: number) => Promise<void>; switchRoom: (id: string) => Promise<void>
}) => Promise<void>, readModels: (roomId: string) => Promise<DshRoomModelCatalog> = async () => modelOptions,
  setModel = async (choice: typeof current) => choice) {
  const { window: w } = parseHTML('<html><body><div id="root"></div></body></html>')
  const previous = { window: globalThis.window, document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle, MutationObserver: globalThis.MutationObserver,
    CustomEvent: globalThis.CustomEvent, Node: globalThis.Node, HTMLElement: globalThis.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT') }
  Object.assign(globalThis, { window: w, document: w.document, IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: (node: HTMLElement) => node.style, MutationObserver: w.MutationObserver,
    CustomEvent: w.CustomEvent, Node: w.Node, HTMLElement: w.HTMLElement })
  Object.assign(w.HTMLElement.prototype, { showModal() {}, close() {} })
  const el = w.document.getElementById('root')!, root = createRoot(el as unknown as HTMLElement)
  const members = new Set(initial), writes: DshSharedRoomCommand[] = []
  const reads: DshSharedRoomCommand[] = []
  let fail: WriteAction | undefined, closed = false
  const input = (id: string) => el.querySelector<HTMLInputElement>(`input[aria-label="${id}"]`)!
  const button = () => el.querySelector<HTMLButtonElement>('[aria-label="保存智能体"]')!
  const picker = () => el.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="本群回答模型"]')
  const openList = async () => {
    await act(async () => Simulate.keyDown(picker()!, {key:'ArrowDown'}))
    return Array.from(el.querySelectorAll<HTMLElement>('[role="option"]'))
  }
  const render = async (id: string) => {
    await act(async () => root.render(<RoomRosterDialog key={id} roomId={id} onClose={() => { closed = true }}
      refreshAgents={async () => [...members].map(id => ({ id, name: id, state: '在线', queuedCount: null, callable: false }))}
      request={async c => {
        if (c.action === 'agentOptions') return ['A', 'B', 'C'].map(id => ({ id, name: id, roomAgentId: members.has(id) ? id : undefined }))
        if (c.action === 'roomModelOptions') { reads.push(c); return readModels(c.roomId) }
        writes.push(c)
        if (fail === c.action) { fail = undefined; throw Error('请求超时') }
        if (c.action === 'removeAgent') { members.delete(c.roomAgentId); return { roomAgentId: c.roomAgentId } }
        if (c.action === 'registerAgent') { members.add(c.workspaceId); return { roomAgentId: c.workspaceId } }
        if (c.action === 'setRoomModel') return setModel({ channelId: c.channelId, modelId: c.modelId })
        throw Error('意外请求')
      }} />))
  }
  try {
    await render('r')
    await exercise({ picker, reads, switchRoom: render,
      labels: async () => {
        const items = await openList()
        const labels = items.map(o => o.textContent)
        await act(async () => document.dispatchEvent(Object.assign(new w.Event('keydown', {bubbles:true}), {key:'Escape'})))
        return labels
      }, choose: async index => {
        const items = await openList()
        await act(async () => Simulate.keyDown(items[index]!, {key:'Enter'}))
    }, text: () => el.textContent ?? '', input, writes, members,
      closed: () => closed, canSave: () => !button().disabled, failNext: action => { fail = action },
      select: async id => { await act(async () => Simulate.change(input(id))) },
      save: async () => { await act(async () => button().click()) },
    })
  } finally {
    await act(async () => root.unmount())
    // Radix 在下一轮事件循环派发关闭后的焦点恢复事件。
    await new Promise(resolve => setTimeout(resolve, 0))
    Object.assign(globalThis, previous)
  }
}

test('历史多位原样显示，明确选择保留者后才移除其余成员', () => withRoster(['A', 'B'], async ui => {
  expect(ui.text()).toContain('保留')
  expect(ui.input('A').closest('fieldset')?.textContent).toContain('成员 @ 后由群主设备依次回答，使用群主的模型额度，不共享本机文件。')
  expect(ui.input('A').checked && ui.input('B').checked).toBe(true)
  expect(ui.canSave()).toBe(false)
  expect(ui.reads).toEqual([])
  await ui.select('B')
  expect(ui.picker()).toBeNull()
  expect(ui.reads).toEqual([])
  expect(ui.input('B').checked).toBe(true)
  expect(ui.input('A').checked).toBe(false)
  expect(ui.writes).toEqual([])
  await ui.save()
  expect([...ui.members]).toEqual(['B'])
  expect(ui.closed()).toBe(true)
}))

test('单选切换先减后增，移除失败不登记，保留意图并使用同一操作重试', () => withRoster(['A'], async ui => {
  await ui.select('B')
  ui.failNext('removeAgent')
  await ui.save()
  expect(ui.writes.map(c => c.action)).toEqual(['removeAgent'])
  expect(ui.closed()).toBe(false)
  expect(ui.input('B').checked).toBe(true)
  await ui.save()
  expect(ui.writes.map(c => c.action)).toEqual(['removeAgent', 'removeAgent', 'registerAgent'])
  expect(ui.writes[1]).toEqual(ui.writes[0])
  expect([...ui.members]).toEqual(['B'])
}))

for (const external of [[], ['X'], ['X','Y']]) {
  test(`已有 ${external.length} 位外设备成员：只允许保存总数不超过一位的名单`, () => withRoster(['A', ...external], async ui => {
    if (external.length) {
      expect(ui.text()).toContain('原共享设备')
      expect(ui.input('B').disabled).toBe(true)
    }
    await ui.select('A')
    expect(ui.canSave()).toBe(external.length <= 1)
    await ui.save()
    expect([...ui.members]).toEqual(external.length <= 1 ? external : ['A', ...external])
    expect(ui.writes.length).toBe(external.length <= 1 ? 1 : 0)
  }))
}

test('打开后其他设备占用名额，不先删本机成员，也不允许重试超限方案', () => withRoster(['A'], async ui => {
  await ui.select('B')
  ui.members.add('X')
  await ui.save()
  expect(ui.writes).toEqual([])
  expect(ui.input('B').checked).toBe(true)
  expect(ui.text()).toContain('原共享设备')
  expect(ui.canSave()).toBe(false)
  expect(ui.closed()).toBe(false)
}))

test('移除已确认但新成员登记失败，保留选择，重试不再移除', () => withRoster(['A'], async ui => {
  await ui.select('B')
  ui.failNext('registerAgent')
  await ui.save()
  expect([...ui.members]).toEqual([])
  expect(ui.input('B').checked).toBe(true)
  expect(ui.closed()).toBe(false)
  await ui.save()
  expect(ui.writes.map(c => c.action)).toEqual(['removeAgent', 'registerAgent', 'registerAgent'])
  expect(ui.writes[2]).toEqual(ui.writes[1])
  expect([...ui.members]).toEqual(['B'])
  expect(ui.closed()).toBe(true)
}))

test('群主只改模型：按渠道和模型选择，只写本群已登记智能体', () => withRoster(['A'], async ui => {
  expect(ui.reads).toEqual([{ action: 'roomModelOptions', roomId: 'r', roomAgentId: 'A' }])
  expect(await ui.labels()).toEqual(['模型甲', '模型乙'])
  expect(ui.canSave()).toBe(false)
  await ui.choose(1)
  expect(ui.canSave()).toBe(true)
  await ui.save()
  expect(ui.writes).toEqual([{ action: 'setRoomModel', roomId: 'r', roomAgentId: 'A', ...alternative }])
  expect(ui.closed()).toBe(true)
}))

test('模型保存失败：显示原因，恢复已确认模型，不关闭或假装成功', () => withRoster(['A'], async ui => {
  await ui.choose(1)
  ui.failNext('setRoomModel')
  await ui.save()
  expect(ui.text()).toContain('请求超时')
  expect(ui.closed()).toBe(false)
  expect(ui.picker()!.textContent).toContain('模型甲')
  expect(ui.canSave()).toBe(false)
  await ui.choose(1)
  await ui.save()
  expect(ui.closed()).toBe(true)
  expect(ui.writes.map(c => c.action)).toEqual(['setRoomModel', 'setRoomModel'])
}))

test('改名单会丢弃旧模型草稿；未登记的所选智能体不读取候选', () => withRoster(['A'], async ui => {
  await ui.choose(1)
  await ui.select('B')
  expect(ui.picker()).toBeNull()
  expect(ui.reads).toHaveLength(1)
  await ui.save()
  expect(ui.writes.map(c => c.action)).toEqual(['removeAgent', 'registerAgent'])
}))

test('切群后迟到的旧候选不能覆盖当前群或作为保存目标', async () => {
  let finish!: (options: typeof modelOptions) => void
  const delayed = new Promise<typeof modelOptions>(resolve => { finish = resolve })
  await withRoster(['A'], async ui => {
    await ui.switchRoom('second')
    await ui.choose(1)
    await act(async () => finish({ current: alternative, options: [] }))
    expect(ui.canSave()).toBe(true)
    await ui.save()
    expect(ui.writes).toEqual([{ action: 'setRoomModel', roomId: 'second', roomAgentId: 'A', ...alternative }])
  }, async id => id === 'r' ? delayed : modelOptions)
})


test('仅有其他设备的已登记智能体，不展示模型或读取候选', () => withRoster(['X'], async ui => {
  expect(ui.text()).toContain('原共享设备')
  expect(ui.picker()).toBeNull()
  expect(ui.reads).toEqual([])
}))

test('保存回执渠道不匹配，不把所选模型当作已生效', () => withRoster(['A'], async ui => {
  await ui.choose(1)
  await ui.save()
  expect(ui.text()).toContain('回执不匹配')
  expect(ui.closed()).toBe(false)
  expect(ui.canSave()).toBe(false)
  expect(ui.picker()!.textContent).toContain('模型甲')
}, undefined, async () => current))


test('当前模型失效：空态在选择器外，唯一候选也必须显式选择才能保存', () => withRoster(['A'], async ui => {
  expect(ui.text()).toContain('暂无有效的当前模型')
  const picker = ui.picker()!
  expect(await ui.labels()).toEqual(['模型乙'])
  expect(picker.textContent).not.toContain('模型乙')
  expect(ui.canSave()).toBe(false)
  await ui.choose(0)
  expect(ui.canSave()).toBe(true)
  await ui.save()
  expect(ui.writes).toEqual([{ action: 'setRoomModel', roomId: 'r', roomAgentId: 'A', ...alternative }])
  expect(ui.closed()).toBe(true)
}, async () => ({ current: null, options: [{ ...alternative, name: '模型乙' }] })))

test('候选为空时只显示提示，不生成默认选项，也不能保存模型', () => withRoster(['A'], async ui => {
  expect(ui.text()).toContain('暂无可选的回答模型')
  expect(ui.picker()).toBeNull()
  expect(ui.canSave()).toBe(false)
}, async () => ({ current: null, options: [] })))

test('已登记但本机工作区已删除：展示模型读取错误，仍可取消勾选并移除绑定', () => withRoster(['A'], async ui => {
  expect(ui.text()).toContain('工作区已删除')
  expect(ui.input('A').checked).toBe(true)
  expect(ui.picker()).toBeNull()
  await ui.select('A')
  expect(ui.canSave()).toBe(true)
  await ui.save()
  expect(ui.writes).toEqual([{ action: 'removeAgent', roomId: 'r', roomAgentId: 'A', operationId: expect.any(String) }])
  expect(ui.closed()).toBe(true)
}, async () => { throw Error('工作区已删除') }))
