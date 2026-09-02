/** Agent runtime 通用错误归一化。 */

import type { ErrorCode, TypedError } from '@copis/shared'
import {
  THINKING_SIGNATURE_ERROR_MESSAGE,
  THINKING_SIGNATURE_ERROR_TITLE,
  isThinkingSignatureError as matchesThinkingSignatureError,
  OPENAI_400_FRIENDLY_MESSAGE,
  OPENAI_400_ERROR_TITLE,
  HTTP_STATUS_ERROR_MAP,
  extractHttpStatusFromErrorText,
  is400ApiError,
  isPromptTooLongError as matchesPromptTooLongError,
  friendlyErrorMessage,
} from '@copis/shared'
import { TRANSIENT_NETWORK_PATTERN, isMalformedResponseError } from './error-patterns'

export {
  OPENAI_400_FRIENDLY_MESSAGE,
  OPENAI_400_ERROR_TITLE,
  HTTP_STATUS_ERROR_MAP,
  extractHttpStatusFromErrorText,
  is400ApiError,
  friendlyErrorMessage,
}

const CONTINUABLE_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  'aborted_streaming',
  'aborted_tools',
  'tool_deferred',
  'hook_stopped',
  'stop_hook_prevented',
])

export function shouldKeepChannelOpen(terminalReason: string | undefined): boolean {
  return terminalReason != null && CONTINUABLE_TERMINAL_REASONS.has(terminalReason)
}

export function isPromptTooLongError(...messages: string[]): boolean {
  return matchesPromptTooLongError(...messages)
}

export function isThinkingSignatureError(...messages: string[]): boolean {
  return matchesThinkingSignatureError(...messages)
}

