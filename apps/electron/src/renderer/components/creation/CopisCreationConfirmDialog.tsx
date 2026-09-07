import React, { useEffect, useState } from 'react'
import { useSetAtom } from 'jotai'
import { Lightbulb, AlertTriangle } from 'lucide-react'
import { creationModeSkipConfirmAtom } from '@/atoms/app-mode'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export interface CopisCreationConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

/**
 * 进入 Copis 创造模式确认弹窗
 *
 * 提示用户：创造模式可对 Copis 进行自我迭代，可能引起程序崩溃等风险，
 * 并支持“下次不再提醒”持久化勾选。
 */
export function CopisCreationConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
}: CopisCreationConfirmDialogProps): React.ReactElement {
  const setSkipConfirm = useSetAtom(creationModeSkipConfirmAtom)
  const [dontAskAgain, setDontAskAgain] = useState(false)

  // 每次打开弹窗时重置勾选状态
  useEffect(() => {
    if (open) {
      setDontAskAgain(false)
    }
  }, [open])

  const handleConfirm = (): void => {
    if (dontAskAgain) {
      setSkipConfirm(true)
    }
    onOpenChange(false)
    onConfirm()
  }

  const handleCancel = (): void => {
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px] gap-5">
        <DialogHeader className="gap-3 text-left">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[var(--creation-ui-primary-background)] text-[var(--creation-ui-primary)] flex items-center justify-center shrink-0 shadow-sm border border-[color-mix(in_srgb,var(--creation-ui-primary)_25%,transparent)]">
              <Lightbulb className="w-5 h-5" />
            </div>
            <div>
              <DialogTitle className="text-base font-semibold text-foreground">
                进入 Copis 创造模式
              </DialogTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                前沿探索与自进化工作区
              </p>
            </div>
          </div>
        </DialogHeader>

        <DialogDescription asChild>
          <div className="space-y-3.5 text-xs leading-relaxed text-muted-foreground">
            <p className="text-foreground/90">
              创造模式专为 Copis 自我进化设计。在此模式下，Agent 具备直接读写源码、重构组件及修改微内核配置的完整权限。
            </p>

            <div className="flex items-start gap-2.5 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs">
              <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="font-semibold text-amber-800 dark:text-amber-300">
                  自我迭代与稳定性提示
                </div>
                <div className="text-amber-700/90 dark:text-amber-400/90 leading-relaxed">
                  深层源码实验与热更新修改可能导致程序逻辑异常、界面闪退或意外崩溃。建议在进入前保存其他窗口的关键内容。
                </div>
              </div>
            </div>

            <label className="flex items-center gap-2.5 pt-1 cursor-pointer select-none text-muted-foreground hover:text-foreground transition-colors">
              <input
                type="checkbox"
                checked={dontAskAgain}
                onChange={(e) => setDontAskAgain(e.target.checked)}
                className="w-4 h-4 rounded border-border/80 accent-[var(--creation-ui-primary)] cursor-pointer"
              />
              <span className="text-xs">下次进入创造模式时不再提醒</span>
            </label>
          </div>
        </DialogDescription>

        <DialogFooter className="gap-2 sm:gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCancel}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            className="bg-[var(--creation-ui-primary)] hover:opacity-90 text-white font-medium gap-1.5 shadow-sm"
            onClick={handleConfirm}
          >
            <Lightbulb className="w-3.5 h-3.5" />
            <span>确认进入创造模式</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
