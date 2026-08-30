import * as React from 'react'
import {
  Compass,
  ListChecks,
  Bot,
  LayoutGrid,
  Users,
  Brain,
  Sparkles,
  ArrowRight,
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface CopisFeatureItem {
  id: string
  title: string
  description: string
  prompt: string
  icon: React.ComponentType<{ className?: string }>
  iconColorClass: string
  bgHoverClass: string
}

export const COPIS_STARTER_FEATURES: CopisFeatureItem[] = [
  {
    id: 'browser-agent',
    title: '学习网页操作',
    description: '观察或记录网页交互流程，学习并提炼为可复用的网页自动化操作',
    prompt: '学习并记录当前网页的操作流程，沉淀为自动化操作',
    icon: Compass,
    iconColorClass: 'text-sky-500/85 group-hover:text-sky-500',
    bgHoverClass: 'hover:border-sky-500/60',
  },
  {
    id: 'generate-workflow',
    title: '生成工作流',
    description: '分析任务目标并规划多步骤业务流程，生成可复用的标准 SOP 工作流',
    prompt: '帮我分析并生成一套可复用的自动化工作流 SOP',
    icon: ListChecks,
    iconColorClass: 'text-emerald-500/85 group-hover:text-emerald-500',
    bgHoverClass: 'hover:border-emerald-500/60',
  },
  {
    id: 'form-memory',
    title: '形成记忆',
    description: '回顾并总结对话中的关键结论、项目规则与重要偏好，沉淀为长期记忆',
    prompt: '请回顾并总结我们对话中的关键结论、项目规则与重要偏好，沉淀为长期记忆',
    icon: Brain,
    iconColorClass: 'text-teal-500/85 group-hover:text-teal-500',
    bgHoverClass: 'hover:border-teal-500/60',
  },
  {
    id: 'automation',
    title: '定时任务',
    description: '利用 Copis Automation 定时系统，创建无人值守的定时巡检或周期性自动化任务',
    prompt: '帮我创建一个定时自动执行的 Copis 任务',
    icon: Bot,
    iconColorClass: 'text-amber-500/85 group-hover:text-amber-500',
    bgHoverClass: 'hover:border-amber-500/60',
  },
  {
    id: 'create-workbench',
    title: '创作个人工作台',
    description: '在当前工作区的 project/ 目录中构建基于 Vue 3 + Vite 的专属个人前端工具台',
    prompt: '在当前工作区为我构建一个基于 Vue 3 + Vite 的专属个人工作台项目',
    icon: LayoutGrid,
    iconColorClass: 'text-purple-500/85 group-hover:text-purple-500',
    bgHoverClass: 'hover:border-purple-500/60',
  },
  {
    id: 'expert-team',
    title: '专家团队',
    description: '启动多角色专家团队，并行研究、对抗性审查与分工协同交付',
    prompt: '启动专家团队协助我完成本次复杂任务',
    icon: Users,
    iconColorClass: 'text-rose-500/85 group-hover:text-rose-500',
    bgHoverClass: 'hover:border-rose-500/60',
  },
]

interface NewSessionFeatureChipsProps {
  onSelect: (feature: CopisFeatureItem) => void
}

export function NewSessionFeatureChips({ onSelect }: NewSessionFeatureChipsProps): React.ReactElement {
  return (
    <div className="copis-agent-starter-chips flex flex-wrap items-center justify-center gap-1.5 px-1 pb-2.5 select-none animate-in fade-in slide-in-from-bottom-1 duration-200">
      <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground/75 mr-0.5 select-none">
        <Sparkles className="size-3 text-primary/80" />
        <span>快捷入口</span>
      </div>

      {COPIS_STARTER_FEATURES.map((item) => {
        const Icon = item.icon
        return (
          <Tooltip key={item.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onSelect(item)}
                className={cn(
                  'group inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-transparent px-2.5 py-1 text-xs font-medium text-foreground/80 transition-all',
                  'hover:text-foreground active:scale-95 cursor-pointer',
                  item.bgHoverClass,
                )}
              >
                <Icon className={cn('size-3.5 shrink-0 transition-transform group-hover:scale-110', item.iconColorClass)} />
                <span className="truncate">{item.title}</span>
                <ArrowRight className="size-3 opacity-35 transition-all group-hover:translate-x-0.5 group-hover:opacity-90 text-muted-foreground group-hover:text-foreground" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" align="center" className="max-w-xs text-xs space-y-0.5">
              <p className="font-medium text-foreground">{item.title}</p>
              <p className="text-muted-foreground leading-relaxed">{item.description}</p>
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
