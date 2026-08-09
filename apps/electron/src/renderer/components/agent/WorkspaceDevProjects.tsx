import * as React from 'react'
import { CircleAlert, ExternalLink, FolderCode, LoaderCircle, Play, RefreshCw, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  listWorkspaceDevProjects,
  startWorkspaceDevProject,
  stopWorkspaceDevProject,
  type WorkspaceDevProject,
} from '@/lib/workspace-dev-api'

interface WorkspaceDevProjectsProps {
  workspaceSlug: string | null
}

function updateProject(items: WorkspaceDevProject[], updated: WorkspaceDevProject): WorkspaceDevProject[] {
  return items.map((project) => project.projectPath === updated.projectPath ? updated : project)
}

async function openProjectUrl(project: WorkspaceDevProject): Promise<void> {
  if (!project.url) return
  await window.electronAPI.webTabs.create({ url: project.url, activate: true })
}

export function WorkspaceDevProjects({ workspaceSlug }: WorkspaceDevProjectsProps): React.ReactElement {
  const [projects, setProjects] = React.useState<WorkspaceDevProject[]>([])
  const [loading, setLoading] = React.useState(false)
  const [busyProjectPath, setBusyProjectPath] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    if (!workspaceSlug) {
      setProjects([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      setProjects(await listWorkspaceDevProjects(workspaceSlug))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '读取项目列表失败')
    } finally {
      setLoading(false)
    }
  }, [workspaceSlug])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const toggleProject = React.useCallback(async (project: WorkspaceDevProject) => {
    if (!workspaceSlug) return
    setBusyProjectPath(project.projectPath)
    setError(null)
    try {
      const updated = project.status === 'running'
        ? await stopWorkspaceDevProject(workspaceSlug, project.projectPath)
        : await startWorkspaceDevProject(workspaceSlug, project.projectPath)
      setProjects((current) => updateProject(current, updated))
      if (updated.status === 'running' && updated.url) {
        try {
          await window.electronAPI.webTabs.create({ url: updated.url, activate: true })
        } catch (browserError) {
          const message = browserError instanceof Error ? browserError.message : '未知错误'
          setError(`开发服务已启动，但无法打开内置浏览器：${message}`)
        }
      }
      window.setTimeout(() => void refresh(), 900)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '更新开发服务失败')
    } finally {
      setBusyProjectPath(null)
    }
  }, [refresh, workspaceSlug])

  const reopenProject = React.useCallback(async (project: WorkspaceDevProject) => {
    setError(null)
    try {
      await openProjectUrl(project)
    } catch (browserError) {
      const message = browserError instanceof Error ? browserError.message : '未知错误'
      setError(`无法打开项目页面：${message}`)
    }
  }, [])

  if (!workspaceSlug) {
    return <EmptyState text="请选择工作区后查看项目" />
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col px-2 pb-2 pt-2" aria-label="项目列表">
      <div className="mb-2 flex h-7 items-center justify-end px-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => void refresh()}
              disabled={loading}
              aria-label="刷新项目列表"
            >
              <RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>刷新项目列表</TooltipContent>
        </Tooltip>
      </div>

      {error && (
        <div className="mb-2 flex items-start gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] leading-4 text-destructive">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading && projects.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          <LoaderCircle className="mr-2 size-3.5 animate-spin" />正在读取项目
        </div>
      ) : projects.length === 0 ? (
        <EmptyState text="在 project/ 下创建包含 Vite dev 脚本的项目后会显示在这里" />
      ) : (
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto scrollbar-thin">
          {projects.map((project) => {
            const busy = busyProjectPath === project.projectPath
            const running = project.status === 'running'
            return (
              <div key={project.projectPath} className="group flex min-h-11 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/60">
                <FolderCode className={running ? 'size-4 shrink-0 text-primary' : 'size-4 shrink-0 text-muted-foreground'} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground" title={project.name}>{project.name}</div>
                  <div className="truncate text-[10px] text-muted-foreground" title={project.projectPath}>
                    {project.projectPath === '.' ? 'project/' : `project/${project.projectPath}`}
                    {project.port ? `  :${project.port}` : ''}
                  </div>
                </div>
                {running && project.url && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 text-primary hover:text-primary"
                        onClick={() => void reopenProject(project)}
                        disabled={busy}
                        aria-label={`重新打开 ${project.name}`}
                      >
                        <ExternalLink className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>重新打开项目页面</TooltipContent>
                  </Tooltip>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={running ? 'size-7 text-destructive hover:text-destructive' : 'size-7 text-primary hover:text-primary'}
                      onClick={() => void toggleProject(project)}
                      disabled={busy}
                      aria-label={running ? `停止 ${project.name}` : `启动 ${project.name}`}
                    >
                      {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : running ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{running ? '停止开发服务' : '启动开发服务'}</TooltipContent>
                </Tooltip>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function EmptyState({ text }: { text: string }): React.ReactElement {
  return <div className="flex flex-1 items-center justify-center px-5 text-center text-xs leading-5 text-muted-foreground">{text}</div>
}
