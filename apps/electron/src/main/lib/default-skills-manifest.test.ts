import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_SKILLS_DIR = join(import.meta.dir, '../../../default-skills')
const RETIRED_BUNDLED_SKILLS = new Set([
  'agent-collaboration',
  'guizang-ppt-skill',
  'tool-builder',
  'docx',
  'pptx',
  'xlsx',
  'copis-coach',
])

function readFrontmatter(skillSlug: string): Map<string, string> {
  const content = readFileSync(join(DEFAULT_SKILLS_DIR, skillSlug, 'SKILL.md'), 'utf8')
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match?.[1]) throw new Error(`Skill ${skillSlug} 缺少 frontmatter`)

  return new Map(
    match[1]
      .split('\n')
      .map((line) => {
        const separator = line.indexOf(':')
        return separator === -1
          ? null
          : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as const
      })
      .filter((entry): entry is readonly [string, string] => entry !== null),
  )
}

function bundledSkillSlugs(): string[] {
  return readdirSync(DEFAULT_SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

describe('默认 Skills 清单', () => {
  test('退役 Skill 不再进入 bundled default-skills', () => {
    const bundled = new Set(bundledSkillSlugs())

    for (const slug of RETIRED_BUNDLED_SKILLS) {
      expect(bundled.has(slug)).toBe(false)
    }
  })

  test('每个保留的默认 Skill 都有分组', () => {
    const ungrouped = bundledSkillSlugs().filter((slug) => !readFrontmatter(slug).get('group'))

    expect(ungrouped).toEqual([])
  })

  test('每个保留的默认 Skill 都有中文展示名', () => {
    const missingDisplayNames = bundledSkillSlugs().filter((slug) => !readFrontmatter(slug).get('displayName'))

    expect(missingDisplayNames).toEqual([])
  })

  test('Office 文档统一使用系统内置 officecli Skill', () => {
    const bundled = new Set(bundledSkillSlugs())
    expect(bundled.has('officecli')).toBe(true)

    const frontmatter = readFrontmatter('officecli')
    expect(frontmatter.get('name')).toBe('officecli')
    expect(frontmatter.get('group')).toBe('系统内置')
    expect(frontmatter.get('version')?.replace(/^['"]|['"]$/g, '')).toMatch(/^\d+\.\d+\.\d+$/)

    const content = readFileSync(join(DEFAULT_SKILLS_DIR, 'officecli', 'SKILL.md'), 'utf8')
    expect(content).toContain('github.com/iOfficeAI/OfficeCLI')
    expect(content).toContain('.docx')
    expect(content).toContain('.xlsx')
    expect(content).toContain('.pptx')
  })

  test('OfficeCLI 模块安装只由 Electron 管理，Skill 不提供安装命令', () => {
    const content = readFileSync(join(DEFAULT_SKILLS_DIR, 'officecli', 'SKILL.md'), 'utf8')

    expect(content).toContain('Electron')
    expect(content).toContain('功能模块')
    expect(content).not.toContain('install.sh')
    expect(content).not.toContain('install.ps1')
    expect(content).not.toContain('Other Agent Runtimes')
  })
})
