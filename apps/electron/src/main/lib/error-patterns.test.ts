import { describe, expect, test } from 'bun:test'
import { isTransientNetworkError, isMalformedResponseError, isSessionNotFoundError, isNetworkError } from './error-patterns'

describe('isTransientNetworkError', () => {
  // 原有覆盖：确保扩展正则未回归
  test.each([
    'terminated',
    'socket hang up',
    'read ECONNRESET',
    'connect ETIMEDOUT 1.2.3.4:443',
    'write EPIPE',
    'getaddrinfo ENOTFOUND api.anthropic.com',
    'getaddrinfo EAI_AGAIN api.anthropic.com',
    'connect ECONNREFUSED 127.0.0.1:443',
    'TypeError: fetch failed',
    'TypeError: Failed to fetch',
    'network error',
    'stream closed prematurely',
    'premature close',
    'OpenAI Responses stream ended before a terminal response event',
    'Error Code undefined: Upstream Responses stream ended before a terminal event',
    'Anthropic stream ended before message_stop',
    'peer closed connection',
    'incomplete chunked read',
    'peer closed connection without sending complete message body (incomplete chunked read)',
  ])('Given 已知瞬时网络错误 "%s" Then 判定为可重试', (msg) => {
    expect(isTransientNetworkError(msg)).toBe(true)
  })

  // #903 新增覆盖：这些断连此前会绕过自动重试、误入终止分支并清除 sdkSessionId
  test.each([
    'The operation was aborted',
    'This operation was aborted',
    'AbortError: The operation was aborted',
    'Connection error.',
    'connection closed',
    'Connection reset by peer',
    'other side closed',
    'request was aborted',
    'request timed out',
    'connect ECONNABORTED',
  ])('Given #903 断连错误 "%s" Then 也判定为可重试', (msg) => {
    expect(isTransientNetworkError(msg)).toBe(true)
  })

  test('Given stderr 含瞬时网络错误 Then 判定为可重试', () => {
    expect(isTransientNetworkError(undefined, 'undici: other side closed')).toBe(true)
  })

  test('Given 普通业务错误 Then 不判定为瞬时网络错误', () => {
    expect(isTransientNetworkError('invalid api key')).toBe(false)
    expect(isTransientNetworkError('400 Bad Request: model not found')).toBe(false)
    expect(isTransientNetworkError('stream ended before an unrelated local marker')).toBe(false)
    expect(isTransientNetworkError()).toBe(false)
  })
})

describe('isMalformedResponseError', () => {
  test('Given JSON 解析失败 Then 判定为响应体解析失败', () => {
    expect(isMalformedResponseError('API Error: JSON Parse error: Unable to parse JSON string')).toBe(true)
    expect(isMalformedResponseError('Unexpected end of JSON input')).toBe(true)
    expect(isMalformedResponseError('Unexpected non-whitespace character after JSON at position 199 (line 2 column 1)')).toBe(true)
  })

  test('Given 普通错误 Then 不判定为响应体解析失败', () => {
    expect(isMalformedResponseError('socket hang up')).toBe(false)
    expect(isMalformedResponseError('Unexpected non-whitespace character in local config')).toBe(false)
  })
})

describe('isSessionNotFoundError', () => {
  test.each([
    'No conversation found with session ID: 4465917d-d054-4a5e-b29e-cc9f7d571810',
    'No conversation found withsessionID:4465917d-d054-4a5e-b29e-cc9f7d571810',
    '任务执行出错：No conversation found withsessionID:4465917d-d054-4a5e-b29e-cc9f7d571810',
    'No conversation found sessionID: 4465917d-d054-4a5e-b29e-cc9f7d571810',
  ])('Given SDK resume 会话丢失文案 "%s" Then 判定为 session-not-found', (msg) => {
    expect(isSessionNotFoundError(msg)).toBe(true)
  })

  test('Given stderr 含 session-not-found Then 判定为 session-not-found', () => {
    expect(isSessionNotFoundError(undefined, 'No conversation found withsessionID:abc')).toBe(true)
  })

  test('Given 普通错误 Then 不判定为 session-not-found', () => {
    expect(isSessionNotFoundError('conversation request failed with 502')).toBe(false)
    expect(isSessionNotFoundError('No model found with id claude')).toBe(false)
    expect(isSessionNotFoundError()).toBe(false)
  })
})

describe('isNetworkError', () => {
  test('Given TypeError: fetch failed (无网络时原生 fetch 异常) Then 判定为网络错误', () => {
    const error = new TypeError('fetch failed')
    expect(isNetworkError(error)).toBe(true)
  })

  test('Given TypeError: fetch failed 且 cause 包含 getaddrinfo ENOTFOUND Then 判定为网络错误', () => {
    const error = new TypeError('fetch failed')
    Object.assign(error, {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND download.copis.cn'), {
        code: 'ENOTFOUND',
      }),
    })
    expect(isNetworkError(error)).toBe(true)
  })

  test('Given 系统网络错误码对象 (code: ENOTFOUND / ECONNREFUSED) Then 判定为网络错误', () => {
    expect(isNetworkError({ code: 'ENOTFOUND', message: 'getaddrinfo failed' })).toBe(true)
    expect(isNetworkError({ code: 'ECONNREFUSED', message: 'connect failed' })).toBe(true)
    expect(isNetworkError({ code: 'EHOSTUNREACH', message: 'host unreachable' })).toBe(true)
  })

  test('Given 离线断网错误 (net::ERR_INTERNET_DISCONNECTED) Then 判定为网络错误', () => {
    expect(isNetworkError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(true)
    expect(isNetworkError(new Error('net::ERR_NAME_NOT_RESOLVED'))).toBe(true)
  })

  test('Given 字符串形式网络错误 Then 判定为网络错误', () => {
    expect(isNetworkError('TypeError: fetch failed')).toBe(true)
    expect(isNetworkError('Failed to fetch')).toBe(true)
    expect(isNetworkError('Network error: connect ETIMEDOUT')).toBe(true)
  })

  test('Given 非网络普通错误 Then 不判定为网络错误', () => {
    expect(isNetworkError(new Error('~/.copis/ 配置损坏'))).toBe(false)
    expect(isNetworkError(new Error('系统 Keychain 无法解密保存的凭证'))).toBe(false)
    expect(isNetworkError(new Error('Invalid token'))).toBe(false)
    expect(isNetworkError(null)).toBe(false)
    expect(isNetworkError(undefined)).toBe(false)
  })
})

