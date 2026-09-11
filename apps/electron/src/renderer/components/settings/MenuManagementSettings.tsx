/**
 * 菜单管理设置页
 *
 * 管理左侧边栏导航菜单各项（新任务、搜索、日程表、定时任务、记忆、知识库、专家团队、技能市场、我的投资）
 * 的显示与隐藏。支持单独切换显隐与一键全部显示。
 */

import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { Eye, EyeOff } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import {
  SIDEBAR_MENU_ITEMS,
  hiddenSidebarMenuItemsAtom,
  setSidebarMenuItemVisibility,
  type SidebarMenuItemDefinition,
} from '@/atoms/sidebar-menu-atoms'
import { activeViewAtom } from '@/atoms/active-view'

export function MenuManagementSettings(): React.ReactElement {
  const [hiddenItems, setHiddenItems] = useAtom(hiddenSidebarMenuItemsAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const [savingId, setSavingId] = React.useState<string | null>(null)

  const hiddenSet = React.useMemo(() => new Set(hiddenItems), [hiddenItems])
  const visibleCount = SIDEBAR_MENU_ITEMS.length - hiddenItems.length
  const hiddenCount = hiddenItems.length

  const handleToggle = async (item: SidebarMenuItemDefinition, checked: boolean): Promise<void> => {
    setSavingId(item.id)
    try {
      await setSidebarMenuItemVisibility(setHiddenItems, hiddenItems, item.id, checked)
      if (!checked && item.targetView) {
        // 若隐藏的是当前打开的视图，平滑切回默认会话
        setActiveView((current) => (current === item.targetView ? 'conversations' : current))
      }
      toast.success(checked ? `已恢复「${item.label}」在侧栏显示` : `已隐藏「${item.label}」`)
    } catch (error) {
      console.error('[菜单管理] 更新显隐失败:', error)
      toast.error(error instanceof Error ? error.message : '更新菜单显示状态失败')
    } finally {
      setSavingId(null)
    }
  }

  return (
    <div className="space-y-6">
      {/* 状态统计指示条 */}
      <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-muted/40 border border-border/40 text-xs text-muted-foreground">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1 font-medium text-foreground">
            <Eye className="w-3.5 h-3.5 text-[var(--ui-primary)]" />
            显示中 ({visibleCount})
          </span>
          <span className="inline-flex items-center gap-1 font-medium text-muted-foreground">
            <EyeOff className="w-3.5 h-3.5 text-zinc-400" />
            已隐藏 ({hiddenCount})
          </span>
        </div>
        <span className="text-[11px]">可在侧边栏点击胶囊隐藏</span>
      </div>

      {/* 菜单项列表卡片 */}
      <div className="rounded-lg border border-border/60 bg-card divide-y divide-border/40 shadow-sm overflow-hidden">
        {SIDEBAR_MENU_ITEMS.map((item) => {
          const Icon = item.icon
          const isVisible = !hiddenSet.has(item.id)
          const isBusy = savingId === item.id

          return (
            <div
              key={item.id}
              className={cn(
                'flex items-center justify-between p-3.5 transition-colors',
                !isVisible ? 'bg-muted/15 opacity-75 hover:opacity-100' : 'hover:bg-muted/25',
              )}
            >
              <div className="flex items-center gap-3 min-w-0 pr-4">
                <div
                  className={cn(
                    'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors',
                    isVisible
                      ? 'border border-border/50 bg-muted/80 text-foreground/80'
                      : 'border border-border/30 bg-muted/35 text-muted-foreground/50',
                  )}
                >
                  <Icon className="w-4 h-4" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground leading-none">{item.label}</span>
                    <span
                      className={cn(
                        'inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium leading-none transition-colors',
                        isVisible
                          ? 'border border-border/50 bg-muted/80 text-foreground/80'
                          : 'border border-border/30 bg-muted/40 text-muted-foreground/60',
                      )}
                    >
                      {isVisible ? '显示中' : '已隐藏'}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 truncate">{item.description}</p>
                </div>
              </div>

              <div className="flex items-center gap-3 flex-shrink-0">
                <Switch
                  checked={isVisible}
                  disabled={isBusy}
                  onCheckedChange={(checked) => void handleToggle(item, checked)}
                  className="data-[state=checked]:bg-[var(--ui-primary)]"
                  aria-label={`切换「${item.label}」显隐`}
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
