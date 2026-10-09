import { afterAll, afterEach, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixtureRoot = mkdtempSync(join(tmpdir(), 'copis-chatroom-management-journal-'))
mkdirSync(join(fixtureRoot, 'rooms'), { recursive: true })
mock.module('./config-paths', () => ({
  getChatRoomsRootPath: () => join(fixtureRoot, 'rooms'),
}))
const { ChatRoomManagementJournal } = await import('./chatroom-management-journal')

const identity = { hostUserId: '7', deviceId: '123e4567-e89b-42d3-a456-426614174000' }
const input = { roomId: 'room-1', sourceWorkspaceId: 'workspace-1', displayName: 'Grok', channelId: 'channel-1', modelId: 'model-1' }

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }))
afterEach(() => {
  for (const suffix of ['', '.tmp', '.bak']) rmSync(join(fixtureRoot, 'rooms', `chatroom-management-operations.json${suffix}`), { force: true })
})

test('Given a prepared registration When the journal is reopened Then it restores the same operation and configuration', () => {
  const first = new ChatRoomManagementJournal(() => 10)
  const operation = first.prepareRegistration(identity, input)
  first.updateRegistration(identity, operation.operationId, { phase: 'remote_created', mode: 'v1', roomAgentId: 'agent-1' })

  const reopened = new ChatRoomManagementJournal(() => 20)
  expect(reopened.list(identity)).toEqual([{ ...operation, phase: 'remote_created', mode: 'v1', roomAgentId: 'agent-1', updatedAt: 10, revision: 1 }])
})

test('Given an unresolved registration When retried with the same name and payload Then reuse its operation ID without adding another record', () => {
  const journal = new ChatRoomManagementJournal(() => 30)
  const first = journal.prepareRegistration(identity, { ...input, roomId: 'room-retry' })
  const retry = journal.prepareRegistration(identity, { ...input, roomId: 'room-retry' })
  expect(retry.operationId).toBe(first.operationId)
  expect(journal.list(identity).filter((item) => item.roomId === 'room-retry')).toHaveLength(1)
})

test('Given an unresolved operation for a display name When another payload tries to claim that name Then reject without creating a second operation', () => {
  const journal = new ChatRoomManagementJournal()
  journal.prepareRegistration(identity, { ...input, roomId: 'room-conflict' })
  expect(() => journal.prepareRegistration(identity, { ...input, roomId: 'room-conflict', modelId: 'model-2' })).toThrow('management_operation_pending')
})

test('Given operations belong to another identity When a different device lists or updates Then it cannot observe or mutate them', () => {
  const journal = new ChatRoomManagementJournal()
  const operation = journal.prepareRegistration(identity, { ...input, roomId: 'room-owner' })
  const otherIdentity = { ...identity, deviceId: '223e4567-e89b-42d3-a456-426614174000' }
  expect(journal.list(otherIdentity)).toEqual([])
  expect(() => journal.updateRegistration(otherIdentity, operation.operationId, { phase: 'unknown' })).toThrow('management_operation_owner_mismatch')
  expect(journal.list(identity)).toHaveLength(1)
})

test('Given the bounded journal is full When another unresolved operation is prepared Then preserve prior records and refuse the write', () => {
  const journal = new ChatRoomManagementJournal()
  for (let index = 0; index < 32; index++) {
    journal.prepareRegistration(identity, { ...input, roomId: `room-${index}`, displayName: `Agent ${index}` })
  }
  expect(() => journal.prepareRegistration(identity, { ...input, roomId: 'room-overflow', displayName: 'overflow' })).toThrow('management_journal_full')
  expect(journal.list(identity)).toHaveLength(32)
})

test('Given a room already exists When a registration operation is created Then bind the immutable room creation identity', () => {
  const room = { roomId: 'room-existing', hostUserId: identity.hostUserId, deviceId: identity.deviceId, createdAt: 100 }
  const journal = new ChatRoomManagementJournal(() => 10)
  const operation = (journal.prepareRegistration as any)(identity, { ...input, roomId: room.roomId }, room)
  expect(operation).toMatchObject({ roomCreatedAt: 100, roomWasMissing: false })
  expect(() => (new ChatRoomManagementJournal() .prepareRegistration as any)(identity, { ...input, roomId: room.roomId }, { ...room, createdAt: 101 })).toThrow('management_operation_room_identity_mismatch')
})

test('Given the operation starts before local room creation When the same operation resumes with its planned createdAt Then accept only that partially persisted room', () => {
  const journal = new ChatRoomManagementJournal(() => 50)
  const missing = (journal.prepareRegistration as any)(identity, { ...input, roomId: 'room-new' }, undefined)
  expect(missing).toMatchObject({ roomWasMissing: true, roomCreatedAt: 50 })

  const materialized = { roomId: 'room-new', hostUserId: identity.hostUserId, deviceId: identity.deviceId, createdAt: missing.roomCreatedAt }
  const reopened = new ChatRoomManagementJournal(() => 60)
  expect((reopened.prepareRegistration as any)(identity, { ...input, roomId: 'room-new' }, materialized).operationId).toBe(missing.operationId)
  expect(() => (reopened.prepareRegistration as any)(identity, { ...input, roomId: 'room-new' }, { ...materialized, createdAt: 51 })).toThrow('management_operation_room_identity_mismatch')
})

