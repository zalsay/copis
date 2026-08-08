import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { AlertCircle, CheckCircle2, Download, Loader2, PackageCheck, RefreshCw } from 'lucide-react'
import type { FunctionalModuleProgressPayload, FunctionalModuleStatus } from '@copis/shared'
import {
  functionalModuleBusyAtom,
  functionalModuleProgressAtom,
  functionalModuleStatusesAtom,
} from '@/atoms/functional-modules'
import { SettingsCard } from './primitives'
import { Button } from '@/components/ui/button'
import {
  createEmptyFunctionalModuleStatus,
  FUNCTIONAL_MODULE_DEFINITIONS,
  getFunctionalModuleProgressText,
  getFunctionalModuleStateText,
  type FunctionalModuleDefinition,
} from './functional-module-ui'

export function FunctionalModulesCard(): React.ReactElement {
  const [statuses, setStatuses] = useAtom(functionalModuleStatusesAtom)
  const progresses = useAtomValue(functionalModuleProgressAtom)
  const [busy, setBusy] = useAtom(functionalModuleBusyAtom)
  const setProgress = useSetAtom(functionalModuleProgressAtom)

  const updateStatus = React.useCallback((next: FunctionalModuleStatus): void => {
    setStatuses((current) => ({ ...current, [next.name]: next }))
  }, [setStatuses])

  React.useEffect(() => {
    let active = true
    const load = async (): Promise<void> => {
      try {
        const modules = await window.electronAPI.listFunctionalModules()
        if (!active) return
        setStatuses((current) => {
          const next = { ...current }
          for (const module of modules) next[module.name] = module
          return next
        })
      } catch (error) {
        console.error('[功能模块] 读取状态失败:', error)
      }
    }
    void load()

    const unsubscribe = window.electronAPI.onFunctionalModuleProgress((next: FunctionalModuleProgressPayload) => {
      setProgress((current) => ({ ...current, [next.name]: next }))
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [setProgress, setStatuses])

  const runCheck = React.useCallback(async (definition: FunctionalModuleDefinition): Promise<void> => {
    const name = definition.name
    setBusy((current) => ({ ...current, [name]: true }))
    try {
      updateStatus(await window.electronAPI.checkFunctionalModule(name))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      updateStatus({ ...(statuses[name] ?? createEmptyFunctionalModuleStatus(definition)), error: message })
    } finally {
      setBusy((current) => ({ ...current, [name]: false }))
    }
  }, [setBusy, statuses, updateStatus])

  const runInstall = React.useCallback(async (definition: FunctionalModuleDefinition): Promise<void> => {
    const name = definition.name
    setBusy((current) => ({ ...current, [name]: true }))
    setProgress((current) => ({
      ...current,
      [name]: {
        name,
        phase: 'manifest',
        detail: '准备安装',
        progress: 0,
      },
    }))
    try {
      updateStatus(await window.electronAPI.installFunctionalModule({ name }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      updateStatus({ ...(statuses[name] ?? createEmptyFunctionalModuleStatus(definition)), error: message })
    } finally {
      setBusy((current) => ({ ...current, [name]: false }))
    }
  }, [setBusy, setProgress, statuses, updateStatus])

  const requiredInstalled = FUNCTIONAL_MODULE_DEFINITIONS
    .filter((definition) => definition.required)
    .every((definition) => statuses[definition.name]?.installed === true)

  return (
    <SettingsCard>
      <div className="flex items-center justify-between border-b p-4">
        <div className="flex items-center gap-2">
          <PackageCheck className="h-4 w-4 text-muted-foreground" />
          <div>
            <h3 className="text-sm font-medium">本地能力</h3>
            <p className="mt-1 text-xs text-muted-foreground">Copis 会自动管理使用所需的本地能力</p>
          </div>
        </div>
        <CheckCircle2 className={`h-4 w-4 ${requiredInstalled ? 'text-green-600' : 'text-muted-foreground'}`} />
      </div>

      <div className="space-y-3 p-4">
        {FUNCTIONAL_MODULE_DEFINITIONS.map((definition) => {
          const status = statuses[definition.name] ?? createEmptyFunctionalModuleStatus(definition)
          const progress = progresses[definition.name]
          const isBusy = busy[definition.name] === true
          const progressPercent = Math.round((progress?.progress ?? 0) * 100)
          const actionLabel = status.updateAvailable ? '更新' : status.installed ? '检查更新' : '安装'
          const ActionIcon = status.installed && !status.updateAvailable ? RefreshCw : Download

          return (
            <div key={definition.name} className="flex items-start gap-3 rounded-lg bg-card p-3 shadow-sm">
              <PackageCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-sm font-medium">{definition.displayName}</h4>
                      {status.required && <span className="text-[10px] text-muted-foreground">必需</span>}
                    </div>
                    <p className={`truncate text-xs ${status.error ? 'text-destructive' : 'text-muted-foreground'}`}>
                      {getFunctionalModuleStateText(status)}
                    </p>
                  </div>
                  {status.error && <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />}
                </div>
                <p className="mt-1.5 text-[11px] text-muted-foreground">{definition.description}</p>

                {isBusy && progress && (
                  <div className="mt-3 space-y-1.5">
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                      <span className="flex min-w-0 items-center gap-1.5 truncate">
                        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                        {getFunctionalModuleProgressText(progress)}
                      </span>
                      <span className="shrink-0">{progressPercent}%</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                      <div className="h-full bg-primary transition-all" style={{ width: `${progressPercent}%` }} />
                    </div>
                  </div>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  {!isBusy && !status.updateAvailable && status.installed && (
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void runCheck(definition)}>
                      <RefreshCw className="mr-1.5 h-3 w-3" />
                      检查更新
                    </Button>
                  )}
                  {!isBusy && (!status.installed || status.updateAvailable) && (
                    <Button size="sm" className="h-7 text-xs" onClick={() => void runInstall(definition)}>
                      <ActionIcon className="mr-1.5 h-3 w-3" />
                      {actionLabel}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </SettingsCard>
  )
}
