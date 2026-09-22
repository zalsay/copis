import { describe, expect, mock, test } from 'bun:test'
import { isChatRoomAgentInvocation, type ChatRoomAgentInvocation } from '@copis/shared'
import type { HttpApiDependencies } from './http-api-handler'
import type { AppSettings } from '../../types'

mock.module('electron', () => ({
  app: { isPackaged: true, getPath: () => '/tmp/copis-test-app-data' },
  BrowserWindow: class {},
  WebContentsView: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: { openExternal: async () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}))

const { handleHttpApiRequest } = await import('./http-api-handler')
const { parseAgentWorkerPermissionRequest } = await import('./http-api-handler')

test('Given worker permission DTO When unknown fields or control text arrive Then Main rejects without truncation', () => {
  expect(() => parseAgentWorkerPermissionRequest({ sessionId: 's', requestId: 'r', toolName: 'Bash', toolInput: {}, extra: true })).toThrow('权限请求字段不正确')
  expect(() => parseAgentWorkerPermissionRequest({ sessionId: 's\n', requestId: 'r', toolName: 'Bash', toolInput: {} })).toThrow('权限请求参数不正确')
  expect(() => parseAgentWorkerPermissionRequest({ sessionId: 's', requestId: 'r', toolName: 'x'.repeat(129), toolInput: {} })).toThrow('权限请求参数不正确')
})

const invocation: ChatRoomAgentInvocation = {
  invocationId: 'inv-1',
  roomId: 'room-1',
  traceId: 'trace-1',
  targetAgentId: 'agent-a',
  triggerMessageId: 'message-1',
  depth: 0,
  sender: { type: 'user', id: 'user-1', displayName: '主理人' },
  messages: [{
    messageId: 'message-1',
    sender: { type: 'user', id: 'user-1', displayName: '主理人' },
    text: '执行',
    createdAt: 0,
  }],
  receivedAt: 1,
}

const rustInvocationFixture: ChatRoomAgentInvocation = {
  ...invocation,
  sender: { type: 'user', id: '7', displayName: '用户#7' },
  messages: [{
    messageId: 'message-1',
    sender: { type: 'user', id: '7', displayName: '用户#7' },
    text: 'hello',
    createdAt: 1000,
    mentionedAgentIds: ['agent-a'],
  }],
  receivedAt: 2000,
}

function createDependencies(overrides: Partial<HttpApiDependencies> = {}): HttpApiDependencies {
  return {
    getWorkingClient: (() => ({ baseUrl: 'https://backend.example.test' })) as unknown as HttpApiDependencies['getWorkingClient'],
    getAppSettings: () => ({ themeMode: 'system' }) as AppSettings,
    updateAppSettings: () => ({ themeMode: 'system' }) as AppSettings,
    ...overrides,
  }
}

test('Given Rust HTTP login reports authenticated When auth state changes Then coordinator resume callback runs once', async () => {
  const resume = mock(async () => undefined)
  const response = await handleHttpApiRequest({
    method: 'POST', path: '/api/internal/auth-state/changed', body: JSON.stringify({ authenticated: true, user: { id: 'user-1' } }),
  }, createDependencies({
    resumeChatRoomAgentsAfterAuthentication: resume,
  }))
  expect(response.status).toBe(204)
  expect(resume).toHaveBeenCalledTimes(1)
})

test('Given authenticated state notification carries a user When bridge handles it Then it does not synthesize or clear local cached identity', async () => {
  const clearAuth = mock(() => undefined)
  const client = { baseUrl: 'https://backend.example.test', clearAuth, getCachedUser: () => null }
  const response = await handleHttpApiRequest({
    method: 'POST',
    path: '/api/internal/auth-state/changed',
    body: JSON.stringify({ authenticated: true, user: { id: 'rust-user' } }),
  }, createDependencies({ getWorkingClient: () => client as never }))

  expect(response).toEqual({ status: 204 })
  expect(clearAuth).not.toHaveBeenCalled()
})

test('Given Rust reports unauthenticated When auth state changes Then chatrooms stop before Working cached user is cleared', async () => {
  let cachedUser: { id: string } | null = { id: 'stale-user' }
  const order: string[] = []
  const client = {
    baseUrl: 'https://backend.example.test',
    getCachedUser: () => cachedUser,
    clearAuth: () => { order.push('clearAuth'); cachedUser = null },
  }
  const response = await handleHttpApiRequest({
    method: 'POST',
    path: '/api/internal/auth-state/changed',
    body: JSON.stringify({ authenticated: false }),
  }, createDependencies({
    getWorkingClient: () => client as never,
    stopChatRoomAgents: async () => { order.push('stopChatRoomAgents'); expect(cachedUser).not.toBeNull() },
  }))

  expect(response).toEqual({ status: 204 })
  expect(order).toEqual(['stopChatRoomAgents', 'clearAuth'])
  expect(cachedUser).toBeNull()
})

test('Given Rust clears auth storage When clear bridge runs Then runtime is stopped before local identity cleanup', async () => {
  const order: string[] = []
  const client = {
    baseUrl: 'https://backend.example.test',
    clearAuth: () => { order.push('clearAuth') },
  }
  const response = await handleHttpApiRequest({
    method: 'POST',
    path: '/api/internal/auth-storage/clear',
  }, createDependencies({
    getWorkingClient: () => client as never,
    stopChatRoomAgents: async () => { order.push('stopChatRoomAgents') },
  }))

  expect(response).toEqual({ status: 204 })
  expect(order).toEqual(['stopChatRoomAgents', 'clearAuth'])
})

test('Given cached account A When Rust saves account B Then old runtime stops before facade adopts B', async () => {
  const order: string[] = []
  let currentUser: { id: string } | null = { id: 'A' }
  const client = {
    baseUrl: 'https://backend.example.test',
    getCachedUser: () => currentUser,
    clearAuth: () => { order.push('clearAuth'); currentUser = null },
    setAuthenticatedUserFromRust: (user: unknown) => { order.push('setUser'); currentUser = user as { id: string }; return true },
  }
  const response = await handleHttpApiRequest({
    method: 'POST',
    path: '/api/internal/auth-storage/save',
    body: JSON.stringify({ accessToken: 'token-b', provider: 'legacy', user: { id: 'B' } }),
  }, createDependencies({
    getWorkingClient: () => client as never,
    stopChatRoomAgents: async () => { order.push('stopChatRoomAgents') },
  }))

  expect(response).toEqual({ status: 204 })
  expect(order).toEqual(['stopChatRoomAgents', 'clearAuth', 'setUser'])
  expect(currentUser).toEqual({ id: 'B' })
})

describe('聊天室 Rust bridge HTTP handler', () => {
  test('Given 合法 invocation When Rust bridge 投递 Then coordinator 接收且返回 accepted 202', async () => {
    const handleChatRoomInvocation = mock(async () => 'accepted' as const)
    const response = await handleHttpApiRequest({
      method: 'POST',
      path: '/api/internal/chatrooms/invocations',
      body: JSON.stringify(invocation),
    }, createDependencies({ handleChatRoomInvocation }))

    expect(response).toEqual({ status: 202, body: { status: 'accepted' } })
    expect(handleChatRoomInvocation).toHaveBeenCalledWith(invocation)
    expect(handleChatRoomInvocation).toHaveBeenCalledTimes(1)
  })

  test('Given Rust full invocation serialization When bridge 投递 Then strict DTO reaches coordinator unchanged', async () => {
    const handleChatRoomInvocation = mock(async () => 'accepted' as const)
    const response = await handleHttpApiRequest({
      method: 'POST',
      path: '/api/internal/chatrooms/invocations',
      body: JSON.stringify(rustInvocationFixture),
    }, createDependencies({ handleChatRoomInvocation }))

    expect(response).toEqual({ status: 202, body: { status: 'accepted' } })
    expect(handleChatRoomInvocation).toHaveBeenCalledWith(rustInvocationFixture)
  })

  test('Given coordinator 判断重复 invocation When Rust bridge 投递 Then 返回 duplicate 200', async () => {
    const handleChatRoomInvocation = mock(async () => 'duplicate' as const)
    const response = await handleHttpApiRequest({
      method: 'POST',
      path: '/api/internal/chatrooms/invocations',
      body: JSON.stringify(invocation),
    }, createDependencies({ handleChatRoomInvocation }))

    expect(response).toEqual({ status: 200, body: { status: 'duplicate' } })
  })

  test('Given disconnected bridge When 收到精确协议 Then coordinator 只清理一次并返回 204', async () => {
    const handleChatRoomGatewayDisconnected = mock(async () => {})
    const response = await handleHttpApiRequest({
      method: 'POST',
      path: '/api/internal/chatrooms/disconnected',
      body: JSON.stringify({ reason: 'realtime_disconnected' }),
    }, createDependencies({ handleChatRoomGatewayDisconnected }))

    expect(response).toEqual({ status: 204 })
    expect(handleChatRoomGatewayDisconnected).toHaveBeenCalledTimes(1)
  })

  test('Given 非法 invocation 或未知字段 When bridge 投递 Then 返回稳定 400 且不执行 Agent', async () => {
    const handleChatRoomInvocation = mock(async () => 'accepted' as const)
    const response = await handleHttpApiRequest({
      method: 'POST',
      path: '/api/internal/chatrooms/invocations',
      body: JSON.stringify({ ...invocation, token: 'leak' }),
    }, createDependencies({ handleChatRoomInvocation }))

    expect(response).toEqual({ status: 400, body: { code: 'invalid_chatroom_invocation', error: '聊天室调用参数不正确' } })
    expect(handleChatRoomInvocation).not.toHaveBeenCalled()
  })

  test('Given legacy minimal or status-bearing invocation When bridge 投递 Then strict DTO rejects before coordinator', async () => {
    const handleChatRoomInvocation = mock(async () => 'accepted' as const)
    for (const body of [
      { invocationId: 'inv-legacy', roomId: 'room-1', traceId: 'trace-1', targetAgentId: 'agent-a', triggerMessageId: 'message-1', depth: 0 },
      { ...rustInvocationFixture, status: 'created' },
    ]) {
      const response = await handleHttpApiRequest({
        method: 'POST',
        path: '/api/internal/chatrooms/invocations',
        body: JSON.stringify(body),
      }, createDependencies({ handleChatRoomInvocation }))
      expect(response.status).toBe(400)
    }
    expect(handleChatRoomInvocation).not.toHaveBeenCalled()
  })

  test('Given Rust invocation 上下文为空或 trigger/sender 不一致 When bridge 投递 Then 返回 400 且不调用 coordinator', async () => {
    const handleChatRoomInvocation = mock(async () => 'accepted' as const)
    for (const body of [
      { ...invocation, messages: [] },
      { ...invocation, messages: [{ ...invocation.messages[0]!, messageId: 'message-other' }] },
      { ...invocation, messages: [{ ...invocation.messages[0]!, sender: { ...invocation.sender, id: 'user-2' } }] },
    ]) {
      const response = await handleHttpApiRequest({
        method: 'POST',
        path: '/api/internal/chatrooms/invocations',
        body: JSON.stringify(body),
      }, createDependencies({ handleChatRoomInvocation }))
      expect(response.status).toBe(400)
    }
    expect(handleChatRoomInvocation).not.toHaveBeenCalled()
  })

  test('Given body 超过通用上限 When bridge 投递 Then 返回 413 且不执行 Agent', async () => {
    const handleChatRoomInvocation = mock(async () => 'accepted' as const)
    const response = await handleHttpApiRequest({
      method: 'POST',
      path: '/api/internal/chatrooms/invocations',
      body: `${JSON.stringify(invocation).slice(0, -1)},"padding":"${'x'.repeat(2 * 1024 * 1024)}"}`,
    }, createDependencies({ handleChatRoomInvocation }))

    expect(response).toEqual({ status: 413, body: { code: 'request_body_too_large', error: '请求体过大' } })
    expect(handleChatRoomInvocation).not.toHaveBeenCalled()
  })

  test('Given route 使用 query、trailing slash 或非 POST When bridge 处理 Then 不匹配 coordinator', async () => {
    const handleChatRoomInvocation = mock(async () => 'accepted' as const)
    const dependencies = createDependencies({ handleChatRoomInvocation })
    const getResponse = await handleHttpApiRequest({ method: 'GET', path: '/api/internal/chatrooms/invocations' }, dependencies)
    const slashResponse = await handleHttpApiRequest({ method: 'POST', path: '/api/internal/chatrooms/invocations/', body: JSON.stringify(invocation) }, dependencies)
    const queryResponse = await handleHttpApiRequest({ method: 'POST', path: '/api/internal/chatrooms/invocations?x=1', body: JSON.stringify(invocation) }, dependencies)

    expect(getResponse).toEqual({ status: 405, body: { code: 'method_not_allowed', error: '聊天室内部接口只支持 POST' } })
    expect(slashResponse.status).toBe(404)
    expect(queryResponse.status).toBe(404)
    expect(handleChatRoomInvocation).not.toHaveBeenCalled()
  })

  test('Given 未注入 coordinator When invocation 合法 Then lazy import 不可用时稳定返回 503', async () => {
    const response = await handleHttpApiRequest({
      method: 'POST',
      path: '/api/internal/chatrooms/invocations',
      body: JSON.stringify(invocation),
    }, createDependencies())

    expect(response).toEqual({ status: 503, body: { code: 'chatroom_coordinator_unavailable', error: '聊天室协调器不可用' } })
  })

  test('Given callback 抛错 When bridge 调用 Then 返回统一 500 且不产生未处理 rejection', async () => {
    const handleChatRoomInvocation = mock(async () => { throw new Error('token=secret /Users/private/coordinator failed') })
    const response = await handleHttpApiRequest({
      method: 'POST',
      path: '/api/internal/chatrooms/invocations',
      body: JSON.stringify(invocation),
    }, createDependencies({ handleChatRoomInvocation }))

    expect(response).toEqual({ status: 500, body: { code: 'chatroom_coordinator_failed', error: '聊天室协调器处理失败' } })
    expect(JSON.stringify(response)).not.toContain('secret')
    expect(JSON.stringify(response)).not.toContain('/Users/private')
  })

  test('Given coordinator 抛出含敏感路径和堆栈的错误 When bridge 记录失败 Then 日志也不泄露错误详情', async () => {
    const secret = 'token=secret-value'
    const posixPath = '/Users/private/coordinator.ts'
    const windowsPath = 'C:\\Users\\private\\coordinator.ts'
    const stackMarker = 'STACK_SECRET_MARKER'
    const error = new Error(`${secret} ${posixPath} ${windowsPath}`)
    error.stack = `${error.name}: ${error.message}\n    at ${windowsPath}:42:7\n${stackMarker}`
    const handleChatRoomInvocation = mock(async () => { throw error })
    const calls: unknown[][] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => { calls.push(args) }
    let response: unknown
    try {
      response = await handleHttpApiRequest({
        method: 'POST',
        path: '/api/internal/chatrooms/invocations',
        body: JSON.stringify(invocation),
      }, createDependencies({ handleChatRoomInvocation }))
    } finally {
      console.error = originalError
    }

    expect(response).toEqual({ status: 500, body: { code: 'chatroom_coordinator_failed', error: '聊天室协调器处理失败' } })
    const logs = JSON.stringify(calls)
    expect(logs).not.toContain(secret)
    expect(logs).not.toContain(posixPath)
    expect(logs).not.toContain(windowsPath)
    expect(logs).not.toContain(stackMarker)
    expect(logs).toContain('协调器回调失败')
  })

  test('Given coordinator callback 返回未知状态 When bridge 调用 Then 固定返回 500 而不是误认 accepted', async () => {
    const handleChatRoomInvocation = mock(async () => 'unexpected' as never)
    const response = await handleHttpApiRequest({
      method: 'POST',
      path: '/api/internal/chatrooms/invocations',
      body: JSON.stringify(invocation),
    }, createDependencies({ handleChatRoomInvocation }))

    expect(response).toEqual({ status: 500, body: { code: 'chatroom_coordinator_failed', error: '聊天室协调器处理失败' } })
  })

  test('Given coordinator 返回带敏感字段的未知状态 When bridge 记录失败 Then 日志不序列化原始状态', async () => {
    const value = {
      status: 'unexpected-status-secret',
      token: 'token=unknown-secret',
      posixPath: '/Users/private/unknown.ts',
      windowsPath: 'C:\\Users\\private\\unknown.ts',
    }
    const handleChatRoomInvocation = mock(async () => value as never)
    const calls: unknown[][] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => { calls.push(args) }
    let response: unknown
    try {
      response = await handleHttpApiRequest({
        method: 'POST',
        path: '/api/internal/chatrooms/invocations',
        body: JSON.stringify(invocation),
      }, createDependencies({ handleChatRoomInvocation }))
    } finally {
      console.error = originalError
    }

    expect(response).toEqual({ status: 500, body: { code: 'chatroom_coordinator_failed', error: '聊天室协调器处理失败' } })
    const logs = JSON.stringify(calls)
    expect(logs).not.toContain('unexpected-status-secret')
    expect(logs).not.toContain('unknown-secret')
    expect(logs).not.toContain('/Users/private/unknown.ts')
    expect(logs).not.toContain('C:\\Users\\private\\unknown.ts')
    expect(logs).toContain('协调器返回了未知状态')
  })

  test('Given disconnected body 含未知字段 When bridge 处理 Then 拒绝且不清理', async () => {
    const handleChatRoomGatewayDisconnected = mock(async () => {})
    const response = await handleHttpApiRequest({
      method: 'POST',
      path: '/api/internal/chatrooms/disconnected',
      body: JSON.stringify({ reason: 'realtime_disconnected', token: 'secret' }),
    }, createDependencies({ handleChatRoomGatewayDisconnected }))

    expect(response.status).toBe(400)
    expect(handleChatRoomGatewayDisconnected).not.toHaveBeenCalled()
  })

  test('Given disconnected callback 抛错 When bridge 处理 Then 返回统一 500 而非误报 coordinator unavailable', async () => {
    const handleChatRoomGatewayDisconnected = mock(async () => { throw new Error('token=secret /Users/private/disconnect failed') })
    const response = await handleHttpApiRequest({
      method: 'POST',
      path: '/api/internal/chatrooms/disconnected',
      body: JSON.stringify({ reason: 'realtime_disconnected' }),
    }, createDependencies({ handleChatRoomGatewayDisconnected }))

    expect(response).toEqual({ status: 500, body: { code: 'chatroom_coordinator_failed', error: '聊天室协调器处理失败' } })
    expect(JSON.stringify(response)).not.toContain('secret')
    expect(JSON.stringify(response)).not.toContain('/Users/private')
  })

  test('Given Task 1 validator When fixture used Then it remains strict plain DTO', () => {
    expect(isChatRoomAgentInvocation(invocation)).toBe(true)
  })
})
