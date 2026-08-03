/**
 * FeishuSettings - 飞书集成设置页
 *
 * 双 Tab 布局：
 * - Bot 配置：飞书应用凭证、连接状态、默认配置、创建引导、命令说明
 * - 绑定管理：查看/管理所有活跃的飞书聊天绑定（群聊/单聊的工作区/会话分配）
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { Loader2, CheckCircle2, XCircle, Users, User, Trash2, RefreshCw, Copy, Check, Power, PowerOff, Plus, ChevronRight, PlayCircle, QrCode, Archive, ArchiveRestore, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SettingsSection } from './primitives/SettingsSection'
import { SettingsCard } from './primitives/SettingsCard'
import { SettingsInput } from './primitives/SettingsInput'
import { SettingsSecretInput } from './primitives/SettingsSecretInput'
import { SettingsRow } from './primitives/SettingsRow'
import { LocalProjectBadge } from '@/components/agent/LocalProjectBadge'
import { feishuBotStatesAtom, feishuBindingsAtom } from '@/atoms/feishu-atoms'
import { agentWorkspacesAtom, agentSessionsAtom } from '@/atoms/agent-atoms'
import { cn } from '@/lib/utils'
import { copyTextToClipboard } from '@/lib/clipboard'
import {
  FEISHU_BINDING_PAGE_SIZE,
  filterFeishuBindings,
  groupFeishuBindings,
  type FeishuBindingSourceFilter,
  type FeishuBindingTypeFilter,
  type FeishuBindingViewMode,
} from '@/lib/feishu-bindings'
import type { AgentSessionMeta, AgentWorkspace, FeishuTestResult, FeishuChatBinding, FeishuBotConfig, FeishuBotBridgeState, FeishuRegisterAppQRCode, FeishuRegisterAppStatus } from '@proma/shared'

// ===== 常量 =====

type FeishuTab = 'config' | 'bindings'

const TAB_OPTIONS: Array<{ value: FeishuTab; label: string }> = [
  { value: 'config', label: 'Bot 配置' },
  { value: 'bindings', label: '绑定管理' },
]

/** 连接状态颜色映射 */
const STATUS_CONFIG = {
  disconnected: { color: 'bg-gray-400', label: '未连接' },
  connecting: { color: 'bg-amber-400 animate-pulse', label: '连接中...' },
  connected: { color: 'bg-green-500', label: '已连接' },
  error: { color: 'bg-red-500', label: '连接错误' },
} as const


/**
 * 视频教程入口配置。
 * 后续把 url 填上即可在飞书配置页顶部显示视频教程卡片，留空则不渲染。
 * 支持 B 站 / YouTube 等任意 iframe 嵌入地址，例如：
 *   B 站：//player.bilibili.com/player.html?bvid=BVxxxxxx&autoplay=0
 *   YouTube：https://www.youtube.com/embed/VIDEO_ID
 *
 * TODO: 教程视频录制完成后，把 url 填回（之前测试用过 'https://www.bilibili.com/video/BV1z8G867Epv'）。
 */
const FEISHU_TUTORIAL_VIDEO = {
  url: '',
  title: '飞书 Bot 配置视频教程',
  description: '跟着视频一步步配，3 分钟内完成飞书 Bot 接入',
} as const

// ===== 视频教程组件 =====

/** 把任意视频链接归一化为可 iframe 嵌入的 URL（B 站 / YouTube / 直链皆支持） */
function normalizeVideoEmbedUrl(raw: string): { embedUrl: string; isIframe: boolean } | null {
  const url = raw.trim()
  if (!url) return null

  // B 站普通页：https://www.bilibili.com/video/BVxxxxxx[?p=N] → player.bilibili.com
  const bvMatch = url.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]+)/)
  if (bvMatch) {
    const pMatch = url.match(/[?&]p=(\d+)/)
    const pageParam = pMatch ? `&page=${pMatch[1]}` : ''
    return { embedUrl: `https://player.bilibili.com/player.html?bvid=${bvMatch[1]}&autoplay=0&high_quality=1&danmaku=0${pageParam}`, isIframe: true }
  }
  // B 站短链（b23.tv/xxx）：无法在前端跟随重定向，让 iframe 自己处理
  if (/^https?:\/\/b23\.tv\//.test(url)) {
    return { embedUrl: url, isIframe: true }
  }
  // B 站 player 直链
  if (/^https?:\/\/player\.bilibili\.com\//.test(url)) {
    return { embedUrl: url, isIframe: true }
  }
  // YouTube watch / shorts / youtu.be → embed
  const ytMatch = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/)
  if (ytMatch) {
    return { embedUrl: `https://www.youtube.com/embed/${ytMatch[1]}`, isIframe: true }
  }
  // YouTube embed 直链
  if (/^https?:\/\/(www\.)?youtube\.com\/embed\//.test(url)) {
    return { embedUrl: url, isIframe: true }
  }
  // mp4 / webm / m3u8 直链：用 video 标签
  if (/\.(mp4|webm|m3u8)(\?.*)?$/i.test(url)) {
    return { embedUrl: url, isIframe: false }
  }
  // 默认尝试当作 iframe 渲染
  return { embedUrl: url, isIframe: true }
}

/** 飞书配置页顶部的视频教程卡片，URL 留空时不渲染。
 *  默认展开方便新用户上手；检测到任一 Bot 已 connected（视为配置完成）会自动收起一次，
 *  之后用户随时可以手动展开/收起。 */
