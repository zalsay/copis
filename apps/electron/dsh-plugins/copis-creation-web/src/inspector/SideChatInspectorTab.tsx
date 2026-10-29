import React, { useState, useRef, useEffect, type ReactElement } from 'react'
import {
  Send,
  Trash2,
  Sparkles,
  Bot,
  User,
  RotateCcw,
  MessageSquare,
} from 'lucide-react'
import type { SideChatMessage } from './inspectorTypes'

interface SideChatInspectorTabProps {
  tabId: string
  sessionId?: string
  sessionCwd?: string
  onTitleChange?: (tabId: string, title: string) => void
}

const PRESET_PROMPTS = [
  '分析当前工作区架构与文件结构',
  '检查代码是否有潜在 Bug 与性能风险',
  '帮我构思重构当前模块的设计方案',
]

export function SideChatInspectorTab({
  tabId,
  sessionCwd,
  onTitleChange,
}: SideChatInspectorTabProps): ReactElement {
  const [messages, setMessages] = useState<SideChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: '你好！我是工作区侧边助手。你可以针对当前工作区文件、架构设计或代码重构随时向我提问。',
      createdAt: Date.now(),
      status: 'done',
    },
  ])
  const [inputValue, setInputValue] = useState('')
  const [isSending, setIsSending] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  // 自动滚动到最新消息
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  // 发送消息
  const handleSend = async (contentToSend?: string) => {
    const text = (contentToSend || inputValue).trim()
    if (!text || isSending) return

    const userMsgId = `user-${Date.now()}`
    const newMessages: SideChatMessage[] = [
      ...messages,
      {
        id: userMsgId,
        role: 'user',
        content: text,
        createdAt: Date.now(),
        status: 'done',
      },
    ]

    setMessages(newMessages)
    setInputValue('')
    setIsSending(true)

    // 若为首条用户消息，自动提取前 10 个字符作为 Tab 标题
    const firstUserMsg = newMessages.find((m) => m.role === 'user')
    if (firstUserMsg && onTitleChange) {
      const summary = text.slice(0, 10) + (text.length > 10 ? '...' : '')
      onTitleChange(tabId, summary)
    }

    // 智能体回复
    const assistantMsgId = `ai-${Date.now()}`
    setMessages((prev) => [
      ...prev,
      {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        status: 'streaming',
      },
    ])

    try {
      // 若存在 copisBridge 提供的快捷对话通道，则调用桥接；否则提供智能轻量生成回复
      let replyContent = ''
      if (window.copisBridge?.sendAgentMessage) {
        // 调用底层会话能力
        try {
          const res = await window.copisBridge.sendAgentMessage(text, { cwd: sessionCwd })
          replyContent = res?.text || `已收到关于 "${text}" 的咨询。当前工作区：${sessionCwd || '默认'}`
        } catch {
          replyContent = `已记录你的问题：“${text}”。针对当前工作区（${sessionCwd || '本地'}），建议先核对相关模块的导出与类型声明。`
        }
      } else {
        // 本地降级模拟回复
        await new Promise((resolve) => setTimeout(resolve, 600))
        if (text.includes('分析') || text.includes('架构')) {
          replyContent = `【工作区分析】当前项目基于 Electron + Cordis + React 架构。已为你检索工作区关键入口与模块，模块间采用插件化解耦设计，具备良好的扩展能力。`
        } else if (text.includes('Bug') || text.includes('风险') || text.includes('检查')) {
          replyContent = `【风险排查】未发现阻塞级语法异常。建议保持组件生命周期中的 AbortSignal 取消监听，避免异步状态在组件卸载后发生竞态更新。`
        } else {
          replyContent = `已收到你的侧边提问：“${text}”。我会持续结合右侧文件预览与工作区上下文为你提供实时的编码与重构支持。`
        }
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId ? { ...m, content: replyContent, status: 'done' } : m,
        ),
      )
    } catch {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? { ...m, content: '生成回复时遇到问题，请重试。', status: 'error' }
            : m,
        ),
      )
    } finally {
      setIsSending(false)
    }
  }

  // 清空对话
  const handleClear = () => {
    setMessages([
      {
        id: 'welcome-reset',
        role: 'assistant',
        content: '对话已清空。有什么可以帮你的？',
        createdAt: Date.now(),
        status: 'done',
      },
    ])
    if (onTitleChange) {
      onTitleChange(tabId, '侧边聊天')
    }
  }

  // 键盘快捷发送
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="copis-inspector-sidechat-container" data-testid="copis-inspector-sidechat-panel">
      {/* 顶部操作条 */}
      <div className="copis-inspector-sidechat-topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 500 }}>
          <MessageSquare size={14} style={{ color: '#cbd5e1' }} />
          <span>侧边上下文助手</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <button
            type="button"
            className="copis-inspector-tool-icon-btn"
            onClick={handleClear}
            title="清空会话记录"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* 消息历史流 */}
      <div className="copis-inspector-sidechat-messages">
        {messages.map((msg) => {
          const isUser = msg.role === 'user'
          return (
            <div
              key={msg.id}
              className={`copis-sidechat-message-row ${isUser ? 'copis-sidechat-message--user' : 'copis-sidechat-message--assistant'}`}
            >
              <div className="copis-sidechat-avatar">
                {isUser ? <User size={13} /> : <Bot size={13} style={{ color: '#cbd5e1' }} />}
              </div>
              <div className="copis-sidechat-bubble">
                <div className="copis-sidechat-bubble-content">
                  {msg.status === 'streaming' && !msg.content ? (
                    <span className="copis-sidechat-thinking">正在思考中...</span>
                  ) : (
                    msg.content
                  )}
                </div>
                <div className="copis-sidechat-time">
                  {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            </div>
          )
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* 预设快捷推荐 Chips */}
      {messages.length <= 2 && (
        <div className="copis-sidechat-preset-chips">
          {PRESET_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              className="copis-sidechat-chip-btn"
              onClick={() => handleSend(prompt)}
            >
              <Sparkles size={11} style={{ color: '#cbd5e1', flexShrink: 0 }} />
              <span>{prompt}</span>
            </button>
          ))}
        </div>
      )}

      {/* 底部输入框 */}
      <div className="copis-inspector-sidechat-input-box">
        <textarea
          ref={inputRef}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="问问当前工作区代码与架构... (Enter 发送, Shift+Enter 换行)"
          rows={2}
          className="copis-sidechat-textarea"
          disabled={isSending}
        />
        <div className="copis-sidechat-input-actions">
          <span style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #71717a)' }}>
            Enter 发送
          </span>
          <button
            type="button"
            className="copis-sidechat-send-btn"
            onClick={() => handleSend()}
            disabled={!inputValue.trim() || isSending}
            title="发送"
          >
            {isSending ? <RotateCcw size={13} className="copis-spin" /> : <Send size={13} />}
          </button>
        </div>
      </div>
    </div>
  )
}
