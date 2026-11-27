import { atom, type createStore } from 'jotai'
import { workingAuthLifecycleEpochAtom } from '@/atoms/working-atoms'
import type { RoomRequest } from './useSharedRoomFeed'

type Store = ReturnType<typeof createStore>
interface Receipt { read: number; scanned: number; incoming: number; checkedAt: number }
const initial: Receipt = {read:0, scanned:0, incoming:0, checkedAt:0}
const isSeq = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
const newReceiptScope = () => atom(new Map<string, Receipt>())
type Scope = ReturnType<typeof newReceiptScope>
export const roomReadScope = atom(get => { get(workingAuthLifecycleEpochAtom); return newReceiptScope() })
export const isUnread = (r?: Receipt) => !!r && r.incoming > r.read

function advance(store: Store, scope: Scope, id: string, update: Partial<Receipt>) {
  store.set(scope, before => {
    const prev = before.get(id) ?? initial
    const next = {...prev}
    for (const key of Object.keys(update) as (keyof Receipt)[]) next[key] = Math.max(prev[key], update[key]!)
    return Object.keys(update).some(k => next[k as keyof Receipt] !== prev[k as keyof Receipt]) ? new Map(before).set(id,next) : before
  })
}
export function confirmRead(store: Store, scope: Scope, id: string, seq: number) {
  if (isSeq(seq)) advance(store,scope,id,{read:seq,scanned:seq})
}

/** nextSeq 包含状态事件，只用它判断是否需要扫描，不能直接当成未读数。 */
export async function scanRoomUnread(store: Store, scope: Scope, room: {id:string; nextSeq?:number}, request: RoomRequest,
  current: () => boolean, now = Date.now()) {
  if (!room.nextSeq || !current()) return
  let receipt = store.get(scope).get(room.id)
  if (!receipt?.checkedAt || (isUnread(receipt) && now - receipt.checkedAt > 30_000)) {
    const detail = await request({action:'detail',roomId:room.id}) as {lastReadSeq?:unknown}
    if (!current() || !isSeq(detail?.lastReadSeq)) return
    advance(store,scope,room.id,{read:detail.lastReadSeq,scanned:detail.lastReadSeq,checkedAt:now})
    receipt = store.get(scope).get(room.id)
  }
  const afterSeq = receipt?.scanned ?? 0
  if (afterSeq >= room.nextSeq - 1) return
  // 每轮每群最多读取一页无正文事件；有积压时从已扫描位置继续，不从头重放。
  const page = await request({action:'unreadEvents',roomId:room.id,afterSeq})
  if (!current() || !Array.isArray(page) || !page.length) return
  let scanned = afterSeq, incoming = 0
  for (const row of page) {
    if (!isSeq(row?.seq) || row.seq <= scanned || typeof row.incoming !== 'boolean') return
    scanned = row.seq
    if (row.incoming) incoming = scanned
  }
  advance(store,scope,room.id,{scanned,incoming})
}
