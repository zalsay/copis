/**
 * 瞬时网络错误模式
 *
 * 覆盖上游 API 偶发断流/抖动：API SSE 流中途 terminated、TCP 连接被重置、
 * DNS 抖动、fetch 层超时、连接被中止（undici "The operation was aborted" /
 * AbortError）、对端提前关闭等。这些错误无 HTTP 状态码，SDK HTTP 客户端层
 * 内置的重试无法完全消化时，会穿透到 Orchestrator 应用层兜底。
 * 命中此模式的错误会走「保留 resume 的自动重试」，不会清除 sdkSessionId（#903）。
 *
 * 同时覆盖 OpenAI/Anthropic provider 的流中断错误：
 * - "stream ended before a terminal [response] event"（OpenAI-compatible Responses API）
 * - "stream ended before message_stop"（Anthropic Messages API）
 * - "peer closed connection ... (incomplete chunked read)"（HTTP chunked/SSE 响应中断）
 * 这些都是 provider 连接被 CDN/网关切断的同类瞬时错误，与 ECONNRESET 性质一致。
 */
export const TRANSIENT_NETWORK_PATTERN =
  /terminated|socket hang up|ECONNRESET|ETIMEDOUT|ECONNABORTED|EPIPE|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|fetch failed|failed to fetch|network error|peer closed connection|connection (?:error|closed|reset)|other side closed|incomplete chunked read|AbortError|(?:operation|request) was aborted|(?:request )?timed out|stream (?:closed|ended|disconnected) prematurely|premature close|stream ended before (?:a )?(?:terminal(?: response)? event|message_stop)|net::ERR_|getaddrinfo/i

/** 判断错误消息/stderr 是否为瞬时网络错误 */
export function isTransientNetworkError(message?: string, stderr?: string): boolean {
  if (!message && !stderr) return false
  return (
    (!!message && TRANSIENT_NETWORK_PATTERN.test(message)) ||
    (!!stderr && TRANSIENT_NETWORK_PATTERN.test(stderr))
  )
}

/**
 * 判断错误是否为网络连接错误（如离线、断网、DNS 失败、拒绝连接、请求失败等）。
 * 深度检查 Error 本身、cause、code 以及典型网络错误模式。
 */
export function isNetworkError(error: unknown): boolean {
  if (!error) return false
  if (typeof error === 'string') {
    return (
      isTransientNetworkError(error) ||
      /fetch failed|failed to fetch|network error|offline|internet|getaddrinfo|enotfound|econnrefused|econnreset|etimedout|ehostunreach|enetunreach|net::err/i.test(error)
    )
  }

  const err = error as {
    name?: string
    message?: string
    stack?: string
    code?: string
    cause?: unknown
  }

  const parts: string[] = []
  if (err.name) parts.push(err.name)
  if (err.message) parts.push(err.message)
  if (err.code) parts.push(err.code)

  if (err.cause) {
    if (err.cause instanceof Error) {
      parts.push(err.cause.name, err.cause.message)
      if ('code' in err.cause && typeof err.cause.code === 'string') {
        parts.push(err.cause.code)
      }
    } else if (typeof err.cause === 'object' && err.cause !== null) {
      const causeObj = err.cause as { code?: string; message?: string; name?: string }
      if (causeObj.name) parts.push(causeObj.name)
      if (causeObj.code) parts.push(causeObj.code)
      if (causeObj.message) parts.push(causeObj.message)
    } else {
      parts.push(String(err.cause))
    }
  }

  const text = parts.join(' ')
  return (
    isTransientNetworkError(text) ||
    /fetch failed|failed to fetch|network error|offline|internet|getaddrinfo|enotfound|econnrefused|econnreset|etimedout|ehostunreach|enetunreach|net::err/i.test(text)
  )
}

/**
 * 上游响应体解析失败模式
 *
 * Agent SDK 将上游响应解析为 JSON 失败时抛出，
 * 典型形如 "API Error: JSON Parse error: Unable to parse JSON string"。
 * 成因多为网关返回 HTML 错误页、SSE 流被截断、代理注入脏数据等瞬时异常，
 * 与瞬时网络错误同属上游抖动，重试通常即可恢复。
 * 同时覆盖 V8 引擎措辞（Unexpected end of JSON input / is not valid JSON）和
 * JavaScriptCore 在完整 JSON 后收到脏数据时的 "Unexpected non-whitespace character after JSON"。
 */
export const MALFORMED_RESPONSE_PATTERN =
  /JSON Parse error|Unable to parse JSON|Unexpected end of JSON input|Unexpected token.*JSON|Unexpected non-whitespace character after JSON|is not valid JSON/i

/** 判断错误消息/stderr 是否为上游响应体解析失败 */
export function isMalformedResponseError(message?: string, stderr?: string): boolean {
  if (!message && !stderr) return false
  return (
    (!!message && MALFORMED_RESPONSE_PATTERN.test(message)) ||
    (!!stderr && MALFORMED_RESPONSE_PATTERN.test(stderr))
  )
}

/**
 * Agent resume 指向的会话不存在。
 *
 * 不同 provider 的错误文案不完全一致，常见形式包括：
 * - "No conversation found with session ID: ..."
 * - "No conversation found withsessionID: ..."
 * 第二种少了空格，不能依赖逐字匹配。
 */
export function isSessionNotFoundError(...messages: Array<string | undefined>): boolean {
  return messages.some((message) => {
    if (!message) return false
    const compact = message.replace(/\s+/g, '').toLowerCase()
    return /noconversationfound(?:with)?session(?:id)?/.test(compact)
  })
}
