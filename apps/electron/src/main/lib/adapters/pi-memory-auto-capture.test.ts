import { describe, expect, test } from 'bun:test'
import {
  MemoryAutoCapture,
  MEMORY_CAPTURE_MAX_TURNS,
  parseMemoryFacts,
} from './pi-memory-auto-capture'

function turn(index: number, autonomous = false) {
  return {
    sessionId: `session-${autonomous ? 'auto' : 'user'}`,
    workspaceSlug: 'project-a',
    userInput: `用户回合 ${index}`,
    assistantReply: `助手回合 ${index}`,
    autonomous,
    memoryPolicy: 'writable' as const,
  }
}

describe('Pi Memory per-turn 自动捕获', () => {
  test('Given 9 个成功 turn When 第 9 轮结束 Then 不调用隐藏抽取', async () => {
    let extractionCount = 0
    let captureCount = 0
    const capture = new MemoryAutoCapture({
      extractor: async () => {
        extractionCount += 1
        return '- [fact] 事实: 内容'
      },
      captureBatch: async () => { captureCount += 1 },
      quietMs: 999_999,
    })

    for (let index = 0; index < MEMORY_CAPTURE_MAX_TURNS - 1; index += 1) {
      await capture.onTurnEnd(turn(index))
    }

    expect(extractionCount).toBe(0)
    expect(captureCount).toBe(0)
  })

  test('Given 10 个成功 turn When 第 10 轮结束 Then 只抽取并提交一次 scratch batch', async () => {
    let extractionCount = 0
    const batches: unknown[] = []
    const capture = new MemoryAutoCapture({
      extractor: async () => {
        extractionCount += 1
        return '- [preference] 输出语言: 优先使用中文'
      },
      captureBatch: async (input) => { batches.push(input) },
      quietMs: 999_999,
    })

    for (let index = 0; index < MEMORY_CAPTURE_MAX_TURNS; index += 1) {
      await capture.onTurnEnd(turn(index))
    }

    expect(extractionCount).toBe(1)
    expect(batches).toHaveLength(1)
    expect((batches[0] as { items: Array<{ kind: string }> }).items[0]?.kind).toBe('scratch')
  })

  test('Given quiet timer 到期 When flush Then 清空 burst 并提交一次', async () => {
    let timerCallback: (() => void) | undefined
    let captureCount = 0
    const capture = new MemoryAutoCapture({
      extractor: async () => '- [fact] 状态: 需要保留',
      captureBatch: async () => { captureCount += 1 },
      quietMs: 180_000,
      setTimeoutFn: ((callback: () => void) => {
        timerCallback = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      }) as typeof setTimeout,
      clearTimeoutFn: (() => {}) as typeof clearTimeout,
    })

    await capture.onTurnEnd(turn(1))
    timerCallback?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(captureCount).toBe(1)
  })

  test('Given NONE 或非 bullet 输出 Then 不写入数据库', async () => {
    let captureCount = 0
    const capture = new MemoryAutoCapture({
      extractor: async () => '解释：没有需要记录的内容',
      captureBatch: async () => { captureCount += 1 },
      quietMs: 999_999,
    })
    await capture.onTurnEnd({ ...turn(1), extractor: async () => 'NONE' })
    await capture.flush('project-a', 'manual')
    expect(captureCount).toBe(0)
    expect(parseMemoryFacts('说明\n- [fact] 标题: 内容')).toEqual([])
  })

  test('Given autonomous turn 返回 preference When flush Then 不产生用户偏好事实', async () => {
    let captureCount = 0
    const capture = new MemoryAutoCapture({
      extractor: async () => '- [preference] 用户偏好: 不应写入',
      captureBatch: async () => { captureCount += 1 },
      quietMs: 999_999,
    })
    await capture.onTurnEnd({ ...turn(1, true), extractor: async () => '- [preference] 用户偏好: 不应写入' })
    await capture.flush('project-a', 'manual')
    expect(captureCount).toBe(0)
  })
})
