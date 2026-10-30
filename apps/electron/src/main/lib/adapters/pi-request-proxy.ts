/**
 * Pi runtime 的请求级 HTTP 代理。
 *
 * Pi 的程序化 SDK 不会执行 CLI 入口的 configureHttpDispatcher()。这里用
 * AsyncLocalStorage 为每次模型 provider stream 绑定 dispatcher，避免进程级环境变量
 * 或 setGlobalDispatcher() 在并发会话间串线。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import {
  Client,
  EnvHttpProxyAgent,
  Pool,
  fetch as undiciFetch,
  type Dispatcher,
  type RequestInfo,
  type RequestInit,
} from 'undici'

const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000

export interface PiRequestProxyOptions {
  proxyUrl?: string
  noProxy?: string
  httpIdleTimeoutMs?: number
}

const PI_PROXY_OPTIONS_KEY = Symbol('PI_PROXY_OPTIONS')

interface DispatcherWithProxyOptions extends Dispatcher {
  [PI_PROXY_OPTIONS_KEY]?: PiRequestProxyOptions
}

interface PiRequestProxyStore {
  dispatcher: Dispatcher
  proxyUrl?: string
  noProxy?: string
}

const requestDispatcherStorage = new AsyncLocalStorage<PiRequestProxyStore>()
const originalFetch = globalThis.fetch
const ignoreUndiciDispatcherError = (_error: Error): void => {}
let proxyFetchInstalled = false

export function shouldBypassProxy(urlStr: string, noProxy: string | undefined): boolean {
  if (!noProxy || !noProxy.trim()) return false
  try {
    const url = new URL(urlStr)
    const hostname = url.hostname.toLowerCase()
    const rules = noProxy.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
    for (const rule of rules) {
      if (rule === '*') return true
      const domainRule = rule.startsWith('.') ? rule.slice(1) : rule
      if (hostname === domainRule || hostname.endsWith(`.${domainRule}`)) {
        return true
      }
    }
    return false
  } catch {
    return false
  }
}

function withUndiciErrorListener<T extends Dispatcher>(dispatcher: T): T {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, 'error', ignoreUndiciDispatcherError)
  }
  return dispatcher
}

function createUndiciClient(origin: string | URL, options: Client.Options): Client {
  return withUndiciErrorListener(new Client(origin, options))
}

function createUndiciOriginDispatcher(origin: string | URL, options: Pool.Options): Dispatcher {
  if (options.connections === 1) {
    return createUndiciClient(origin, options)
  }
  return withUndiciErrorListener(new Pool(origin, {
    ...options,
    factory: createUndiciClient,
  }))
}

/** 在首次 Pi 请求前安装全局 fetch 路由；非 Pi 上下文仍调用 Copis 原 fetch。 */
export function installPiRequestProxyFetch(): void {
  if (proxyFetchInstalled) return
  proxyFetchInstalled = true

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const store = requestDispatcherStorage.getStore()
    if (!store) {
      return (originalFetch as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)(input, init)
    }

    // 在 Bun runtime（包括打包为独立自包含二进制的 copis CLI / Pi Worker）中，
    // 原生 fetch 原生支持 `{ proxy: proxyUrl }`。
    // undici fetch 在 Bun 下构建的纯 JS socket 隧道在父进程环境变量未注入代理时会触发 ECONNRESET。
    // 直接使用 Bun 原生 fetch 的 proxy 选项可百分之百稳定地通过代理访问。
    if (typeof Bun !== 'undefined' || Boolean(process.versions?.bun)) {
      if (store.proxyUrl) {
        const urlStr = typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url?: string }).url ?? ''
        if (!shouldBypassProxy(urlStr, store.noProxy)) {
          return (originalFetch as unknown as (input: RequestInfo | URL, init?: Record<string, unknown>) => Promise<Response>)(input, {
            ...(init as Record<string, unknown>),
            proxy: store.proxyUrl,
          })
        }
      }
      return (originalFetch as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)(input, init)
    }

    return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...init,
      dispatcher: store.dispatcher,
    } as Parameters<typeof undiciFetch>[1])
  }) as typeof globalThis.fetch
}

/**
 * 为单个 Pi 请求创建 dispatcher。调用者必须在请求结束时 close()，以释放连接池。
 */
export function createPiRequestProxyDispatcher(options: PiRequestProxyOptions): Dispatcher | undefined {
  const proxyUrl = options.proxyUrl?.trim()
  if (!proxyUrl) return undefined

  const timeoutMs = options.httpIdleTimeoutMs ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS
  const normalizedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0
  const defaultNoProxy = '127.0.0.1,localhost'
  const rawNoProxy = options.noProxy?.trim()
  const effectiveNoProxy = rawNoProxy
    ? (rawNoProxy.includes('127.0.0.1') ? rawNoProxy : `${rawNoProxy},${defaultNoProxy}`)
    : defaultNoProxy
  const dispatcher = withUndiciErrorListener(new EnvHttpProxyAgent({
    httpProxy: proxyUrl,
    httpsProxy: proxyUrl,
    noProxy: effectiveNoProxy,
    allowH2: false,
    headersTimeout: normalizedTimeoutMs,
    bodyTimeout: normalizedTimeoutMs,
    clientFactory: createUndiciClient,
    factory: createUndiciOriginDispatcher,
  })) as DispatcherWithProxyOptions

  dispatcher[PI_PROXY_OPTIONS_KEY] = {
    proxyUrl,
    noProxy: effectiveNoProxy,
    httpIdleTimeoutMs: normalizedTimeoutMs,
  }

  return dispatcher
}

/** 仅让当前异步链内的 Pi 网络请求使用其 dispatcher。 */
export function runWithPiRequestProxy<T>(dispatcher: Dispatcher | undefined, operation: () => T): T {
  if (!dispatcher) return operation()
  const options = (dispatcher as DispatcherWithProxyOptions)[PI_PROXY_OPTIONS_KEY]
  return requestDispatcherStorage.run({
    dispatcher,
    proxyUrl: options?.proxyUrl,
    noProxy: options?.noProxy,
  }, operation)
}

/** 用于测试及诊断：不会暴露或修改全局 dispatcher。 */
export function getPiRequestProxyDispatcher(): Dispatcher | undefined {
  return requestDispatcherStorage.getStore()?.dispatcher
}

export async function closePiRequestProxyDispatcher(dispatcher: Dispatcher | undefined): Promise<void> {
  const close = (dispatcher as (Dispatcher & { close?: () => Promise<void> }) | undefined)?.close
  if (!close) return
  await close.call(dispatcher).catch((error: unknown) => {
    console.warn('[Pi SDK] 关闭请求级代理 dispatcher 失败:', error)
  })
}
