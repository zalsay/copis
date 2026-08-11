import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_SKILL_SLUG_ALIASES,
  RETIRED_DEFAULT_SKILL_SLUGS,
  isRetiredDefaultSkill,
  migrateLegacyConfigDirectory,
  migrateLegacySkillSlugDirectory,
  resolveConfigDirName,
} from './config-paths'

describe('Electron 配置目录改名迁移', () => {
  test('Given COPIS_DEV=1 When 解析配置目录 Then 使用新的开发目录', () => {
    expect(resolveConfigDirName({ copisDev: '1', isPackaged: true })).toBe('.copis-dev')
  })

  test('Given 只有旧开发目录 When 迁移配置 Then 重命名到新的开发目录', () => {
    const home = mkdtempSync(join(tmpdir(), 'copis-config-paths-'))
    const legacyDir = join(home, '.proma-dev')
    const targetDir = join(home, '.copis-dev')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'marker.txt'), 'legacy', 'utf-8')

    try {
      migrateLegacyConfigDirectory(home, '.copis-dev')

      expect(existsSync(legacyDir)).toBe(false)
      expect(readFileSync(join(targetDir, 'marker.txt'), 'utf-8')).toBe('legacy')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('Given COPIS_DEV 未设置且 PROMA_DEV=1 When 解析配置目录 Then 仍使用新的开发目录', () => {
    expect(resolveConfigDirName({ promaDev: '1', isPackaged: true })).toBe('.copis-dev')
  })

  test('Given 新旧目录同时存在 When 迁移配置 Then 保留新目录且不覆盖内容', () => {
    const home = mkdtempSync(join(tmpdir(), 'copis-config-paths-'))
    const legacyDir = join(home, '.proma')
    const targetDir = join(home, '.copis')
    mkdirSync(legacyDir, { recursive: true })
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(legacyDir, 'marker.txt'), 'legacy', 'utf-8')
    writeFileSync(join(targetDir, 'marker.txt'), 'copis', 'utf-8')

    try {
      migrateLegacyConfigDirectory(home, '.copis')

      expect(existsSync(legacyDir)).toBe(true)
      expect(readFileSync(join(targetDir, 'marker.txt'), 'utf-8')).toBe('copis')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('Given 工作区存在旧版默认 Skill When 迁移 slug Then 改为 Copis slug 且保留内容', () => {
    const home = mkdtempSync(join(tmpdir(), 'copis-config-paths-'))
    const legacyDir = join(home, 'proma-coach')
    const targetDir = join(home, 'copis-coach')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'SKILL.md'), 'legacy skill', 'utf-8')

    try {
      migrateLegacySkillSlugDirectory(home, 'proma-coach', 'copis-coach')

      expect(existsSync(legacyDir)).toBe(false)
      expect(readFileSync(join(targetDir, 'SKILL.md'), 'utf-8')).toBe('legacy skill')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('Given 已下线的默认 Skill When 判断内置状态 Then 旧名和当前名都不再属于内置', () => {
    expect(RETIRED_DEFAULT_SKILL_SLUGS).toEqual(expect.arrayContaining([
      'agent-collaboration',
      'guizang-ppt-skill',
      'tool-builder',
      'docx',
      'pptx',
      'xlsx',
      'copis-coach',
      'proma-coach',
      'alipay-ai-buyer-agent',
    ]))
    expect(DEFAULT_SKILL_SLUG_ALIASES).toContainEqual({ legacy: 'proma-coach', canonical: 'copis-coach' })
    expect(isRetiredDefaultSkill('copis-coach')).toBe(true)
    expect(isRetiredDefaultSkill('proma-coach')).toBe(true)
    expect(isRetiredDefaultSkill('alipay-ai-buyer-agent')).toBe(true)
    expect(isRetiredDefaultSkill('automation')).toBe(false)
  })
})
