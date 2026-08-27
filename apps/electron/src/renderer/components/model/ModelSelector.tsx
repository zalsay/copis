/**
 * ModelSelector - 模型选择器（Dialog / Composer 抽屉 + 搜索）
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
import { ChevronDown, Cpu, Globe, Search, Zap } from 'lucide-react'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  selectedModelAtom,
  channelsAtom,
  channelsLoadedAtom,
  modelSelectorOpenAtom,
} from '@/atoms/model-atoms'
import { workingModelCatalogAtom } from '@/atoms/working-model-catalog-atoms'
import { CopisTemplateLogo, getModelLogo, getChannelLogo, DefaultLogo } from '@/lib/model-logo'
import { cn } from '@/lib/utils'
import {
  COPIS_WORKING_CHANNEL_ID,
  COPIS_WORKING_DEEPSEEK_CHANNEL_ID,
  COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID,
  COPIS_WORKING_DEEPSEEK_PRO_MODEL_ID,
  COPIS_WORKING_FAST_MODEL_ID,
  COPIS_WORKING_GLOBAL_MODEL_ID,
  workingModelCatalogToOptions,
} from '@copis/shared'
import type { ModelOption, ProviderType, WorkingCustomModelOption, WorkingModelLatencyMap } from '@copis/shared'
import { ChannelPlanQuotaBadge } from './ChannelPlanQuotaBadge'
import { buildModelOptions } from './model-selector-utils'
import { ModelLatencySignal } from './ModelLatencySignal'

const EMPTY_CUSTOM_MODEL_OPTIONS: readonly WorkingCustomModelOption[] = []

interface ModelGroup {
  key: string
  name: string
  isCustom: boolean
  options: ModelOption[]
}

/** 内置模型按渠道分组，自定义模型按用户配置的分类分组。 */
function groupModelOptions(
  baseOptions: ModelOption[],
  customOptions: readonly WorkingCustomModelOption[],
): ModelGroup[] {
  const groups = new Map<string, ModelGroup>()

  for (const option of baseOptions) {
    const key = option.channelId
    const group = groups.get(key) ?? { key, name: option.channelName, isCustom: false, options: [] }
    group.options.push(option)
    groups.set(key, group)
  }

  for (const option of customOptions) {
    const key = option.groupKey ?? option.categoryId ?? 'custom:default'
    const group = groups.get(key) ?? {
      key,
      name: option.groupName ?? option.categoryName ?? '自定义模型',
      isCustom: true,
      options: [],
    }
    group.options.push(option)
    groups.set(key, group)
  }

  return [...groups.values()]
}

function getModelDescription(option: Pick<ModelOption, 'channelId' | 'modelId'>): string | undefined {
  if (option.channelId === COPIS_WORKING_DEEPSEEK_CHANNEL_ID) {
    if (option.modelId === COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID) {
      return 'v4 Flash，思考速度快，不支持图片识别'
    }
    if (option.modelId === COPIS_WORKING_DEEPSEEK_PRO_MODEL_ID) {
      return 'v4Pro，DeepSeek 最强模型，不支持图片识别'
    }
  }
  if (option.channelId !== COPIS_WORKING_CHANNEL_ID) return undefined
  if (option.modelId === COPIS_WORKING_FAST_MODEL_ID) return '速度快，思考能力一般'
  if (option.modelId === COPIS_WORKING_GLOBAL_MODEL_ID) return '通晓世界知识，适合教育、探索等场景'
  return undefined
}

function renderModelIcon(option: ModelOption, useCopisLogo: boolean, className: string): React.ReactElement {
  if (option.channelId === COPIS_WORKING_CHANNEL_ID && option.modelId === COPIS_WORKING_FAST_MODEL_ID) {
    return <Zap aria-hidden="true" className={cn(className, 'text-amber-400')} />
  }
  if (option.channelId === COPIS_WORKING_CHANNEL_ID && option.modelId === COPIS_WORKING_GLOBAL_MODEL_ID) {
    return <Globe aria-hidden="true" className={cn(className, 'text-sky-400')} />
  }
  return (
    <img
      src={useCopisLogo && option.channelId !== COPIS_WORKING_DEEPSEEK_CHANNEL_ID
        ? CopisTemplateLogo
        : getModelLogo(option.modelId, option.provider)}
      alt={option.modelName}
      className={cn(className, 'rounded object-cover')}
    />
  )
}

