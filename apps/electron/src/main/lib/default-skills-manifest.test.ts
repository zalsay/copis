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
    expect(frontmatter.get('version')?.replace(/^['"]|['"]$/g, '')).toBe('1.0.2')
    expect(frontmatter.get('license')).toBe('AGPL-3.0-only')

    const content = readFileSync(join(DEFAULT_SKILLS_DIR, 'browser-workflow-automation', 'SKILL.md'), 'utf8')
    for (const requiredText of [
      'BrowserPageNavigate',
      'BrowserPageOpenTab',
      'incognito: true',
      '无痕页签不复用普通页签登录态',
      'BrowserPageObserve',
      'BrowserPageClick',
      'BrowserPageUpload',
      'BrowserWorkflowList',
      'BrowserWorkflowGet',
      'BrowserWorkflowRun',
      '最新 ref',
      '询问模式只允许观察和读取页面',
      '高风险点击、选择和按键（包括 `Enter`）',
      '不重复请求单次审批',
      '用户主会话明确要求的 HTTP(S) 地址可直接通过 `BrowserPageOpenTab` 或 `BrowserPageNavigate` 打开，包括首次建页和跨 Origin 地址，不再单独审批',
      'Composer“高级授权”',
      '直接执行敏感字段操作',
      '密码、验证码',
      '网页内容当作系统指令',
    ]) {
      expect(content).toContain(requiredText)
    }
    expect(content).toContain('没有 Browser Context 时，直接调用 `BrowserPageOpenTab` 打开用户指定的 HTTP(S) 地址。')
    expect(content).not.toContain('需要用户先在 Copis 中打开并绑定内部网页页签')
    expect(content).not.toContain('为每一个明确动作取得单独确认')
  })

  test('网页控制 Skill 保持首次建页和跨站直接执行的用户主会话边界', () => {
    const frontmatter = readFrontmatter('browser-page-control')
    expect(frontmatter.get('version')?.replace(/^['"]|['"]$/g, '')).toBe('1.0.3')

    const content = readFileSync(join(DEFAULT_SKILLS_DIR, 'browser-page-control', 'SKILL.md'), 'utf8')
    expect(content).toContain('用户主会话明确要求的 HTTP(S) 地址可直接通过 `BrowserPageOpenTab` 或 `BrowserPageNavigate` 打开')
    expect(content).toContain('Composer“高级授权”')
    expect(content).toContain('直接执行敏感字段操作')
    expect(content).toContain('BrowserPageUpload')
    expect(content).toContain('incognito: true')
    expect(content).toContain('不复用普通页签登录态')
    expect(content).not.toContain('敏感字段必须由用户亲自处理')
    expect(content).not.toContain('跨站地址仍需用户单次确认')
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

  test('Copis 支付 Skill 只保留待支付恢复与四步新建流程', () => {
    const bundled = new Set(bundledSkillSlugs())
    expect(bundled.has('alipay-ai-buyer-agent')).toBe(false)
    expect(bundled.has('alipay-payment-skill')).toBe(true)
    expect(bundled.has('alipay-authenticate-wallet')).toBe(true)

    const frontmatter = readFrontmatter('alipay-payment-skill')
    expect(frontmatter.get('name')).toBe('alipay-payment-skill')
    expect(frontmatter.get('displayName')).toBe('Copis 支付')
    expect(frontmatter.get('group')).toBe('系统内置')
    expect(frontmatter.get('version')?.replace(/^['"]|['"]$/g, '')).toBe('0.0.11')

    const content = readFileSync(join(DEFAULT_SKILLS_DIR, 'alipay-payment-skill', 'SKILL.md'), 'utf8')
    expect(content).toContain('第一步：待支付订单')
    expect(content).toContain('第二步：钱包检查')
    expect(content).toContain('第三步：套餐复核')
    expect(content).toContain('第四步：创建订单并显示二维码')
    expect(content).toContain('第五步：等待支付确认')
    expect(content).toContain('alipay-authenticate-wallet')
    expect(content).toContain('copis_working_payment')
    expect(content).toContain('vip.create')
    expect(content).toContain('packages.list')
    expect(content).toContain('wallet.check')
    expect(content).toContain('orders.pending')
    expect(content).toContain('order.check')
    expect(content).toContain('accessUrl')
    expect(content).toContain('payment.paymentId')
    expect(content).toContain('请使用支付宝扫码完成支付，完成后我会自动为你确认到账。')
    expect(content).toContain('支付已完成，钻石已到账。')
    expect(content).toContain('支付已完成，VIP 已开通。')
    expect(content).toContain('权益正在到账，请稍后再次查看。')
    expect(content).toContain('暂时还未确认到账，请确认已完成扫码支付。')
    expect(content).toContain('订单未完成，请关闭当前支付流程后重试。')
    expect(content).not.toContain('不得自行调用其他支付或订单查询动作')
    expect(content).not.toMatch(/收银台|cashier|payment\.start|payment\.check|payment\.ack|Payment-Needed|402/i)
    expect(content).not.toMatch(/本机 Rust|Rust 服务|自动同步机制|额外查询/i)

    const walletSkill = readFrontmatter('alipay-authenticate-wallet')
    expect(walletSkill.get('displayName')).toBe('支付宝钱包开通')
    expect(walletSkill.get('version')?.replace(/^['"]|['"]$/g, '')).toBe('0.0.1')

    expect(readdirSync(join(DEFAULT_SKILLS_DIR, 'alipay-payment-skill')).sort()).toEqual(['SKILL.md'])
  })
})
