import { randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import {
  canonicalizeChatRoomAgentDisplayName,
  type ChatRoomAgentLocalConfig,
  type ChatRoomLocalIdentity,
  type ChatRoomLocalRoomConfig,
  type ProvisionChatRoomAgentInput,
} from '@copis/shared'
import { getChatRoomsRootPath } from './config-paths'
import { readJsonFileSafeDetailed, writeJsonFileAtomicDurable } from './safe-file'

export type ChatRoomManagementOperationPhase = 'prepared' | 'submitting' | 'unknown' | 'remote_created' | 'remote_removed' | 'remote_updated' | 'local_saved' | 'legacy_unknown' | 'legacy_cleanup_unknown' | 'compensation_pending'
export type ChatRoomManagementMode = 'v1' | 'legacy'
export type ChatRoomManagementAction = 'register' | 'remove' | 'update-sharing'
export type ChatRoomManagementRoomIdentity = Pick<ChatRoomLocalRoomConfig, 'roomId' | 'hostUserId' | 'deviceId' | 'createdAt'>

export interface ChatRoomManagementOperation {
  /** 旧 v2 注册记录省略 action，读取时按 register 解释，避免升级丢失恢复信息。 */
  action?: ChatRoomManagementAction
  operationId: string
  hostUserId: string
  deviceId: string
  roomId: string
  roomCreatedAt: number
  roomWasMissing: boolean
  input: ProvisionChatRoomAgentInput
  phase: ChatRoomManagementOperationPhase
  mode?: ChatRoomManagementMode
  roomAgentId?: string
  compensationOperationId?: string
  sharing?: { memoryShared: boolean; skillsShared: boolean }
  createdAt: number
  updatedAt: number
  /** 单调递增的本机 CAS 版本；缺省 v2 记录视为 0。 */
  revision?: number
}

interface PersistedOperations {
  version: 2
  records: ChatRoomManagementOperation[]
}

const FILE_NAME = 'chatroom-management-operations.json'
const MAX_RECORDS = 32
const MAX_BYTES = 512 * 1024
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u
const OPERATION_PHASES = new Set<ChatRoomManagementOperationPhase>([
  'prepared', 'submitting', 'unknown', 'remote_created', 'remote_removed', 'remote_updated', 'local_saved', 'legacy_unknown', 'legacy_cleanup_unknown', 'compensation_pending',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key))
}

function sameIdentity(left: ChatRoomLocalIdentity, right: ChatRoomLocalIdentity): boolean {
  return left.hostUserId === right.hostUserId && left.deviceId === right.deviceId
}

function canonicalInput(input: ProvisionChatRoomAgentInput): ProvisionChatRoomAgentInput {
  const displayName = canonicalizeChatRoomAgentDisplayName(input.displayName)
  if (!COMPONENT.test(input.roomId) || !displayName || !input.sourceWorkspaceId.trim() || !input.channelId.trim()
    || (input.modelId !== undefined && !input.modelId.trim())
    || (input.contextMessageCount !== undefined && (!Number.isSafeInteger(input.contextMessageCount) || input.contextMessageCount < 1 || input.contextMessageCount > 100))
    || (input.memorySharingEnabled !== undefined && typeof input.memorySharingEnabled !== 'boolean')
    || (input.skillSharingEnabled !== undefined && typeof input.skillSharingEnabled !== 'boolean')) {
    throw new Error('invalid_management_operation')
  }
  return {
    roomId: input.roomId, sourceWorkspaceId: input.sourceWorkspaceId, displayName, channelId: input.channelId,
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
    ...(input.contextMessageCount === undefined ? {} : { contextMessageCount: input.contextMessageCount }),
    ...(input.memorySharingEnabled === undefined ? {} : { memorySharingEnabled: input.memorySharingEnabled }),
    ...(input.skillSharingEnabled === undefined ? {} : { skillSharingEnabled: input.skillSharingEnabled }),
  }
}

