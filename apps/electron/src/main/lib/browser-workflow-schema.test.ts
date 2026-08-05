import { describe, expect, test } from 'bun:test'
import {
  assertBrowserWorkflowManifest,
  assertBrowserWorkflowVersion,
  validateBrowserWorkflowVersion,
} from './browser-workflow-schema'

const locator = {
  framePath: { frameIds: [] },
  strategies: [{ kind: 'id', value: 'email' }],
  fingerprint: {
    tagName: 'input',
    inputType: 'text',
    visible: true,
    enabled: true,
  },
}

const version = {
  schemaVersion: 1,
  workflowId: 'workflow-1',
  version: 1,
  start: { tabAlias: 'main', url: 'https://example.com', origin: 'https://example.com' },
  variables: [],
  steps: [
    {
      id: 'step-1',
      type: 'fill',
      tabAlias: 'main',
      origin: 'https://example.com',
      target: locator,
      value: { kind: 'literal', value: 'hello' },
    },
  ],
  createdAt: Date.now(),
  createdBySessionId: 'session-1',
  approval: { status: 'pending' },
}

const manifest = {
  schemaVersion: 1,
  id: 'workflow-1',
  workspaceId: 'workspace-1',
  name: '示例 Workflow',
  status: 'draft',
  currentVersion: 1,
  profileId: 'copis-web',
  allowedOrigins: ['https://example.com'],
  unattendedAllowed: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

describe('Browser Workflow schema', () => {
  test('Given 可选 urlPattern 缺失 When 校验步骤 Then 版本有效', () => {
    expect(validateBrowserWorkflowVersion(version).valid).toBe(true)
    expect(assertBrowserWorkflowVersion(version).workflowId).toBe('workflow-1')
  })

  test('Given 页面路径 Origin When 校验 Then 拒绝带路径的 Origin', () => {
    const invalid = {
      ...manifest,
      allowedOrigins: ['https://example.com/path'],
    }
    expect(() => assertBrowserWorkflowManifest(invalid)).toThrow('Origin')
  })

  test('Given 跨页签 openTab When 校验 Then 新别名可在后续步骤使用', () => {
    const multiPage = {
      ...version,
      steps: [
        {
          id: 'step-open',
          type: 'openTab',
          tabAlias: 'detail',
          newTabAlias: 'detail',
          origin: 'https://example.com',
        },
        {
          ...version.steps[0],
          id: 'step-detail',
          tabAlias: 'detail',
        },
      ],
    }
    expect(validateBrowserWorkflowVersion(multiPage).valid).toBe(true)
  })

  test('Given click 后紧接 navigate When 校验 Then 拒绝可能重复提交', () => {
    const invalid = {
      ...version,
      steps: [
        {
          id: 'step-click',
          type: 'click',
          tabAlias: 'main',
          origin: 'https://example.com',
          target: locator,
        },
        {
          id: 'step-navigate',
          type: 'navigate',
          tabAlias: 'main',
          origin: 'https://example.com',
          url: 'https://example.com/next',
        },
      ],
    }
    expect(validateBrowserWorkflowVersion(invalid).valid).toBe(false)
  })

  test('Given click 触发新页签 When 后续 openTab 未声明 outcome Then 拒绝重复创建', () => {
    const invalid = {
      ...version,
      steps: [
        {
          id: 'step-click',
          type: 'click',
          tabAlias: 'main',
          origin: 'https://example.com',
          target: locator,
        },
        {
          id: 'step-open',
          type: 'openTab',
          tabAlias: 'main',
          newTabAlias: 'detail',
          origin: 'https://example.com',
        },
      ],
    }
    expect(validateBrowserWorkflowVersion(invalid).valid).toBe(false)
  })
  test('Given navigate URL 与步骤 Origin 不一致 When 校验 Then 拒绝版本', () => {
    const invalid = {
      ...version,
      steps: [{
        id: 'step-navigate',
        type: 'navigate',
        tabAlias: 'main',
        origin: 'https://example.com',
        url: 'https://other.example.com/login',
      }],
    }
    expect(validateBrowserWorkflowVersion(invalid).valid).toBe(false)
  })
  test('Given 需要人工接管的敏感步骤 When 校验 Then 仅允许规定的原因', () => {
    const manual = {
      ...version,
      steps: [{
        id: 'step-manual',
        type: 'manual',
        tabAlias: 'main',
        origin: 'https://example.com',
        reason: 'password',
        instruction: '请完成登录',
      }],
    }
    expect(validateBrowserWorkflowVersion(manual).valid).toBe(true)
    expect(validateBrowserWorkflowVersion({
      ...manual,
      steps: [{ ...manual.steps[0], reason: 'executeScript' }],
    }).valid).toBe(false)
  })


  test('Given fill 引用变量 When 变量未声明 Then 拒绝版本', () => {
    const variableVersion = {
      ...version,
      variables: [{ key: 'email', label: '邮箱', type: 'string', required: true }],
      steps: [{
        ...version.steps[0],
        value: { kind: 'variable', variableKey: 'missing' },
      }],
    }
    expect(validateBrowserWorkflowVersion(variableVersion).valid).toBe(false)

    const validVersion = {
      ...variableVersion,
      steps: [{
        ...variableVersion.steps[0],
        value: { kind: 'variable', variableKey: 'email' },
      }],
    }
    expect(validateBrowserWorkflowVersion(validVersion).valid).toBe(true)
  })


  test('Given 重复步骤 ID When 校验 Then 返回明确错误', () => {
    const invalid = {
      ...version,
      steps: [version.steps[0], { ...version.steps[0] }],
    }
    const result = validateBrowserWorkflowVersion(invalid)
    expect(result.valid).toBe(false)
    expect(result.errors.some((error) => error.includes('重复'))).toBe(true)
  })

  test('Given click outcome When 匹配条件非法 Then 拒绝版本', () => {
    const invalidOutcome = {
      ...version,
      steps: [{
        id: 'step-click',
        type: 'click',
        tabAlias: 'main',
        origin: 'https://example.com',
        target: locator,
        expect: { type: 'navigation', urlPattern: '[' },
      }],
    }
    expect(validateBrowserWorkflowVersion(invalidOutcome).valid).toBe(false)
  })

  test('Given click 已声明 navigation outcome When 后续再次 navigate Then 拒绝重复副作用', () => {
    const invalid = {
      ...version,
      steps: [
        {
          id: 'step-click',
          type: 'click',
          tabAlias: 'main',
          origin: 'https://example.com',
          target: locator,
          expect: { type: 'navigation', urlPattern: 'https://example\\.com/next' },
        },
        {
          id: 'step-navigate',
          type: 'navigate',
          tabAlias: 'main',
          origin: 'https://example.com',
          url: 'https://example.com/next',
        },
      ],
    }
    const result = validateBrowserWorkflowVersion(invalid)
    expect(result.valid).toBe(false)
    expect(result.errors.some((error) => error.includes('重复'))).toBe(true)
  })
  test('Given assert visible 缺少目标 When 校验 Then 拒绝版本', () => {
    const invalidAssert = {
      ...version,
      steps: [{
        id: 'step-assert',
        type: 'assert',
        tabAlias: 'main',
        origin: 'https://example.com',
        condition: { type: 'visible' },
      }],
    }
    expect(validateBrowserWorkflowVersion(invalidAssert).valid).toBe(false)
  })

  test('Given 不安全 Profile ID When 校验 Then 拒绝版本清单', () => {
    expect(validateBrowserWorkflowVersion(version).valid).toBe(true)
    expect(validateBrowserWorkflowVersion({ ...version, approval: { status: 'pending', draftHash: 'bad' } }).valid).toBe(false)
    expect(() => assertBrowserWorkflowManifest({ ...manifest, profileId: '../shared' })).toThrow('profileId')
  })
})

