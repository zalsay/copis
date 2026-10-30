import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FunctionalModuleStatus } from '@copis/shared'
import * as moduleUi from './functional-module-ui'
import {
  FUNCTIONAL_MODULE_DEFINITIONS,
  createEmptyFunctionalModuleStatus,
  getFunctionalModuleProgressText,
  getFunctionalModuleStateText,
} from './functional-module-ui'

describe('功能模块设置页模型', () => {
  test('Given 本地能力列表 When 生成设置页模型 Then 显示友好的能力名称', () => {
    expect(FUNCTIONAL_MODULE_DEFINITIONS.map((item) => item.name)).toEqual([
      'node-runtime',
      'rust-http-api',
      'officecli',
      'alipay-bot',
      'playwright-core',
      'python-runtime',
      'agently-cli',
      'dsh',
      'codex-cli',
      'chrome-desktop-cli',
    ])
    expect(FUNCTIONAL_MODULE_DEFINITIONS.find((item) => item.name === 'node-runtime')?.required).toBe(true)
    expect(FUNCTIONAL_MODULE_DEFINITIONS.find((item) => item.name === 'rust-http-api')?.required).toBe(true)
    expect(FUNCTIONAL_MODULE_DEFINITIONS.find((item) => item.name === 'officecli')?.required).toBe(true)
    expect(FUNCTIONAL_MODULE_DEFINITIONS.find((item) => item.name === 'alipay-bot')?.required).toBe(true)
    expect(FUNCTIONAL_MODULE_DEFINITIONS.find((item) => item.name === 'playwright-core')?.required).toBe(true)
    expect(FUNCTIONAL_MODULE_DEFINITIONS.find((item) => item.name === 'python-runtime')?.required).toBe(true)
    expect(FUNCTIONAL_MODULE_DEFINITIONS.find((item) => item.name === 'agently-cli')?.required).toBe(false)
    expect(FUNCTIONAL_MODULE_DEFINITIONS.find((item) => item.name === 'dsh')?.required).toBe(false)
    expect(FUNCTIONAL_MODULE_DEFINITIONS.find((item) => item.name === 'codex-cli')?.required).toBe(false)
    expect(FUNCTIONAL_MODULE_DEFINITIONS.map((item) => item.displayName)).toEqual([
      'Node.js 运行环境',
      '系统核心模块',
      'Office 文档支持',
      '支付宝智能体 CLI',
      '浏览器自动化内核',
      'Python 3.12 运行环境',
      'Agent QQ 邮箱 CLI',
      '创造模式',
      '专业模式',
      'MCC · Chrome 桌面自动化',
    ])
    expect(FUNCTIONAL_MODULE_DEFINITIONS.every((item) => !/Rust|HTTP|API|Electron/.test(`${item.displayName} ${item.description}`))).toBe(true)
  })

  test('Given 能力状态 When 生成状态文案 Then 覆盖错误、更新、已准备和未准备', () => {
    const status = createEmptyFunctionalModuleStatus(FUNCTIONAL_MODULE_DEFINITIONS[0]!)
    expect(getFunctionalModuleStateText(status)).toBe('尚未准备')
    expect(getFunctionalModuleStateText({ ...status, installed: true, version: '0.1.0' })).toBe('已准备好（v0.1.0）')
    expect(getFunctionalModuleStateText({
      ...status,
      installed: true,
      version: '0.1.0',
      updateAvailable: true,
      availableVersion: '0.2.0',
    })).toBe('已准备好（v0.1.0），可更新至 v0.2.0')
    expect(getFunctionalModuleStateText({ ...status, error: 'manifest 地址未配置' })).toBe('暂时无法准备，请重试')
  })

  test('Given 安装阶段包含实现细节 When 生成进度文案 Then 只展示用户可理解的动作', () => {
    expect(getFunctionalModuleProgressText({ phase: 'manifest', version: undefined })).toBe('正在获取更新信息')
    expect(getFunctionalModuleProgressText({ phase: 'download', version: undefined })).toBe('正在下载更新')
    expect(getFunctionalModuleProgressText({ phase: 'verify', version: undefined })).toBe('正在验证文件')
    expect(getFunctionalModuleProgressText({ phase: 'done', version: '1.2.3' })).toBe('已准备好（v1.2.3）')
  })

  test('空状态符合共享状态契约', () => {
    const status: FunctionalModuleStatus = createEmptyFunctionalModuleStatus(FUNCTIONAL_MODULE_DEFINITIONS.find((item) => item.name === 'officecli')!)
    expect(status).toMatchObject({
      name: 'officecli',
      displayName: 'Office 文档支持',
      installed: false,
      required: true,
      error: null,
    })
  })

  test('Given FunctionalModulesCard 模块遇到版本过低错误 When 渲染操作区 Then 提供打开官网按钮', () => {
    const cardSource = readFileSync(join(__dirname, 'FunctionalModulesCard.tsx'), 'utf8')
    expect(cardSource).toContain("status.error?.includes('版本过低')")
    expect(cardSource).toContain('COPIS_OFFICIAL_URL')
    expect(cardSource).toContain('打开官网')
  })
})

