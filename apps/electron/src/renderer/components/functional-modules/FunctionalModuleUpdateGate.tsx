import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { AlertCircle, CheckCircle2, Loader2, PackageCheck, RefreshCw, ShieldCheck } from 'lucide-react'
import type {
  FunctionalModuleProgressPayload,
  FunctionalModuleStartupProgressPayload,
  FunctionalModuleStatus,
} from '@copis/shared'
import { functionalModuleBusyAtom, functionalModuleProgressAtom, functionalModuleStartupAtom, functionalModuleStatusesAtom } from '@/atoms/functional-modules'
import { isHttpApiBridgeActive } from '@/lib/http-api-bridge'
import { CopisAppLogo } from '@/lib/model-logo'
import { detectIsWindows, WINDOW_CONTROLS_INSET_RIGHT } from '@/lib/platform'
import { cn } from '@/lib/utils'
import {
  formatStartupBytes,
  getStartupErrorLabel,
  getStartupModuleDetail,
  getStartupModuleRowsForMode,
  getStartupPhaseLabel,
} from './functional-module-startup-ui'

interface FunctionalModuleUpdateGateProps {
  children: React.ReactNode
}

const INITIAL_PROGRESS: FunctionalModuleStartupProgressPayload = {
  phase: 'checking',
  detail: '正在检查必要组件',
  progress: 0,
}

