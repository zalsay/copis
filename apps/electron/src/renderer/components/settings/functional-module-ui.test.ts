import { describe, expect, test } from 'bun:test'
import type { FunctionalModuleStatus } from '@copis/shared'
import {
  FUNCTIONAL_MODULE_DEFINITIONS,
  createEmptyFunctionalModuleStatus,
  getFunctionalModuleProgressText,
  getFunctionalModuleStateText,
} from './functional-module-ui'

describe('功能模块设置页模型', () => {
  test('Given 本地能力列表 When 生成设置页模型 Then 显示友好的能力名称', () => {
    expect(FUNCTIONAL_MODULE_DEFINITIONS.map((item) => item.name)).toEqual(['node-runtime', 'rust-http-api', 'officecli', 'alipay-bot', 'playwright-core'])
    expect(FUNCTIONAL_MODULE_DEFINITIONS.find((item) => item.name === 'node-runtime')?.required).toBe(true)
    expect(FUNCTIONAL_MODULE_DEFINITIONS.find((item) => item.name === 'rust-http-api')?.required).toBe(true)
    expect(FUNCTIONAL_MODULE_DEFINITIONS.find((item) => item.name === 'officecli')?.required).toBe(true)
    expect(FUNCTIONAL_MODULE_DEFINITIONS.find((item) => item.name === 'alipay-bot')?.required).toBe(true)
    expect(FUNCTIONAL_MODULE_DEFINITIONS.find((item) => item.name === 'playwright-core')?.required).toBe(true)
    expect(FUNCTIONAL_MODULE_DEFINITIONS.map((item) => item.displayName)).toEqual(['Node.js 运行环境', '系统核心模块', 'Office 文档支持', '支付宝智能体 CLI', '浏览器自动化内核'])
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
})
