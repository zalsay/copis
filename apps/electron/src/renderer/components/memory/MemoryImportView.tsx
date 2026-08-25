import * as React from 'react'
import { CheckCircle2, FileText, Loader2, Upload, X } from 'lucide-react'
import { useAtom, useSetAtom } from 'jotai'
import type { AgentWorkspace, MemoryImportInput, MemoryImportItemInput, MemoryKind } from '@copis/shared'
import {
  memoryImportErrorAtom,
  memoryImportItemsAtom,
  memoryImportLoadingAtom,
  memoryImportResultAtom,
  memoryImportScopeAtom,
  memoryPageAtom,
  memoryRefreshTokenAtom,
} from '@/atoms/memory-atoms'
import { memoryApi } from '@/lib/memory-api'
import { parseMemoryImportFile, parseMarkdownImport } from '@/lib/memory-import-parser'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

interface MemoryImportViewProps {
  workspaceSlug: string | null
  workspaces: AgentWorkspace[]
}

const KIND_LABELS: Record<MemoryKind, string> = {
  fact: '事实',
  preference: '偏好',
  decision: '决策',
  project: '项目',
  scratch: '草稿',
}

const KIND_COLORS: Record<MemoryKind, string> = {
  fact: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
  preference: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20',
  decision: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
  project: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
  scratch: 'bg-muted text-muted-foreground border-border/40',
}

export function buildMemoryImportInput(
  scope: 'current-workspace' | 'user',
  workspaceSlug: string | null,
  items: MemoryImportItemInput[],
): MemoryImportInput {
  return {
    scope: scope === 'current-workspace' && workspaceSlug ? 'workspace' : 'user',
    workspaceSlug: scope === 'current-workspace' ? workspaceSlug ?? undefined : undefined,
    items,
  }
}