function FeishuTutorialVideo(): React.ReactElement | null {
  const video = React.useMemo(() => normalizeVideoEmbedUrl(FEISHU_TUTORIAL_VIDEO.url), [])
  const botStates = useAtomValue(feishuBotStatesAtom)
  const hasConnectedBot = React.useMemo(
    () => Object.values(botStates).some((b) => b.status === 'connected'),
    [botStates],
  )
  const [expanded, setExpanded] = React.useState(true)
  const autoCollapsedRef = React.useRef(false)

  React.useEffect(() => {
    if (hasConnectedBot && !autoCollapsedRef.current) {
      autoCollapsedRef.current = true
      setExpanded(false)
    }
  }, [hasConnectedBot])

  if (!video) return null

  return (
    <SettingsSection
      title={
        <span className="flex items-center gap-2">
          <PlayCircle size={16} className="text-primary" />
          {FEISHU_TUTORIAL_VIDEO.title}
        </span>
      }
      description={FEISHU_TUTORIAL_VIDEO.description}
    >
      <SettingsCard divided={false}>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors cursor-pointer text-left"
        >
          <span className="text-sm text-muted-foreground">
            {expanded ? '点击收起视频' : '点击展开视频教程（约 3 分钟）'}
          </span>
          <ChevronRight size={16} className={cn('text-muted-foreground transition-transform duration-200', expanded && 'rotate-90')} />
        </button>
        {expanded && (
          <div className="px-4 pb-4 animate-in fade-in-0 slide-in-from-top-1 duration-200">
            <div className="relative w-full overflow-hidden rounded-md bg-black" style={{ aspectRatio: '16 / 9' }}>
              {video.isIframe ? (
                <iframe
                  src={video.embedUrl}
                  title={FEISHU_TUTORIAL_VIDEO.title}
                  className="absolute inset-0 w-full h-full border-0"
                  allowFullScreen
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; fullscreen; gyroscope; picture-in-picture"
                  referrerPolicy="no-referrer"
                  sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
                />
              ) : (
                <video
                  src={video.embedUrl}
                  controls
                  preload="metadata"
                  className="absolute inset-0 w-full h-full"
                />
              )}
            </div>
          </div>
        )}
      </SettingsCard>
    </SettingsSection>
  )
}

// ===== 工具组件 =====
// ===== 飞书 CLI 预置 Prompt =====

const FEISHU_CLI_PROMPT = `请帮我配置飞书 CLI 开发环境，按以下步骤执行：

1. 安装飞书 CLI 到全局
npm install -g @larksuite/cli

2. 将 SKILL 安装到当前项目的 Proma 工作区 Skills 目录。先下载，再按系统提示给出的 Skills 目录将下载内容移动过去；不要使用全局安装，以免在无关项目预置上下文。
npx skills add https://github.com/larksuite/cli -y

3. 初始化 CLI 配置（创建一个全新的飞书 CLI 应用，与 Proma 飞书 Bot 互不影响）
lark-cli config init --new

4. 一键申请全部领域的所有权限（文档/表格/日历/任务/邮件/通讯录/会议/审批/OKR/Wiki/多维表格/幻灯片/考勤/项目板等都包含在内）
lark-cli auth login --domain all

执行第 3 步时浏览器会弹出授权页面，引导用户完成应用创建并扫码授权；
执行第 4 步时浏览器会再次弹出，引导用户一次性确认所有领域的权限——这一步是体验关键，跳过会导致后续 Agent 调用飞书文档/日历/邮件等能力时报权限不足。`

