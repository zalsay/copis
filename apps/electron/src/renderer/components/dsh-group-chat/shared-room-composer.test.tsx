import React from 'react'
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseHTML } from 'linkedom'
import { DshGroupChatWorkspace } from './DshGroupChatWorkspace'

test('共享群未就绪时仍可选择本地附件，发送保持禁用，首行提示 @ 用法', () => {
  const html = renderToStaticMarkup(<DshGroupChatWorkspace shared={{ roomId: 'r', name: '共享群', userId: '1',
    status: null, historyAction: null, canSend: false, messages: [], send: async () => {}, download: async () => new File([], '文件'),
  }} />)
  const { document } = parseHTML(html)
  expect(document.querySelector('[aria-label="添加群附件"]')?.hasAttribute('disabled')).toBe(false)
  expect(document.querySelector('[title="发送消息"]')?.hasAttribute('disabled')).toBe(true)
  expect(document.querySelector('[role="textbox"]')?.getAttribute('data-placeholder')).toContain('@智能体发起对话')
})
