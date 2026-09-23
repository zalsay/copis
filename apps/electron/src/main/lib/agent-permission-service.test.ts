import { expect, test } from 'bun:test'
import { AgentPermissionService, type CanUseToolOptions } from './agent-permission-service'
import type { PermissionRequest } from '@copis/shared'

function permissionOptions(signal: AbortSignal, toolUseID: string): CanUseToolOptions {
  return { signal, toolUseID, displayName: '删除分组', description: '删除 Todo 分组' }
}

test('Given internal worker approval When renderer responds Then external pending settles exactly once', async () => {
  const service = new AgentPermissionService(() => 'external-request')
  const sent: PermissionRequest[] = []
  const result = service.openExternalApproval({ requestId: 'external-request', sessionId: 'chat-session', toolName: 'Bash', toolInput: { command: 'echo ok' }, description: 'danger', dangerLevel: 'dangerous', allowAlways: false }, new AbortController().signal, (request) => sent.push(request))
  expect(sent).toHaveLength(1)
  expect(service.respondToPermission('external-request', 'allow', false)).toBe('chat-session')
  expect(await result).toMatchObject({ behavior: 'allow' })
})

test('Given a destructive planning request When it is approved Then approval is single-use and cannot create a session whitelist', async () => {
  const service = new AgentPermissionService()
  const controller = new AbortController()
  let firstRequest: { requestId: string; allowAlways?: boolean } | undefined

  const firstResult = service.requestSingleApproval(
    'session-1',
    'mcp__planning__delete_group',
    { id: 'group-1', scope: 'todo' },
    permissionOptions(controller.signal, 'tool-1'),
    (request) => { firstRequest = request },
  )

  expect(firstRequest?.allowAlways).toBe(false)
  expect(service.respondToPermission(firstRequest!.requestId, 'allow', true)).toBe('session-1')
  expect((await firstResult).behavior).toBe('allow')

  let secondRequest: { requestId: string } | undefined
  const secondResult = service.createCanUseTool('session-1', (request) => { secondRequest = request })(
    'mcp__planning__delete_group',
    { id: 'group-2', scope: 'todo' },
    permissionOptions(controller.signal, 'tool-2'),
  )

  expect(secondRequest).toBeDefined()
  expect(service.respondToPermission(secondRequest!.requestId, 'deny', false)).toBe('session-1')
  expect((await secondResult).behavior).toBe('deny')
})

test('Given the same request id When two approvals are opened Then the second promise rejects and the first remains resolvable', async () => {
  let sequence = 0
  const service = new AgentPermissionService(() => sequence++ === 0 ? 'duplicate-request' : 'duplicate-request')
  const controller = new AbortController()
  let requestId = ''
  const first = service.requestSingleApproval('session-1', 'Bash', { command: 'rm -rf project' }, permissionOptions(controller.signal, 'tool-1'), (request) => { requestId = request.requestId })
  const second = service.requestSingleApproval('session-1', 'Bash', { command: 'rm -rf project' }, permissionOptions(controller.signal, 'tool-2'), () => {})
  await expect(second).rejects.toThrow('permission_request_duplicate')
  expect(service.respondToPermission(requestId, 'deny', true)).toBe('session-1')
  expect((await first).behavior).toBe('deny')
})

test('Given an already aborted signal When approval opens Then it resolves deny without dispatching', async () => {
  const service = new AgentPermissionService(() => 'pre-aborted')
  const controller = new AbortController()
  controller.abort()
  let dispatched = false
  const result = await service.requestSingleApproval('session-1', 'Bash', { command: 'rm -rf project' }, permissionOptions(controller.signal, 'tool-1'), () => { dispatched = true })
  expect(result.behavior).toBe('deny')
  expect(dispatched).toBe(false)
  expect(service.getPendingRequests()).toHaveLength(0)
})

test('Given abort during renderer dispatch When approval opens Then it resolves deny and leaves no pending request', async () => {
  const service = new AgentPermissionService(() => 'dispatch-abort')
  const controller = new AbortController()
  let result!: Promise<unknown>
  result = service.requestSingleApproval('session-1', 'Bash', { command: 'rm -rf project' }, permissionOptions(controller.signal, 'tool-1'), () => controller.abort())
  await expect(result).resolves.toMatchObject({ behavior: 'deny' })
  expect(service.getPendingRequests()).toHaveLength(0)
})

test('Given approval already responded When abort and clear follow Then settle is idempotent and no pending remains', async () => {
  const service = new AgentPermissionService(() => 'settle-once')
  const controller = new AbortController()
  const result = service.requestSingleApproval('session-1', 'Bash', { command: 'echo ok' }, permissionOptions(controller.signal, 'tool-1'), () => {})
  expect(service.respondToPermission('settle-once', 'deny', false)).toBe('session-1')
  controller.abort()
  service.clearSessionPending('session-1')
  await expect(result).resolves.toMatchObject({ behavior: 'deny' })
  expect(service.getPendingRequests()).toHaveLength(0)
})
