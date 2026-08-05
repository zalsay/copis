import { describe, expect, test } from 'bun:test'
import { getEnabledAgentChannelIds } from './agent-channel-selection'

describe('getEnabledAgentChannelIds', () => {
  test('uses the channel enabled state as the only Claude availability switch', () => {
    expect(getEnabledAgentChannelIds([
      { id: 'anthropic', provider: 'anthropic', enabled: true },
      { id: 'custom', provider: 'custom', enabled: true },
      { id: 'disabled-kimi', provider: 'kimi-api', enabled: false },
    ])).toEqual(['anthropic'])
  })
})
