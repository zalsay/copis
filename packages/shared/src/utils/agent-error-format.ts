/**
 * 通用 Agent / 模型调用错误归一化与友好提示工具
 */

import {
  THINKING_SIGNATURE_ERROR_MESSAGE,
  THINKING_SIGNATURE_ERROR_TITLE,
  isThinkingSignatureError,
} from './thinking-signature-error'

export const OPENAI_400_FRIENDLY_MESSAGE = '模型调用失败 (400)：API 请求参数或上下文格式异常，建议开启新会话解决。'
export const OPENAI_400_ERROR_TITLE = '模型调用失败 (400)'

export interface HttpStatusErrorDetail {
  code: string
  title: string
  message: string
}

export const HTTP_STATUS_ERROR_MAP: Record<number, HttpStatusErrorDetail> = {
  400: {
    code: 'invalid_request',
    title: OPENAI_400_ERROR_TITLE,
    message: OPENAI_400_FRIENDLY_MESSAGE,
  },
  401: {
    code: 'invalid_api_key',
    title: '认证失败 (401)',
    message: '认证失败 (401)：API Key 无效或未授权，请检查渠道配置，请重试。',
  },
  402: {
    code: 'billing_error',
    title: '账单异常 (402)',
    message: '账单异常 (402)：账户额度不足或存在欠费，请重试。',
  },
  403: {
    code: 'invalid_api_key',
    title: '访问受限 (403)',
    message: '访问受限 (403)：无权访问所选模型或操作被拒绝，请重试。',
  },
  404: {
    code: 'invalid_model',
    title: '模型不存在 (404)',
    message: '模型不存在 (404)：当前渠道找不到所选模型，请检查模型名称，请重试。',
  },
  408: {
    code: 'network_error',
    title: '请求超时 (408)',
    message: '请求超时 (408)：网络连接或模型响应超时，请重试。',
  },
  429: {
    code: 'rate_limited',
    title: '请求频率限制 (429)',
    message: '请求频率限制 (429)：请求过于频繁或配额受限，请重试。',
  },
  500: {
    code: 'service_error',
    title: '服务内部错误 (500)',
    message: '服务内部错误 (500)：上游模型服务内部异常，请重试。',
  },
  502: {
    code: 'service_error',
    title: '网关异常 (502)',
    message: '网关异常 (502)：上游服务响应异常或网关暂时故障，请重试。',
  },
  503: {
    code: 'service_unavailable',
    title: '服务不可用 (503)',
    message: '服务不可用 (503)：上游模型服务暂时不可用，请重试。',
  },
  504: {
    code: 'service_error',
    title: '网关超时 (504)',
    message: '网关超时 (504)：上游服务响应超时，请重试。',
  },
  529: {
    code: 'provider_error',
    title: '服务过载 (529)',
    message: '服务过载 (529)：API 服务当前负载过高，请重试。',
  },
}

/** 提取 HTTP 状态码 */
export function extractHttpStatusFromErrorText(...messages: Array<string | null | undefined>): number | null {
  const combined = messages.filter(Boolean).join('\n')
  const patterns = [
    /(?:(?:OpenAI|OpenAl)\s+)?API\s+(?:error|错误|Error)\s*\((\d{3})\)/i,
    /API Error:\s*(\d{3})/i,
    /API error[^:]*:\s+(\d{3})/i,
    /\b(?:HTTP|status|statusCode)\s*[:=]?\s*(\d{3})\b/i,
    /\b(\d{3})\s+\{[^}]*"error"/is,
    /\b(\d{3})\s+(?:Bad Request|Unauthorized|Forbidden|Not Found|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)/i,
  ]
  for (const pattern of patterns) {
    const match = combined.match(pattern)
    const statusCode = match?.[1] ? parseInt(match[1], 10) : NaN
    if (statusCode >= 400 && statusCode < 600) return statusCode
  }
  return null
}

export function is400ApiError(...messages: Array<string | null | undefined>): boolean {
  const combined = messages.filter(Boolean).join('\n')
  return (
    extractHttpStatusFromErrorText(combined) === 400 ||
    /(?:(?:OpenAI|OpenAl)\s+)?API\s+(?:error|错误|Error)(?:\s*\(\s*400\s*\)|:\s*400|\s+400\b)|\b400\s+Bad\s+Request|\b400\s+\{[^}]*"error"|invalid_request_error.*400|\bstatus(?:Code)?\s*[:=]?\s*400\b/i.test(combined)
  )
}

const PROMPT_TOO_LONG_PATTERNS = [
  'prompt is too long',
  'prompt_too_long',
  'input is too long',
  'context_length_exceeded',
  'maximum context length',
  'token limit',
  'exceeds the model',
] as const