export function FunctionalModuleUpdateGate({ children }: FunctionalModuleUpdateGateProps): React.ReactElement {
  const developmentMode = import.meta.env.DEV
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const [startup, setStartup] = useAtom(functionalModuleStartupAtom)
  const statuses = useAtomValue(functionalModuleStatusesAtom)
  const progresses = useAtomValue(functionalModuleProgressAtom)
  const setStatuses = useSetAtom(functionalModuleStatusesAtom)
  const setProgress = useSetAtom(functionalModuleProgressAtom)
  const setBusy = useSetAtom(functionalModuleBusyAtom)
  const [released, setReleased] = React.useState(false)

  const applyStartupProgress = React.useCallback((payload: FunctionalModuleStartupProgressPayload): void => {
    const progress = clamp01(payload.progress)
    setStartup((current) => ({
      ...current,
      ...payload,
      progress: Math.max(current.progress, progress),
      error: payload.phase === 'error' ? payload.error ?? payload.detail : null,
    }))
  }, [setStartup])

  const applyModuleProgress = React.useCallback((payload: FunctionalModuleProgressPayload): void => {
    setProgress((current) => ({ ...current, [payload.name]: payload }))
    setBusy((current) => ({
      ...current,
      [payload.name]: payload.phase !== 'done' && payload.phase !== 'error',
    }))
  }, [setBusy, setProgress])

  const runStartup = React.useCallback(async (): Promise<void> => {
    setReleased(false)
    setStartup({ ...INITIAL_PROGRESS, error: null })
    setBusy({ 'node-runtime': true, 'officecli': true, 'alipay-bot': true, 'rust-http-api': true, 'playwright-core': true, 'python-runtime': true })
    try {
      const nextStatuses = await window.electronAPI.ensureRequiredFunctionalModules()
      setStatuses((current) => mergeStatuses(current, nextStatuses))
      setBusy({ 'node-runtime': false, 'officecli': false, 'alipay-bot': false, 'rust-http-api': false, 'playwright-core': false, 'python-runtime': false })
      setStartup({ phase: 'ready', detail: '本地服务运行正常', progress: 1, error: null })
      window.setTimeout(() => setReleased(true), 260)
    } catch (error) {
      const message = error instanceof Error ? error.message : '必要组件准备失败，请重试'
      setBusy({ 'node-runtime': false, 'officecli': false, 'alipay-bot': false, 'rust-http-api': false, 'playwright-core': false, 'python-runtime': false })
      setStartup((current) => ({
        ...current,
        phase: 'error',
        detail: message,
        error: message,
      }))
    }
  }, [setBusy, setReleased, setStartup, setStatuses])

  React.useEffect(() => {
    if (isHttpApiBridgeActive()) {
      setStartup({ phase: 'ready', detail: '浏览器版已准备好', progress: 1, error: null })
      setReleased(true)
      return undefined
    }

    let active = true
    const unsubscribeStartup = window.electronAPI.onFunctionalModuleStartupProgress((payload) => {
      if (active) applyStartupProgress(payload)
    })
    const unsubscribeModule = developmentMode
      ? () => {}
      : window.electronAPI.onFunctionalModuleProgress((payload) => {
        if (active) applyModuleProgress(payload)
      })

    if (!developmentMode) {
      void window.electronAPI.listFunctionalModules()
        .then((nextStatuses) => {
          if (active) setStatuses((current) => mergeStatuses(current, nextStatuses))
        })
        .catch((error: unknown) => {
          console.warn('[功能模块] 读取启动前状态失败:', error)
        })
    }

    void runStartup()
    return () => {
      active = false
      unsubscribeStartup()
      unsubscribeModule()
    }
  }, [applyModuleProgress, applyStartupProgress, developmentMode, runStartup, setStatuses, setStartup])

  if (released) return <>{children}</>

  const percentage = Math.round(clamp01(startup.progress) * 100)
  const phaseLabel = getStartupPhaseLabel(startup)
  const isError = startup.phase === 'error'
  const activeModule = startup.activeModule
  const bytes = activeModule === 'rust-http-api' || activeModule === 'officecli' || activeModule === 'alipay-bot' || activeModule === 'playwright-core' || activeModule === 'python-runtime'
    ? `${formatStartupBytes(startup.downloadedBytes)}${startup.totalBytes ? ` / ${formatStartupBytes(startup.totalBytes)}` : ''}`
    : ''

  return (
    <main
      className="flex h-full min-h-0 overflow-auto bg-background text-foreground"
      aria-busy={!isError && startup.phase !== 'ready'}
      aria-label="Copis 启动准备"
    >
      <div className="flex min-h-full w-full flex-col px-6 pb-10 pt-0 sm:px-10">
        <div className="relative -mx-6 h-[35px] shrink-0 bg-[hsl(var(--sidebar-surface))] sm:-mx-10">
          <div
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute inset-y-0 left-0 titlebar-drag-region',
              isWindows ? WINDOW_CONTROLS_INSET_RIGHT : 'right-0',
            )}
          />
        </div>

        <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center py-10 sm:py-14">
          <header className="flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <img src={CopisAppLogo} alt="Copis" className="size-11 rounded-xl shadow-sm" />
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Copis</p>
                <p className="mt-1 text-sm text-muted-foreground">正在准备本地能力</p>
              </div>
            </div>
            <div className="max-w-xl">
              <p className={`text-sm font-medium ${isError ? 'text-destructive' : 'text-primary'}`}>
                {isError ? '启动遇到问题' : phaseLabel}
              </p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
                {isError ? 'Copis 暂时无法启动' : '正在准备 Copis'}
              </h1>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                {isError ? '必要组件暂未准备完成，请重试后继续使用。' : '正在检查并准备本地能力，完成后会自动进入工作区。'}
              </p>
            </div>
          </header>

          <div className="mt-10 space-y-3" aria-live="polite">
            <div className="flex items-end justify-between gap-4">
              <div className="min-w-0">
                <p className={`truncate text-sm font-medium ${isError ? 'text-destructive' : 'text-foreground'}`}>{isError ? getStartupErrorLabel(startup.error) : phaseLabel}</p>
                <p className="mt-1 min-h-5 text-xs tabular-nums text-muted-foreground">{bytes || '正在确认安装状态'}</p>
              </div>
              <strong className={`shrink-0 text-2xl tabular-nums ${isError ? 'text-destructive' : 'text-foreground'}`}>{percentage}%</strong>
            </div>
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-secondary"
              role="progressbar"
              aria-label="本地能力准备进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percentage}
            >
              <div
                className={`h-full rounded-full transition-[width] duration-300 ease-out ${isError ? 'bg-destructive' : 'bg-primary'}`}
                style={{ width: `${percentage}%` }}
              />
            </div>
          </div>

          {developmentMode ? (
            <div className="mt-8 flex items-center gap-3 rounded-lg bg-card p-4 shadow-sm ring-1 ring-border/60" aria-label="本地服务检查">
              <ShieldCheck className={`size-4 shrink-0 ${startup.phase === 'ready' ? 'text-primary' : 'text-muted-foreground'}`} aria-hidden="true" />
              <p className="min-w-0 text-sm text-muted-foreground">
                {startup.phase === 'ready' ? '本地服务运行正常' : '正在检查本地服务是否可用'}
              </p>
            </div>
          ) : (
            <div className="mt-8 grid gap-3" aria-label="必要组件">
              {getStartupModuleRowsForMode(developmentMode).map((row) => (
                <StartupModuleRow
                  key={row.name}
                  displayName={row.displayName}
                  description={row.description}
                  status={statuses[row.name]}
                  active={activeModule === row.name}
                  progress={progresses[row.name]}
                  error={isError && activeModule === row.name ? getStartupErrorLabel(startup.error) : null}
                />
              ))}
            </div>
          )}

          {isError && (
            <div className="mt-8 flex flex-col gap-4 rounded-lg bg-destructive/10 p-4" role="alert">
              <div className="flex items-start gap-3">
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
                <p className="min-w-0 text-sm leading-6 text-destructive">{getStartupErrorLabel(startup.error)}</p>
              </div>
              <button
                type="button"
                className="inline-flex min-h-9 items-center justify-center gap-2 self-start rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                onClick={() => void runStartup()}
              >
                <RefreshCw className="size-4" aria-hidden="true" />
                重试更新
              </button>
            </div>
          )}

          {!isError && startup.phase === 'ready' && (
            <p className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
              <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
              本地服务运行正常
            </p>
          )}
        </section>
      </div>
    </main>
  )
}