function validateInput(value: unknown, roomId: string): asserts value is ProvisionChatRoomAgentInput {
  if (!isRecord(value) || !exactKeys(value, ['roomId', 'sourceWorkspaceId', 'displayName', 'channelId'], [
    'modelId', 'contextMessageCount', 'memorySharingEnabled', 'skillSharingEnabled',
  ]) || value.roomId !== roomId || typeof value.sourceWorkspaceId !== 'string' || !value.sourceWorkspaceId.trim()
    || typeof value.channelId !== 'string' || !value.channelId.trim()
    || canonicalizeChatRoomAgentDisplayName(value.displayName) !== value.displayName
    || (Object.hasOwn(value, 'modelId') && (typeof value.modelId !== 'string' || !value.modelId.trim()))
    || (Object.hasOwn(value, 'contextMessageCount') && (!Number.isSafeInteger(value.contextMessageCount) || Number(value.contextMessageCount) < 1 || Number(value.contextMessageCount) > 100))
    || (Object.hasOwn(value, 'memorySharingEnabled') && typeof value.memorySharingEnabled !== 'boolean')
    || (Object.hasOwn(value, 'skillSharingEnabled') && typeof value.skillSharingEnabled !== 'boolean')) {
    throw new Error('management_journal_unrecoverable')
  }
}

function validateOperation(value: unknown): asserts value is ChatRoomManagementOperation {
  if (!isRecord(value) || !exactKeys(value, ['operationId', 'hostUserId', 'deviceId', 'roomId', 'roomCreatedAt', 'roomWasMissing', 'input', 'phase', 'createdAt', 'updatedAt'], [
    'action', 'mode', 'roomAgentId', 'compensationOperationId', 'sharing', 'revision',
  ]) || typeof value.operationId !== 'string' || !UUID_V4.test(value.operationId)
    || typeof value.hostUserId !== 'string' || !value.hostUserId.trim()
    || typeof value.deviceId !== 'string' || !UUID_V4.test(value.deviceId)
    || typeof value.roomId !== 'string' || !COMPONENT.test(value.roomId)
    || !Number.isSafeInteger(value.roomCreatedAt) || Number(value.roomCreatedAt) < 0
    || typeof value.roomWasMissing !== 'boolean'
    || typeof value.phase !== 'string' || !OPERATION_PHASES.has(value.phase as ChatRoomManagementOperationPhase)
    || (value.action !== undefined && !['register', 'remove', 'update-sharing'].includes(String(value.action)))
    || (value.mode !== undefined && value.mode !== 'v1' && value.mode !== 'legacy')
    || (value.roomAgentId !== undefined && (typeof value.roomAgentId !== 'string' || !COMPONENT.test(value.roomAgentId)))
    || (value.compensationOperationId !== undefined && (typeof value.compensationOperationId !== 'string' || !UUID_V4.test(value.compensationOperationId)))
    || (value.sharing !== undefined && (!isRecord(value.sharing) || !exactKeys(value.sharing, ['memoryShared', 'skillsShared'])
      || typeof value.sharing.memoryShared !== 'boolean' || typeof value.sharing.skillsShared !== 'boolean'))
    || (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0))
    || !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0
    || !Number.isSafeInteger(value.updatedAt) || Number(value.updatedAt) < Number(value.createdAt)) {
    throw new Error('management_journal_unrecoverable')
  }
  validateInput(value.input, value.roomId)
  const action = value.action ?? 'register'
  if (action === 'register' && (value.sharing !== undefined || ['remote_removed', 'remote_updated'].includes(value.phase as string))) throw new Error('management_journal_unrecoverable')
  if (action !== 'register' && (!value.roomAgentId || value.compensationOperationId !== undefined)) throw new Error('management_journal_unrecoverable')
  if (action === 'update-sharing' && (!value.sharing || value.mode === 'legacy'
    || ['remote_created', 'remote_removed', 'compensation_pending', 'legacy_unknown', 'legacy_cleanup_unknown'].includes(value.phase as string))) {
    throw new Error('management_journal_unrecoverable')
  }
  if (action === 'remove' && (value.sharing !== undefined
    || ['remote_created', 'remote_updated', 'compensation_pending', 'legacy_cleanup_unknown'].includes(value.phase as string)
    || (value.phase === 'legacy_unknown' && value.mode !== 'legacy'))) {
    throw new Error('management_journal_unrecoverable')
  }
  if ((action === 'register' && ['remote_created', 'local_saved', 'compensation_pending'].includes(value.phase as string)
      || action !== 'register' && ['remote_removed', 'remote_updated', 'local_saved'].includes(value.phase as string)) && !value.roomAgentId) {
    throw new Error('management_journal_unrecoverable')
  }
  if (action === 'register' && value.phase === 'compensation_pending' && (!value.compensationOperationId || value.mode !== 'v1')) throw new Error('management_journal_unrecoverable')
  if (action === 'register' && value.phase === 'legacy_cleanup_unknown' && value.mode !== 'legacy') throw new Error('management_journal_unrecoverable')
}

