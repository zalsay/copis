import { expect, test } from 'bun:test'
import { isChatRoomPermissionResponse } from '@copis/shared'

test('Given permission response with prototype or symbol fields When validating Then reject it', () => {
  const value = Object.create({ requestId: 'request-1' }) as Record<string, unknown>
  value.behavior = 'allow'
  expect(isChatRoomPermissionResponse(value)).toBe(false)
  const symbolValue = { requestId: 'request-1', behavior: 'allow', [Symbol('toolInput')]: 'secret' }
  expect(isChatRoomPermissionResponse(symbolValue)).toBe(false)
})