/** ModelSelector 可选属性 */
interface ModelSelectorProps {
  /** 仅显示此渠道的模型 */
  filterChannelId?: string
  /** 仅显示这些渠道的模型（多渠道过滤） */
  filterChannelIds?: string[]
  /** 外部选中模型（不传则用内部 selectedModelAtom） */
  externalSelectedModel?: { channelId: string; modelId: string } | null
  /** 自定义触发按钮 className */
  triggerClassName?: string
  /** 外部选择回调 */
  onModelSelect?: (option: ModelOption) => void
  /** 触发按钮是否显示「渠道 · 模型」（默认只显示模型名） */
  showChannelInTrigger?: boolean
  /** 触发按钮中覆盖渠道显示名，不影响选择弹窗中的完整渠道名 */
  triggerChannelName?: string
  /** 是否在触发器和下拉列表中统一使用 Copis 品牌 Logo */
  useCopisLogo?: boolean
  /** 不在此选择器中显示的供应商 */
  excludedProviders?: readonly ProviderType[]
  /** 是否使用全局 modelSelectorOpenAtom 控制打开状态（用于外部拉起，如错误提示按钮） */
  useSharedOpenState?: boolean
  /** 模型列表展示位置；Composer 使用紧贴输入框并向上展开的抽屉。 */
  placement?: 'dialog' | 'composer'
  /** Agent/欢迎页 Composer 使用的渠道范围与产品分组名。 */
  composerMode?: boolean
  /** Composer 自定义模型配置，按用户分类分组展示；选择后仍走现有 Working 请求链。 */
  customModelOptions?: readonly WorkingCustomModelOption[]
}

