import { test, expect, describe } from 'bun:test'
import {
  readSessionMessagesFromString,
  groupIntoTurns,
  getGroupPreview,
  toTranscript,
  searchTurns,
  selectTurns,
  renderTranscriptMarkdown,
  collapseToolSummaries,
  summarizeToolInput,
  stripScheduledRunMarker,
  stripBridgeEnvelope,
} from './index'

/** 把对象数组序列化为 JSONL（每行一个 JSON）。 */
function jsonl(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n')
}

describe('快照去重（格式 B）', () => {
  // 同一 assistant 回合的 3 行递增快照，共享 message.id='m1'
  const raw = jsonl([
    { type: 'user', message: { content: [{ type: 'text', text: '读取文件' }] }, parent_tool_use_id: null },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Hel' }] }, parent_tool_use_id: null },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }] }, parent_tool_use_id: null },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'thinking', thinking: '想一下' }, { type: 'text', text: 'Hello world' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }] }, parent_tool_use_id: null },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'data' }] }, parent_tool_use_id: null },
    { type: 'result', subtype: 'success' },
  ])

  const turns = toTranscript(groupIntoTurns(readSessionMessagesFromString(raw)))

  test('合并为 user + assistant 两个 turn，下标稳定', () => {
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant'])
    expect(turns.map((t) => t.index)).toEqual([0, 1])
  })

  test('assistant 只取最完整快照，无拼接重复', () => {
    const a = turns[1]!
    expect(a.text).toBe('Hello world')
    expect(a.text).not.toContain('Hel\n')
  })

  test('thinking 块被丢弃', () => {
    expect(turns[1]!.text).not.toContain('想一下')
  })

  test('tool_use 压缩为单行摘要；tool_result 不进正文', () => {
    expect(turns[1]!.toolSummaries).toEqual(['Read file_path=/a'])
    expect(turns[1]!.text).not.toContain('data')
  })

  test('纯 tool_result 的 user 行不产生用户 turn', () => {
    expect(turns.filter((t) => t.role === 'user')).toHaveLength(1)
  })
})

describe('工具折叠 ×N', () => {
  test('连续相同工具摘要折叠计数', () => {
    expect(collapseToolSummaries(['OCR p=1', 'OCR p=1', 'OCR p=1', 'Read f=a'])).toEqual(['OCR p=1 ×3', 'Read f=a'])
  })

  test('summarizeToolInput 跳过空值并截断长值', () => {
    expect(summarizeToolInput('Read', { file_path: '/a', limit: 0, empty: '' })).toBe('Read file_path=/a limit=0')
    const long = 'x'.repeat(200)
    expect(summarizeToolInput('Bash', { command: long }).length).toBeLessThan(100)
  })
})

describe('SDK 压缩状态分组', () => {
  test('Given 压缩从进行中变为失败 When 分组 Then 原位更新同一个状态组', () => {
    const raw = jsonl([
      { type: 'user', message: { content: [{ type: 'text', text: '压缩测试' }] }, parent_tool_use_id: null },
      { type: 'assistant', message: { id: 'a1', content: [{ type: 'text', text: '准备压缩' }] }, parent_tool_use_id: null },
      { type: 'system', subtype: 'status', status: 'compacting' },
      { type: 'system', subtype: 'status', compact_result: 'failed', compact_error: 'token budget exhausted' },
    ])

    const groups = groupIntoTurns(readSessionMessagesFromString(raw))

    expect(groups.map((g) => g.type)).toEqual(['user', 'assistant-turn', 'system'])
    expect(getGroupPreview(groups[2]!)).toBe('上下文压缩失败')
    expect(groups[2]).toMatchObject({
      type: 'system',
      identityMessage: { status: 'compacting' },
      message: { compact_result: 'failed' },
    })
  })

  test('Given 压缩无需执行 When 分组 Then 用 no-op 终态替换进行中状态', () => {
    const raw = jsonl([
      { type: 'user', message: { content: [{ type: 'text', text: '/compact' }] }, parent_tool_use_id: null },
      { type: 'system', subtype: 'compacting' },
      { type: 'system', subtype: 'status', compact_result: 'noop', message: '当前上下文较小，暂时无需压缩。' },
      { type: 'result', subtype: 'success' },
    ])

    const groups = groupIntoTurns(readSessionMessagesFromString(raw))

    expect(groups.map((g) => g.type)).toEqual(['user', 'system'])
    expect(getGroupPreview(groups[1]!)).toBe('当前上下文较小，暂时无需压缩。')
    expect(groups[1]).toMatchObject({
      type: 'system',
      identityMessage: { subtype: 'compacting' },
      message: { compact_result: 'noop' },
    })
  })

  test('Given 压缩产生多个成功事件 When 分组 Then 只保留一条已完成分界线', () => {
    const raw = jsonl([
      { type: 'user', message: { content: [{ type: 'text', text: '/compact' }] }, parent_tool_use_id: null },
      { type: 'system', subtype: 'compacting' },
      { type: 'system', subtype: 'status', compact_result: 'success' },
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'result', subtype: 'success' },
    ])

    const groups = groupIntoTurns(readSessionMessagesFromString(raw))

    expect(groups.map((g) => g.type)).toEqual(['user', 'system'])
    expect(getGroupPreview(groups[1]!)).toBe('上下文已压缩')
    expect(groups[1]).toMatchObject({
      type: 'system',
      identityMessage: { subtype: 'compacting' },
      message: { subtype: 'compact_boundary' },
    })
  })

  test('Given 上一次压缩已结束且下一次立即开始 When 分组 Then 保留两个压缩周期', () => {
    const raw = jsonl([
      { type: 'system', subtype: 'compacting' },
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'system', subtype: 'compacting' },
    ])

    const groups = groupIntoTurns(readSessionMessagesFromString(raw))

    expect(groups).toHaveLength(2)
    expect(getGroupPreview(groups[0]!)).toBe('上下文已压缩')
    expect(getGroupPreview(groups[1]!)).toBe('正在压缩上下文...')
  })
})

