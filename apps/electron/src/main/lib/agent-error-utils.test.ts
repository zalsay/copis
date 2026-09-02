import { describe, expect, test } from 'bun:test'
import { friendlyErrorMessage, mapSDKErrorToTypedError } from './agent-error-utils'

describe('agent-error-utils', () => {
  describe('friendlyErrorMessage', () => {
    test('Given OpenAI API error (400) 原始错误 Then 返回友好的开启新会话解决提示', () => {
      const rawError = 'OpenAI API error (400): {"error":{"message":"Invalid message sequence","type":"invalid_request_error"}}'
      const friendly = friendlyErrorMessage(rawError)
      expect(friendly).toContain('模型调用失败 (400)')
      expect(friendly).toContain('建议开启新会话解决')
    })

    test('Given API Error: 400 原始错误 Then 返回友好的开启新会话解决提示', () => {
      const rawError = 'API Error: 400 Bad Request'
      const friendly = friendlyErrorMessage(rawError)
      expect(friendly).toContain('模型调用失败 (400)')
      expect(friendly).toContain('建议开启新会话解决')
    })

    test('Given OpenAI API error (401) 原始错误 Then 返回友好的认证失败提示并以「请重试」结尾', () => {
      const rawError = 'OpenAI API error (401): {"error":{"message":"Incorrect API key provided"}}'
      const friendly = friendlyErrorMessage(rawError)
      expect(friendly).toContain('认证失败 (401)')
      expect(friendly).toContain('请重试')
    })

    test('Given OpenAI API error (403) 原始错误 Then 返回友好的访问受限提示并以「请重试」结尾', () => {
      const rawError = 'OpenAI API error (403): Forbidden'
      const friendly = friendlyErrorMessage(rawError)
      expect(friendly).toContain('访问受限 (403)')
      expect(friendly).toContain('请重试')
    })

    test('Given OpenAI API error (404) 原始错误 Then 返回友好的模型不存在提示并以「请重试」结尾', () => {
      const rawError = 'OpenAI API error (404): The model `gpt-xxx` does not exist'
      const friendly = friendlyErrorMessage(rawError)
      expect(friendly).toContain('模型不存在 (404)')
      expect(friendly).toContain('请重试')
    })

    test('Given OpenAI API error (429) 原始错误 Then 返回友好的频率限制提示并以「请重试」结尾', () => {
      const rawError = 'OpenAI API error (429): Rate limit reached'
      const friendly = friendlyErrorMessage(rawError)
      expect(friendly).toContain('请求频率限制 (429)')
      expect(friendly).toContain('请重试')
    })

    test('Given OpenAI API error (500) 原始错误 Then 返回友好的内部服务错误提示并以「请重试」结尾', () => {
      const rawError = 'OpenAI API error (500): Internal Server Error'
      const friendly = friendlyErrorMessage(rawError)
      expect(friendly).toContain('服务内部错误 (500)')
      expect(friendly).toContain('请重试')
    })

    test('Given OpenAI API error (502) / 503 / 529 原始错误 Then 返回友好的服务错误提示并以「请重试」结尾', () => {
      expect(friendlyErrorMessage('OpenAI API error (502): Bad Gateway')).toContain('网关异常 (502)')
      expect(friendlyErrorMessage('OpenAI API error (502): Bad Gateway')).toContain('请重试')
      expect(friendlyErrorMessage('OpenAI API error (503): Service Unavailable')).toContain('服务不可用 (503)')
      expect(friendlyErrorMessage('OpenAI API error (503): Service Unavailable')).toContain('请重试')
      expect(friendlyErrorMessage('OpenAI API error (529): Overloaded')).toContain('服务过载 (529)')
      expect(friendlyErrorMessage('OpenAI API error (529): Overloaded')).toContain('请重试')
    })

    test('Given 网络断连与瞬时错误 Then 返回网络异常提示并以「请重试」结尾', () => {
      const friendly = friendlyErrorMessage('TypeError: Failed to fetch')
      expect(friendly).toContain('网络连接异常')
      expect(friendly).toContain('请重试')
    })

    test('Given capability expired 原始错误 Then 返回以「请重试」结尾的提示', () => {
      const rawError = 'API Error: 401 {"error":"模型会话已过期","code":"capability_expired"}'
      const friendly = friendlyErrorMessage(rawError)
      expect(friendly).toContain('请重试')
    })
  })

  describe('mapSDKErrorToTypedError', () => {
    test('Given OpenAI API error (400) 错误 Then 映射为含建议开启新会话与在新对话继续 action 的 TypedError', () => {
      const typed = mapSDKErrorToTypedError(
        'unknown_error',
        'OpenAI API error (400): {"error":{"message":"Invalid parameter"}}',
        'OpenAI API error (400)',
      )
      expect(typed.code).toBe('invalid_request')
      expect(typed.title).toBe('模型调用失败 (400)')
      expect(typed.message).toContain('建议开启新会话解决')
      expect(typed.canRetry).toBe(true)
      expect(typed.actions).toContainEqual({ key: 'n', label: '在新对话继续', action: 'retry_in_new_session' })
      expect(typed.actions).toContainEqual({ key: 'r', label: '重试', action: 'retry' })
    })

    test('Given 401/429/500/502 错误 Then 映射为含「请重试」的 TypedError', () => {
      const t401 = mapSDKErrorToTypedError('invalid_api_key', 'OpenAI API error (401)', '401')
      expect(t401.title).toBe('认证失败 (401)')
      expect(t401.message).toContain('请重试')

      const t429 = mapSDKErrorToTypedError('rate_limited', 'OpenAI API error (429)', '429')
      expect(t429.title).toBe('请求频率限制 (429)')
      expect(t429.message).toContain('请重试')

      const t502 = mapSDKErrorToTypedError('service_error', 'OpenAI API error (502)', '502')
      expect(t502.title).toBe('网关异常 (502)')
      expect(t502.message).toContain('请重试')
    })

    test('Given invalid_request 错误码 Then 映射为含建议开启新会话的 TypedError', () => {
      const typed = mapSDKErrorToTypedError(
        'invalid_request',
        '请求参数错误',
        'HTTP 400 invalid_request',
      )
      expect(typed.code).toBe('invalid_request')
      expect(typed.title).toBe('模型调用失败 (400)')
      expect(typed.message).toContain('建议开启新会话解决')
      expect(typed.actions).toContainEqual({ key: 'n', label: '在新对话继续', action: 'retry_in_new_session' })
    })

    test('Given capability_expired 错误码 Then 映射为可重试的 TypedError 并提示请重试', () => {
      const typed = mapSDKErrorToTypedError(
        'capability_expired',
        '模型会话已过期',
        'capability_expired: token timeout',
      )
      expect(typed.title).toBe('会话已过期')
      expect(typed.message).toContain('请重试')
      expect(typed.canRetry).toBe(true)
      expect(typed.actions).toEqual([{ key: 'r', label: '重试', action: 'retry' }])
    })

    test('Given invalid_upstream_response 错误码 Then 映射为可重试的 TypedError 并提示请重试', () => {
      const typed = mapSDKErrorToTypedError(
        'invalid_upstream_response',
        '模型服务响应异常',
        'HTTP 502 invalid_upstream_response',
      )
      expect(typed.title).toBe('网关异常 (502)')
      expect(typed.message).toContain('请重试')
      expect(typed.canRetry).toBe(true)
      expect(typed.actions).toContainEqual({ key: 'r', label: '重试', action: 'retry' })
    })
  })
})
