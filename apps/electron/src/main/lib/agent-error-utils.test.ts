import { describe, expect, test } from 'bun:test'
import { friendlyErrorMessage, mapSDKErrorToTypedError } from './agent-error-utils'

describe('agent-error-utils', () => {
  describe('friendlyErrorMessage', () => {
    test('Given capability expired 原始错误 Then 返回友好的重试与继续任务提示', () => {
      const rawError = 'API Error: 401 {"error":"模型会话已过期，请直接发送「继续任务」或点击重试","code":"capability_expired"}'
      const friendly = friendlyErrorMessage(rawError)
      expect(friendly).toContain('继续任务')
      expect(friendly).toContain('重试')
    })

    test('Given invalid_upstream_response 原始错误 Then 返回友好的重试与继续任务提示', () => {
      const rawError = 'API Error: 502 {"error":"模型服务响应异常，请直接发送「继续任务」或点击重试","code":"invalid_upstream_response"}'
      const friendly = friendlyErrorMessage(rawError)
      expect(friendly).toContain('继续任务')
      expect(friendly).toContain('重试')
    })
  })

  describe('mapSDKErrorToTypedError', () => {
    test('Given capability_expired 错误码 Then 映射为可重试的 TypedError 并提示发送继续任务', () => {
      const typed = mapSDKErrorToTypedError(
        'capability_expired',
        '模型会话已过期',
        'capability_expired: token timeout',
      )
      expect(typed.title).toBe('会话已过期')
      expect(typed.message).toContain('继续任务')
      expect(typed.canRetry).toBe(true)
      expect(typed.actions).toEqual([{ key: 'r', label: '重试', action: 'retry' }])
    })

    test('Given detailedMessage 含有 capability expired Then 正确识别并友好化', () => {
      const typed = mapSDKErrorToTypedError(
        'api_error',
        'Working 模型代理 capability 已过期',
        'HTTP 401 capability_expired',
      )
      expect(typed.title).toBe('会话已过期')
      expect(typed.message).toContain('继续任务')
      expect(typed.canRetry).toBe(true)
    })

    test('Given invalid_upstream_response 错误码 Then 映射为可重试的 TypedError 并提示发送继续任务', () => {
      const typed = mapSDKErrorToTypedError(
        'invalid_upstream_response',
        '模型服务响应异常',
        'HTTP 502 invalid_upstream_response',
      )
      expect(typed.title).toBe('模型响应异常')
      expect(typed.message).toContain('继续任务')
      expect(typed.canRetry).toBe(true)
      expect(typed.actions).toEqual([{ key: 'r', label: '重试', action: 'retry' }])
    })
  })
})
