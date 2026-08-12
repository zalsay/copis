import { describe, expect, test } from 'bun:test'
import { isAdvancedAuthorizationCommand } from './permission-rules'

describe('高级授权命令', () => {
  test('Given Bearer curl When checking Composer advanced authorization Then it requires advanced authorization', () => {
    expect(isAdvancedAuthorizationCommand(
      "curl -H 'Authorization: Bearer test-token' https://example.test/health",
    )).toBe(true)
  })

  test('Given Python command When checking Composer advanced authorization Then it requires advanced authorization', () => {
    expect(isAdvancedAuthorizationCommand('python script.py')).toBe(true)
    expect(isAdvancedAuthorizationCommand('python3 -c "print(1)"')).toBe(true)
  })
})
