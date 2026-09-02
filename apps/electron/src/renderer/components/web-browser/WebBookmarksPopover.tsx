import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Globe2,
  List,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import type { WebBookmark, WebBookmarkGroup, WebBookmarksSnapshot, WebTabState } from '@copis/shared'
import { webBookmarkGroupsAtom, webBookmarksAtom } from '@/atoms/web-bookmarks'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

interface WebBookmarksPopoverProps {
  activeTab: WebTabState
  onNavigate: (url: string) => Promise<void>
  standalone?: boolean
  onRequestClose?: () => void
}

function applyBookmarkSnapshot(
  snapshot: WebBookmarksSnapshot,
  setBookmarks: (bookmarks: WebBookmark[]) => void,
  setGroups: (groups: WebBookmarkGroup[]) => void,
): void {
  setBookmarks(snapshot.bookmarks)
  setGroups(snapshot.groups)
}

function resolveDefaultFaviconUrl(rawUrl?: string | null): string | null {
  if (!rawUrl) return null
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return `${parsed.origin}/favicon.ico`
    }
  } catch {}
  return null
}

function isBookmarkableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

function BookmarkIcon({ faviconUrl, url }: { faviconUrl?: string | null; url?: string }): React.ReactElement {
  const [failedFavicon, setFailedFavicon] = React.useState<string | null>(null)
  const candidateFaviconUrl = faviconUrl || resolveDefaultFaviconUrl(url)

  React.useEffect(() => {
    setFailedFavicon(null)
  }, [candidateFaviconUrl])

  if (!candidateFaviconUrl || failedFavicon === candidateFaviconUrl) {
    return <Globe2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
  }

  return (
    <img
      src={candidateFaviconUrl}
      alt=""
      aria-hidden="true"
      className="size-3.5 shrink-0 rounded-sm object-contain"
      onError={() => setFailedFavicon(candidateFaviconUrl)}
    />
  )
}

const UNGROUPED_TREE_ID = '__ungrouped__'

interface BookmarkTreeGroupProps {
  group: WebBookmarkGroup | null
  treeId: string
  bookmarks: WebBookmark[]
  groups: WebBookmarkGroup[]
  expanded: boolean
  selected: boolean
  editing: boolean
  editingName: string
  busy: boolean
  onToggle: () => void
  onSelect: () => void
  onEditingNameChange: (name: string) => void
  onRename?: (event: React.FormEvent<HTMLFormElement>) => void
  onStartRename?: () => void
  onCancelRename?: () => void
  onRemoveGroup?: () => void
  onNavigateBookmark: (bookmark: WebBookmark) => void
  onMoveBookmark: (bookmark: WebBookmark, groupId: string | null) => void
  onRemoveBookmark: (bookmarkId: string) => void
}

