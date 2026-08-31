import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BrowserLocatorBundle, BrowserWorkflowRunSummary, BrowserWorkflowVersion } from '@copis/shared'

type WorkflowStoreModule = typeof import('./browser-workflow-store')
let store: WorkflowStoreModule
let tempDir: string
let workflowRoot: string
let browserWorkflowRoot: string
let primaryUnavailable = false

mock.module('./config-paths', () => ({
  getWorkspaceBrowserWorkflowsDir: (slug: string) => join(workflowRoot, slug),
}))

mock.module('./agent-workspace-manager', () => ({
  getAgentWorkspaceBrowserWorkflowsDir: () => {
    if (primaryUnavailable) throw new Error('本地项目根目录不可用')
    return browserWorkflowRoot
  },
  getAgentWorkspace: (workspaceId: string) => workspaceId === 'workspace-1'
    ? { id: workspaceId, slug: 'demo-workspace' }
    : undefined,
}))

const locator: BrowserLocatorBundle = {
  framePath: { frameIds: [] },
  strategies: [{ kind: 'id', value: 'email' }],
  fingerprint: { tagName: 'input', inputType: 'text', visible: true, enabled: true },
}

function writeLegacyWorkflow(workflowId: string): void {
  const dir = join(workflowRoot, 'demo-workspace', workflowId)
  const version = createVersion(workflowId)
  mkdirSync(join(dir, 'versions'), { recursive: true })
  writeFileSync(join(dir, 'workflow.json'), JSON.stringify({
    schemaVersion: 1,
    id: workflowId,
    workspaceId: 'workspace-1',
    workspaceSlug: 'demo-workspace',
    name: '历史 Workflow',
    status: 'ready',
    currentVersion: 1,
    profileId: 'copis-web',
    allowedOrigins: ['https://example.com'],
    unattendedAllowed: false,
    createdAt: version.createdAt,
    updatedAt: version.createdAt,
  }))
  writeFileSync(join(dir, 'versions', 'v1.json'), JSON.stringify(version))
}

function createVersion(workflowId = 'workflow-1'): BrowserWorkflowVersion {
  return {
    schemaVersion: 1 as const,
    workflowId,
    version: 1,
    sourceRecordingId: 'recording-1',
    start: { tabAlias: 'main', url: 'https://example.com/start', origin: 'https://example.com' },
    variables: [],
    steps: [{
      id: 'step-1',
      type: 'fill' as const,
      tabAlias: 'main',
      origin: 'https://example.com',
      target: locator,
      value: { kind: 'literal' as const, value: 'hello' },
    }],
    createdAt: Date.now(),
    createdBySessionId: 'session-1',
    approval: { status: 'approved' as const },
  }
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'copis-browser-workflow-store-'))
  workflowRoot = join(tempDir, 'browser-workflows')
  browserWorkflowRoot = join(tempDir, 'project', 'browser', 'browser-workflows')
  store = await import('./browser-workflow-store')
})