export function MemoryImportView({ workspaceSlug, workspaces }: MemoryImportViewProps): React.ReactElement {
  const [scope, setScope] = useAtom(memoryImportScopeAtom)
  const [items, setItems] = useAtom(memoryImportItemsAtom)
  const [loading, setLoading] = useAtom(memoryImportLoadingAtom)
  const [errorMessage, setErrorMessage] = useAtom(memoryImportErrorAtom)
  const [result, setResult] = useAtom(memoryImportResultAtom)
  const setPage = useSetAtom(memoryPageAtom)
  const setRefreshToken = useSetAtom(memoryRefreshTokenAtom)

  const [defaultKind, setDefaultKind] = React.useState<MemoryKind>('fact')
  const [rawText, setRawText] = React.useState('')
  const [fileName, setFileName] = React.useState<string | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const currentWorkspace = workspaces.find((w) => w.slug === workspaceSlug)

  React.useEffect(() => {
    if (!workspaceSlug && scope === 'current-workspace') {
      setScope('user')
    }
  }, [scope, setScope, workspaceSlug])

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    if (!file) return

    setFileName(file.name)
    setErrorMessage(null)
    setResult(null)

    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string
        const parsed = parseMemoryImportFile(content, file.name, defaultKind)
        setItems(parsed)
        if (parsed.length === 0) {
          toast.warning('未解析到有效的记忆条目')
        } else {
          toast.success(`成功解析出 ${parsed.length} 条知识卡片`)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : '解析文件失败'
        setErrorMessage(msg)
        toast.error(msg)
      }
    }
    reader.readAsText(file)
  }

  const handleTextParse = (): void => {
    if (!rawText.trim()) return
    setErrorMessage(null)
    setResult(null)
    setFileName(null)
    try {
      const parsed = parseMarkdownImport(rawText, defaultKind)
      setItems(parsed)
      if (parsed.length === 0) {
        toast.warning('未解析到有效的记忆条目')
      } else {
        toast.success(`成功解析出 ${parsed.length} 条知识卡片`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '解析文本失败'
      setErrorMessage(msg)
      toast.error(msg)
    }
  }

  const handleClear = (): void => {
    setItems([])
    setRawText('')
    setFileName(null)
    setErrorMessage(null)
    setResult(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleImport = async (): Promise<void> => {
    if (items.length === 0) return
    setLoading(true)
    setErrorMessage(null)
    setResult(null)

    try {
      const input = buildMemoryImportInput(scope, workspaceSlug, items)
      const res = await memoryApi.import(input)
      setResult(res)
      setRefreshToken((prev) => prev + 1)
      toast.success(`导入成功：新增 ${res.imported} 条，去重 ${res.deduplicated} 条`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '导入知识库失败'
      setErrorMessage(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  // 统计类型分布
  const kindCounts = React.useMemo(() => {
    const counts: Partial<Record<MemoryKind, number>> = {}
    for (const item of items) {
      counts[item.kind] = (counts[item.kind] ?? 0) + 1
    }
    return counts
  }, [items])

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-6 md:p-8">
      <div className="mx-auto w-full max-w-4xl space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">导入知识库</h1>
          <p className="mt-1 text-sm text-foreground/60">
            支持导入 Copis / QM 导出的 JSON 文件，或 Markdown 知识库笔记与 Bullet 事实列表。
          </p>
        </div>

        {/* 导入设置卡片 */}
        <div className="rounded-xl border border-border/50 bg-card/60 p-5 shadow-xs">
          <h2 className="text-sm font-medium text-foreground">导入目标与默认分类</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-foreground/70">导入范围</label>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as 'current-workspace' | 'user')}
                aria-label="导入范围"
                className="mt-1.5 h-9 w-full rounded-lg border border-border/50 bg-background px-3 text-sm text-foreground/80 outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                {workspaceSlug && (
                  <option value="current-workspace">当前项目（{currentWorkspace?.name ?? workspaceSlug}）</option>
                )}
                <option value="user">用户记忆（全局通用）</option>
              </select>
            </div>

            <div>
              <label className="text-xs font-medium text-foreground/70">默认知识分类</label>
              <select
                value={defaultKind}
                onChange={(e) => setDefaultKind(e.target.value as MemoryKind)}
                aria-label="默认知识分类"
                className="mt-1.5 h-9 w-full rounded-lg border border-border/50 bg-background px-3 text-sm text-foreground/80 outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                <option value="fact">事实 (fact)</option>
                <option value="preference">偏好 (preference)</option>
                <option value="decision">决策 (decision)</option>
                <option value="project">项目 (project)</option>
                <option value="scratch">草稿 (scratch)</option>
              </select>
            </div>
          </div>
        </div>

        {/* 文件上传或直接粘贴卡片 */}
        <div className="rounded-xl border border-border/50 bg-card/60 p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-foreground">选择知识文件或粘贴文本</h2>
            {items.length > 0 && (
              <button
                type="button"
                onClick={handleClear}
                className="flex items-center gap-1 text-xs text-foreground/50 transition-colors hover:text-destructive"
              >
                <X className="size-3.5" />
                清空重选
              </button>
            )}
          </div>

          <div className="mt-4 grid gap-4">
            {/* 上传区域 */}
            <div
              onClick={() => fileInputRef.current?.click()}
              className="flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-border/80 bg-muted/20 px-6 py-6 text-center transition-colors hover:border-primary/60 hover:bg-muted/40"
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.md,.markdown,.txt"
                onChange={handleFileChange}
                className="hidden"
              />
              <Upload className="size-8 text-foreground/40" />
              <p className="mt-2 text-sm font-medium text-foreground">
                {fileName ? `已选文件：${fileName}` : '点击或拖拽文件到此处'}
              </p>
              <p className="mt-1 text-xs text-foreground/50">支持 .json, .md, .markdown, .txt 格式</p>
            </div>

            {/* 直接粘贴文本 */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-foreground/70">或者直接粘贴 Markdown / 文本内容：</label>
              <textarea
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                placeholder="在此粘贴 Markdown 笔记或 Bullet 事实列表（例如：- [fact] 部署端口为 5173 #port）"
                rows={4}
                className="w-full rounded-lg border border-border/50 bg-background p-3 text-xs leading-relaxed text-foreground placeholder:text-foreground/35 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
              {rawText.trim() && (
                <button
                  type="button"
                  onClick={handleTextParse}
                  className="rounded-lg bg-muted px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/80"
                >
                  解析粘贴内容
                </button>
              )}
            </div>
          </div>
        </div>

        {/* 错误提示 */}
        {errorMessage && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
            {errorMessage}
          </div>
        )}

        {/* 导入结果卡片 */}
        {result && (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-5">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <div className="flex-1">
                <h3 className="text-sm font-medium text-emerald-900 dark:text-emerald-100">知识库导入成功</h3>
                <p className="mt-1 text-xs text-emerald-800/80 dark:text-emerald-200/80">
                  成功导入 <strong className="font-semibold">{result.imported}</strong> 条，
                  自动去重跳过 <strong className="font-semibold">{result.deduplicated}</strong> 条，
                  共处理 {result.total} 条知识条目。
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setPage('current')}
                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-xs transition-colors hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-600"
                  >
                    前往当前项目查看
                  </button>
                  <button
                    type="button"
                    onClick={handleClear}
                    className="rounded-lg border border-emerald-600/30 px-3 py-1.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-600/10 dark:text-emerald-300"
                  >
                    继续导入
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 解析预览卡片 */}
        {items.length > 0 && !result && (
          <div className="rounded-xl border border-border/50 bg-card/60 p-5 shadow-xs">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-4">
              <div>
                <h2 className="text-sm font-medium text-foreground">
                  待导入知识卡片（共 {items.length} 条）
                </h2>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {(Object.keys(kindCounts) as MemoryKind[]).map((k) => (
                    <span
                      key={k}
                      className={cn(
                        'inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium',
                        KIND_COLORS[k],
                      )}
                    >
                      {KIND_LABELS[k]}: {kindCounts[k]}
                    </span>
                  ))}
                </div>
              </div>

              <button
                type="button"
                onClick={handleImport}
                disabled={loading}
                className="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                {loading ? '正在导入...' : `确认导入（${items.length} 条）`}
              </button>
            </div>

            {/* 预览条目列表 */}
            <div className="mt-4 max-h-96 space-y-2.5 overflow-y-auto pr-1">
              {items.map((item, idx) => (
                <div
                  key={idx}
                  className="rounded-lg border border-border/40 bg-background/60 p-3 text-xs transition-colors hover:border-border"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none',
                        KIND_COLORS[item.kind],
                      )}
                    >
                      {KIND_LABELS[item.kind]}
                    </span>
                    <span className="font-medium text-foreground">{item.title}</span>
                    {item.tags && item.tags.length > 0 && (
                      <div className="ml-auto flex flex-wrap gap-1">
                        {item.tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground/60"
                          >
                            #{tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-foreground/75 leading-relaxed">
                    {item.content}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
