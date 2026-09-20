import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  closeSync,
  existsSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  CHATROOM_CONFIG_MAX_BYTES,
  CHATROOM_RECOVERY_ENVELOPE_MAX_BYTES,
  readJsonFileSafe,
  readJsonFileSafeDetailed,
  writeJsonFileAtomic,
  writeJsonFileAtomicDurable,
} from './safe-file'

const root = join(process.env.TMPDIR ?? '/tmp', `copis-safe-file-${Date.now()}-${Math.random().toString(36).slice(2)}`)

function recoveryOwnerToken(file: string): string {
  return (JSON.parse(readFileSync(`${file}.bak-recovery-owner`, 'utf8')) as { token: string }).token
}

function recoverySlotPath(file: string, token: string, suffix: 'a' | 'b'): string {
  return `${file}.bak-recovery-${token}-${suffix}`
}

function legacyRecoverySlotPath(file: string, suffix: 'a' | 'b'): string {
  return `${file}.bak-recovery-${suffix}`
}

function writeRecoveryEnvelope(path: string, ownerToken: string, generation: number, payload: object): void {
  const encoded = JSON.stringify(payload)
  writeFileSync(path, JSON.stringify({
    version: 1,
    ownerToken,
    generation,
    payload: encoded,
    digest: createHash('sha256').update(encoded, 'utf8').digest('hex'),
  }))
}

