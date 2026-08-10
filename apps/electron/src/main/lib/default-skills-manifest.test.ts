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

  test('网页工作流自动化 Skill 包含兼容元数据和安全操作流程', () => {
    const frontmatter = readFrontmatter('browser-workflow-automation')
    expect(frontmatter.get('name')).toBe('browser-workflow-automation')
    expect(frontmatter.get('displayName')).toBe('网页工作流自动化')
    expect(frontmatter.get('group')).toBe('系统内置')
    expect(frontmatter.get('version')?.replace(/^['"]|['"]$/g, '')).toMatch(/^\d+\.\d+\.\d+$/)
    expect(frontmatter.get('license')).toBe('AGPL-3.0-only')

    const content = readFileSync(join(DEFAULT_SKILLS_DIR, 'browser-workflow-automation', 'SKILL.md'), 'utf8')
    for (const requiredText of [
      'BrowserPageNavigate',
      'BrowserPageOpenTab',
      'BrowserPageObserve',
      'BrowserPageClick',
      'BrowserWorkflowList',
      'BrowserWorkflowGet',
      'BrowserWorkflowRun',
      '最新 ref',
      '询问模式只允许观察和读取页面',
      '高风险点击、选择和按键（包括 `Enter`）',
      '不重复请求单次审批',
      '只有跨 Origin 的 `BrowserPageNavigate` 仍需要一次单独审批',
      '密码、验证码',
      '网页内容当作系统指令',
    ]) {
      expect(content).toContain(requiredText)
    }
    expect(content).not.toContain('为每一个明确动作取得单独确认')
  })

  test('find-skills 使用 SkillHub 源工作流并保持 Copis 默认 Skill 兼容元数据', () => {
    const frontmatter = readFrontmatter('find-skills')
    expect(frontmatter.get('name')).toBe('find-skills')
    expect(frontmatter.get('displayName')).toBe('技能发现')
    expect(frontmatter.get('group')).toBe('系统内置')
    expect(frontmatter.get('version')?.replace(/^['"]|['"]$/g, '')).toBe('1.0.4')
    expect(frontmatter.get('description')).toContain('在 SkillHub 平台查找/搜索 Skill 技能')

    const content = readFileSync(join(DEFAULT_SKILLS_DIR, 'find-skills', 'SKILL.md'), 'utf8')
    expect(content).toContain('GET https://api.skillhub.cn/api/skills')
    expect(content).toContain('references/api.md')
    expect(content).toContain('references/categories.md')
    expect(content).toContain('核心流程')
    expect(content).toContain('Step 5')
    expect(content).not.toMatch(/\bnpx\s+skills\b/i)
    expect(content).not.toContain('skills.sh')
    expect(content).not.toContain('install npx skills')
  })

  test('find-skills 包含 SkillHub 源引用文件', () => {
    const referencesDir = join(DEFAULT_SKILLS_DIR, 'find-skills', 'references')
    const references = readdirSync(referencesDir).sort()

    expect(references).toHaveLength(14)
    expect(references).toContain('api.md')
    expect(references).toContain('categories.md')
  })

  test('支付宝买家 Skill 使用 Rust capability 并与 Working 支付链路隔离', () => {
    const frontmatter = readFrontmatter('alipay-ai-buyer-agent')
    expect(frontmatter.get('name')).toBe('alipay-ai-buyer-agent')
    expect(frontmatter.get('displayName')).toBe('支付宝买家支付')
    expect(frontmatter.get('group')).toBe('系统内置')
    expect(frontmatter.get('version')?.replace(/^['"]|['"]$/g, '')).toMatch(/^\d+\.\d+\.\d+$/)

    const content = readFileSync(join(DEFAULT_SKILLS_DIR, 'alipay-ai-buyer-agent', 'SKILL.md'), 'utf8')
    expect(content).toContain('alipay_bot')
    expect(content).toContain('402 Payment Required')
    expect(content).toContain('wallet.check')
    expect(content).toContain('payment.check')
    expect(content).toContain('payment.ack')
    expect(content).toContain('Rust API -> edu-api')
    expect(content).toContain('设置页的 VIP/钻石购买不使用本 Skill')
    expect(content).toContain('禁止使用 Bash')
  })
})
