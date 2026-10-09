import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CHATROOM_MAX_DEPTH, type ChatRoomLocalIdentity } from '@copis/shared'
import type { ChatRoomGatewayOrigin } from './chatroom-execution-types'

const fixtureRoot = mkdtempSync(join(tmpdir(), 'copis-chatroom-pre-admission-'))
mock.module('electron', () => ({ app: { isPackaged: false } }))
mock.module('node:os', () => ({ homedir: () => fixtureRoot }))
mock.module('./http-api-server', () => ({
  HTTP_API_HOST: '127.0.0.1',
  HTTP_API_PORT: 51730,
  getHttpApiInternalToken: () => 'fixture-token',
}))

const { ChatRoomWorkspaceStore } = await import('./chatroom-workspace-store')
const { ChatRoomAgentCoordinator } = await import('./chatroom-agent-coordinator')
const { HttpChatRoomRustApiClient } = await import('./chatroom-rust-client')
const { computeChatRoomReplyDigest } = await import('./chatroom-reply-digest')

const identityA: ChatRoomLocalIdentity = { hostUserId: 'account-a', deviceId: 'device-1' }
const identityB: ChatRoomLocalIdentity = { hostUserId: 'account-b', deviceId: 'device-1' }
const gatewayOrigin: ChatRoomGatewayOrigin = { clientGeneration: 1, socketGeneration: 1, authEpoch: 0 }
const now = 1_700_000_000_000

beforeEach(() => rmSync(join(fixtureRoot, '.copis-dev', 'agent-workspaces', 'chatrooms'), { recursive: true, force: true }))
afterEach(() => rmSync(join(fixtureRoot, '.copis-dev', 'agent-workspaces', 'chatrooms'), { recursive: true, force: true }))

function provisionRoom(store: InstanceType<typeof ChatRoomWorkspaceStore>, identity: ChatRoomLocalIdentity, roomId: string, agentId: string) {
  return store.provisionAgent(identity, {
    roomId,
    sourceWorkspaceId: `workspace-${identity.hostUserId}`,
    displayName: `Agent ${agentId}`,
    channelId: 'channel-1',
  }, agentId)
}

function savePending(store: InstanceType<typeof ChatRoomWorkspaceStore>, identity: ChatRoomLocalIdentity, roomId: string, agentId: string, invocationId: string) {
  const output = { text: `reply-${identity.hostUserId}`, attachmentIds: [], mentionedAgentIds: [] }
  const clientMessageId = `message-${identity.hostUserId}`
  return store.savePendingResult({
    hostUserId: identity.hostUserId, deviceId: identity.deviceId, roomId, invocationId,
    traceId: `trace-${identity.hostUserId}`, targetAgentId: agentId, triggerMessageId: clientMessageId,
    depth: 0, clientMessageId, createdAt: now, expectedStatus: 'completed', output,
    replyDigest: computeChatRoomReplyDigest({ ...output, clientMessageId }),
  })
}

async function waitForRequestStarted(requestStarted: Promise<void>, admission: Promise<'accepted' | 'duplicate'>): Promise<void> {
  await Promise.race([
    requestStarted,
    admission.then((result) => {
      throw new Error(`预期 HTTP failure 请求到达前 admission 已返回 ${result}`)
    }),
  ])
}

async function withHeldProof<T>(input: {
  admission: Promise<unknown>
  releaseProof: () => void
  runMutation: () => Promise<T>
}): Promise<T> {
  let mutationFailed = false
  let mutationError: unknown
  try {
    return await input.runMutation()
  } catch (error) {
    mutationFailed = true
    mutationError = error
  } finally {
    input.releaseProof()
    try {
      await input.admission
    } catch (cleanupError) {
      if (!mutationFailed) throw cleanupError
    }
  }
  throw mutationError
}

