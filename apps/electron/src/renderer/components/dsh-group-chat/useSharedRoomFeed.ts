import { useCallback, useEffect, useRef, useState } from 'react'
import { atom, useAtom } from 'jotai'
import { DSH_ROOM_ATTACHMENT_MAX_BYTES, DSH_ROOM_ATTACHMENT_MAX_COUNT } from '@copis/shared/types'
import type { DshGroupChatMessage, DshSharedRoomCommand } from '@copis/shared'
import {
  mergeSharedMessages,
  readSharedEvents,
  readSharedMessage,
  readHostAgents,
  readSharedRoom,
  type HostAgent,
} from './shared-room-data'

import { roomOutboxAtom, reconcileOutbox, displayOutgoing, type OutgoingAttachmentMessage } from './shared-room-outbox'

export type RoomRequest = (command: DshSharedRoomCommand) => Promise<unknown>
// 由当前账号/房间独立的 Provider 持有，切房或切号时不复用消息和草稿。
const messagesAtom = atom<DshGroupChatMessage[]>([])
const errorText = (err: unknown) => (err instanceof Error ? err.message : '无法同步共享群')

export function useSharedRoomFeed(request: RoomRequest, roomId: string, userId: string) {
  const [messages, setMessages] = useAtom(messagesAtom)
  const [ready, setReady] = useState(false)
  const [agents, setAgents] = useState<HostAgent[]>([])
  const [error, setError] = useState('')
  const [sendError, setSendError] = useState('')
  const [hasOlder, setHasOlder] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const revision = useRef(0)
  const pending = useRef<{ text: string; target?: string; key: string } | null>(null)

  const [outbox, setOutbox] = useAtom(roomOutboxAtom)
  const inFlight = useRef(new Set<string>())
  const sendLock = useRef(false)
  const receive = useCallback((incoming: DshGroupChatMessage[], replace = false) => {
    setMessages(prev => mergeSharedMessages(replace ? [] : prev, incoming))
    setOutbox(prev => reconcileOutbox(prev, incoming, userId))
  }, [setMessages, setOutbox, userId])
  const [shareCode, setShareCode] = useState<string>()
  const detailRevision = useRef(0)
  const refreshAgents = useCallback(async () => {
    const seq = ++detailRevision.current
    const detail = await request({ action: 'detail', roomId })
    const agents = readHostAgents(detail, roomId)
    const room = readSharedRoom((detail as { room: unknown }).room, userId)
    if (seq === detailRevision.current) {
      setAgents(agents)
      setShareCode(room.shareCode)
    }
    return agents
  }, [request, roomId, userId])

  useEffect(() => {
    let active = true,
      initialized = false,
      cursor = 0
    let timer: ReturnType<typeof setTimeout>
    async function sync() {
      let delay = 3000
      try {
        // 与消息使用同一轮同步：群成员看到的是服务端当前任务和等待数。
        await refreshAgents()
        if (!active) return
        if (!initialized) {
          const raw = await request({ action: 'messages', roomId })
          if (!active) return
          if (!Array.isArray(raw)) throw new Error('无法读取群历史')
          const first = raw.map((m) => readSharedMessage(m, roomId))
          receive(first, true)
          setHasOlder(raw.length === 50)
          cursor = Math.max(0, ...first.map((m) => m.seq))
          initialized = true
        }
        const rawEvents = await request({ action: 'events', roomId, afterSeq: cursor })
        if (!active) return
        const page = readSharedEvents(rawEvents, roomId, cursor)
        if (page.messages.length) receive(page.messages)
        cursor = page.cursor
        if (page.more) delay = 0
        setReady(true)
        setError('')
      } catch (err) {
        if (!active) return
        // 请求失败时不能假设仍有阅读权限；重验前不展示缓存、不允许发送。
        detailRevision.current++
        setShareCode(undefined)
        revision.current++
        initialized = false
        setAgents([])
        setMessages([])
        setHasOlder(false)
        setLoadingOlder(false)
        setReady(false)
        setError(errorText(err))
        delay = 5000
      } finally {
        if (active) timer = setTimeout(() => void sync(), delay)
      }
    }
    void sync()
    return () => {
      active = false
      detailRevision.current++
      revision.current++
      clearTimeout(timer)
    }
  }, [request, roomId, receive, setMessages, refreshAgents])

  async function older() {
    if (!ready || !hasOlder || loadingOlder || !messages[0]) return
    const generation = revision.current
    setLoadingOlder(true)
    try {
      const raw = await request({ action: 'messages', roomId, beforeSeq: messages[0].seq })
      if (generation !== revision.current) return
      if (!Array.isArray(raw)) throw new Error('无法读取更早的群消息')
      const page = raw.map((m) => readSharedMessage(m, roomId))
      receive(page)
      setHasOlder(page.length === 50)
    } catch (err) {
      if (generation === revision.current) setError(errorText(err))
    } finally {
      if (generation === revision.current) setLoadingOlder(false)
    }
  }
  function validate(target: string | undefined, files: File[]) {
    if (!ready) throw new Error('房间尚未就绪')
    if (target && (agents.length !== 1 || agents[0]?.id !== target || !agents[0].callable))
      throw new Error('群智能体不可用；取消提及后仍可发送普通消息')
    if (files.length > DSH_ROOM_ATTACHMENT_MAX_COUNT || files.some(f => f.size > DSH_ROOM_ATTACHMENT_MAX_BYTES)) throw new Error('附件数量或大小超限')
    if (target) {
      const images = files.filter(f => f.type.startsWith('image/'))
      if (images.some(f => !/^image\/(png|jpeg|webp|gif)$/i.test(f.type))) throw new Error('@智能体看图支持 PNG、JPEG、WebP 或 GIF；其他格式可作为普通群附件发送')
      if (images.reduce((bytes, f) => bytes + f.size, 0) > DSH_ROOM_ATTACHMENT_MAX_BYTES) throw new Error('发给智能体的图片合计不能超过 20 MB，请分条发送')
    }
  }

  async function post(key: string, content: string, target: string | undefined, attachmentIds: string[], generation: number) {
    const raw = (await request({
      action: 'send',
      roomId,
      content,
      ...(attachmentIds.length ? { attachmentIds } : {}),
      ...(target ? { mentionAgentId: target } : {}),
      clientMessageId: key,
    })) as { message?: unknown; notExecuted?: boolean; reason?: string }
    if (generation !== revision.current) throw new Error('房间状态已更改')
    const msg = readSharedMessage(raw?.message, roomId)
    receive([msg])
    const reason = raw.reason === 'room_queue_full' ? '本群等待队列已满' : raw.reason === 'member_pending_limit' ? '你的待处理请求已达上限'
      : raw.reason === 'agent_offline' ? '群主设备离线' : raw.reason === 'agent_disabled' ? '智能体已暂停' : '智能体未接单'
    setSendError(target && raw.notExecuted ? `消息已发送，${reason}。` : '')
  }

  async function deliver(row: OutgoingAttachmentMessage) {
    if (inFlight.current.has(row.key)) return
    inFlight.current.add(row.key)
    const generation = revision.current
    const current = () => { if (generation !== revision.current) throw new Error('房间状态已更改，请重试') }
    const patch = (changes: Partial<OutgoingAttachmentMessage>) => setOutbox(list => list.map(r => r.key === row.key ? {...r, ...changes} : r))
    try {
      validate(row.target, row.files)
      let ids = row.ids
      if (ids.length < row.files.length) patch({phase:'uploading', error:undefined})
      for (const file of row.files.slice(ids.length)) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        current()
        const result = await request({action:'uploadAttachment', roomId, name:file.name, mimeType:file.type || 'application/octet-stream', bytes}) as {id?: unknown}
        current()
        if (typeof result?.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(result.id)) throw new Error('附件上传未确认')
        ids = [...ids, result.id]
        patch({ids})
      }
      patch({phase:'sending', error:undefined})
      const content = row.text || `附件：${row.files.map(f => f.name).join('、')}`
      await post(row.key, content, row.target, ids, generation)
      setOutbox(list => list.filter(r => r.key !== row.key))
    } catch (err) {
      patch({phase:'failed', error:errorText(err)})
    } finally { inFlight.current.delete(row.key) }
  }

  async function send(text: string, target?: string, files: File[] = []) {
    const generation = revision.current
    try {
      validate(target, files)
      if (files.length) {
        const row: OutgoingAttachmentMessage = {key:crypto.randomUUID(), text, target, files:[...files], ids:[], createdAt:new Date().toISOString(), phase:'uploading'}
        setOutbox(list => [...list, row])
        setSendError('')
        void deliver(row)
        return // 草稿已转交消息气泡，后续上传和重试不再碰 composer。
      }
      if (sendLock.current) throw new Error('请等待当前请求完成')
      if (pending.current?.text !== text || pending.current.target !== target) pending.current = {text, target, key:crypto.randomUUID()}
      sendLock.current = true
      try {
        await post(pending.current.key, text, target, [], generation)
        pending.current = null
      } finally { sendLock.current = false }
    } catch (err) {
      if (generation === revision.current) setSendError(errorText(err))
      throw err
    }
  }
  const retry = (key: string) => {
    const row = outbox.find(r => r.key === key && r.phase === 'failed')
    if (row && ready) void deliver(row)
  }
  const download = useCallback(async (attachmentId: string) => {
    if (!ready) throw new Error('房间尚未就绪')
    const generation = revision.current
    const data = await request({action:'downloadAttachment', roomId, attachmentId}) as {bytes?: unknown; name?: string; mimeType?: string}
    if (generation !== revision.current || !(data?.bytes instanceof Uint8Array) || data.bytes.byteLength > DSH_ROOM_ATTACHMENT_MAX_BYTES) throw new Error('附件读取失败')
    // 不把 HTML、SVG 等活动内容作为可导航的 blob 页面打开。
    const type = /^image\/(png|jpeg|webp|gif|bmp|avif)$/i.test(data.mimeType ?? '') ? data.mimeType : 'application/octet-stream'
    return new File([new Uint8Array(data.bytes)], data.name || `附件-${attachmentId}`, {type})
  }, [ready, request, roomId])
  const displayMessages = [...messages, ...(ready ? outbox.map(row => displayOutgoing(row, roomId, userId)) : [])]
  const loadedIncomingSeq = messages.reduce((seq,m) => m.kind === 'agent' || (m.kind === 'user' && m.authorUserId !== userId) ? Math.max(seq,m.seq) : seq, 0)
  return { messages:displayMessages, loadedIncomingSeq, retry, agents, shareCode, refreshAgents, ready, error: error || sendError, send, download, older, hasOlder, loadingOlder }
}