beforeEach(() => mkdirSync(root, { recursive: true }))
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('聊天室 durable JSON writer', () => {
  test('Given 合法通用 JSON 超过 4 MiB When 安全读取 Then 保持既有通用索引兼容', () => {
    const file = join(root, 'large-generic.json')
    const value = 'x'.repeat(4 * 1024 * 1024)
    writeFileSync(file, JSON.stringify({ value }))

    expect(readJsonFileSafe<{ value: string }>(file)?.value.length).toBe(value.length)
  })

  test('Given 聊天室配置 payload 恰好在显式上限内 When 安全读取 Then 接受 payload', () => {
    const file = join(root, 'room-boundary.json')
    const prefix = '{\n  "value": "'
    const suffix = '"\n}'
    const value = 'x'.repeat(CHATROOM_CONFIG_MAX_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix))
    writeFileSync(file, `${prefix}${value}${suffix}`)

    const result = readJsonFileSafeDetailed<{ value: string }>(file, '聊天室配置', {
      maxBytes: CHATROOM_CONFIG_MAX_BYTES,
    })
    expect(result.status).toBe('valid')
    expect(result.value?.value.length).toBe(value.length)
  })

  test('Given 通用 writer 传入显式 maxBytes 且 payload 超限 When 写入 Then fail closed', () => {
    const file = join(root, 'room-write-limit.json')

    expect(() => writeJsonFileAtomic(file, { value: '0123456789' }, false, 0o600, 10)).toThrow()
    expect(existsSync(file)).toBe(false)
  })

  test('Given 聊天室配置 recovery envelope 近 payload 上限 When 恢复 Then 预留包装与转义空间', () => {
    const file = join(root, 'room-envelope-boundary.json')
    const value = 'x'.repeat(CHATROOM_CONFIG_MAX_BYTES - 64)
    writeJsonFileAtomicDurable(file, { value })
    writeFileSync(`${file}.bak`, 'external bak')
    writeJsonFileAtomicDurable(file, { value: `${value}2` })
    const slots = [...new Bun.Glob('room-envelope-boundary.json.bak-recovery-*').scanSync(root)]
      .filter((path) => !path.endsWith('-owner'))
    expect(slots.length).toBeGreaterThan(0)
    expect(slots.every((path) => Buffer.byteLength(readFileSync(join(root, path))) <= CHATROOM_RECOVERY_ENVELOPE_MAX_BYTES)).toBe(true)
    writeFileSync(file, '{broken')

    const result = readJsonFileSafeDetailed<{ value: string }>(file, '聊天室配置', {
      maxBytes: CHATROOM_CONFIG_MAX_BYTES,
    })
    expect(result.status).toBe('recovered')
    expect(result.value?.value).toBe(value)
  })

  test('Given 固定 tmp 是外部普通文件 When 持久化 Then 不截断或覆盖固定 tmp', () => {
    const file = join(root, 'room.json')
    const fixedTmp = `${file}.tmp`
    writeFileSync(fixedTmp, 'external tmp')

    writeJsonFileAtomicDurable(file, { value: 'first' })

    expect(readFileSync(fixedTmp, 'utf8')).toBe('external tmp')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ value: 'first' })
  })

  test('Given 固定 tmp 和 bak 是符号链接 When 持久化 Then 不跟随链接写入外部文件', () => {
    if (process.platform === 'win32') return
    const file = join(root, 'room.json')
    const externalTmp = join(root, 'external-tmp')
    const externalBak = join(root, 'external-bak')
    writeFileSync(externalTmp, 'external tmp')
    writeFileSync(externalBak, 'external bak')
    symlinkSync(externalTmp, `${file}.tmp`)
    symlinkSync(externalBak, `${file}.bak`)
    writeJsonFileAtomicDurable(file, { value: 'first' })

    expect(readFileSync(externalTmp, 'utf8')).toBe('external tmp')
    expect(readFileSync(externalBak, 'utf8')).toBe('external bak')
    expect(lstatSync(`${file}.bak`).isSymbolicLink()).toBe(true)
  })

  test('Given 已有 canonical When 持久化 Then 通过唯一临时文件原子替换并保留旧 bak', () => {
    const file = join(root, 'room.json')
    writeFileSync(file, JSON.stringify({ value: 'old' }))

    writeJsonFileAtomicDurable(file, { value: 'new' })

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ value: 'new' })
    expect(JSON.parse(readFileSync(`${file}.bak`, 'utf8'))).toEqual({ value: 'old' })
    expect([...new Bun.Glob('room.json.tmp-*').scanSync(root)]).toEqual([])
    expect([...new Bun.Glob('room.json.bak-*').scanSync(root)]).toEqual([])
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  test('Given canonical bak 已是外部普通文件 When 持久化 Then 不覆盖固定 bak', () => {
    const file = join(root, 'room.json')
    const fixedBak = `${file}.bak`
    writeFileSync(file, JSON.stringify({ value: 'old' }))
    writeFileSync(fixedBak, 'external bak')

    writeJsonFileAtomicDurable(file, { value: 'new' })

    expect(readFileSync(fixedBak, 'utf8')).toBe('external bak')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ value: 'new' })
  })

  test('Given canonical bak 是指向外部的符号链接 When 持久化 Then 不覆盖链接或外部目标', () => {
    if (process.platform === 'win32') return
    const file = join(root, 'room.json')
    const fixedBak = `${file}.bak`
    const externalBak = join(root, 'external-bak')
    writeFileSync(file, JSON.stringify({ value: 'old' }))
    writeFileSync(externalBak, 'external bak')
    symlinkSync(externalBak, fixedBak)

    writeJsonFileAtomicDurable(file, { value: 'new' })

    expect(lstatSync(fixedBak).isSymbolicLink()).toBe(true)
    expect(readFileSync(externalBak, 'utf8')).toBe('external bak')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ value: 'new' })
  })

  test('Given fixed bak 被外部普通文件占用 When 连续提交并丢失主文件 Then 恢复最近一次 previous 且不改外部文件', () => {
    const file = join(root, 'room.json')
    const fixedBak = `${file}.bak`
    writeJsonFileAtomicDurable(file, { value: 'one' })
    writeFileSync(fixedBak, 'external bak')

    writeJsonFileAtomicDurable(file, { value: 'two' })
    writeJsonFileAtomicDurable(file, { value: 'three' })
    unlinkSync(file)

    expect(readJsonFileSafe<{ value: string }>(file)).toEqual({ value: 'two' })
    expect(readFileSync(fixedBak, 'utf8')).toBe('external bak')
  })

  test('Given fixed bak 是外部符号链接 When 连续提交并损坏主文件 Then 恢复最近一次 previous 且不跟随链接', () => {
    if (process.platform === 'win32') return
    const file = join(root, 'room.json')
    const fixedBak = `${file}.bak`
    const externalBak = join(root, 'external-bak')
    writeJsonFileAtomicDurable(file, { value: 'one' })
    writeFileSync(externalBak, 'external bak')
    symlinkSync(externalBak, fixedBak)

    writeJsonFileAtomicDurable(file, { value: 'two' })
    writeJsonFileAtomicDurable(file, { value: 'three' })
    writeFileSync(file, '{broken')

    expect(readJsonFileSafe<{ value: string }>(file)).toEqual({ value: 'two' })
    expect(readFileSync(externalBak, 'utf8')).toBe('external bak')
    expect(lstatSync(fixedBak).isSymbolicLink()).toBe(true)
  })

  test('Given 多次提交 When 检查受控恢复残留 Then 数量保持有界', () => {
    const file = join(root, 'room.json')
    writeJsonFileAtomicDurable(file, { value: 'one' })
    writeFileSync(`${file}.bak`, 'external bak')
    for (let index = 2; index <= 20; index += 1) {
      writeJsonFileAtomicDurable(file, { value: String(index) })
    }

    const controlled = [...new Bun.Glob('room.json.bak-recovery-*').scanSync(root)]
    expect(controlled.length).toBeLessThanOrEqual(3)
    expect(controlled.some((path) => path.endsWith('.bak-recovery-owner'))).toBe(true)
    expect([...new Bun.Glob('room.json.bak-????????-????-????-????-????????????').scanSync(root)]).toEqual([])
  })

  test('Given canonical bak 正常存在 When 主文件丢失 Then 仍从 canonical bak 恢复', () => {
    const file = join(root, 'room.json')
    writeJsonFileAtomicDurable(file, { value: 'one' })
    writeJsonFileAtomicDurable(file, { value: 'two' })
    unlinkSync(file)

    expect(readJsonFileSafe<{ value: string }>(file)).toEqual({ value: 'one' })
  })

  test('Given 受控槽有伪造的更高代次 When owner token 不匹配 Then 拒绝伪造恢复并使用可信来源', () => {
    const file = join(root, 'room.json')
    writeJsonFileAtomicDurable(file, { value: 'slot' })
    writeFileSync(`${file}.bak`, JSON.stringify({ value: 'canonical' }))
    writeJsonFileAtomicDurable(file, { value: 'current' })

    const token = recoveryOwnerToken(file)
    // 槽路径绑定当前 owner，但 envelope 仍必须精确匹配 owner token。
    writeRecoveryEnvelope(recoverySlotPath(file, token, 'b'), '11111111-1111-4111-8111-111111111111', 999, { value: 'forged' })
    writeFileSync(file, '{broken')

    expect(readJsonFileSafe<{ value: string }>(file)).toEqual({ value: 'slot' })
  })

  test('Given owner 文件缺失、损坏或被替换 When 主文件损坏 Then controlled slots 全部不可信', () => {
    const modes = ['missing', 'corrupt', 'replaced'] as const
    for (const mode of modes) {
      const file = join(root, `room-${mode}.json`)
      writeJsonFileAtomicDurable(file, { value: 'slot' })
      writeFileSync(`${file}.bak`, JSON.stringify({ value: 'canonical' }))
      writeJsonFileAtomicDurable(file, { value: 'current' })
      const ownerPath = `${file}.bak-recovery-owner`
      if (mode === 'missing') unlinkSync(ownerPath)
      if (mode === 'corrupt') writeFileSync(ownerPath, '{broken')
      if (mode === 'replaced') writeFileSync(ownerPath, JSON.stringify({ token: '22222222-2222-4222-8222-222222222222' }))
      writeFileSync(file, '{broken')

      expect(readJsonFileSafe<{ value: string }>(file)).toEqual({ value: 'canonical' })
    }
  })

  test('Given owner 文件是符号链接 When 主文件损坏 Then controlled slots 全部不可信', () => {
    if (process.platform === 'win32') return
    const file = join(root, 'room-owner-symlink.json')
    writeJsonFileAtomicDurable(file, { value: 'slot' })
    writeFileSync(`${file}.bak`, JSON.stringify({ value: 'canonical' }))
    writeJsonFileAtomicDurable(file, { value: 'current' })
    const ownerPath = `${file}.bak-recovery-owner`
    const externalOwner = join(root, 'external-owner.json')
    writeFileSync(externalOwner, JSON.stringify({ token: recoveryOwnerToken(file) }))
    unlinkSync(ownerPath)
    symlinkSync(externalOwner, ownerPath)
    writeFileSync(file, '{broken')

    expect(readJsonFileSafe<{ value: string }>(file)).toEqual({ value: 'canonical' })
  })

  test('Given legacy recovery slot 的 owner 匹配 When 主文件损坏 Then 兼容恢复并标记 recovered', () => {
    const file = join(root, 'room-legacy.json')
    const token = '11111111-1111-4111-8111-111111111111'
    writeFileSync(`${file}.bak-recovery-owner`, JSON.stringify({ token }))
    writeRecoveryEnvelope(legacyRecoverySlotPath(file, 'a'), token, 1, { value: 'legacy' })
    writeFileSync(file, '{broken')

    const result = readJsonFileSafeDetailed<{ value: string }>(file)
    expect(result).toEqual({ value: { value: 'legacy' }, status: 'recovered' })
  })

  test('Given legacy recovery slot 的 owner token 不匹配 When 主文件损坏 Then 拒绝恢复', () => {
    const file = join(root, 'room-legacy-mismatch.json')
    writeFileSync(`${file}.bak-recovery-owner`, JSON.stringify({ token: '11111111-1111-4111-8111-111111111111' }))
    writeRecoveryEnvelope(
      legacyRecoverySlotPath(file, 'a'),
      '22222222-2222-4222-8222-222222222222',
      999,
      { value: 'forged' },
    )
    writeFileSync(file, '{broken')

    const result = readJsonFileSafeDetailed(file)
    expect(result.value).toBeNull()
    expect(result.status).toBe('corrupt')
  })

  test('Given legacy recovery slot 但 owner 缺失、损坏或符号链接 When 主文件损坏 Then 不信任 legacy', () => {
    const modes = ['missing', 'corrupt', 'symlink'] as const
    for (const mode of modes) {
      if (mode === 'symlink' && process.platform === 'win32') continue
      const file = join(root, `room-legacy-owner-${mode}.json`)
      const token = '11111111-1111-4111-8111-111111111111'
      const ownerPath = `${file}.bak-recovery-owner`
      writeRecoveryEnvelope(legacyRecoverySlotPath(file, 'a'), token, 1, { value: 'forged' })
      if (mode === 'corrupt') writeFileSync(ownerPath, '{broken')
      if (mode === 'symlink') {
        const externalOwner = join(root, `external-owner-${mode}.json`)
        writeFileSync(externalOwner, JSON.stringify({ token }))
        symlinkSync(externalOwner, ownerPath)
      }
      writeFileSync(file, '{broken')

      const result = readJsonFileSafeDetailed(file)
      expect(result.value).toBeNull()
      expect(result.status).toBe('corrupt')
    }
  })

  test('Given 一个可信槽和一个外部占用槽 When 写入下一代失败 Then 保留唯一可信槽和外部文件', () => {
    const file = join(root, 'room-external-slot.json')
    writeJsonFileAtomicDurable(file, { value: 'one' })
    writeFileSync(`${file}.bak`, JSON.stringify({ value: 'canonical' }))
    writeJsonFileAtomicDurable(file, { value: 'two' })

    const token = recoveryOwnerToken(file)
    const externalSlot = recoverySlotPath(file, token, 'b')
    writeFileSync(externalSlot, 'external slot')
    expect(() => writeJsonFileAtomicDurable(file, { value: 'three' })).toThrow()

    expect(readFileSync(externalSlot, 'utf8')).toBe('external slot')
    writeFileSync(file, '{broken')
    expect(readJsonFileSafe<{ value: string }>(file)).toEqual({ value: 'one' })
  })

  test('Given sparse 巨型 owner-like 文件 When 安全读取 Then 不分配巨型 Buffer 且 fail closed', () => {
    const file = join(root, 'sparse.json')
    const fd = openSync(file, 'w')
    try {
      ftruncateSync(fd, 8 * 1024 * 1024)
    } finally {
      closeSync(fd)
    }

    expect(readJsonFileSafe(file)).toBeNull()
  })
})