test('Given a written journal When inspecting its mode and presenting corrupt bytes Then preserve private permissions and fail closed', () => {
  const path = join(fixtureRoot, 'rooms', 'chatroom-management-operations.json')
  const journal = new ChatRoomManagementJournal(() => 70)
  journal.prepareRegistration(identity, { ...input, roomId: 'room-private' })
  expect(statSync(path).mode & 0o777).toBe(0o600)

  writeFileSync(path, '{corrupt', 'utf8')
  expect(() => journal.list(identity)).toThrow('management_journal_unrecoverable')
  expect(readFileSync(path, 'utf8')).toBe('{corrupt')
})

test('Given a prepared operation When an impossible journal phase transition is requested Then leave the persisted phase unchanged', () => {
  const journal = new ChatRoomManagementJournal(() => 80)
  const operation = journal.prepareRegistration(identity, { ...input, roomId: 'room-phase' })
  expect(() => journal.updateRegistration(identity, operation.operationId, { phase: 'compensation_pending' })).toThrow('management_operation_transition_invalid')
  expect(journal.getRegistration(identity, operation.operationId)?.phase).toBe('prepared')
})

test('Given a v2 registration and pending removal When journal is reopened Then preserve both exact operation identities and isolate the target agent', () => {
  const journal = new ChatRoomManagementJournal(() => 90)
  const registration = journal.prepareRegistration(identity, { ...input, roomId: 'room-shared' }, {
    roomId: 'room-shared', hostUserId: identity.hostUserId, deviceId: identity.deviceId, createdAt: 100,
  })
  const removal = (journal as any).prepareRemoval(identity, {
    roomId: 'room-shared', hostUserId: identity.hostUserId, deviceId: identity.deviceId, createdAt: 100,
  }, { ...input, displayName: 'Grok', roomAgentId: 'agent-target' })

  const reopened = new ChatRoomManagementJournal(() => 91)
  expect(reopened.list(identity)).toHaveLength(2)
  expect((reopened as any).getOperation(identity, removal.operationId)).toMatchObject({
    action: 'remove', operationId: removal.operationId, roomCreatedAt: 100, roomAgentId: 'agent-target', phase: 'prepared',
  })
  expect((reopened as any).hasPendingForAgent(identity, 'room-shared', 'agent-target')).toBe(true)
  expect((reopened as any).hasPendingForAgent(identity, 'room-shared', 'agent-other')).toBe(false)
  expect(reopened.getRegistration(identity, registration.operationId)?.operationId).toBe(registration.operationId)
})

test('Given pending sharing update When the same desired booleans resume Then reuse its operation and keep secrets out of the journal command', () => {
  const journal = new ChatRoomManagementJournal(() => 110)
  const room = { roomId: 'room-sharing', hostUserId: identity.hostUserId, deviceId: identity.deviceId, createdAt: 111 }
  const agent = { ...input, roomAgentId: 'agent-sharing', sourceWorkspaceId: 'workspace-secret', channelId: 'channel-secret' }
  const first = (journal as any).prepareSharingUpdate(identity, room, agent, { memoryShared: true, skillsShared: false })
  const retry = (journal as any).prepareSharingUpdate(identity, room, agent, { memoryShared: true, skillsShared: false })
  expect(retry.operationId).toBe(first.operationId)
  expect(first).toMatchObject({ action: 'update-sharing', sharing: { memoryShared: true, skillsShared: false }, roomAgentId: 'agent-sharing' })
  expect(journal.list(identity)).toHaveLength(1)
})

test('Given one remove operation When it is updated repeatedly Then its monotonic revision survives journal reopen', () => {
  const journal = new ChatRoomManagementJournal(() => 120)
  const room = { roomId: 'room-revision', hostUserId: identity.hostUserId, deviceId: identity.deviceId, createdAt: 121 }
  const agent = { roomAgentId: 'agent-revision', displayName: 'Grok', sourceWorkspaceId: 'workspace-1', sessionId: 'session-1',
    channelId: 'channel-1', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false }
  const operation = journal.prepareRemoval(identity, room, agent)
  expect(operation.revision).toBe(0)
  const first = journal.updateOperation(identity, operation.operationId, { mode: 'v1', phase: 'submitting' }, 'remove', 0)
  expect(first.revision).toBe(1)
  const second = journal.updateOperation(identity, operation.operationId, { phase: 'submitting' }, 'remove', 1)
  expect(second.revision).toBe(2)
  expect(() => journal.updateOperation(identity, operation.operationId, { phase: 'unknown' }, 'remove', 1)).toThrow('management_operation_revision_changed')
  expect(new ChatRoomManagementJournal().getOperation(identity, operation.operationId)?.revision).toBe(2)
})

test('Given a legacy journal contains unresolved operations When new identity fields are required Then preserve it and fail closed', () => {
  const path = join(fixtureRoot, 'rooms', 'chatroom-management-operations.json')
  const legacyBytes = JSON.stringify({ version: 1, records: [{ operationId: 'old-unresolved-operation' }] })
  writeFileSync(path, legacyBytes, 'utf8')
  expect(() => new ChatRoomManagementJournal().list(identity)).toThrow('management_journal_legacy_unrecoverable')
  expect(readFileSync(path, 'utf8')).toBe(legacyBytes)
})
