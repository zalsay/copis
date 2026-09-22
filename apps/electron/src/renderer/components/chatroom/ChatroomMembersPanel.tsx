import * as React from 'react'
import type { ChatRoomAgent, ChatRoomMember, ChatRoomRole } from '@copis/shared'

export interface ChatroomMembersPanelProps { role: ChatRoomRole; members: ChatRoomMember[]; agents: ChatRoomAgent[] }

export function ChatroomMembersPanel({ role, members, agents }: ChatroomMembersPanelProps): React.ReactElement {
  return <aside aria-label="聊天室成员" className="w-64 shrink-0 border-l border-border/50 p-3 overflow-y-auto space-y-4">
    <section><h2 className="mb-2 text-xs font-semibold text-muted-foreground">成员 · {members.length}</h2><div className="space-y-1">{members.map((member) => <div key={member.userId} className="flex items-center justify-between rounded-lg bg-muted/30 px-2 py-1.5 text-xs"><span>{member.displayName}{member.role === 'host' && <span className="ml-1 text-primary">主理人</span>}</span><span className={member.presence === 'offline' ? 'text-muted-foreground' : 'text-emerald-500'}>{member.presence === 'offline' ? '离线' : member.presence === 'busy' ? '忙碌' : '在线'}</span></div>)}</div></section>
    <section><h2 className="mb-2 text-xs font-semibold text-muted-foreground">Agent · {agents.length}/3</h2><div className="space-y-1">{agents.map((agent) => <div key={agent.agentId} className="rounded-lg bg-muted/30 px-2 py-1.5 text-xs"><div className="flex items-center justify-between"><span>@{agent.displayName}</span><span className={agent.status === 'offline' ? 'text-muted-foreground' : 'text-emerald-500'}>{agent.status === 'offline' ? '离线' : agent.status === 'busy' ? '忙碌' : '在线'}</span></div>{role === 'host' && <div className="mt-1 flex gap-2 text-[10px] text-muted-foreground"><span>记忆 {agent.memoryShared ? '已共享' : '未共享'}</span><span>Skill {agent.skillsShared ? '已共享' : '未共享'}</span></div>}</div>)}</div></section>
    {role === 'host' && <div className="border-t border-border/40 pt-3 text-[10px] text-muted-foreground">主理人权限：可在本机 Agent 设置中调整共享策略</div>}
  </aside>
}
