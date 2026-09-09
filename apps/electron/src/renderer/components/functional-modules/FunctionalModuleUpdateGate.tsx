import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { AlertCircle, CheckCircle2, Download, ExternalLink, Loader2, PackageCheck, RefreshCw, ShieldCheck, X } from 'lucide-react'
import type {
  AppInfo,
  FunctionalModuleProgressPayload,
  FunctionalModuleStartupProgressPayload,
  FunctionalModuleStatus,
} from '@copis/shared'
import { functionalModuleBusyAtom, functionalModuleProgressAtom, functionalModuleStartupAtom, functionalModuleStatusesAtom } from '@/atoms/functional-modules'
import { appInfoAtom, checkForUpdates, downloadUpdate, onlineUpdateAvailableAtom, updaterAvailableAtom, updateStatusAtom } from '@/atoms/updater'
import { isHttpApiBridgeActive } from '@/lib/http-api-bridge'
import { CopisAppLogo } from '@/lib/model-logo'
import { detectIsWindows, WINDOW_CONTROLS_INSET_RIGHT } from '@/lib/platform'
import { cn } from '@/lib/utils'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  COPIS_DOWNLOAD_URL,
  formatStartupBytes,
  getStartupClientUpdateDialog,
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
  const [clientUpdateDismissed, setClientUpdateDismissed] = React.useState(false)
  const [appInfo, setAppInfo] = useAtom(appInfoAtom)
  const updateStatus = useAtomValue(updateStatusAtom)
  const onlineUpdateAvailable = useAtomValue(onlineUpdateAvailableAtom)

  React.useEffect(() => {
    if (appInfo) return
    let active = true
    window.electronAPI?.getAppInfo?.()
      ?.then((info) => {
        if (active) setAppInfo(info)
      })
      ?.catch(() => {
        if (active) setAppInfo({ version: '-', packaged: false })
      })
    return () => {
      active = false
    }
  }, [appInfo, setAppInfo])
  const isDownloading = updateStatus.status === 'downloading'
  const isDownloaded = updateStatus.status === 'downloaded'
  const isChecking = updateStatus.status === 'checking'
  const isAvailable = updateStatus.status === 'available'
  const progressPercent = isDownloading
    ? Math.round(Math.min(100, Math.max(0, updateStatus.progress?.percent ?? 0)))
    : 0

  React.useEffect(() => {
    setClientUpdateDismissed(false)
  }, [startup.error])

  const applyStartupProgress = React.useCallback((payload: FunctionalModuleStartupProgressPayload): void => {
    const progress = clamp01(payload.progress)
    setStartup((current) => ({
      ...current,
      ...payload,
      progress: payload.phase === 'error' ? 0 : Math.max(current.progress, progress),
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
    setClientUpdateDismissed(false)
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
        progress: 0,
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

  const percentage = Math.round(clamp01(startup.progress) * 100)
  const phaseLabel = getStartupPhaseLabel(startup)
  const isError = startup.phase === 'error'
  const clientUpdateDialog = getStartupClientUpdateDialog(startup.error)
  const isClientUpdateDialogOpen = clientUpdateDialog !== null && !clientUpdateDismissed

  React.useEffect(() => {
    if (released) return
    if (clientUpdateDialog && onlineUpdateAvailable && updateStatus.status === 'idle') {
      void checkForUpdates().catch((error: unknown) => {
        console.warn('[功能模块] 检查客户端更新失败:', error)
      })
    }
  }, [clientUpdateDialog, onlineUpdateAvailable, released, updateStatus.status])

  const handleUpdateAction = React.useCallback(async (e?: React.MouseEvent): Promise<void> => {
    if (!onlineUpdateAvailable) {
      setClientUpdateDismissed(true)
      void window.electronAPI.openExternal(updateStatus.downloadUrl || COPIS_DOWNLOAD_URL).catch((error: unknown) => {
        console.error('[功能模块] 打开 Copis 下载页失败:', error)
      })
      return
    }

    if (updateStatus.status === 'downloaded') {
      void window.electronAPI.updater?.installWhenIdle()
      return
    }

    if (updateStatus.status === 'available') {
      e?.preventDefault?.()
      void downloadUpdate().catch((error: unknown) => {
        console.error('[功能模块] 下载客户端更新失败:', error)
      })
      return
    }

    if (updateStatus.status === 'error' || updateStatus.status === 'idle' || updateStatus.status === 'not-available') {
      e?.preventDefault?.()
      try {
        await checkForUpdates()
        const current = await window.electronAPI.updater?.getStatus?.()
        if (current?.status === 'available') {
          await downloadUpdate()
        }
      } catch (error) {
        console.error('[功能模块] 检查并下载更新失败:', error)
      }
    }
  }, [onlineUpdateAvailable, updateStatus.downloadUrl, updateStatus.status])

  const updateButtonLabel = React.useMemo(() => {
    if (!onlineUpdateAvailable) {
      return clientUpdateDialog?.actionLabel ?? '下载最新版本'
    }
    switch (updateStatus.status) {
      case 'downloaded':
        return '立即安装'
      case 'downloading':
        return `正在下载 (${progressPercent}%)`
      case 'checking':
        return '检查更新中...'
      case 'error':
        return '重试下载更新'
      case 'available':
      default:
        return '下载更新'
    }
  }, [clientUpdateDialog?.actionLabel, onlineUpdateAvailable, progressPercent, updateStatus.status])

  const dialogTitle = React.useMemo(() => {
    if (!clientUpdateDialog) return ''
    if (!onlineUpdateAvailable) return clientUpdateDialog.title
    if (isDownloaded) return '更新已下载完成'
    if (isDownloading) return '正在下载更新'
    return clientUpdateDialog.title
  }, [clientUpdateDialog, isDownloaded, isDownloading, onlineUpdateAvailable])

  const dialogDescription = React.useMemo(() => {
    if (!clientUpdateDialog) return ''
    if (!onlineUpdateAvailable) return clientUpdateDialog.description
    if (isDownloaded) {
      const ver = updateStatus.version ?? clientUpdateDialog.minClientVersion
      return `Copis v${ver} 已下载完成，点击立即安装并重启应用。`
    }
    if (isDownloading) {
      const ver = updateStatus.version ?? clientUpdateDialog.minClientVersion
      return `正在下载 Copis v${ver} (${progressPercent}%)，下载完成后可直接安装。`
    }
    if (isChecking) {
      return '正在检查最新版本更新包...'
    }
    if (updateStatus.status === 'error') {
      return `更新检查或下载失败：${updateStatus.error || '网络连接异常'}。您可以重试，或直接前往官网下载最新版本。`
    }
    if (isAvailable) {
      const ver = updateStatus.version ?? clientUpdateDialog.minClientVersion
      return `必要组件要求 Copis v${clientUpdateDialog.minClientVersion} 或更高版本。发现新版本 v${ver}，点击下载更新。`
    }
    return clientUpdateDialog.description
  }, [clientUpdateDialog, isAvailable, isChecking, isDownloaded, isDownloading, onlineUpdateAvailable, progressPercent, updateStatus.error, updateStatus.status, updateStatus.version])

  const activeModule = startup.activeModule
  const bytes = activeModule === 'rust-http-api' || activeModule === 'officecli' || activeModule === 'alipay-bot' || activeModule === 'playwright-core' || activeModule === 'python-runtime'
    ? `${formatStartupBytes(startup.downloadedBytes)}${startup.totalBytes ? ` / ${formatStartupBytes(startup.totalBytes)}` : ''}`
    : ''

  if (released) return <>{children}</>

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
                {isError ? (clientUpdateDialog ? clientUpdateDialog.title : 'Copis 暂时无法启动') : '正在准备 Copis'}
              </h1>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                {isError
                  ? (clientUpdateDialog
                    ? clientUpdateDialog.description
                    : '必要组件暂未准备完成，请重试后继续使用。')
                  : '正在检查并准备本地能力，完成后会自动进入工作区。'}
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
              {clientUpdateDialog && isDownloading && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>正在下载更新</span>
                    <span className="font-mono tabular-nums">{progressPercent}%</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full bg-primary transition-all duration-200"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-3">
                {clientUpdateDialog && (
                  <button
                    type="button"
                    disabled={isChecking || isDownloading}
                    className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                    onClick={(e) => void handleUpdateAction(e)}
                  >
                    {isChecking || isDownloading ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Download className="size-4" aria-hidden="true" />
                    )}
                    {updateButtonLabel}
                  </button>
                )}
                {clientUpdateDialog && updateStatus.status === 'error' && (
                  <button
                    type="button"
                    className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-input bg-background px-4 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                    onClick={() => {
                      void window.electronAPI.openExternal(updateStatus.downloadUrl || COPIS_DOWNLOAD_URL)
                    }}
                  >
                    <ExternalLink className="size-4" aria-hidden="true" />
                    前往官网下载
                  </button>
                )}
                <button
                  type="button"
                  className={cn(
                    'inline-flex min-h-9 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
                    clientUpdateDialog
                      ? 'border border-input bg-background hover:bg-accent hover:text-accent-foreground'
                      : 'bg-primary text-primary-foreground hover:bg-primary/90 self-start',
                  )}
                  onClick={() => void runStartup()}
                >
                  <RefreshCw className="size-4" aria-hidden="true" />
                  {clientUpdateDialog ? '重新检查' : '重试更新'}
                </button>
              </div>
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
      <AlertDialog
        open={isClientUpdateDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setClientUpdateDismissed(true)
          }
        }}
      >
        <AlertDialogContent>
          <button
            type="button"
            aria-label="关闭"
            className="absolute right-4 top-4 rounded-md p-1 opacity-60 transition-all duration-150 hover:opacity-100 hover:bg-accent/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none"
            onClick={() => setClientUpdateDismissed(true)}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">关闭</span>
          </button>
          <AlertDialogHeader>
            <AlertDialogTitle>{dialogTitle}</AlertDialogTitle>
            <AlertDialogDescription>{dialogDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          {isDownloading && (
            <div className="space-y-1.5 py-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>正在下载更新</span>
                <span className="font-mono tabular-nums">{progressPercent}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full bg-primary transition-all duration-200"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => setClientUpdateDismissed(true)}
            >
              {clientUpdateDialog?.cancelLabel ?? '关闭'}
            </AlertDialogCancel>
            <AlertDialogAction
              className="gap-2"
              disabled={isChecking || isDownloading}
              onClick={(e) => void handleUpdateAction(e)}
            >
              {isChecking || isDownloading ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="size-4" aria-hidden="true" />
              )}
              {updateButtonLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
