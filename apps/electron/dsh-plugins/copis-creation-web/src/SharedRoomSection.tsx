import { type CSSProperties, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, MessageSquare, Plus, MoreHorizontal, Copy, Trash2, LogOut, LogIn, MessageSquarePlus, RotateCw, UsersRound } from 'lucide-react'
import { ROOM_ACTION_LABELS, type RoomMenuAction, type DshRoomSidebarSnapshot } from '@copis/shared/types/dsh'

const empty: DshRoomSidebarSnapshot = {
  type: 'COPIS_SHARED_ROOM_SIDEBAR',
  status: 'loading',
  rooms: [],
  epoch: -1,
  selected: null,
  busy: false,
}
interface Props {
  wide: boolean
  active: boolean
  open: (tab?: string) => void
  directory: (tab: 'refresh' | 'sidebar-sync' | `manage:${string}`) => void
}

const moreIcons = { roster: UsersRound, copy: Copy, leave: LogOut, dissolve: Trash2 }
function RoomActionMenu({ disabled, label, menuLabel, row, items, choose }: {
  disabled: boolean
  label: string
  menuLabel: string
  row?: boolean
  items: ReadonlyArray<readonly [string, string, typeof Plus]>
  choose: (action: string) => void
}) {
  const anchor = '--copis-room-' + useId().replace(/[^a-z0-9_-]/gi, '')
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    if (!open) return
    if (disabled) { setOpen(false); return }
    // 进入浏览器顶层，避免被工作区的滚动容器裁切。
    const panel = menu.current!
    panel.popover = 'manual'
    panel.showPopover()
    panel.querySelector('button')?.focus()
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const dismiss = () => setOpen(false)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('blur', dismiss)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('blur', dismiss)
    }
  }, [open, disabled])
  return (
    <div ref={root} style={{'--copis-room-anchor': anchor} as CSSProperties} onKeyDown={(e) => {
      if (!open) return
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); setOpen(false); trigger.current?.focus()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const items = Array.from(menu.current!.querySelectorAll('button'))
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        items[(index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
      }
    }} onBlur={(e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false)
    }}>
      <button ref={trigger} type="button" className={row ? "copis-room-action copis-room-more" : "copis-room-action"} disabled={disabled}
        aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(!open)}>{row ? <MoreHorizontal /> : <Plus />}</button>
      {open && <div ref={menu} role="menu" aria-label={menuLabel} className="copis-room-action-menu">
        {items.map(([tab, label, Icon]) => (
          <button type="button" role="menuitem" aria-label={label} key={tab} onClick={() => {
            setOpen(false); choose(tab)
          }}><Icon aria-hidden="true" />{label}</button>
        ))}
      </div>}
    </div>
  )
}

/** 原生侧栏只渲染目录快照，不读取凭据，也不能自行建群或加入。 */
export function SharedRoomSection({ wide, active, open, directory }: Props) {
  const [expanded, setExpanded] = useState(true)
  const [snapshot, setSnapshot] = useState(empty)
  useEffect(() => {
    const onSnapshot = (e: MessageEvent) => {
      if ((e.source && e.source !== window) || (e.origin && e.origin !== window.location.origin)) return
      const s = e.data as Partial<DshRoomSidebarSnapshot> | null
      if (
        s?.type !== empty.type ||
        !Array.isArray(s.rooms) ||
        !s.rooms.every((r) => typeof r?.id === 'string' && typeof r.name === 'string')
      )
        return
      setSnapshot({
        type: empty.type,
        epoch: Number.isSafeInteger(s.epoch) ? s.epoch! : -1,
        status: s.status ?? 'loading',
        rooms: s.rooms,
        selected: s.selected ?? null,
        busy: s.busy === true,
      })
    }
    window.addEventListener('message', onSnapshot)
    directory('sidebar-sync')
    return () => window.removeEventListener('message', onSnapshot)
  }, [directory])
  const disabled = snapshot.busy || snapshot.status === 'signed-out'
  if (!wide)
    return (
      <button
        type="button"
        className="copis-rail-menu-item copis-workspace-group-entry"
        aria-label="群聊协作"
        title="群聊协作"
        data-active={active}
        onClick={() => {
          setExpanded(true)
          open()
        }}
      >
        <UsersRound size={16} />
      </button>
    )
  return (
    <section className="copis-room-section" aria-label="群聊协作目录">
      <div className="copis-room-heading">
        <button
          type="button"
          className="copis-menu-item copis-room-toggle"
          aria-label="群聊协作"
          aria-expanded={expanded}
          onClick={() => {
            if (!expanded && !disabled) directory('refresh')
            setExpanded(!expanded)
          }}
        >
          {expanded ? <ChevronDown /> : <ChevronRight />}
          <span>群聊协作</span>
        </button>
        <RoomActionMenu disabled={disabled} label="群聊操作" menuLabel="群聊操作菜单"
          items={[['create', '创建群聊', MessageSquarePlus], ['join', '加入群聊', LogIn]]} choose={(tab) => {
          setExpanded(true)
          open(tab)
        }} />
      </div>
      {expanded && (
        <div className="copis-room-children" aria-label="我的共享群">
          {snapshot.rooms.map((room) => (
            <div key={`${snapshot.epoch}:${room.id}`} className="copis-room-row">
            <button
              type="button"
              className="copis-menu-item"
              disabled={snapshot.busy}
              data-active={active && snapshot.selected === room.id}
              aria-current={active && snapshot.selected === room.id ? 'page' : undefined}
              aria-label={room.name}
              title={room.name}
              onClick={() => open(`room:${room.id}`)}
            >
              <MessageSquare />
              <span>{room.name}</span>
            </button>
            {Array.isArray(room.actions) && room.actions.length > 0 && <RoomActionMenu row
              disabled={disabled || snapshot.epoch < 0} label={`管理「${room.name}」`} menuLabel={`${room.name}管理菜单`}
              items={room.actions.filter((a: RoomMenuAction) => Object.hasOwn(ROOM_ACTION_LABELS, a)).map(a => [a, ROOM_ACTION_LABELS[a], moreIcons[a]])}
              choose={action => directory(`manage:${snapshot.epoch}:${action}:${room.id}`)} />}
            </div>
          ))}
          {snapshot.status === 'error' ? (
            <button type="button" className="copis-menu-item" onClick={() => directory('refresh')}>
              <RotateCw />
              重试加载群列表
            </button>
          ) : (
            !snapshot.rooms.length && (
              <small>
                {snapshot.status === 'signed-out'
                  ? '登录后可查看共享群'
                  : snapshot.status === 'loading'
                    ? '正在读取…'
                    : '暂无共享群'}
              </small>
            )
          )}
        </div>
      )}
    </section>
  )
}