describe('Chrome 功能模块平台可见性', () => {
  test('Given Chrome 组件定义 When 查看模块属性 Then 是 macOS 可选模块', () => {
    expect(FUNCTIONAL_MODULE_DEFINITIONS.find(item => item.name === 'chrome-desktop-cli')).toMatchObject({
      displayName: 'MCC · Chrome 桌面自动化', required: false, platform: 'darwin',
    })
  })

  test('Given 主进程按平台返回状态 When 生成设置列表 Then 只在 macOS 且主进程提供 Chrome 状态时展示', () => {
    expect(typeof moduleUi.getVisibleFunctionalModuleDefinitions).toBe('function')
    const chrome = createEmptyFunctionalModuleStatus(FUNCTIONAL_MODULE_DEFINITIONS.find(item => item.name === 'chrome-desktop-cli')!)
    expect(moduleUi.getVisibleFunctionalModuleDefinitions({ 'chrome-desktop-cli': chrome }, true).map(item => item.name)).toContain('chrome-desktop-cli')
    expect(moduleUi.getVisibleFunctionalModuleDefinitions({}, true).map(item => item.name)).not.toContain('chrome-desktop-cli')
    expect(moduleUi.getVisibleFunctionalModuleDefinitions({ 'chrome-desktop-cli': chrome }, false).map(item => item.name)).not.toContain('chrome-desktop-cli')
  })
})


describe('组件本地就绪与更新错误文案', () => {
  const empty = createEmptyFunctionalModuleStatus(FUNCTIONAL_MODULE_DEFINITIONS.find(item => item.name === 'chrome-desktop-cli')!)
  test('Given 本地有效但网络检查失败 Then 不误报本地未准备', () => {
    expect(getFunctionalModuleStateText({ ...empty, installed: true, version: '0.3.6', updateError: { code: 'check-failed', message: 'raw-secret-url' } }))
      .toBe('已准备好（v0.3.6），更新检查失败')
  })
  test('Given 当前平台组件未发布 Then 区分已安装与未安装且不回显原始错误', () => {
    const updateError = { code: 'not-published' as const, message: 'raw-secret-url' }
    expect(getFunctionalModuleStateText({ ...empty, updateError })).toBe('当前平台组件尚未发布，暂时无法安装')
    expect(getFunctionalModuleStateText({ ...empty, installed: true, version: '0.3.6', updateError })).toBe('已准备好（v0.3.6），线上暂无当前平台组件')
  })
  test('Given 本地组件不符合MCC契约 Then 展示升级或本地异常而不是启动失败', () => {
    expect(getFunctionalModuleStateText({ ...empty, localIssue: 'upgrade-required', error: 'raw-path' })).toBe('旧版 Chrome 组件需要升级为 MCC')
    expect(getFunctionalModuleStateText({ ...empty, localIssue: 'invalid-installation', error: 'raw-path' })).toBe('本地 MCC 组件文件异常，暂不可用')
  })
  test('Given 本地未安装但有可用版本 Then 显示可安装而不是已准备v-', () => {
    expect(getFunctionalModuleStateText({ ...empty, updateAvailable: true, availableVersion: '0.3.6' })).toBe('可安装（v0.3.6）')
  })
})
