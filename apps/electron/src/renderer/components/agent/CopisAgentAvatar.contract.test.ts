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
const lightMetalLogoPath = join(rootDir, 'apps/electron/resources/copis-logos/main-logo-metal-light.svg')

describe('对话区 Agent 回复 Copis 头像浅色模式金属 Logo 契约 (BDD)', () => {
  test('Given 浅色模式金属 Logo 文件 When 检查 SVG 定义 Then 保留白底与双环且不包含外边框', () => {
    expect(existsSync(lightMetalLogoPath)).toBe(true)
    const svgContent = readFileSync(lightMetalLogoPath, 'utf8')

    expect(svgContent).toContain('fill="#ffffff"')
    expect(svgContent).toContain('id="mark0SteelDark"')
    expect(svgContent).toContain('id="mark1SteelDark"')
    expect(svgContent).not.toContain('id="frameSteelDark"')
    expect(svgContent).not.toContain('stroke="url(#frameSteelDark)"')
  })

  test('Given model-logo 模块 When 导出 Logo 资源 Then 包含浅色模式金属版 CopisAgentLightLogo', () => {
    const modelLogoSource = readFileSync(modelLogoPath, 'utf8')
    expect(modelLogoSource).toContain('CopisAgentLightLogo')
    expect(modelLogoSource).toContain('main-logo-metal-light.svg')
  })

  test('Given CopisAgentAvatar 组件 When 渲染头像 Then 浅色模式显示金属 Logo，深色模式显示银白 Logo', () => {
    const avatarSource = readFileSync(avatarComponentPath, 'utf8')

    // 包含浅色与深色专属类
    expect(avatarSource).toContain('CopisAgentLightLogo')
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