function normalizedName(value: string): string {
  return canonicalizeChatRoomAgentDisplayName(value)?.toLocaleLowerCase('en-US') ?? ''
}

export class ChatRoomManagementJournal {
  constructor(private readonly now: () => number = () => Date.now()) {}

  list(identity: ChatRoomLocalIdentity): ChatRoomManagementOperation[] {
    return this.read().records.filter((record) => sameIdentity(record, identity)).map((record) => structuredClone(record))
  }

  findRegistration(identity: ChatRoomLocalIdentity, roomId: string, displayName: string): ChatRoomManagementOperation | undefined {
    const name = normalizedName(displayName)
    const record = this.read().records.find((item) => sameIdentity(item, identity)
      && (item.action ?? 'register') === 'register' && item.roomId === roomId && normalizedName(item.input.displayName) === name)
    return record ? structuredClone(record) : undefined
  }

  getRegistration(identity: ChatRoomLocalIdentity, operationId: string): ChatRoomManagementOperation | undefined {
    const record = this.read().records.find((item) => item.operationId === operationId)
    if (!record) return undefined
    if (!sameIdentity(record, identity)) throw new Error('management_operation_owner_mismatch')
    if ((record.action ?? 'register') !== 'register') return undefined
    return structuredClone(record)
  }

  getOperation(identity: ChatRoomLocalIdentity, operationId: string): ChatRoomManagementOperation | undefined {
    const record = this.read().records.find((item) => item.operationId === operationId)
    if (!record) return undefined
    if (!sameIdentity(record, identity)) throw new Error('management_operation_owner_mismatch')
    return structuredClone(record)
  }

  hasPendingForAgent(identity: ChatRoomLocalIdentity, roomId: string, roomAgentId: string): boolean {
    return this.read().records.some((record) => sameIdentity(record, identity) && record.roomId === roomId
      && record.roomAgentId === roomAgentId && record.phase !== 'local_saved')
  }

  findOperationForAgent(identity: ChatRoomLocalIdentity, roomId: string, roomAgentId: string, action?: ChatRoomManagementAction): ChatRoomManagementOperation | undefined {
    const records = this.read().records.filter((item) => sameIdentity(item, identity) && item.roomId === roomId
      && item.roomAgentId === roomAgentId && (!action || (item.action ?? 'register') === action))
    const pending = records.filter((item) => item.phase !== 'local_saved')
    if (pending.length > 1) throw new Error('management_operation_conflict')
    const record = pending[0] ?? records.at(-1)
    return record ? structuredClone(record) : undefined
  }

  prepareRemoval(identity: ChatRoomLocalIdentity, room: ChatRoomManagementRoomIdentity, agent: ChatRoomAgentLocalConfig): ChatRoomManagementOperation {
    return this.prepareAgentOperation(identity, room, agent, 'remove')
  }

  prepareSharingUpdate(
    identity: ChatRoomLocalIdentity,
    room: ChatRoomManagementRoomIdentity,
    agent: ChatRoomAgentLocalConfig,
    sharing: { memoryShared: boolean; skillsShared: boolean },
  ): ChatRoomManagementOperation {
    if (typeof sharing.memoryShared !== 'boolean' || typeof sharing.skillsShared !== 'boolean') throw new Error('invalid_management_operation')
    return this.prepareAgentOperation(identity, room, agent, 'update-sharing', sharing)
  }

