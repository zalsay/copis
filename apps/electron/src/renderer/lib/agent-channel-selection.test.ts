import { describe, expect, test } from 'bun:test'
import { createBuiltinChannels } from '@copis/shared'
import { getEnabledAgentChannelIds } from './agent-channel-selection'

describe('Agent 内置渠道筛选', () => {
  test('Given 代码内置渠道 When 派生 Agent 渠道 Then 三个内置渠道均可用', () => {
    const channels = createBuiltinChannels('http://127.0.0.1:9000')

    expect(getEnabledAgentChannelIds(channels)).toEqual(channels.map((channel) => channel.id))
  })
})