export function mapSDKErrorToTypedError(
  errorCode: string,
  detailedMessage: string,
  originalError: string,
): TypedError {
  if (isThinkingSignatureError(detailedMessage, originalError)) {
    return {
      code: 'thinking_signature_invalid',
      title: THINKING_SIGNATURE_ERROR_TITLE,
      message: THINKING_SIGNATURE_ERROR_MESSAGE,
      actions: [
        { key: 'n', label: '在新对话继续', action: 'retry_in_new_session' },
        { key: 'r', label: '重试', action: 'retry' },
      ],
      canRetry: true,
      retryDelayMs: 1000,
      originalError,
    }
  }

  const httpStatus = extractHttpStatusFromErrorText(detailedMessage, originalError)

  if (
    is400ApiError(detailedMessage, originalError) ||
    errorCode === 'invalid_request' ||
    httpStatus === 400
  ) {
    return {
      code: 'invalid_request',
      title: OPENAI_400_ERROR_TITLE,
      message: OPENAI_400_FRIENDLY_MESSAGE,
      actions: [
        { key: 'n', label: '在新对话继续', action: 'retry_in_new_session' },
        { key: 'r', label: '重试', action: 'retry' },
        { key: 's', label: '设置', action: 'settings' },
      ],
      canRetry: true,
      retryDelayMs: 1000,
      originalError,
    }
  }

  if (httpStatus != null && HTTP_STATUS_ERROR_MAP[httpStatus]) {
    const statusMeta = HTTP_STATUS_ERROR_MAP[httpStatus]
    return {
      code: (statusMeta.code as ErrorCode) || 'service_error',
      title: statusMeta.title,
      message: statusMeta.message,
      actions: [
        ...(httpStatus === 401 || httpStatus === 403 || httpStatus === 404
          ? [{ key: 'm', label: '重新选择模型', action: 'select_model' as const }, { key: 's', label: '设置', action: 'settings' as const }]
          : [{ key: 's', label: '设置', action: 'settings' as const }]),
        { key: 'r', label: '重试', action: 'retry' as const },
      ],
      canRetry: true,
      retryDelayMs: 1000,
      originalError,
    }
  }

  if (
    errorCode === 'capability_expired' ||
    /capability_expired|capability.*expired|模型.*capability.*过期|模型会话已过期/i.test(detailedMessage) ||
    /capability_expired|capability.*expired|模型.*capability.*过期|模型会话已过期/i.test(originalError)
  ) {
    return {
      code: 'service_error',
      title: '会话已过期',
      message: '模型会话已过期，请重试。',
      actions: [
        { key: 'r', label: '重试', action: 'retry' },
      ],
      canRetry: true,
      retryDelayMs: 1000,
      originalError,
    }
  }

  if (
    errorCode === 'invalid_upstream_response' ||
    /invalid_upstream_response|模型.*响应.*不正确|模型服务响应异常/i.test(detailedMessage) ||
    /invalid_upstream_response|模型.*响应.*不正确|模型服务响应异常/i.test(originalError)
  ) {
    return {
      code: 'service_error',
      title: '模型响应异常',
      message: '模型服务响应暂时异常，请重试。',
      actions: [
        { key: 'r', label: '重试', action: 'retry' },
      ],
      canRetry: true,
      retryDelayMs: 1000,
      originalError,
    }
  }

  const errorMap: Record<string, { code: ErrorCode; title: string; message: string; canRetry: boolean }> = {
    authentication_failed: { code: 'invalid_api_key', title: '认证失败', message: '无法通过 API 认证，API Key 可能无效或已过期，请重试。', canRetry: true },
    billing_error: { code: 'billing_error', title: '账单错误', message: '您的账户存在账单问题或额度不足，请重试。', canRetry: true },
    model_not_found: { code: 'invalid_model', title: '模型不可用', message: '当前渠道无法使用所选模型，请检查模型名称或切换模型，请重试。', canRetry: true },
    invalid_request: { code: 'invalid_request', title: OPENAI_400_ERROR_TITLE, message: OPENAI_400_FRIENDLY_MESSAGE, canRetry: true },
    rate_limit: { code: 'rate_limited', title: '请求频率限制', message: '请求过于频繁或配额受限，请重试。', canRetry: true },
    rate_limited: { code: 'rate_limited', title: '请求频率限制', message: '请求过于频繁或配额受限，请重试。', canRetry: true },
    overloaded: { code: 'provider_error', title: '服务繁忙', message: 'API 服务当前过载，请重试。', canRetry: true },
    provider_error: { code: 'provider_error', title: '服务繁忙', message: 'API 服务当前过载或暂时异常，请重试。', canRetry: true },
    service_error: { code: 'service_error', title: '服务错误', message: 'API 服务暂时异常，请重试。', canRetry: true },
    api_error: { code: 'service_error', title: '服务错误', message: 'API 服务暂时异常，请重试。', canRetry: true },
    service_unavailable: { code: 'service_unavailable', title: '服务暂时不可用', message: 'API 服务暂时不可用，请重试。', canRetry: true },
    server_error: { code: 'service_error', title: '服务错误', message: 'API 服务暂时异常，请重试。', canRetry: true },
    prompt_too_long: { code: 'prompt_too_long', title: '上下文过长', message: '当前对话的上下文已超出模型限制，建议开启新会话解决。', canRetry: false },
    network_error: { code: 'network_error', title: '网络异常', message: '上游 API 连接中断，请重试。', canRetry: true },
  }

  if (!errorMap[errorCode] && (TRANSIENT_NETWORK_PATTERN.test(detailedMessage) || TRANSIENT_NETWORK_PATTERN.test(originalError))) {
    return {
      code: 'network_error', title: '网络异常', message: detailedMessage ? friendlyErrorMessage(detailedMessage) : '上游 API 连接中断，请重试。',
      actions: [{ key: 's', label: '设置', action: 'settings' }, { key: 'r', label: '重试', action: 'retry' }],
      canRetry: true, retryDelayMs: 1000, originalError,
    }
  }

  if (!errorMap[errorCode] && isMalformedResponseError(detailedMessage, originalError)) {
    return {
      code: 'service_error', title: '响应解析失败', message: '上游返回了无法解析的响应，请重试。',
      actions: [{ key: 's', label: '设置', action: 'settings' }, { key: 'r', label: '重试', action: 'retry' }],
      canRetry: true, retryDelayMs: 1000, originalError,
    }
  }

  const mapped = errorMap[errorCode] ?? { code: 'unknown_error' as ErrorCode, title: '服务错误', message: friendlyErrorMessage(detailedMessage || errorCode), canRetry: true }
  const isInvalidChannelOrModel = /请检查是否选择了正确的 Copis 供应渠道和模型/.test(mapped.message)
  return {
    code: mapped.code,
    title: mapped.title,
    message: detailedMessage ? friendlyErrorMessage(detailedMessage) : mapped.message,
    actions: [
      isInvalidChannelOrModel ? { key: 'm', label: '重新选择模型', action: 'select_model' } : { key: 's', label: '设置', action: 'settings' },
      ...(mapped.canRetry ? [{ key: 'r', label: '重试', action: 'retry' }] : []),
      ...(mapped.code === 'prompt_too_long' ? [{ key: 'c', label: '压缩上下文', action: 'compact' }, { key: 'n', label: '在新对话继续', action: 'retry_in_new_session' }] : []),
    ],
    canRetry: mapped.canRetry,
    retryDelayMs: mapped.canRetry ? 1000 : undefined,
    originalError,
  }
}

export function extractErrorDetails(msg: { error?: { message: string }; message?: { content?: Array<Record<string, unknown>> } }): { detailedMessage: string; originalError: string } {
  let detailedMessage = msg.error?.message ?? '未知错误'
  let originalError = msg.error?.message ?? '未知错误'
  try {
    const content = msg.message?.content
    const textBlock = Array.isArray(content) ? content.find((block) => block.type === 'text') : undefined
    if (textBlock && typeof textBlock.text === 'string') {
      const fullText = textBlock.text
      originalError = fullText
      const apiErrorMatch = fullText.match(/(?:(?:OpenAI|OpenAl)\s+)?API\s+[Ee]rror(?:\s*\(\d+\))?[:\s]+\d*\s*(\{.*\})/s)
      if (apiErrorMatch?.[1]) {
        try {
          const apiErrorObj = JSON.parse(apiErrorMatch[1]) as { error?: { message?: string } }
          detailedMessage = apiErrorObj.error?.message ?? fullText
        } catch {
          detailedMessage = fullText
        }
      } else {
        detailedMessage = fullText
      }
    }
  } catch {
    // 提取失败时使用原始 error 字段。
  }
  return { detailedMessage, originalError }
}
