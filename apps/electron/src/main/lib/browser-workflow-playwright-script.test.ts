import { beforeAll, afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWorkflowVersion } from '@copis/shared'

const root = mkdtempSync(join(tmpdir(), 'copis-browser-workflow-playwright-'))

mock.module('./agent-workspace-manager', () => ({
  getAgentWorkspace: (workspaceId: string) => workspaceId === 'workspace-1'
    ? { id: workspaceId, slug: 'workflow-workspace' }
    : undefined,
  getAgentWorkspaceBrowserWorkflowsDir: () => root,
}))

let writeBrowserWorkflowPlaywrightDraft: typeof import('./browser-workflow-playwright-script')['writeBrowserWorkflowPlaywrightDraft']
let writeBrowserWorkflowPlaywrightVersion: typeof import('./browser-workflow-playwright-script')['writeBrowserWorkflowPlaywrightVersion']
let buildBrowserWorkflowPlaywrightScript: typeof import('./browser-workflow-playwright-script')['buildBrowserWorkflowPlaywrightScript']
let getBrowserWorkflowPlaywrightScriptSha256: typeof import('./browser-workflow-playwright-script')['getBrowserWorkflowPlaywrightScriptSha256']
let assertBrowserWorkflowPlaywrightScriptIntegrity: typeof import('./browser-workflow-playwright-script')['assertBrowserWorkflowPlaywrightScriptIntegrity']

beforeAll(async () => {
  const module = await import('./browser-workflow-playwright-script')
  writeBrowserWorkflowPlaywrightDraft = module.writeBrowserWorkflowPlaywrightDraft
  writeBrowserWorkflowPlaywrightVersion = module.writeBrowserWorkflowPlaywrightVersion
  buildBrowserWorkflowPlaywrightScript = module.buildBrowserWorkflowPlaywrightScript
  getBrowserWorkflowPlaywrightScriptSha256 = module.getBrowserWorkflowPlaywrightScriptSha256
  assertBrowserWorkflowPlaywrightScriptIntegrity = module.assertBrowserWorkflowPlaywrightScriptIntegrity
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

function createVersion(): BrowserWorkflowVersion {
  return {
    schemaVersion: 1,
    workflowId: 'workflow-1',
    version: 3,
    start: { tabAlias: 'main', url: 'https://example.com/start', origin: 'https://example.com' },
    variables: [{ key: 'sessionCookie', label: '会话 Cookie', type: 'string', required: true, sensitive: true }],
    steps: [{
      id: 'step-1',
      type: 'fill',
      tabAlias: 'main',
      origin: 'https://example.com',
      target: {
        framePath: { frameIds: [] },
        strategies: [{ kind: 'id', value: 'email' }],
        fingerprint: { tagName: 'input', inputType: 'text', visible: true, enabled: true },
      },
      value: { kind: 'variable', variableKey: 'sessionCookie' },
    }],
    createdAt: 1,
    createdBySessionId: 'session-1',
    approval: { status: 'approved' },
  }
}

describe('Browser Workflow Playwright 脚本', () => {
  test('Given 待审核版本 When 写入草稿 Then 生成可附着目标页且不携带运行变量的脚本', () => {
    const path = writeBrowserWorkflowPlaywrightDraft('workspace-1', createVersion())
    const source = readFileSync(path, 'utf8')

    expect(path).toBe(join(root, 'workflow-1', 'playwright', 'draft.mjs'))
    expect(source).toContain('connectOverCDP')
    expect(source).toContain('COPIS_PLAYWRIGHT_TARGET_ID')
    expect(source).toContain('COPIS_PLAYWRIGHT_CORE_ENTRY')
    expect(source).toContain('process.stdin.destroy()')
    expect(source).not.toContain('cookie-secret')
    expect(() => execFileSync('node', ['--check', path], { stdio: 'pipe' })).not.toThrow()
  })

  test('Given 已批准版本 When 写入脚本 Then 使用不可变版本文件名', () => {
    const path = writeBrowserWorkflowPlaywrightVersion('workspace-1', createVersion())

    expect(path).toBe(join(root, 'workflow-1', 'playwright', 'v3.mjs'))
  })

  test('Given 已确认脚本摘要 When 脚本被外部修改 Then 执行前拒绝运行', () => {
    const version = createVersion()
    const path = writeBrowserWorkflowPlaywrightVersion('workspace-1', version)
    expect(() => assertBrowserWorkflowPlaywrightScriptIntegrity(version, path))
      .toThrow('缺少 Playwright 脚本摘要')
    const approvedVersion = {
      ...version,
      approval: {
        ...version.approval,
        playwrightScriptSha256: getBrowserWorkflowPlaywrightScriptSha256(version),
      },
    }

    expect(() => assertBrowserWorkflowPlaywrightScriptIntegrity(approvedVersion, path)).not.toThrow()
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n// 外部修改\n`)

    expect(() => assertBrowserWorkflowPlaywrightScriptIntegrity(approvedVersion, path))
      .toThrow('Playwright Workflow 脚本校验失败')
  })

  test('Given playwright-core 是 CommonJS When 脚本加载驱动 Then 使用 createRequire 获取 chromium', () => {
    const source = buildBrowserWorkflowPlaywrightScript(createVersion())

    expect(source).toContain("import { createRequire } from 'node:module'")
    expect(source).toContain('createRequire(import.meta.url)')
    expect(source).toContain('requireFromScript(coreEntry)')
  })

  test('Given Electron DevTools 端点 When Playwright 连接 Then 使用 Node 原生 WebSocket transport', () => {
    const source = buildBrowserWorkflowPlaywrightScript(createVersion())

    expect(source).toContain('async function createCdpTransport')
    expect(source).toContain('chromium.connectOverCDP(transport)')
    expect(source).toContain('TextDecoder')
    expect(source).toContain('ignoredSessions')
    expect(source).toContain('void target.close')
  })

  test('Given 敏感 locator 使用固定值 When 生成脚本 Then 拒绝写出凭据内容', () => {
    const version = createVersion()
    const step = version.steps[0]
    if (step?.type !== 'fill') throw new Error('测试步骤类型错误')
    step.target.fingerprint.inputType = 'password'
    step.target.fingerprint.accessibleName = '登录密码'
    step.value = { kind: 'literal', value: 'password-secret' }

    expect(() => buildBrowserWorkflowPlaywrightScript(version)).toThrow('敏感页面目标')
  })

  test('Given click 后跳转到另一个允许 Origin When 生成脚本 Then navigation outcome 不锁定点击前 Origin', () => {
    const version = createVersion()
    const step = version.steps[0]
    if (step?.type !== 'fill') throw new Error('测试步骤类型错误')
    version.steps = [{
      id: 'step-click',
      type: 'click',
      tabAlias: 'main',
      origin: 'https://example.com',
      target: step.target,
      expect: { type: 'navigation', urlPattern: 'https://accounts.example.com/' },
    }]
    version.start = { tabAlias: 'main', url: 'https://example.com/start', origin: 'https://example.com' }
    const source = buildBrowserWorkflowPlaywrightScript(version)
    const navigationBlockStart = source.indexOf("if (step.expect.type === 'navigation')")
    const navigationBlock = source.slice(navigationBlockStart, navigationBlockStart + 500)

    expect(navigationBlock).toContain('workflow.allowedOrigins.includes(origin)')
    expect(navigationBlock).not.toContain('assertOrigin(page, step.origin)')
  })
})
