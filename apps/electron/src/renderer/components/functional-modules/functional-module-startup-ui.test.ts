import { describe, expect, test } from 'bun:test'
import {
  getStartupActions,
  getStartupErrorLabel,
  getStartupModuleDetail,
  getStartupModuleRows,
  getStartupModuleRowsForMode,
  getStartupPhaseLabel,
} from './functional-module-startup-ui'

describe('登录后功能模块更新页模型', () => {
  test('Given 启动进入服务检查阶段 When 生成阶段标题 Then 显示用户可理解的本地服务文案', () => {
    expect(getStartupPhaseLabel({ phase: 'health', progress: 0.97 })).toBe('正在检查本地服务')
    expect(getStartupPhaseLabel({ phase: 'ready', progress: 1 })).toBe('本地服务运行正常')
  })

  test('Given 必要组件列表 When 生成启动页模型 Then Rust 实现显示为系统核心模块', () => {
    expect(getStartupModuleRows().map((row) => row.name)).toEqual(['rust-http-api', 'officecli', 'alipay-bot'])
    expect(getStartupModuleRows().map((row) => row.displayName)).toEqual(['系统核心模块', 'Office 文档支持', '支付宝智能体 CLI'])
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

  test('Given 失败状态 When 生成操作 Then 只能重试不能继续进入', () => {
    expect(getStartupActions('error')).toEqual(['retry'])
    expect(getStartupActions('health')).toEqual([])
  })
})
