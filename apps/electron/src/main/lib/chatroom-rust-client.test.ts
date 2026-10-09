import { describe, expect, mock, test } from 'bun:test'

const electronPathLookups: string[] = []

mock.module('electron', () => ({
  app: { isPackaged: true, getPath: (name: string) => { electronPathLookups.push(name); return '/tmp/copis-test-app-data' } },
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
mock.module('./http-api-server', () => ({
  HTTP_API_HOST: '127.0.0.1',
  HTTP_API_PORT: 51730,
  getHttpApiInternalToken: () => 'internal-test',
}))

const { HttpChatRoomRustApiClient } = await import('./chatroom-rust-client')

type RecordedRequest = { input: RequestInfo | URL; init?: RequestInit }

const context = {
  roomId: 'room-1',
  agentId: 'agent-a',
  deviceId: 'device-1',
  clientMessageId: 'message-1',
  traceId: 'trace-1',
  targetAgentId: 'agent-a',
  triggerMessageId: 'message-1',
  depth: 0,
}

function responseForLifecycleRequest(input: RequestInfo | URL, init?: RequestInit): Response {
  const url = new URL(String(input))
  const state = url.pathname.split('/').at(-1)
  if (!['accepted', 'running', 'completed', 'failed'].includes(state ?? '')) return new Response(null, { status: 204 })
  const body = JSON.parse(String(init?.body)) as { roomId: string; invocationId: string }
  const isRunning = state === 'running'
  if (state === 'completed' || state === 'failed') {
    return Response.json({
      outcome: 'confirmed', mode: 'invocation-ack-v1', source: 'private-ack', confirmed: true,
      roomId: body.roomId, invocationId: body.invocationId, command: `agent.${state}`,
      status: state, generation: 1, requestId: `request-${body.invocationId}-${state}`,
    })
  }
  return Response.json({
    outcome: isRunning ? 'advisory' : 'confirmed',
    mode: 'legacy',
    source: isRunning ? 'accepted-event+local-advisory' : 'server-event',
    roomId: body.roomId,
    invocationId: body.invocationId,
    command: `agent.${state}`,
    status: state,
    generation: 1,
  })
}

function createClient(
  requests: RecordedRequest[],
  options: {
    token?: string | null
    response?: Response
    getInvocationContext?: (invocationId: string) => typeof context
  } = {},
) {
  return new HttpChatRoomRustApiClient({
    fetchImpl: async (input, init) => {
      requests.push({ input, init })
      return options.response ?? responseForLifecycleRequest(input, init)
    },
    getToken: () => options.token === undefined ? 'internal-test' : options.token,
    getInvocationContext: options.getInvocationContext ?? (() => context),
  })
}

describe('HttpChatRoomRustApiClient', () => {
  test('Given isolated Main HTTP client fixture When tests load Then no Electron user-data/config path is requested', () => {
    expect(electronPathLookups).toEqual([])
  })

  test('Given lifecycle endpoint 返回空 204 When 上报 accepted Then 不得将 HTTP 成功当作生命周期确认', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests, { response: new Response(null, { status: 204 }) })

    await expect(client.reportAccepted({ invocationId: 'inv-1' })).rejects.toThrow()
    expect(requests).toHaveLength(1)
  })

  test('Given accepted 私有 ACK 的真实 proof When outcome 与 invocation 匹配 Then 返回服务端实际 running status', async () => {
    const requests: RecordedRequest[] = []
    const client = new HttpChatRoomRustApiClient({
      fetchImpl: async (input, init) => {
        requests.push({ input, init })
        return Response.json({
          outcome: 'confirmed', mode: 'invocation-ack-v1', source: 'private-ack', confirmed: true,
          roomId: 'room-1', invocationId: 'inv-1', requestId: 'request-1',
          command: 'agent.accepted', status: 'running', generation: 3,
        })
      },
      getToken: () => 'internal-test',
      getInvocationContext: () => context,
    })

    const controller = new AbortController()
    const result = await client.reportAccepted({ invocationId: 'inv-1' }, { signal: controller.signal })
    expect(result).toEqual({
      outcome: 'confirmed', mode: 'invocation-ack-v1', source: 'private-ack', confirmed: true,
      roomId: 'room-1', invocationId: 'inv-1', requestId: 'request-1',
      command: 'agent.accepted', status: 'running', generation: 3,
    })
    expect(requests[0]?.init?.signal).toBe(controller.signal)
  })

  test('Given lifecycle proof 具有 unknown source、错误状态类型或 generation When 回传 Then fail closed', async () => {
    const invalidProofs = [
      { outcome: 'confirmed', mode: 'legacy', source: 'local-enqueue', roomId: 'room-1', invocationId: 'inv-1', command: 'agent.accepted', status: 'accepted', generation: 1 },
      { outcome: 'confirmed', mode: 'legacy', source: 'server-event', roomId: 'room-1', invocationId: 'inv-1', command: 'agent.accepted', status: ['accepted'], generation: 1 },
      { outcome: 'confirmed', mode: 'legacy', source: 'server-event', roomId: 'room-1', invocationId: 'inv-1', command: 'agent.accepted', status: 'accepted', generation: 0 },
      { outcome: 'confirmed', mode: 'legacy', source: 'server-event', roomId: 'other-room', invocationId: 'inv-1', command: 'agent.accepted', status: 'accepted', generation: 1 },
      { outcome: 'confirmed', mode: 'legacy', source: 'server-event', roomId: 'room-1', invocationId: 'inv-1', command: 'agent.failed', status: 'accepted', generation: 1 },
      { outcome: 'confirmed', mode: 'legacy', source: 'server-event', roomId: 'room-1', invocationId: 'inv-1', command: 'agent.accepted', status: 'accepted', generation: 1, private: 'unexpected' },
    ]
    for (const proof of invalidProofs) {
      const client = new HttpChatRoomRustApiClient({
        fetchImpl: async () => Response.json(proof),
        getToken: () => 'internal-test',
        getInvocationContext: () => context,
      })
      await expect(client.reportAccepted({ invocationId: 'inv-1' })).rejects.toThrow()
    }
  })

  test('Given exact event-derived legacy completed or failed receipt When Main validates it Then accept only the matched terminal proof', async () => {
    const matchedEvent = {
      roomId: 'room-1', invocationId: 'inv-1', content: 'done', mentionAgentIds: [], attachmentIds: [],
      clientMessageId: 'reply-1',
    }
    const expectedDigest = 'b49e17043a199ab3a220f1746e315d88d6d9dbb0820f5f7c24254dda3c151b37'
    const eventProofs = [
      {
        command: 'agent.completed', status: 'completed',
        terminalProof: {
          kind: 'matched-server-event-v1',
          replyClientMessageId: matchedEvent.clientMessageId,
          replyDigest: expectedDigest,
        },
        report: (client: InstanceType<typeof HttpChatRoomRustApiClient>) => client.reportCompleted({
          invocationId: matchedEvent.invocationId,
          output: { text: matchedEvent.content, mentionedAgentIds: [], attachmentIds: [] },
        }),
      },
      {
        command: 'agent.failed', status: 'failed',
        terminalProof: { kind: 'matched-server-event-v1', failureCode: 'agent_offline' },
        report: (client: InstanceType<typeof HttpChatRoomRustApiClient>) => client.reportFailed({
          invocationId: matchedEvent.invocationId, code: 'agent_offline', message: 'offline',
        }),
      },
    ]
    for (const scenario of eventProofs) {
      const client = new HttpChatRoomRustApiClient({
        fetchImpl: async () => Response.json({
          outcome: 'confirmed', mode: 'legacy', source: 'server-event',
          roomId: matchedEvent.roomId, invocationId: matchedEvent.invocationId,
          command: scenario.command, status: scenario.status, generation: 4,
          terminalProof: scenario.terminalProof,
        }),
        getToken: () => 'internal-test',
        getInvocationContext: () => ({ ...context, clientMessageId: matchedEvent.clientMessageId }),
      })

      await expect(scenario.report(client)).resolves.toMatchObject({
        outcome: 'confirmed', mode: 'legacy', source: 'server-event',
        command: scenario.command, status: scenario.status, generation: 4,
        terminalProof: scenario.terminalProof,
      })
    }
  })

  test('Given legacy terminal lifecycle response omits or corrupts event proof When Main validates it Then weak exact shape is Unknown and malformed proof is Rejected', async () => {
    const contextForResult = { ...context, clientMessageId: 'reply-1' }
    const completedBody = {
      outcome: 'confirmed', mode: 'legacy', source: 'server-event', roomId: 'room-1', invocationId: 'inv-1',
      command: 'agent.completed', status: 'completed', generation: 4,
    }
    const failedBody = {
      outcome: 'confirmed', mode: 'legacy', source: 'server-event', roomId: 'room-1', invocationId: 'inv-1',
      command: 'agent.failed', status: 'failed', generation: 4,
    }
    for (const weak of [completedBody, failedBody]) {
      const client = new HttpChatRoomRustApiClient({
        fetchImpl: async () => Response.json(weak), getToken: () => 'internal-test',
        getInvocationContext: () => contextForResult,
      })
      const report = weak.status === 'completed'
        ? () => client.reportCompleted({ invocationId: 'inv-1', output: { text: 'done', mentionedAgentIds: [], attachmentIds: [] } })
        : () => client.reportFailed({ invocationId: 'inv-1', code: 'agent_offline', message: 'offline' })
      await expect(report()).rejects.toMatchObject({ outcome: 'Unknown' })
    }

    for (const terminalProof of [
      { kind: 'matched-server-event-v1', replyClientMessageId: 'wrong-client', replyDigest: 'b49e17043a199ab3a220f1746e315d88d6d9dbb0820f5f7c24254dda3c151b37' },
      { kind: 'matched-server-event-v1', replyClientMessageId: 'reply-1', replyDigest: 'b'.repeat(64) },
      { kind: 'matched-server-event-v1', failureCode: 'agent_offline', extra: true },
    ]) {
      const client = new HttpChatRoomRustApiClient({
        fetchImpl: async () => Response.json({ ...completedBody, terminalProof }),
        getToken: () => 'internal-test', getInvocationContext: () => contextForResult,
      })
      await expect(client.reportCompleted({ invocationId: 'inv-1', output: { text: 'done', mentionedAgentIds: [], attachmentIds: [] } }))
        .rejects.toMatchObject({ outcome: 'Rejected' })
    }
  })

  test('Given HTTP auth/conflict responses carry a misleading lifecycle_unknown code When lifecycle reports Then HTTP status keeps them Rejected', async () => {
    for (const status of [401, 403, 409]) {
      const client = new HttpChatRoomRustApiClient({
        fetchImpl: async () => Response.json({ code: 'lifecycle_unknown', error: 'private details' }, { status }),
        getToken: () => 'internal-test',
        getInvocationContext: () => context,
      })
      await expect(client.reportAccepted({ invocationId: 'inv-1' })).rejects.toMatchObject({ outcome: 'Rejected', code: 'lifecycle_unknown', httpStatus: status })
    }
  })

  test('Given HTTP 404 or 503 lifecycle_unknown When lifecycle report ends Then classify as Unknown', async () => {
    for (const status of [404, 503]) {
      const client = new HttpChatRoomRustApiClient({
        fetchImpl: async () => Response.json({ code: 'lifecycle_unknown' }, { status }),
        getToken: () => 'internal-test',
        getInvocationContext: () => context,
      })
      await expect(client.reportAccepted({ invocationId: 'inv-1' })).rejects.toMatchObject({ outcome: 'Unknown', code: 'lifecycle_unknown', httpStatus: status })
    }
  })

  test('Given legacy running response When matching local advisory arrives Then retain running but never call it confirmed', async () => {
    const client = new HttpChatRoomRustApiClient({
      fetchImpl: async () => Response.json({
        outcome: 'advisory', mode: 'legacy', source: 'accepted-event+local-advisory',
        roomId: 'room-1', invocationId: 'inv-1', command: 'agent.running', status: 'running', generation: 3,
      }),
      getToken: () => 'internal-test',
      getInvocationContext: () => context,
    })

    const result = await client.reportRunning({ invocationId: 'inv-1' })
    expect(result.outcome).toBe('advisory')
    expect(result.status).toBe('running')
  })

  test('Given local completed result When querying Rust status Then require matching identity and Go-compatible reply proof', async () => {
    const requests: RecordedRequest[] = []
    const controller = new AbortController()
    const query = {
      roomId: 'room-1', invocationId: 'inv-1', deviceId: 'device-1', traceId: 'trace-1',
      targetAgentId: 'agent-a', triggerMessageId: 'message-1', depth: 0, expectedStatus: 'completed' as const,
      failureCode: '' as const, clientMessageId: 'message-1', replyDigest: 'a'.repeat(64),
    }
    const client = new HttpChatRoomRustApiClient({
      fetchImpl: async (input, init) => {
        requests.push({ input, init })
        return Response.json({
          outcome: 'Confirmed', roomId: 'room-1', invocationId: 'inv-1', traceId: 'trace-1', generation: 4,
          status: 'completed', finishedAt: '2026-09-28T10:00:00Z', replyMessageId: 'reply-msg-1',
          replyClientMessageId: 'message-1', replyDigest: 'a'.repeat(64),
        })
      },
      getToken: () => 'internal-test',
    })

    const result = await client.queryInvocationStatus(query, { signal: controller.signal })
    expect(result).toMatchObject({ outcome: 'Confirmed', status: 'completed', replyMessageId: 'reply-msg-1', replyDigest: 'a'.repeat(64) })
    expect(String(requests[0]?.input)).toBe('http://127.0.0.1:51730/api/internal/chatrooms/rooms/room-1/invocations/inv-1/status')
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual(query)
    expect((requests[0]?.init?.headers as Record<string, string>)['X-Copis-Internal-Token']).toBe('internal-test')
    expect(requests[0]?.init?.signal).toBe(controller.signal)
  })

  test('Given local failed result When querying status Then matching failure proof confirms without a reply digest', async () => {
    const client = new HttpChatRoomRustApiClient({
      fetchImpl: async () => Response.json({
        outcome: 'Confirmed', roomId: 'room-1', invocationId: 'inv-1', traceId: 'trace-1', generation: 0,
        status: 'failed', finishedAt: '2026-09-28T10:00:00Z', failureCode: 'internal_error',
      }),
      getToken: () => 'internal-test',
    })
    const result = await client.queryInvocationStatus({
      roomId: 'room-1', invocationId: 'inv-1', deviceId: 'device-1', traceId: 'trace-1',
      targetAgentId: 'agent-a', triggerMessageId: 'message-1', depth: 0, expectedStatus: 'failed',
      failureCode: 'internal_error', clientMessageId: '', replyDigest: '',
    })
    expect(result).toMatchObject({ outcome: 'Confirmed', status: 'failed', failureCode: 'internal_error', generation: 0 })
  })

  test('Given legacy status 404 event proof When only the old status envelope arrives Then keep it unknown', async () => {
    const client = new HttpChatRoomRustApiClient({
      fetchImpl: async () => Response.json({
        outcome: 'Confirmed', mode: 'legacy', source: 'server-event', roomId: 'room-1', invocationId: 'inv-1',
        traceId: 'trace-1', status: 'failed', generation: 4,
      }),
      getToken: () => 'internal-test',
    })
    const result = await client.queryInvocationStatus({
      roomId: 'room-1', invocationId: 'inv-1', deviceId: 'device-1', traceId: 'trace-1',
      targetAgentId: 'agent-a', triggerMessageId: 'message-1', depth: 0, expectedStatus: 'failed',
      failureCode: 'internal_error', clientMessageId: '', replyDigest: '',
    })
    expect(result).toMatchObject({ outcome: 'Unknown', roomId: 'room-1', invocationId: 'inv-1', traceId: 'trace-1' })
  })

  test('Given legacy terminal event includes an exact event-derived proof When its identity and result match Then accept without reply body or fabricated timestamp', async () => {
    const matchedEvent = {
      roomId: 'room-1', invocationId: 'inv-1', content: 'done', mentionAgentIds: [], attachmentIds: [],
      clientMessageId: 'reply-1',
    }
    const expectedDigest = 'b49e17043a199ab3a220f1746e315d88d6d9dbb0820f5f7c24254dda3c151b37'
    const query = {
      roomId: 'room-1', invocationId: 'inv-1', deviceId: 'device-1', traceId: 'trace-1',
      targetAgentId: 'agent-a', triggerMessageId: 'message-1', depth: 0, expectedStatus: 'completed' as const,
      failureCode: '' as const, clientMessageId: 'reply-1', replyDigest: expectedDigest,
    }
    const client = new HttpChatRoomRustApiClient({
      fetchImpl: async () => Response.json({
        outcome: 'Confirmed', mode: 'legacy', source: 'server-event', roomId: matchedEvent.roomId, invocationId: matchedEvent.invocationId,
        traceId: query.traceId, status: 'completed', generation: 4,
        terminalProof: { kind: 'matched-server-event-v1', replyClientMessageId: matchedEvent.clientMessageId, replyDigest: expectedDigest },
      }),
      getToken: () => 'internal-test',
    })

    const result = await client.queryInvocationStatus(query)

    expect(result).toMatchObject({
      outcome: 'Confirmed', mode: 'legacy', source: 'server-event', status: 'completed', generation: 4,
      terminalProof: { kind: 'matched-server-event-v1', replyClientMessageId: matchedEvent.clientMessageId, replyDigest: expectedDigest },
    })
    expect(result).not.toHaveProperty('finishedAt')
    expect(result).not.toHaveProperty('content')
  })

  test('Given legacy failed event proof When actual failureCode matches the local claim Then confirm; a substituted code remains Rejected', async () => {
    const matchedEvent = { roomId: 'room-1', invocationId: 'inv-1', failureCode: 'agent_offline' }
    const query = {
      roomId: 'room-1', invocationId: 'inv-1', deviceId: 'device-1', traceId: 'trace-1',
      targetAgentId: 'agent-a', triggerMessageId: 'message-1', depth: 0, expectedStatus: 'failed' as const,
      failureCode: 'agent_offline' as const, clientMessageId: '', replyDigest: '',
    }
    const response = {
      outcome: 'Confirmed', mode: 'legacy', source: 'server-event', roomId: matchedEvent.roomId,
      invocationId: matchedEvent.invocationId, traceId: query.traceId, status: 'failed', generation: 4,
      terminalProof: { kind: 'matched-server-event-v1', failureCode: matchedEvent.failureCode },
    }
    const client = new HttpChatRoomRustApiClient({ fetchImpl: async () => Response.json(response), getToken: () => 'internal-test' })

    expect(await client.queryInvocationStatus(query)).toMatchObject({
      outcome: 'Confirmed', mode: 'legacy', status: 'failed', generation: 4,
      terminalProof: { kind: 'matched-server-event-v1', failureCode: matchedEvent.failureCode },
    })

    const mismatch = new HttpChatRoomRustApiClient({
      fetchImpl: async () => Response.json({
        ...response, terminalProof: { kind: 'matched-server-event-v1', failureCode: 'agent_busy' },
      }),
      getToken: () => 'internal-test',
    })
    expect((await mismatch.queryInvocationStatus(query)).outcome).toBe('Rejected')
  })

  test('Given legacy terminal proof has a mismatched digest or extra nested field When queried Then reject it', async () => {
    const matchedEvent = {
      roomId: 'room-1', invocationId: 'inv-1', content: 'done', mentionAgentIds: [], attachmentIds: [],
      clientMessageId: 'reply-1',
    }
    const expectedDigest = 'b49e17043a199ab3a220f1746e315d88d6d9dbb0820f5f7c24254dda3c151b37'
    const query = {
      roomId: 'room-1', invocationId: 'inv-1', deviceId: 'device-1', traceId: 'trace-1',
      targetAgentId: 'agent-a', triggerMessageId: 'message-1', depth: 0, expectedStatus: 'completed' as const,
      failureCode: '' as const, clientMessageId: 'reply-1', replyDigest: expectedDigest,
    }
    for (const terminalProof of [
      { kind: 'matched-server-event-v1', replyClientMessageId: 'wrong-client', replyDigest: expectedDigest },
      { kind: 'matched-server-event-v1', replyClientMessageId: matchedEvent.clientMessageId, replyDigest: 'b'.repeat(64) },
      { kind: 'matched-server-event-v1', replyClientMessageId: matchedEvent.clientMessageId, replyDigest: expectedDigest, content: 'must not cross the boundary' },
    ]) {
      const client = new HttpChatRoomRustApiClient({
        fetchImpl: async () => Response.json({
          outcome: 'Confirmed', mode: 'legacy', source: 'server-event', roomId: matchedEvent.roomId, invocationId: matchedEvent.invocationId,
          traceId: query.traceId, status: 'completed', generation: 4, terminalProof,
        }),
        getToken: () => 'internal-test',
      })
      expect((await client.queryInvocationStatus(query)).outcome).toBe('Rejected')
    }
  })

  test('Given legacy terminal proof has a substituted room, trace, generation or top-level field When queried Then reject it', async () => {
    const query = {
      roomId: 'room-1', invocationId: 'inv-1', deviceId: 'device-1', traceId: 'trace-1',
      targetAgentId: 'agent-a', triggerMessageId: 'message-1', depth: 0, expectedStatus: 'completed' as const,
      failureCode: '' as const, clientMessageId: 'reply-1',
      replyDigest: 'b49e17043a199ab3a220f1746e315d88d6d9dbb0820f5f7c24254dda3c151b37',
    }
    const proof = {
      outcome: 'Confirmed', mode: 'legacy', source: 'server-event', roomId: query.roomId,
      invocationId: query.invocationId, traceId: query.traceId, status: 'completed', generation: 4,
      terminalProof: { kind: 'matched-server-event-v1', replyClientMessageId: 'reply-1', replyDigest: query.replyDigest },
    }
    for (const invalid of [
      { ...proof, roomId: 'other-room' },
      { ...proof, traceId: 'other-trace' },
      { ...proof, generation: 0 },
      { ...proof, extra: 'not allowed' },
    ]) {
      const client = new HttpChatRoomRustApiClient({ fetchImpl: async () => Response.json(invalid), getToken: () => 'internal-test' })
      expect((await client.queryInvocationStatus(query)).outcome).toBe('Rejected')
    }
  })

  test('Given status proof has the wrong digest, trace or unexpected fields When queried Then return Rejected; status 404 is Unknown', async () => {
    const query = {
      roomId: 'room-1', invocationId: 'inv-1', deviceId: 'device-1', traceId: 'trace-1',
      targetAgentId: 'agent-a', triggerMessageId: 'message-1', depth: 0, expectedStatus: 'completed' as const,
      failureCode: '' as const, clientMessageId: 'message-1', replyDigest: 'a'.repeat(64),
    }
    const proof = {
      outcome: 'Confirmed', roomId: 'room-1', invocationId: 'inv-1', traceId: 'trace-1', generation: 4,
      status: 'completed', finishedAt: '2026-09-28T10:00:00Z', replyMessageId: 'reply-msg-1',
      replyClientMessageId: 'message-1', replyDigest: 'a'.repeat(64),
    }
    for (const invalid of [
      { ...proof, replyDigest: 'b'.repeat(64) },
      { ...proof, traceId: 'other-trace' },
      { ...proof, unexpectedBody: 'must not be trusted' },
    ]) {
      const client = new HttpChatRoomRustApiClient({ fetchImpl: async () => Response.json(invalid), getToken: () => 'internal-test' })
      expect((await client.queryInvocationStatus(query)).outcome).toBe('Rejected')
    }
    const missingRoute = new HttpChatRoomRustApiClient({ fetchImpl: async () => new Response('missing', { status: 404 }), getToken: () => 'internal-test' })
    expect((await missingRoute.queryInvocationStatus(query)).outcome).toBe('Unknown')
    const denied = new HttpChatRoomRustApiClient({ fetchImpl: async () => new Response(null, { status: 403 }), getToken: () => 'internal-test' })
    const authDenied = new HttpChatRoomRustApiClient({ fetchImpl: async () => Response.json({ code: 'lifecycle_unknown' }, { status: 401 }), getToken: () => 'internal-test' })
    const conflict = new HttpChatRoomRustApiClient({ fetchImpl: async () => Response.json({ code: 'lifecycle_unknown' }, { status: 409 }), getToken: () => 'internal-test' })
    const misleadingForbidden = new HttpChatRoomRustApiClient({ fetchImpl: async () => Response.json({ code: 'lifecycle_unknown' }, { status: 403 }), getToken: () => 'internal-test' })
    const unavailable = new HttpChatRoomRustApiClient({ fetchImpl: async () => new Response(null, { status: 503 }), getToken: () => 'internal-test' })
    expect((await denied.queryInvocationStatus(query)).outcome).toBe('Rejected')
    expect((await authDenied.queryInvocationStatus(query)).outcome).toBe('Rejected')
    expect((await misleadingForbidden.queryInvocationStatus(query)).outcome).toBe('Rejected')
    expect((await conflict.queryInvocationStatus(query)).outcome).toBe('Rejected')
    expect((await unavailable.queryInvocationStatus(query)).outcome).toBe('Unknown')
    const missingToken = new HttpChatRoomRustApiClient({ fetchImpl: async () => Response.json(proof), getToken: () => '' })
    await expect(missingToken.queryInvocationStatus(query)).rejects.toMatchObject({ outcome: 'Unknown', code: 'internal_token_unavailable' })
    const invalidDevice = new HttpChatRoomRustApiClient({ fetchImpl: async () => Response.json(proof), getToken: () => 'internal-test' })
    await expect(invalidDevice.queryInvocationStatus({ ...query, deviceId: '' })).rejects.toThrow('聊天室状态查询上下文不可用')
    const fakeLegacyGeneration = new HttpChatRoomRustApiClient({
      fetchImpl: async () => Response.json({ outcome: 'Confirmed', mode: 'legacy', source: 'server-event', roomId: 'room-1', invocationId: 'inv-1', traceId: 'trace-1', status: 'completed', generation: 0 }),
      getToken: () => 'internal-test',
    })
    expect((await fakeLegacyGeneration.queryInvocationStatus(query)).outcome).toBe('Rejected')
  })

  test('Given 五个状态回传 When 请求 Rust Then 只访问 loopback 冻结路径并携带 internal token', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests)

    await client.reportAccepted({ invocationId: 'inv-1' })
    await client.reportRunning({ invocationId: 'inv-1' })
    await client.reportDelta({ invocationId: 'inv-1', delta: '你好' })
    await client.reportCompleted({
      invocationId: 'inv-1',
      output: { text: '完成', mentionedAgentIds: [], attachmentIds: [] },
    })
    await client.reportFailed({ invocationId: 'inv-1', code: 'internal_error', message: '失败' })

    expect(requests.map((request) => String(request.input))).toEqual([
      'http://127.0.0.1:51730/api/internal/chatrooms/invocations/inv-1/accepted',
      'http://127.0.0.1:51730/api/internal/chatrooms/invocations/inv-1/running',
      'http://127.0.0.1:51730/api/internal/chatrooms/invocations/inv-1/delta',
      'http://127.0.0.1:51730/api/internal/chatrooms/invocations/inv-1/completed',
      'http://127.0.0.1:51730/api/internal/chatrooms/invocations/inv-1/failed',
    ])
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      roomId: 'room-1', invocationId: 'inv-1', agentId: 'agent-a', deviceId: 'device-1',
    })
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      roomId: 'room-1', invocationId: 'inv-1',
    })
    expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({
      roomId: 'room-1', invocationId: 'inv-1', delta: '你好',
    })
    expect(JSON.parse(String(requests[3]?.init?.body))).toEqual({
      roomId: 'room-1', invocationId: 'inv-1', content: '完成',
      mentionAgentIds: [], attachmentIds: [], clientMessageId: 'message-1',
    })
    expect(JSON.parse(String(requests[4]?.init?.body))).toEqual({
      roomId: 'room-1', invocationId: 'inv-1', failureCode: 'internal_error', message: '失败',
    })
    for (const request of requests) {
      expect(request.init?.method).toBe('POST')
      expect(request.init?.headers).toEqual(expect.objectContaining({
        Accept: 'application/json',
        'X-Copis-Internal-Token': 'internal-test',
        'Content-Type': 'application/json',
      }))
      const serialized = JSON.stringify(request.init?.body ?? '')
      expect(serialized).not.toContain('working-jwt')
      expect(serialized).not.toContain('public-token')
    }
  })

  test('Given invocationId 不符合路径组件 When 回传 Then 在 fetch 前拒绝', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests)

    await expect(client.reportRunning({ invocationId: 'inv/escape' })).rejects.toThrow('invocationId 参数不正确')
    await expect(client.reportFailed({ invocationId: '', code: 'internal_error', message: 'x' })).rejects.toThrow('invocationId 参数不正确')
    expect(requests).toHaveLength(0)
  })

  test('Given delta UTF-8 恰好 16 KiB When 回传 Then 接受；超出一个字节时在 fetch 前拒绝', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests)
    const exactlyAtLimit = `${'你'.repeat(5461)}a`
    expect(Buffer.byteLength(exactlyAtLimit, 'utf8')).toBe(16 * 1024)

    await client.reportDelta({ invocationId: 'inv-1', delta: exactlyAtLimit })
    await expect(client.reportDelta({ invocationId: 'inv-1', delta: `${exactlyAtLimit}b` })).rejects.toThrow('delta 参数过大')
    expect(requests).toHaveLength(1)
  })

  test('Given delta 含 Rust 禁止控制字符 When 回传 Then 在 fetch 前拒绝且允许换行制表符', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests)

    await expect(client.reportDelta({ invocationId: 'inv-1', delta: '有效\u0001内容' }))
      .rejects.toThrow('delta 参数不正确')
    await client.reportDelta({ invocationId: 'inv-1', delta: '第一行\n\t第二行\r' })
    expect(requests).toHaveLength(1)
  })

  test('Given internal token 为空或全空白 When 请求 Rust Then 在 fetch 前拒绝', async () => {
    const requests: RecordedRequest[] = []
    const empty = createClient(requests, { token: '' })
    const blank = createClient(requests, { token: ' \t\n' })

    await expect(empty.reportAccepted({ invocationId: 'inv-1' })).rejects.toThrow('Rust HTTP API 尚未启动')
    await expect(blank.reportAccepted({ invocationId: 'inv-1' })).rejects.toThrow('Rust HTTP API 尚未启动')
    expect(requests).toHaveLength(0)
  })

  test('Given resolver 缺失、抛错或返回非法 context When 回传 Then 在 fetch 前 fail closed', async () => {
    const requests: RecordedRequest[] = []
    const missing = new HttpChatRoomRustApiClient({
      fetchImpl: async (input, init) => {
        requests.push({ input, init })
        return responseForLifecycleRequest(input, init)
      },
      getToken: () => 'internal-test',
    })
    const throwing = createClient(requests, { getInvocationContext: () => { throw new Error('token=secret /Users/private') } })
    const invalid = createClient(requests, { getInvocationContext: () => ({ ...context, roomId: '../escape' }) })

    await expect(missing.reportAccepted({ invocationId: 'inv-1' })).rejects.toThrow('聊天室回传上下文不可用')
    await expect(throwing.reportRunning({ invocationId: 'inv-1' })).rejects.toThrow('聊天室回传上下文不可用')
    await expect(invalid.reportFailed({ invocationId: 'inv-1', code: 'internal_error', message: '失败' })).rejects.toThrow('聊天室回传上下文不可用')
    expect(requests).toHaveLength(0)
  })

  test('Given JS caller 伪造 room/device 字段 When 回传 Then 只能使用 resolver context 且 body 不含额外字段', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests)
    await client.reportAccepted({
      invocationId: 'inv-1',
      roomId: 'attacker-room',
      agentId: 'attacker-agent',
      deviceId: 'attacker-device',
    } as never)

    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      roomId: 'room-1', invocationId: 'inv-1', agentId: 'agent-a', deviceId: 'device-1',
    })
  })

  test('Given 非 loopback baseUrl When 创建客户端 Then 立即拒绝外部或 localhost 地址', () => {
    expect(() => new HttpChatRoomRustApiClient({ baseUrl: 'http://localhost:51730' })).toThrow('Rust HTTP API 必须使用 loopback 地址')
    expect(() => new HttpChatRoomRustApiClient({ baseUrl: 'https://evil.example.test:51730' })).toThrow('Rust HTTP API 必须使用 loopback 地址')
    expect(() => new HttpChatRoomRustApiClient({ baseUrl: 'http://127.0.0.1:51730/internal' })).toThrow('Rust HTTP API 必须使用 loopback 地址')
  })

  test('Given Main 提供 invocation 上下文 When 完成回传 Then 严格映射 Rust 所需字段', async () => {
    const requests: RecordedRequest[] = []
    const client = new HttpChatRoomRustApiClient({
      fetchImpl: async (input, init) => {
        requests.push({ input, init })
        return responseForLifecycleRequest(input, init)
      },
      getToken: () => 'internal-test',
      getInvocationContext: () => context,
    })

    await client.reportAccepted({ invocationId: 'inv-1' })
    await client.reportCompleted({ invocationId: 'inv-1', output: { text: '完成', mentionedAgentIds: ['agent-b'], attachmentIds: [] } })

    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      invocationId: 'inv-1', roomId: 'room-1', agentId: 'agent-a', deviceId: 'device-1',
    })
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      invocationId: 'inv-1', roomId: 'room-1',
      content: '完成', mentionAgentIds: ['agent-b'], attachmentIds: [], clientMessageId: 'message-1',
    })
  })

  test('Given Rust protocol 各字段达到边界 When 回传 Then 64 字节 ID 接受而超限在 fetch 前拒绝', async () => {
    const requests: RecordedRequest[] = []
    const id64 = 'a'.repeat(64)
    const id65 = 'a'.repeat(65)
    const device128 = 'd'.repeat(128)
    const clientMessage128 = 'm'.repeat(128)
    const boundaryContext = {
      roomId: id64,
      agentId: id64,
      deviceId: device128,
      clientMessageId: clientMessage128,
      traceId: id64,
      targetAgentId: id64,
      triggerMessageId: clientMessage128,
      depth: 0,
    }
    const client = createClient(requests, { getInvocationContext: () => boundaryContext })

    await client.reportAccepted({ invocationId: id64 })
    await client.reportCompleted({
      invocationId: id64,
      output: { text: '完成', mentionedAgentIds: [], attachmentIds: [id64] },
    })
    expect(requests).toHaveLength(2)

    const cases: Array<[
      string,
      () => Promise<unknown>,
    ]> = [
      ['roomId', () => new HttpChatRoomRustApiClient({
        fetchImpl: async (input, init) => {
          requests.push({ input, init })
          return responseForLifecycleRequest(input, init)
        },
        getToken: () => 'internal-test',
        getInvocationContext: () => ({ ...boundaryContext, roomId: id65 }),
      }).reportAccepted({ invocationId: 'inv-1' })],
      ['agentId', () => new HttpChatRoomRustApiClient({
        fetchImpl: async (input, init) => {
          requests.push({ input, init })
          return responseForLifecycleRequest(input, init)
        },
        getToken: () => 'internal-test',
        getInvocationContext: () => ({ ...boundaryContext, agentId: id65 }),
      }).reportAccepted({ invocationId: 'inv-1' })],
      ['deviceId', () => new HttpChatRoomRustApiClient({
        fetchImpl: async (input, init) => {
          requests.push({ input, init })
          return responseForLifecycleRequest(input, init)
        },
        getToken: () => 'internal-test',
        getInvocationContext: () => ({ ...boundaryContext, deviceId: `${device128}d` }),
      }).reportAccepted({ invocationId: 'inv-1' })],
      ['clientMessageId', () => new HttpChatRoomRustApiClient({
        fetchImpl: async (input, init) => {
          requests.push({ input, init })
          return responseForLifecycleRequest(input, init)
        },
        getToken: () => 'internal-test',
        getInvocationContext: () => ({ ...boundaryContext, clientMessageId: `${clientMessage128}m` }),
      }).reportCompleted({
        invocationId: 'inv-1',
        output: { text: '完成', mentionedAgentIds: [], attachmentIds: [] },
      })],
      ['invocationId', () => client.reportRunning({ invocationId: id65 })],
    ]
    for (const [field, attempt] of cases) {
      await expect(attempt()).rejects.toThrow(field === 'invocationId' ? 'invocationId 参数不正确' : '聊天室回传上下文不可用')
    }
    expect(requests).toHaveLength(2)
  })

  test('Given output ID 是多字节 UTF-8 When 达到 protocol 64 字节边界 Then 接受而 65 字节拒绝', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests)
    const id64Bytes = `${'你'.repeat(21)}a`
    const id65Bytes = `${id64Bytes}b`
    expect(Buffer.byteLength(id64Bytes, 'utf8')).toBe(64)
    expect(Buffer.byteLength(id65Bytes, 'utf8')).toBe(65)

    await client.reportCompleted({
      invocationId: 'inv-1',
      output: { text: '完成', mentionedAgentIds: [id64Bytes], attachmentIds: [] },
    })
    await expect(client.reportCompleted({
      invocationId: 'inv-1',
      output: { text: '完成', mentionedAgentIds: [id65Bytes], attachmentIds: [] },
    })).rejects.toThrow('聊天室输出参数不正确')
    await expect(client.reportCompleted({
      invocationId: 'inv-1',
      output: { text: '完成', mentionedAgentIds: [], attachmentIds: [id65Bytes] },
    })).rejects.toThrow('聊天室输出参数不正确')
    expect(requests).toHaveLength(1)
  })

  test('Given completed output 含未知字段或非法 mention/attachment ID When 回传 Then 在 fetch 前拒绝', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests)
    const validOutput = { text: '完成', mentionedAgentIds: [], attachmentIds: [] }

    await expect(client.reportCompleted({
      invocationId: 'inv-1',
      output: { ...validOutput, token: 'forged' } as never,
    })).rejects.toThrow('聊天室输出参数不正确')
    await expect(client.reportCompleted({
      invocationId: 'inv-1',
      output: { ...validOutput, mentionedAgentIds: ['agent/id'] },
    })).rejects.toThrow('聊天室输出参数不正确')
    await expect(client.reportCompleted({
      invocationId: 'inv-1',
      output: { ...validOutput, attachmentIds: ['attachment id'] },
    })).rejects.toThrow('聊天室输出参数不正确')
    expect(requests).toHaveLength(0)
  })

  test('Given completed output has repeated IDs When sending Then the stable reply body removes duplicates in first-seen order', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests)
    await client.reportCompleted({
      invocationId: 'inv-1',
      output: { text: '完成', mentionedAgentIds: ['agent-b', 'agent-b', 'agent-c'], attachmentIds: ['file-a', 'file-a'] },
    })
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      roomId: 'room-1', invocationId: 'inv-1', content: '完成',
      mentionAgentIds: ['agent-b', 'agent-c'], attachmentIds: ['file-a'], clientMessageId: 'message-1',
    })
  })

  test('Given completed text 在 Rust 64 KiB 边界 When 回传 Then 精确边界接受且超出一个字节前拒绝', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests)
    const asciiAtLimit = 'a'.repeat(64 * 1024)
    const unicodeAtLimit = `${'你'.repeat(21845)}a`
    expect(Buffer.byteLength(unicodeAtLimit, 'utf8')).toBe(64 * 1024)

    await client.reportCompleted({
      invocationId: 'inv-1',
      output: { text: asciiAtLimit, mentionedAgentIds: [], attachmentIds: [] },
    })
    await client.reportCompleted({
      invocationId: 'inv-1',
      output: { text: unicodeAtLimit, mentionedAgentIds: [], attachmentIds: [] },
    })
    await expect(client.reportCompleted({
      invocationId: 'inv-1',
      output: { text: `${asciiAtLimit}b`, mentionedAgentIds: [], attachmentIds: [] },
    })).rejects.toThrow('聊天室文本参数不正确')
    await expect(client.reportCompleted({
      invocationId: 'inv-1',
      output: { text: `${unicodeAtLimit}b`, mentionedAgentIds: [], attachmentIds: [] },
    })).rejects.toThrow('聊天室文本参数不正确')
    expect(requests).toHaveLength(2)
  })

  test('Given completed text 为空或包含 Rust 禁止控制字符 When 回传 Then 在 fetch 前拒绝', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests)

    await expect(client.reportCompleted({
      invocationId: 'inv-1',
      output: { text: ' \n\t ', mentionedAgentIds: [], attachmentIds: [] },
    })).rejects.toThrow('聊天室文本参数不正确')
    await expect(client.reportCompleted({
      invocationId: 'inv-1',
      output: { text: '有效\u0001文本', mentionedAgentIds: [], attachmentIds: [] },
    })).rejects.toThrow('聊天室文本参数不正确')
    expect(requests).toHaveLength(0)
  })

  test('Given failed report 使用未知 failureCode 或非法 message When 回传 Then 在 fetch 前拒绝', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests)
    const exactlyAtLimit = 'a'.repeat(64 * 1024)
    const unicodeAtLimit = `${'你'.repeat(21845)}a`
    expect(Buffer.byteLength(unicodeAtLimit, 'utf8')).toBe(64 * 1024)

    await expect(client.reportFailed({ invocationId: 'inv-1', code: 'not_a_failure_code' as never, message: '失败' }))
      .rejects.toThrow('failureCode 参数不正确')
    await expect(client.reportFailed({ invocationId: 'inv-1', code: 'internal_error', message: ' \n\t ' }))
      .rejects.toThrow('聊天室文本参数不正确')
    await expect(client.reportFailed({ invocationId: 'inv-1', code: 'internal_error', message: '失败\u0001原因' }))
      .rejects.toThrow('聊天室文本参数不正确')
    await client.reportFailed({ invocationId: 'inv-1', code: 'internal_error', message: exactlyAtLimit })
    await client.reportFailed({ invocationId: 'inv-1', code: 'internal_error', message: unicodeAtLimit })
    await expect(client.reportFailed({ invocationId: 'inv-1', code: 'internal_error', message: `${exactlyAtLimit}b` }))
      .rejects.toThrow('聊天室文本参数不正确')
    await expect(client.reportFailed({ invocationId: 'inv-1', code: 'internal_error', message: `${unicodeAtLimit}b` }))
      .rejects.toThrow('聊天室文本参数不正确')
    expect(requests).toHaveLength(2)
  })

  test('Given Rust 返回超大敏感错误 When 请求失败 Then 只读取有限内容并先脱敏再抛出', async () => {
    const secret = 'internal-test-secret'
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`token=${secret}&path=/Users/private/secret.txt ${'x'.repeat(20_000)}`))
        controller.close()
      },
    })
    const requests: RecordedRequest[] = []
    const client = createClient(requests, {
      token: secret,
      response: new Response(stream, { status: 500 }),
    })

    let error: unknown
    try {
      await client.reportAccepted({ invocationId: 'inv-1' })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain(secret)
    expect((error as Error).message).not.toContain('/Users/private/secret.txt')
    expect((error as Error).message.length).toBeLessThan(700)
    if (!(error instanceof Error)) {
      throw new Error('预期客户端抛出 Error')
    }
  })

  test('Given 错误响应 UTF-8 字符被拆成多块 When 请求失败 Then 有界读取仍保留完整字符', async () => {
    const encoded = new TextEncoder().encode('错误：请重试')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of encoded) controller.enqueue(new Uint8Array([byte]))
        controller.close()
      },
    })
    const client = createClient([], { response: new Response(stream, { status: 500 }) })

    await expect(client.reportAccepted({ invocationId: 'inv-1' })).rejects.toThrow('错误：请重试')
  })

  test('Given authenticated lease pairs When release is requested Then Rust receives the bounded internal DTO', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests)

    await client.releaseAgentLeases({
      roomAgentIds: ['agent-a'],
      reason: 'app_quit',
      deviceId: 'device-1',
      leases: [{ roomId: 'room-1', roomAgentId: 'agent-a' }],
    })

    expect(String(requests[0]?.input)).toBe('http://127.0.0.1:51730/api/internal/chatrooms/agents/leases/release')
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      deviceId: 'device-1',
      leases: [{ roomId: 'room-1', roomAgentId: 'agent-a' }],
    })
  })

  test('Given Main accepted a current socket invocation When binding execution owner Then send exact private origin and run identity to token-gated Rust route', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests)
    const input = {
      invocation: {
        invocationId: 'inv-binding', roomId: 'room-1', traceId: 'trace-binding', targetAgentId: 'agent-a',
        triggerMessageId: 'message-binding', depth: 0,
        sender: { type: 'user' as const, id: 'user-1', displayName: '主理人' },
        messages: [{ messageId: 'message-binding', sender: { type: 'user' as const, id: 'user-1', displayName: '主理人' }, text: 'execute', createdAt: 1 }],
        receivedAt: 2,
      },
      targetAgentId: 'agent-a', sessionId: 'session-binding', workerRunId: 'run-binding',
      gatewayOrigin: { clientGeneration: 7, socketGeneration: 11, authEpoch: 0 },
    }
    expect(await client.bindExecution(input)).toBe(true)
    expect(requests).toHaveLength(1)
    expect(new URL(String(requests[0]?.input)).pathname).toBe('/api/internal/chatrooms/execution-bindings/bind')
    expect(requests[0]?.init?.headers).toMatchObject({ 'X-Copis-Internal-Token': 'internal-test' })
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      roomId: 'room-1', invocationId: 'inv-binding', targetAgentId: 'agent-a',
      sessionId: 'session-binding', workerRunId: 'run-binding',
      origin: { clientGeneration: 7, socketGeneration: 11, authEpoch: 0 },
    })
  })

  test('Given invalid run owner or gateway origin When binding execution owner Then fail closed without fetch', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests)
    const input = {
      invocation: {
        invocationId: 'inv-binding', roomId: 'room-1', traceId: 'trace-binding', targetAgentId: 'agent-a',
        triggerMessageId: 'message-binding', depth: 0,
        sender: { type: 'user' as const, id: 'user-1', displayName: '主理人' },
        messages: [{ messageId: 'message-binding', sender: { type: 'user' as const, id: 'user-1', displayName: '主理人' }, text: 'execute', createdAt: 1 }],
        receivedAt: 2,
      },
      targetAgentId: 'agent-a', sessionId: 'session-binding', workerRunId: 'run-binding',
      gatewayOrigin: { clientGeneration: 7, socketGeneration: 11, authEpoch: 0 },
    }
    expect(await client.bindExecution({ ...input, workerRunId: '../run-b' })).toBe(false)
    expect(await client.bindExecution({ ...input, gatewayOrigin: { ...input.gatewayOrigin, socketGeneration: 0 } })).toBe(false)
    expect(requests).toHaveLength(0)
  })

  test('Given incomplete lease context When release is requested Then it fails closed before fetch', async () => {
    const requests: RecordedRequest[] = []
    const client = createClient(requests)
    await expect(client.releaseAgentLeases({
      roomAgentIds: ['agent-a'], reason: 'logout', deviceId: 'device-1', leases: [],
    })).rejects.toThrow('lease 上下文不可用')
    expect(requests).toHaveLength(0)
  })
})
