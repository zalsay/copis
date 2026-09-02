import { describe, expect, test } from 'bun:test'
import {
  assertBrowserPageMutationAllowed,
  classifyBrowserPageElement,
  createBrowserPageControlService,
  renderBrowserSnapshot,
  snapshotElementLine,
  type BrowserPageCdpCommandInput,
  type BrowserPageControlRuntime,
} from './browser-page-control-service'

function createRuntime(mode: 'ask' | 'authorized', advancedAuthorization = false): {
  runtime: BrowserPageControlRuntime
  commands: string[]
  calls: BrowserPageCdpCommandInput[]
  commandTimes: number[]
  setFailCursor: (fail: boolean) => void
  setCursorException: (enabled: boolean) => void
  setFocusResult: (result: Record<string, unknown>) => void
} {
  const commands: string[] = []
  const calls: BrowserPageCdpCommandInput[] = []
  const commandTimes: number[] = []
  let failCursor = false
  let cursorException = false
  let focusResult: Record<string, unknown> = { x: 120, y: 80 }
  const runtime: BrowserPageControlRuntime = {
    getContext: () => ({ tabId: 'tab-1' }),
    getControlMode: () => mode,
    isAdvancedAuthorizationEnabled: () => advancedAuthorization,
    resolveUploadPaths: (_sessionId, paths) => paths,
    getTab: () => ({ id: 'tab-1', url: 'https://example.com/form', title: '示例表单' }),
    navigate: () => undefined,
    async sendCommand(input) {
      calls.push(input)
      commandTimes.push(performance.now())
      commands.push(input.method)
      if (
        failCursor
        && input.method === 'Runtime.evaluate'
        && typeof input.params?.expression === 'string'
        && input.params.expression.includes('data-copis-ai-browser-cursor')
      ) {
        throw new Error('页面已销毁')
      }
      if (
        cursorException
        && input.method === 'Runtime.evaluate'
        && typeof input.params?.expression === 'string'
        && input.params.expression.includes('data-copis-ai-browser-cursor')
      ) {
        return { exceptionDetails: { text: '页面脚本执行失败' } }
      }
      if (
        input.method === 'Runtime.evaluate'
        && input.params?.awaitPromise === true
        && typeof input.params?.expression === 'string'
        && input.params.expression.includes('data-copis-ai-browser-cursor')
      ) {
        return { result: { value: { ok: true } } }
      }
      if (input.method === 'Runtime.evaluate' && commands.length === 2) {
        return {
          result: {
            value: {
              url: 'https://example.com/form',
              title: '示例表单',
              text: '名称 提交',
              scrollX: 0,
              scrollY: 0,
              viewportWidth: 1000,
              viewportHeight: 700,
              documentWidth: 1000,
              documentHeight: 1200,
              elements: [{
                selector: '#name',
                tagName: 'input',
                role: 'textbox',
                name: '名称',
                inputType: 'text',
                placeholder: '输入名称',
                enabled: true,
                attributes: { id: 'name' },
              }, {
                selector: '#password',
                tagName: 'input',
                role: 'textbox',
                name: '密码',
                inputType: 'password',
                placeholder: '输入密码',
                enabled: true,
                attributes: { id: 'password', type: 'password' },
              }, {
                selector: '#country',
                tagName: 'select',
                role: 'combobox',
                name: '国家',
                enabled: true,
                attributes: { id: 'country' },
              }, {
                selector: '#attachment',
                tagName: 'input',
                role: 'button',
                name: '上传附件',
                inputType: 'file',
                enabled: true,
                attributes: { id: 'attachment', type: 'file' },
              }],
            },
          },
        }
      }
      if (input.method === 'Runtime.evaluate') {
        if (typeof input.params?.expression === 'string' && input.params.expression.includes("input[type=file]")) {
          return { result: { objectId: 'file-input-1' } }
        }
        if (typeof input.params?.expression === 'string' && input.params.expression.includes('selectValue =')) {
          return { result: { value: { ok: true, ...focusResult, optionIndex: 1 } } }
        }
        return { result: { value: { ok: true, ...focusResult } } }
      }
      return {}
    },
  }
  return {
    runtime,
    commands,
    calls,
    commandTimes,
    setFailCursor: (fail) => { failCursor = fail },
    setCursorException: (enabled) => { cursorException = enabled },
    setFocusResult: (result) => { focusResult = result },
  }
}