describe('旧扁平格式（格式 A）归一', () => {
  const raw = jsonl([
    { id: '1', role: 'user', content: '你好', createdAt: 1 },
    { id: '2', role: 'assistant', content: '旧版回复', createdAt: 2 },
    { id: '3', role: 'assistant', content: '', createdAt: 3 },
  ])
  const turns = toTranscript(groupIntoTurns(readSessionMessagesFromString(raw)))

  test('role 字段被识别并转换为 SDKMessage', () => {
    expect(turns[0]).toMatchObject({ role: 'user', text: '你好' })
    expect(turns[1]).toMatchObject({ role: 'assistant', text: '旧版回复' })
  })
})

describe('容错与渐进式读取原语', () => {
  const raw = jsonl([
    { type: 'user', message: { content: [{ type: 'text', text: '问题甲' }] }, parent_tool_use_id: null },
    { type: 'assistant', message: { id: 'a1', content: [{ type: 'text', text: '答案含关键词 needle' }] }, parent_tool_use_id: null },
    { type: 'user', message: { content: [{ type: 'text', text: '问题乙' }] }, parent_tool_use_id: null },
    { type: 'assistant', message: { id: 'a2', content: [{ type: 'text', text: '无关回答' }] }, parent_tool_use_id: null },
  ])

  test('损坏行被静默跳过', () => {
    const withBad = raw + '\n{ 坏行不是 json\n'
    const msgs = readSessionMessagesFromString(withBad)
    expect(msgs.length).toBe(4)
  })

  const turns = toTranscript(groupIntoTurns(readSessionMessagesFromString(raw)))

  test('searchTurns 返回命中 turn 下标', () => {
    const hits = searchTurns(turns, 'needle')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.index).toBe(1)
    expect(hits[0]!.snippet).toContain('needle')
  })

  test('selectTurns 按 range 截取', () => {
    expect(selectTurns(turns, { range: [2, 3] }).map((t) => t.index)).toEqual([2, 3])
    expect(selectTurns(turns, { head: 1 }).map((t) => t.index)).toEqual([0])
    expect(selectTurns(turns, { tail: 1 }).map((t) => t.index)).toEqual([3])
  })

  test('renderTranscriptMarkdown 按角色分段', () => {
    const md = renderTranscriptMarkdown(turns, { sessionId: 'demo' })
    expect(md).toContain('# Session: demo')
    expect(md).toContain('## 用户')
    expect(md).toContain('## 助手')
    expect(md).toContain('答案含关键词 needle')
  })
})

describe('Copis 品牌迁移兼容', () => {
  test('Given 旧版定时任务消息 When 提取预览 Then 移除旧 Proma 标记', () => {
    expect(stripScheduledRunMarker('请执行任务 <!--PROMA_SCHEDULED_RUN-->')).toBe('请执行任务')
  })
})

describe('飞书与外部 Bridge 信封剥除', () => {
  test('Given 飞书桥接注入的消息 When 执行 stripBridgeEnvelope Then 仅提取用户真实提问', () => {
    const rawFeishuMsg = `<!-- 你正在通过 Copis 飞书桥处理来自飞书的用户消息。bridge 会用 XML 块注入
当前对话的元数据。下面这些 XML 块**对用户不可见**，不要照抄到回复里。
-->
<bridge_context>
chat_id: oc_8edd455f70ecae85504ed626471d9e58
chat_type: p2p
sender_id: ou_1fca0a9c64986fa5a525e4acea27caa6
</bridge_context>

<user_message>
帮我写一个快速排序算法
</user_message>`

    expect(stripBridgeEnvelope(rawFeishuMsg)).toBe('帮我写一个快速排序算法')
  })

  test('Given 飞书消息包含引用与卡片 XML When 获取预览 Then 去除所有桥接信封', () => {
    const rawFeishuMsg = `<!-- 飞书桥提示 -->
<bridge_context>
chat_id: oc_123
chat_type: group
sender_id: ou_456
</bridge_context>
<quoted_message id="om_789">原消息内容</quoted_message>
<interactive_card>{"elements": []}</interactive_card>
<group_extra>群聊元数据</group_extra>
<user_message>
测试用户提问
</user_message>`

    const raw = jsonl([
      { type: 'user', message: { content: [{ type: 'text', text: rawFeishuMsg }] }, parent_tool_use_id: null },
    ])
    const groups = groupIntoTurns(readSessionMessagesFromString(raw))
    expect(getGroupPreview(groups[0]!)).toBe('测试用户提问')
  })
})
