import React, { useState, useEffect, useMemo, type ReactElement } from 'react'
import {
  Folder,
  FolderOpen,
  FileCode,
  FileText,
  Search,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  Copy,
  Check,
  ExternalLink,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react'
import type { DirectoryEntry, FilePreviewState } from './inspectorTypes'

interface FilesInspectorTabProps {
  sessionCwd?: string
  sessionId?: string
  onSelectFile?: (filePath: string) => void
}

function formatSize(bytes?: number): string {
  if (bytes === undefined || bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getFileIconColor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  if (['ts', 'tsx'].includes(ext)) return '#3b82f6'
  if (['js', 'jsx'].includes(ext)) return '#eab308'
  if (['json'].includes(ext)) return '#fb923c'
  if (['css', 'scss', 'less'].includes(ext)) return '#38bdf8'
  if (['html', 'htm'].includes(ext)) return '#f97316'
  if (['md', 'txt'].includes(ext)) return '#94a3b8'
  if (['py'].includes(ext)) return '#34d399'
  if (['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif'].includes(ext)) return '#ec4899'
  return '#a1a1aa'
}

export function FilesInspectorTab({ sessionCwd, onSelectFile }: FilesInspectorTabProps): ReactElement {
  const [filterText, setFilterText] = useState('')
  const [rootEntries, setRootEntries] = useState<DirectoryEntry[]>([])
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set())
  const [childrenMap, setChildrenMap] = useState<Map<string, DirectoryEntry[]>>(() => new Map())
  const [loadingMap, setLoadingMap] = useState<Map<string, boolean>>(() => new Map())
  const [isRootLoading, setIsRootLoading] = useState(false)
  const [refreshCount, setRefreshCount] = useState(0)

  // 布局状态：是否收起左侧目录树，让预览占满
  const [treeCollapsed, setTreeCollapsed] = useState(false)

  // 当前选中预览的文件
  const [previewingFile, setPreviewingFile] = useState<DirectoryEntry | null>(null)
  const [previewState, setPreviewState] = useState<FilePreviewState>({
    loading: false,
    content: '',
    error: null,
    isImage: false,
    imageUrl: '',
  })
  const [copied, setCopied] = useState(false)

  // 1. 加载根目录
  useEffect(() => {
    let cancelled = false
    setIsRootLoading(true)

    if (window.copisBridge?.listDirectory) {
      window.copisBridge
        .listDirectory(undefined, sessionCwd)
        .then((entries) => {
          if (!cancelled) {
            setRootEntries(Array.isArray(entries) ? entries : [])
            setIsRootLoading(false)
          }
        })
        .catch(() => {
          if (!cancelled) {
            setRootEntries([])
            setIsRootLoading(false)
          }
        })
    } else {
      setIsRootLoading(false)
    }

    return () => {
      cancelled = true
    }
  }, [sessionCwd, refreshCount])

  // 2. 展开/折叠目录
  const toggleFolder = (folderPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(folderPath)) {
        next.delete(folderPath)
      } else {
        next.add(folderPath)
        if (!childrenMap.has(folderPath)) {
          setLoadingMap((lm) => new Map(lm).set(folderPath, true))
          if (window.copisBridge?.listDirectory) {
            window.copisBridge
              .listDirectory(folderPath, sessionCwd)
              .then((kids) => {
                setChildrenMap((cm) => new Map(cm).set(folderPath, Array.isArray(kids) ? kids : []))
                setLoadingMap((lm) => {
                  const n = new Map(lm)
                  n.delete(folderPath)
                  return n
                })
              })
              .catch(() => {
                setChildrenMap((cm) => new Map(cm).set(folderPath, []))
                setLoadingMap((lm) => {
                  const n = new Map(lm)
                  n.delete(folderPath)
                  return n
                })
              })
          } else {
            setLoadingMap((lm) => {
              const n = new Map(lm)
              n.delete(folderPath)
              return n
            })
          }
        }
      }
      return next
    })
  }

  // 3. 刷新文件树
  const handleRefresh = () => {
    setChildrenMap(new Map())
    setExpandedDirs(new Set())
    setRefreshCount((c) => c + 1)
  }

  // 4. 打开文件预览
  const openPreview = (file: DirectoryEntry) => {
    setPreviewingFile(file)
    onSelectFile?.(file.path)
    setPreviewState({ loading: true, content: '', error: null, isImage: false, imageUrl: '' })

    if (window.copisBridge?.readFile) {
      window.copisBridge
        .readFile(file.path, sessionCwd)
        .then((res) => {
          if (!res) {
            setPreviewState({ loading: false, content: '', error: '无法读取文件内容', isImage: false, imageUrl: '' })
          } else if (!res.success) {
            setPreviewState({ loading: false, content: '', error: res.error || '读取失败', isImage: false, imageUrl: '' })
          } else if (res.isImage) {
            setPreviewState({ loading: false, content: '', error: null, isImage: true, imageUrl: res.content || '' })
          } else {
            const rawContent = res.content || ''
            const lines = rawContent ? rawContent.split('\n').length : 0
            setPreviewState({
              loading: false,
              content: rawContent,
              error: null,
              isImage: false,
              imageUrl: '',
              lineCount: lines,
            })
          }
        })
        .catch((err) => {
          setPreviewState({
            loading: false,
            content: '',
            error: String(err?.message || err),
            isImage: false,
            imageUrl: '',
          })
        })
    } else {
      setPreviewState({
        loading: false,
        content: '',
        error: '未连接到 Copis 文件服务',
        isImage: false,
        imageUrl: '',
      })
    }
  }

  // 5. 复制内容
  const handleCopyContent = () => {
    if (!previewState.content) return
    navigator.clipboard.writeText(previewState.content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  // 6. 系统定位文件
  const handleLocateFile = (filePath: string) => {
    if (window.copisBridge?.showItemInFolder) {
      window.copisBridge.showItemInFolder(filePath, sessionCwd)
    }
  }

  // 扁平化汇总
  const allLoadedFiles = useMemo(() => {
    const list: DirectoryEntry[] = []
    const scan = (items: DirectoryEntry[]) => {
      for (const item of items) {
        if (item.isDirectory) {
          const kids = childrenMap.get(item.path)
          if (kids) scan(kids)
        } else {
          list.push(item)
        }
      }
    }
    scan(rootEntries)
    return list
  }, [rootEntries, childrenMap])

  // 过滤结果
  const filteredFiles = useMemo(() => {
    const q = filterText.trim().toLowerCase()
    if (!q) return []
    return allLoadedFiles.filter(
      (f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q),
    )
  }, [filterText, allLoadedFiles])

  // 递归渲染树
  const renderTreeNodes = (items: DirectoryEntry[], depth = 0): ReactElement[] => {
    return items.map((item) => {
      const isDir = item.isDirectory
      const isExpanded = isDir && expandedDirs.has(item.path)
      const isLoadingChild = isDir && loadingMap.get(item.path)
      const children = isDir ? childrenMap.get(item.path) || [] : []
      const isSelected = previewingFile?.path === item.path

      return (
        <div key={item.path} style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            className="copis-tree-node-row"
            data-selected={isSelected ? 'true' : 'false'}
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
            onClick={() => {
              if (isDir) {
                toggleFolder(item.path)
              } else {
                openPreview(item)
              }
            }}
            title={item.path}
          >
            {isDir ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', width: '12px' }}>
                {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </span>
            ) : (
              <span style={{ width: '12px', flexShrink: 0 }} />
            )}

            {isDir ? (
              isExpanded ? (
                <FolderOpen size={14} style={{ color: '#a1a1aa', flexShrink: 0 }} />
              ) : (
                <Folder size={14} style={{ color: '#a1a1aa', flexShrink: 0 }} />
              )
            ) : (
              <FileCode size={14} style={{ color: getFileIconColor(item.name), flexShrink: 0 }} />
            )}

            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontWeight: isDir ? 500 : 400,
              }}
            >
              {item.name}
            </span>

            {!isDir && item.size !== undefined && (
              <span style={{ fontSize: '10px', color: 'var(--dsw-alias-label-tertiary, #a1a1aa)', flexShrink: 0 }}>
                {formatSize(item.size)}
              </span>
            )}
          </div>

          {isDir && isExpanded && (
            <div>
              {isLoadingChild ? (
                <div style={{ padding: '4px 0 4px 32px', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #a1a1aa)' }}>
                  加载中...
                </div>
              ) : children.length > 0 ? (
                renderTreeNodes(children, depth + 1)
              ) : (
                <div style={{ padding: '4px 0 4px 32px', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #a1a1aa)' }}>
                  (空目录)
                </div>
              )}
            </div>
          )}
        </div>
      )
    })
  }

  // 顶部路径面包屑文本
  const pathBreadcrumb = useMemo(() => {
    if (previewingFile) {
      return previewingFile.path.replace(/^\//, '').split('/')
    }
    return ['工作区根目录']
  }, [previewingFile])

  return (
    <div className="copis-inspector-files-container" data-testid="copis-inspector-files-panel">
      {/* 顶部面包屑与快捷工具条 */}
      <div className="copis-inspector-files-topbar">
        <button
          type="button"
          className="copis-inspector-tool-icon-btn"
          onClick={() => setTreeCollapsed((prev) => !prev)}
          title={treeCollapsed ? '展开目录树' : '收起目录树'}
          aria-label={treeCollapsed ? '展开目录树' : '收起目录树'}
        >
          {treeCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
        </button>

        <div className="copis-inspector-files-breadcrumb" title={sessionCwd || ''}>
          {pathBreadcrumb.map((seg, idx) => (
            <React.Fragment key={`${seg}-${idx}`}>
              {idx > 0 && <span style={{ opacity: 0.4 }}>/</span>}
              <span style={{ fontWeight: idx === pathBreadcrumb.length - 1 ? 500 : 400 }}>{seg}</span>
            </React.Fragment>
          ))}
        </div>

        <div className="copis-inspector-files-topbar-actions">
          {previewingFile && !previewState.isImage && previewState.content && (
            <button
              type="button"
              className="copis-inspector-tool-icon-btn"
              onClick={handleCopyContent}
              title="复制代码"
            >
              {copied ? <Check size={13} style={{ color: '#22c55e' }} /> : <Copy size={13} />}
            </button>
          )}

          {previewingFile && (
            <button
              type="button"
              className="copis-inspector-tool-icon-btn"
              onClick={() => handleLocateFile(previewingFile.path)}
              title="在系统文件管理器中显示"
            >
              <ExternalLink size={13} />
            </button>
          )}

          <button
            type="button"
            className="copis-inspector-tool-icon-btn"
            onClick={handleRefresh}
            title="刷新目录树"
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {/* 核心双栏分栏区域 */}
      <div className="copis-inspector-files-body">
        {/* 左列：目录树 */}
        {!treeCollapsed && (
          <div className="copis-inspector-files-tree-col">
            {/* 搜索过滤框 */}
            <div className="copis-workspace-search-bar" style={{ margin: '8px 8px 6px 8px' }}>
              <Search size={13} className="copis-workspace-search-icon" />
              <input
                type="text"
                placeholder="搜索文件..."
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                className="copis-workspace-search-input"
              />
            </div>

            {/* 树节点列表 */}
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 4px 12px 4px' }}>
              {isRootLoading ? (
                <div style={{ textAlign: 'center', padding: '30px 10px', color: 'var(--dsw-alias-label-tertiary, #a1a1aa)', fontSize: '11px' }}>
                  正在扫描工作区目录...
                </div>
              ) : filterText.trim() ? (
                filteredFiles.length > 0 ? (
                  filteredFiles.map((file) => (
                    <div
                      key={file.path}
                      className="copis-tree-node-row"
                      data-selected={previewingFile?.path === file.path ? 'true' : 'false'}
                      style={{ paddingLeft: '12px' }}
                      onClick={() => openPreview(file)}
                    >
                      <FileCode size={14} style={{ color: getFileIconColor(file.name), flexShrink: 0 }} />
                      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                        <span style={{ fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {file.name}
                        </span>
                        <span style={{ fontSize: '10px', color: 'var(--dsw-alias-label-tertiary, #a1a1aa)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {file.path}
                        </span>
                      </div>
                    </div>
                  ))
                ) : (
                  <div style={{ textAlign: 'center', padding: '30px 10px', color: 'var(--dsw-alias-label-tertiary, #a1a1aa)', fontSize: '11px' }}>
                    未匹配到文件
                  </div>
                )
              ) : rootEntries.length > 0 ? (
                renderTreeNodes(rootEntries)
              ) : (
                <div style={{ textAlign: 'center', padding: '30px 10px', color: 'var(--dsw-alias-label-tertiary, #a1a1aa)', fontSize: '11px' }}>
                  <div style={{ marginBottom: '8px' }}>工作区暂无文件</div>
                  <button
                    type="button"
                    className="copis-header-action-btn"
                    style={{ fontSize: '11px', padding: '3px 10px' }}
                    onClick={handleRefresh}
                  >
                    重新扫描
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 右列：代码预览与就地查看器 */}
        <div className="copis-inspector-files-preview-col">
          {!previewingFile ? (
            <div className="copis-inspector-empty-state">
              <FileText size={32} style={{ opacity: 0.25, marginBottom: '8px' }} />
              <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--dsw-alias-label-secondary, #a1a1aa)' }}>
                未选择文件
              </div>
              <div style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #71717a)', marginTop: '4px' }}>
                在左侧文件树中点击任意文件即可查看内容与高亮预览
              </div>
            </div>
          ) : previewState.loading ? (
            <div className="copis-inspector-empty-state">
              <div style={{ fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #a1a1aa)' }}>
                正在加载文件内容...
              </div>
            </div>
          ) : previewState.error ? (
            <div className="copis-inspector-empty-state">
              <div style={{ color: '#ef4444', fontWeight: 600, fontSize: '12px', marginBottom: '6px' }}>
                预览失败
              </div>
              <div style={{ color: 'var(--dsw-alias-label-secondary, #a1a1aa)', fontSize: '11px', marginBottom: '12px' }}>
                {previewState.error}
              </div>
              <button
                type="button"
                className="copis-header-action-btn"
                onClick={() => openPreview(previewingFile)}
              >
                重试
              </button>
            </div>
          ) : previewState.isImage ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', overflow: 'auto', padding: '16px' }}>
              <img
                src={previewState.imageUrl}
                alt={previewingFile.name}
                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '6px' }}
              />
            </div>
          ) : (
            <div className="copis-inspector-code-viewer">
              <div className="copis-inspector-code-meta">
                <span>{previewingFile.name}</span>
                {previewState.lineCount !== undefined && <span>{previewState.lineCount} 行</span>}
                {previewingFile.size !== undefined && <span>{formatSize(previewingFile.size)}</span>}
              </div>
              <div className="copis-code-view-wrapper" style={{ flex: 1, margin: 0, borderRadius: 0, border: 'none' }}>
                <code>{previewState.content || '// 空文件'}</code>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
