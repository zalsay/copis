import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ensureSkillDirectoryFrontmatter,
  ensureSkillPathsSanitized,
  extractDescriptionFromMarkdownBody,
  parseSkillFrontmatterInfo,
  sanitizeSkillDescription,
  sanitizeSkillName,
} from './skill-sanitizer'

describe('Skill 元数据自愈工具 (skill-sanitizer)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = join(tmpdir(), `copis-skill-sanitizer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Given 无 frontmatter 但同目录下有 metadata.json 的技能 When 执行自愈 Then 自动补齐标准 frontmatter 并提取描述', () => {
    const skillDir = join(tempDir, 'zhoubao-yuebao')
    mkdirSync(skillDir, { recursive: true })

    const skillMd = join(skillDir, 'SKILL.md')
    writeFileSync(
      skillMd,
      '# 周报/月报生成 Skill\n\n一键生成结构化周报、月报、项目报告与会议纪要。',
      'utf-8',
    )

    const metaJson = join(skillDir, 'metadata.json')
    writeFileSync(
      metaJson,
      JSON.stringify({
        name: 'weekly-report',
        displayName: '周报月报生成',
        description: '一键生成结构化周报/月报，基于飞书云文档格式输出',
        version: '1.0.0',
      }),
      'utf-8',
    )

    const changed = ensureSkillDirectoryFrontmatter(skillDir, 'zhoubao-yuebao')
    expect(changed).toBe(true)

    const parsed = parseSkillFrontmatterInfo(readFileSync(skillMd, 'utf-8'))
    expect(parsed.hasFrontmatter).toBe(true)
    expect(parsed.name).toBe('weekly-report')
    expect(parsed.displayName).toBe('周报月报生成')
    expect(parsed.description).toBe('一键生成结构化周报/月报，基于飞书云文档格式输出')
    expect(parsed.version).toBe('1.0.0')
    expect(parsed.body).toContain('# 周报/月报生成 Skill')
  })

  test('Given 已有 frontmatter 但缺少 description 字段的 SKILL.md When 执行自愈 Then 保留原有字段并自动追加 description', () => {
    const skillDir = join(tempDir, 'legacy-skill')
    mkdirSync(skillDir, { recursive: true })

    const skillMd = join(skillDir, 'SKILL.md')
    writeFileSync(
      skillMd,
      '---\nname: legacy-skill\nversion: 2.1.0\n---\n\n> 这是一个遗留系统的操作技能文档\n\n正文内容...',
      'utf-8',
    )

    const changed = ensureSkillDirectoryFrontmatter(skillDir, 'legacy-skill')
    expect(changed).toBe(true)

    const parsed = parseSkillFrontmatterInfo(readFileSync(skillMd, 'utf-8'))
    expect(parsed.hasFrontmatter).toBe(true)
    expect(parsed.name).toBe('legacy-skill')
    expect(parsed.description).toBe('这是一个遗留系统的操作技能文档')
  })

  test('Given 无 frontmatter 且无外部 json 仅有纯 Markdown 正文 When 执行自愈 Then 从正文提取摘要作为 description', () => {
    const skillDir = join(tempDir, 'pure-markdown-skill')
    mkdirSync(skillDir, { recursive: true })

    const skillMd = join(skillDir, 'SKILL.md')
    writeFileSync(
      skillMd,
      '# 纯 Markdown 技能\n\n```bash\necho "ignore code blocks"\n```\n\n这是一个用于自动化部署和构建的前端流水线技能。\n\n- 步骤1\n- 步骤2',
      'utf-8',
    )

    const changed = ensureSkillDirectoryFrontmatter(skillDir, 'pure-markdown-skill')
    expect(changed).toBe(true)

    const parsed = parseSkillFrontmatterInfo(readFileSync(skillMd, 'utf-8'))
    expect(parsed.hasFrontmatter).toBe(true)
    expect(parsed.name).toBe('pure-markdown-skill')
    expect(parsed.description).toBe('这是一个用于自动化部署和构建的前端流水线技能。')
  })

  test('Given 描述超长（> 1024 字符） When 执行 sanitizeSkillDescription Then 严格截断在 1024 字符以内', () => {
    const longText = 'A'.repeat(1500)
    const sanitized = sanitizeSkillDescription(longText)
    expect(sanitized.length).toBe(1024)
  })

  test('Given 不合规的技能名称（含大写和非法字符） When 执行 sanitizeSkillName Then 规范为小写连字符形式', () => {
    expect(sanitizeSkillName('My_Awesome_Skill#1', 'fallback')).toBe('my-awesome-skill-1')
    expect(sanitizeSkillName('---leading-trailing---', 'fallback')).toBe('leading-trailing')
    expect(sanitizeSkillName('', 'default-slug')).toBe('default-slug')
  })

  test('Given 已经合规且包含有效 description 的 SKILL.md When 执行自愈 Then 返回 false 且不重复修改文件', () => {
    const skillDir = join(tempDir, 'valid-skill')
    mkdirSync(skillDir, { recursive: true })

    const skillMd = join(skillDir, 'SKILL.md')
    const originalContent = '---\nname: valid-skill\ndescription: "Already valid description"\n---\n\n# Valid Skill'
    writeFileSync(skillMd, originalContent, 'utf-8')

    const changed = ensureSkillDirectoryFrontmatter(skillDir, 'valid-skill')
    expect(changed).toBe(false)
    expect(readFileSync(skillMd, 'utf-8')).toBe(originalContent)
  })

  test('Given 包含多个子技能目录的技能父根路径 When 批量调用 ensureSkillPathsSanitized Then 自动修复子目录中的异常技能', () => {
    const skillsRoot = join(tempDir, 'skills')
    const brokenDir1 = join(skillsRoot, 'skill-1')
    const brokenDir2 = join(skillsRoot, 'skill-2')
    mkdirSync(brokenDir1, { recursive: true })
    mkdirSync(brokenDir2, { recursive: true })

    writeFileSync(join(brokenDir1, 'SKILL.md'), '# Skill 1\n\nSkill 1 描述内容。', 'utf-8')
    writeFileSync(join(brokenDir2, 'SKILL.md'), '---\nname: skill-2\n---\n\nSkill 2 描述内容。', 'utf-8')

    ensureSkillPathsSanitized([skillsRoot])

    const parsed1 = parseSkillFrontmatterInfo(readFileSync(join(brokenDir1, 'SKILL.md'), 'utf-8'))
    const parsed2 = parseSkillFrontmatterInfo(readFileSync(join(brokenDir2, 'SKILL.md'), 'utf-8'))

    expect(parsed1.description).toBe('Skill 1 描述内容。')
    expect(parsed2.description).toBe('Skill 2 描述内容。')
  })
})
