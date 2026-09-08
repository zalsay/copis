/**
 * 对话区 Agent 回复 Copis 头像深灰色主题契约测试 (BDD)
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const rootDir = join(__dirname, '../../../../../../')
const avatarComponentPath = join(__dirname, 'CopisAgentAvatar.tsx')
const agentMessagesPath = join(__dirname, 'AgentMessages.tsx')
const sdkRendererPath = join(__dirname, 'SDKMessageRenderer.tsx')
const modelLogoPath = join(__dirname, '../../lib/model-logo.ts')
const darkLogoPath = join(rootDir, 'mian-logo-dark.svg')

describe('对话区 Agent 回复 Copis 头像浅色模式深灰色契约 (BDD)', () => {
  test('Given 浅色模式深灰 Logo 文件 When 检查 SVG 定义 Then 具备深灰渐变与镂空遮罩', () => {
    expect(existsSync(darkLogoPath)).toBe(true)
    const svgContent = readFileSync(darkLogoPath, 'utf8')

    // 渐变与深灰配色
    expect(svgContent).toContain('id="dark-gray"')
    expect(svgContent).toContain('#3F3F46')
    expect(svgContent).toContain('#27272A')
    expect(svgContent).toContain('#18181B')

    // 镂空遮罩：保证眼睛与五官在任何背景下均透出背景色
    expect(svgContent).toContain('mask id="cutout"')
    expect(svgContent).toContain('mask="url(#cutout)"')
  })

  test('Given model-logo 模块 When 导出 Logo 资源 Then 包含深灰版 CopisAgentDarkLogo', () => {
    const modelLogoSource = readFileSync(modelLogoPath, 'utf8')
    expect(modelLogoSource).toContain('CopisAgentDarkLogo')
    expect(modelLogoSource).toContain('mian-logo-dark.svg')
  })

  test('Given CopisAgentAvatar 组件 When 渲染头像 Then 浅色模式显示深灰 Logo，深色模式显示银白 Logo', () => {
    const avatarSource = readFileSync(avatarComponentPath, 'utf8')

    // 包含浅色与深色专属类
    expect(avatarSource).toContain('CopisAgentDarkLogo')
    expect(avatarSource).toContain('CopisAgentLogo')
    expect(avatarSource).toContain('dark:hidden')
    expect(avatarSource).toContain('hidden dark:block')
    expect(avatarSource).toContain('AssistantLogo')
  })

  test('Given 对话区消息渲染组件 When 渲染 Agent 头部头像 Then 统一使用 CopisAgentAvatar', () => {
    const agentMessagesSource = readFileSync(agentMessagesPath, 'utf8')
    const sdkRendererSource = readFileSync(sdkRendererPath, 'utf8')

    // AgentMessages
    expect(agentMessagesSource).toContain("import { AssistantLogo } from './CopisAgentAvatar'")
    expect(agentMessagesSource).toContain('logo={<AssistantLogo />}')

    // SDKMessageRenderer
    expect(sdkRendererSource).toContain("import { AssistantLogo } from './CopisAgentAvatar'")
    expect(sdkRendererSource).toContain('logo={<AssistantLogo />}')
  })
})
