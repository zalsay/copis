import * as React from 'react'
import { Download, FolderKanban, Layers3, Settings2, Upload } from 'lucide-react'
import type { MemoryPage } from '@/atoms/memory-atoms'
import { cn } from '@/lib/utils'

interface MemoryWorkspaceNavProps {
  page: MemoryPage
  onPageChange: (page: MemoryPage) => void
}

const NAV_ITEMS: Array<{ page: MemoryPage; label: string; description: string; icon: React.ComponentType<{ className?: string }> }> = [
  { page: 'current', label: '当前项目', description: '管理当前项目和用户记忆', icon: FolderKanban },
  { page: 'all', label: '全部项目', description: '查看项目记忆概览', icon: Layers3 },
  { page: 'global', label: '全局设置', description: '管理默认 Memory 策略', icon: Settings2 },
  { page: 'import', label: '导入知识库', description: '导入 JSON 或 Markdown', icon: Upload },
  { page: 'export', label: '导出记忆', description: '导出 JSON 或 Markdown', icon: Download },
]

export function MemoryWorkspaceNav({ page, onPageChange }: MemoryWorkspaceNavProps): React.ReactElement {
  return (
    <nav aria-label="Memory 页面导航" className="w-52 shrink-0 border-r border-border/45 bg-background/25 px-3 py-4">
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
