import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const componentPath = join(import.meta.dir, 'ProxySettingsCard.tsx')

function readComponentSource(): string {
  return existsSync(componentPath) ? readFileSync(componentPath, 'utf8') : ''
}

describe('ProxySettingsCard 代理设置组件契约', () => {
  test('Given 代理设置组件 When 检查导出与状态管理 Then 正确导出并使用 proxy-atoms', () => {
    const source = readComponentSource()
    expect(existsSync(componentPath)).toBe(true)
    expect(source).toContain('export function ProxySettingsCard')
    expect(source).toContain('proxyConfigAtom')
    expect(source).toContain('loadProxyConfigAtom')
    expect(source).toContain('updateProxyConfigAtom')
    expect(source).toContain('detectSystemProxyAtom')
  })

  test('Given 代理设置组件 When 检查基础控件 Then 包含启用代理开关和模式切换选项且明确说明仅接入自定义模型', () => {
    const source = readComponentSource()
    expect(source).toContain('自定义模型网络代理')
    expect(source).toContain('仅对第三方自定义模型 API 请求及连通性测试生效')
    expect(source).toContain('启用代理')
    expect(source).toContain('系统代理')
    expect(source).toContain('手动配置')
  })

  test('Given 系统代理模式 When 检查操作与展示 Then 包含检测系统代理按钮与检测结果反馈', () => {
    const source = readComponentSource()
    expect(source).toContain('检测系统代理')
    expect(source).toContain('detectSystemProxy')
    expect(source).toContain('systemProxyDetectResultAtom')
  })

  test('Given 手动代理模式 When 检查输入项 Then 包含代理地址输入框及提示', () => {
    const source = readComponentSource()
    expect(source).toContain('代理服务器地址')
    expect(source).toContain('http://127.0.0.1:7890')
    expect(source).toContain('manualUrl')
  })

  test('Given 保存操作 When 检查保存逻辑 Then 提供保存能力与用户反馈', () => {
    const source = readComponentSource()
    expect(source).toContain('保存')
    expect(source).toContain('onNotice')
  })
})
