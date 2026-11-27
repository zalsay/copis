import { atom, useAtomValue, useSetAtom, useStore } from 'jotai'
import { useEffect, useState, useCallback } from 'react'
import { workingAuthLifecycleEpochAtom, workingAuthStateAtom } from '@/atoms/working-atoms'
import { roomMenuActions, type DshRoomSidebarSnapshot, type RoomMenuAction } from '@copis/shared/types/dsh'
import { toast } from 'sonner'
import { copyTextToClipboard } from '@/lib/clipboard'
import { readSharedRoom, type SharedRoom } from './shared-room-data'

import type { RoomAgentOption } from './RoomAgentPicker'

type Form = 'create' | 'join'
interface Registration extends RoomAgentOption { operationId: string }
interface Creation {
  room: SharedRoom
  code: string
  agent: Registration
}
export interface RoomManagementTarget { id: string; action: Exclude<RoomMenuAction, 'copy'> }
interface Directory {
  management: RoomManagementTarget | null
  creation: Creation | null
  rooms: SharedRoom[]
  selected: string | null
  form: Form | null
  loading: boolean
  loaded: boolean
  busy: boolean
  error: string
  requestId: number
}
const empty = (): Directory => ({
  management: null,
  creation: null,
  rooms: [],
  selected: null,
  form: null,
  loading: false,
  loaded: false,
  busy: false,
  error: '',
  requestId: 0,
})
// 每个认证代次独享目录，A → B → A 时迟到的请求也不能写回新目录。
const directoryScope = atom((get) => {
  get(workingAuthLifecycleEpochAtom)
  return atom(empty())
})
export const roomDirectoryAtom = atom((get) => get(get(directoryScope)))
export const roomAccountAtom = atom((get) => {
  const auth = get(workingAuthStateAtom),
    id = auth?.user?.id ?? auth?.user?.userId
  return auth?.authenticated && id != null ? String(id) : null
})
type Intent =
  | { kind: 'ensure' | 'refresh' | 'cancel' | Form }
  | { kind: 'leave' | 'dissolve'; id: string }
  | { kind: 'manage'; id: string; action: RoomMenuAction }
  | { kind: 'close-management' }
  | { kind: 'select'; id: string }
  | { kind: 'submit'; name: string; code: string; agents?: RoomAgentOption[] }
export const roomDirectoryAction = atom(null, async (get, set, action: Intent) => {
  const scope = get(directoryScope),
    state = get(scope),
    userId = get(roomAccountAtom)
  if (!userId || state.busy) return
  if (action.kind === 'close-management') {
    set(scope, { ...state, management: null, error: '' })
    return
  }
  if (action.kind === 'manage') {
    const room = state.rooms.find(r => r.id === action.id)
    if (!room || state.form || state.loading || state.management || !roomMenuActions(room.role, !!room.shareCode).includes(action.action)) return
    if (action.action === 'copy') {
      // 只在可信主窗口读取最新分享码；原生侧栏只发送房间和操作意图。
      try {
        const detail = await window.electronAPI.dshGroupChat.sharedRoomCommand(userId, { action: 'detail', roomId: room.id }) as { room: unknown }
        if (get(directoryScope) !== scope) return
        const latest = readSharedRoom(detail.room, userId)
        if (latest.id !== room.id || !latest.active || !latest.shareCode) throw new Error('此群的分享码未启用')
        await copyTextToClipboard(latest.shareCode)
        if (get(directoryScope) === scope) toast.success(`已复制「${room.name}」的分享码`)
      } catch (e) {
        if (get(directoryScope) === scope) toast.error(e instanceof Error ? e.message : '复制分享码失败')
      }
    } else set(scope, { ...state, management: { id: room.id, action: action.action }, error: '' })
    return
  }
  if (state.management && !(action.kind === state.management.action && 'id' in action && action.id === state.management.id)) return
  if (action.kind === 'select') {
    if (state.rooms.some((r) => r.id === action.id))
      set(scope, { ...state, selected: action.id, form: null, creation: null, error: '' })
    return
  }
  if (action.kind === 'create' || action.kind === 'join' || action.kind === 'cancel') {
    if (action.kind === 'create' && state.creation) return
    set(scope, { ...state, form: action.kind === 'cancel' ? null : action.kind, creation: null,
      selected: state.creation?.room.id ?? state.selected, error: '' })
    return
  }
  const requestId = state.requestId + 1
  const current = () => get(directoryScope) === scope && get(scope).requestId === requestId
  const api = window.electronAPI.dshGroupChat
  if (action.kind === 'leave' || action.kind === 'dissolve') {
    const room = state.rooms.find((r) => r.id === action.id)
    if (state.loading || state.form || state.management?.id !== action.id || state.management.action !== action.kind ||
        room?.role !== (action.kind === 'leave' ? 'member' : 'host')) return
    set(scope, { ...state, requestId, busy: true, error: '' })
    try {
      const result = await api.sharedRoomCommand(userId, { action: action.kind, roomId: action.id })
      if (!current()) return
      if (!result || typeof result !== 'object' || !('roomId' in result) || result.roomId !== action.id)
        throw new Error('未收到当前群的操作确认，请刷新群列表')
      const index = state.rooms.indexOf(room)
      const rooms = state.rooms.filter((r) => r.id !== action.id)
      set(scope, { ...get(scope), rooms, selected: state.selected === action.id ? (rooms[index] ?? rooms[index - 1])?.id ?? null : state.selected, management: null, busy: false })
    } catch (err) {
      if (current()) set(scope, (s) => ({ ...s, busy: false, error: err instanceof Error ? err.message : '群操作失败' }))
    }
    return
  }
  if (action.kind === 'submit') {
    if (state.loading || !state.form) return
    const agents = action.agents ?? []
    if (!state.creation && (!/^[A-Z0-9]{4}$/.test(action.code) || (state.form === 'create' && (
      !action.name.trim() || agents.length !== 1 || !agents[0]?.id.trim()
    )))) return
    set(scope, { ...state, requestId, busy: true, error: '' })
    try {
      let creation = state.creation
      if (!creation) {
        const raw = await api.sharedRoomCommand(userId, state.form === 'join'
          ? { action: 'join', shareCode: action.code }
          : { action: 'create', name: action.name.trim(), shareCode: action.code })
        if (!current()) return
        const room = readSharedRoom(raw, userId)
        const rooms = [...state.rooms.filter(r => r.id !== room.id), room]
        if (state.form === 'join') {
          set(scope, { ...get(scope), rooms, selected: room.id, form: null, busy: false })
          return
        }
        creation = { room, code: action.code, agent: { ...agents[0]!, operationId: crypto.randomUUID() } }
        set(scope, { ...get(scope), rooms, creation })
      }
      // 登记超时不代表服务端未执行；重试沿用原群、工作区和操作 ID。
      const { room, agent } = creation
      try {
        const result = await api.sharedRoomCommand(userId, { action: 'registerAgent', roomId: room.id,
          workspaceId: agent.id, operationId: agent.operationId })
        if (!result || typeof result !== 'object' || !('roomAgentId' in result) ||
            typeof result.roomAgentId !== 'string' || !result.roomAgentId.trim())
          throw new Error('未收到登记确认')
      } catch (err) {
        throw new Error(`群已创建，${agent.name}：${err instanceof Error ? err.message : '登记失败'}`)
      }
      if (current()) set(scope, { ...get(scope), selected: room.id, form: null, creation: null, busy: false })
    } catch (err) {
      if (current())
        set(scope, (s) => ({
          ...s,
          busy: false,
          loading: false,
          error: err instanceof Error ? err.message : '群操作失败',
        }))
    }
    return
  }
  if (state.creation || state.loading || (action.kind === 'ensure' && state.loaded)) return
  set(scope, { ...state, requestId, loading: true, error: '' })
  try {
    const raw = await api.sharedRoomCommand(userId, { action: 'list' })
    if (!current()) return
    if (!Array.isArray(raw)) throw new Error('无法读取共享群列表')
    const rooms = raw.map((r) => readSharedRoom(r, userId)).filter((r) => r.active)
    set(scope, (s) => ({
      ...s,
      rooms,
      selected: rooms.some((r) => r.id === s.selected) ? s.selected : (rooms[0]?.id ?? null),
      loaded: true,
      loading: false,
    }))
  } catch (err) {
    if (current())
      set(scope, (s) => ({
        ...s,
        rooms: [],
        selected: null,
        loading: false,
        loaded: false,
        error: err instanceof Error ? err.message : '读取群列表失败',
      }))
  }
})

