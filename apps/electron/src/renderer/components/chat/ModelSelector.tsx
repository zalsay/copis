/**
 * ModelSelector - 模型选择器（Dialog + Command 搜索）
 *
 * 现代化设计：
 * - 大尺寸 Dialog，宽敞易读
 * - 按渠道分组，灰色背景供应商标题行
 * - 选中项左侧绿色竖条高亮
 * - 触发按钮：模型 logo + 模型名 + Chevron
 * - 模型选项构建逻辑独立，保持组件的 Fast Refresh 边界稳定
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Brain, ChevronDown, Cpu, Search, Zap } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  conversationsAtom,
  selectedModelAtom,
  channelsAtom,
  channelsLoadedAtom,
  modelSelectorOpenAtom,
} from '@/atoms/chat-atoms'
import { useConversationModelOptional } from '@/hooks/useConversationSettings'
import { useConversationIdOptional } from '@/contexts/session-context'
import { CopisTemplateLogo, getModelLogo, getChannelLogo, DefaultLogo } from '@/lib/model-logo'
import { cn } from '@/lib/utils'
import {
  COPIS_WORKING_CHANNEL_ID,
  COPIS_WORKING_EXPERT_MODEL_ID,
  COPIS_WORKING_FAST_MODEL_ID,
} from '@copis/shared'
import type { Channel, ModelOption, ProviderType } from '@copis/shared'
import { ChannelPlanQuotaBadge } from './ChannelPlanQuotaBadge'
import { buildModelOptions } from './model-selector-utils'

/** 按渠道分组模型选项 */
function groupByChannel(options: ModelOption[]): Map<string, ModelOption[]> {
  const groups = new Map<string, ModelOption[]>()

  for (const option of options) {
    const key = option.channelId
    const group = groups.get(key) ?? []
    group.push(option)
    groups.set(key, group)
  }

  return groups
}

function getModelDescription(option: Pick<ModelOption, 'channelId' | 'modelId'>): string | undefined {
  if (option.channelId !== COPIS_WORKING_CHANNEL_ID) return undefined
  if (option.modelId === COPIS_WORKING_FAST_MODEL_ID) return '速度快，思考能力一般'
  if (option.modelId === COPIS_WORKING_EXPERT_MODEL_ID) return '知识面广，深度思考，消耗更多钻石'
  return undefined
}

function renderModelIcon(option: ModelOption, useCopisLogo: boolean, className: string): React.ReactElement {
  if (option.channelId === COPIS_WORKING_CHANNEL_ID && option.modelId === COPIS_WORKING_FAST_MODEL_ID) {
    return <Zap aria-hidden="true" className={cn(className, 'text-amber-400')} />
  }
  if (option.channelId === COPIS_WORKING_CHANNEL_ID && option.modelId === COPIS_WORKING_EXPERT_MODEL_ID) {
    return <Brain aria-hidden="true" className={cn(className, 'text-violet-400')} />
  }
  return (
    <img
      src={useCopisLogo ? CopisTemplateLogo : getModelLogo(option.modelId, option.provider)}
      alt={option.modelName}
      className={cn(className, 'rounded object-cover')}
    />
  )
}

/** ModelSelector 可选属性 */
interface ModelSelectorProps {
  /** 仅显示此渠道的模型 */
  filterChannelId?: string
  /** 仅供 Agent 等专用场景追加的内存渠道，不会写入全局渠道配置。 */
  additionalChannels?: Channel[]
  /** 仅显示这些渠道的模型（多渠道过滤） */
  filterChannelIds?: string[]
  /** 外部选中模型（不传则用内部 selectedModelAtom） */
  externalSelectedModel?: { channelId: string; modelId: string } | null
  /** 外部选择回调 */
  onModelSelect?: (option: ModelOption) => void
  /** 触发按钮是否显示「渠道 · 模型」（默认只显示模型名） */
  showChannelInTrigger?: boolean
  /** 触发按钮中覆盖渠道显示名，不影响选择弹窗中的完整渠道名 */
  triggerChannelName?: string
  /** 是否在触发器和下拉列表中统一使用 Copis 品牌 Logo */
  useCopisLogo?: boolean
  /** 不在此选择器中显示的供应商（例如 Chat 暂不支持的协议） */
  excludedProviders?: readonly ProviderType[]
  /** 是否使用全局 modelSelectorOpenAtom 控制打开状态（用于外部拉起，如错误提示按钮） */
  useSharedOpenState?: boolean
}