interface StartupModuleRowProps {
  displayName: string
  description: string
  status: FunctionalModuleStatus | undefined
  active: boolean
  progress: FunctionalModuleProgressPayload | undefined
  error: string | null
}

function StartupModuleRow({ displayName, description, status, active, progress, error }: StartupModuleRowProps): React.ReactElement {
  const isInstalled = status?.installed === true
  const isDone = isInstalled && status?.updateAvailable !== true && !error
  const isWorking = active && !isDone && !error
  const Icon = error ? AlertCircle : isDone ? CheckCircle2 : isWorking ? Loader2 : PackageCheck
  const detail = error
    ?? (isWorking
      ? getStartupModuleDetail(progress)
      : isDone
        ? getStartupModuleDetail({ phase: 'done', version: status?.version ?? undefined })
        : '等待准备')

  return (
    <div className="flex min-w-0 items-start gap-3 rounded-lg bg-card p-4 shadow-sm ring-1 ring-border/60">
      <Icon className={`mt-0.5 size-4 shrink-0 ${error ? 'text-destructive' : isDone ? 'text-primary' : isWorking ? 'animate-spin text-primary' : 'text-muted-foreground'}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-sm font-medium">{displayName}</p>
          <span className="text-[11px] text-muted-foreground">必要</span>
        </div>
        <p className={`mt-1 truncate text-xs ${error ? 'text-destructive' : 'text-muted-foreground'}`}>{detail}</p>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

function mergeStatuses(
  current: Partial<Record<FunctionalModuleStatus['name'], FunctionalModuleStatus>>,
  next: FunctionalModuleStatus[],
): Partial<Record<FunctionalModuleStatus['name'], FunctionalModuleStatus>> {
  const merged = { ...current }
  for (const status of next) merged[status.name] = status
  return merged
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
}
