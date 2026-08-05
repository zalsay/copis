import { describe, expect, test } from 'bun:test'
import { memoryToolNamesForPolicy } from './memory-tool-policy'

describe('Pi Memory 工具策略矩阵', () => {
  test('Given off policy Then不注册任何 Memory tool', () => {
    expect(memoryToolNamesForPolicy('off')).toEqual([])
  })

  test('Given visible policy Then只注册 recall/read', () => {
    expect(memoryToolNamesForPolicy('visible')).toEqual(['memory_recall', 'memory_read'])
  })

  test('Given writable policy Then注册读写四个 typed tools', () => {
    expect(memoryToolNamesForPolicy('writable')).toEqual([
      'memory_recall',
      'memory_read',
      'memory_capture',
      'memory_rewrite',
    ])
  })
})
