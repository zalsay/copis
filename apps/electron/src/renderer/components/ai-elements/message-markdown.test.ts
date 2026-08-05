import { expect, test } from 'bun:test'
import { normalizeNamedReferenceDelimiters, remarkMentions } from './message-markdown'

test('Markdown 引用兼容 > Given 普通文本中的旧分隔符 When 规范化 Then 转为双冒号', () => {
  expect(normalizeNamedReferenceDelimiters('&todo:todo-1~修复启动问题')).toBe('&todo:todo-1::修复启动问题')
})

test('Markdown 引用兼容 > Given 代码块中的旧分隔符 When 规范化 Then 保持代码原文', () => {
  const markdown = '```text\n&todo:todo-1~修复启动问题\n```'
  expect(normalizeNamedReferenceDelimiters(markdown)).toBe(markdown)
})

test('Markdown mention 解析 > Given 带标题的 Todo 引用 When 运行 remark 插件 Then 生成 mention 链接节点', () => {
  const tree = {
    type: 'root' as const,
    children: [{ type: 'text' as const, value: '&todo:todo-1::修复启动问题' }],
  }

  remarkMentions()(tree)

  expect(tree.children[0]).toMatchObject({
    type: 'link',
    url: 'mention://todo/todo-1%3A%3A%E4%BF%AE%E5%A4%8D%E5%90%AF%E5%8A%A8%E9%97%AE%E9%A2%98',
  })
})
