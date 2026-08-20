import { describe, expect, test } from 'bun:test'
import {
  attachWebTabDragMouseListeners,
  getWebTabDragOffset,
  getWebTabDragMovePhase,
  getWebTabDropIndex,
  getWebTabDropMarkerIndex,
  hasWebTabDragStarted,
} from './web-tab-drag'

function createMouseEvent(type: string, clientX: number, clientY: number): Event {
  return Object.assign(new Event(type), { clientX, clientY })
}

describe('网页页签拖动位置计算', () => {
  test('Given拖动已激活且待处理状态已清空 When继续移动 Then识别为激活拖动', () => {
    expect(getWebTabDragMovePhase('A', null, 'A')).toBe('active')
  })

  test('Given鼠标跨过相邻 Tab When窗口继续收到移动 Then拖动回调持续跟随直到松开', () => {
    const target = new EventTarget()
    const moved: Array<{ x: number; y: number }> = []
    let ended = 0
    const cleanup = attachWebTabDragMouseListeners(
      target as unknown as Document,
      (event) => moved.push({ x: event.clientX, y: event.clientY }),
      () => { ended += 1 },
    )

    target.dispatchEvent(createMouseEvent('mousemove', 320, 18))
    target.dispatchEvent(createMouseEvent('mousemove', 500, 18))
    target.dispatchEvent(createMouseEvent('mousemove', 640, 18))
    target.dispatchEvent(createMouseEvent('mouseup', 640, 18))
    target.dispatchEvent(createMouseEvent('mousemove', 800, 18))

    expect(moved).toEqual([{ x: 320, y: 18 }, { x: 500, y: 18 }, { x: 640, y: 18 }])
    expect(ended).toBe(1)
    cleanup()
  })

  test('Given指针移动小于 6px When判断拖动 Then不开始拖动', () => {
    expect(hasWebTabDragStarted(10, 10, 15, 13)).toBe(false)
  })

  test('Given指针移动达到 6px When判断拖动 Then开始拖动', () => {
    expect(hasWebTabDragStarted(10, 10, 16, 10)).toBe(true)
  })

  test('Given拖动 A When指针位于 B 左半区 Then插入索引为 0', () => {
    expect(getWebTabDropIndex(120, [
      { id: 'A', left: 0, right: 100 },
      { id: 'B', left: 100, right: 200 },
      { id: 'C', left: 200, right: 300 },
    ], 'A')).toBe(0)
  })

  test('Given拖动 A When指针位于 B 右半区 Then插入索引为 1', () => {
    expect(getWebTabDropIndex(180, [
      { id: 'A', left: 0, right: 100 },
      { id: 'B', left: 100, right: 200 },
      { id: 'C', left: 200, right: 300 },
    ], 'A')).toBe(1)
  })

  test('Given拖动 C When指针位于 A 左侧或列表末端 Then返回首位或末位索引', () => {
    const rects = [
      { id: 'A', left: 0, right: 100 },
      { id: 'B', left: 100, right: 200 },
      { id: 'C', left: 200, right: 300 },
    ]

    expect(getWebTabDropIndex(20, rects, 'C')).toBe(0)
    expect(getWebTabDropIndex(290, rects, 'C')).toBe(2)
  })

  test('Given源页签从首位移动到末位 When渲染插入提示 Then提示显示在原列表末尾', () => {
    expect(getWebTabDropMarkerIndex(['A', 'B', 'C'], 'A', 2)).toBe(3)
  })

  test('Given源页签从末位移动到首位 When渲染插入提示 Then提示显示在原列表首位', () => {
    expect(getWebTabDropMarkerIndex(['A', 'B', 'C'], 'C', 0)).toBe(0)
  })

  test('Given拖动网页 Tab When指针向右移动 Then Tab 本体水平覆盖相邻 Tab 且不发生下移', () => {
    expect(getWebTabDragOffset(100, 250)).toEqual({ x: 150, y: 0 })
  })

  test('Given拖动网页 Tab When指针向左移动 Then Tab 本体水平覆盖相邻 Tab', () => {
    expect(getWebTabDragOffset(250, 100)).toEqual({ x: -150, y: 0 })
  })
})
