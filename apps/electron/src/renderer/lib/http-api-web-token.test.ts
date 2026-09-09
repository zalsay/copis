import { expect, test } from 'bun:test'
import { setHttpApiWebToken, withHttpApiWebToken } from './http-api-web-token'

test('preload 注入令牌后无需 window.electronAPI 即可认证请求', () => {
  setHttpApiWebToken('preload-test-token')
  const request = withHttpApiWebToken({ headers: { Accept: 'text/event-stream' } })
  const headers = new Headers(request.headers)
  expect(headers.get('x-copis-web-token')).toBe('preload-test-token')
  expect(headers.get('Accept')).toBe('text/event-stream')
  setHttpApiWebToken('rotated-test-token')
  expect(new Headers(withHttpApiWebToken({}).headers).get('x-copis-web-token')).toBe('rotated-test-token')
  setHttpApiWebToken('')
})
