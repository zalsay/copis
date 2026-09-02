import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const globalsCss = readFileSync(join(import.meta.dir, '../../styles/globals.css'), 'utf8')
const tailwindConfig = readFileSync(join(import.meta.dir, '../../../../tailwind.config.js'), 'utf8')
const settingsPanelCss = readFileSync(join(import.meta.dir, 'CopisWorkingSettingsPanel.css'), 'utf8')
const connectDialogCss = readFileSync(join(import.meta.dir, 'CopisWorkingConnectDialog.css'), 'utf8')
const loginDialogCss = readFileSync(join(import.meta.dir, 'CopisWorkingLoginDialog.css'), 'utf8')
const loginShowcaseCss = readFileSync(join(import.meta.dir, 'CopisWorkingLoginShowcase.css'), 'utf8')
const feedbackDialogCss = readFileSync(join(import.meta.dir, 'CopisWorkingFeedbackDialog.css'), 'utf8')
const paymentModalCss = readFileSync(join(import.meta.dir, 'CopisWorkingPaymentModal.css'), 'utf8')
const messageSettingsCss = readFileSync(join(import.meta.dir, 'CopisWorkingMessageSettingsPanel.css'), 'utf8')
const voiceInputCss = readFileSync(join(import.meta.dir, '../settings/VoiceInputSettings.css'), 'utf8')
const agentViewCss = readFileSync(join(import.meta.dir, '../agent/AgentView.css'), 'utf8')
const webBookmarksPopoverTsx = readFileSync(join(import.meta.dir, '../web-browser/WebBookmarksPopover.tsx'), 'utf8')

describe('UI 卡片与弹窗圆角统一契约（对齐账户设置--个人钻石卡片 8px 标准）', () => {
  test('Given globals.css When 检查全局圆角 Token Then 基准与语义变量均统一定义为 8px (0.5rem)', () => {
    expect(globalsCss).toContain('--radius: 0.5rem;')
    expect(globalsCss).toContain('--radius-cap: 8px;')
    expect(globalsCss).toContain('--radius-card: 8px;')
    expect(globalsCss).toContain('--radius-dialog: 8px;')
    expect(globalsCss).toContain('--radius-modal: 8px;')
  })

  test('Given tailwind.config.js When 检查 borderRadius 配置 Then 支持 card 与 dialog 语义并派生自 --radius', () => {
    expect(tailwindConfig).toContain("card: 'var(--radius-card, var(--radius))'")
    expect(tailwindConfig).toContain("dialog: 'var(--radius-dialog, var(--radius))'")
    expect(tailwindConfig).toContain("modal: 'var(--radius-modal, var(--radius))'")
    expect(tailwindConfig).toContain("lg: 'var(--radius)'")
  })

  test('Given 账户设置--个人钻石卡片 When 检查圆角定义 Then 显式为 8px 且作为全应用卡片标准', () => {
    const cardRule = settingsPanelCss.match(/\.copis-working-settings-card\s*\{([^}]*)\}/s)?.[1]
    expect(cardRule).toBeDefined()
    expect(cardRule).toContain('border-radius: 8px;')
  })

  test('Given 工作区创建弹窗 When 检查模态框与拾取器 Then 圆角统一为 8px', () => {
    const modalRule = connectDialogCss.match(/\.copis-working-connect-modal\s*\{([^}]*)\}/s)?.[1]
    const pickerRule = connectDialogCss.match(/\.copis-working-connect-picker\s*\{([^}]*)\}/s)?.[1]
    expect(modalRule).toBeDefined()
    expect(modalRule).toContain('border-radius: 8px;')
    expect(pickerRule).toBeDefined()
    expect(pickerRule).toContain('border-radius: 8px;')
  })

  test('Given 登录面板与模态框 When 检查面板与弹窗 Then 圆角统一为 8px', () => {
    const panelRule = loginDialogCss.match(/\.copis-working-auth-page\s+\.copis-working-auth-panel\s*\{([^}]*)\}/s)?.[1]
    const modalRule = loginDialogCss.match(/\.copis-working-auth-modal\s*\{([^}]*)\}/s)?.[1]
    expect(panelRule).toBeDefined()
    expect(panelRule).toContain('border-radius: 8px;')
    expect(modalRule).toBeDefined()
    expect(modalRule).toContain('border-radius: 8px;')
  })

  test('Given 登录页展示卡片 When 检查 showcase 容器 Then 圆角统一为 8px', () => {
    const showcaseRule = loginShowcaseCss.match(/\.copis-working-login-showcase\s*\{([^}]*)\}/s)?.[1]
    expect(showcaseRule).toBeDefined()
    expect(showcaseRule).toContain('border-radius: 8px;')
  })

  test('Given 用户反馈弹窗 When 检查模态框 Then 圆角统一为 8px', () => {
    const feedbackModalRule = feedbackDialogCss.match(/\.copis-working-feedback-modal\s*\{([^}]*)\}/s)?.[1]
    expect(feedbackModalRule).toBeDefined()
    expect(feedbackModalRule).toContain('border-radius: 8px;')
  })

  test('Given 支付收银台弹窗 When 检查模态框与套餐卡片 Then 圆角统一为 8px', () => {
    const paymentModalRule = paymentModalCss.match(/\.copis-working-payment-modal\s*\{([^}]*)\}/s)?.[1]
    const packageRule = paymentModalCss.match(/\.copis-working-payment-package\s*\{([^}]*)\}/s)?.[1]
    expect(paymentModalRule).toBeDefined()
    expect(paymentModalRule).toContain('border-radius: 8px;')
    expect(packageRule).toBeDefined()
    expect(packageRule).toContain('border-radius: 8px;')
  })

  test('Given 消息渠道卡片 When 检查列表卡片 Then 圆角统一为 8px', () => {
    const channelRule = messageSettingsCss.match(/\.copis-working-message-channel\s*\{([^}]*)\}/s)?.[1]
    expect(channelRule).toBeDefined()
    expect(channelRule).toContain('border-radius: 8px;')
  })

  test('Given 语音设置模式卡片 When 检查卡片容器 Then 圆角统一为 8px', () => {
    const voiceCardRule = voiceInputCss.match(/\.copis-voice-mode-card\s*\{([^}]*)\}/s)?.[1]
    expect(voiceCardRule).toBeDefined()
    expect(voiceCardRule).toContain('border-radius: 8px;')
  })

  test('Given Agent 对话输入框 When 检查容器圆角 Then 统一为 8px', () => {
    const compactInputRule = agentViewCss.match(/\.copis-agent-session-compact\s+\[data-input-mode="agent"\]\s*>\s*div:first-child\s*\{([^}]*)\}/s)?.[1]
    expect(compactInputRule).toBeDefined()
    expect(compactInputRule).toContain('border-radius: 8px;')
  })

  test('Given 网页收藏夹弹窗 When 检查弹窗容器与卡片圆角 Then 对齐主页 8px (rounded-lg) 标准', () => {
    expect(webBookmarksPopoverTsx).toContain('data-web-bookmarks-panel="true"')
    expect(webBookmarksPopoverTsx).toContain('className="z-[9999] w-96 rounded-lg p-2 duration-75"')
    expect(webBookmarksPopoverTsx).toContain("borderRadius: '8px'")
    expect(webBookmarksPopoverTsx).toContain('flex items-center gap-2 rounded-md bg-muted/45 px-2 py-1.5')
  })
})
