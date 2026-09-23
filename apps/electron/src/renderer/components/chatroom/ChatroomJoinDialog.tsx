import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { chatRoomApi } from '@/lib/chatroom-api'
import { openChatRoomTab, tabsAtom, activeTabIdAtom } from '@/atoms/tab-atoms'
import { chatRoomRoomsAtom } from '@/atoms/chatroom-atoms'

export function ChatroomJoinDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }): React.ReactElement {
  const [code, setCode] = React.useState(''); const [error, setError] = React.useState(''); const [tabs, setTabs] = useAtom(tabsAtom); const [, setActive] = useAtom(activeTabIdAtom); const setRooms = useSetAtom(chatRoomRoomsAtom)
  const submit = async (event: React.FormEvent): Promise<void> => { event.preventDefault(); setError(''); const shareCode = code.trim().toUpperCase(); if (!/^[A-Z0-9]{4}$/.test(shareCode)) { setError('请输入4位字母或数字分享码'); return } try { const room = await chatRoomApi.joinRoom({ shareCode }); setRooms((current) => [...current.filter((item) => item.roomId !== room.roomId), room]); const next = openChatRoomTab(tabs, room); setTabs(next.tabs); setActive(next.activeTabId); onOpenChange(false); setCode('') } catch (e) { setError(e instanceof Error ? e.message : '加入聊天室失败') } }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>加入聊天室</DialogTitle><DialogDescription>输入主理人创建的4位分享码</DialogDescription></DialogHeader><form onSubmit={(e) => void submit(e)} className="space-y-4"><input aria-label="分享码" autoFocus maxLength={4} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="A7K2" className="w-full rounded-lg bg-muted px-3 py-2 text-center text-lg tracking-[0.35em] uppercase outline-none focus:ring-2 focus:ring-primary/30" />{error && <p role="alert" className="text-xs text-destructive">{error}</p>}<DialogFooter><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit">加入</Button></DialogFooter></form></DialogContent></Dialog>
}
