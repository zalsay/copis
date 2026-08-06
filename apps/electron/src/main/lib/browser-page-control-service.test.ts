import { describe, expect, test } from 'bun:test'
import {
  assertBrowserPageMutationAllowed,
  classifyBrowserPageElement,
  createBrowserPageControlService,
  type BrowserPageControlRuntime,
} from './browser-page-control-service'

function createRuntime(mode: 'ask' | 'authorized'): {
  runtime: BrowserPageControlRuntime
  commands: string[]
} {
  const commands: string[] = []
  const runtime: BrowserPageControlRuntime = {
    getContext: () => ({ tabId: 'tab-1' }),
    getControlMode: () => mode,
    getTab: () => ({ id: 'tab-1', url: 'https://example.com/form', title: '示例表单' }),
    navigate: () => undefined,
    async sendCommand(input) {
      commands.push(input.method)
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
              }],
            },
          },
        }
      }
      if (input.method === 'Runtime.evaluate') {
        return { result: { value: { ok: true, x: 120, y: 80 } } }
      }
      return {}
    },
  }
  return { runtime, commands }
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
    expect(() => assertBrowserPageMutationAllowed('ask')).toThrow('授权')
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

  test('Given 授权模式和有效元素引用 When Agent 点击 Then 通过 CDP 派发可信鼠标事件', async () => {
    const { runtime, commands } = createRuntime('authorized')
    const service = createBrowserPageControlService(runtime)
    await service.observe('session-1')

    await service.click('session-1', 'e1')

    expect(commands).toEqual([
      'Runtime.enable',
      'Runtime.evaluate',
      'Runtime.evaluate',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
    ])
  })

  test('Given 授权模式和敏感字段 When Agent 尝试输入 Then 在发送输入命令前拒绝', async () => {
    const { runtime, commands } = createRuntime('authorized')
    const service = createBrowserPageControlService(runtime)
    await service.observe('session-1')

    await expect(service.typeText('session-1', 'e2', 'secret')).rejects.toThrow('敏感')
    expect(commands).toEqual(['Runtime.enable', 'Runtime.evaluate'])
  })

  test('Given 授权模式和普通字段 When Agent 输入文本 Then 使用 CDP 可信键盘事件', async () => {
    const { runtime, commands } = createRuntime('authorized')
    const service = createBrowserPageControlService(runtime)
    await service.observe('session-1')

    await service.typeText('session-1', 'e1', 'Copis')

    expect(commands).toContain('Input.insertText')
  })

  test('Given 授权模式 When Agent 滚动或导航 Then 只调用受限高层能力', async () => {
    const { runtime, commands } = createRuntime('authorized')
    const navigations: string[] = []
    runtime.navigate = (_tabId, url) => { navigations.push(url) }
    const service = createBrowserPageControlService(runtime)

    await service.scroll('session-1', 0, 500)
    await service.navigate('session-1', 'https://example.com/next')

    expect(commands).toEqual(['Runtime.evaluate'])
    expect(navigations).toEqual(['https://example.com/next'])
  })
})
