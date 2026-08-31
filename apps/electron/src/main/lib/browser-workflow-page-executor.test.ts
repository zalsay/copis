import { describe, test, expect, beforeEach } from 'bun:test'
import type {
  BrowserAssertStep,
  BrowserClickStep,
  BrowserElementFingerprint,
  BrowserFillStep,
  BrowserLocatorBundle,
  BrowserNavigateStep,
  BrowserPressStep,
  BrowserSelectStep,
  BrowserWaitStep,
} from '@copis/shared'
import type { BrowserCdpMethod, BrowserPagePort } from './browser-page-port'
import {
  createBrowserWorkflowPageExecutor,
  buildLocatorEvaluationSource,
  type BrowserWorkflowPageRuntime,
  type BrowserWorkflowPageStepInput,
} from './browser-workflow-page-executor'

const ALLOWED_CDP_METHODS = new Set<BrowserCdpMethod>([
  'DOM.getBoxModel',
  'DOM.getFrameOwner',
  'DOM.setFileInputFiles',
  'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent',
  'Input.insertText',
  'Page.addScriptToEvaluateOnNewDocument',
  'Page.captureScreenshot',
  'Page.createIsolatedWorld',
  'Page.enable',
  'Page.getFrameTree',
  'Page.handleJavaScriptDialog',
  'Page.removeScriptToEvaluateOnNewDocument',
  'Runtime.addBinding',
  'Runtime.enable',
  'Runtime.evaluate',
  'Runtime.releaseObject',
  'Runtime.removeBinding',
])

interface FakeTabState {
  id: string
  url: string
  title: string
  isLoading: boolean
}

function createFakeRuntime(tab?: Partial<FakeTabState>) {
  const currentTab: FakeTabState = {
    id: 'tab-1',
    url: 'https://example.com/app',
    title: 'Example App',
    isLoading: false,
    ...tab,
  }

  const navigateCalls: Array<{ tabId: string; url: string }> = []
  const waitForLoadCalls: Array<{ tabId: string; timeoutMs: number }> = []

  const runtime: BrowserWorkflowPageRuntime = {
    getTab(tabId: string) {
      if (tabId === currentTab.id) {
        return { ...currentTab }
      }
      return undefined
    },
    navigate(tabId: string, url: string) {
      navigateCalls.push({ tabId, url })
      currentTab.url = url
    },
    async waitForLoad(tabId: string, timeoutMs: number, signal: AbortSignal) {
      waitForLoadCalls.push({ tabId, timeoutMs })
      if (signal.aborted) {
        throw new Error('Browser Workflow 已取消')
      }
      currentTab.isLoading = false
    },
  }

  return {
    runtime,
    currentTab,
    navigateCalls,
    waitForLoadCalls,
  }
}

interface FakePortOptions {
  onEvaluate?: (expression: string) => unknown
  onSend?: (method: BrowserCdpMethod, params?: Record<string, unknown>) => unknown
}

function createFakePort(options: FakePortOptions = {}) {
  const sentCalls: Array<{ method: BrowserCdpMethod; params?: Record<string, unknown> }> = []
  let sendCountAfterAbort = 0
  let isAborted = false

  const port: BrowserPagePort = {
    tabId: 'tab-1',
    owner: 'workflow',
    generation: 1,
    documentEpoch: 1,
    getSnapshot() {
      return {
        kind: 'untrusted_browser_page',
        instruction: '',
        url: 'https://example.com/app',
        title: 'Example App',
        text: '',
        elements: [],
        scrollX: 0,
        scrollY: 0,
        viewportWidth: 1280,
        viewportHeight: 800,
        documentWidth: 1280,
        documentHeight: 800,
      }
    },
    async send(method: BrowserCdpMethod, params?: Record<string, unknown>) {
      if (isAborted) {
        sendCountAfterAbort += 1
      }
      sentCalls.push({ method, params })

      if (options.onSend) {
        const customSendResult = options.onSend(method, params)
        if (customSendResult !== undefined) {
          return customSendResult
        }
      }

      if (method === 'Runtime.evaluate') {
        const expression = String(params?.expression || '')
        if (options.onEvaluate) {
          const customResult = options.onEvaluate(expression)
          if (customResult !== undefined) {
            return customResult
          }
        }
        return {
          result: {
            value: {
              status: 'found',
              strategyIndex: 0,
              point: { x: 100, y: 200 },
              tagName: 'button',
              enabled: true,
              visible: true,
            },
          },
        }
      }

      return {}
    },
    onMessage: () => () => {},
    onDetached: () => () => {},
    onDestroyed: () => () => {},
    release: () => {},
  }

  return {
    port,
    sentCalls,
    get sendCountAfterAbort() {
      return sendCountAfterAbort
    },
    markAborted() {
      isAborted = true
    },
  }
}

function createLocatorBundle(overrides: Partial<BrowserLocatorBundle> = {}): BrowserLocatorBundle {
  const fingerprint: BrowserElementFingerprint = {
    tagName: 'button',
    visible: true,
    enabled: true,
    accessibleName: '提交',
    ...(overrides.fingerprint || {}),
  }

  return {
    framePath: { frameIds: ['main'] },
    strategies: [
      { kind: 'testId', attribute: 'data-testid', value: 'submit-btn' },
      { kind: 'role', role: 'button', name: '提交' },
    ],
    fingerprint,
    ...overrides,
  }
}

