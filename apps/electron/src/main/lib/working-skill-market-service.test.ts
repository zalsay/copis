import AdmZip from 'adm-zip'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(tmpdir(), 'copis-test-documents'),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}))

const { extractWorkingSkillArchive } = await import('./working-skill-market-service')

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeDestination(): string {
  const root = mkdtempSync(join(tmpdir(), 'copis-market-archive-test-'))
  temporaryRoots.push(root)
  return root
}

describe('Working 技能市场安装包', () => {
  test('安全解压带根目录的 Skill ZIP', () => {
    const zip = new AdmZip()
    zip.addFile('weekly-report/SKILL.md', Buffer.from('---\nname: weekly-report\n---\n', 'utf8'))
    zip.addFile('weekly-report/scripts/run.ts', Buffer.from('console.log("ok")\n', 'utf8'))
    const destination = makeDestination()

    const skillRoot = extractWorkingSkillArchive(zip.toBuffer(), destination)

    expect(skillRoot).toBe(join(destination, 'weekly-report'))
    expect(readFileSync(join(skillRoot, 'SKILL.md'), 'utf8')).toContain('weekly-report')
    expect(existsSync(join(skillRoot, 'scripts', 'run.ts'))).toBe(true)
  })

  test('拒绝 ZIP Slip 路径并且不写出临时目录', () => {
    const zip = new AdmZip()
    zip.addFile('weekly-report/SKILL.md', Buffer.from('---\nname: weekly-report\n---\n', 'utf8'))
    zip.addFile('weekly-report/outside.txt', Buffer.from('blocked', 'utf8'))
    const maliciousEntry = zip.getEntries().find((entry) => entry.entryName.endsWith('outside.txt'))
    if (!maliciousEntry) throw new Error('测试 ZIP 缺少恶意条目')
    maliciousEntry.entryName = '../outside.txt'
    const destination = makeDestination()

    expect(() => extractWorkingSkillArchive(zip.toBuffer(), destination)).toThrow('不安全路径')
    expect(existsSync(join(destination, '..', 'outside.txt'))).toBe(false)
  })
})
