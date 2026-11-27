import React, { useLayoutEffect, useRef } from 'react'

export function RoomDialog({ title, busy = false, size = 'compact', onClose, children }: {
  title: string
  size?: 'compact' | 'roster'
  busy?: boolean
  onClose: () => void
  children: React.ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const node = dialog.current!
    node.showModal()
    return () => node.close()
  }, [])
  const cancel = () => { if (!busy) onClose() }
  return (
    <dialog ref={dialog} aria-label={title}
      className={`fixed [position-anchor:--copis-room-pane] [inset:anchor(top)_anchor(right)_anchor(bottom)_anchor(left)] m-auto h-fit min-w-0 max-h-[90vh] overflow-y-auto rounded-xl border border-border/50 bg-[var(--copis-search-panel-bg)] p-6 text-dialog-foreground shadow-xl backdrop:bg-black/40 [overflow-wrap:anywhere] ${
        size === 'roster' ? 'w-[min(35rem,calc(anchor-size(width)_-_2rem))]' : 'w-[min(24rem,calc(anchor-size(width)_-_2rem))]'
      }`}
      onCancel={(e) => { e.preventDefault(); cancel() }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.stopPropagation()
        if (!e.defaultPrevented) { e.preventDefault(); cancel() }
      }}>
      <h2 className="mb-4 text-lg font-semibold">{title}</h2>
      {children}
    </dialog>
  )
}