/** 飞书 CLI 配置引导 */
function FeishuCliSection(): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false)
  const [copied, setCopied] = React.useState(false)

  const handleSendToAgent = React.useCallback(() => {
    copyTextToClipboard(FEISHU_CLI_PROMPT).then(() => {
      setCopied(true)
      toast.success('配置指令已复制，请在 Agent 对话中粘贴发送')
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {
      toast.error('复制失败')
    })
  }, [])

  return (
    <SettingsSection
      title="配置飞书 CLI"
      description="飞书官方开源的命令行工具，配置后 Proma Agent 将可以直接读消息、查日历、写文档、建多维表格、发邮件，把任务真正落到飞书里完成。"
    >
      <SettingsCard divided={false}>
        <div className="px-4 py-4 space-y-2 text-sm text-muted-foreground">
          <p className="text-xs">复制配置提示词，并前往飞书Bot日常绑定的<strong>项目</strong>，创建新的 Proma Agent 对话并发送即可让 Proma 协助完成配置。</p>
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            onClick={() => setExpanded(!expanded)}
          >
            <ChevronRight size={14} className={cn('transition-transform duration-200', expanded && 'rotate-90')} />
            <span>{expanded ? '收起配置步骤' : '展开查看配置步骤'}</span>
          </button>

          {expanded && (
            <div className="bg-muted/50 rounded-md p-3 font-mono text-xs space-y-1.5 animate-in fade-in-0 slide-in-from-top-1 duration-200">
              <div><span className="text-foreground/70 font-semibold">步骤 1</span> — 安装飞书 CLI 到全局</div>
              <div className="pl-3 text-foreground/60">npm install -g @larksuite/cli</div>
              <div className="pt-1"><span className="text-foreground/70 font-semibold">步骤 2</span> — 下载并安装到当前项目的 Proma 工作区 Skills 目录</div>
              <div className="pl-3 text-foreground/60">npx skills add https://github.com/larksuite/cli -y</div>
              <div className="pt-1"><span className="text-foreground/70 font-semibold">步骤 3</span> — 初始化 CLI（新建独立 CLI 应用，不影响 Proma 飞书 Bot）</div>
              <div className="pl-3 text-foreground/60">lark-cli config init --new</div>
              <div className="pt-1"><span className="text-foreground/70 font-semibold">步骤 4</span> — 一键申请全部领域权限（文档/表格/日历/任务/邮件/通讯录/会议等）</div>
              <div className="pl-3 text-foreground/60">lark-cli auth login --domain all</div>
            </div>
          )}

          <Button
            size="sm"
            variant="outline"
            onClick={handleSendToAgent}
            className="gap-1.5"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            <span>{copied ? '已复制至剪贴板' : '复制配置提示词'}</span>
          </Button>
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

// ===== 绑定卡片组件 =====

interface FeishuBindingCardProps {
  binding: FeishuChatBinding
  workspaces: AgentWorkspace[]
  workspaceById: Map<string, AgentWorkspace>
  sessionById: Map<string, AgentSessionMeta>
  sessionsByWorkspaceId: Map<string, AgentSessionMeta[]>
  onUpdate: (chatId: string, updates: { workspaceId?: string; sessionId?: string }) => void
  onArchive: (chatId: string, archived: boolean) => void
  onRemove: (chatId: string) => void
}

const FeishuBindingCard = React.memo(function FeishuBindingCard({
  binding,
  workspaces,
  workspaceById,
  sessionById,
  sessionsByWorkspaceId,
  onUpdate,
  onArchive,
  onRemove,
}: FeishuBindingCardProps): React.ReactElement {
  const [workspaceSelectOpen, setWorkspaceSelectOpen] = React.useState(false)
  const [sessionSelectOpen, setSessionSelectOpen] = React.useState(false)
  const isGroup = binding.chatType === 'group'
  const displayName = isGroup ? (binding.groupName ?? '未知群组') : '单聊'
  const isArchived = !!binding.archived

  // 当前绑定工作区下的会话列表
  const workspaceSessions = React.useMemo(
    () => sessionsByWorkspaceId.get(binding.workspaceId) ?? [],
    [sessionsByWorkspaceId, binding.workspaceId]
  )

  const currentWorkspace = workspaceById.get(binding.workspaceId)
  const currentSession = sessionById.get(binding.sessionId)
  const lastUsedAt = binding.lastUsedAt ?? binding.createdAt

  return (
    <div className={cn('px-4 py-3 space-y-3', isArchived && 'opacity-75')}>
      {/* 头部：类型图标 + 名称 + 删除 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className={cn(
            'flex items-center justify-center w-8 h-8 rounded-lg',
            isGroup ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400' : 'bg-green-500/10 text-green-600 dark:text-green-400'
          )}>
            {isGroup ? <Users size={16} /> : <User size={16} />}
          </div>
          <div>
            <div className="text-sm font-medium text-foreground">{displayName}</div>
            <div className="text-xs text-muted-foreground">
              {isGroup ? '群聊' : '私聊'} · 最近 {new Date(lastUsedAt).toLocaleDateString('zh-CN')}
              {binding.source === 'session-mirror' && ' · Session 镜像'}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-muted-foreground"
            onClick={() => onArchive(binding.chatId, !isArchived)}
            title={isArchived ? '取消归档' : '归档'}
          >
            {isArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-destructive">
                <Trash2 size={14} />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>解除绑定</AlertDialogTitle>
                <AlertDialogDescription>
                  确定要解除「{displayName}」的飞书聊天绑定吗？解除后下次在飞书发消息会自动创建新绑定。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction onClick={() => onRemove(binding.chatId)}>
                  确认解除
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* 项目选择 */}
      <div className="grid grid-cols-[80px_1fr] gap-2 items-center text-sm">
        <span className="text-muted-foreground">项目</span>
        <Select
          value={binding.workspaceId}
          open={workspaceSelectOpen}
          onOpenChange={setWorkspaceSelectOpen}
          onValueChange={(value) => onUpdate(binding.chatId, { workspaceId: value })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="选择项目">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{currentWorkspace?.name ?? '未知项目'}</span>
                <LocalProjectBadge
                  projectRootPath={currentWorkspace?.projectRootPath}
                  projectRootStatus={currentWorkspace?.projectRootStatus}
                />
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {workspaceSelectOpen && workspaces.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                <span className="flex items-center gap-1.5">
                  <span>{w.name}</span>
                  <LocalProjectBadge
                    projectRootPath={w.projectRootPath}
                    projectRootStatus={w.projectRootStatus}
                  />
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="text-muted-foreground">会话</span>
        <Select
          value={binding.sessionId}
          open={sessionSelectOpen}
          onOpenChange={setSessionSelectOpen}
          onValueChange={(value) => onUpdate(binding.chatId, { sessionId: value })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="选择会话">
              {currentSession?.title ?? binding.sessionId.slice(0, 8)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {sessionSelectOpen && workspaceSessions.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
})

// ===== 绑定管理 Tab =====

function FeishuBindingsTab(): React.ReactElement {
  const bindings = useAtomValue(feishuBindingsAtom)
  const setBindings = useSetAtom(feishuBindingsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const [refreshing, setRefreshing] = React.useState(false)
  const [viewMode, setViewMode] = React.useState<FeishuBindingViewMode>('active')
  const [query, setQuery] = React.useState('')
  const [chatTypeFilter, setChatTypeFilter] = React.useState<FeishuBindingTypeFilter>('all')
  const [sourceFilter, setSourceFilter] = React.useState<FeishuBindingSourceFilter>('all')
  const [visibleLimit, setVisibleLimit] = React.useState(FEISHU_BINDING_PAGE_SIZE)

  const activeCount = React.useMemo(
    () => bindings.filter((binding) => !binding.archived).length,
    [bindings],
  )
  const archivedCount = React.useMemo(
    () => bindings.filter((binding) => binding.archived).length,
    [bindings],
  )

  const workspaceById = React.useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces],
  )
  const sessionById = React.useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  )
  const sessionsByWorkspaceId = React.useMemo(() => {
    const grouped = new Map<string, AgentSessionMeta[]>()
    for (const session of sessions) {
      if (!session.workspaceId) continue
      const list = grouped.get(session.workspaceId) ?? []
      list.push(session)
      grouped.set(session.workspaceId, list)
    }
    for (const list of grouped.values()) {
      list.sort((a, b) => b.updatedAt - a.updatedAt)
    }
    return grouped
  }, [sessions])

  const filteredBindings = React.useMemo(
    () => filterFeishuBindings(bindings, {
      viewMode,
      chatType: chatTypeFilter,
      source: sourceFilter,
      query,
    }),
    [bindings, chatTypeFilter, query, sourceFilter, viewMode],
  )

  const visibleBindings = React.useMemo(
    () => filteredBindings.slice(0, visibleLimit),
    [filteredBindings, visibleLimit],
  )
  const { groupBindings, p2pBindings } = React.useMemo(
    () => groupFeishuBindings(visibleBindings),
    [visibleBindings],
  )

  React.useEffect(() => {
    setVisibleLimit(FEISHU_BINDING_PAGE_SIZE)
  }, [chatTypeFilter, query, sourceFilter, viewMode])

  // 刷新绑定列表
  const refreshBindings = React.useCallback(async () => {
    setRefreshing(true)
    try {
      const list = await window.electronAPI.listFeishuBindings()
      setBindings(list)
    } catch {
      toast.error('获取绑定列表失败')
    } finally {
      setRefreshing(false)
    }
  }, [setBindings])

  // 进入 Tab 时自动刷新
  React.useEffect(() => {
    refreshBindings()
  }, [refreshBindings])

  // 更新绑定
  const handleUpdate = React.useCallback(async (chatId: string, updates: { workspaceId?: string; sessionId?: string }) => {
    try {
      const result = await window.electronAPI.updateFeishuBinding({ chatId, ...updates })
      if (result) {
        setBindings((prev) => prev.map((b) => b.chatId === chatId ? result : b))
        toast.success('绑定已更新')
      }
    } catch {
      toast.error('更新绑定失败')
    }
  }, [setBindings])

  // 归档 / 恢复绑定
  const handleArchive = React.useCallback(async (chatId: string, archived: boolean) => {
    try {
      const result = await window.electronAPI.updateFeishuBinding({ chatId, archived })
      if (result) {
        setBindings((prev) => prev.map((binding) => binding.chatId === chatId ? result : binding))
        toast.success(archived ? '绑定已归档' : '绑定已恢复')
      }
    } catch {
      toast.error(archived ? '归档绑定失败' : '恢复绑定失败')
    }
  }, [setBindings])

  // 移除绑定
  const handleRemove = React.useCallback(async (chatId: string) => {
    try {
      const ok = await window.electronAPI.removeFeishuBinding(chatId)
      if (ok) {
        setBindings((prev) => prev.filter((b) => b.chatId !== chatId))
        toast.success('绑定已解除')
      }
    } catch {
      toast.error('解除绑定失败')
    }
  }, [setBindings])

  return (
    <div className="space-y-8">
      <SettingsSection
        title="绑定管理"
        description={`${activeCount} 个活跃绑定，${archivedCount} 个已归档绑定`}
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={refreshBindings}
            disabled={refreshing}
          >
            <RefreshCw size={14} className={cn(refreshing && 'animate-spin')} />
            <span className="ml-1.5">刷新</span>
          </Button>
        }
      >
        <SettingsCard divided={false}>
          <div className="px-4 py-3 space-y-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
              <div className="inline-flex rounded-lg bg-muted p-1 gap-0.5">
                <button
                  type="button"
                  onClick={() => setViewMode('active')}
                  className={cn(
                    'px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                    viewMode === 'active' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  活跃 ({activeCount})
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('archived')}
                  className={cn(
                    'px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                    viewMode === 'archived' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  已归档 ({archivedCount})
                </button>
              </div>

              <div className="relative min-w-0 flex-1">
                <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索群名、chat_id、session"
                  className="h-9 pl-8 text-sm"
                />
              </div>

              <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
                <Select value={chatTypeFilter} onValueChange={(value) => setChatTypeFilter(value as FeishuBindingTypeFilter)}>
                  <SelectTrigger className="h-9 w-full sm:w-[118px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部类型</SelectItem>
                    <SelectItem value="group">群聊</SelectItem>
                    <SelectItem value="p2p">单聊</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={sourceFilter} onValueChange={(value) => setSourceFilter(value as FeishuBindingSourceFilter)}>
                  <SelectTrigger className="h-9 w-full sm:w-[138px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部来源</SelectItem>
                    <SelectItem value="feishu">飞书主动</SelectItem>
                    <SelectItem value="session-mirror">Session 镜像</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </SettingsCard>

        {bindings.length === 0 ? (
          <SettingsCard divided={false}>
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              暂无绑定。启动 Bridge 后在飞书中发消息即可自动创建绑定。
            </div>
          </SettingsCard>
        ) : filteredBindings.length === 0 ? (
          <SettingsCard divided={false}>
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              没有匹配的绑定。
            </div>
          </SettingsCard>
        ) : (
          <div className="space-y-4">
            {/* 群聊绑定 */}
            {groupBindings.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  群聊 ({groupBindings.length})
                </div>
                <SettingsCard>
                  {groupBindings.map((binding) => (
                    <FeishuBindingCard
                      key={binding.chatId}
                      binding={binding}
                      workspaces={workspaces}
                      workspaceById={workspaceById}
                      sessionById={sessionById}
                      sessionsByWorkspaceId={sessionsByWorkspaceId}
                      onUpdate={handleUpdate}
                      onArchive={handleArchive}
                      onRemove={handleRemove}
                    />
                  ))}
                </SettingsCard>
              </div>
            )}

            {/* 单聊绑定 */}
            {p2pBindings.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  单聊 ({p2pBindings.length})
                </div>
                <SettingsCard>
                  {p2pBindings.map((binding) => (
                    <FeishuBindingCard
                      key={binding.chatId}
                      binding={binding}
                      workspaces={workspaces}
                      workspaceById={workspaceById}
                      sessionById={sessionById}
                      sessionsByWorkspaceId={sessionsByWorkspaceId}
                      onUpdate={handleUpdate}
                      onArchive={handleArchive}
                      onRemove={handleRemove}
                    />
                  ))}
                </SettingsCard>
              </div>
            )}

            {visibleBindings.length < filteredBindings.length && (
              <div className="flex justify-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setVisibleLimit((limit) => limit + FEISHU_BINDING_PAGE_SIZE)}
                >
                  加载更多（{visibleBindings.length}/{filteredBindings.length}）
                </Button>
              </div>
            )}
          </div>
        )}
      </SettingsSection>
    </div>
  )
}

// ===== 扫码注册 Dialog =====

/** 扫码成功页底部的"下一步推荐"：把 CLI 提示词一键复制，让用户去 Agent 会话里跑 */
function CliRecommendationCard(): React.ReactElement {
  const [copied, setCopied] = React.useState(false)

  const handleCopy = React.useCallback(() => {
    copyTextToClipboard(FEISHU_CLI_PROMPT).then(() => {
      setCopied(true)
      toast.success('提示词已复制，前往 Agent 对话粘贴发送')
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {
      toast.error('复制失败')
    })
  }, [])

  return (
    <div className="w-full rounded-lg border border-dashed border-primary/30 bg-primary/5 px-3 py-3 space-y-2">
      <div className="flex items-start gap-2">
        <div className="flex-1 text-xs text-foreground/80 leading-relaxed">
          <div className="font-medium text-foreground mb-0.5">想要更完整的飞书生态体验？</div>
          补全飞书 CLI 后 Proma Agent 还可以直接读写你的文档、查日历、发邮件等。
          复制下方提示词到任意项目的新对话发送即可，Agent 会全程引导完成。
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={handleCopy}
        className="gap-1.5 w-full"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        <span>{copied ? '已复制至剪贴板' : '复制配置提示词'}</span>
      </Button>
    </div>
  )
}

interface RegisterFeishuDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 注册成功后回调，返回主进程拿到的 App ID/Secret 与扫码用户身份；上层应在此处保存配置并启动 Bot */
  onSuccess: (result: { appId: string; appSecret: string; operatorOpenId?: string }) => void
}

/** 扫码注册飞书 Bot：弹窗内全程引导，扫码成功后自动保存配置并启动 Bot */
function RegisterFeishuDialog({ open, onOpenChange, onSuccess }: RegisterFeishuDialogProps): React.ReactElement {
  const [qrcode, setQrcode] = React.useState<FeishuRegisterAppQRCode | null>(null)
  const [status, setStatus] = React.useState<FeishuRegisterAppStatus | null>(null)
  const [phase, setPhase] = React.useState<'idle' | 'qrcode' | 'success' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = React.useState<string>('')

  // 用 ref 持有最新的 onSuccess，避免依赖 onSuccess 后回调引用变化触发整个 effect 重启
  // 重启会调 cancelFeishuRegistration 中断当前正在等待扫码的流程
  const onSuccessRef = React.useRef(onSuccess)
  React.useLayoutEffect(() => {
    onSuccessRef.current = onSuccess
  })

  // 弹窗打开 → 监听推送 + 启动注册；关闭 → 解监听 + 取消
  React.useEffect(() => {
    if (!open) return

    let cancelled = false
    setPhase('idle')
    setErrorMsg('')
    setQrcode(null)
    setStatus(null)

    const offQr = window.electronAPI.onFeishuRegisterQrcode((payload) => {
      setQrcode(payload)
      setPhase('qrcode')
    })
    const offStatus = window.electronAPI.onFeishuRegisterStatus((payload) => {
      setStatus(payload)
    })

    window.electronAPI.registerFeishuApp()
      .then((result) => {
        if (cancelled) return
        setPhase('success')
        onSuccessRef.current({
          appId: result.appId,
          appSecret: result.appSecret,
          operatorOpenId: result.operatorOpenId,
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        // SDK 在 abort 时抛出的错误，关闭弹窗时不显示
        if (msg.includes('aborted') || msg.includes('Abort')) return
        setPhase('error')
        setErrorMsg(msg)
      })

    return () => {
      cancelled = true
      offQr()
      offStatus()
      window.electronAPI.cancelFeishuRegistration().catch(() => {})
    }
  }, [open])

  const handleOpenInBrowser = React.useCallback(() => {
    if (qrcode?.url) {
      window.electronAPI.openExternal(qrcode.url)
    }
  }, [qrcode])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode size={18} className="text-primary" />
            扫码创建飞书 Bot
          </DialogTitle>
          <DialogDescription>
            飞书后端将自动创建一个 PersonalAgent 应用，扫码完成后 Proma 会自动保存凭证并启动 Bot，整个过程无需手动复制 App ID / Secret。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-3 py-2">
          {phase === 'idle' && (
            <div className="flex flex-col items-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 size={24} className="animate-spin" />
              <span>正在向飞书申请二维码…</span>
            </div>
          )}

          {phase === 'qrcode' && qrcode && (
            <>
              <div className="bg-white rounded-lg p-3 shadow-sm">
                {qrcode.dataUrl ? (
                  <img
                    src={qrcode.dataUrl}
                    alt="飞书扫码注册二维码"
                    className="w-[240px] h-[240px] block"
                  />
                ) : (
                  <div className="w-[240px] h-[240px] flex items-center justify-center text-xs text-muted-foreground">
                    二维码生成失败，请用浏览器打开
                  </div>
                )}
              </div>
              <div className="text-sm text-foreground text-center">
                用飞书 App 「扫一扫」，按提示完成应用创建
              </div>
              <div className="text-xs text-muted-foreground text-center">
                {status?.status === 'polling' && '等待扫码确认中…'}
                {status?.status === 'slow_down' && '轮询节奏已自动放慢'}
                {status?.status === 'domain_switched' && '已切换到国际版域名'}
                {!status && '二维码已就绪'}
              </div>
              <Button
                variant="link"
                size="sm"
                onClick={handleOpenInBrowser}
                className="h-auto p-0 text-xs"
              >
                或在浏览器中打开链接
              </Button>
            </>
          )}

          {phase === 'success' && (
            <div className="w-full flex flex-col items-center gap-4 py-2">
              <div className="flex flex-col items-center gap-2 text-sm">
                <CheckCircle2 size={32} className="text-green-600" />
                <span className="text-foreground font-medium">应用创建成功</span>
                <span className="text-xs text-muted-foreground">已自动保存配置，正在启动 Bot…</span>
              </div>

              {/* 推荐：补全飞书 CLI 获得完整生态体验 */}
              <CliRecommendationCard />
            </div>
          )}

          {phase === 'error' && (
            <div className="flex flex-col items-center gap-2 py-8 text-sm">
              <XCircle size={32} className="text-red-600" />
              <span className="text-foreground font-medium">创建失败</span>
              <span className="text-xs text-muted-foreground text-center max-w-[300px]">{errorMsg || '未知错误，请稍后重试'}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {phase === 'success' ? '关闭' : '取消'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// 用于将新名称生成的占位符（参考 handleAddBot 的命名规则保持一致）
function defaultBotName(index: number): string {
  return `飞书助手 ${index + 1}`
}

// ===== 单个 Bot 配置卡片 =====

interface BotConfigCardProps {
  bot: FeishuBotConfig
  state: FeishuBotBridgeState | undefined
  onSaved: () => void
  onRemoved: () => void
}

function BotConfigCard({ bot, state, onSaved, onRemoved }: BotConfigCardProps): React.ReactElement {
  const setBotStates = useSetAtom(feishuBotStatesAtom)
  const [name, setName] = React.useState(bot.name)
  const [appId, setAppId] = React.useState(bot.appId)
  const [appSecret, setAppSecret] = React.useState('')
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<FeishuTestResult | null>(null)
  const [expanded, setExpanded] = React.useState(!bot.appId) // 新建的 Bot 默认展开

  // 加载已有 secret（使用 bot-specific API）
  React.useEffect(() => {
    if (bot.appSecret && bot.id) {
      window.electronAPI.getDecryptedFeishuBotSecret?.(bot.id)
        .then((s: string) => { if (s) setAppSecret(s) })
        .catch(() => {
          // 回退到旧 API（兼容迁移前的首个 Bot）
          window.electronAPI.getDecryptedFeishuSecret?.()
            .then((s: string) => { if (s) setAppSecret(s) })
            .catch(() => {})
        })
    }
  }, [bot.id, bot.appSecret])

  const statusConfig = state ? STATUS_CONFIG[state.status] : STATUS_CONFIG.disconnected
  const isConnected = state?.status === 'connected' || state?.status === 'connecting'

  const handleSave = React.useCallback(async () => {
    if (!appId.trim() || !name.trim()) return
    try {
      await window.electronAPI.saveFeishuBotConfig({
        id: bot.id,
        name: name.trim(),
        enabled: true,
        appId: appId.trim(),
        appSecret: appSecret || '',
        defaultWorkspaceId: bot.defaultWorkspaceId,
        defaultChannelId: bot.defaultChannelId,
        defaultModelId: bot.defaultModelId,
      })
      toast.success(`Bot "${name}" 已保存`)
      onSaved()
    } catch {
      toast.error('保存配置失败')
    }
  }, [bot.id, name, appId, appSecret, onSaved])

  const handleTest = React.useCallback(async () => {
    if (!appId.trim() || !appSecret.trim()) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.electronAPI.testFeishuConnection(appId.trim(), appSecret.trim())
      setTestResult(result)
    } catch (err) {
      setTestResult({ success: false, message: `测试失败: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      setTesting(false)
    }
  }, [appId, appSecret])

  /** 操作完成后主动拉取最新状态，确保 UI 同步 */
  const refreshBotStates = React.useCallback(async () => {
    try {
      const multiState = await window.electronAPI.getFeishuMultiStatus?.()
      if (multiState?.bots) {
        setBotStates(multiState.bots)
      }
    } catch { /* 忽略 */ }
  }, [setBotStates])

  const handleToggle = React.useCallback(async () => {
    if (isConnected) {
      await window.electronAPI.stopFeishuBot(bot.id)
      toast.success(`Bot "${bot.name}" 已停止`)
      await refreshBotStates()
    } else {
      // 启动是异步的（10-15秒），不阻塞等待完成
      // 先发起启动请求，然后轮询状态直到连接成功或失败
      window.electronAPI.startFeishuBot(bot.id).catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : '启动失败')
        refreshBotStates()
      })
      // 短暂等待让主进程设置 connecting 状态
      await new Promise((r) => setTimeout(r, 300))
      await refreshBotStates()
      // 轮询直到状态不再是 connecting
      const poll = setInterval(async () => {
        try {
          const multiState = await window.electronAPI.getFeishuMultiStatus?.()
          if (multiState?.bots) {
            setBotStates(multiState.bots)
            const botState = multiState.bots[bot.id]
            if (!botState || botState.status !== 'connecting') {
              clearInterval(poll)
              if (botState?.status === 'connected') {
                toast.success(`Bot "${bot.name}" 已连接`)
              }
            }
          }
        } catch {
          clearInterval(poll)
        }
      }, 1000)
      // 安全超时：60秒后停止轮询
      setTimeout(() => clearInterval(poll), 60_000)
    }
  }, [bot.id, bot.name, isConnected, refreshBotStates, setBotStates])

  const handleRemove = React.useCallback(async () => {
    try {
      await window.electronAPI.removeFeishuBot(bot.id)
      toast.success(`Bot "${bot.name}" 已删除`)
      onRemoved()
    } catch {
      toast.error('删除失败')
    }
  }, [bot.id, bot.name, onRemoved])

  return (
    <SettingsCard>
      {/* 头部：名称 + 状态 + 展开/折叠 */}
      <div
        role="button"
        tabIndex={0}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-muted/30 transition-colors cursor-pointer"
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(!expanded) } }}
      >
        <div className="flex items-center gap-3">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusConfig.color}`} />
          <span className="font-medium text-sm">{bot.name || '未命名 Bot'}</span>
          <span className="text-xs text-muted-foreground">{bot.appId ? bot.appId.slice(0, 12) + '...' : '未配置'}</span>
        </div>
        <div className="flex items-center gap-2">
          {isConnected ? (
            <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); handleToggle() }}>
              <PowerOff size={14} className="mr-1" />
              停止
            </Button>
          ) : bot.appId ? (
            <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); handleToggle() }}
              disabled={state?.status === 'connecting'}>
              {state?.status === 'connecting' ? <Loader2 size={14} className="animate-spin mr-1" /> : <Power size={14} className="mr-1" />}
              启动
            </Button>
          ) : null}
          <span className="text-xs text-muted-foreground">{expanded ? '▾' : '▸'}</span>
        </div>
      </div>

      {/* 展开的配置表单 */}
      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-border pt-4">
          <SettingsInput
            label="Bot 名称"
            value={name}
            onChange={setName}
            placeholder="如：研发助手"
          />
          <SettingsInput
            label="App ID"
            value={appId}
            onChange={setAppId}
            placeholder="cli_xxxxxxxxxx"
          />
          <SettingsSecretInput
            label="App Secret"
            value={appSecret}
            onChange={setAppSecret}
            placeholder="输入 App Secret"
          />

          <div className="flex items-center gap-3">
            <Button size="sm" variant="outline" onClick={handleTest}
              disabled={testing || !appId.trim() || !appSecret.trim()}>
              {testing && <Loader2 size={14} className="animate-spin" />}
              <span>{testing ? '测试中...' : '测试连接'}</span>
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!appId.trim() || !name.trim()}>
              保存配置
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="destructive">
                  <Trash2 size={14} className="mr-1" />
                  删除
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>确认删除</AlertDialogTitle>
                  <AlertDialogDescription>
                    删除 Bot "{bot.name}" 将同时断开连接并清除所有绑定。此操作不可撤销。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction onClick={handleRemove}>删除</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>

          {testResult && (
            <div className={cn(
              'p-3 rounded-lg flex items-start gap-2 text-sm',
              testResult.success ? 'bg-green-500/10 text-green-700 dark:text-green-400' : 'bg-red-500/10 text-red-700 dark:text-red-400'
            )}>
              {testResult.success
                ? <CheckCircle2 size={16} className="flex-shrink-0 mt-0.5" />
                : <XCircle size={16} className="flex-shrink-0 mt-0.5" />
              }
              <span>{testResult.message}{testResult.botName && ` — ${testResult.botName}`}</span>
            </div>
          )}

          {state?.status === 'error' && state.errorMessage && (
            <div className="p-2.5 rounded-lg bg-red-500/10 text-red-700 dark:text-red-400 text-sm">
              {state.errorMessage}
            </div>
          )}
        </div>
      )}
    </SettingsCard>
  )
}

// ===== Bot 配置 Tab（多 Bot 版本）=====

function FeishuConfigTab(): React.ReactElement {
  const botStates = useAtomValue(feishuBotStatesAtom)
  const setBotStates = useSetAtom(feishuBotStatesAtom)
  const [bots, setBots] = React.useState<FeishuBotConfig[]>([])
  const [loading, setLoading] = React.useState(true)

  const loadBots = React.useCallback(async () => {
    try {
      const config = await window.electronAPI.getFeishuMultiConfig()
      setBots(config.bots)
    } catch {
      // fallback: 旧 API
      try {
        const oldConfig = await window.electronAPI.getFeishuConfig()
        if (oldConfig.appId) {
          setBots([{
            id: 'legacy',
            name: '飞书助手',
            enabled: oldConfig.enabled,
            appId: oldConfig.appId,
            appSecret: oldConfig.appSecret,
          }])
        }
      } catch { /* ignore */ }
    } finally {
      setLoading(false)
    }
  }, [])

  // 进入 Tab 时同步最新状态，避免因启动时序问题导致颜色显示错误
  const refreshStates = React.useCallback(async () => {
    try {
      const multiState = await window.electronAPI.getFeishuMultiStatus?.()
      if (multiState?.bots) {
        setBotStates(multiState.bots)
      }
    } catch { /* 忽略 */ }
  }, [setBotStates])

  React.useEffect(() => {
    loadBots()
    refreshStates()
  }, [loadBots, refreshStates])

  const handleAddBot = React.useCallback(async () => {
    try {
      const saved = await window.electronAPI.saveFeishuBotConfig({
        name: defaultBotName(bots.length),
        enabled: false,
        appId: '',
        appSecret: '',
        defaultWorkspaceId: undefined,
        defaultChannelId: undefined,
        defaultModelId: undefined,
      })
      setBots((prev) => [...prev, saved])
    } catch {
      toast.error('创建 Bot 失败')
    }
  }, [bots.length])

  const [registerOpen, setRegisterOpen] = React.useState(false)

  /** 扫码成功后：保存配置 + 自动启动 Bot */
  const handleRegisterSuccess = React.useCallback(async (result: { appId: string; appSecret: string; operatorOpenId?: string }) => {
    try {
      const saved = await window.electronAPI.saveFeishuBotConfig({
        name: defaultBotName(bots.length),
        enabled: true,
        appId: result.appId,
        appSecret: result.appSecret,
        defaultWorkspaceId: undefined,
        defaultChannelId: undefined,
        defaultModelId: undefined,
        operatorOpenId: result.operatorOpenId,
      })
      setBots((prev) => [...prev, saved])
      toast.success(`Bot "${saved.name}" 已创建`)
      // 自动启动 Bot（不阻塞 UI）
      window.electronAPI.startFeishuBot(saved.id).catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : '自动启动失败，请手动启动')
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存配置失败')
    }
  }, [bots.length])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* 视频教程（顶部最显眼处，未配置 URL 时自动隐藏） */}
      <FeishuTutorialVideo />

      <RegisterFeishuDialog
        open={registerOpen}
        onOpenChange={setRegisterOpen}
        onSuccess={handleRegisterSuccess}
      />

      {/* Bot 列表 */}
      <SettingsSection
        title="飞书 Bot 列表"
        description="管理多个飞书机器人，每个 Bot 可绑定不同的项目和模型"
        action={
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setRegisterOpen(true)}>
              <QrCode size={14} className="mr-1.5" />
              扫码创建
            </Button>
            <Button size="sm" variant="outline" onClick={handleAddBot}>
              <Plus size={14} className="mr-1.5" />
              手动添加
            </Button>
          </div>
        }
      >
        {bots.length === 0 ? (
          <SettingsCard divided={false}>
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              还没有配置飞书 Bot。点击「扫码创建」一键接入，或「手动添加」用已有 App ID。
            </div>
          </SettingsCard>
        ) : (
          <div className="space-y-3">
            {bots.map((bot) => (
              <BotConfigCard
                key={bot.id}
                bot={bot}
                state={botStates[bot.id]}
                onSaved={loadBots}
                onRemoved={loadBots}
              />
            ))}
          </div>
        )}
      </SettingsSection>

      {/* 飞书 CLI 配置引导 */}
      <FeishuCliSection />

    </div>
  )
}

// ===== 主组件 =====

export function FeishuSettings(): React.ReactElement {
  const [activeTab, setActiveTab] = React.useState<FeishuTab>('config')

  return (
    <div className="space-y-6">
      {/* Tab 切换栏 */}
      <div className="inline-flex rounded-lg bg-muted p-1 gap-0.5">
        {TAB_OPTIONS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => setActiveTab(tab.value)}
            className={cn(
              'px-4 py-1.5 rounded-md text-sm font-medium transition-colors',
              activeTab === tab.value
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab 内容 */}
      {activeTab === 'config' ? <FeishuConfigTab /> : <FeishuBindingsTab />}
    </div>
  )
}
