import { expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { scanRoomUnread, roomReadScope, confirmRead, isUnread } from './shared-room-unread'

const setup = () => {
  const store = createStore(), scope = store.get(roomReadScope)
  return {store,scope,scan:(nextSeq:number, request:Parameters<typeof scanRoomUnread>[3],now=1000) => scanRoomUnread(store,scope,{id:'r',nextSeq},request,()=>true,now),
    unread:() => isUnread(store.get(scope).get('r'))}
}
test('只扫描读游标之后有变化的群；自己的消息和状态不点亮红点', async () => {
  const f = setup(), calls:string[]=[]
  await f.scan(7, async c => {calls.push(c.action);return c.action==='detail' ? {lastReadSeq:4} : [{seq:5,incoming:false},{seq:6,incoming:false}]})
  expect(f.unread()).toBe(false); expect(calls).toEqual(['detail','unreadEvents'])
  await f.scan(7, async () => {throw Error('未变化的群不应重新请求')})
  await f.scan(9, async c => {expect(c).toEqual({action:'unreadEvents',roomId:'r',afterSeq:6}); return [{seq:7,incoming:true},{seq:8,incoming:false}]})
  expect(f.unread()).toBe(true)
  confirmRead(f.store,f.scope,'r',6); expect(f.unread()).toBe(true)
  confirmRead(f.store,f.scope,'r',8); expect(f.unread()).toBe(false)
})
test('迟到的未读响应不覆盖较新的已读位置', async () => {
  const f = setup()
  await f.scan(6, async c => {
    if(c.action==='detail') return {lastReadSeq:2}
    confirmRead(f.store,f.scope,'r',5)
    return [{seq:5,incoming:true}]
  })
  expect(f.unread()).toBe(false)
})
