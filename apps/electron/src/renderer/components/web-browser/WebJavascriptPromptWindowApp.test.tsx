import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { parseHTML } from 'linkedom'
import * as React from 'react'
import { Simulate } from 'react-dom/test-utils'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot, type Root } from 'react-dom/client'
import type { WebJavascriptPromptRequest } from '@copis/shared'

const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act

const { WebJavascriptPromptWindowApp } = await import('./WebJavascriptPromptWindowApp')

let root: Root | null = null
let domWindow: ReturnType<typeof parseHTML>['window'] | null = null
let getRequest: ReturnType<typeof mock>
let resolveRequest: ReturnType<typeof mock>
let cancelRequest: ReturnType<typeof mock>

function installDom(): void {
  if (!domWindow) {
    const parsed = parseHTML('<html><body><div id="root"></div></body></html>')
    domWindow = parsed.window
    Object.defineProperty(domWindow, 'location', { value: { search: '?requestId=req-1' }, configurable: true })
    Object.assign(globalThis, {
      window: domWindow,
      document: domWindow.document,
      navigator: domWindow.navigator,
      Event: domWindow.Event,
      KeyboardEvent: domWindow.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    })
  } else {
    domWindow.document.body.innerHTML = '<div id="root"></div>'
  }
  getRequest = mock(() => Promise.resolve<WebJavascriptPromptRequest | null>({
    requestId: 'req-1',
    message: '请输入名称',
    defaultPrompt: 'Copis',
  }))
  resolveRequest = mock(() => Promise.resolve(true))
  cancelRequest = mock(() => Promise.resolve(true))
  Object.assign(domWindow, {
    webJavascriptPrompt: { get: getRequest, resolve: resolveRequest, cancel: cancelRequest },
  })
}

async function renderPrompt(): Promise<void> {
  root = createRoot(document.getElementById('root')!)
  await act(async () => {
    root!.render(<WebJavascriptPromptWindowApp />)
    await Promise.resolve()
  })
}

function buttons(): HTMLButtonElement[] {
  return [...document.querySelectorAll('button')] as HTMLButtonElement[]
}

beforeEach(() => installDom())
afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount())
    root = null
  }
})

describe('网页 JavaScript prompt 渲染入口行为', () => {
  test('加载请求后显示消息和默认值，确认提交编辑后的值', async () => {
    await renderPrompt()
    const input = document.querySelector('input') as HTMLInputElement
    expect(document.body.textContent).toContain('请输入名称')
    input.focus()
    expect(buttons().map((button) => button.textContent)).toEqual(['取消', '确认'])

    expect(input.value).toBe('Copis')
    expect(document.body.textContent).toContain('请输入名称')
    await act(async () => {
      Simulate.change(input, { target: { value: '新名称' } as unknown as EventTarget })
      await Promise.resolve()
    })
    await act(async () => {
      Simulate.click(buttons().find((button) => button.textContent === '确认')!)
    })

    expect(resolveRequest).toHaveBeenCalledWith({ requestId: 'req-1', accept: true, promptText: '新名称' })
    expect(cancelRequest).not.toHaveBeenCalled()
  })

  test('确认按钮和 Enter 在请求返回前不提交空值', async () => {
    let resolveGet!: (request: WebJavascriptPromptRequest) => void
    getRequest = mock(() => new Promise<WebJavascriptPromptRequest>((resolve) => { resolveGet = resolve }))
    ;(domWindow as Window & typeof globalThis).webJavascriptPrompt.get = getRequest
    await renderPrompt()
    const input = document.querySelector('input') as HTMLInputElement
    const confirm = buttons().find((button) => button.textContent === '确认')!

    expect(confirm.disabled).toBe(true)
    await act(async () => {
      Simulate.click(confirm)
      Simulate.keyDown(input, { key: 'Enter' })
    })
    expect(resolveRequest).not.toHaveBeenCalled()

    await act(async () => {
      resolveGet({ requestId: 'req-1', message: '请输入名称', defaultPrompt: '默认值' })
      await Promise.resolve()
    })
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('默认值')
  })

  test('取消按钮和 Escape 取消请求，输入框有焦点意图', async () => {
    await renderPrompt()
    const input = document.querySelector('input') as HTMLInputElement
    expect(document.body.textContent).toContain('请输入名称')
    input.focus()
    const cancel = buttons().find((button) => button.textContent === '取消')!
    expect(cancel.disabled).toBe(false)

    await act(async () => {
      const escape = new domWindow!.Event('keydown', { bubbles: true })
      Object.defineProperty(escape, 'key', { value: 'Escape' })
      input.dispatchEvent(escape)
      await Promise.resolve()
    })
    expect(cancelRequest).toHaveBeenCalledWith('req-1')
  })

  test('确认与取消按钮在请求返回后分别提交和取消，并保留自动聚焦意图', async () => {
    expect(renderToStaticMarkup(<WebJavascriptPromptWindowApp />)).toContain('autofocus=""')
    await renderPrompt()
    const cancel = buttons().find((button) => button.textContent === '取消')!
    await act(async () => cancel.click())
    expect(cancelRequest).toHaveBeenCalledWith('req-1')
  })
})
