import * as React from 'react'
import { Download, FolderKanban, Globe, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'

export type KnowledgePage = 'ingest' | 'workspace' | 'global' | 'export'

interface KnowledgeNavProps {
  page: KnowledgePage
  onPageChange: (page: KnowledgePage) => void
}

const NAV_ITEMS: Array<{
  page: KnowledgePage
  label: string
  description: string
  icon: React.ComponentType<{ className?: string }>
}> = [
  { page: 'ingest', label: '资料智能摄取', description: '本地文档 AI 提炼与网页抓取导入', icon: Sparkles },
  { page: 'workspace', label: '项目知识库', description: '当前项目的结构化知识卡片', icon: FolderKanban },
  { page: 'global', label: '全局知识库', description: '跨项目通用的用户知识与规约', icon: Globe },
  { page: 'export', label: '导出知识库', description: '导出为 Markdown 或 JSON 数据包', icon: Download },
]

export function KnowledgeNav({ page, onPageChange }: KnowledgeNavProps): React.ReactElement {
  return (
    <nav aria-label="知识库导航" className="w-52 shrink-0 border-r border-border/45 bg-background/25 px-3 py-4">
      <div className="space-y-1">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          const active = page === item.page
          return (
            <button
              key={item.page}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => onPageChange(item.page)}
              title={item.description}
              className={cn(
                'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                active ? 'bg-primary/10 text-primary' : 'text-foreground/60 hover:bg-muted/60 hover:text-foreground',
              )}
            >
              <Icon className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 text-sm font-medium">{item.label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