function BookmarkTreeGroup({
  group,
  treeId,
  bookmarks,
  groups,
  expanded,
  selected,
  editing,
  editingName,
  busy,
  onToggle,
  onSelect,
  onEditingNameChange,
  onRename,
  onStartRename,
  onCancelRename,
  onRemoveGroup,
  onNavigateBookmark,
  onMoveBookmark,
  onRemoveBookmark,
}: BookmarkTreeGroupProps): React.ReactElement {
  const groupName = group?.name ?? '未分组'

  return (
    <div role="treeitem" aria-level={1} aria-expanded={expanded} aria-selected={selected} data-tree-id={treeId} className="min-w-0">
      <div className={cn('flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5', selected && 'bg-primary/10 text-primary')}>
        <button
          type="button"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/70"
          aria-label={expanded ? `收起${groupName}` : `展开${groupName}`}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>

        {editing && group ? (
          <form className="flex min-w-0 flex-1 items-center gap-1" onSubmit={onRename}>
            <Input
              autoFocus
              value={editingName}
              onChange={(event) => onEditingNameChange(event.target.value)}
              className="h-7 min-w-0 flex-1 px-1.5 text-xs"
              maxLength={80}
              aria-label="分组名称"
            />
            <Button type="submit" variant="ghost" size="icon-sm" className="size-6 shrink-0" aria-label="保存分组名称" disabled={busy}>
              <Check className="size-3.5" />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" className="size-6 shrink-0" aria-label="取消重命名" onClick={onCancelRename}>
              <X className="size-3.5" />
            </Button>
          </form>
        ) : (
          <>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-muted/70"
              aria-label={`查看${groupName}`}
              onClick={onSelect}
            >
              {expanded ? <FolderOpen className="size-3.5 shrink-0 text-primary/80" /> : <Folder className="size-3.5 shrink-0 text-muted-foreground" />}
              <span className="min-w-0 flex-1 truncate font-medium">{groupName}</span>
              <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">{bookmarks.length}</span>
            </button>
            {group && onStartRename && onRemoveGroup && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="icon-sm" className="size-7 shrink-0 text-muted-foreground" aria-label={`管理分组 ${group.name}`}>
                    <MoreHorizontal className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="z-[10000] w-36">
                  <DropdownMenuItem onSelect={onStartRename}>
                    <Pencil />
                    重命名
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onRemoveGroup}>
                    <Trash2 />
                    删除分组
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        )}
      </div>

      {expanded && (
        <div role="group" className="ml-4 border-l border-border/60 pl-2">
          {bookmarks.length === 0 ? (
            <p className="px-2 py-2 text-[10px] text-muted-foreground">暂无收藏</p>
          ) : (
            bookmarks.map((bookmark) => (
              <div key={bookmark.id} role="treeitem" aria-level={2} className="group/bookmark flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 hover:bg-muted/60">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 px-1 py-1 text-left"
                  aria-label={`打开收藏 ${bookmark.title}`}
                  onClick={() => onNavigateBookmark(bookmark)}
                >
                  <BookmarkIcon faviconUrl={bookmark.faviconUrl} url={bookmark.url} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{bookmark.title}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">{bookmark.url}</span>
                  </span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="ghost" size="icon-sm" className="size-7 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/bookmark:opacity-100" aria-label={`移动收藏 ${bookmark.title}`} disabled={busy}>
                      <Folder className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="z-[10000] w-40">
                    <DropdownMenuLabel>移动到分组</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled={bookmark.groupId === null} onSelect={() => onMoveBookmark(bookmark, null)}>
                      <Folder className="text-muted-foreground" />
                      未分组
                    </DropdownMenuItem>
                    {groups.map((targetGroup) => (
                      <DropdownMenuItem key={targetGroup.id} disabled={bookmark.groupId === targetGroup.id} onSelect={() => onMoveBookmark(bookmark, targetGroup.id)}>
                        <Folder className="text-muted-foreground" />
                        <span className="truncate">{targetGroup.name}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`删除收藏 ${bookmark.title}`}
                  className="size-7 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/bookmark:opacity-100"
                  disabled={busy}
                  onClick={() => onRemoveBookmark(bookmark.id)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

export function WebBookmarksPopover({ activeTab, onNavigate, standalone = false, onRequestClose }: WebBookmarksPopoverProps): React.ReactElement {
  const bookmarks = useAtomValue(webBookmarksAtom)
  const groups = useAtomValue(webBookmarkGroupsAtom)
  const setBookmarks = useSetAtom(webBookmarksAtom)
  const setGroups = useSetAtom(webBookmarkGroupsAtom)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [showAllGroups, setShowAllGroups] = React.useState(true)
  const [viewGroupId, setViewGroupId] = React.useState<string | null>(null)
  const [saveGroupId, setSaveGroupId] = React.useState<string | null | undefined>(undefined)
  const [creatingGroup, setCreatingGroup] = React.useState(false)
  const [newGroupName, setNewGroupName] = React.useState('')
  const [editingGroupId, setEditingGroupId] = React.useState<string | null>(null)
  const [editingGroupName, setEditingGroupName] = React.useState('')
  const [expandedGroupIds, setExpandedGroupIds] = React.useState<Set<string>>(new Set())
  const bookmarksTriggerRef = React.useRef<HTMLButtonElement>(null)
  const treeInitializedRef = React.useRef(false)

  const currentBookmark = bookmarks.find((bookmark) => bookmark.url === activeTab.url)
  const effectiveSaveGroupId = saveGroupId === undefined ? currentBookmark?.groupId ?? null : saveGroupId
  const canBookmark = isBookmarkableUrl(activeTab.url)
  const saveGroupName = effectiveSaveGroupId === null
    ? '未分组'
    : groups.find((group) => group.id === effectiveSaveGroupId)?.name ?? '未分组'
  const bookmarksByGroup = React.useMemo(() => {
    const grouped = new Map<string | null, WebBookmark[]>()
    for (const bookmark of bookmarks) {
      const groupBookmarks = grouped.get(bookmark.groupId)
      if (groupBookmarks) {
        groupBookmarks.push(bookmark)
      } else {
        grouped.set(bookmark.groupId, [bookmark])
      }
    }
    return grouped
  }, [bookmarks])
  const displayedGroups = showAllGroups
    ? groups
    : viewGroupId === null
      ? []
      : groups.filter((group) => group.id === viewGroupId)
  const ungroupedBookmarks = bookmarksByGroup.get(null) ?? []
  const bookmarkActionLabel = !canBookmark ? '当前页面不可收藏' : currentBookmark ? '取消当前页收藏' : '收藏当前页'

  React.useEffect(() => {
    let mounted = true
    setLoading(true)
    window.electronAPI.webTabs.bookmarksList()
      .then((snapshot) => {
        if (mounted) applyBookmarkSnapshot(snapshot, setBookmarks, setGroups)
      })
      .catch((error: unknown) => {
        if (mounted) toast.error(error instanceof Error ? error.message : '加载收藏夹失败')
      })
      .finally(() => {
        if (mounted) setLoading(false)
      })
    return () => {
      mounted = false
    }
  }, [setBookmarks, setGroups])

  React.useEffect(() => {
    if (saveGroupId !== null && saveGroupId !== undefined && !groups.some((group) => group.id === saveGroupId)) {
      setSaveGroupId(undefined)
    }
    if (viewGroupId !== null && !groups.some((group) => group.id === viewGroupId)) {
      setViewGroupId(null)
      setShowAllGroups(false)
    }
  }, [groups, saveGroupId, viewGroupId])

  React.useEffect(() => {
    const validTreeIds = new Set(groups.map((group) => group.id))
    validTreeIds.add(UNGROUPED_TREE_ID)
    setExpandedGroupIds((current) => {
      const next = new Set([...current].filter((treeId) => validTreeIds.has(treeId)))
      return next.size === current.size ? current : next
    })
  }, [groups])

  React.useEffect(() => {
    if (treeInitializedRef.current || (groups.length === 0 && bookmarks.length === 0)) return
    treeInitializedRef.current = true
    setExpandedGroupIds(new Set([...groups.map((group) => group.id), UNGROUPED_TREE_ID]))
  }, [bookmarks.length, groups])

  const toggleTreeGroup = (treeId: string): void => {
    setExpandedGroupIds((current) => {
      const next = new Set(current)
      if (next.has(treeId)) {
        next.delete(treeId)
      } else {
        next.add(treeId)
      }
      return next
    })
  }

  const saveCurrent = async (): Promise<void> => {
    if (!canBookmark || busy) return
    setBusy(true)
    try {
      const wasAlreadySaved = currentBookmark !== undefined
      const wasMoved = wasAlreadySaved && currentBookmark.groupId !== effectiveSaveGroupId
      const snapshot = await window.electronAPI.webTabs.bookmarksSave({
        title: activeTab.title || activeTab.url,
        url: activeTab.url,
        faviconUrl: activeTab.faviconUrl || resolveDefaultFaviconUrl(activeTab.url),
        groupId: saveGroupId,
      })
      applyBookmarkSnapshot(snapshot, setBookmarks, setGroups)
      toast.success(wasMoved ? `已移动到「${saveGroupName}」` : wasAlreadySaved ? '已更新当前页收藏' : `已收藏到「${saveGroupName}」`)
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : '保存收藏失败')
    } finally {
      setBusy(false)
    }
  }

  const removeBookmark = async (bookmarkId: string, successMessage?: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const snapshot = await window.electronAPI.webTabs.bookmarksRemove(bookmarkId)
      applyBookmarkSnapshot(snapshot, setBookmarks, setGroups)
      if (successMessage) toast.success(successMessage)
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : '删除收藏失败')
    } finally {
      setBusy(false)
    }
  }

  const toggleCurrentBookmark = async (): Promise<void> => {
    if (!canBookmark || busy) return
    if (currentBookmark) {
      await removeBookmark(currentBookmark.id, '已取消收藏')
      return
    }
    await saveCurrent()
  }

  const moveBookmark = async (bookmark: WebBookmark, groupId: string | null): Promise<void> => {
    if (busy || bookmark.groupId === groupId) return
    setBusy(true)
    try {
      const snapshot = await window.electronAPI.webTabs.bookmarksSave({
        title: bookmark.title,
        url: bookmark.url,
        groupId,
      })
      applyBookmarkSnapshot(snapshot, setBookmarks, setGroups)
      const targetName = groupId === null ? '未分组' : groups.find((group) => group.id === groupId)?.name ?? '未分组'
      toast.success(`已移动到「${targetName}」`)
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : '移动收藏失败')
    } finally {
      setBusy(false)
    }
  }

  const createGroup = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!newGroupName.trim() || busy) return
    setBusy(true)
    try {
      const snapshot = await window.electronAPI.webTabs.bookmarksGroupCreate({ name: newGroupName })
      applyBookmarkSnapshot(snapshot, setBookmarks, setGroups)
      const createdGroup = snapshot.groups[0]
      if (createdGroup) {
        setSaveGroupId(createdGroup.id)
        setViewGroupId(createdGroup.id)
        setShowAllGroups(false)
        setExpandedGroupIds((current) => new Set(current).add(createdGroup.id))
      }
      setNewGroupName('')
      setCreatingGroup(false)
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : '创建分组失败')
    } finally {
      setBusy(false)
    }
  }

  const renameGroup = async (event: React.FormEvent<HTMLFormElement>, groupId: string): Promise<void> => {
    event.preventDefault()
    if (!editingGroupName.trim() || busy) return
    setBusy(true)
    try {
      const snapshot = await window.electronAPI.webTabs.bookmarksGroupRename({ groupId, name: editingGroupName })
      applyBookmarkSnapshot(snapshot, setBookmarks, setGroups)
      setEditingGroupId(null)
      setEditingGroupName('')
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : '重命名分组失败')
    } finally {
      setBusy(false)
    }
  }

  const removeGroup = async (group: WebBookmarkGroup): Promise<void> => {
    if (busy) return
    const confirmed = window.confirm(`删除分组「${group.name}」？其中的收藏会移动到未分组。`)
    if (!confirmed) return

    setBusy(true)
    try {
      const snapshot = await window.electronAPI.webTabs.bookmarksGroupRemove(group.id)
      applyBookmarkSnapshot(snapshot, setBookmarks, setGroups)
      if (saveGroupId === group.id) setSaveGroupId(null)
      if (viewGroupId === group.id) {
        setViewGroupId(null)
        setShowAllGroups(false)
      }
      toast.success(`已删除分组「${group.name}」`)
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : '删除分组失败')
    } finally {
      setBusy(false)
    }
  }

  const navigateToBookmark = async (bookmark: WebBookmark): Promise<void> => {
    await onNavigate(bookmark.url)
    onRequestClose?.()
  }

  const openNativeBookmarksWindow = (): void => {
    const trigger = bookmarksTriggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    void window.electronAPI.webTabs.bookmarksOpen({
      bounds: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      },
    }).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : '打开收藏夹失败')
    })
  }

  const selectGroup = (groupId: string | null): void => {
    setSaveGroupId(groupId)
    setViewGroupId(groupId)
    setShowAllGroups(false)
    setExpandedGroupIds((current) => new Set(current).add(groupId ?? UNGROUPED_TREE_ID))
  }

  const handlePopoverOpenChange = (nextOpen: boolean): void => {
    if (standalone && !nextOpen) onRequestClose?.()
  }

  return (
    <div className={standalone ? 'h-full w-full' : 'flex items-center gap-0.5'}>
      {!standalone && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={bookmarkActionLabel}
          className={cn('hover:bg-transparent hover:text-current', currentBookmark && 'text-primary')}
          disabled={!canBookmark || busy || loading}
          onClick={() => void toggleCurrentBookmark()}
        >
          {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Star className={cn('size-4', currentBookmark && 'fill-current')} />}
        </Button>
      )}

      <Popover open={standalone} onOpenChange={handlePopoverOpenChange}>
        {standalone ? (
          <PopoverAnchor asChild>
            <span className="absolute left-0 top-0 size-0" />
          </PopoverAnchor>
        ) : (
          <Button
            ref={bookmarksTriggerRef}
            type="button"
            variant="ghost"
            size="icon-sm"
            className="hover:bg-transparent hover:text-current"
            aria-label="打开收藏夹"
            aria-expanded={false}
            onClick={openNativeBookmarksWindow}
          >
            <List className="size-4" />
          </Button>
        )}

        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={standalone ? 0 : 6}
          avoidCollisions={!standalone}
          data-web-bookmarks-panel="true"
          className="z-[9999] w-96 rounded-lg p-2 duration-75"
          style={{ animationDuration: '60ms', borderRadius: '8px' }}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div className="flex items-center justify-between px-1 pb-2">
            <div>
              <p className="text-sm font-medium">收藏夹</p>
              <p className="text-[11px] text-muted-foreground">保存常用网页地址</p>
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">{bookmarks.length}</span>
          </div>

          <div className="border-y border-border/60 py-2">
            <div className="flex items-center gap-1 px-1">
              <button
                type="button"
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                  showAllGroups ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/70',
                )}
                aria-label="查看全部收藏"
                aria-current={showAllGroups ? 'page' : undefined}
                onClick={() => setShowAllGroups(true)}
              >
                <List className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate font-medium">全部收藏</span>
                <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">{bookmarks.length}</span>
              </button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button type="button" variant="ghost" size="icon-sm" className="size-7 shrink-0" aria-label="新建收藏分组" onClick={() => setCreatingGroup((current) => !current)}>
                    <Plus className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">新建收藏分组</TooltipContent>
              </Tooltip>
            </div>

            {creatingGroup && (
              <form className="flex items-center gap-1 pt-1" onSubmit={(event) => void createGroup(event)}>
                <Input
                  autoFocus
                  value={newGroupName}
                  onChange={(event) => setNewGroupName(event.target.value)}
                  placeholder="分组名称"
                  maxLength={80}
                  className="h-7 text-xs"
                  aria-label="新分组名称"
                />
                <Button type="submit" variant="default" size="icon-sm" className="size-7 shrink-0" aria-label="创建分组" disabled={busy || !newGroupName.trim()}>
                  <Check className="size-3.5" />
                </Button>
                <Button type="button" variant="ghost" size="icon-sm" className="size-7 shrink-0" aria-label="取消创建分组" onClick={() => { setCreatingGroup(false); setNewGroupName('') }}>
                  <X className="size-3.5" />
                </Button>
              </form>
            )}
          </div>

          <div className="border-b border-border/60 py-2">
            <div className="flex items-center gap-2 rounded-md bg-muted/45 px-2 py-1.5" style={{ borderRadius: '6px' }}>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{activeTab.title || '当前网页'}</p>
                <p className="truncate text-[10px] text-muted-foreground">{activeTab.url}</p>
                <p className="pt-0.5 text-[10px] text-muted-foreground">保存到：{saveGroupName}</p>
              </div>
              <Button
                type="button"
                variant={currentBookmark ? 'secondary' : 'default'}
                size="sm"
                className="h-7 shrink-0 px-2 text-[11px]"
                disabled={!canBookmark || busy}
                onClick={() => void toggleCurrentBookmark()}
              >
                {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Star className={cn('size-3.5', currentBookmark && 'fill-current')} />}
                {currentBookmark ? '取消收藏' : '收藏当前页'}
              </Button>
            </div>
            {!canBookmark && <p className="px-2 pt-1 text-[10px] text-muted-foreground">当前页面不是可收藏的 HTTP(S) 地址</p>}
          </div>

          <div className="max-h-72 overflow-y-auto pt-1 scrollbar-thin">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                <LoaderCircle className="size-3.5 animate-spin" />
                加载中
              </div>
            ) : (
              <div role="tree" aria-label="收藏夹分组" className="space-y-0.5">
                {displayedGroups.map((group) => (
                  <BookmarkTreeGroup
                    key={group.id}
                    group={group}
                    treeId={group.id}
                    bookmarks={bookmarksByGroup.get(group.id) ?? []}
                    groups={groups}
                    expanded={expandedGroupIds.has(group.id)}
                    selected={!showAllGroups && viewGroupId === group.id}
                    editing={editingGroupId === group.id}
                    editingName={editingGroupName}
                    busy={busy}
                    onToggle={() => toggleTreeGroup(group.id)}
                    onSelect={() => selectGroup(group.id)}
                    onEditingNameChange={setEditingGroupName}
                    onRename={(event) => void renameGroup(event, group.id)}
                    onStartRename={() => { setEditingGroupId(group.id); setEditingGroupName(group.name) }}
                    onCancelRename={() => { setEditingGroupId(null); setEditingGroupName('') }}
                    onRemoveGroup={() => void removeGroup(group)}
                    onNavigateBookmark={(bookmark) => void navigateToBookmark(bookmark)}
                    onMoveBookmark={(bookmark, groupId) => void moveBookmark(bookmark, groupId)}
                    onRemoveBookmark={(bookmarkId) => void removeBookmark(bookmarkId)}
                  />
                ))}
                {(showAllGroups || viewGroupId === null) && (
                  <BookmarkTreeGroup
                    group={null}
                    treeId={UNGROUPED_TREE_ID}
                    bookmarks={ungroupedBookmarks}
                    groups={groups}
                    expanded={expandedGroupIds.has(UNGROUPED_TREE_ID)}
                    selected={!showAllGroups && viewGroupId === null}
                    editing={false}
                    editingName=""
                    busy={busy}
                    onToggle={() => toggleTreeGroup(UNGROUPED_TREE_ID)}
                    onSelect={() => selectGroup(null)}
                    onEditingNameChange={() => undefined}
                    onNavigateBookmark={(bookmark) => void navigateToBookmark(bookmark)}
                    onMoveBookmark={(bookmark, groupId) => void moveBookmark(bookmark, groupId)}
                    onRemoveBookmark={(bookmarkId) => void removeBookmark(bookmarkId)}
                  />
                )}
                {!showAllGroups && viewGroupId !== null && displayedGroups.length === 0 && (
                  <p className="py-6 text-center text-xs text-muted-foreground">该分组已不存在</p>
                )}
                {bookmarks.length === 0 && groups.length === 0 && (
                  <p className="py-6 text-center text-xs text-muted-foreground">暂无收藏</p>
                )}
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
