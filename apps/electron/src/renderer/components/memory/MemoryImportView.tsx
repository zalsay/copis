import * as React from 'react'
import {
  BookOpen,
  CheckCircle2,
  FileCode,
  FileText,
  Globe,
  Loader2,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
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
import { AppSelect } from '@/components/ui/select'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

export type ImportTabMode = 'file' | 'doc_ai' | 'web_ai'

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

  const [activeTab, setActiveTab] = React.useState<ImportTabMode>('doc_ai')
  const [defaultKind, setDefaultKind] = React.useState<MemoryKind>('fact')
  const [rawText, setRawText] = React.useState('')
  const [fileName, setFileName] = React.useState<string | null>(null)
  const [targetUrl, setTargetUrl] = React.useState('')
  const [ingestionStage, setIngestionStage] = React.useState<string | null>(null)
  const [isProcessing, setIsProcessing] = React.useState(false)

  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const docAiInputRef = React.useRef<HTMLInputElement>(null)

  const currentWorkspace = workspaces.find((w) => w.slug === workspaceSlug)

  React.useEffect(() => {
    if (!workspaceSlug && scope === 'current-workspace') {
      setScope('user')
    }
  }, [scope, setScope, workspaceSlug])

  // 处理结构化文件选择（Tab 1）
  const handleStructuredFileChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
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

  // 处理文本直接解析（Tab 1）
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

  // 路径 2：处理本地原始文档 AI 抽取
  const handleDocAiFileChange = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    if (!file) return

    setFileName(file.name)
    setErrorMessage(null)
    setResult(null)
    setIsProcessing(true)

    try {
      setIngestionStage('正在解析文档内容（PDF/Word/Office）...')
      let filePath = ''
      try {
        filePath = window.electronAPI.getPathForFile(file)
      } catch {
        filePath = ''
      }

      let extractedText = ''
      if (filePath && window.electronAPI.parseDocumentFile) {
        extractedText = await window.electronAPI.parseDocumentFile(filePath)
      } else {
        // 纯文本兜底
        extractedText = await file.text()
      }

      if (!extractedText.trim()) {
        throw new Error('未能从文档中提取到文字内容')
      }

      setIngestionStage('正在调用 AI 模型提炼高价值知识点（Copis 抽取协议）...')
      if (window.electronAPI.extractKnowledgeFromText) {
        const extractRes = await window.electronAPI.extractKnowledgeFromText({
          text: extractedText,
          defaultKind,
        })
        setItems(extractRes.items)
        if (extractRes.items.length === 0) {
          toast.warning('AI 提炼完成，但未发现符合长期沉淀规则的事实')
        } else {
          toast.success(`AI 智能提炼出 ${extractRes.items.length} 条知识卡片`)
        }
      } else {
        const parsed = parseMarkdownImport(extractedText, defaultKind)
        setItems(parsed)
        toast.success(`成功解析出 ${parsed.length} 条卡片`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '文档提炼失败'
      setErrorMessage(msg)
      toast.error(msg)
    } finally {
      setIsProcessing(false)
      setIngestionStage(null)
    }
  }

  // 路径 3：处理网页 URL 抓取与 AI 提炼
  const handleWebUrlIngestion = async (): Promise<void> => {
    const url = targetUrl.trim()
    if (!url) return
    if (!/^https?:\/\//i.test(url)) {
      toast.error('请输入以 http:// 或 https:// 开头的网页链接')
      return
    }

    setErrorMessage(null)
    setResult(null)
    setIsProcessing(true)

    try {
      setIngestionStage(`正在抓取网页内容（${new URL(url).hostname}）...`)
      if (!window.electronAPI.fetchUrlContent || !window.electronAPI.extractKnowledgeFromText) {
        throw new Error('当前环境不支持网页内容直接抓取')
      }

      const fetchRes = await window.electronAPI.fetchUrlContent(url)
      setIngestionStage('正在调用 AI 模型提炼网页核心知识与规范...')

      const extractRes = await window.electronAPI.extractKnowledgeFromText({
        text: `# ${fetchRes.title}\nURL: ${fetchRes.url}\n\n${fetchRes.content}`,
        defaultKind,
      })

      setItems(extractRes.items)
      if (extractRes.items.length === 0) {
        toast.warning('网页提炼完成，未提取到符合条件的知识卡片')
      } else {
        toast.success(`从网页《${fetchRes.title}》中提炼出 ${extractRes.items.length} 条知识卡片`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '网页抓取提炼失败'
      setErrorMessage(msg)
      toast.error(msg)
    } finally {
      setIsProcessing(false)
      setIngestionStage(null)
    }
  }

  // 移除单条预览条目
  const handleRemoveItem = (index: number): void => {
    setItems((prev) => prev.filter((_, i) => i !== index))
  }

  const handleClear = (): void => {
    setItems([])
    setRawText('')
    setFileName(null)
    setTargetUrl('')
    setErrorMessage(null)
    setResult(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
    if (docAiInputRef.current) docAiInputRef.current.value = ''
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
          <h1 className="text-xl font-semibold tracking-tight text-foreground">导入与沉淀知识库</h1>
          <p className="mt-1 text-sm text-foreground/60">
            通过结构化文件、本地原始文档 AI 提炼或在线网页抓取，将外部资料转换为 Copis 原子知识库。
          </p>
        </div>

        {/* 导入模式 Tabs */}
        <div className="flex gap-2 border-b border-border/50 pb-2">
          <button
            type="button"
            onClick={() => { setActiveTab('doc_ai'); setErrorMessage(null); }}
            className={cn(
              'flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors',
              activeTab === 'doc_ai'
                ? 'bg-primary/10 text-primary shadow-2xs'
                : 'text-foreground/60 hover:bg-muted hover:text-foreground',
            )}
          >
            <Sparkles className="size-4" />
            <span>文档智能抽取 (PDF/Word/Office)</span>
          </button>
          <button
            type="button"
            onClick={() => { setActiveTab('web_ai'); setErrorMessage(null); }}
            className={cn(
              'flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors',
              activeTab === 'web_ai'
                ? 'bg-primary/10 text-primary shadow-2xs'
                : 'text-foreground/60 hover:bg-muted hover:text-foreground',
            )}
          >
            <Globe className="size-4" />
            <span>网页链接抓取 (URL)</span>
          </button>
          <button
            type="button"
            onClick={() => { setActiveTab('file'); setErrorMessage(null); }}
            className={cn(
              'flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors',
              activeTab === 'file'
                ? 'bg-primary/10 text-primary shadow-2xs'
                : 'text-foreground/60 hover:bg-muted hover:text-foreground',
            )}
          >
            <FileCode className="size-4" />
            <span>结构化文件导入 (JSON/Markdown)</span>
          </button>
        </div>

        {/* 导入设置卡片 */}
        <div className="rounded-xl border border-border/50 bg-card/60 p-5 shadow-xs">
          <h2 className="text-sm font-medium text-foreground">目标范围与默认分类</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-foreground/70">导入目标范围</label>
              <AppSelect
                value={scope}
                onValueChange={(val) => setScope(val as 'current-workspace' | 'user')}
                aria-label="导入范围"
                triggerClassName="mt-1.5 h-9 w-full bg-background"
                options={[
                  ...(workspaceSlug
                    ? [
                        {
                          value: 'current-workspace',
                          label: `当前项目（${currentWorkspace?.name ?? workspaceSlug}）`,
                        },
                      ]
                    : []),
                  { value: 'user', label: '用户记忆（全局通用）' },
                ]}
              />
            </div>

            <div>
              <label className="text-xs font-medium text-foreground/70">默认知识分类</label>
              <AppSelect
                value={defaultKind}
                onValueChange={(val) => setDefaultKind(val as MemoryKind)}
                aria-label="默认知识分类"
                triggerClassName="mt-1.5 h-9 w-full bg-background"
                options={[
                  { value: 'fact', label: '事实 (fact)' },
                  { value: 'preference', label: '偏好 (preference)' },
                  { value: 'decision', label: '决策 (decision)' },
                  { value: 'project', label: '项目 (project)' },
                  { value: 'scratch', label: '草稿 (scratch)' },
                ]}
              />
            </div>
          </div>
        </div>

        {/* Tab 2: 本地原始文档 AI 提炼 */}
        {activeTab === 'doc_ai' && (
          <div className="rounded-xl border border-border/50 bg-card/60 p-5 shadow-xs">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-medium text-foreground">本地原始文档智能提炼</h2>
                <p className="mt-1 text-xs text-foreground/50">
                  支持上传长篇技术文档、API 手册、需求规格书，AI 将自动解构为原子知识点。
                </p>
              </div>
              {items.length > 0 && (
                <button
                  type="button"
                  onClick={handleClear}
                  className="flex items-center gap-1 text-xs text-foreground/50 transition-colors hover:text-destructive"
                >
                  <X className="size-3.5" />
                  清空重新选择
                </button>
              )}
            </div>

            <div className="mt-4">
              <div
                onClick={() => !isProcessing && docAiInputRef.current?.click()}
                className={cn(
                  'flex flex-col items-center justify-center rounded-xl border border-dashed border-border/80 bg-muted/20 px-6 py-8 text-center transition-colors',
                  isProcessing ? 'cursor-not-allowed opacity-75' : 'cursor-pointer hover:border-primary/60 hover:bg-muted/40',
                )}
              >
                <input
                  ref={docAiInputRef}
                  type="file"
                  accept=".pdf,.docx,.doc,.xlsx,.pptx,.rtf,.txt,.md"
                  onChange={handleDocAiFileChange}
                  disabled={isProcessing}
                  className="hidden"
                />
                {isProcessing ? (
                  <div className="flex flex-col items-center">
                    <Loader2 className="size-8 animate-spin text-primary" />
                    <p className="mt-3 text-sm font-medium text-foreground">{ingestionStage}</p>
                  </div>
                ) : (
                  <>
                    <Upload className="size-8 text-foreground/40" />
                    <p className="mt-2 text-sm font-medium text-foreground">
                      {fileName ? `已选文档：${fileName}` : '点击或拖拽文档到此处（PDF / Word / Office / TXT）'}
                    </p>
                    <p className="mt-1 text-xs text-foreground/50">
                      支持 .pdf, .docx, .doc, .xlsx, .pptx, .rtf, .txt, .md
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Tab 3: 网页链接抓取 */}
        {activeTab === 'web_ai' && (
          <div className="rounded-xl border border-border/50 bg-card/60 p-5 shadow-xs">
            <div>
              <h2 className="text-sm font-medium text-foreground">在线网页链接抓取与提炼</h2>
              <p className="mt-1 text-xs text-foreground/50">
                输入官方开发文档、博客文章或 API 参考页面的 URL，自动抓取并提炼为项目事实。
              </p>
            </div>

            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <input
                type="url"
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                placeholder="例如：https://react.dev/learn 或 https://vite.dev/guide"
                disabled={isProcessing}
                className="h-10 flex-1 rounded-lg border border-border/50 bg-background px-3 text-xs text-foreground placeholder:text-foreground/35 outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              />
              <button
                type="button"
                onClick={handleWebUrlIngestion}
                disabled={isProcessing || !targetUrl.trim()}
                className="flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isProcessing ? <Loader2 className="size-3.5 animate-spin" /> : <Globe className="size-3.5" />}
                {isProcessing ? '正在抓取提炼...' : '抓取并提炼'}
              </button>
            </div>

            {isProcessing && ingestionStage && (
              <div className="mt-3 flex items-center gap-2 text-xs text-primary">
                <Loader2 className="size-3.5 animate-spin" />
                <span>{ingestionStage}</span>
              </div>
            )}
          </div>
        )}

        {/* Tab 1: 结构化文件导入 */}
        {activeTab === 'file' && (
          <div className="rounded-xl border border-border/50 bg-card/60 p-5 shadow-xs">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-foreground">结构化文件导入或直接粘贴</h2>
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
              <div
                onClick={() => fileInputRef.current?.click()}
                className="flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-border/80 bg-muted/20 px-6 py-6 text-center transition-colors hover:border-primary/60 hover:bg-muted/40"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,.md,.markdown,.txt"
                  onChange={handleStructuredFileChange}
                  className="hidden"
                />
                <FileCode className="size-8 text-foreground/40" />
                <p className="mt-2 text-sm font-medium text-foreground">
                  {fileName ? `已选文件：${fileName}` : '点击或拖拽 JSON / Markdown 文件到此处'}
                </p>
                <p className="mt-1 text-xs text-foreground/50">支持 .json, .md, .markdown, .txt 格式</p>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium text-foreground/70">或者直接粘贴 Markdown 笔记：</label>
                <textarea
                  value={rawText}
                  onChange={(e) => setRawText(e.target.value)}
                  placeholder="在此粘贴 Markdown 笔记或 Bullet 列表（例如：- [fact] 部署端口为 5173 #port）"
                  rows={3}
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
        )}

        {/* 错误提示 */}
        {errorMessage && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
            {errorMessage}
          </div>
        )}

        {/* 导入结果反馈卡片 */}
        {result && (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-5">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <div className="flex-1">
                <h3 className="text-sm font-medium text-emerald-900 dark:text-emerald-100">知识库沉淀成功</h3>
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

        {/* 待导入卡片预览列表 */}
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
                {loading ? '正在写入数据库...' : `确认导入知识库（${items.length} 条）`}
              </button>
            </div>

            {/* 预览条目列表 */}
            <div className="mt-4 max-h-96 space-y-2.5 overflow-y-auto pr-1">
              {items.map((item, idx) => (
                <div
                  key={idx}
                  className="group relative rounded-lg border border-border/40 bg-background/60 p-3 text-xs transition-colors hover:border-border"
                >
                  <div className="flex items-center gap-2 pr-6">
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
                  <button
                    type="button"
                    onClick={() => handleRemoveItem(idx)}
                    title="移除该条知识"
                    className="absolute right-2 top-2 rounded p-1 text-foreground/30 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