export function ModelSelector({
  filterChannelId,
  filterChannelIds,
  externalSelectedModel,
  onModelSelect,
  showChannelInTrigger = false,
  triggerChannelName,
  useCopisLogo = false,
  excludedProviders,
  useSharedOpenState = false,
  placement = 'dialog',
  triggerClassName,
  composerMode = false,
  customModelOptions,
}: ModelSelectorProps = {}): React.ReactElement {
  const setGlobalModel = useSetAtom(selectedModelAtom)
  const globalSelectedModel = useAtomValue(selectedModelAtom)
  const channels = useAtomValue(channelsAtom)
  const channelsLoaded = useAtomValue(channelsLoadedAtom)
  const setChannels = useSetAtom(channelsAtom)
  const [localOpen, setLocalOpen] = React.useState(false)
  const [sharedOpen, setSharedOpen] = useAtom(modelSelectorOpenAtom)
  const open = useSharedOpenState ? sharedOpen : localOpen
  const setOpen = useSharedOpenState ? setSharedOpen : setLocalOpen
  const [modelTooltipOpen, setModelTooltipOpen] = React.useState(false)
  const [search, setSearch] = React.useState('')
  const [latencies, setLatencies] = React.useState<WorkingModelLatencyMap>({})
  const pickerListId = React.useId()

  // 外部模型优先；未传入时使用全局默认模型，避免依赖旧 Chat 会话状态。
  const selectedModel = externalSelectedModel !== undefined ? externalSelectedModel : globalSelectedModel

  const workingModelCatalog = useAtomValue(workingModelCatalogAtom)
  const defaultCustomModelOptions = React.useMemo(
    () => workingModelCatalogToOptions(workingModelCatalog),
    [workingModelCatalog],
  )

  // 挂载时刷新渠道（若尚未加载）
  React.useEffect(() => {
    if (!channelsLoaded) {
      window.electronAPI.listChannels().then((chs) => {
        setChannels(chs)
      }).catch(console.error)
    }
  }, [channelsLoaded, setChannels])

  // 渠道唯一来自主进程 listChannels() 的结果；内置渠道也由该列表统一提供。
  const availableChannels = channels

  const resolvedCustomModelOptions = customModelOptions !== undefined
    ? customModelOptions
    : defaultCustomModelOptions

  // 构建全部模型选项（已启用渠道中已启用的模型）
  const allOptions = React.useMemo(() => {
    return buildModelOptions(
      availableChannels,
      filterChannelId,
      filterChannelIds,
      excludedProviders,
      {
        includeProviders: composerMode ? ['zhipu'] : undefined,
        useComposerProviderLabels: composerMode,
      },
    )
  }, [availableChannels, composerMode, filterChannelId, filterChannelIds, excludedProviders])

  // 按供应商/渠道分组（包含用户自定义 Working 模型）
  const grouped = React.useMemo(() => {
    return groupModelOptions(allOptions, resolvedCustomModelOptions ?? EMPTY_CUSTOM_MODEL_OPTIONS)
  }, [allOptions, resolvedCustomModelOptions])

  // 搜索过滤
  const filteredGrouped = React.useMemo(() => {
    if (!search.trim()) return grouped
    const q = search.toLowerCase()
    return grouped
      .map((g) => ({
        ...g,
        options: g.options.filter(
          (o) =>
            o.modelName.toLowerCase().includes(q) ||
            o.modelId.toLowerCase().includes(q) ||
            o.channelName.toLowerCase().includes(q)
        ),
      }))
      .filter((g) => g.options.length > 0)
  }, [grouped, search])

  // 扁平列表（供键盘导航）
  const flatOptions = React.useMemo(
    () => filteredGrouped.flatMap((g) => g.options),
    [filteredGrouped]
  )

  // 键盘高亮索引
  const [highlightIndex, setHighlightIndex] = React.useState(-1)
  const itemRefs = React.useRef<Map<number, HTMLButtonElement>>(new Map())

  // 弹窗打开时重置状态并拉取延迟
  React.useEffect(() => {
    if (open) {
      setSearch('')
      setHighlightIndex(-1)
      setLatencies({})
      window.electronAPI.getWorkingModelLatencies()
        .then(setLatencies)
        .catch(() => setLatencies({}))
    }
  }, [open])

  // 键盘高亮项自动滚动到可见区域
  React.useEffect(() => {
    if (highlightIndex >= 0) {
      itemRefs.current.get(highlightIndex)?.scrollIntoView({ block: 'nearest' })
    }
  }, [highlightIndex])

  // 当前选中模型的展示信息
  const currentModelInfo = React.useMemo(() => {
    if (!selectedModel) return null
    return (
      (resolvedCustomModelOptions ?? EMPTY_CUSTOM_MODEL_OPTIONS).find(
        (o) => o.channelId === selectedModel.channelId && o.modelId === selectedModel.modelId
      ) ??
      allOptions.find(
        (o) => o.channelId === selectedModel.channelId && o.modelId === selectedModel.modelId
      ) ??
      null
    )
  }, [selectedModel, allOptions, resolvedCustomModelOptions])

  // 保持上次有效的模型信息，避免渠道未加载时闪烁"选择模型"
  const stableModelInfoRef = React.useRef(currentModelInfo)
  if (currentModelInfo) stableModelInfoRef.current = currentModelInfo
  const displayModelInfo = currentModelInfo ?? stableModelInfoRef.current
  const modelTooltipDisabled = open || !displayModelInfo

  React.useEffect(() => {
    if (modelTooltipDisabled) setModelTooltipOpen(false)
  }, [modelTooltipDisabled])

  /** 选择模型并持久化到当前对话 */
  const handleSelect = (option: ModelOption): void => {
    if (onModelSelect) {
      onModelSelect(option)
      setOpen(false)
      return
    }

    setGlobalModel({ channelId: option.channelId, modelId: option.modelId })
    setOpen(false)
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

  const pickerContent = (
    <>
      {/* 搜索栏 */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border/60">
        <Search aria-hidden="true" className="size-5 text-muted-foreground/60 flex-shrink-0" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder="搜索模型..."
          aria-label="搜索模型"
          className="flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground/50"
          autoFocus
        />
      </div>

      {/* 模型列表 */}
      <div id={pickerListId} role="listbox" aria-label="可用模型" className="max-h-[420px] overflow-y-auto pb-3 scrollbar-thin">
        {filteredGrouped.length === 0 ? (
          <div className="py-12 px-6 text-center text-sm text-muted-foreground flex flex-col items-center justify-center gap-2">
            <Cpu className="size-8 opacity-40 text-muted-foreground" />
            <span className="font-medium text-foreground/80">
              {search.trim() ? '未找到匹配的模型' : '暂无可用模型'}
            </span>
            <span className="text-xs text-muted-foreground/70">
              {search.trim() ? '请尝试更换关键词搜索' : '请先在「设置 - 模型渠道」中添加并启用 AI 渠道'}
            </span>
          </div>
        ) : (
          (() => {
            let flatIndex = 0
            return filteredGrouped.map((group) => {
              const first = group.options[0]
              if (!first) return null
              const channel = group.isCustom ? undefined : availableChannels.find((c) => c.id === group.key)
              const useDeepSeekLogo = first.channelId === COPIS_WORKING_DEEPSEEK_CHANNEL_ID

              return (
                <div key={group.key}>
                  {/* 供应商标题行 - 灰色背景 */}
                  <div className="flex items-center gap-2 px-4 py-2 bg-muted/50 border-b border-border/30">
                    {group.isCustom ? (
                      <Cpu aria-hidden="true" className="size-5 text-muted-foreground" />
                    ) : (
                      <img
                        src={useDeepSeekLogo
                          ? getModelLogo(first.modelId, first.provider)
                          : useCopisLogo ? CopisTemplateLogo : channel ? getChannelLogo(channel) : DefaultLogo}
                        alt={first.channelName}
                        className="size-5 rounded object-cover"
                      />
                    )}
                    <span className="min-w-0 truncate text-sm font-medium text-muted-foreground">
                      {group.name}
                    </span>
                    {!group.isCustom && channel ? <ChannelPlanQuotaBadge channel={channel} /> : null}
                  </div>

                  {/* 该渠道下的模型列表 */}
                  {group.options.map((option) => {
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
                        role="option"
                        aria-selected={isSelected}
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
                        <span className="flex min-w-0 flex-1 items-center gap-2">
                          <span className={cn(
                            'min-w-0 flex-1 truncate text-sm',
                            isSelected ? 'font-medium text-foreground' : 'text-foreground/80'
                          )}>
                            {option.modelName}
                            {placement === 'dialog' && modelDescription ? `(${modelDescription})` : ''}
                          </span>
                          {placement === 'dialog' ? (
                            <ModelLatencySignal
                              averageMs={latencies[option.modelId]}
                              className="shrink-0"
                            />
                          ) : null}
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
    </>
  )

  const triggerLabel = displayModelInfo
    ? (showChannelInTrigger
      ? `${triggerChannelName ?? displayModelInfo.channelName} · ${displayModelInfo.modelName}`
      : displayModelInfo.modelName)
    : '暂无可用模型'

  return (
    <>
      {placement === 'composer' ? (
        <Popover open={open} onOpenChange={setOpen}>
          <Tooltip
            open={!modelTooltipDisabled && modelTooltipOpen}
            onOpenChange={(nextOpen) => {
              if (!modelTooltipDisabled) setModelTooltipOpen(nextOpen)
            }}
          >
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded={open}
                  aria-controls={open ? pickerListId : undefined}
                  className={cn(
                    'model-selector-trigger flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors',
                    triggerClassName
                  )}
                >
                  {displayModelInfo ? renderModelIcon(displayModelInfo, useCopisLogo, 'size-4 shrink-0') : <Cpu className="size-3.5" />}
                  <span className="max-w-[200px] truncate">
                    {triggerLabel}
                  </span>
                  <ChevronDown aria-hidden="true" className="size-3" />
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">
              {displayModelInfo ? `渠道：${triggerChannelName ?? displayModelInfo.channelName}` : '点击选择或配置可用模型'}
            </TooltipContent>
          </Tooltip>
          <PopoverContent
            side="top"
            align="end"
            sideOffset={8}
            className="w-[min(220px,calc(100vw-2rem))] max-w-[calc(100vw-1rem)] overflow-hidden p-0"
          >
            {pickerContent}
          </PopoverContent>
        </Popover>
      ) : (
        <>
          {/* 触发按钮 */}
          <Tooltip
            open={!modelTooltipDisabled && modelTooltipOpen}
            onOpenChange={(nextOpen) => {
              if (!modelTooltipDisabled) setModelTooltipOpen(nextOpen)
            }}
          >
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setOpen(true)}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={open ? pickerListId : undefined}
                className={cn(
                  'model-selector-trigger flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors',
                  triggerClassName
                )}
              >
                {displayModelInfo ? renderModelIcon(displayModelInfo, useCopisLogo, 'size-4 shrink-0') : <Cpu className="size-3.5" />}
                <span className="max-w-[200px] truncate">
                  {triggerLabel}
                </span>
                <ChevronDown aria-hidden="true" className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {displayModelInfo ? `渠道：${triggerChannelName ?? displayModelInfo.channelName}` : '点击选择或配置可用模型'}
            </TooltipContent>
          </Tooltip>

          {/* 模型选择 Dialog */}
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="p-0 gap-0 max-w-lg" aria-describedby={undefined}>
              <DialogHeader className="sr-only">
                <DialogTitle>选择模型</DialogTitle>
              </DialogHeader>
              {pickerContent}
            </DialogContent>
          </Dialog>
        </>
      )}
    </>
  )
}
