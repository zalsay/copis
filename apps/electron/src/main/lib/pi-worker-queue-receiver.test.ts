import { describe, expect, test } from 'bun:test'
import { receiveActiveWorkerQueue } from './pi-worker-queue-receiver'

describe('Pi Worker queue UUID 接收', () => {
  test('Given 活跃 Worker 连续收到相同 UUID When 投递 queue Then 只调用一次发送器', async () => {
    const state = { acceptedQueueUuids: new Set<string>() }
    let sendCalls = 0
    let releaseFirstSend!: () => void
    const firstSend = new Promise<void>((resolve) => {
      releaseFirstSend = resolve
    })
    const send = async (): Promise<void> => {
      sendCalls += 1
      await firstSend
    }

    const first = receiveActiveWorkerQueue(state, 'queue-1', send)
    const duplicate = await receiveActiveWorkerQueue(state, 'queue-1', send)
    releaseFirstSend()

    expect(duplicate).toBe(false)
    await expect(first).resolves.toBe(true)
    expect(sendCalls).toBe(1)
  })

  test('Given 首次发送失败 When 使用相同 UUID 重试 Then 允许再次发送', async () => {
    const state = { acceptedQueueUuids: new Set<string>() }
    let sendCalls = 0

    await expect(receiveActiveWorkerQueue(state, 'queue-1', async () => {
      sendCalls += 1
      throw new Error('临时失败')
    })).rejects.toThrow('临时失败')

    const accepted = await receiveActiveWorkerQueue(state, 'queue-1', async () => {
      sendCalls += 1
    })

    expect(accepted).toBe(true)
    expect(sendCalls).toBe(2)
  })
})