test('Given 本地 Agent 在 admission 前因 depth 超限拒绝 When 真实 HTTP client 回传 Then created 上下文可验证且只在 failed proof 后落账', async () => {
  const store = new ChatRoomWorkspaceStore({ identity: identityA, now: () => now })
  provisionRoom(store, identityA, 'room-depth', 'agent-depth')
  const requests: Array<{ body: Record<string, unknown> }> = []
  let resolveProof!: (response: Response) => void
  let markRequestStarted!: () => void
  const proof = new Promise<Response>((resolve) => { resolveProof = resolve })
  const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve })
  let currentUserId = identityA.hostUserId
  const client = new HttpChatRoomRustApiClient({
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push({ body })
      markRequestStarted()
      return proof
    },
    getToken: () => 'fixture-token',
    getInvocationContext: (invocationId) => {
      const room = store.listRestorableRooms().find((candidate) => candidate.invocations.some((item) => item.invocationId === invocationId))
      const invocation = room?.invocations.find((item) => item.invocationId === invocationId)
      return room && invocation ? {
        roomId: room.roomId, agentId: invocation.targetAgentId, deviceId: room.deviceId,
        clientMessageId: invocation.triggerMessageId, traceId: invocation.traceId,
        targetAgentId: invocation.targetAgentId, triggerMessageId: invocation.triggerMessageId, depth: invocation.depth,
      } : undefined
    },
  })
  const coordinator = new ChatRoomAgentCoordinator({
    store,
    rustApi: { reportFailed: (input: never, options: never) => client.reportFailed(input, options) },
    getCurrentUserId: async () => currentUserId,
    getDeviceId: () => identityA.deviceId,
    now: () => now,
    reportDiagnostic: () => undefined,
  } as never)

  const admission = coordinator.handleInvocation({
    invocationId: 'inv-depth', roomId: 'room-depth', traceId: 'trace-depth', targetAgentId: 'agent-depth',
    triggerMessageId: 'message-depth', depth: CHATROOM_MAX_DEPTH, receivedAt: now,
    sender: { type: 'user', id: 'user-1', displayName: '用户' }, messages: [],
  }, gatewayOrigin)
  let pendingB: ReturnType<typeof savePending> | undefined
  await withHeldProof({
    admission,
    releaseProof: () => resolveProof(Response.json({
      outcome: 'confirmed', mode: 'invocation-ack-v1', source: 'private-ack', confirmed: true,
      roomId: 'room-depth', invocationId: 'inv-depth', command: 'agent.failed', status: 'failed',
      generation: 1, requestId: 'request-failed-1',
    })),
    runMutation: async () => {
      await waitForRequestStarted(requestStarted, admission)
      const storeB = new ChatRoomWorkspaceStore({ identity: identityB, now: () => now })
      provisionRoom(storeB, identityB, 'account-b-late-proof', 'agent-b-late')
      pendingB = savePending(storeB, identityB, 'account-b-late-proof', 'agent-b-late', 'inv-depth')
    },
  })

  expect(requests).toHaveLength(1)
  expect(requests[0]?.body).toMatchObject({
    roomId: 'room-depth', invocationId: 'inv-depth', failureCode: 'invocation_depth_exceeded',
  })
  expect(store.getInvocation('room-depth', 'inv-depth')).toMatchObject({ status: 'failed', failureCode: 'invocation_depth_exceeded' })
  const storeB = new ChatRoomWorkspaceStore({ identity: identityB, now: () => now })
  expect(storeB.listPendingResults('account-b-late-proof')).toEqual([pendingB!])
  expect(storeB.getInvocation('account-b-late-proof', 'inv-depth')).toBeUndefined()

  await coordinator.handleInvocation({
    invocationId: 'inv-unknown-room', roomId: 'missing-room', traceId: 'trace-unknown-room', targetAgentId: 'agent-depth',
    triggerMessageId: 'message-unknown-room', depth: 0, receivedAt: now,
    sender: { type: 'user', id: 'user-1', displayName: '用户' }, messages: [],
  }, gatewayOrigin)
  await coordinator.handleInvocation({
    invocationId: 'inv-unknown-agent', roomId: 'room-depth', traceId: 'trace-unknown-agent', targetAgentId: 'unknown-agent',
    triggerMessageId: 'message-unknown-agent', depth: 0, receivedAt: now,
    sender: { type: 'user', id: 'user-1', displayName: '用户' }, messages: [],
  }, gatewayOrigin)
  currentUserId = identityB.hostUserId
  await coordinator.handleInvocation({
    invocationId: 'inv-cross-account', roomId: 'room-depth', traceId: 'trace-cross-account', targetAgentId: 'agent-depth',
    triggerMessageId: 'message-cross-account', depth: 0, receivedAt: now,
    sender: { type: 'user', id: 'user-1', displayName: '用户' }, messages: [],
  }, gatewayOrigin)
  expect(requests).toHaveLength(1)
})

