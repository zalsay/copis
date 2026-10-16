import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const agentStyles = readFileSync(join(import.meta.dir, 'AgentView.css'), 'utf8')
const agentConversationSurface = readFileSync(join(import.meta.dir, 'AgentConversationSurface.tsx'), 'utf8')
const chromeDesktopBanner = readFileSync(join(import.meta.dir, 'ChromeDesktopBanner.tsx'), 'utf8')
const globalStyles = readFileSync(join(import.meta.dir, '../../styles/globals.css'), 'utf8')

describe('Agent 思考状态动画契约', () => {
  test('Given Agent 正在思考 When 展示模型气泡 Then 跑马灯复刻 Working 的周期并与方块加载图标同步', () => {
    expect(agentStyles).toContain('animation: agent-thinking-marquee 1.35s linear infinite;')
    expect(globalStyles).toContain('animation: spinner 1.35s infinite ease-in-out;')
  })

  test('Given Agent 正在思考 When 展示模型气泡 Then 跑马灯以 Working 的灰白高光由右向左推进', () => {
    expect(agentStyles).toContain('background: linear-gradient(90deg, #7f7f87 0%, #f1f1f3 42%, #7f7f87 84%);')
    expect(agentStyles).toContain('background-position: 220% 0;')
    expect(agentStyles).toContain('background-position: 0 0;')
  })

  test('Given Agent composer 高度变化 When 显示输入区域 Then 消息滚动区按实际高度预留空间', () => {
    expect(agentStyles).toContain('background: hsl(var(--background) / 0.42) !important;')
    expect(agentStyles).toContain('position: absolute;')
    expect(agentStyles).toContain('padding-bottom: var(--agent-composer-reserve-space, 128px);')
    expect(agentConversationSurface).toContain("style.setProperty('--agent-composer-reserve-space'")
    expect(agentConversationSurface).toContain('new ResizeObserver(updateComposerReserveSpace)')
    expect(agentStyles).toContain('backdrop-filter: blur(18px) saturate(1.12);')
    expect(agentStyles).toContain('-webkit-backdrop-filter: blur(18px) saturate(1.12);')
  })

  test('Given Chrome Desktop 正在观察或控制 When 渲染对话区 Then 预览位于消息区底部且 Composer 保持显示', () => {
    expect(agentConversationSurface).toContain('<ChromeDesktopBanner sessionId={sessionId} />')
    expect(agentConversationSurface).toContain('className="relative flex min-h-0 flex-1 flex-col"')
    expect(agentConversationSurface).toContain('const hasBlockingRequests = hasBannerOverlay || isChromeDesktopBusy')
    expect(agentConversationSurface).toContain('{!hasBannerOverlay && !hideComposer && (')
  })

  test('Given Chrome Desktop 横幅显示 When 对齐 Agent 输出 Then 使用消息区左侧 padding 链而不是居中定位', () => {
    expect(chromeDesktopBanner).toContain('ml-8 mr-auto')
    expect(chromeDesktopBanner).toContain('w-[calc(100%-2rem)]')
    expect(chromeDesktopBanner).not.toContain('mx-auto w-full max-w-[560px]')
  })

  test('Given Chrome 授权卡片宽度受限 When 展示等待授权标签 Then 标签有独立宽度且不收缩换行', () => {
    const badgeClasses = chromeDesktopBanner.match(/<Badge\b[^>]*className="([^"]*)"[^>]*>\s*等待授权/s)?.[1]?.split(/\s+/) ?? []
    expect(badgeClasses).toContain('min-w-[76px]')
    expect(badgeClasses).toContain('shrink-0')
    expect(badgeClasses).toContain('whitespace-nowrap')
    expect(badgeClasses).toContain('justify-center')
    expect(chromeDesktopBanner).toContain('flex min-w-0 flex-1 items-center gap-2.5')
  })

  test('Given Agent 处于 Plan 模式 When 显示输入区域 Then 使用 primary background token', () => {
    expect(agentStyles).toContain('background-color: var(--ui-primary-background) !important;')
    expect(agentStyles).not.toContain('rgb(43 33 55 / 0.70)')
  })

  test('Given Agent 新会话标语 When 渲染标题 Then 使用语义前景文字 token 保证浅色模式为深色文字', () => {
    expect(agentStyles).toContain('.copis-agent-new-session-hero h1 {')
    expect(agentStyles).toContain('color: hsl(var(--foreground));')
    expect(agentStyles).not.toContain('color: #f4f4f5;')
  })
})
