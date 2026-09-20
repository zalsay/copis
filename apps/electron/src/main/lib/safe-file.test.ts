import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFileSafe, writeJsonFileAtomicDurable } from './safe-file'

const root = join(process.env.TMPDIR ?? '/tmp', `copis-safe-file-${Date.now()}-${Math.random().toString(36).slice(2)}`)

beforeEach(() => mkdirSync(root, { recursive: true }))
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('聊天室 durable JSON writer', () => {
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
})