describe('BrowserWorkflowPageExecutor 确定性页面执行器', () => {
  let fakeRuntime: ReturnType<typeof createFakeRuntime>
  let fakePort: ReturnType<typeof createFakePort>
  let abortController: AbortController

  function createStepInput(
    step: BrowserWorkflowPageStepInput['step'],
    overrides: Partial<BrowserWorkflowPageStepInput> = {},
  ): BrowserWorkflowPageStepInput {
    return {
      step,
      tabId: 'tab-1',
      port: fakePort.port,
      allowedOrigins: ['https://example.com'],
      variables: {},
      signal: abortController.signal,
      ...overrides,
    }
  }

  beforeEach(() => {
    fakeRuntime = createFakeRuntime()
    fakePort = createFakePort()
    abortController = new AbortController()
  })

  // 1. 完整 Fingerprint 校验与 Fallback 判定
  describe('1. 完整 Fingerprint 校验与 Fallback', () => {
    test('Given 首选 locator 无匹配且第二策略唯一 When click Then 标记 fallbackUsed 为 true', async () => {
      fakePort = createFakePort({
        onEvaluate: () => ({
          result: {
            value: {
              status: 'found',
              strategyIndex: 1,
              point: { x: 150, y: 250 },
              tagName: 'button',
              enabled: true,
              visible: true,
            },
          },
        }),
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserClickStep = {
        id: 'step-click-fallback',
        type: 'click',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle(),
      }
      const result = await executor.execute(createStepInput(step))
      expect(result.fallbackUsed).toBe(true)
      expect(fakePort.sentCalls.some((c) => c.method === 'Input.dispatchMouseEvent')).toBe(true)
    })

    test('Given 首选 locator 唯一定位成功 When click Then fallbackUsed 为 false', async () => {
      fakePort = createFakePort({
        onEvaluate: () => ({
          result: {
            value: {
              status: 'found',
              strategyIndex: 0,
              point: { x: 100, y: 200 },
              tagName: 'button',
              enabled: true,
              visible: true,
            },
          },
        }),
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserClickStep = {
        id: 'step-click-primary',
        type: 'click',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle(),
      }
      const result = await executor.execute(createStepInput(step))
      expect(result.fallbackUsed).toBe(false)
    })

    test('Given locator 匹配到多个可见候选元素 When execute Then 抛出包含 AMBIGUOUS_TARGET 的错误', async () => {
      fakePort = createFakePort({
        onEvaluate: () => ({
          result: {
            value: {
              status: 'ambiguous',
              strategyIndex: 0,
              count: 2,
            },
          },
        }),
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserClickStep = {
        id: 'step-click-ambiguous',
        type: 'click',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle(),
      }

      await expect(executor.execute(createStepInput(step))).rejects.toThrow('AMBIGUOUS_TARGET')
    })

    test('Given 所有策略均无匹配候选 When execute Then 抛出清晰中文错误', async () => {
      fakePort = createFakePort({
        onEvaluate: () => ({
          result: {
            value: {
              status: 'not_found',
            },
          },
        }),
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserClickStep = {
        id: 'step-click-not-found',
        type: 'click',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle(),
      }

      await expect(executor.execute(createStepInput(step))).rejects.toThrow('未找到匹配的')
    })

    // Fingerprint 逐项比对 Table Tests（在模拟 DOM 中直接运行生成的固定脚本）
    const fingerprintMismatchCases: Array<{
      desc: string
      fingerprint: BrowserElementFingerprint
      domElement: {
        tagName: string
        type?: string
        accessibleName?: string
        disabled?: boolean
        visible?: boolean
      }
    }> = [
      {
        desc: 'tagName 不匹配（期望 button，实际 a）',
        fingerprint: { tagName: 'button', visible: true, enabled: true },
        domElement: { tagName: 'A', visible: true, disabled: false },
      },
      {
        desc: 'inputType 不匹配（期望 text，实际 radio）',
        fingerprint: { tagName: 'input', inputType: 'text', visible: true, enabled: true },
        domElement: { tagName: 'INPUT', type: 'radio', visible: true, disabled: false },
      },
      {
        desc: 'accessibleName 不匹配（期望“保存”，实际“取消”）',
        fingerprint: { tagName: 'button', accessibleName: '保存', visible: true, enabled: true },
        domElement: { tagName: 'BUTTON', accessibleName: '取消', visible: true, disabled: false },
      },
      {
        desc: 'enabled 状态不匹配（期望 enabled: true，实际 disabled: true）',
        fingerprint: { tagName: 'button', visible: true, enabled: true },
        domElement: { tagName: 'BUTTON', visible: true, disabled: true },
      },
    ]

    for (const c of fingerprintMismatchCases) {
      test(`Given 脚本执行环境中元素 ${c.desc} When 执行 locator 脚本 Then 跳过该策略并报告未找到`, () => {
        const bundle: BrowserLocatorBundle = {
          framePath: { frameIds: ['main'] },
          strategies: [{ kind: 'css', value: '.candidate' }],
          fingerprint: c.fingerprint,
        }

        const source = buildLocatorEvaluationSource({ bundle, action: 'locate' })

        // 构造最小 DOM 环境执行 source 脚本
        const mockTarget = {
          tagName: c.domElement.tagName,
          type: c.domElement.type || 'text',
          disabled: Boolean(c.domElement.disabled),
          isConnected: true,
          getAttribute: (name: string) => (name === 'aria-label' ? c.domElement.accessibleName || null : null),
          getBoundingClientRect: () => ({ width: 100, height: 40, left: 10, top: 20 }),
          scrollIntoView: () => {},
          focus: () => {},
        }

        const mockDoc = {
          querySelectorAll: () => [mockTarget],
          getElementById: () => null,
        }

        const mockWindow = {
          getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
        }

        const runner = new Function('document', 'window', `return ${source}`)
        const evalResult = runner(mockDoc, mockWindow)

        expect(evalResult.status).toBe('not_found')
      })
    }
  })

  // 2. 页面副作用前完成安全校验
  describe('2. 副作用前严格安全校验（零预先 Mutation / Focus / Scroll）', () => {
    test('Given disabled 状态的 select 元素 When 执行 select evaluate 脚本 Then 不发生 scroll/focus/selectedIndex 修改或事件派发', () => {
      let scrollCalls = 0
      let focusCalls = 0
      let dispatchCalls = 0
      let selectedIndexVal = 0

      const mockSelect = {
        tagName: 'SELECT',
        disabled: true, // 已禁用
        isConnected: true,
        options: [{ value: 'opt1', textContent: '选项 1' }, { value: 'opt2', textContent: '选项 2' }],
        get selectedIndex() {
          return selectedIndexVal
        },
        set selectedIndex(v: number) {
          selectedIndexVal = v
        },
        getAttribute: () => null,
        getBoundingClientRect: () => ({ width: 100, height: 30, left: 10, top: 10 }),
        scrollIntoView: () => {
          scrollCalls++
        },
        focus: () => {
          focusCalls++
        },
        dispatchEvent: () => {
          dispatchCalls++
          return true
        },
      }

      const bundle: BrowserLocatorBundle = {
        framePath: { frameIds: ['main'] },
        strategies: [{ kind: 'css', value: 'select' }],
        fingerprint: { tagName: 'select', visible: true, enabled: false },
      }

      const source = buildLocatorEvaluationSource({ bundle, action: 'select', selectValue: 'opt2' })
      const mockDoc = { querySelectorAll: () => [mockSelect], getElementById: () => null }
      const mockWindow = { getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }) }

      const runner = new Function('document', 'window', `return ${source}`)
      const evalResult = runner(mockDoc, mockWindow)

      expect(evalResult.enabled).toBe(false)
      // 关键安全断言：副作用必须为 0
      expect(scrollCalls).toBe(0)
      expect(focusCalls).toBe(0)
      expect(dispatchCalls).toBe(0)
      expect(selectedIndexVal).toBe(0)
    })

    test('Given 敏感 password 输入框 When 执行 fill evaluate 脚本 Then 不发生 scrollIntoView 或 focus', () => {
      let scrollCalls = 0
      let focusCalls = 0

      const mockInput = {
        tagName: 'INPUT',
        type: 'password', // 敏感密码
        disabled: false,
        isConnected: true,
        id: 'pwd-input',
        getAttribute: (name: string) => (name === 'type' ? 'password' : null),
        getBoundingClientRect: () => ({ width: 100, height: 30, left: 10, top: 10 }),
        scrollIntoView: () => {
          scrollCalls++
        },
        focus: () => {
          focusCalls++
        },
      }

      const bundle: BrowserLocatorBundle = {
        framePath: { frameIds: ['main'] },
        strategies: [{ kind: 'css', value: '#pwd-input' }],
        fingerprint: { tagName: 'input', inputType: 'password', visible: true, enabled: true },
      }

      const source = buildLocatorEvaluationSource({ bundle, action: 'fill' })
      const mockDoc = { querySelectorAll: () => [mockInput], getElementById: () => null }
      const mockWindow = { getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }) }

      const runner = new Function('document', 'window', `return ${source}`)
      const evalResult = runner(mockDoc, mockWindow)

      expect(evalResult.sensitiveReason).toBe('password')
      expect(scrollCalls).toBe(0)
      expect(focusCalls).toBe(0)
    })

    test('Given locate / visible / hidden 只读查询 When 执行普通 strategy evaluate 脚本 Then 成功定位时不得发生 scrollIntoView 或 focus', () => {
      let scrollCalls = 0
      let focusCalls = 0

      const mockBtn = {
        tagName: 'BUTTON',
        disabled: false,
        isConnected: true,
        getAttribute: (name: string) => (name === 'aria-label' ? '查询按钮' : null),
        getBoundingClientRect: () => ({ width: 100, height: 30, left: 10, top: 10 }),
        scrollIntoView: () => {
          scrollCalls++
        },
        focus: () => {
          focusCalls++
        },
      }

      const bundle: BrowserLocatorBundle = {
        framePath: { frameIds: ['main'] },
        strategies: [{ kind: 'css', value: 'button' }],
        fingerprint: { tagName: 'button', accessibleName: '查询按钮', visible: true, enabled: true },
      }

      for (const readonlyAction of ['locate', 'visible', 'hidden'] as const) {
        scrollCalls = 0
        focusCalls = 0
        const source = buildLocatorEvaluationSource({ bundle, action: readonlyAction })
        const mockDoc = { querySelectorAll: () => [mockBtn], getElementById: () => null }
        const mockWindow = { getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }) }

        const runner = new Function('document', 'window', `return ${source}`)
        const evalResult = runner(mockDoc, mockWindow)

        expect(evalResult.status).toBe('found')
        // 只读查询不得有副作用
        expect(scrollCalls).toBe(0)
        expect(focusCalls).toBe(0)
      }
    })

    test('Given locate / visible / hidden 只读查询 When 执行 anchor href fallback evaluate 脚本 Then 成功定位时不得发生 scrollIntoView 或 focus', () => {
      let scrollCalls = 0
      let focusCalls = 0

      const mockAnchor = {
        tagName: 'A',
        href: 'https://example.com/details',
        disabled: false,
        isConnected: true,
        getAttribute: (name: string) => (name === 'href' ? 'https://example.com/details' : name === 'aria-label' ? '详情' : null),
        getBoundingClientRect: () => ({ width: 100, height: 30, left: 10, top: 10 }),
        scrollIntoView: () => {
          scrollCalls++
        },
        focus: () => {
          focusCalls++
        },
      }

      const bundle: BrowserLocatorBundle = {
        framePath: { frameIds: ['main'] },
        strategies: [{ kind: 'css', value: '.non-existent' }],
        fingerprint: { tagName: 'a', href: 'https://example.com/details', accessibleName: '详情', visible: true, enabled: true },
      }

      for (const readonlyAction of ['locate', 'visible', 'hidden'] as const) {
        scrollCalls = 0
        focusCalls = 0
        const source = buildLocatorEvaluationSource({ bundle, action: readonlyAction })
        const mockDoc = { querySelectorAll: (sel: string) => (sel === 'a[href]' ? [mockAnchor] : []), getElementById: () => null }
        const mockWindow = { getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }) }

        const runner = new Function('document', 'window', `return ${source}`)
        const evalResult = runner(mockDoc, mockWindow)

        expect(evalResult.status).toBe('found')
        expect(evalResult.isHrefFallback).toBe(true)
        expect(scrollCalls).toBe(0)
        expect(focusCalls).toBe(0)
      }
    })

    test('Given anchor href fallback 的 candidate 与 fingerprint 不匹配 (accessibleName 不符) When 执行 evaluate Then 返回 not_found', () => {
      const mockAnchor = {
        tagName: 'A',
        href: 'https://example.com/login',
        disabled: false,
        isConnected: true,
        getAttribute: (name: string) => (name === 'href' ? 'https://example.com/login' : name === 'aria-label' ? '登录' : null),
        getBoundingClientRect: () => ({ width: 100, height: 30, left: 10, top: 10 }),
      }

      const bundle: BrowserLocatorBundle = {
        framePath: { frameIds: ['main'] },
        strategies: [{ kind: 'css', value: '.non-existent' }],
        // 指纹期望 accessibleName 为“关于我们”，但页面实际为“登录”
        fingerprint: { tagName: 'a', href: 'https://example.com/login', accessibleName: '关于我们', visible: true, enabled: true },
      }

      const source = buildLocatorEvaluationSource({ bundle, action: 'click' })
      const mockDoc = { querySelectorAll: (sel: string) => (sel === 'a[href]' ? [mockAnchor] : []), getElementById: () => null }
      const mockWindow = { getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }) }

      const runner = new Function('document', 'window', `return ${source}`)
      const evalResult = runner(mockDoc, mockWindow)

      expect(evalResult.status).toBe('not_found')
    })
  })

  // 3. visible wait / click expect.visible / assert visible 快速失败（非 not_found 立即抛错）
  describe('3. 预期与断言快速失败机制', () => {
    test('Given visible wait 遇到 AMBIGUOUS_TARGET When execute Then 立即抛出错误而不是轮询直到超时', async () => {
      let evalCalls = 0
      fakePort = createFakePort({
        onEvaluate: () => {
          evalCalls++
          return {
            result: {
              value: {
                status: 'ambiguous',
                strategyIndex: 0,
                count: 3,
              },
            },
          }
        },
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserWaitStep = {
        id: 'step-wait-ambiguous',
        type: 'wait',
        tabAlias: 'main',
        origin: 'https://example.com',
        condition: { type: 'visible', target: createLocatorBundle() },
        timeoutMs: 5000,
      }

      const startTime = Date.now()
      await expect(executor.execute(createStepInput(step))).rejects.toThrow('AMBIGUOUS_TARGET')
      const elapsed = Date.now() - startTime
      expect(elapsed).toBeLessThan(1000) // 快速失败，不用等待 5000ms timeout
      expect(evalCalls).toBe(1) // 第一次遇到歧义立即失败，不反复轮询
    })

    test('Given assert hidden 遇到 AMBIGUOUS_TARGET When execute Then 立即失败', async () => {
      fakePort = createFakePort({
        onEvaluate: () => ({
          result: {
            value: {
              status: 'ambiguous',
              count: 2,
            },
          },
        }),
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserAssertStep = {
        id: 'step-assert-hidden-ambiguous',
        type: 'assert',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle(),
        condition: { type: 'hidden' },
        timeoutMs: 5000,
      }

      const startTime = Date.now()
      await expect(executor.execute(createStepInput(step))).rejects.toThrow('AMBIGUOUS_TARGET')
      const elapsed = Date.now() - startTime
      expect(elapsed).toBeLessThan(1000)
    })

    test('Given wait text 遇到 CDP exceptionDetails When execute Then 立即抛出页面脚本执行异常而非轮询到超时', async () => {
      let evalCalls = 0
      fakePort = createFakePort({
        onEvaluate: () => {
          evalCalls++
          return {
            exceptionDetails: {
              text: 'Uncaught Error: Security error on body read',
            },
          }
        },
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserWaitStep = {
        id: 'step-wait-text-error',
        type: 'wait',
        tabAlias: 'main',
        origin: 'https://example.com',
        condition: { type: 'text', value: '欢迎' },
        timeoutMs: 5000,
      }

      const startTime = Date.now()
      await expect(executor.execute(createStepInput(step))).rejects.toThrow('页面脚本执行异常')
      const elapsed = Date.now() - startTime
      expect(elapsed).toBeLessThan(1000)
      expect(evalCalls).toBe(1)
    })

    test('Given assert text 遇到 CDP exceptionDetails When execute Then 立即抛出页面脚本执行异常而非轮询到超时', async () => {
      let evalCalls = 0
      fakePort = createFakePort({
        onEvaluate: () => {
          evalCalls++
          return {
            exceptionDetails: {
              text: 'Uncaught TypeError: body is null',
            },
          }
        },
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserAssertStep = {
        id: 'step-assert-text-error',
        type: 'assert',
        tabAlias: 'main',
        origin: 'https://example.com',
        condition: { type: 'text', value: '欢迎', exact: false },
        timeoutMs: 5000,
      }

      const startTime = Date.now()
      await expect(executor.execute(createStepInput(step))).rejects.toThrow('页面脚本执行异常')
      const elapsed = Date.now() - startTime
      expect(elapsed).toBeLessThan(1000)
      expect(evalCalls).toBe(1)
    })

    test('Given assert hidden 遇到损坏的 CDP 响应 (缺少 result) When execute Then 立即抛出错误而非轮询到超时', async () => {
      fakePort = createFakePort({
        onEvaluate: () => ({
          // 缺少 result
        }),
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserAssertStep = {
        id: 'step-assert-hidden-malformed',
        type: 'assert',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle(),
        condition: { type: 'hidden' },
        timeoutMs: 5000,
      }

      const startTime = Date.now()
      await expect(executor.execute(createStepInput(step))).rejects.toThrow('CDP 评估结果缺失')
      const elapsed = Date.now() - startTime
      expect(elapsed).toBeLessThan(1000)
    })

    test('Given assert hidden 遇到未知 status When execute Then 立即抛出页面定位返回未知状态而非轮询到超时', async () => {
      fakePort = createFakePort({
        onEvaluate: () => ({
          result: {
            value: {
              status: 'unexpected_custom_status',
            },
          },
        }),
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserAssertStep = {
        id: 'step-assert-hidden-unknown-status',
        type: 'assert',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle(),
        condition: { type: 'hidden' },
        timeoutMs: 5000,
      }

      const startTime = Date.now()
      await expect(executor.execute(createStepInput(step))).rejects.toThrow('页面定位返回未知状态')
      const elapsed = Date.now() - startTime
      expect(elapsed).toBeLessThan(1000)
    })
  })

  // 4. URL Pattern 校验与单次编译
  describe('4. URL Pattern 正则校验与错误区分', () => {
    test('Given 合法正则但页面 URL 不匹配 When execute Then 抛出“不匹配”错误而非“无效正则”', async () => {
      fakeRuntime.currentTab.url = 'https://example.com/other-path'
      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserClickStep = {
        id: 'step-pattern-mismatch',
        type: 'click',
        tabAlias: 'main',
        origin: 'https://example.com',
        urlPattern: '^https://example.com/checkout$',
        target: createLocatorBundle(),
      }

      await expect(executor.execute(createStepInput(step))).rejects.toThrow('页面 URL 不匹配规则')
    })

    test('Given 语法损坏的正则表达式 When execute Then 抛出“无效的 URL 匹配规则”', async () => {
      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserClickStep = {
        id: 'step-pattern-invalid',
        type: 'click',
        tabAlias: 'main',
        origin: 'https://example.com',
        urlPattern: '[unclosed-regex',
        target: createLocatorBundle(),
      }

      await expect(executor.execute(createStepInput(step))).rejects.toThrow('无效的 URL 匹配规则')
    })
  })

  // 5. 导航与轮询期间的 Origin 边界持续检查（防跨域 Redirect）
  describe('5. 导航与轮询期间的 Origin 边界持续检查', () => {
    test('Given navigate 在 waitForLoad 后重定向到 evil.com When execute Then 立即拒绝', async () => {
      const customRuntime = createFakeRuntime()
      customRuntime.runtime.waitForLoad = async () => {
        customRuntime.currentTab.url = 'https://evil.com/phishing'
      }

      const executor = createBrowserWorkflowPageExecutor(customRuntime.runtime)
      const step: BrowserNavigateStep = {
        id: 'step-nav-redirect',
        type: 'navigate',
        tabAlias: 'main',
        origin: 'https://example.com',
        url: 'https://example.com/start-login',
      }

      await expect(executor.execute(createStepInput(step))).rejects.toThrow('页面 Origin 不在 Workflow 白名单内')
    })

    test('Given wait text 轮询期间页面跳转到未授权 Origin When execute Then 立即终止轮询并不再向新 Origin 发送 CDP evaluate', async () => {
      let evalCalls = 0
      fakePort = createFakePort({
        onEvaluate: () => {
          evalCalls++
          // 第一次调用后模拟外部页面跳至 evil.com
          fakeRuntime.currentTab.url = 'https://evil.com/redirected'
          return { result: { value: '载入中...' } }
        },
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserWaitStep = {
        id: 'step-wait-redirect',
        type: 'wait',
        tabAlias: 'main',
        origin: 'https://example.com',
        condition: { type: 'text', value: '目标文本' },
        timeoutMs: 5000,
      }

      await expect(executor.execute(createStepInput(step))).rejects.toThrow('页面 Origin 不在 Workflow 白名单内')
      expect(evalCalls).toBe(1) // 第二轮在发送 evaluate 前就被 Origin 校验拦截
    })
  })

  // 6. 坐标有限性与范围校验
  describe('6. 页面元素坐标校验', () => {
    const invalidPoints = [
      { desc: '负数坐标 x', point: { x: -10, y: 100 } },
      { desc: 'NaN 坐标', point: { x: NaN, y: 100 } },
      { desc: '超大越界坐标', point: { x: 200_000, y: 100 } },
    ]

    for (const item of invalidPoints) {
      test(`Given 定位结果包含 ${item.desc} When click Then 拒绝派发并抛出坐标无效`, async () => {
        fakePort = createFakePort({
          onEvaluate: () => ({
            result: {
              value: {
                status: 'found',
                strategyIndex: 0,
                point: item.point,
                tagName: 'button',
                enabled: true,
                visible: true,
              },
            },
          }),
        })

        const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
        const step: BrowserClickStep = {
          id: `step-click-point-${item.desc}`,
          type: 'click',
          tabAlias: 'main',
          origin: 'https://example.com',
          target: createLocatorBundle(),
        }

        await expect(executor.execute(createStepInput(step))).rejects.toThrow('坐标无效')
      })
    }
  })

  // 7. 字段长度与前置校验
  describe('7. 字段长度限制与前置拒绝', () => {
    test('Given select 步骤传入超长选择值 (> 500 字符) When execute Then 在 Runtime.evaluate 前拒绝', async () => {
      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserSelectStep = {
        id: 'step-select-too-long',
        type: 'select',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle(),
        value: { kind: 'literal', value: 'a'.repeat(501) },
      }

      await expect(executor.execute(createStepInput(step))).rejects.toThrow('500')
      expect(fakePort.sentCalls.length).toBe(0) // 前置拦截，零 CDP 发送
    })

    test('Given fill 步骤传入超长值 (> 10000 字符) When execute Then 在 Runtime.evaluate 前拒绝', async () => {
      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserFillStep = {
        id: 'step-fill-too-long',
        type: 'fill',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle(),
        value: { kind: 'literal', value: 'a'.repeat(10_001) },
      }

      await expect(executor.execute(createStepInput(step))).rejects.toThrow('10000')
      expect(fakePort.sentCalls.length).toBe(0)
    })
  })

  // 8. 真实 CDP 执行后的 Abort 与零残留 Send 测试
  describe('8. 真实 Abort 取消与静默窗口验证', () => {
    test('Given wait text 正在执行 CDP 轮询 When 中途 signal abort Then 立即退出且在观察窗口内零新增 send', async () => {
      let evalCallsBeforeAbort = 0

      fakePort = createFakePort({
        onEvaluate: () => {
          evalCallsBeforeAbort++
          return { result: { value: '仍然在加载中...' } }
        },
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserWaitStep = {
        id: 'step-wait-abort-real',
        type: 'wait',
        tabAlias: 'main',
        origin: 'https://example.com',
        condition: { type: 'text', value: '成功' },
        timeoutMs: 10_000,
      }
      const executionPromise = executor.execute(createStepInput(step))

      // 等待确保至少发生了一次 CDP evaluate
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(evalCallsBeforeAbort).toBeGreaterThanOrEqual(1)

      // 触发取消并标记
      fakePort.markAborted()
      abortController.abort()

      await expect(executionPromise).rejects.toThrow('Browser Workflow 已取消')

      // 等待超过 2 个轮询周期（250ms），验证不再有任何新增 CDP send
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(fakePort.sendCountAfterAbort).toBe(0)
    })
  })

  // 9. 六类敏感字段拒绝安全防护（针对 Fingerprint 与运行时返回）
  describe('9. 六类敏感字段安全防护', () => {
    const sensitiveCases: Array<{ reason: string; fingerprint: Partial<BrowserElementFingerprint> }> = [
      { reason: 'password', fingerprint: { tagName: 'input', inputType: 'password', accessibleName: '密码' } },
      { reason: 'otp', fingerprint: { tagName: 'input', inputType: 'text', accessibleName: '短信验证码' } },
      { reason: 'payment', fingerprint: { tagName: 'input', inputType: 'text', accessibleName: '信用卡号' } },
      { reason: 'file', fingerprint: { tagName: 'input', inputType: 'file', accessibleName: '上传附件' } },
      { reason: 'captcha', fingerprint: { tagName: 'input', inputType: 'text', accessibleName: '人机图形验证码' } },
      { reason: 'secret', fingerprint: { tagName: 'input', inputType: 'text', accessibleName: 'API Key 密钥' } },
    ]

    for (const item of sensitiveCases) {
      test(`Given ${item.reason} 敏感字段 (fingerprint) When 自动 fill Then 拒绝并抛出“Workflow 不允许自动填写敏感字段”`, async () => {
        const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
        const step: BrowserFillStep = {
          id: `step-fill-sensitive-${item.reason}`,
          type: 'fill',
          tabAlias: 'main',
          origin: 'https://example.com',
          target: createLocatorBundle({ fingerprint: item.fingerprint as BrowserElementFingerprint }),
          value: { kind: 'literal', value: 'secret123' },
        }

        await expect(executor.execute(createStepInput(step))).rejects.toThrow('Workflow 不允许自动填写敏感字段')
      })

      test(`Given ${item.reason} 敏感字段 (fingerprint) When 自动 select Then 拒绝并抛出“Workflow 不允许自动填写敏感字段”`, async () => {
        const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
        const step: BrowserSelectStep = {
          id: `step-select-sensitive-${item.reason}`,
          type: 'select',
          tabAlias: 'main',
          origin: 'https://example.com',
          target: createLocatorBundle({ fingerprint: item.fingerprint as BrowserElementFingerprint }),
          value: { kind: 'literal', value: 'opt1' },
        }

        await expect(executor.execute(createStepInput(step))).rejects.toThrow('Workflow 不允许自动填写敏感字段')
      })
    }
  })

  // 10. 各类 Step 执行及仅调用白名单 CDP 方法
  describe('10. 各类步骤执行与 CDP Method 白名单校验', () => {
    test('Given navigate step When execute Then 调用 runtime.navigate 并通过白名单检查', async () => {
      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserNavigateStep = {
        id: 'step-nav',
        type: 'navigate',
        tabAlias: 'main',
        origin: 'https://example.com',
        url: 'https://example.com/dashboard',
      }
      const result = await executor.execute(createStepInput(step))
      expect(result).toEqual({ fallbackUsed: false })
      expect(fakeRuntime.navigateCalls).toEqual([{ tabId: 'tab-1', url: 'https://example.com/dashboard' }])
      expect(fakeRuntime.waitForLoadCalls.length).toBe(1)
      expect(fakePort.sentCalls.every((c) => ALLOWED_CDP_METHODS.has(c.method))).toBe(true)
    })

    test('Given click step When execute Then 派发 mousePressed 和 mouseReleased', async () => {
      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserClickStep = {
        id: 'step-click',
        type: 'click',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle(),
      }
      const result = await executor.execute(createStepInput(step))
      expect(result).toEqual({ fallbackUsed: false })
      const mouseEvents = fakePort.sentCalls.filter((c) => c.method === 'Input.dispatchMouseEvent')
      expect(mouseEvents.length).toBe(2)
      expect(mouseEvents[0]!.params?.type).toBe('mousePressed')
      expect(mouseEvents[1]!.params?.type).toBe('mouseReleased')
      expect(fakePort.sentCalls.every((c) => ALLOWED_CDP_METHODS.has(c.method))).toBe(true)
    })

    test('Given click with newTab expectation When execute Then 返回 expectsNewTabAlias', async () => {
      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserClickStep = {
        id: 'step-click-newtab',
        type: 'click',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle(),
        expect: { type: 'newTab', tabAlias: 'detail-tab' },
      }
      const result = await executor.execute(createStepInput(step))
      expect(result).toEqual({ fallbackUsed: false, expectsNewTabAlias: 'detail-tab' })
    })

    test('Given click with navigation expectation When execute Then 等待 URL 匹配', async () => {
      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserClickStep = {
        id: 'step-click-expect-nav',
        type: 'click',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle(),
        expect: { type: 'navigation', urlPattern: '/success' },
      }

      setTimeout(() => {
        fakeRuntime.currentTab.url = 'https://example.com/success'
      }, 50)
      const result = await executor.execute(createStepInput(step))
      expect(result).toEqual({ fallbackUsed: false })
    })

    test('Given click with visible expectation When execute Then 等待预期元素可见', async () => {
      let callCount = 0
      fakePort = createFakePort({
        onEvaluate: (expr) => {
          if (expr.includes('expect-visible-btn')) {
            callCount++
            if (callCount >= 2) {
              return { result: { value: { status: 'found', strategyIndex: 0, point: { x: 50, y: 50 }, enabled: true, visible: true } } }
            }
            return { result: { value: { status: 'not_found' } } }
          }
          return undefined
        },
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserClickStep = {
        id: 'step-click-expect-visible',
        type: 'click',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle(),
        expect: {
          type: 'visible',
          target: createLocatorBundle({ strategies: [{ kind: 'testId', attribute: 'data-testid', value: 'expect-visible-btn' }] }),
        },
      }
      const result = await executor.execute(createStepInput(step))
      expect(result).toEqual({ fallbackUsed: false })
    })

    test('Given fill step with variable When execute Then 解析变量并调用 insertText', async () => {
      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserFillStep = {
        id: 'step-fill-var',
        type: 'fill',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle({ fingerprint: { tagName: 'input', accessibleName: '用户名', visible: true, enabled: true } }),
        value: { kind: 'variable', variableKey: 'username' },
      }
      const result = await executor.execute(createStepInput(step, { variables: { username: 'alice_copis' } }))
      expect(result).toEqual({ fallbackUsed: false })
      const insertCall = fakePort.sentCalls.find((c) => c.method === 'Input.insertText')
      expect(insertCall?.params?.text).toBe('alice_copis')
      expect(fakePort.sentCalls.every((c) => ALLOWED_CDP_METHODS.has(c.method))).toBe(true)
    })

    test('Given press step without target When execute Then 派发 keyDown 和 keyUp', async () => {
      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserPressStep = {
        id: 'step-press',
        type: 'press',
        tabAlias: 'main',
        origin: 'https://example.com',
        key: 'Enter',
      }
      const result = await executor.execute(createStepInput(step))
      expect(result).toEqual({ fallbackUsed: false })
      const keyEvents = fakePort.sentCalls.filter((c) => c.method === 'Input.dispatchKeyEvent')
      expect(keyEvents.length).toBe(2)
      expect(keyEvents[0]!.params?.type).toBe('keyDown')
      expect(keyEvents[0]!.params?.key).toBe('Enter')
      expect(keyEvents[1]!.params?.type).toBe('keyUp')
      expect(fakePort.sentCalls.every((c) => ALLOWED_CDP_METHODS.has(c.method))).toBe(true)
    })

    test('Given press step with target When execute Then 先定位聚焦目标元素再派发按键', async () => {
      fakePort = createFakePort({
        onEvaluate: () => ({
          result: {
            value: {
              status: 'found',
              strategyIndex: 1,
              point: { x: 100, y: 100 },
              tagName: 'input',
              enabled: true,
              visible: true,
            },
          },
        }),
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserPressStep = {
        id: 'step-press-target',
        type: 'press',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle(),
        key: 'Tab',
      }
      const result = await executor.execute(createStepInput(step))
      expect(result).toEqual({ fallbackUsed: true })
      expect(fakePort.sentCalls.some((c) => c.method === 'Runtime.evaluate')).toBe(true)
      expect(fakePort.sentCalls.some((c) => c.method === 'Input.dispatchKeyEvent')).toBe(true)
    })

    test('Given select step When execute Then 执行选择脚本并派发 input/change', async () => {
      fakePort = createFakePort({
        onEvaluate: (expr) => {
          if (expr.includes('selectedIndex')) {
            return { result: { value: { status: 'found', strategyIndex: 0, optionIndex: 2, enabled: true, visible: true } } }
          }
          return undefined
        },
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserSelectStep = {
        id: 'step-select',
        type: 'select',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle({ fingerprint: { tagName: 'select', accessibleName: '省份', visible: true, enabled: true } }),
        value: { kind: 'literal', value: 'Guangdong' },
      }
      const result = await executor.execute(createStepInput(step))
      expect(result).toEqual({ fallbackUsed: false })
      expect(fakePort.sentCalls.every((c) => ALLOWED_CDP_METHODS.has(c.method))).toBe(true)
    })

    test('Given wait step for url When execute Then 轮询直至 URL 匹配', async () => {
      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserWaitStep = {
        id: 'step-wait-url',
        type: 'wait',
        tabAlias: 'main',
        origin: 'https://example.com',
        condition: { type: 'url', pattern: '/dashboard' },
      }

      setTimeout(() => {
        fakeRuntime.currentTab.url = 'https://example.com/dashboard'
      }, 50)
      const result = await executor.execute(createStepInput(step))
      expect(result).toEqual({ fallbackUsed: false })
      expect(fakePort.sentCalls.every((c) => ALLOWED_CDP_METHODS.has(c.method))).toBe(true)
    })

    test('Given wait step for visible target When execute Then 轮询直至目标可见', async () => {
      let pollCount = 0
      fakePort = createFakePort({
        onEvaluate: () => {
          pollCount++
          if (pollCount >= 2) {
            return { result: { value: { status: 'found', strategyIndex: 0, point: { x: 50, y: 50 }, enabled: true, visible: true } } }
          }
          return { result: { value: { status: 'not_found' } } }
        },
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserWaitStep = {
        id: 'step-wait-visible',
        type: 'wait',
        tabAlias: 'main',
        origin: 'https://example.com',
        condition: { type: 'visible', target: createLocatorBundle() },
      }
      const result = await executor.execute(createStepInput(step))
      expect(result).toEqual({ fallbackUsed: false })
    })

    test('Given assert step for visible When execute Then 成功校验', async () => {
      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserAssertStep = {
        id: 'step-assert-visible',
        type: 'assert',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle(),
        condition: { type: 'visible' },
      }
      const result = await executor.execute(createStepInput(step))
      expect(result).toEqual({ fallbackUsed: false })
      expect(fakePort.sentCalls.every((c) => ALLOWED_CDP_METHODS.has(c.method))).toBe(true)
    })

    test('Given assert step for hidden When execute Then 校验元素已隐藏或不存在', async () => {
      fakePort = createFakePort({
        onEvaluate: () => ({
          result: {
            value: {
              status: 'not_found',
            },
          },
        }),
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserAssertStep = {
        id: 'step-assert-hidden',
        type: 'assert',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle(),
        condition: { type: 'hidden' },
      }
      const result = await executor.execute(createStepInput(step))
      expect(result).toEqual({ fallbackUsed: false })
    })

    test('Given assert step for text (exact and partial) When execute Then 正确断言文本', async () => {
      fakePort = createFakePort({
        onEvaluate: () => ({
          result: {
            value: '支付成功 订单号: 12345',
          },
        }),
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)

      const stepContains: BrowserAssertStep = {
        id: 'step-assert-text-contains',
        type: 'assert',
        tabAlias: 'main',
        origin: 'https://example.com',
        condition: { type: 'text', value: '支付成功', exact: false },
      }

      await expect(
        executor.execute({
          step: stepContains,
          tabId: 'tab-1',
          port: fakePort.port,
          allowedOrigins: ['https://example.com'],
          variables: {},
          signal: abortController.signal,
        }),
      ).resolves.toEqual({ fallbackUsed: false })

      const stepExact: BrowserAssertStep = {
        id: 'step-assert-text-exact',
        type: 'assert',
        tabAlias: 'main',
        origin: 'https://example.com',
        condition: { type: 'text', value: '支付成功 订单号: 12345', exact: true },
      }

      await expect(
        executor.execute({
          step: stepExact,
          tabId: 'tab-1',
          port: fakePort.port,
          allowedOrigins: ['https://example.com'],
          variables: {},
          signal: abortController.signal,
        }),
      ).resolves.toEqual({ fallbackUsed: false })
    })

    test('Given assert step for url When execute Then 正确断言页面 URL', async () => {
      fakeRuntime.currentTab.url = 'https://example.com/checkout/success?order=123'
      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)

      const stepUrl: BrowserAssertStep = {
        id: 'step-assert-url',
        type: 'assert',
        tabAlias: 'main',
        origin: 'https://example.com',
        condition: { type: 'url', pattern: '/checkout/success' },
      }

      await expect(
        executor.execute({
          step: stepUrl,
          tabId: 'tab-1',
          port: fakePort.port,
          allowedOrigins: ['https://example.com'],
          variables: {},
          signal: abortController.signal,
        }),
      ).resolves.toEqual({ fallbackUsed: false })
    })

    test('Given fill 步骤引用未声明变量 When execute Then 拒绝并提示缺失变量', async () => {
      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserFillStep = {
        id: 'step-fill-missing-var',
        type: 'fill',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle({ fingerprint: { tagName: 'input', accessibleName: '地址', visible: true, enabled: true } }),
        value: { kind: 'variable', variableKey: 'missingKey' },
      }

      await expect(executor.execute(createStepInput(step))).rejects.toThrow('缺少 Workflow 变量: missingKey')
      expect(fakePort.sentCalls.length).toBe(0)
    })
  })

  // 11. Review 修复：A. click expect.navigation 跨 Origin 语义
  describe('11. Review 修复 A: click expect.navigation 跨 Origin 语义', () => {
    test('Given click with navigation expect When 跨 Origin 跳转到 allowedOrigins 内的新 Origin Then 校验通过且成功返回', async () => {
      fakeRuntime.currentTab.url = 'https://example.com/login'
      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserClickStep = {
        id: 'step-click-cross-origin-nav',
        type: 'click',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle(),
        expect: { type: 'navigation', urlPattern: '^https://accounts\\.example\\.com/success' },
      }

      setTimeout(() => {
        fakeRuntime.currentTab.url = 'https://accounts.example.com/success'
      }, 50)
      const result = await executor.execute(createStepInput(step, { allowedOrigins: ['https://example.com', 'https://accounts.example.com'] }))
      expect(result).toEqual({ fallbackUsed: false })
    })

    test('Given click with navigation expect When 跳转到未授权 Origin Then 立即抛错失败', async () => {
      fakeRuntime.currentTab.url = 'https://example.com/login'
      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserClickStep = {
        id: 'step-click-unauthorized-nav',
        type: 'click',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle(),
        expect: { type: 'navigation', urlPattern: '^https://evil\\.com/phishing' },
      }

      setTimeout(() => {
        fakeRuntime.currentTab.url = 'https://evil.com/phishing'
      }, 50)

      await expect(executor.execute(createStepInput(step))).rejects.toThrow('页面 Origin 不在 Workflow 白名单内')
    })
  })

  // 12. Review 修复：B. navigate + step.urlPattern 延迟/SPA 轮询
  describe('12. Review 修复 B: navigate + step.urlPattern 延迟/SPA 轮询', () => {
    test('Given navigate + urlPattern 当 waitForLoad 返回时处于中间加载 URL When 随后更新为匹配 pattern 的最终 URL Then 轮询成功完成', async () => {
      const customRuntime = createFakeRuntime()
      customRuntime.runtime.waitForLoad = async () => {
        // waitForLoad 返回时为 SPA 中间路由
        customRuntime.currentTab.url = 'https://example.com/spa-loading'
      }

      setTimeout(() => {
        customRuntime.currentTab.url = 'https://example.com/dashboard/home'
      }, 50)

      const executor = createBrowserWorkflowPageExecutor(customRuntime.runtime)
      const step: BrowserNavigateStep = {
        id: 'step-nav-spa',
        type: 'navigate',
        tabAlias: 'main',
        origin: 'https://example.com',
        url: 'https://example.com/dashboard',
        urlPattern: '^https://example\\.com/dashboard/home',
      }
      const result = await executor.execute(createStepInput(step))
      expect(result).toEqual({ fallbackUsed: false })
    })
  })

  // 13. Review 修复：C. 轮询期间页签关闭快速失败
  describe('13. Review 修复 C: 轮询期间页签关闭快速失败', () => {
    test('Given wait visible 轮询中途页签被关闭 (tab 返回 undefined) When execute Then 立即抛出“当前网页页签不存在”且在 1 秒内退出', async () => {
      let pollCount = 0
      fakePort = createFakePort({
        onEvaluate: () => {
          pollCount++
          return { result: { value: { status: 'not_found' } } }
        },
      })

      const customRuntime: BrowserWorkflowPageRuntime = {
        getTab() {
          if (pollCount >= 1) {
            return undefined // 模拟页签关闭
          }
          return { id: 'tab-1', url: 'https://example.com/app', title: 'App', isLoading: false }
        },
        navigate: () => {},
        waitForLoad: async () => {},
      }

      const executor = createBrowserWorkflowPageExecutor(customRuntime)
      const step: BrowserWaitStep = {
        id: 'step-wait-tab-closed',
        type: 'wait',
        tabAlias: 'main',
        origin: 'https://example.com',
        condition: { type: 'visible', target: createLocatorBundle() },
        timeoutMs: 5000,
      }

      const startTime = Date.now()
      await expect(executor.execute(createStepInput(step))).rejects.toThrow('当前网页页签不存在')
      const elapsed = Date.now() - startTime
      expect(elapsed).toBeLessThan(1000)
    })
  })

  // 14. Review 修复：D. read-only visible/locate 对 disabled 元素的语义
  describe('14. Review 修复 D: read-only visible/locate 对 disabled 元素匹配成功', () => {
    test('Given disabled 元素与匹配的 fingerprint (enabled: false) When assert visible / wait visible Then 校验成功', async () => {
      fakePort = createFakePort({
        onEvaluate: () => ({
          result: {
            value: {
              status: 'found',
              strategyIndex: 0,
              point: { x: 100, y: 100 },
              tagName: 'button',
              enabled: false, // 页面上处于 disabled
              visible: true,
            },
          },
        }),
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserAssertStep = {
        id: 'step-assert-visible-disabled',
        type: 'assert',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle({ fingerprint: { tagName: 'button', visible: true, enabled: false } }),
        condition: { type: 'visible' },
      }
      const result = await executor.execute(createStepInput(step))
      expect(result).toEqual({ fallbackUsed: false })
    })

    test('Given disabled 元素 When click Then 仍抛出“页面元素当前不可用”', async () => {
      fakePort = createFakePort({
        onEvaluate: () => ({
          result: {
            value: {
              status: 'found',
              strategyIndex: 0,
              point: { x: 100, y: 100 },
              tagName: 'button',
              enabled: false,
              visible: true,
            },
          },
        }),
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserClickStep = {
        id: 'step-click-disabled',
        type: 'click',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle(),
      }

      await expect(executor.execute(createStepInput(step))).rejects.toThrow('页面元素当前不可用')
    })
  })

  // 15. Review 修复：E. 跨 Origin / 嵌套 iframe Workflow CDP 主进程定位
  describe('15. Review 修复 E: 跨 Origin / 嵌套 iframe 主进程 CDP 定位与坐标叠加', () => {
    test('Given 目标元素位于 cross-origin iframe (framePath.frameUrls) When click Then 调用 FrameTree、IsolatedWorld、FrameOwner、BoxModel 并叠加坐标', async () => {
      fakePort = createFakePort({
        onSend: (method, params) => {
          if (method === 'Page.getFrameTree') {
            return {
              frameTree: {
                frame: { id: 'main-frame-id', url: 'https://example.com/checkout' },
                childFrames: [
                  {
                    frame: { id: 'payment-frame-id', url: 'https://payment.gateway.com/embedded-card?token=abc#frag' },
                  },
                ],
              },
            }
          }
          if (method === 'Page.createIsolatedWorld') {
            expect(params?.frameId).toBe('payment-frame-id')
            return { executionContextId: 42 }
          }
          if (method === 'DOM.getFrameOwner') {
            expect(params?.frameId).toBe('payment-frame-id')
            return { backendNodeId: 888 }
          }
          if (method === 'DOM.getBoxModel') {
            expect(params?.backendNodeId).toBe(888)
            return {
              model: {
                content: [50, 100, 350, 100, 350, 300, 50, 300], // min x = 50, min y = 100
              },
            }
          }
          if (method === 'Runtime.evaluate') {
            expect(params?.contextId).toBe(42)
            return {
              result: {
                value: {
                  status: 'found',
                  strategyIndex: 0,
                  point: { x: 20, y: 30 }, // frame 内部相对坐标
                  tagName: 'button',
                  enabled: true,
                  visible: true,
                },
              },
            }
          }
          return undefined
        },
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserClickStep = {
        id: 'step-click-iframe',
        type: 'click',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle({
          framePath: {
            frameIds: ['main', 'payment-frame-id'],
            frameUrls: ['https://payment.gateway.com/embedded-card'],
          },
        }),
      }
      const result = await executor.execute(createStepInput(step))
      expect(result).toEqual({ fallbackUsed: false })

      // 验证鼠标事件使用了叠加后的真实视口坐标 (20 + 50 = 70, 30 + 100 = 130)
      const mousePress = fakePort.sentCalls.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mousePressed')
      expect(mousePress?.params?.x).toBe(70)
      expect(mousePress?.params?.y).toBe(130)
      expect(fakePort.sentCalls.every((c) => ALLOWED_CDP_METHODS.has(c.method))).toBe(true)
    })

    test('Given framePath.frameUrls 在 getFrameTree 中无匹配 When execute Then 立即抛出“Workflow 目标 Frame 不存在或地址已变化”', async () => {
      fakePort = createFakePort({
        onSend: (method) => {
          if (method === 'Page.getFrameTree') {
            return {
              frameTree: {
                frame: { id: 'main-frame-id', url: 'https://example.com/checkout' },
                childFrames: [],
              },
            }
          }
          return undefined
        },
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserClickStep = {
        id: 'step-click-iframe-missing',
        type: 'click',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle({
          framePath: {
            frameIds: ['main', 'missing-frame-id'],
            frameUrls: ['https://missing.gateway.com/frame'],
          },
        }),
      }

      await expect(executor.execute(createStepInput(step))).rejects.toThrow('Workflow 目标 Frame 不存在或地址已变化')
    })

    test('Given framePath.frameUrls 在 getFrameTree 中匹配多个 frame When execute Then 立即抛出“Workflow 目标 Frame 不明确”', async () => {
      fakePort = createFakePort({
        onSend: (method) => {
          if (method === 'Page.getFrameTree') {
            return {
              frameTree: {
                frame: { id: 'main-frame-id', url: 'https://example.com/checkout' },
                childFrames: [
                  { frame: { id: 'frame-1', url: 'https://sub.example.com/widget' } },
                  { frame: { id: 'frame-2', url: 'https://sub.example.com/widget' } },
                ],
              },
            }
          }
          return undefined
        },
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserClickStep = {
        id: 'step-click-iframe-ambiguous',
        type: 'click',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle({
          framePath: {
            frameIds: ['main', 'sub-frame-id'],
            frameUrls: ['https://sub.example.com/widget'],
          },
        }),
      }

      await expect(executor.execute(createStepInput(step))).rejects.toThrow('Workflow 目标 Frame 不明确')
    })

    test('Given Page.createIsolatedWorld 返回非 number executionContextId When execute Then 立即抛出“无法创建 Workflow Frame 执行环境”且不降级到 main frame', async () => {
      fakePort = createFakePort({
        onSend: (method) => {
          if (method === 'Page.getFrameTree') {
            return {
              frameTree: {
                frame: { id: 'main-frame-id', url: 'https://example.com/checkout' },
                childFrames: [
                  { frame: { id: 'payment-frame-id', url: 'https://payment.gateway.com/embedded-card' } },
                ],
              },
            }
          }
          if (method === 'Page.createIsolatedWorld') {
            // 返回缺少 executionContextId 的响应
            return {}
          }
          return undefined
        },
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserClickStep = {
        id: 'step-click-iframe-no-ctx',
        type: 'click',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle({
          framePath: {
            frameIds: ['main', 'payment-frame-id'],
            frameUrls: ['https://payment.gateway.com/embedded-card'],
          },
        }),
      }

      await expect(executor.execute(createStepInput(step))).rejects.toThrow('无法创建 Workflow Frame 执行环境')
      // 保证未降级到 main frame 执行 evaluate
      expect(fakePort.sentCalls.some((c) => c.method === 'Runtime.evaluate')).toBe(false)
    })

    test('Given 3 层嵌套 frame 树且 recorded 为 2 段后缀 When 匹配 Frame Then 成功匹配到最终叶子 Frame C', async () => {
      let createdWorldFrameId: string | undefined

      fakePort = createFakePort({
        onSend: (method, params) => {
          if (method === 'Page.getFrameTree') {
            return {
              frameTree: {
                frame: { id: 'main-frame', url: 'https://app.com/main' },
                childFrames: [
                  {
                    frame: { id: 'frame-b', url: 'https://auth.com/login' },
                    childFrames: [
                      {
                        frame: { id: 'frame-c', url: 'https://auth.com/captcha' },
                      },
                    ],
                  },
                ],
              },
            }
          }
          if (method === 'Page.createIsolatedWorld') {
            createdWorldFrameId = params?.frameId as string
            return { executionContextId: 101 }
          }
          if (method === 'DOM.getFrameOwner') {
            return { backendNodeId: 999 }
          }
          if (method === 'DOM.getBoxModel') {
            return { model: { content: [10, 20, 110, 20, 110, 120, 10, 120] } }
          }
          if (method === 'Runtime.evaluate') {
            return {
              result: {
                value: {
                  status: 'found',
                  strategyIndex: 0,
                  point: { x: 5, y: 5 },
                  tagName: 'button',
                  enabled: true,
                  visible: true,
                },
              },
            }
          }
          return undefined
        },
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserClickStep = {
        id: 'step-click-suffix-match',
        type: 'click',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle({
          framePath: {
            frameIds: ['main', 'frame-b', 'frame-c'],
            frameUrls: ['https://auth.com/login', 'https://auth.com/captcha'],
          },
        }),
      }
      const result = await executor.execute(createStepInput(step))
      expect(result).toEqual({ fallbackUsed: false })
      expect(createdWorldFrameId).toBe('frame-c')
    })

    test('Given 多层嵌套 frame click When 执行 Then 只对最终 target frame 请求一次 DOM.getFrameOwner 且不累加祖先 offset', async () => {
      const ownerCalls: string[] = []

      fakePort = createFakePort({
        onSend: (method, params) => {
          if (method === 'Page.getFrameTree') {
            return {
              frameTree: {
                frame: { id: 'main-frame', url: 'https://app.com/main' },
                childFrames: [
                  {
                    frame: { id: 'frame-b', url: 'https://auth.com/step1' },
                    childFrames: [
                      {
                        frame: { id: 'frame-c', url: 'https://auth.com/step2' },
                      },
                    ],
                  },
                ],
              },
            }
          }
          if (method === 'Page.createIsolatedWorld') {
            return { executionContextId: 102 }
          }
          if (method === 'DOM.getFrameOwner') {
            ownerCalls.push(params?.frameId as string)
            return { backendNodeId: 777 }
          }
          if (method === 'DOM.getBoxModel') {
            return { model: { content: [100, 200, 300, 200, 300, 400, 100, 400] } }
          }
          if (method === 'Runtime.evaluate') {
            return {
              result: {
                value: {
                  status: 'found',
                  strategyIndex: 0,
                  point: { x: 15, y: 25 },
                  tagName: 'button',
                  enabled: true,
                  visible: true,
                },
              },
            }
          }
          return undefined
        },
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserClickStep = {
        id: 'step-click-single-owner',
        type: 'click',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle({
          framePath: {
            frameIds: ['main', 'frame-b', 'frame-c'],
            frameUrls: ['https://auth.com/step1', 'https://auth.com/step2'],
          },
        }),
      }

      await executor.execute(createStepInput(step))

      // 断言只对最终 frame-c 请求了 owner 一次（不是 frame-b + frame-c）
      expect(ownerCalls).toEqual(['frame-c'])
      const mousePress = fakePort.sentCalls.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mousePressed')
      expect(mousePress?.params?.x).toBe(115) // 15 + 100
      expect(mousePress?.params?.y).toBe(225) // 25 + 200
    })

    test('Given cross-frame assert visible / assert hidden When 执行 Then 零 DOM.getFrameOwner 与 getBoxModel 调用', async () => {
      fakePort = createFakePort({
        onSend: (method) => {
          if (method === 'Page.getFrameTree') {
            return {
              frameTree: {
                frame: { id: 'main-frame', url: 'https://example.com/page' },
                childFrames: [
                  { frame: { id: 'sub-frame', url: 'https://sub.example.com/content' } },
                ],
              },
            }
          }
          if (method === 'Page.createIsolatedWorld') {
            return { executionContextId: 103 }
          }
          if (method === 'Runtime.evaluate') {
            return {
              result: {
                value: {
                  status: 'found',
                  strategyIndex: 0,
                  point: { x: 50, y: 50 },
                  tagName: 'div',
                  enabled: true,
                  visible: true,
                },
              },
            }
          }
          return undefined
        },
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserAssertStep = {
        id: 'step-assert-visible-frame',
        type: 'assert',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle({
          framePath: {
            frameIds: ['main', 'sub-frame'],
            frameUrls: ['https://sub.example.com/content'],
          },
        }),
        condition: { type: 'visible' },
      }
      const result = await executor.execute(createStepInput(step))
      expect(result).toEqual({ fallbackUsed: false })

      // 验证未调用任何 DOM frame owner / box model 方法
      expect(fakePort.sentCalls.some((c) => c.method === 'DOM.getFrameOwner')).toBe(false)
      expect(fakePort.sentCalls.some((c) => c.method === 'DOM.getBoxModel')).toBe(false)
    })

    test('Given 在 Page.getFrameTree 返回时触发 abort When execute Then 立即中断且无后续 CDP 发送', async () => {
      fakePort = createFakePort({
        onSend: (method) => {
          if (method === 'Page.getFrameTree') {
            // 在 frameTree 返回瞬间触发外部 abort
            abortController.abort()
            return {
              frameTree: {
                frame: { id: 'main-frame', url: 'https://example.com/page' },
                childFrames: [
                  { frame: { id: 'sub-frame', url: 'https://sub.example.com/content' } },
                ],
              },
            }
          }
          return undefined
        },
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserClickStep = {
        id: 'step-click-abort-during-tree',
        type: 'click',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle({
          framePath: {
            frameIds: ['main', 'sub-frame'],
            frameUrls: ['https://sub.example.com/content'],
          },
        }),
      }

      await expect(executor.execute(createStepInput(step))).rejects.toThrow('Browser Workflow 已取消')
      // 确认未发送 createIsolatedWorld 或 Runtime.evaluate
      expect(fakePort.sentCalls.some((c) => c.method === 'Page.createIsolatedWorld')).toBe(false)
      expect(fakePort.sentCalls.some((c) => c.method === 'Runtime.evaluate')).toBe(false)
      expect(fakePort.sentCalls.some((c) => c.method === 'Input.dispatchMouseEvent')).toBe(false)
    })

    test('Given 叠加 frame offset 后最终坐标超出安全范围 (负数) When click Then 拒绝并抛出“页面元素坐标无效”', async () => {
      fakePort = createFakePort({
        onSend: (method) => {
          if (method === 'Page.getFrameTree') {
            return {
              frameTree: {
                frame: { id: 'main-frame', url: 'https://example.com/page' },
                childFrames: [
                  { frame: { id: 'sub-frame', url: 'https://sub.example.com/content' } },
                ],
              },
            }
          }
          if (method === 'Page.createIsolatedWorld') {
            return { executionContextId: 104 }
          }
          if (method === 'DOM.getFrameOwner') {
            return { backendNodeId: 555 }
          }
          if (method === 'DOM.getBoxModel') {
            // 返回导致最终坐标为负数的 content quad
            return { model: { content: [-200, -200, 0, -200, 0, 0, -200, 0] } }
          }
          if (method === 'Runtime.evaluate') {
            return {
              result: {
                value: {
                  status: 'found',
                  strategyIndex: 0,
                  point: { x: 50, y: 50 },
                  tagName: 'button',
                  enabled: true,
                  visible: true,
                },
              },
            }
          }
          return undefined
        },
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserClickStep = {
        id: 'step-click-negative-point',
        type: 'click',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: createLocatorBundle({
          framePath: {
            frameIds: ['main', 'sub-frame'],
            frameUrls: ['https://sub.example.com/content'],
          },
        }),
      }

      await expect(executor.execute(createStepInput(step))).rejects.toThrow('页面元素坐标无效')
      expect(fakePort.sentCalls.some((c) => c.method === 'Input.dispatchMouseEvent')).toBe(false)
    })
  })

  // 16. Review 修复：F. href fallback 遇到 select 拒绝
  describe('16. Review 修复 F: href fallback 遇到 select 拒绝', () => {
    test('Given select 步骤遭遇 anchor href fallback When 执行 evaluate 脚本 Then 拒绝并返回 notSelect 且零 focus/scroll', () => {
      let scrollCalls = 0
      let focusCalls = 0

      const mockAnchor = {
        tagName: 'A',
        href: 'https://example.com/options',
        disabled: false,
        isConnected: true,
        getAttribute: (name: string) => (name === 'href' ? 'https://example.com/options' : null),
        getBoundingClientRect: () => ({ width: 100, height: 30, left: 10, top: 10 }),
        scrollIntoView: () => {
          scrollCalls++
        },
        focus: () => {
          focusCalls++
        },
      }

      const bundle: BrowserLocatorBundle = {
        framePath: { frameIds: ['main'] },
        strategies: [{ kind: 'css', value: '.non-existent' }],
        fingerprint: { tagName: 'a', href: 'https://example.com/options', visible: true, enabled: true },
      }

      const source = buildLocatorEvaluationSource({ bundle, action: 'select', selectValue: 'opt1' })
      const mockDoc = { querySelectorAll: (sel: string) => (sel === 'a[href]' ? [mockAnchor] : []), getElementById: () => null }
      const mockWindow = { getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }) }

      const runner = new Function('document', 'window', `return ${source}`)
      const evalResult = runner(mockDoc, mockWindow)

      expect(evalResult.notSelect).toBe(true)
      expect(scrollCalls).toBe(0)
      expect(focusCalls).toBe(0)
    })
  })

  // 17. 最后一轮安全 Review：持续 urlPattern 校验与 evaluatePageText 安全守护
  describe('17. 最后一轮安全 Review: 持续 urlPattern 校验与 evaluatePageText 安全守护', () => {
    test('Given click step 携带 urlPattern 当 evaluate 返回时同 Origin 改到不匹配 URL Then 立即抛出“页面 URL 不匹配规则”且未发送 Input.dispatchMouseEvent', async () => {
      fakeRuntime.currentTab.url = 'https://example.com/form'

      fakePort = createFakePort({
        onEvaluate: () => {
          // evaluate 返回时同 Origin URL 改变为 /other
          fakeRuntime.currentTab.url = 'https://example.com/other'
          return {
            result: {
              value: {
                status: 'found',
                strategyIndex: 0,
                point: { x: 100, y: 100 },
                tagName: 'button',
                enabled: true,
                visible: true,
              },
            },
          }
        },
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserClickStep = {
        id: 'step-click-url-pattern-mid-drift',
        type: 'click',
        tabAlias: 'main',
        origin: 'https://example.com',
        urlPattern: '^https://example\\.com/form$',
        target: createLocatorBundle(),
      }

      await expect(executor.execute(createStepInput(step))).rejects.toThrow('页面 URL 不匹配规则')
      expect(fakePort.sentCalls.some((c) => c.method === 'Input.dispatchMouseEvent')).toBe(false)
    })

    test('Given wait text 轮询中 evaluate 返回目标文本同时将页面改到未授权 Origin When execute Then 立即抛出 Origin 不在白名单且只发送一次 Runtime.evaluate', async () => {
      let evalCount = 0

      fakePort = createFakePort({
        onEvaluate: () => {
          evalCount++
          // 模拟 evaluate 期间发生跳转到未授权 Origin
          fakeRuntime.currentTab.url = 'https://evil.com/phishing'
          return {
            result: {
              value: '支付成功',
            },
          }
        },
      })

      const executor = createBrowserWorkflowPageExecutor(fakeRuntime.runtime)
      const step: BrowserWaitStep = {
        id: 'step-wait-text-origin-drift',
        type: 'wait',
        tabAlias: 'main',
        origin: 'https://example.com',
        condition: { type: 'text', value: '支付成功' },
        timeoutMs: 5000,
      }

      const startTime = Date.now()
      await expect(executor.execute(createStepInput(step))).rejects.toThrow('页面 Origin 不在 Workflow 白名单内')
      expect(Date.now() - startTime).toBeLessThan(1000)
      expect(evalCount).toBe(1)
    })
  })
})