/** 侧栏只做导航和打开表单。已登录用户的写操作仍须在主窗口提交。 */
export function useRoomSidebarBridge(ready: boolean, clientGeneration: number) {
  const state = useAtomValue(roomDirectoryAtom),
    account = useAtomValue(roomAccountAtom),
    epoch = useAtomValue(workingAuthLifecycleEpochAtom)
  const act = useSetAtom(roomDirectoryAction)
  const store = useStore()
  const [sync, setSync] = useState(0)
  useEffect(() => {
    if (ready) void act({ kind: 'ensure' })
  }, [ready, epoch, act])
  useEffect(() => {
    if (!ready) return
    const payload: DshRoomSidebarSnapshot = {
      type: 'COPIS_SHARED_ROOM_SIDEBAR',
      epoch,
      rooms: state.rooms.map(({ id, name, role, shareCode }) => ({ id, name, actions: roomMenuActions(role, !!shareCode) })),
      selected: state.selected,
      status: !account
        ? 'signed-out'
        : state.loading
          ? 'loading'
          : state.error && !state.loaded
            ? 'error'
            : 'ready',
      busy: state.busy || !!state.management,
    }
    void window.electronAPI.dshCordis
      .dispatchToClient(payload)
      .catch((err) => console.warn('[群聊协作] 同步侧栏失败', err))
  }, [ready, clientGeneration, sync, account, epoch, state])
  return useCallback(
    (tab?: string) => {
      if (tab === 'sidebar-sync' || tab === 'refresh') {
        setSync((n) => n + 1)
        void act({ kind: tab === 'refresh' ? 'refresh' : 'ensure' })
        return false
      }
      if (tab?.startsWith('manage:')) {
        const match = /^manage:(\d+):(roster|copy|leave|dissolve):([a-zA-Z0-9_-]{1,64})$/.exec(tab)
        if (match && Number(match[1]) === store.get(workingAuthLifecycleEpochAtom))
          void act({ kind: 'manage', action: match[2] as RoomMenuAction, id: match[3]! })
        return false
      }
      if (store.get(roomDirectoryAtom).management) return false
      if (tab === 'create' || tab === 'join') void act({ kind: tab })
      else if (tab?.startsWith('room:')) {
        const id = tab.slice(5)
        if (!store.get(roomDirectoryAtom).rooms.some((r) => r.id === id)) return false
        void act({ kind: 'select', id })
      } else if (tab !== undefined) return false
      return true
    },
    [act, store],
  )
}