describe('Browser Agent 页面操作安全策略', () => {
  test('Given 密码或验证码字段 When 分类页面元素 Then 标记为敏感字段', () => {
    expect(classifyBrowserPageElement({
      tagName: 'input',
      inputType: 'password',
      name: '密码',
      attributes: {},
    }).sensitiveReason).toBe('password')

    expect(classifyBrowserPageElement({
      tagName: 'input',
      inputType: 'text',
      name: '验证码',
      attributes: { name: 'verification_code' },
    }).sensitiveReason).toBe('otp')
  })

  test('Given 删除或提交按钮 When 分类点击风险 Then 要求单次确认', () => {
    expect(classifyBrowserPageElement({
      tagName: 'button',
      role: 'button',
      name: '删除账户',
      attributes: {},
    }).requiresConfirmation).toBe(true)

    expect(classifyBrowserPageElement({
      tagName: 'button',
      role: 'button',
      name: '提交申请',
      attributes: { type: 'submit' },
    }).requiresConfirmation).toBe(true)
  })

  test('Given 普通页面链接 When 分类点击风险 Then 不要求单次确认', () => {
    expect(classifyBrowserPageElement({
      tagName: 'a',
      role: 'link',
      name: '查看详情',
      attributes: { href: '/details' },
    }).requiresConfirmation).toBe(false)
  })

  test('Given 询问模式 When 尝试页面写操作 Then 拒绝执行', () => {
    expect(() => assertBrowserPageMutationAllowed('ask')).toThrow('当前页面处于询问模式，请先在 AI浏览器顶部授权页面操作')
    expect(() => assertBrowserPageMutationAllowed('authorized')).not.toThrow()
  })

  test('Given 当前页面 When Agent 观察页面 Then 返回短期元素引用且不暴露 selector', async () => {
    const { runtime } = createRuntime('ask')
    const service = createBrowserPageControlService(runtime)

    const snapshot = await service.observe('session-1')

    expect(snapshot.elements[0]).toEqual({
      ref: 'e1',
      tagName: 'input',
      role: 'textbox',
      name: '名称',
      inputType: 'text',
      placeholder: '输入名称',
      enabled: true,
      requiresConfirmation: false,
    })
    expect(JSON.stringify(snapshot)).not.toContain('selector')
  })

  test('Given 询问模式 When Agent 尝试点击 Then 在发送 CDP 写命令前拒绝', async () => {
    const { runtime, commands } = createRuntime('ask')
    const service = createBrowserPageControlService(runtime)
    await service.observe('session-1')

    await expect(service.click('session-1', 'e1')).rejects.toThrow('授权')
    expect(commands).toEqual(['Runtime.enable', 'Runtime.evaluate'])
  })

  test('Given 授权模式和有效元素引用 When Agent 点击 Then 先移动和按下网页指针再派发鼠标事件', async () => {
    const { runtime, calls } = createRuntime('authorized')
    const service = createBrowserPageControlService(runtime)
    await service.observe('session-1')

    await service.click('session-1', 'e1')

    expect(calls.slice(2).map((call) => call.method)).toEqual([
      'Runtime.evaluate',
      'Runtime.evaluate',
      'Input.dispatchMouseEvent',
      'Runtime.evaluate',
      'Input.dispatchMouseEvent',
    ])
    expect(calls[2]?.params?.expression).toContain("if (rect.width <= 0 || rect.height <= 0) return { ok: false, reason: 'not_visible' };")
    expect(calls[3]?.params?.expression).toContain('const phase = "move"')
    expect(calls[3]?.params).toMatchObject({ returnByValue: true, awaitPromise: true })
    expect(calls[4]?.params).toMatchObject({ type: 'mousePressed', x: 120, y: 80 })
    expect(calls[5]?.params?.expression).toContain('const phase = "press"')
    expect(calls[5]?.params).toMatchObject({ returnByValue: true, awaitPromise: true })
    expect(calls[6]?.params).toMatchObject({ type: 'mouseReleased', x: 120, y: 80 })
  })

  test('Given 授权模式和有效元素引用 When Agent 点击 Then mousePressed 不早于移动指针后 1000ms 发送', async () => {
    const { runtime, calls, commandTimes } = createRuntime('authorized')
    const service = createBrowserPageControlService(runtime)
    await service.observe('session-1')

    await service.click('session-1', 'e1')

    const moveIndex = calls.findIndex((call) => (
      call.method === 'Runtime.evaluate'
      && typeof call.params?.expression === 'string'
      && call.params.expression.includes('const phase = "move"')
    ))
    const mousePressedIndex = calls.findIndex((call) => (
      call.method === 'Input.dispatchMouseEvent'
      && call.params?.type === 'mousePressed'
    ))
    expect(mousePressedIndex).toBeGreaterThan(moveIndex)
    expect(commandTimes[mousePressedIndex]! - commandTimes[moveIndex]!).toBeGreaterThanOrEqual(1_000)
  })

  test('Given 授权模式和敏感字段 When Agent 尝试输入 Then 在发送输入命令前拒绝', async () => {
    const { runtime, commands } = createRuntime('authorized')
    const service = createBrowserPageControlService(runtime)
    await service.observe('session-1')

    await expect(service.typeText('session-1', 'e2', 'secret')).rejects.toThrow('敏感')
    expect(commands).toEqual(['Runtime.enable', 'Runtime.evaluate'])
  })

  test('Given Composer 高级授权和敏感字段 When Agent 输入 Then 使用 CDP 可信键盘事件', async () => {
    const { runtime, commands } = createRuntime('authorized', true)
    const service = createBrowserPageControlService(runtime)
    await service.observe('session-1')

    await expect(service.typeText('session-1', 'e2', 'secret')).resolves.toMatchObject({ ok: true })

    expect(commands).toContain('Input.insertText')
  })

  test('Given Composer 高级授权和已授权文件 When Agent 上传到 file input Then 使用 CDP 设置文件并派发页面事件', async () => {
    const { runtime, calls } = createRuntime('authorized', true)
    Object.assign(runtime, {
      resolveUploadPaths: (_sessionId: string, paths: string[]) => paths,
    })
    const service = createBrowserPageControlService(runtime)
    await service.observe('session-1')

    const upload = (service as unknown as {
      upload: (sessionId: string, ref: string, paths: string[]) => Promise<{ ok: boolean }>
    }).upload
    await expect(upload('session-1', 'e4', ['/workspace/project/contract.pdf'])).resolves.toMatchObject({ ok: true })

    expect(calls).toContainEqual(expect.objectContaining({
      method: 'DOM.setFileInputFiles',
      params: { objectId: 'file-input-1', files: ['/workspace/project/contract.pdf'] },
    }))
    expect(calls).toContainEqual(expect.objectContaining({
      method: 'Runtime.releaseObject',
      params: { objectId: 'file-input-1' },
    }))
    expect(calls.some((call) => (
      call.method === 'Runtime.evaluate'
      && typeof call.params?.expression === 'string'
      && call.params.expression.includes("new Event('change'")
    ))).toBe(true)
  })

  test('Given 授权模式和普通字段 When Agent 输入文本 Then 使用 CDP 可信键盘事件', async () => {
    const { runtime, commands } = createRuntime('authorized')
    const service = createBrowserPageControlService(runtime)
    await service.observe('session-1')

    await service.typeText('session-1', 'e1', 'Copis')

    expect(commands).toContain('Input.insertText')
  })

  test('Given 聚焦元素返回负坐标 When Agent 输入文本 Then 仍继续键盘输入且指针坐标由脚本钳制', async () => {
    const { runtime, calls, setFocusResult } = createRuntime('authorized')
    const service = createBrowserPageControlService(runtime)
    await service.observe('session-1')
    setFocusResult({ x: -20, y: 30 })

    const result = await service.typeText('session-1', 'e1', 'Copis')

    expect(result.ok).toBe(true)
    expect(calls.some((call) => call.method === 'Input.insertText')).toBe(true)
    expect(calls.some((call) => (
      call.method === 'Runtime.evaluate'
      && typeof call.params?.expression === 'string'
      && call.params.expression.includes('const x = 0')
      && call.params.expression.includes('const y = 30')
    ))).toBe(true)
  })

  test('Given 授权模式和普通字段 When Agent 输入选择或按键 Then 聚焦后显示对应网页指针阶段', async () => {
    const { runtime, calls } = createRuntime('authorized')
    const service = createBrowserPageControlService(runtime)
    await service.observe('session-1')

    await service.typeText('session-1', 'e1', 'Copis')
    await service.select('session-1', 'e3', 'Copis')
    await service.press('session-1', 'e1', 'Enter')

    const phases = calls.flatMap((call) => {
      if (call.method !== 'Runtime.evaluate' || typeof call.params?.expression !== 'string') return []
      const match = call.params.expression.match(/const phase = "([a-z]+)"/)
      return match ? [match[1]] : []
    })
    expect(phases).toEqual(['type', 'select', 'key'])
  })

  test('Given 授权模式 When Agent 滚动 Then 先显示视口中心的滚动指针再执行滚动', async () => {
    const { runtime, calls } = createRuntime('authorized')
    const service = createBrowserPageControlService(runtime)

    await service.scroll('session-1', 0, 500)

    const cursorIndex = calls.findIndex((call) => (
      call.method === 'Runtime.evaluate'
      && typeof call.params?.expression === 'string'
      && call.params.expression.includes('const phase = "scroll"')
    ))
    const scrollIndex = calls.findIndex((call) => (
      call.method === 'Runtime.evaluate'
      && typeof call.params?.expression === 'string'
      && call.params.expression.includes('window.scrollBy')
    ))
    expect(cursorIndex).toBeGreaterThanOrEqual(0)
    expect(calls[cursorIndex]?.params?.expression).toContain('window.innerWidth / 2')
    expect(calls[cursorIndex]?.params?.expression).toContain('window.innerHeight / 2')
    expect(calls[cursorIndex]?.params?.awaitPromise).toBe(true)
    expect(scrollIndex).toBeGreaterThan(cursorIndex)
  })

  test('Given 指针注入失败 When Agent 点击输入或滚动 Then 原页面操作仍然完成', async () => {
    const { runtime, calls, setFailCursor } = createRuntime('authorized')
    const service = createBrowserPageControlService(runtime)
    await service.observe('session-1')
    setFailCursor(true)

    await service.click('session-1', 'e1')
    await service.typeText('session-1', 'e1', 'Copis')
    await service.scroll('session-1', 0, 500)

    expect(calls.some((call) => call.method === 'Input.dispatchMouseEvent')).toBe(true)
    expect(calls.some((call) => call.method === 'Input.insertText')).toBe(true)
    expect(calls.some((call) => (
      call.method === 'Runtime.evaluate'
      && typeof call.params?.expression === 'string'
      && call.params.expression.includes('window.scrollBy')
    ))).toBe(true)
  })

  test('Given cursor Runtime.evaluate 返回 exceptionDetails When Agent 点击 Then 告警且继续派发鼠标事件', async () => {
    const { runtime, calls, setCursorException } = createRuntime('authorized')
    const service = createBrowserPageControlService(runtime)
    await service.observe('session-1')
    setCursorException(true)
    const originalWarn = console.warn
    const warnings: unknown[][] = []
    console.warn = (...args: unknown[]): void => { warnings.push(args) }

    try {
      await service.click('session-1', 'e1')
    } finally {
      console.warn = originalWarn
    }

    expect(calls.some((call) => call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mousePressed')).toBe(true)
    expect(calls.some((call) => call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mouseReleased')).toBe(true)
    expect(warnings).toHaveLength(2)
    expect(warnings.every(([message]) => message === '[AI浏览器][主进程] 页面指针注入失败')).toBe(true)
  })

  test('Given 授权模式和无效元素引用 When Agent 尝试点击 Then 不发送指针 Runtime.evaluate', async () => {
    const { runtime, calls } = createRuntime('authorized')
    const service = createBrowserPageControlService(runtime)
    await service.observe('session-1')

    await expect(service.click('session-1', 'e99')).rejects.toThrow('页面元素引用不存在')
    expect(calls.filter((call) => call.method === 'Runtime.evaluate')).toHaveLength(1)
    expect(calls.every((call) => (
      call.method !== 'Runtime.evaluate'
      || typeof call.params?.expression !== 'string'
      || !call.params.expression.includes('data-copis-ai-browser-cursor')
    ))).toBe(true)
  })

  test('Given 指针注入失败后导航 Then 尽力隐藏指针并继续导航', async () => {
    const { runtime, calls } = createRuntime('authorized')
    const navigations: string[] = []
    runtime.navigate = (_tabId, url) => { navigations.push(url) }
    const service = createBrowserPageControlService(runtime)

    await service.navigate('session-1', 'https://example.com/next')

    expect(calls).toHaveLength(1)
    expect(calls[0]?.params?.expression).toContain('.remove()')
    expect(calls[0]?.params?.awaitPromise).not.toBe(true)
    expect(navigations).toEqual(['https://example.com/next'])
  })

  test('Given 询问模式 When Agent 尝试滚动或导航 Then 不发送指针 Runtime.evaluate', async () => {
    const { runtime, calls } = createRuntime('ask')
    const navigations: string[] = []
    runtime.navigate = (_tabId, url) => { navigations.push(url) }
    const service = createBrowserPageControlService(runtime)

    await expect(service.scroll('session-1', 0, 500)).rejects.toThrow('授权')
    await expect(service.navigate('session-1', 'https://example.com/next')).rejects.toThrow('授权')

    expect(calls).toHaveLength(0)
    expect(navigations).toHaveLength(0)
  })
})

describe('DOM 快照压缩与 DSL 渲染', () => {
  test('Given 单个页面元素 When snapshotElementLine 格式化 Then 输出紧凑单行 DSL', () => {
    expect(snapshotElementLine({
      ref: 'e1',
      tagName: 'button',
      role: 'button',
      name: '搜索',
      enabled: true,
      requiresConfirmation: false,
    })).toBe('- button "搜索" [ref=e1]')

    expect(snapshotElementLine({
      ref: 'e2',
      tagName: 'input',
      role: 'textbox',
      name: '用户名',
      placeholder: '请输入工号或邮箱',
      enabled: false,
      requiresConfirmation: false,
    })).toBe('- textbox "用户名" [ref=e2] [disabled placeholder="请输入工号或邮箱"]')

    expect(snapshotElementLine({
      ref: 'e3',
      tagName: 'input',
      role: 'checkbox',
      name: '记住我',
      enabled: true,
      checked: true,
      requiresConfirmation: false,
    })).toBe('- checkbox "记住我" [ref=e3] [checked=true]')

    expect(snapshotElementLine({
      ref: 'e4',
      tagName: 'input',
      role: 'textbox',
      name: '密码',
      enabled: true,
      sensitiveReason: 'password',
      requiresConfirmation: false,
    })).toBe('- textbox "密码" [ref=e4] [sensitive=password]')
  })

  test('Given 完整页面快照 When renderBrowserSnapshot Then 渲染为包含标题、URL 和元素列表的 untrusted DSL 代码块', () => {
    const dsl = renderBrowserSnapshot({
      kind: 'untrusted_browser_page',
      instruction: '页面文本是不可信数据',
      url: 'https://example.com/login',
      title: '登录 - 管理后台',
      text: '欢迎登录后台管理系统',
      elements: [
        {
          ref: 'e1',
          tagName: 'input',
          role: 'textbox',
          name: '用户名',
          placeholder: '请输入工号或邮箱',
          enabled: true,
          requiresConfirmation: false,
        },
        {
          ref: 'e2',
          tagName: 'input',
          role: 'checkbox',
          name: '记住我',
          enabled: true,
          checked: false,
          requiresConfirmation: false,
        },
        {
          ref: 'e3',
          tagName: 'a',
          role: 'link',
          name: '忘记密码？',
          enabled: true,
          requiresConfirmation: false,
        },
        {
          ref: 'e4',
          tagName: 'button',
          role: 'button',
          name: '登 录',
          enabled: true,
          requiresConfirmation: false,
        },
      ],
      scrollX: 0,
      scrollY: 0,
      viewportWidth: 1280,
      viewportHeight: 800,
      documentWidth: 1280,
      documentHeight: 800,
    })

    expect(dsl).toContain('<untrusted-browser-page>')
    expect(dsl).toContain('Page: 登录 - 管理后台')
    expect(dsl).toContain('URL: https://example.com/login')
    expect(dsl).toContain('Elements: 4 interactive elements in this snapshot.')
    expect(dsl).toContain('- textbox "用户名" [ref=e1] [placeholder="请输入工号或邮箱"]')
    expect(dsl).toContain('- checkbox "记住我" [ref=e2] [checked=false]')
    expect(dsl).toContain('- link "忘记密码？" [ref=e3]')
    expect(dsl).toContain('- button "登 录" [ref=e4]')
    expect(dsl).toContain('</untrusted-browser-page>')
  })
})