test('Given failed HTTP proof 等待期间身份、Agent或created记录变化 When 旧proof迟到 Then 不得把旧invocation写为failed', async () => {
  const mutations = ['account', 'device', 'archive', 'record', 'generation', 'sentinel'] as const
  for (const [index, mutation] of mutations.entries()) {
    const roomId = `late-proof-${mutation}`
    const invocationId = `inv-late-${mutation}`
    const store = new ChatRoomWorkspaceStore({ identity: identityA, now: () => now })
    provisionRoom(store, identityA, roomId, `agent-${mutation}`)
    let currentUserId = identityA.hostUserId
    let currentDeviceId = identityA.deviceId
    let resolveProof!: (response: Response) => void
    let markRequestStarted!: () => void
    let proofReleased = false
    let admissionSettled = false
    let created: ReturnType<typeof store.getInvocation> | undefined
    const proof = new Promise<Response>((resolve) => { resolveProof = resolve })
    const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve })
    let storeB: InstanceType<typeof ChatRoomWorkspaceStore> | undefined
    let pendingB: ReturnType<typeof savePending> | undefined
    const client = new HttpChatRoomRustApiClient({
      fetchImpl: async (_input, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({ roomId, invocationId, failureCode: 'invocation_depth_exceeded' })
        markRequestStarted()
        return proof
      },
      getToken: () => 'fixture-token',
      getInvocationContext: (id) => {
        const room = store.listRestorableRooms().find((candidate) => candidate.invocations.some((item) => item.invocationId === id))
        const invocation = room?.invocations.find((item) => item.invocationId === id)
        return room && invocation ? {
          roomId: room.roomId, agentId: invocation.targetAgentId, deviceId: room.deviceId,
          clientMessageId: invocation.triggerMessageId, traceId: invocation.traceId,
          targetAgentId: invocation.targetAgentId, triggerMessageId: invocation.triggerMessageId, depth: invocation.depth,
        } : undefined
      },
    })
    const coordinator = new ChatRoomAgentCoordinator({
      store,
      rustApi: { reportFailed: (input: never, options: never) => client.reportFailed(input, options), releaseAgentLeases: async () => {} },
      getCurrentUserId: async () => currentUserId,
      getDeviceId: () => currentDeviceId,
      now: () => now + index,
      reportDiagnostic: () => undefined,
    } as never)
    const admission = coordinator.handleInvocation({
      invocationId, roomId, traceId: `trace-${mutation}`, targetAgentId: `agent-${mutation}`,
      triggerMessageId: `message-${mutation}`, depth: CHATROOM_MAX_DEPTH, receivedAt: now,
      sender: { type: 'user', id: 'user-1', displayName: '用户' }, messages: [],
    }, gatewayOrigin)
    void admission.then(
      () => { admissionSettled = true },
      () => { admissionSettled = true },
    )
    const releaseProof = (): void => {
      proofReleased = true
      resolveProof(Response.json({
        outcome: 'confirmed', mode: 'invocation-ack-v1', source: 'private-ack', confirmed: true,
        roomId, invocationId, command: 'agent.failed', status: 'failed', generation: 1, requestId: `request-${mutation}`,
      }))
    }
    const sentinelError = mutation === 'sentinel' ? new Error('sentinel mutation failure') : undefined
    const runMutation = async (): Promise<void> => {
      await waitForRequestStarted(requestStarted, admission)
      if (sentinelError) throw sentinelError
      created = store.getInvocation(roomId, invocationId)!
      if (mutation === 'account') {
        storeB = new ChatRoomWorkspaceStore({ identity: identityB, now: () => now })
        provisionRoom(storeB, identityB, `account-b-${roomId}`, `agent-b-${mutation}`)
        pendingB = savePending(storeB, identityB, `account-b-${roomId}`, `agent-b-${mutation}`, invocationId)
        currentUserId = identityB.hostUserId
      }
      if (mutation === 'device') currentDeviceId = 'device-2'
      if (mutation === 'archive') store.archiveAgent({ roomId, roomAgentId: `agent-${mutation}` })
      if (mutation === 'record') store.upsertInvocation(roomId, { ...created!, updatedAt: created!.updatedAt + 1 })
      if (mutation === 'generation') await coordinator.stopAll('logout')
    }
    if (mutation === 'sentinel') {
      await expect(withHeldProof({ admission, releaseProof, runMutation })).rejects.toBe(sentinelError)
    } else {
      await withHeldProof({ admission, releaseProof, runMutation })
    }
    expect(proofReleased).toBe(true)
    expect(admissionSettled).toBe(true)
    if (mutation === 'sentinel') {
      expect(store.getInvocation(roomId, invocationId)?.status).toBe('failed')
      continue
    }

    expect(store.getInvocation(roomId, invocationId)?.status).toBe('created')
    if (storeB && pendingB) expect(storeB.listPendingResults(`account-b-${roomId}`)).toEqual([pendingB!])
    if (mutation === 'record') expect(store.getInvocation(roomId, invocationId)?.updatedAt).toBe(created!.updatedAt + 1)
    if (mutation === 'archive') expect(store.read(roomId)?.agents[0]?.archivedAt).toBeDefined()
  }
})

