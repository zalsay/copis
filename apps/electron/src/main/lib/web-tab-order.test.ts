import { describe, expect, test } from 'bun:test'
import { moveWebTab } from './web-tab-order'

describe('网页页签顺序移动', () => {
  test('Given A、B、C When 将 A 移到末位 Then 顺序为 B、C、A', () => {
    expect(moveWebTab(['A', 'B', 'C'], 0, 2)).toEqual(['B', 'C', 'A'])
  })

  test('Given A、B、C When 将 C 移到首位 Then 顺序为 C、A、B', () => {
    expect(moveWebTab(['A', 'B', 'C'], 2, 0)).toEqual(['C', 'A', 'B'])
  })

  test('Given A、B、C When 将 A 移到 B 后面 Then 顺序为 B、A、C', () => {
    expect(moveWebTab(['A', 'B', 'C'], 0, 1)).toEqual(['B', 'A', 'C'])
  })

  test('Given源和目标位置相同或索引无效 When移动页签 Then顺序保持不变', () => {
    expect(moveWebTab(['A', 'B', 'C'], 1, 1)).toEqual(['A', 'B', 'C'])
    expect(moveWebTab(['A', 'B', 'C'], -1, 1)).toEqual(['A', 'B', 'C'])
    expect(moveWebTab(['A', 'B', 'C'], 0, 3)).toEqual(['A', 'B', 'C'])
  })
})
