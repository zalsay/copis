import { expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseHTML } from 'linkedom'
import { DshGroupChatWorkspace } from './DshGroupChatWorkspace'
import { readSharedMessage } from './shared-room-data'

function bubble(senderType: string, content: string) {
  const msg = readSharedMessage({ roomId:'r', messageId:'m', seq:1, senderType, content, createdAt:'2026-11-27T00:00:00Z' }, 'r')
  const html = renderToStaticMarkup(<DshGroupChatWorkspace shared={{ roomId:'r', name:'讨论', userId:'1', status:null, historyAction:null, canSend:false, send:async()=>{}, download:async()=>new File([], "示例"), messages:[msg] }} />)
  return parseHTML(html).document.querySelector('.dsh-room-bubble')!
}
const text = '我是群里负责**基金与 ETF**这块的。\n\n### 概念分析\n\n- 行业基金\n- 指数增强\n\n| 项目 | 含义 |\n| --- | --- |\n| ETF | 基金 |\n\n```js\nconst value = "**原样**"\n```'
test('群智能体文本按 Markdown 展示，不改代码块内容或消息原文', () => {
  const node = bubble('agent', text)
  expect(node.querySelector('strong')?.textContent).toBe('基金与 ETF')
  expect(node.querySelector('h3')?.textContent).toBe('概念分析')
  expect(node.querySelectorAll('ul > li')).toHaveLength(2)
  expect(node.querySelector('tbody td')?.textContent).toBe('ETF')
  expect(node.querySelector('pre code')?.textContent?.trim()).toBe('const value = "**原样**"')
})
for (const type of ['user','system']) test(`${type} 群消息保持纯文本`, () => {
  const node = bubble(type, text)
  expect(node.textContent).toBe(text)
  expect(node.querySelector('strong, h3, li, table, code')).toBeNull()
})
test('智能体回复中的 HTML、文件链接与图片不触发本地能力或外部加载', () => {
  const node = bubble('agent', '<iframe src="https://example.invalid"></iframe>\n\n[本机](file:///etc/hosts) ![图](https://example.invalid/a.png) [网页](https://example.org)')
  expect(node.querySelector('iframe, img, a[href^="file:"]')).toBeNull()
  expect(node.querySelector('a[href="https://example.org"]')?.textContent).toBe('网页')
})
