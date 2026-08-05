import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BrowserLocatorBundle, BrowserWorkflowVersion } from '@copis/shared'

type WorkflowStoreModule = typeof import('./browser-workflow-store')
let store: WorkflowStoreModule
let tempDir: string
let workflowRoot: string

mock.module('./config-paths', () => ({
  getWorkspaceBrowserWorkflowsDir: (slug: string) => join(workflowRoot, slug),
}))

mock.module('./agent-workspace-manager', () => ({
  getAgentWorkspace: (workspaceId: string) => workspaceId === 'workspace-1'
    ? { id: workspaceId, slug: 'demo-workspace' }
    : undefined,
}))

const locator: BrowserLocatorBundle = {
  framePath: { frameIds: [] },
  strategies: [{ kind: 'id', value: 'email' }],
  fingerprint: { tagName: 'input', inputType: 'text', visible: true, enabled: true },
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
  store = await import('./browser-workflow-store')
})

beforeEach(() => {
  rmSync(workflowRoot, { recursive: true, force: true })
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
    expect(existsSync(join(workflowRoot, 'demo-workspace', 'workflow-1', 'versions', 'v1.json'))).toBe(true)
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
    expect(readFileSync(join(workflowRoot, 'demo-workspace', 'workflow-1', path!), 'utf8')).toContain('redacted')
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

    const path = join(workflowRoot, 'demo-workspace', 'workflow-1', 'runs', 'run-1.jsonl')
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2)
  })
})
