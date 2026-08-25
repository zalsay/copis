import { describe, expect, test } from 'bun:test'
import type { SDKMessage, SDKUserMessage } from '@copis/shared'
import {
  appendHistoryEntry,
  extractUserHistoryFromMessages,
  mergeSessionAndGlobalHistory,
} from './composer-history'

describe('composer-history 单元测试', () => {
  describe('appendHistoryEntry', () => {
    test('Given 空白文本 When 追加历史 Then 保持原数组不插入空项', () => {
      const history = ['first']
      expect(appendHistoryEntry(history, '   ')).toBe(history)
      expect(appendHistoryEntry(history, '')).toBe(history)
    })

    test('Given 与末尾相同的文本 When 连续追加 Then 自动去重', () => {
      const history = ['hello']
      const updated = appendHistoryEntry(history, 'hello')
      expect(updated).toBe(history)

      const withNew = appendHistoryEntry(history, 'world')
      expect(withNew).toEqual(['hello', 'world'])
      expect(appendHistoryEntry(withNew, 'world')).toBe(withNew)
    })

    test('Given 历史超过上限 When 追加新项 Then 截断保留最新 N 条', () => {
      let history: string[] = []
      for (let i = 0; i < 110; i++) {
        history = appendHistoryEntry(history, `prompt-${i}`, 100)
      }
      expect(history.length).toBe(100)
      expect(history[0]).toBe('prompt-10')
      expect(history[99]).toBe('prompt-109')
    })
  })

  describe('extractUserHistoryFromMessages', () => {
    test('Given 包含普通文本、附件、Bridge 封装与合成消息的 SDKMessage 列表 When 提取历史 Then 仅返回纯净用户提问', () => {
      const messages: SDKMessage[] = [
        {
          type: 'user',
          message: {
            content: [{ type: 'text', text: '你好，请帮我检查代码' }],
          },
          parent_tool_use_id: null,
        } as SDKUserMessage,
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '好的，请提供代码' }],
          },
          parent_tool_use_id: null,
        } as SDKMessage,
        {
          type: 'user',
          isSynthetic: true,
          message: {
            content: [{ type: 'text', text: 'Skill 展开的系统 prompt' }],
          },
          parent_tool_use_id: null,
        } as SDKUserMessage,
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'text',
                text: '这是带附件的提问\n<attached_files><file path="/foo/bar.ts">content</file></attached_files>',
              },
            ],
          },
          parent_tool_use_id: null,
        } as SDKUserMessage,
        {
          type: 'user',
          message: {
            content: [{ type: 'text', text: '/compact' }],
          },
          parent_tool_use_id: null,
        } as SDKUserMessage,
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'text',
                text: '<!--COPIS_SCHEDULED_RUN-->定时任务执行 <!--COPIS_SCHEDULED_RUN-->',
              },
            ],
          },
          parent_tool_use_id: null,
        } as SDKUserMessage,
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'text',
                text: '<bridge_context><sender>张三</sender></bridge_context><user_message>飞书提问文本</user_message>',
              },
            ],
          },
          parent_tool_use_id: null,
        } as SDKUserMessage,
      ]

      const history = extractUserHistoryFromMessages(messages)
      expect(history).toEqual([
        '你好，请帮我检查代码',
        '这是带附件的提问',
        '定时任务执行',
        '飞书提问文本',
      ])
    })
  })

  describe('mergeSessionAndGlobalHistory', () => {
    test('Given 全局历史与当前会话历史 When 合并 Then 会话最近输入优先排在最后且去重', () => {
      const globalHistory = ['cmd 1', 'cmd 2', 'session cmd 1', 'cmd 3']
      const sessionHistory = ['session cmd 1', 'session cmd 2']

      const merged = mergeSessionAndGlobalHistory(globalHistory, sessionHistory, 100)
      expect(merged).toEqual(['cmd 1', 'cmd 2', 'cmd 3', 'session cmd 1', 'session cmd 2'])
    })

    test('Given 会话历史为空 When 合并 Then 返回全局历史', () => {
      const globalHistory = ['cmd 1', 'cmd 2']
      const sessionHistory: string[] = []

      const merged = mergeSessionAndGlobalHistory(globalHistory, sessionHistory, 100)
      expect(merged).toEqual(['cmd 1', 'cmd 2'])
    })
  })
})
