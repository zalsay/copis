import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
  __clientDeviceIdTestHooks,
} = await import('./client-device-id')

const LEGACY_DEVICE_ID = '123e4567-e89b-42d3-a456-426614174000'

describe('客户端设备 ID 与聊天室路径', () => {
  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test('已有 web-sync deviceId 时首次读取会迁移并原子保存', () => {
    writeFileSync(webSyncPath, JSON.stringify({ deviceId: LEGACY_DEVICE_ID, serverCursor: 0 }))

    expect(getOrCreateClientDeviceId()).toBe(LEGACY_DEVICE_ID)
    expect(JSON.parse(readFileSync(getClientDevicePath(), 'utf8'))).toMatchObject({
      version: 1,
      deviceId: LEGACY_DEVICE_ID,
    })
    if (process.platform !== 'win32') {
      expect(statSync(getClientDevicePath()).mode & 0o777).toBe(0o600)
    }
  })

  test('client-device.json 优先于 web-sync-state.json 且权限收紧', () => {
    mkdirSync(join(testDir, 'agent-workspaces', 'chatrooms'), { recursive: true })
    writeFileSync(webSyncPath, JSON.stringify({ deviceId: LEGACY_DEVICE_ID }))
    writeFileSync(getClientDevicePath(), JSON.stringify({ version: 1, deviceId: LEGACY_DEVICE_ID, createdAt: Date.now() }))

    expect(getOrCreateClientDeviceId()).toBe(LEGACY_DEVICE_ID)
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

  test('大小写混合的 UUID v4 旧 ID 可以迁移，新生成 ID 保持小写', () => {
    const uppercaseId = '123E4567-E89B-42D3-A456-426614174000'
    writeFileSync(webSyncPath, JSON.stringify({ deviceId: uppercaseId }))

    expect(getOrCreateClientDeviceId()).toBe(uppercaseId)
    rmSync(getClientDevicePath(), { force: true })
    rmSync(webSyncPath, { force: true })
    expect(getOrCreateClientDeviceId()).toMatch(/^[0-9a-f-]{36}$/)
    expect(getOrCreateClientDeviceId()).not.toMatch(/[A-F]/)
  })

  test('旧 ID 含控制字符、空白或超长时不迁移', () => {
    for (const deviceId of [' leading-space', 'trailing-space ', 'line\nbreak', 'x'.repeat(129), '🙂'.repeat(64), 'legacy-device']) {
      rmSync(getClientDevicePath(), { force: true })
      writeFileSync(webSyncPath, JSON.stringify({ deviceId }))
      expect(getOrCreateClientDeviceId()).not.toBe(deviceId)
    }
  })

  test('client-device.json 的临时恢复文件不会被纯读取路径提升', () => {
    writeFileSync(getClientDevicePath(), '{broken')
    writeFileSync(`${getClientDevicePath()}.tmp`, JSON.stringify({
      version: 1,
      deviceId: LEGACY_DEVICE_ID,
      createdAt: 1,
    }))

    const resolved = getOrCreateClientDeviceId()

    expect(resolved).not.toBe(LEGACY_DEVICE_ID)
    expect(existsSync(`${getClientDevicePath()}.tmp`)).toBe(true)
  })

  test('有效和悬空符号链接设备目标都直接失败且不触碰链接目标', () => {
    if (process.platform === 'win32') return
    const externalPath = join(testDir, 'external-device.json')
    writeFileSync(externalPath, JSON.stringify({
      version: 1,
      deviceId: LEGACY_DEVICE_ID,
      createdAt: 1,
    }))

    for (const linkPath of [getClientDevicePath(), `${getClientDevicePath()}-dangling`]) {
      rmSync(getClientDevicePath(), { force: true })
      rmSync(`${getClientDevicePath()}-dangling`, { force: true })
      symlinkSync(linkPath.endsWith('dangling') ? join(testDir, 'missing.json') : externalPath, getClientDevicePath())

      expect(() => getOrCreateClientDeviceId()).toThrow('客户端设备文件路径不是普通文件')
      expect(readFileSync(externalPath, 'utf8')).toContain(LEGACY_DEVICE_ID)
    }
  })

  test('目录和 FIFO 设备目标直接失败且不会进入重试循环', () => {
    if (process.platform === 'win32') return
    mkdirSync(getClientDevicePath())
    expect(() => getOrCreateClientDeviceId()).toThrow('客户端设备文件路径不是普通文件')

    rmSync(getClientDevicePath(), { recursive: true, force: true })
    const fifoPath = getClientDevicePath()
    const fifoResult = Bun.spawnSync(['mkfifo', fifoPath])
    if (fifoResult.exitCode !== 0) return
    expect(() => getOrCreateClientDeviceId()).toThrow('客户端设备文件路径不是普通文件')
  })

  test('活动但过期的锁不会因 mtime 老旧而被窃取', () => {
    if (process.platform === 'win32') return
    const lockPath = `${getClientDevicePath()}.lock`
    const token = '11111111-1111-4111-8111-111111111111'
    mkdirSync(lockPath)
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({
      version: 1,
      token,
      pid: process.pid,
      createdAt: 0,
    }))

    expect(() => __clientDeviceIdTestHooks.acquire(lockPath, getClientDevicePath())).toThrow('客户端设备文件锁仍由活动进程持有')
    expect(readFileSync(join(lockPath, 'owner.json'), 'utf8')).toContain(token)
  })

  test('旧 token 不能删除或覆盖新 owner 的锁', () => {
    if (process.platform === 'win32') return
    const lockPath = `${getClientDevicePath()}.lock`
    const oldToken = '11111111-1111-4111-8111-111111111111'
    const newToken = '22222222-2222-4222-8222-222222222222'
    mkdirSync(lockPath)
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ version: 1, token: newToken, pid: process.pid, createdAt: Date.now() }))

    expect(__clientDeviceIdTestHooks.removeIfOwner(lockPath, oldToken)).toBe(false)
    expect(__clientDeviceIdTestHooks.publishIfOwner(getClientDevicePath(), lockPath, oldToken, {
      version: 1,
      deviceId: '123e4567-e89b-42d3-a456-426614174001',
      createdAt: 1,
    })).toBe(false)
    expect(existsSync(getClientDevicePath())).toBe(false)
    expect(readFileSync(join(lockPath, 'owner.json'), 'utf8')).toContain(newToken)
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