test('Given 同一roomId已绑定账号A When 账号B读取/尝试provision Then 不迁移、不覆盖A数据且B无法列出A的room', () => {
  const storeA = new ChatRoomWorkspaceStore({ identity: identityA, now: () => now })
  provisionRoom(storeA, identityA, 'shared-room', 'agent-a')
  const storeB = new ChatRoomWorkspaceStore({ identity: identityB, now: () => now })
  const original = storeA.read('shared-room')

  expect(() => storeB.read('shared-room')).toThrow('identity_mismatch')
  expect(storeB.listRestorableRooms()).toEqual([])
  expect(storeB.list()).toEqual([])
  expect(() => provisionRoom(storeB, identityB, 'shared-room', 'agent-b')).toThrow('identity_mismatch')
  expect(storeA.read('shared-room')).toEqual(original)
})

test('Given 账号A与B分别有独立room When store身份切换 Then 当前身份仅恢复自己的room与pending', () => {
  const storeA = new ChatRoomWorkspaceStore({ identity: identityA, now: () => now })
  const roomA = provisionRoom(storeA, identityA, 'account-a-room', 'agent-a')
  storeA.upsertInvocation(roomA.roomId, {
    invocationId: 'inv-a', roomId: roomA.roomId, traceId: 'trace-a', targetAgentId: 'agent-a',
    triggerMessageId: 'message-a', depth: 0, status: 'created', createdAt: now, updatedAt: now,
  })
  const storeB = new ChatRoomWorkspaceStore({ identity: identityB, now: () => now })
  const roomB = provisionRoom(storeB, identityB, 'account-b-room', 'agent-b')
  const pendingA = savePending(storeA, identityA, roomA.roomId, 'agent-a', 'inv-shared')
  const pendingB = savePending(storeB, identityB, roomB.roomId, 'agent-b', 'inv-shared')

  expect(storeA.listRestorableRooms().map((room) => room.roomId)).toContain('account-a-room')
  expect(storeB.listRestorableRooms().map((room) => room.roomId)).toEqual(['account-b-room'])
  expect(storeB.list().map((room) => room.roomId)).toEqual(['account-b-room'])
  expect(() => storeB.getInvocation('account-a-room', 'inv-a')).toThrow('identity_mismatch')
  expect(storeA.getInvocation('account-a-room', 'inv-a')).toMatchObject({ status: 'created' })
  expect(storeA.listPendingResults('account-a-room')).toEqual([pendingA])
  expect(storeB.listPendingResults('account-b-room')).toEqual([pendingB])

  storeA.upsertInvocation('account-a-room', {
    invocationId: 'inv-a', roomId: 'account-a-room', traceId: 'trace-a', targetAgentId: 'agent-a',
    triggerMessageId: 'message-a', depth: 0, status: 'failed', createdAt: now, updatedAt: now, finishedAt: now,
    failureCode: 'agent_busy', failureMessage: 'Agent 忙碌',
  })
  expect(storeA.removePendingResultIfUnchanged(pendingA)).toBe(true)
  expect(storeB.getInvocation('account-b-room', 'inv-shared')).toBeUndefined()
  expect(storeB.listPendingResults('account-b-room')).toEqual([pendingB])
  expect(roomB.hostUserId).toBe(identityB.hostUserId)
})

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }))
