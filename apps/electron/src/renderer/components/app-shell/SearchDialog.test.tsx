import { describe, expect, test } from 'bun:test'
import { SearchDialog } from './SearchDialog'

describe('Agent-only 搜索入口', () => {
  test('保留可加载的搜索组件', () => {
    expect(SearchDialog).toBeTypeOf('function')
  })
})