  private prepareAgentOperation(
    identity: ChatRoomLocalIdentity,
    room: ChatRoomManagementRoomIdentity,
    agent: ChatRoomAgentLocalConfig,
    action: 'remove' | 'update-sharing',
    sharing?: { memoryShared: boolean; skillsShared: boolean },
  ): ChatRoomManagementOperation {
    if (!identity.hostUserId.trim() || !UUID_V4.test(identity.deviceId)
      || room.roomId === '' || room.hostUserId !== identity.hostUserId || room.deviceId !== identity.deviceId
      || !Number.isSafeInteger(room.createdAt) || room.createdAt < 0 || !COMPONENT.test(agent.roomAgentId)) {
      throw new Error('management_operation_room_identity_mismatch')
    }
    const input = canonicalInput({
      roomId: room.roomId, sourceWorkspaceId: agent.sourceWorkspaceId, displayName: agent.displayName,
      channelId: agent.channelId, ...(agent.modelId === undefined ? {} : { modelId: agent.modelId }),
      contextMessageCount: agent.contextMessageCount,
      memorySharingEnabled: sharing?.memoryShared ?? agent.memorySharingEnabled,
      skillSharingEnabled: sharing?.skillsShared ?? agent.skillSharingEnabled,
    })
    const snapshot = this.read()
    const pending = snapshot.records.find((record) => sameIdentity(record, identity)
      && record.roomId === room.roomId && record.roomAgentId === agent.roomAgentId
      && (record.phase !== 'local_saved'
        || ((record.action ?? 'register') === action && JSON.stringify(record.input) === JSON.stringify(input)
          && JSON.stringify(record.sharing) === JSON.stringify(sharing))))
    if (pending) {
      if ((pending.action ?? 'register') !== action || JSON.stringify(pending.input) !== JSON.stringify(input)
        || JSON.stringify(pending.sharing) !== JSON.stringify(sharing)) throw new Error('management_operation_pending')
      if (pending.roomCreatedAt !== room.createdAt || pending.roomWasMissing) throw new Error('management_operation_room_identity_mismatch')
      return structuredClone(pending)
    }
    if (snapshot.records.length >= MAX_RECORDS) throw new Error('management_journal_full')
    const timestamp = this.now()
    const operation: ChatRoomManagementOperation = {
      action, operationId: randomUUID(), hostUserId: identity.hostUserId, deviceId: identity.deviceId,
      roomId: room.roomId, roomCreatedAt: room.createdAt, roomWasMissing: false, roomAgentId: agent.roomAgentId,
      input, ...(sharing ? { sharing } : {}), phase: 'prepared', createdAt: timestamp, updatedAt: timestamp, revision: 0,
    }
    validateOperation(operation)
    snapshot.records.push(operation)
    this.write(snapshot)
    return structuredClone(operation)
  }

  prepareRegistration(identity: ChatRoomLocalIdentity, rawInput: ProvisionChatRoomAgentInput, room?: ChatRoomManagementRoomIdentity): ChatRoomManagementOperation {
    if (!identity.hostUserId.trim() || !UUID_V4.test(identity.deviceId)) throw new Error('management_operation_identity_invalid')
    const input = canonicalInput(rawInput)
    if (room && (room.roomId !== input.roomId || room.hostUserId !== identity.hostUserId || room.deviceId !== identity.deviceId
      || !Number.isSafeInteger(room.createdAt) || room.createdAt < 0)) {
      throw new Error('management_operation_room_identity_mismatch')
    }
    const snapshot = this.read()
    const pending = snapshot.records.find((record) => sameIdentity(record, identity)
      && (record.action ?? 'register') === 'register' && record.phase !== 'local_saved'
      && record.roomId === input.roomId && normalizedName(record.input.displayName) === normalizedName(input.displayName))
    if (pending) {
      if (JSON.stringify(pending.input) !== JSON.stringify(input)) throw new Error('management_operation_pending')
      if (room ? room.createdAt !== pending.roomCreatedAt : !pending.roomWasMissing) {
        throw new Error('management_operation_room_identity_mismatch')
      }
      return structuredClone(pending)
    }
    if (snapshot.records.length >= MAX_RECORDS) throw new Error('management_journal_full')
    const timestamp = this.now()
    const operation: ChatRoomManagementOperation = {
      operationId: randomUUID(), hostUserId: identity.hostUserId, deviceId: identity.deviceId,
      roomId: input.roomId, roomCreatedAt: room?.createdAt ?? timestamp, roomWasMissing: room === undefined,
      input, phase: 'prepared', createdAt: timestamp, updatedAt: timestamp, revision: 0,
    }
    snapshot.records.push(operation)
    this.write(snapshot)
    return structuredClone(operation)
  }

  updateRegistration(identity: ChatRoomLocalIdentity, operationId: string, update: Partial<Pick<ChatRoomManagementOperation,
    'phase' | 'mode' | 'roomAgentId' | 'compensationOperationId'>>): ChatRoomManagementOperation {
    return this.updateOperation(identity, operationId, update, 'register')
  }

