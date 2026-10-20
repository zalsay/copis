/**
 * DSH 群聊与多智能体协作子视图根组件（DshGroupChatView）
 * 
 * 嵌入 CopisCreationWebView 的 subview 槽位中，承载多智能体协同办公全流程。
 */

import React from 'react'
import { useAtomValue } from 'jotai'
import { DshGroupChatSidebar } from './DshGroupChatSidebar'
import { DshGroupChatWorkspace } from './DshGroupChatWorkspace'
import { DshGroupChatTasksPanel } from './DshGroupChatTasksPanel'
import { DshGroupChatInvocationDetail } from './DshGroupChatInvocationDetail'
import { DshGroupChatCreateDialog } from './DshGroupChatCreateDialog'
import { dshActiveDrawerAtom } from '@/atoms/dsh-group-chat-atoms'

interface DshGroupChatViewProps {
  onClose?: () => void
}

export function DshGroupChatView({ onClose }: DshGroupChatViewProps): React.ReactElement {
  const activeDrawer = useAtomValue(dshActiveDrawerAtom)

  return (
    <div className="flex w-full h-full overflow-hidden bg-background">
      {/* 1. 左侧群聊会话列表 */}
      <DshGroupChatSidebar />

      {/* 2. 中间主聊天工作台 */}
      <DshGroupChatWorkspace onClose={onClose} />

      {/* 3. 右侧协作抽屉 */}
      {activeDrawer === 'tasks' && <DshGroupChatTasksPanel />}
      {activeDrawer === 'invocation' && <DshGroupChatInvocationDetail />}

      {/* 4. 新建群聊弹窗 */}
      <DshGroupChatCreateDialog />
    </div>
  )
}
