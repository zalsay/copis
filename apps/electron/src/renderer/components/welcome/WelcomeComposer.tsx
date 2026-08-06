/**
 * WelcomeComposer — 欢迎页默认 Agent 输入区域。
 *
 * 浏览器模式通过本地 HTTP API 创建 Agent 会话，始终绑定默认项目。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { CornerDownLeft, Loader2, Paperclip, Square, Zap } from 'lucide-react'
import type { AgentSessionMeta, AgentWorkspace, ModelOption, SDKMessage, WorkingMode } from '@copis/shared'
import {
  COPIS_WORKING_CHANNEL_ID,
  COPIS_WORKING_EXPERT_MODEL_ID,
  createCopisWorkingChannel,
  workingModeToModelId,
} from '@copis/shared'
import { workingClientConfigAtom } from '@/atoms/working-atoms'
import { ModelSelector } from '@/components/model/ModelSelector'
import { RichTextInput } from '@/components/ai-elements/rich-text-input'
import { InputToolbarOverflow, type ToolbarItem } from '@/components/ai-elements/InputToolbarOverflow'
import { SpeechButton } from '@/components/ai-elements/speech-button'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  inputToolbarButtonClass,
  inputToolbarDangerButtonClass,
  inputToolbarDisabledButtonClass,
  inputToolbarSendButtonClass,
} from '@/components/ai-elements/input-toolbar-styles'

interface WelcomeEntry {
  role: 'user' | 'assistant'
  text: string
}

const DEFAULT_WORKSPACE_LOAD_TIMEOUT_MS = 10_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getAssistantText(message: SDKMessage): string {
  if (message.type !== 'assistant') return ''
  const candidate = message as unknown as { message?: { content?: unknown } }
  const content = candidate.message?.content
  if (!Array.isArray(content)) return ''
  return content.map((block: unknown) => {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return ''
    return block.text
  }).join('')
    .trim()
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Agent 请求失败，请稍后重试。'
}

export function WelcomeComposer(): React.ReactElement {
  const [workspace, setWorkspace] = React.useState<AgentWorkspace | null>(null)
  const [session, setSession] = React.useState<AgentSessionMeta | null>(null)
  const [content, setContent] = React.useState('')
  const [entries, setEntries] = React.useState<WelcomeEntry[]>([])
  const [loading, setLoading] = React.useState(true)
  const [sending, setSending] = React.useState(false)
  const [workingMode, setWorkingMode] = React.useState<WorkingMode>('fast')
  const [error, setError] = React.useState<string | null>(null)
  const sessionRef = React.useRef<AgentSessionMeta | null>(null)
  const workingClientConfig = useAtomValue(workingClientConfigAtom)
  const workingChannel = React.useMemo(
    () => workingClientConfig ? createCopisWorkingChannel(workingClientConfig.backendUrl) : null,
    [workingClientConfig],
  )
  const selectedModelId = workingModeToModelId(workingMode)

  React.useEffect(() => {
    let disposed = false

    const loadDefaultWorkspace = async (): Promise<void> => {
      let timeoutId: number | undefined
      try {
        const workspaces = await new Promise<AgentWorkspace[]>((resolve, reject) => {
          timeoutId = window.setTimeout(() => {
            reject(new Error('默认项目连接超时，请刷新页面后重试。'))
          }, DEFAULT_WORKSPACE_LOAD_TIMEOUT_MS)
          window.electronAPI.listAgentWorkspaces().then(resolve, reject)
        })
        if (disposed) return

        const selected = workspaces.find((item) => item.slug === 'default')
          ?? workspaces[0]
        if (!selected) {
          setError('默认项目暂不可用，请重启 Copis 后重试。')
          return
        }
        setWorkspace(selected)
      } catch (loadError: unknown) {
        if (!disposed) setError(getErrorMessage(loadError))
      } finally {
        if (timeoutId !== undefined) window.clearTimeout(timeoutId)
        if (!disposed) setLoading(false)
      }
    }

    void loadDefaultWorkspace()

    return () => { disposed = true }
  }, [])

  const handleSend = React.useCallback(async (): Promise<void> => {
    const userMessage = content.trim()
    if (!userMessage || sending || !workspace) return

    setContent('')
    setError(null)
    setEntries((previous) => [...previous, { role: 'user', text: userMessage }])
    setSending(true)

    try {
      let activeSession = sessionRef.current
      if (!activeSession) {
        activeSession = await window.electronAPI.createAgentSession(
          undefined,
          COPIS_WORKING_CHANNEL_ID,
          workspace.id,
          selectedModelId,
        )
        sessionRef.current = activeSession
        setSession(activeSession)
      }

      await window.electronAPI.sendAgentMessage({
        sessionId: activeSession.id,
        userMessage,
        rawUserMessage: userMessage,
        channelId: COPIS_WORKING_CHANNEL_ID,
        modelId: selectedModelId,
        agentRuntime: 'pi',
        workspaceId: workspace.id,
        workingMode,
        permissionModeOverride: 'bypassPermissions',
      })

      const sdkMessages = await window.electronAPI.getAgentSessionSDKMessages(activeSession.id)
      const assistantText = sdkMessages.map(getAssistantText).filter(Boolean).at(-1)
      if (assistantText) {
        setEntries((previous) => [...previous, { role: 'assistant', text: assistantText }])
      }
    } catch (sendError: unknown) {
      setError(getErrorMessage(sendError))
    } finally {
      setSending(false)
    }
  }, [content, selectedModelId, sending, workingMode, workspace])

  const handleStop = React.useCallback((): void => {
    const activeSession = sessionRef.current
    if (!activeSession) return
    void window.electronAPI.stopAgent(activeSession.id).catch((stopError: unknown) => {
      setError(getErrorMessage(stopError))
    })
  }, [])

  const sendDisabled = loading || sending || !workspace || content.trim().length === 0

  const handleModelSelect = React.useCallback((option: ModelOption): void => {
    if (option.channelId !== COPIS_WORKING_CHANNEL_ID) return
    setWorkingMode(option.modelId === COPIS_WORKING_EXPERT_MODEL_ID ? 'expert' : 'fast')
  }, [])

  const toolbarItems = React.useMemo<ToolbarItem[]>(() => [
    {
      key: 'fast-response',
      node: (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={inputToolbarButtonClass}
          aria-label="快速响应"
          title="快速响应"
        >
          <Zap className="size-5" />
        </Button>
      ),
    },
    {
      key: 'speech',
      node: <SpeechButton disabled={loading || sending} className={inputToolbarButtonClass} />,
    },
    {
      key: 'attach-content',
      node: (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={inputToolbarButtonClass}
          onClick={() => { void window.electronAPI.openFileDialog() }}
          disabled={loading || sending}
          aria-label="附加文件或文件夹"
          title="附加文件或文件夹"
        >
          <Paperclip className="size-[17px]" />
        </Button>
      ),
    },
  ], [loading, sending])

  const trailingNode = (
    <>
      <ModelSelector
        filterChannelId={COPIS_WORKING_CHANNEL_ID}
        additionalChannels={workingChannel ? [workingChannel] : []}
        externalSelectedModel={{ channelId: COPIS_WORKING_CHANNEL_ID, modelId: selectedModelId }}
        onModelSelect={handleModelSelect}
        showChannelInTrigger
        triggerChannelName="Copis"
        useCopisLogo
        useSharedOpenState
      />
      {sending ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={inputToolbarDangerButtonClass}
          onClick={handleStop}
          aria-label="停止 Agent"
          title="停止 Agent"
        >
          <Square className="size-4" fill="currentColor" strokeWidth={0} />
        </Button>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={sendDisabled ? inputToolbarDisabledButtonClass : inputToolbarSendButtonClass}
          onClick={() => { void handleSend() }}
          disabled={sendDisabled}
          aria-label="发送消息"
          title="发送消息"
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : <CornerDownLeft className="size-[22px]" />}
        </Button>
      )}
    </>
  )

  return (
    <div className="w-full max-w-[730px] space-y-3">
      {entries.length > 0 && (
        <div className="max-h-64 space-y-2 overflow-y-auto px-1" aria-live="polite">
          {entries.map((entry, index) => (
            <div
              key={`${entry.role}-${index}`}
              className={cn(
                'rounded-xl px-3 py-2 text-sm leading-6',
                entry.role === 'user'
                  ? 'ml-8 bg-primary text-primary-foreground'
                  : 'mr-8 bg-muted/60 text-foreground',
              )}
            >
              {entry.text}
            </div>
          ))}
        </div>
      )}

      <div className="rounded-[19px] border-[0.5px] border-border bg-background/70 shadow-[0_20px_60px_rgba(0,0,0,0.26)] backdrop-blur-[18px] transition-colors focus-within:border-foreground/20 dark:border-white/[0.07] dark:bg-[rgba(47,47,47,0.76)]">
        <RichTextInput
          key={loading ? 'default-project-loading' : 'default-project-ready'}
          value={content}
          onChange={setContent}
          onSubmit={() => { void handleSend() }}
          placeholder={loading
            ? '正在连接默认项目...'
            : '输入消息...（@ 引用文件，/ 调用 Skill，# 使用 MCP，& 引用会话，～ 引用待办/日程；Enter 发送）'}
          autoFocusTrigger="welcome-agent-composer"
          disabled={loading || sending || !workspace}
          collapsible
          enableMentions
          workspacePath={workspace?.projectRootPath ?? null}
          workspaceSlug={workspace?.slug ?? null}
          sessionId={session?.id ?? null}
        />
        <InputToolbarOverflow items={toolbarItems} trailing={trailingNode} />
      </div>

      {error && <p className="px-1 text-xs text-destructive">{error}</p>}
      {session && !error && !sending && entries.length > 0 && (
        <span className="sr-only">Agent 会话已连接</span>
      )}
    </div>
  )
}
