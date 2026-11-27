import { expect, test } from 'bun:test'
import { authorizeRoomBinding } from './shared-room-authority'
const binding = {userId:'7',deviceId:'dev',roomId:'r',roomAgentId:'a',workspaceId:'w',displayName:'助手'}
const detail = (kind:unknown, host=7) => ({room:{roomId:'r',hostUserId:host,status:'active',roomKind:kind},agents:[{roomId:'r',roomAgentId:'a',ownerUserId:7}]})
test('Given 本机真实绑定的旧群 When 群主匹配 Then 标记一次并重读确认', async () => {
  let reads=0, writes=0, target:unknown
  expect(await authorizeRoomBinding(binding, async ()=> detail(reads++ ? 'dsh_shared' : ''),async b=>{writes++;target=b},()=>true)).toBe(true)
  expect([reads,writes]).toEqual([2,1]); expect(target).toEqual(binding)
})
test('Given 缺字段、非群主、错 agent 或身份已变 When 校验 Then 不迁移也不上线', async () => {
  for (const value of [{room:{roomId:'r',hostUserId:7,status:'active'},agents:[{roomAgentId:'a',roomId:'r',ownerUserId:7}]},detail('',8),{...detail(''),agents:[]},detail('other')]) {
    let writes=0; expect(await authorizeRoomBinding(binding,async()=>value,async()=>{writes++},()=>true)).toBe(false); expect(writes).toBe(0)
  }
  let writes=0; expect(await authorizeRoomBinding(binding,async()=>detail(''),async()=>{writes++},()=>false)).toBe(false); expect(writes).toBe(0)
})
test('Given 历史多个 agent When 检查本地绑定 Then 不迁移、不执行、不删除', async () => {
  const value=detail(''); value.agents.push({roomId:'r',roomAgentId:'old',ownerUserId:7})
  let writes=0; expect(await authorizeRoomBinding(binding,async()=>value,async()=>{writes++},()=>true)).toBe(false); expect(writes).toBe(0)
})