export function ModelSelector({
  filterChannelId,
  additionalChannels,
  filterChannelIds,
  externalSelectedModel,
  onModelSelect,
  showChannelInTrigger = false,
  triggerChannelName,
  useCopisLogo = false,
  excludedProviders,
  useSharedOpenState = false,
}: ModelSelectorProps = {}): React.ReactElement {
  const [conversationModel, setConversationModel] = useConversationModelOptional()
  const conversationId = useConversationIdOptional()
  const setConversations = useSetAtom(conversationsAtom)
  const setGlobalModel = useSetAtom(selectedModelAtom)
  const channels = useAtomValue(channelsAtom)
  const channelsLoaded = useAtomValue(channelsLoadedAtom)
  const setChannels = useSetAtom(channelsAtom)
  const [localOpen, setLocalOpen] = React.useState(false)
  const [sharedOpen, setSharedOpen] = useAtom(modelSelectorOpenAtom)
  const open = useSharedOpenState ? sharedOpen : localOpen
  const setOpen = useSharedOpenState ? setSharedOpen : setLocalOpen
  const [search, setSearch] = React.useState('')

  // 外部模型优先 → per-conversation 模型
  const selectedModel = externalSelectedModel !== undefined ? externalSelectedModel : conversationModel

  // 每次打开 Dialog 时刷新渠道列表，确保最新
  React.useEffect(() => {
    if (open) {
      window.electronAPI.listChannels().then(setChannels).catch(console.error)
      setSearch('')
    }
  }, [open, setChannels])

  const availableChannels = React.useMemo(() => {
    if (!additionalChannels || additionalChannels.length === 0) return channels
    const byId = new Map(channels.map((channel) => [channel.id, channel]))
    for (const channel of additionalChannels) byId.set(channel.id, channel)
    return [...byId.values()]
  }, [additionalChannels, channels])

  const modelOptions = React.useMemo(
    () => buildModelOptions(availableChannels, filterChannelId, filterChannelIds, excludedProviders),
    [availableChannels, filterChannelId, filterChannelIds, excludedProviders],
  )
  const grouped = React.useMemo(() => groupByChannel(modelOptions), [modelOptions])

  // 搜索过滤
  const filteredGrouped = React.useMemo(() => {
    if (!search.trim()) return grouped

    const query = search.toLowerCase()
    const filtered = new Map<string, ModelOption[]>()

    for (const [channelId, options] of grouped.entries()) {
      const matchedOptions = options.filter(
        (o) =>
          o.modelName.toLowerCase().includes(query) ||
          getModelDescription(o)?.toLowerCase().includes(query) ||
          o.channelName.toLowerCase().includes(query)
      )
      if (matchedOptions.length > 0) {
        filtered.set(channelId, matchedOptions)
      }
    }

    return filtered
  }, [grouped, search])

  // 扁平化过滤后的模型列表，用于键盘导航
  const flatOptions = React.useMemo(() => {
    const result: ModelOption[] = []
    for (const options of filteredGrouped.values()) {
      result.push(...options)
    }
    return result
  }, [filteredGrouped])

  // 键盘高亮索引
  const [highlightIndex, setHighlightIndex] = React.useState(-1)
  const itemRefs = React.useRef<Map<number, HTMLButtonElement>>(new Map())

  // 搜索变化时重置高亮
  React.useEffect(() => {
    setHighlightIndex(-1)
  }, [search])

  // 高亮项变化时滚动到可见区域
  React.useEffect(() => {
    if (highlightIndex < 0) return
    const el = itemRefs.current.get(highlightIndex)
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlightIndex])

  // 查找当前选中的模型信息
  const currentModelInfo = React.useMemo(() => {
    if (!selectedModel) return null
    return modelOptions.find(
      (o) => o.channelId === selectedModel.channelId && o.modelId === selectedModel.modelId
    ) ?? null
  }, [selectedModel, modelOptions])

  // 保持上次有效的模型信息，避免渠道未加载时闪烁"选择模型"
  const stableModelInfoRef = React.useRef(currentModelInfo)
  if (currentModelInfo) stableModelInfoRef.current = currentModelInfo
  const displayModelInfo = currentModelInfo ?? stableModelInfoRef.current

  /** 选择模型并持久化到当前对话 */
  const handleSelect = (option: ModelOption): void => {
    if (onModelSelect) {
      onModelSelect(option)
      setOpen(false)
      return
    }

    // Chat 模式：写入 per-conversation Map + 同步全局默认值
    if (setConversationModel) {
      setConversationModel({ channelId: option.channelId, modelId: option.modelId })
    }
    setGlobalModel({ channelId: option.channelId, modelId: option.modelId })
    setOpen(false)

    // 将模型/渠道选择保存到当前对话元数据
    if (conversationId) {
      window.electronAPI
        .updateConversationModel(conversationId, option.modelId, option.channelId)
        .then((updated) => {
          setConversations((prev) =>
            prev.map((c) => (c.id === updated.id ? updated : c))
          )
        })
        .catch(console.error)
    }
  }

  /** 搜索框键盘导航 */
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (flatOptions.length === 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIndex((prev) => (prev < flatOptions.length - 1 ? prev + 1 : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIndex((prev) => (prev > 0 ? prev - 1 : flatOptions.length - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = flatOptions[highlightIndex >= 0 ? highlightIndex : 0]
      if (target) handleSelect(target)
    }
  }

  if (channelsLoaded && modelOptions.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground px-2 py-1">
        <Cpu className="size-3.5" />
        <span>暂无可用模型</span>
      </div>
    )
  }

  return (
    <>
      {/* 触发按钮 */}
      <Tooltip open={open || !displayModelInfo ? false : undefined}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="model-selector-trigger flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            {displayModelInfo ? (
              renderModelIcon(displayModelInfo, useCopisLogo, 'size-4 shrink-0')
            ) : (
              <Cpu className="size-3.5" />
            )}
            <span className="max-w-[200px] truncate">
              {displayModelInfo
                ? (showChannelInTrigger
                  ? `${triggerChannelName ?? displayModelInfo.channelName} · ${displayModelInfo.modelName}`
                  : displayModelInfo.modelName)
                : '选择模型'}
            </span>
            <ChevronDown className="size-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">渠道：{triggerChannelName ?? displayModelInfo?.channelName}</TooltipContent>
      </Tooltip>

      {/* 模型选择 Dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="p-0 gap-0 max-w-lg" aria-describedby={undefined}>
          <DialogHeader className="sr-only">
            <DialogTitle>选择模型</DialogTitle>
          </DialogHeader>

          {/* 搜索栏 */}
          <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border/60">
            <Search className="size-5 text-muted-foreground/60 flex-shrink-0" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="搜索模型..."
              className="flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground/50"
              autoFocus
            />
          </div>

          {/* 模型列表 */}
          <div className="max-h-[420px] overflow-y-auto scrollbar-thin">
            {filteredGrouped.size === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                未找到模型
              </div>
            ) : (
              (() => {
                let flatIndex = 0
                return Array.from(filteredGrouped.entries()).map(([channelId, options]) => {
                const first = options[0]
                if (!first) return null
                const channel = channels.find((c) => c.id === channelId)

                return (
                  <div key={channelId}>
                    {/* 供应商标题行 - 灰色背景 */}
                    <div className="flex items-center gap-2 px-4 py-2 bg-muted/50 border-b border-border/30">
                      <img
                        src={useCopisLogo ? CopisTemplateLogo : channel ? getChannelLogo(channel) : DefaultLogo}
                        alt={first.channelName}
                        className="size-5 rounded object-cover"
                      />
                      <span className="min-w-0 truncate text-sm font-medium text-muted-foreground">
                        {first.channelName}
                      </span>
                      {channel ? <ChannelPlanQuotaBadge channel={channel} /> : null}
                    </div>

                    {/* 该渠道下的模型列表 */}
                    {options.map((option) => {
                      const modelDescription = getModelDescription(option)
                      const isSelected =
                        selectedModel?.channelId === option.channelId &&
                        selectedModel?.modelId === option.modelId
                      const currentFlatIndex = flatIndex++
                      const isHighlighted = currentFlatIndex === highlightIndex

                      return (
                        <button
                          key={`${option.channelId}:${option.modelId}`}
                          ref={(el) => {
                            if (el) itemRefs.current.set(currentFlatIndex, el)
                            else itemRefs.current.delete(currentFlatIndex)
                          }}
                          type="button"
                          onClick={() => handleSelect(option)}
                          onMouseEnter={() => setHighlightIndex(currentFlatIndex)}
                          className={cn(
                            'flex items-center gap-3 w-[calc(100%-1rem)] px-4 py-1.5 mx-2 rounded-lg text-left transition-colors',
                            'hover:bg-accent',
                            isHighlighted && 'bg-accent',
                            isSelected && 'bg-foreground/10 border-l-3 border-l-primary'
                          )}
                        >
                          {renderModelIcon(option, useCopisLogo, 'size-5 flex-shrink-0')}
                          <span className={cn(
                            'flex-1 text-sm truncate',
                            isSelected ? 'font-medium text-foreground' : 'text-foreground/80'
                          )}>
                            {option.modelName}
                            {modelDescription ? `(${modelDescription})` : ''}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )
              })
              })()
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