  updateOperation(
    identity: ChatRoomLocalIdentity,
    operationId: string,
    update: Partial<Pick<ChatRoomManagementOperation, 'phase' | 'mode' | 'roomAgentId' | 'compensationOperationId'>>,
    expectedAction?: ChatRoomManagementAction,
    expectedRevision?: number,
  ): ChatRoomManagementOperation {
    const snapshot = this.read()
    const index = snapshot.records.findIndex((record) => record.operationId === operationId)
    if (index < 0) throw new Error('management_operation_not_found')
    const current = snapshot.records[index]!
    if (!sameIdentity(current, identity)) throw new Error('management_operation_owner_mismatch')
    if (expectedAction && (current.action ?? 'register') !== expectedAction) throw new Error('management_operation_action_mismatch')
    if (expectedRevision !== undefined && (current.revision ?? 0) !== expectedRevision) throw new Error('management_operation_revision_changed')
    if (update.phase && !this.canTransition(current.phase, update.phase)) throw new Error('management_operation_transition_invalid')
    const next = { ...current, ...update, revision: (current.revision ?? 0) + 1, updatedAt: this.now() }
    validateOperation(next)
    snapshot.records[index] = next
    this.write(snapshot)
    return structuredClone(next)
  }

  removeRegistration(identity: ChatRoomLocalIdentity, operationId: string, expectedRevision?: number): boolean {
    const snapshot = this.read()
    const index = snapshot.records.findIndex((record) => record.operationId === operationId)
    if (index < 0) return false
    if (!sameIdentity(snapshot.records[index]!, identity)) throw new Error('management_operation_owner_mismatch')
    if (expectedRevision !== undefined && (snapshot.records[index]!.revision ?? 0) !== expectedRevision) throw new Error('management_operation_revision_changed')
    snapshot.records.splice(index, 1)
    this.write(snapshot)
    return true
  }

  private get path(): string {
    return join(getChatRoomsRootPath(), FILE_NAME)
  }

  private read(): PersistedOperations {
    const path = this.path
    this.assertRegular(path)
    this.assertRegular(`${path}.tmp`)
    this.assertRegular(`${path}.bak`)
    const result = readJsonFileSafeDetailed<unknown>(path, '聊天室管理操作', { maxBytes: MAX_BYTES })
    if (result.status === 'missing') return { version: 2, records: [] }
    if (result.status === 'corrupt' || !isRecord(result.value) || !exactKeys(result.value, ['version', 'records'])
      || !Array.isArray(result.value.records) || result.value.records.length > MAX_RECORDS) {
      throw new Error('management_journal_unrecoverable')
    }
    if (result.value.version === 1) {
      if (result.value.records.length > 0) throw new Error('management_journal_legacy_unrecoverable')
      return { version: 2, records: [] }
    }
    if (result.value.version !== 2) throw new Error('management_journal_unrecoverable')
    const ids = new Set<string>()
    for (const record of result.value.records) {
      validateOperation(record)
      if (ids.has(record.operationId)) throw new Error('management_journal_unrecoverable')
      ids.add(record.operationId)
    }
    return { version: 2, records: result.value.records }
  }

  private write(snapshot: PersistedOperations): void {
    if (snapshot.records.length > MAX_RECORDS) throw new Error('management_journal_full')
    const path = this.path
    this.assertRegular(path)
    this.assertRegular(`${path}.tmp`)
    this.assertRegular(`${path}.bak`)
    writeJsonFileAtomicDurable(path, snapshot, 0o600, true, MAX_BYTES)
  }

  private canTransition(from: ChatRoomManagementOperationPhase, to: ChatRoomManagementOperationPhase): boolean {
    const allowed: Record<ChatRoomManagementOperationPhase, readonly ChatRoomManagementOperationPhase[]> = {
      prepared: ['submitting', 'remote_created', 'remote_removed', 'remote_updated', 'legacy_unknown'],
      submitting: ['unknown', 'remote_created', 'remote_removed', 'remote_updated', 'legacy_unknown'],
      unknown: ['submitting', 'remote_created', 'remote_removed', 'remote_updated', 'legacy_unknown'],
      remote_created: ['local_saved', 'compensation_pending', 'legacy_cleanup_unknown'],
      remote_removed: ['local_saved'],
      remote_updated: ['local_saved'],
      local_saved: [],
      legacy_unknown: [],
      legacy_cleanup_unknown: [],
      compensation_pending: [],
    }
    return from === to || allowed[from].includes(to)
  }

  private assertRegular(path: string): void {
    try {
      if (!lstatSync(path).isFile()) throw new Error('management_journal_path_not_file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
