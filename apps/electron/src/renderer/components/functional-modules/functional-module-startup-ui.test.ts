import { describe, expect, test } from 'bun:test'
import {
  COPIS_DOWNLOAD_URL,
  getStartupActions,
  getStartupClientUpdateDialog,
  getStartupErrorLabel,
  getStartupModuleDetail,
  getStartupModuleRows,
  getStartupModuleRowsForMode,
  getStartupPhaseLabel,
  isStartupClientUpdateRequired,
  parseStartupClientUpdateRequired,
} from './functional-module-startup-ui'

describe('登录后功能模块更新页模型', () => {
  test('Given 启动进入服务检查阶段 When 生成阶段标题 Then 显示用户可理解的本地服务文案', () => {
    expect(getStartupPhaseLabel({ phase: 'health', progress: 0.97 })).toBe('正在检查本地服务')
    expect(getStartupPhaseLabel({ phase: 'ready', progress: 1 })).toBe('本地服务运行正常')
  })

  test('Given 必要组件列表 When 生成启动页模型 Then Rust 实现显示为系统核心模块', () => {
    expect(getStartupModuleRows().map((row) => row.name)).toEqual([
      'rust-http-api',
      'officecli',
      'alipay-bot',
      'playwright-core',
      'python-runtime',
    ])
    expect(getStartupModuleRows().map((row) => row.displayName)).toEqual([
      '系统核心模块',
      'Office 文档支持',
      '支付宝智能体 CLI',
      '浏览器自动化内核',
      'Python 3.12 运行环境',
    ])
    expect(getStartupModuleRows().every((row) => !/Rust|HTTP|API|health/.test(`${row.displayName} ${row.description}`))).toBe(true)
  })

  test('Given 开发模式 When 生成启动页模型 Then 不展示必要组件更新行', () => {
    expect(getStartupModuleRowsForMode(true)).toEqual([])
    expect(getStartupModuleRowsForMode(false)).toEqual(getStartupModuleRows())
  })

  test('Given 后端阶段详情包含实现术语 When 生成模块进度文案 Then 只显示友好提示', () => {
    expect(getStartupModuleDetail({ phase: 'manifest' })).toBe('正在获取更新信息')
    expect(getStartupModuleDetail({ phase: 'download' })).toBe('正在下载更新')
    expect(getStartupModuleDetail({ phase: 'verify' })).toBe('正在验证文件')
    expect(getStartupModuleDetail({ phase: 'done', version: '1.2.3' })).toBe('已准备好（v1.2.3）')
  })

  test('Given 启动失败原因包含实现细节 When 生成错误文案 Then 引导用户重试而不暴露内部信息', () => {
    expect(getStartupErrorLabel('Rust HTTP API 未通过 health 检查')).toBe('必要组件暂未准备完成，请重试')
  })

  test('Given 客户端版本过低错误 When 生成错误文案 Then 提取最低版本并显示友好升级提示', () => {
    expect(getStartupErrorLabel('Copis 版本过低，需要至少 0.16.13')).toBe('当前 Copis 版本过低，需要至少 v0.16.13，请下载最新版本')
    expect(getStartupErrorLabel('Copis 版本过低，需要至少 v0.18.0')).toBe('当前 Copis 版本过低，需要至少 v0.18.0，请下载最新版本')
  })

  test('Given 失败状态 When 生成操作 Then 只能重试不能继续进入', () => {
    expect(getStartupActions('error')).toEqual(['retry'])
    expect(getStartupActions('health')).toEqual([])
  })

  test('Given 客户端版本过低错误 When 生成操作 Then 提供下载最新版本动作而非重试', () => {
    expect(getStartupActions('error', 'Copis 版本过低，需要至少 0.16.13')).toEqual(['download_update'])
    expect(getStartupActions('error', '网络连接超时')).toEqual(['retry'])
    expect(getStartupActions('ready', 'Copis 版本过低，需要至少 0.16.13')).toEqual([])
  })

  test('Given 客户端更新地址 When 读取常量 Then 指向官方下载页面', () => {
    expect(COPIS_DOWNLOAD_URL).toBe('https://copis.meetlife.com.cn')
  })

  test('Given 客户端版本过低错误 When 生成检测页弹窗 Then 显示升级说明和下载动作', () => {
    expect(getStartupClientUpdateDialog('Copis 版本过低，需要至少 0.16.13')).toEqual({
      minClientVersion: '0.16.13',
      title: '需要更新 Copis',
      description: '必要组件要求 Copis v0.16.13 或更高版本。下载最新版本后重新打开应用。',
      actionLabel: '下载最新版本',
    })
    expect(getStartupClientUpdateDialog('网络连接超时')).toBeNull()
  })

  test('Given 版本检查辅助方法 When 解析错误信息 Then 正确识别并解析最低版本', () => {
    expect(parseStartupClientUpdateRequired('Copis 版本过低，需要至少 0.16.13')).toEqual({ minClientVersion: '0.16.13' })
    expect(isStartupClientUpdateRequired('Copis 版本过低，需要至少 0.16.13')).toBe(true)
    expect(isStartupClientUpdateRequired('普通错误')).toBe(false)
    expect(isStartupClientUpdateRequired(null)).toBe(false)
    expect(isStartupClientUpdateRequired(undefined)).toBe(false)
  })
})
