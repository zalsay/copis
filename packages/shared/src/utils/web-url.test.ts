import { describe, expect, test } from 'bun:test'
import {
  autocompleteWebAddress,
  isAllowedWebUrl,
  isLocalWebAddress,
  isUnsupportedScheme,
  normalizeWebTabUrl,
  shouldAutocompleteWebUrl,
} from './web-url'

describe('网页 URL 与地址栏规范化工具', () => {
  describe('Given 地址栏输入普通域名 When 导航或补齐', () => {
    test('Then 自动补齐 https:// 前缀且不被错误拦截', () => {
      expect(normalizeWebTabUrl('baidu.com')).toBe('https://baidu.com')
      expect(normalizeWebTabUrl('www.google.com')).toBe('https://www.google.com')
      expect(normalizeWebTabUrl('github.com/trending')).toBe('https://github.com/trending')
      expect(normalizeWebTabUrl('news.ycombinator.com/item?id=123')).toBe('https://news.ycombinator.com/item?id=123')
      expect(normalizeWebTabUrl('a.co')).toBe('https://a.co')
      expect(normalizeWebTabUrl('vitejs.dev')).toBe('https://vitejs.dev')
    })

    test('Then autocompleteWebAddress 同样返回补齐后的 https:// 地址', () => {
      expect(autocompleteWebAddress('baidu.com')).toBe('https://baidu.com')
      expect(autocompleteWebAddress('www.bilibili.com')).toBe('https://www.bilibili.com')
      expect(autocompleteWebAddress('github.com/copis/copis')).toBe('https://github.com/copis/copis')
    })

    test('Then shouldAutocompleteWebUrl 识别其需要失焦补齐', () => {
      expect(shouldAutocompleteWebUrl('baidu.com')).toBe(true)
      expect(shouldAutocompleteWebUrl('www.baidu.com')).toBe(true)
      expect(shouldAutocompleteWebUrl('sub.domain.org/path')).toBe(true)
    })
  })

  describe('Given 地址栏输入带端口的域名 When 导航或补齐', () => {
    test('Then 补齐 https:// 且不会被误判为未知协议拦截', () => {
      expect(normalizeWebTabUrl('example.com:8080')).toBe('https://example.com:8080')
      expect(normalizeWebTabUrl('dev.company.org:8443/api')).toBe('https://dev.company.org:8443/api')
      expect(normalizeWebTabUrl('baidu.com:443')).toBe('https://baidu.com:443')
      expect(autocompleteWebAddress('example.com:8080')).toBe('https://example.com:8080')
      expect(shouldAutocompleteWebUrl('example.com:8080')).toBe(true)
    })
  })

  describe('Given 地址栏输入本地服务地址 When 导航或补齐', () => {
    test('Then 自动补齐 http:// 前缀且不被错误拦截', () => {
      expect(normalizeWebTabUrl('localhost:3000')).toBe('http://localhost:3000')
      expect(normalizeWebTabUrl('localhost:3000/app')).toBe('http://localhost:3000/app')
      expect(normalizeWebTabUrl('localhost')).toBe('http://localhost')
      expect(normalizeWebTabUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
      expect(normalizeWebTabUrl('127.0.0.1')).toBe('http://127.0.0.1')
      expect(normalizeWebTabUrl('0.0.0.0:5173')).toBe('http://0.0.0.0:5173')
      expect(normalizeWebTabUrl('[::1]:3000')).toBe('http://[::1]:3000')

      expect(autocompleteWebAddress('localhost:3000')).toBe('http://localhost:3000')
      expect(autocompleteWebAddress('127.0.0.1:5173')).toBe('http://127.0.0.1:5173')
      expect(shouldAutocompleteWebUrl('localhost:3000')).toBe(true)
      expect(shouldAutocompleteWebUrl('localhost')).toBe(true)
    })

    test('Then isLocalWebAddress 正确判定本地回环地址', () => {
      expect(isLocalWebAddress('localhost')).toBe(true)
      expect(isLocalWebAddress('localhost:5173')).toBe(true)
      expect(isLocalWebAddress('127.0.0.1:3000')).toBe(true)
      expect(isLocalWebAddress('0.0.0.0:8000')).toBe(true)
      expect(isLocalWebAddress('[::1]:8080')).toBe(true)
      expect(isLocalWebAddress('baidu.com')).toBe(false)
    })
  })

  describe('Given 地址栏已输入完整协议或 about:blank When 导航或补齐', () => {
    test('Then 保持原样导航且不重复补齐', () => {
      expect(normalizeWebTabUrl('https://example.com')).toBe('https://example.com/')
      expect(normalizeWebTabUrl('http://example.com/foo')).toBe('http://example.com/foo')
      expect(normalizeWebTabUrl('about:blank')).toBe('about:blank')
      expect(normalizeWebTabUrl('ABOUT:BLANK')).toBe('about:blank')

      expect(autocompleteWebAddress('https://example.com')).toBe('https://example.com')
      expect(autocompleteWebAddress('about:blank')).toBe('about:blank')
      expect(shouldAutocompleteWebUrl('https://example.com')).toBe(false)
      expect(shouldAutocompleteWebUrl('about:blank')).toBe(false)
    })
  })

  describe('Given 地址栏输入包含空格的内容 When 导航或补齐', () => {
    test('Then 导航时转为搜索引擎 URL', () => {
      expect(normalizeWebTabUrl('hello world')).toBe('https://www.google.com/search?q=hello%20world')
      expect(normalizeWebTabUrl('  copis agent  ')).toBe('https://www.google.com/search?q=copis%20agent')
    })

    test('Then 自动补齐或失焦时保留原搜索词不追加协议', () => {
      expect(autocompleteWebAddress('hello world')).toBe('hello world')
      expect(shouldAutocompleteWebUrl('hello world')).toBe(false)
    })
  })

  describe('Given 地址栏输入不受支持的协议 Scheme When 导航', () => {
    test('Then 准确拦截并抛出错误提示', () => {
      expect(() => normalizeWebTabUrl('ftp://ftp.example.com')).toThrow('仅支持 HTTP 或 HTTPS 网页')
      expect(() => normalizeWebTabUrl('file:///etc/hosts')).toThrow('仅支持 HTTP 或 HTTPS 网页')
      expect(() => normalizeWebTabUrl('javascript:alert(1)')).toThrow('仅支持 HTTP 或 HTTPS 网页')
      expect(() => normalizeWebTabUrl('data:text/html,<h1>test</h1>')).toThrow('仅支持 HTTP 或 HTTPS 网页')
      expect(() => normalizeWebTabUrl('chrome://settings')).toThrow('仅支持 HTTP 或 HTTPS 网页')
      expect(() => normalizeWebTabUrl('about:config')).toThrow('仅支持 about:blank')
    })

    test('Then isUnsupportedScheme 正确识别非法协议但排除端口', () => {
      expect(isUnsupportedScheme('ftp://test')).toBe(true)
      expect(isUnsupportedScheme('file:///path')).toBe(true)
      expect(isUnsupportedScheme('javascript:void(0)')).toBe(true)
      expect(isUnsupportedScheme('chrome://gpu')).toBe(true)
      expect(isUnsupportedScheme('data:application/json,{}')).toBe(true)

      // 冒号后接数字是端口，不是 scheme
      expect(isUnsupportedScheme('localhost:3000')).toBe(false)
      expect(isUnsupportedScheme('example.com:8080')).toBe(false)
      expect(isUnsupportedScheme('baidu.com')).toBe(false)
      expect(isUnsupportedScheme('https://baidu.com')).toBe(false)
      expect(isUnsupportedScheme('http://localhost:3000')).toBe(false)
    })
  })

  describe('Given 空白输入 When 导航或补齐', () => {
    test('Then 返回 about:blank 或空字符串', () => {
      expect(normalizeWebTabUrl('')).toBe('about:blank')
      expect(normalizeWebTabUrl('   ')).toBe('about:blank')
      expect(autocompleteWebAddress('')).toBe('')
      expect(autocompleteWebAddress('   ')).toBe('')
      expect(shouldAutocompleteWebUrl('')).toBe(false)
      expect(isAllowedWebUrl('about:blank')).toBe(true)
      expect(isAllowedWebUrl('https://example.com')).toBe(true)
      expect(isAllowedWebUrl('file:///tmp')).toBe(false)
    })
  })
})
