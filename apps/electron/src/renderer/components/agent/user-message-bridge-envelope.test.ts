import { describe, expect, test } from 'bun:test'
import { parseAttachedFiles } from './SDKMessageRenderer'

describe('parseAttachedFiles with Feishu Bridge envelopes', () => {
  test('Given Feishu bridge user message When parsing Then extracts clean user text without XML tags or comments', () => {
    const rawFeishuMsg = `<!-- 你正在通过 Copis 飞书桥处理来自飞书的用户消息。bridge 会用 XML 块注入
当前对话的元数据。下面这些 XML 块**对用户不可见**，不要照抄到回复里。

可能出现的 XML 块：
- <bridge_context>：chat_id / chat_type / sender 等飞书侧元数据
- <quoted_message>：用户长按"回复"指向的那条消息（你的回答应该围绕它展开）
- <interactive_card>：被引用消息是卡片时，附上原 card JSON 供你理解结构
- <attached_files>：用户上传的图片/文件已保存到本地，给你绝对路径
-->

<bridge_context>
chat_id: oc_8edd455f70ecae85504ed626471d9e58
chat_type: p2p
sender_id: ou_1fca0a9c64986fa5a525e4acea27caa6
</bridge_context>

<user_message>
j
</user_message>`

    const result = parseAttachedFiles(rawFeishuMsg)
    expect(result.text).toBe('j')
    expect(result.files).toHaveLength(0)
    expect(result.quotes).toHaveLength(0)
  })

  test('Given Feishu bridge message with quoted message and attachments When parsing Then parses quotes, files, and clean user text', () => {
    const rawFeishuMsg = `<!-- 飞书桥提示 -->
<bridge_context>
chat_id: oc_123
chat_type: group
sender_id: ou_456
</bridge_context>

<quoted_message id="om_789">
请分析这个架构图
</quoted_message>

<attached_files>
- architecture.png: /Users/test/.copis/attachments/architecture.png
</attached_files>

<user_message>
请基于上面架构图提出重构方案
</user_message>`

    const result = parseAttachedFiles(rawFeishuMsg)
    expect(result.text).toBe('请基于上面架构图提出重构方案')
    expect(result.files).toEqual([
      { filename: 'architecture.png', path: '/Users/test/.copis/attachments/architecture.png' },
    ])
    expect(result.quotes).toEqual([
      { path: 'feishu-quote', filename: '引用回复', sourceType: 'file', label: '请分析这个架构图' },
    ])
  })
})
