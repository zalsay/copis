import React, { useEffect, useRef, useState } from 'react'
import { copyTextToClipboard } from '@/lib/clipboard'
import { ChevronDown, Copy, UsersRound } from 'lucide-react'
import type { SharedRoom } from './shared-room-data'
import { ROOM_ACTION_LABELS, roomMenuActions } from '@copis/shared/types/dsh'

export function RoomManagement({ room, shareCode, ready, disabled, onChoose }: {
  room: SharedRoom
  shareCode?: string
  ready: boolean
  disabled: boolean
  onChoose: (action: 'roster' | 'leave' | 'dissolve') => void
}) {
  const [open, setOpen] = useState(false)
  const [copyStatus, setCopyStatus] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const actions = roomMenuActions(room.role, !!shareCode)
  const exit = room.role === 'host' ? 'dissolve' : 'leave'
  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const blur = () => setOpen(false)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('blur', blur)
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('blur', blur) }
  }, [open])
  useEffect(() => { if (disabled || !ready) { setOpen(false) } }, [disabled, ready])
  const item = 'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted focus-visible:bg-muted'
  return <div className="relative" ref={root} onKeyDown={e => {
    if (!open) return
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); trigger.current?.focus() }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const items = Array.from(root.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
      const i = items.indexOf(document.activeElement as HTMLButtonElement)
      items[(i + items.length + (e.key === 'ArrowDown' ? 1 : -1)) % items.length]?.focus()
    }
  }} onBlur={e => { if (open && !root.current?.contains(e.relatedTarget as Node | null)) setOpen(false) }}>
    <button type="button" ref={trigger} aria-label="群聊管理" aria-haspopup="menu" aria-expanded={open}
      className="flex items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-white/10" disabled={disabled || !room.role}
      onClick={() => { setCopyStatus(''); setOpen(!open) }}>管理 <ChevronDown size={14}/></button>
    {open && <div role="menu" aria-label="群聊管理菜单" className="absolute right-0 top-full z-20 mt-1 min-w-44 rounded-lg border border-border/50 bg-[var(--copis-search-panel-bg)] p-1 text-foreground shadow-lg">
      <button type="button" role="menuitem" className={item} aria-label="群智能体" disabled={!ready} onClick={() => { setOpen(false); onChoose('roster') }}><UsersRound size={15}/>群智能体</button>
      {ready && actions.includes('copy') && shareCode && <button type="button" role="menuitem" className={item} aria-label="复制分享码" onClick={async () => {
        try { await copyTextToClipboard(shareCode); setCopyStatus('已复制') } catch { setCopyStatus('复制失败') }
      }}><Copy size={15}/>分享码 <b className="select-all font-mono">{shareCode}</b><small role="status">{copyStatus}</small></button>}
      <button type="button" role="menuitem" className={`${item} text-destructive`} onClick={() => { setOpen(false); onChoose(exit) }}>{ROOM_ACTION_LABELS[exit]}</button>
    </div>}
  </div>
}
