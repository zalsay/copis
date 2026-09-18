import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const testDir = join(process.env.TMPDIR ?? '/tmp', `copis-client-device-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
const webSyncPath = join(testDir, 'web-sync-state.json')

mock.module('electron', () => ({
  app: { isPackaged: false },
}))
mock.module('node:os', () => ({
  homedir: () => testDir,
}))

const actualConfigPaths = await import('./config-paths')
mock.module('./config-paths', () => ({
  ...actualConfigPaths,
  getWebSyncStatePath: () => webSyncPath,
}))

const {
  getOrCreateClientDeviceId,
  getClientDevicePath,
  getChatRoomsRootPath,
  getChatRoomPath,
  getChatRoomConfigPath,
  getChatRoomAgentSessionMessagesPath,
} = await import('./client-device-id')

describe('客户端设备 ID 与聊天室路径', () => {
  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test('已有 web-sync deviceId 时首次读取会迁移并原子保存', () => {
    writeFileSync(webSyncPath, JSON.stringify({ deviceId: 'legacy-device', serverCursor: 0 }))

    expect(getOrCreateClientDeviceId()).toBe('legacy-device')
    expect(JSON.parse(readFileSync(getClientDevicePath(), 'utf8'))).toMatchObject({
      version: 1,
      deviceId: 'legacy-device',
    })
    if (process.platform !== 'win32') {
      expect(statSync(getClientDevicePath()).mode & 0o777).toBe(0o600)
    }
  })

  test('client-device.json 优先于 web-sync-state.json 且权限收紧', () => {
    mkdirSync(join(testDir, 'agent-workspaces', 'chatrooms'), { recursive: true })
    writeFileSync(webSyncPath, JSON.stringify({ deviceId: 'legacy-device' }))
    writeFileSync(getClientDevicePath(), JSON.stringify({ version: 1, deviceId: 'client-device', createdAt: Date.now() }))

    expect(getOrCreateClientDeviceId()).toBe('client-device')
    if (process.platform !== 'win32') {
      expect(statSync(getClientDevicePath()).mode & 0o777).toBe(0o600)
    }
  })

  test('没有合法旧 ID 时生成并稳定复用 UUID v4', () => {
    writeFileSync(webSyncPath, JSON.stringify({ deviceId: 'bad device' }))

    const first = getOrCreateClientDeviceId()
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(getOrCreateClientDeviceId()).toBe(first)
  })

  test('旧 ID 含控制字符、空白或超长时不迁移', () => {
    for (const deviceId of [' leading-space', 'trailing-space ', 'line\nbreak', 'x'.repeat(129), '🙂'.repeat(64)]) {
      rmSync(getClientDevicePath(), { force: true })
      writeFileSync(webSyncPath, JSON.stringify({ deviceId }))
      expect(getOrCreateClientDeviceId()).not.toBe(deviceId)
    }
  })

  test('client-device.json 缺少或错误 createdAt 时视为坏文件并重建', () => {
    for (const file of [
      { version: 1, deviceId: 'missing-created-at' },
      { version: 1, deviceId: 'fractional-created-at', createdAt: 1.5 },
      { version: 1, deviceId: 'negative-created-at', createdAt: -1 },
      { version: 1, deviceId: 'unknown-structure', createdAt: 1, extra: true },
    ]) {
      rmSync(getClientDevicePath(), { force: true })
      writeFileSync(getClientDevicePath(), JSON.stringify(file))
      const resolved = getOrCreateClientDeviceId()
      expect(resolved).not.toBe(file.deviceId)
      expect(JSON.parse(readFileSync(getClientDevicePath(), 'utf8'))).toMatchObject({ version: 1, deviceId: resolved })
      expect(JSON.parse(readFileSync(getClientDevicePath(), 'utf8')).createdAt).toBeGreaterThanOrEqual(0)
    }
  })

  test('首次创建并发时所有调用者都返回同一个赢家 ID', async () => {
    const modulePath = new URL('./client-device-id.ts', import.meta.url).pathname
    const childCode = `import { mock } from 'bun:test'; mock.module('electron', () => ({ app: { isPackaged: true } })); const { getOrCreateClientDeviceId } = await import(${JSON.stringify(modulePath)}); process.stdout.write(getOrCreateClientDeviceId())`
    const children = Array.from({ length: 8 }, () => Bun.spawn(['bun', '-e', childCode], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: testDir, USERPROFILE: testDir, COPIS_DEV: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    }))

    const ids: string[] = []
    for (const child of children) {
      await child.exited
      expect(child.exitCode).toBe(0)
      const output = await new Response(child.stdout).text()
      const match = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/)
      expect(match).not.toBeNull()
      ids.push(match![0])
    }

    expect(new Set(ids).size).toBe(1)
  })

  test('聊天室路径校验组件并拒绝目录穿越', () => {
    const roomsRoot = getChatRoomsRootPath()
    expect(getChatRoomPath('room-1')).toBe(join(roomsRoot, 'room-1'))
    expect(getChatRoomConfigPath('room-1')).toBe(join(roomsRoot, 'room-1', 'room.json'))
    expect(getChatRoomAgentSessionMessagesPath('room-1', 'agent-a')).toBe(
      join(roomsRoot, 'room-1', 'agents', 'agent-a', 'sessions', 'messages.jsonl'),
    )
    expect(() => getChatRoomPath('../escape')).toThrow('roomId 参数不正确')
    expect(() => getChatRoomPath('room/escape')).toThrow('roomId 参数不正确')
    expect(() => getChatRoomAgentSessionMessagesPath('room-1', '../escape')).toThrow('roomAgentId 参数不正确')
    expect(getChatRoomPath('room-1').startsWith(roomsRoot)).toBe(true)
    expect(existsSync(roomsRoot)).toBe(true)
  })
})