beforeEach(() => {
  primaryUnavailable = false
  rmSync(workflowRoot, { recursive: true, force: true })
  rmSync(browserWorkflowRoot, { recursive: true, force: true })
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('Browser Workflow 存储', () => {
  test('Given 用户批准版本 When 保存 Then 生成 manifest、版本文件和可读取列表', () => {
    const manifest = store.saveBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      name: '登录 Workflow',
      allowedOrigins: ['https://example.com'],
      version: createVersion(),
    })

    expect(manifest.status).toBe('ready')
    expect(store.listBrowserWorkflows('workspace-1')).toHaveLength(1)
    expect(store.getBrowserWorkflow('workspace-1', 'workflow-1').version.version).toBe(1)
    expect(existsSync(join(browserWorkflowRoot, 'workflow-1', 'versions', 'v1.json'))).toBe(true)
    const savedVersion = store.getBrowserWorkflow('workspace-1', 'workflow-1').version
    expect(savedVersion.approval.playwrightScriptSha256).toBeUndefined()
    expect(existsSync(join(browserWorkflowRoot, 'workflow-1', 'playwright'))).toBe(false)
  })

  test('Given Agent 已提交待审核总结 When 写入草稿 Markdown Then 工作区保留可读 draft.md', () => {
    const draft: BrowserWorkflowVersion = {
      ...createVersion(),
      approval: { status: 'pending', draftHash: 'a'.repeat(64) },
    }

    store.writeBrowserWorkflowDraftMarkdown('workspace-1', draft)

    const draftPath = join(browserWorkflowRoot, 'workflow-1', 'draft.md')
    expect(existsSync(draftPath)).toBe(true)
    expect(readFileSync(draftPath, 'utf8')).toContain('# 待审核 Browser Workflow')
    expect(readFileSync(draftPath, 'utf8')).toContain('状态：待审核')
    expect(readFileSync(draftPath, 'utf8')).toContain('来源录制：`recording-1`')
    expect(readFileSync(draftPath, 'utf8')).toContain('### 1. fill')
    expect(existsSync(join(browserWorkflowRoot, 'workflow-1', 'workflow.md'))).toBe(false)
    expect(existsSync(join(browserWorkflowRoot, 'workflow-1', 'playwright', 'draft.mjs'))).toBe(false)
  })

  test('Given 用户确认待审核总结 When 提升草稿 Markdown Then 仅保留带名称的 workflow.md', () => {
    const draft: BrowserWorkflowVersion = {
      ...createVersion(),
      approval: { status: 'pending', draftHash: 'a'.repeat(64) },
    }
    store.writeBrowserWorkflowDraftMarkdown('workspace-1', draft)
    store.saveBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      name: '登录 Workflow',
      description: '登录后填写账户资料',
      allowedOrigins: ['https://example.com'],
      version: createVersion(),
    })

    store.promoteBrowserWorkflowDraftMarkdown('workspace-1', 'workflow-1')

    const workflowPath = join(browserWorkflowRoot, 'workflow-1', 'workflow.md')
    expect(existsSync(workflowPath)).toBe(true)
    expect(existsSync(join(browserWorkflowRoot, 'workflow-1', 'draft.md'))).toBe(false)
    expect(readFileSync(workflowPath, 'utf8')).toContain('# 登录 Workflow')
    expect(readFileSync(workflowPath, 'utf8')).toContain('状态：已确认')
    expect(readFileSync(workflowPath, 'utf8')).toContain('登录后填写账户资料')
  })

  test('Given 已保存版本 When 再保存同一 Workflow Then 旧版本不变并追加新版本', () => {
    store.saveBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      name: '登录 Workflow',
      allowedOrigins: ['https://example.com'],
      version: createVersion(),
    })
    const second = store.saveBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-2',
      name: '登录 Workflow v2',
      allowedOrigins: ['https://example.com'],
      version: { ...createVersion(), createdBySessionId: 'session-2' },
    })

    expect(second.currentVersion).toBe(2)
    expect(store.getBrowserWorkflow('workspace-1', 'workflow-1', 1).version.createdBySessionId).toBe('session-1')
    expect(store.getBrowserWorkflow('workspace-1', 'workflow-1', 2).version.createdBySessionId).toBe('session-2')
  })

  test('Given 不可信 Workflow ID When 读取或写入 Then 拒绝路径穿越', () => {
    expect(() => store.getBrowserWorkflow('workspace-1', '../outside')).toThrow('ID 不合法')
    expect(() => store.saveBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      name: '不安全',
      allowedOrigins: ['https://example.com'],
      version: createVersion('../outside'),
    })).toThrow('ID 不合法')
  })

  test('Given 新目录没有历史 Workflow When 读取或列出 Then 回退到旧 Copis 配置目录', () => {
    writeLegacyWorkflow('legacy-workflow')

    expect(store.getBrowserWorkflow('workspace-1', 'legacy-workflow').version.workflowId).toBe('legacy-workflow')
    expect(store.listBrowserWorkflows('workspace-1').map((item) => item.manifest.id)).toContain('legacy-workflow')
  })

  test('Given 本地项目根不可用且存在历史 Workflow When 读取或列出 Then 仍回退到旧 Copis 配置目录', () => {
    writeLegacyWorkflow('legacy-workflow')
    primaryUnavailable = true

    expect(store.getBrowserWorkflow('workspace-1', 'legacy-workflow').version.workflowId).toBe('legacy-workflow')
    expect(store.listBrowserWorkflows('workspace-1').map((item) => item.manifest.id)).toContain('legacy-workflow')
  })

  test('Given 历史 Workflow When 新目录写入最新运行摘要 Then 列表显示该摘要', () => {
    writeLegacyWorkflow('legacy-workflow')
    const latestRun: BrowserWorkflowRunSummary = {
      runId: 'run-1',
      workflowId: 'legacy-workflow',
      version: 1,
      status: 'completed',
      startedAt: Date.now() - 1_000,
      finishedAt: Date.now(),
    }

    store.saveLatestBrowserWorkflowRun('workspace-1', 'legacy-workflow', latestRun)

    expect(store.listBrowserWorkflows('workspace-1').find((item) => item.manifest.id === 'legacy-workflow')?.latestRun).toEqual(latestRun)
    expect(existsSync(join(browserWorkflowRoot, 'legacy-workflow', 'latest-run.json'))).toBe(true)
  })

  test('Given 历史 Workflow When 保存后续版本 Then 新目录续存版本且旧版本仍可读取', () => {
    writeLegacyWorkflow('legacy-workflow')

    const manifest = store.saveBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-2',
      name: '历史 Workflow 修复版',
      allowedOrigins: ['https://example.com'],
      version: { ...createVersion('legacy-workflow'), createdBySessionId: 'session-2' },
    })

    expect(manifest.currentVersion).toBe(2)
    expect(store.getBrowserWorkflow('workspace-1', 'legacy-workflow', 1).version.createdBySessionId).toBe('session-1')
    expect(store.getBrowserWorkflow('workspace-1', 'legacy-workflow', 2).version.createdBySessionId).toBe('session-2')
    expect(existsSync(join(browserWorkflowRoot, 'legacy-workflow', 'versions', 'v2.json'))).toBe(true)
  })

  test('Given 运行诊断 When 写入超限 artifact Then 保存脱敏文件并拒绝超大内容', () => {
    store.saveBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      name: '登录 Workflow',
      allowedOrigins: ['https://example.com'],
      version: createVersion(),
    })

    const path = store.writeBrowserWorkflowArtifact('workspace-1', 'workflow-1', 'run-1', 'failure.json', '{"text":"redacted"}')
    expect(path).toBe('artifacts/run-1/failure.json')
    expect(readFileSync(join(browserWorkflowRoot, 'workflow-1', path!), 'utf8')).toContain('redacted')
    expect(store.writeBrowserWorkflowArtifact(
      'workspace-1',
      'workflow-1',
      'run-1',
      'too-large.bin',
      new Uint8Array(2 * 1024 * 1024 + 1),
    )).toBeUndefined()
  })

  test('Given 运行步骤事件 When 追加 Then 以 JSONL 形式保留事件顺序', () => {
    store.saveBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      name: '登录 Workflow',
      allowedOrigins: ['https://example.com'],
      version: createVersion(),
    })
    const base = {
      runId: 'run-1',
      workflowId: 'workflow-1',
      version: 1,
      timestamp: Date.now(),
      status: 'running' as const,
    }
    store.appendBrowserWorkflowRunEvent('workspace-1', 'workflow-1', { ...base, type: 'started' })
    store.appendBrowserWorkflowRunEvent('workspace-1', 'workflow-1', { ...base, type: 'completed', timestamp: base.timestamp + 1, status: 'completed' })

    const path = join(browserWorkflowRoot, 'workflow-1', 'runs', 'run-1.jsonl')
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  test('Given 历史版本包含 playwrightScriptSha256 When 读取 Workflow Then 原样保留 hash 且 steps 不变', () => {
    const dir = join(workflowRoot, 'demo-workspace', 'legacy-hashed')
    const legacyVersion: BrowserWorkflowVersion = {
      ...createVersion('legacy-hashed'),
      approval: {
        status: 'approved',
        playwrightScriptSha256: 'a'.repeat(64),
      },
    }
    mkdirSync(join(dir, 'versions'), { recursive: true })
    writeFileSync(join(dir, 'workflow.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'legacy-hashed',
      workspaceId: 'workspace-1',
      workspaceSlug: 'demo-workspace',
      name: '带旧 Hash 的历史 Workflow',
      status: 'ready',
      currentVersion: 1,
      profileId: 'copis-web',
      allowedOrigins: ['https://example.com'],
      unattendedAllowed: false,
      createdAt: legacyVersion.createdAt,
      updatedAt: legacyVersion.createdAt,
    }))
    writeFileSync(join(dir, 'versions', 'v1.json'), JSON.stringify(legacyVersion))

    const loaded = store.getBrowserWorkflow('workspace-1', 'legacy-hashed')
    expect(loaded.manifest.id).toBe('legacy-hashed')
    expect(loaded.version.approval.playwrightScriptSha256).toBe('a'.repeat(64))
    expect(loaded.version.steps).toEqual(legacyVersion.steps)
  })

  test('Given 输入版本包含旧版 playwrightScriptSha256 When 保存新版本 Then 清除旧运行产物 hash 字段', () => {
    const legacyInputVersion: BrowserWorkflowVersion = {
      ...createVersion('legacy-clean-test'),
      approval: {
        status: 'approved',
        playwrightScriptSha256: 'b'.repeat(64),
      },
    }
    store.saveBrowserWorkflow({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      name: '新保存 Workflow',
      allowedOrigins: ['https://example.com'],
      version: legacyInputVersion,
    })

    const loaded = store.getBrowserWorkflow('workspace-1', 'legacy-clean-test')
    expect(loaded.version.approval.playwrightScriptSha256).toBeUndefined()
    expect(existsSync(join(browserWorkflowRoot, 'legacy-clean-test', 'playwright'))).toBe(false)
  })
})
