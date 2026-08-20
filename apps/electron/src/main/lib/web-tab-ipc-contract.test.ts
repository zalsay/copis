import { expect, test } from 'bun:test'
import { WEB_IPC_CHANNELS } from '@copis/shared'

test('网页页签重排使用独立 IPC 通道', () => {
  expect(WEB_IPC_CHANNELS.REORDER).toBe('web-tabs:reorder')
})
