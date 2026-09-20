import { expect, test } from 'bun:test'
import type { ChatRoomAgentRuntimeContext } from '@copis/shared'

const context: ChatRoomAgentRuntimeContext = {
  executionWorkspace: {
    root: '/tmp/chatroom/root',
    projectRoot: '/tmp/chatroom/root/project',
    inboxRoot: '/tmp/chatroom/root/inbox',
    sessionRoot: '/tmp/chatroom/root/session',
  },
  memorySource: { workspaceSlug: 'source-workspace', policy: 'visible' },
  skillSnapshotPath: '/tmp/chatroom/root/skills',
  permissionContext: {
    roomId: 'room-1',
    roomAgentId: 'agent-1',
    invocationId: 'invocation-1',
    traceId: 'trace-1',
    originalSender: { type: 'user', id: 'user-1', displayName: '用户' },
    invocationChain: [],
  },
}

test('Given 注册可信上下文 When 读取 Then 返回深冻结副本且不能影响原始对象', async () => {
  const { registerTrustedAgentRuntimeContext, getTrustedAgentRuntimeContext } = await import('./agent-rpc-runtime-context')
  const release = registerTrustedAgentRuntimeContext('session-1', context)
  const resolved = getTrustedAgentRuntimeContext('session-1')!

  expect(resolved).not.toBe(context)
  expect(Object.isFrozen(resolved)).toBe(true)
  expect(Object.isFrozen(resolved.executionWorkspace)).toBe(true)
  expect(Object.isFrozen(resolved.permissionContext)).toBe(true)
  expect(() => {
    ;(resolved.executionWorkspace as { projectRoot: string }).projectRoot = '/tmp/forged'
  }).toThrow()
  expect(context.executionWorkspace.projectRoot).toBe('/tmp/chatroom/root/project')

  release()
  expect(getTrustedAgentRuntimeContext('session-1')).toBeUndefined()
})

test('Given 同一 session 嵌套注册 When 按顺序释放 Then 只释放自己的 token 并恢复上一层', async () => {
  const { registerTrustedAgentRuntimeContext, getTrustedAgentRuntimeContext } = await import('./agent-rpc-runtime-context')
  const outer = registerTrustedAgentRuntimeContext('session-2', context)
  const innerContext = { ...context, memorySource: undefined }
  const inner = registerTrustedAgentRuntimeContext('session-2', innerContext)

  expect(getTrustedAgentRuntimeContext('session-2')?.memorySource).toBeUndefined()
  outer()
  expect(getTrustedAgentRuntimeContext('session-2')?.memorySource).toBeUndefined()
  inner()
  expect(getTrustedAgentRuntimeContext('session-2')).toBeUndefined()
  outer()
})
