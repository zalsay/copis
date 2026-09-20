import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

const testHome = join(os.tmpdir(), `copis-hidden-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

mock.module('electron', () => ({
  app: { isPackaged: true, getPath: () => join(testHome, 'Library', 'Application Support') },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))
mock.module('node:os', () => ({ ...os, homedir: () => testHome }))

const {
  getChatRoomAgentSessionDir,
  getChatRoomAgentSessionMetaPath,
  getChatRoomAgentSessionMessagesPath,
  getAgentSessionMessagesPath,
} = await import('./config-paths')
const manager = await import('./agent-session-manager')
const { ChatRoomHiddenSessionStore } = await import('./chatroom-hidden-session-store')
import type { AgentMessage, SDKMessage } from '@copis/shared'
import type { ChatRoomAgentLocalConfig } from '@copis/shared'

const agentConfig: ChatRoomAgentLocalConfig = {
  roomAgentId: 'agent-a',
  displayName: 'Agent A',
  sourceWorkspaceId: 'workspace-a',
  sessionId: 'hidden-session-a',
  channelId: 'channel-a',
  modelId: 'model-a',
  contextMessageCount: 20,
  memorySharingEnabled: true,
  skillSharingEnabled: false,
}

const userMessage: SDKMessage = {
  type: 'user',
  uuid: 'message-a',
  message: { role: 'user', content: [{ type: 'text', text: '你好' }] },
  parent_tool_use_id: null,
  session_id: 'sdk-session',
}

function prepareAgentDirectories(roomAgentId = agentConfig.roomAgentId): void {
  mkdirSync(join(testHome, '.copis', 'agent-workspaces', 'chatrooms', 'room-1', 'agents', roomAgentId, 'sessions'), { recursive: true })
}

function makeConfig(overrides: Partial<ChatRoomAgentLocalConfig> = {}): ChatRoomAgentLocalConfig {
  return { ...agentConfig, ...overrides }
}

beforeEach(() => {
  rmSync(testHome, { recursive: true, force: true })
  mkdirSync(testHome, { recursive: true })
  prepareAgentDirectories()
})

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true })
})

describe('聊天室隐藏 Agent session 存储', () => {
  test('Given 已注册隐藏 session backend When runtime 读写 meta 和 SDKMessage Then 只写聊天室目录', () => {
    const backend = new ChatRoomHiddenSessionStore('room-1', agentConfig)
    const unregister = manager.registerAgentSessionStorageOverride(agentConfig.sessionId, backend)

    manager.appendSDKMessages(agentConfig.sessionId, [userMessage])
    manager.updateAgentSessionMeta(agentConfig.sessionId, { sdkSessionId: 'sdk-1' })

    expect(manager.getAgentSessionSDKMessages(agentConfig.sessionId)).toHaveLength(1)
    expect(manager.getAgentSessionMeta(agentConfig.sessionId)?.sdkSessionId).toBe('sdk-1')
    expect(manager.listAgentSessions().some((session) => session.id === agentConfig.sessionId)).toBe(false)
    expect(existsSync(join(testHome, '.copis', 'agent-sessions.json'))).toBe(false)
    expect(existsSync(getAgentSessionMessagesPath(agentConfig.sessionId))).toBe(false)
    expect(existsSync(getChatRoomAgentSessionMetaPath('room-1', agentConfig.roomAgentId))).toBe(true)
    expect(existsSync(getChatRoomAgentSessionMessagesPath('room-1', agentConfig.roomAgentId))).toBe(true)
    expect(existsSync(`${getChatRoomAgentSessionMetaPath('room-1', agentConfig.roomAgentId)}.bak`)).toBe(false)
    unregister()
  })

  test('Given 两个 Agent backend When 并行追加消息 Then JSONL 和 meta 不交叉', async () => {
    prepareAgentDirectories('agent-b')
    const configB = makeConfig({ roomAgentId: 'agent-b', sessionId: 'hidden-session-b', displayName: 'Agent B' })
    const backendA = new ChatRoomHiddenSessionStore('room-1', agentConfig)
    const backendB = new ChatRoomHiddenSessionStore('room-1', configB)
    const unregisterA = manager.registerAgentSessionStorageOverride(agentConfig.sessionId, backendA)
    const unregisterB = manager.registerAgentSessionStorageOverride(configB.sessionId, backendB)

    await Promise.all([
      Promise.resolve().then(() => manager.appendSDKMessages(agentConfig.sessionId, [userMessage])),
      Promise.resolve().then(() => manager.appendSDKMessages(configB.sessionId, [{ ...userMessage, uuid: 'message-b' }])),
    ])

    expect(manager.getAgentSessionSDKMessages(agentConfig.sessionId).map((message) => (message as { uuid?: string }).uuid)).toEqual(['message-a'])
    expect(manager.getAgentSessionSDKMessages(configB.sessionId).map((message) => (message as { uuid?: string }).uuid)).toEqual(['message-b'])
    unregisterA()
    unregisterB()
  })

  test('duplicate registration rejects and stale unregister cannot remove a later registration', () => {
    const first = new ChatRoomHiddenSessionStore('room-1', agentConfig)
    const unregisterFirst = manager.registerAgentSessionStorageOverride(agentConfig.sessionId, first)
    expect(() => manager.registerAgentSessionStorageOverride(agentConfig.sessionId, new ChatRoomHiddenSessionStore('room-1', agentConfig))).toThrow()
    unregisterFirst()
    const second = new ChatRoomHiddenSessionStore('room-1', agentConfig)
    const unregisterSecond = manager.registerAgentSessionStorageOverride(agentConfig.sessionId, second)
    unregisterFirst()
    expect(manager.getAgentSessionMeta(agentConfig.sessionId)?.id).toBe(agentConfig.sessionId)
    unregisterSecond()
    expect(manager.getAgentSessionMeta(agentConfig.sessionId)).toEqual(undefined)
  })

  test('corrupted meta and JSONL fail closed without falling back to normal storage', () => {
    const metaPath = getChatRoomAgentSessionMetaPath('room-1', agentConfig.roomAgentId)
    const messagesPath = getChatRoomAgentSessionMessagesPath('room-1', agentConfig.roomAgentId)
    const backend = new ChatRoomHiddenSessionStore('room-1', agentConfig)
    const validMeta = backend.getMeta()
    writeFileSync(metaPath, '{broken', 'utf8')
    expect(() => backend.getMeta()).toThrow()
    writeFileSync(metaPath, JSON.stringify(validMeta), 'utf8')
    writeFileSync(messagesPath, '{broken\n', 'utf8')
    expect(() => backend.getSDKMessages()).toThrow()
    expect(existsSync(getAgentSessionMessagesPath(agentConfig.sessionId))).toBe(false)
  })

  test('sessions、meta、messages 为 symlink 或非目录/文件时拒绝访问', () => {
    if (process.platform === 'win32') return
    const sessionsPath = getChatRoomAgentSessionDir('room-1', agentConfig.roomAgentId)
    const external = join(testHome, 'external')
    mkdirSync(external)
    rmSync(sessionsPath, { recursive: true, force: true })
    symlinkSync(external, sessionsPath)
    expect(() => new ChatRoomHiddenSessionStore('room-1', agentConfig)).toThrow()

    rmSync(sessionsPath, { force: true })
    mkdirSync(sessionsPath)
    symlinkSync(external, getChatRoomAgentSessionMetaPath('room-1', agentConfig.roomAgentId))
    expect(() => new ChatRoomHiddenSessionStore('room-1', agentConfig)).toThrow()

    rmSync(getChatRoomAgentSessionMetaPath('room-1', agentConfig.roomAgentId), { force: true })
    symlinkSync(external, getChatRoomAgentSessionMessagesPath('room-1', agentConfig.roomAgentId))
    expect(() => new ChatRoomHiddenSessionStore('room-1', agentConfig)).toThrow()
  })

  test('UUID dedupe 保留最新帧，legacy AgentMessage 转换，并仅删除 assistant error', () => {
    const backend = new ChatRoomHiddenSessionStore('room-1', agentConfig)
    const messagesPath = getChatRoomAgentSessionMessagesPath('room-1', agentConfig.roomAgentId)
    const first = { ...userMessage, message: { role: 'user', content: [{ type: 'text', text: '旧' }] } }
    const latest = { ...userMessage, message: { role: 'user', content: [{ type: 'text', text: '新' }] } }
    const legacy: AgentMessage = { id: 'legacy-1', role: 'assistant', content: '旧格式', createdAt: Date.now() }
    writeFileSync(messagesPath, `${JSON.stringify(first)}\n${JSON.stringify(legacy)}\n${JSON.stringify(latest)}\n`, 'utf8')
    expect(backend.getSDKMessages()).toHaveLength(2)
    expect(JSON.stringify(backend.getSDKMessages()[0])).toContain('新')

    const regular = { ...latest, uuid: 'regular', error: undefined }
    const error = { ...latest, type: 'assistant', uuid: 'error', error: { message: 'retry' } }
    writeFileSync(messagesPath, `${JSON.stringify(regular)}\n${JSON.stringify(error)}\n`, 'utf8')
    expect(backend.removeSDKErrorMessage('regular')).toBe(false)
    expect(backend.removeSDKErrorMessage('error')).toBe(true)
    expect(backend.getSDKMessages().map((message) => (message as { uuid?: string }).uuid)).toEqual(['regular'])
  })

  test('oversize SDKMessage 使用 ordinary serializer 的 256K UTF-16 cap', () => {
    const backend = new ChatRoomHiddenSessionStore('room-1', agentConfig)
    const huge: SDKMessage = {
      ...userMessage,
      uuid: 'huge',
      message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(300_000) }] },
    }
    backend.appendSDKMessages([huge])
    const line = readFileSync(getChatRoomAgentSessionMessagesPath('room-1', agentConfig.roomAgentId), 'utf8').trim()
    expect(line.length).toBeLessThanOrEqual(256 * 1024)
    expect(line).toBe(manager.serializeSDKMessageForStorageForInternal(huge))
  })
})
