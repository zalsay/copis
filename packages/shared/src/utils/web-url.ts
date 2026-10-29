/**
 * 网页 URL 与地址栏输入规范化工具。
 *
 * 负责内嵌 Chromium 浏览器地址栏输入的协议补齐、本地服务识别、搜索转换与非法协议拦截。
 */

export const DEFAULT_WEB_TAB_URL = 'about:blank'
export const DEFAULT_WEB_SEARCH_URL = 'https://www.google.com/search?q='

/** 判断是否为受支持的网页协议（HTTP、HTTPS 或空白页）。 */
export function isAllowedWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) || url === DEFAULT_WEB_TAB_URL
}

/** 判断是否为本地地址（localhost、127.0.0.1、0.0.0.0、[::1]）。 */
export function isLocalWebAddress(value: string): boolean {
  return /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(:\d+)?(?:\/.*)?$/i.test(value.trim())
}

/**
 * 判断是否属于不受支持的协议 scheme（如 ftp://、file://、javascript:、data: 等）。
 *
 * 注意：必须排除域名或本地地址后接端口号（例如 localhost:3000、example.com:8080）。
 */
export function isUnsupportedScheme(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false

  // 已知合法的前缀
  if (/^https?:\/\//i.test(trimmed) || /^about:/i.test(trimmed)) {
    return false
  }

  // 明确的非法非分层伪协议
  if (/^(javascript|data|blob|file|mailto|tel):/i.test(trimmed)) {
    return true
  }

  // 明确的双斜杠协议 scheme://（且非 http/https）
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) {
    return true
  }

  // 冒号后接非数字字符（排除端口号如 host:3000）的未知 scheme
  if (/^[a-z][a-z\d+.-]*:(?!\d)/i.test(trimmed)) {
    return true
  }

  return false
}

/**
 * 判断是否应在失焦（blur）时自动补齐前缀。
 * 针对域名、本地主机或包含路径/端口的网址自动补齐，搜索关键词或已包含协议的内容不重复补齐。
 */
export function shouldAutocompleteWebUrl(input: string): boolean {
  const value = input.trim()
  if (!value) return false
  if (/^https?:\/\//i.test(value) || value.toLowerCase() === DEFAULT_WEB_TAB_URL) return false
  if (/\s/.test(value)) return false
  if (isUnsupportedScheme(value)) return false

  // 本地主机名或回环 IP
  if (isLocalWebAddress(value)) return true

  // 包含域名点分隔符、端口号或路径
  if (value.includes('.') || /:\d+/.test(value) || value.includes('/')) {
    return true
  }

  return false
}

/**
 * 将域名或输入内容补齐为包含协议前缀的完整地址。
 * 本地地址补齐 http://，常规域名/网址补齐 https://。
 */
export function autocompleteWebAddress(input: string): string {
  const value = input.trim()
  if (!value) return ''
  if (value.toLowerCase() === DEFAULT_WEB_TAB_URL) return DEFAULT_WEB_TAB_URL

  if (/^https?:\/\//i.test(value)) {
    return value
  }

  if (/\s/.test(value)) {
    return value
  }

  if (isLocalWebAddress(value)) {
    return `http://${value}`
  }

  if (isUnsupportedScheme(value)) {
    return value
  }

  return `https://${value}`
}

/**
 * 将地址栏输入转换成可导航的 HTTP(S) 地址（供主进程及前端提交时调用）。
 */
export function normalizeWebTabUrl(input: string): string {
  const value = input.trim()
  if (!value) return DEFAULT_WEB_TAB_URL
  if (value.toLowerCase() === DEFAULT_WEB_TAB_URL) return DEFAULT_WEB_TAB_URL

  if (/^https?:\/\//i.test(value)) {
    const parsed = new URL(value)
    if (!isAllowedWebUrl(parsed.toString())) {
      throw new Error('仅支持 HTTP 或 HTTPS 网页')
    }
    return parsed.toString()
  }

  if (/^about:/i.test(value)) {
    if (value.toLowerCase() === DEFAULT_WEB_TAB_URL) return DEFAULT_WEB_TAB_URL
    throw new Error('仅支持 about:blank')
  }

  if (isUnsupportedScheme(value)) {
    throw new Error('仅支持 HTTP 或 HTTPS 网页')
  }

  if (/\s/.test(value)) {
    return `${DEFAULT_WEB_SEARCH_URL}${encodeURIComponent(value)}`
  }

  if (isLocalWebAddress(value)) {
    return `http://${value}`
  }

  return `https://${value}`
}