export function isPromptTooLongError(...messages: Array<string | null | undefined>): boolean {
  const combined = messages.filter(Boolean).join(' ').toLowerCase()
  return PROMPT_TOO_LONG_PATTERNS.some((pattern) => combined.includes(pattern))
}

const TRANSIENT_NETWORK_REGEX = /terminated|socket hang up|read ECONNRESET|connect ETIMEDOUT|write EPIPE|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed|Failed to fetch|network error|stream closed prematurely|premature close|ended before|peer closed connection|incomplete chunked read|The operation was aborted|This operation was aborted|AbortError: The operation was aborted|Connection error|connection closed|Connection reset by peer|other side closed|request was aborted|request timed out|connect ECONNABORTED/i

export function isTransientNetworkErrorText(text: string): boolean {
  return TRANSIENT_NETWORK_REGEX.test(text)
}

const MALFORMED_RESPONSE_REGEX = /JSON Parse error|Unexpected token|is not valid JSON|Unexpected end of JSON|Unexpected character/i

export function isMalformedResponseErrorText(text: string): boolean {
  return MALFORMED_RESPONSE_REGEX.test(text)
}

const MAX_ERROR_MESSAGE_LENGTH = 5000

/**
 * 将模型/API 原始错误转为友好提示：
 * - 400 错误以及上下文/格式校验异常以「建议开启新会话解决。」结尾；
 * - 其他错误码与服务/网络异常以「请重试。」结尾。
 */
export function friendlyErrorMessage(raw: string): string {
  if (!raw) return '未知错误，请重试。'

  // 1. Thinking signature 不兼容
  if (isThinkingSignatureError(raw)) {
    return `${THINKING_SIGNATURE_ERROR_TITLE}：${THINKING_SIGNATURE_ERROR_MESSAGE}`
  }

  // 2. HTTP 状态码精准映射
  const httpStatus = extractHttpStatusFromErrorText(raw)
  if (httpStatus != null && HTTP_STATUS_ERROR_MAP[httpStatus]) {
    return HTTP_STATUS_ERROR_MAP[httpStatus].message
  }
  if (httpStatus != null && httpStatus >= 400 && httpStatus < 600) {
    return `API 服务暂时异常 (${httpStatus})，请重试。`
  }

  // 3. 语义模式匹配
  if (is400ApiError(raw) || /validation error|schema validation/i.test(raw)) {
    return OPENAI_400_FRIENDLY_MESSAGE
  }

  if (isPromptTooLongError(raw)) {
    return '当前对话的上下文已超出模型限制，建议开启新会话解决。'
  }

  if (/capability_expired|capability.*expired|模型.*capability.*过期|模型会话已过期/i.test(raw)) {
    return '模型会话已过期，请重试。'
  }

  if (/invalid_upstream_response|模型.*响应.*不正确|模型服务响应异常/i.test(raw)) {
    return '模型服务响应暂时异常，请重试。'
  }

  if (/not logged in|please run \/login/i.test(raw)) {
    return '请检查是否选择了正确的 Copis 供应渠道和模型，请重试。'
  }

  if (/api.*key|unauthorized|invalid.*key|authentication/i.test(raw)) {
    return 'API Key 无效或未授权，请检查渠道配置，请重试。'
  }

  if (/billing|quota|insufficient_quota|balance|payment/i.test(raw)) {
    return '账户额度不足或存在账单问题，请重试。'
  }

  if (/model.*(?:not found|unavailable)|invalid.*model/i.test(raw)) {
    return '当前渠道无法使用所选模型，请检查模型配置，请重试。'
  }

  if (/rate.?limit/i.test(raw)) {
    return '请求过于频繁或配额受限，请重试。'
  }

  if (/overloaded/i.test(raw)) {
    return 'API 服务当前过载，请重试。'
  }

  if (/service unavailable/i.test(raw)) {
    return 'API 服务暂时不可用，请重试。'
  }

  if (isTransientNetworkErrorText(raw) || /network|fetch|socket|terminated|ECONNRESET/i.test(raw)) {
    return '网络连接异常：上游 API 连接中断，请重试。'
  }

  if (isMalformedResponseErrorText(raw)) {
    return '响应解析失败：上游返回了无法解析的响应，请重试。'
  }

  // 4. 如果已有规范结尾则保留
  if (
    raw.endsWith('建议开启新会话解决') ||
    raw.endsWith('建议开启新会话解决。') ||
    raw.endsWith('请重试') ||
    raw.endsWith('请重试。')
  ) {
    return raw
  }

  const sample = raw.length > MAX_ERROR_MESSAGE_LENGTH ? raw.slice(0, MAX_ERROR_MESSAGE_LENGTH) : raw
  return raw.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${sample}，请重试。\n\n[错误详情过长 (${(raw.length / 1024).toFixed(0)}KB)，已截断]`
    : `${sample}，请重试。`
}
