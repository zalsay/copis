import React, { useEffect, useRef, useState } from 'react'
import { Bot, ChevronDown } from 'lucide-react'
import type { HostAgent } from './shared-room-data'

export function RoomMembers({ agents, ids, hostId, userId, disabled, removeMember }: {
  agents: HostAgent[]; ids?: number[]; hostId?: number; userId: string; disabled: boolean
  removeMember: (id: number) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<number>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const canManage = hostId !== undefined && String(hostId) === userId
  useEffect(() => {
    if (!open) { setTarget(undefined); setError(''); return }
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  const confirm = async (id: number) => {
    setPending(true); setError('')
    try { await removeMember(id); setTarget(undefined) }
    catch (err) { setError(err instanceof Error ? err.message : '移除群成员失败') }
    finally { setPending(false) }
  }
  return <div className="relative" ref={root} onKeyDown={e => {
    if (open && e.key === 'Escape') { e.stopPropagation(); setOpen(false); trigger.current?.focus() }
  }}>
    <button type="button" ref={trigger} aria-expanded={open && !disabled} disabled={disabled} onClick={() => setOpen(!open)}
      className="flex items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-white/10">成员{ids && ` · ${ids.length}`}<ChevronDown size={14}/></button>
    {open && !disabled && <section aria-label="群成员列表" className="absolute right-0 top-full z-20 mt-1 max-h-[min(60vh,24rem)] w-56 overflow-y-auto rounded-lg border border-border/50 bg-[var(--copis-search-panel-bg)] p-2 text-sm text-foreground shadow-lg">
      {agents.length ? agents.map(a => <div key={a.id} className="flex items-center gap-2 px-2 py-1.5"><Bot size={15} className="shrink-0"/><strong className="truncate" title={a.name}>{a.name}</strong><small className="ml-auto shrink-0 text-muted-foreground">智能体</small></div>) : <p className="px-2 py-1.5 text-muted-foreground">未共享智能体</p>}
      <ul className="mt-1 border-t border-border/50 pt-1">{ids?.map(id => <li key={id} className="px-2 py-1.5">
        <div className="flex items-center justify-between gap-2"><span>用户 {id}</span>
          {id === hostId ? <small className="text-muted-foreground">群主</small> : canManage && <button type="button" aria-label={`移除用户 ${id}`} disabled={pending} className="text-xs text-destructive" onClick={() => { setTarget(id); setError('') }}>移除</button>}
        </div>
        {canManage && id === target && <div className="mt-1 space-y-1 text-xs"><p>确定将用户 {id} 移出本群？</p>
          {error && <p role="alert" className="text-destructive">{error}</p>}
          <div className="flex justify-end gap-3"><button type="button" disabled={pending} onClick={() => setTarget(undefined)}>取消</button>
            <button type="button" className="text-destructive" disabled={pending} onClick={() => void confirm(id)}>{pending ? '正在移除…' : '确认移除'}</button></div>
        </div>}
      </li>)}</ul>
      {!ids && <p className="px-2 py-1.5 text-muted-foreground">成员列表暂不可用</p>}
    </section>}
  </div>
}
