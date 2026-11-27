import type { RoomBinding } from './shared-room-executor'

/** 调用者必须先从本机绑定文件获得 binding；详情和迁移均走绑定账号的内部网关。 */
export async function authorizeRoomBinding(binding:RoomBinding, detail:()=>Promise<unknown>, mark:(binding:RoomBinding)=>Promise<unknown>, current:()=>boolean):Promise<boolean> {
  const check = (raw:unknown) => {
    if (!raw || typeof raw !== 'object') return null
    const data = raw as any, room = data.room
    if (!room || room.roomId !== binding.roomId || String(room.hostUserId) !== binding.userId || room.status !== 'active' || typeof room.roomKind !== 'string' || (!Array.isArray(data.agents) || data.agents.length !== 1)) return null
    const agents = data.agents.filter((a:any) => a?.roomId === binding.roomId && a.roomAgentId === binding.roomAgentId && String(a.ownerUserId) === binding.userId)
    return agents.length === 1 ? room.roomKind as string : null
  }
  if (!current()) return false
  let kind = check(await detail())
  if (!current() || kind === null) return false
  if (kind === '') {
    await mark(binding)
    if (!current()) return false
    kind = check(await detail())
  }
  return current() && kind === 'dsh_shared'
}
