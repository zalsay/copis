import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('ProfessionalModeCard 组件功能契约 (BDD)', () => {
  const cardSource = readFileSync(join(__dirname, 'ProfessionalModeCard.tsx'), 'utf8')
  const pillSource = readFileSync(join(__dirname, '../agent/ComposerModeTogglePill.tsx'), 'utf8')

  test('Given 专业模式配置卡片 When 挂载时 Then 自动调用 checkCodexCli 检测本地环境', () => {
    expect(cardSource).toContain('window.electronAPI.checkCodexCli')
    expect(cardSource).toContain('refreshCliStatus')
    expect(cardSource).toContain('setCliStatus')
    expect(cardSource).toContain('checkingCli')
  })

  test('Given 本机未安装核心模块或无法启动后台服务 When 渲染卡片 Then 显示提示横幅与一键下载安装按钮', () => {
    expect(cardSource).toContain('!checkingCli && !isCliReady')
    expect(cardSource).toContain('未安装专业模式核心模块')
    expect(cardSource).toContain('下载并安装模块')
    expect(cardSource).toContain('handleInstallModule')
  })

  test('Given 用户点击下载并安装模块 When 执行安装 Then 触发 codex-cli 安装与进度监听', () => {
    expect(cardSource).toContain("installFunctionalModule({ name: 'codex-cli' })")
    expect(cardSource).toContain('onFunctionalModuleProgress')
    expect(cardSource).toContain("payload.name === 'codex-cli'")
    expect(cardSource).toContain('installPercent')
    expect(cardSource).toContain('installProgressText')
  })

  test('Given 组件未就绪 When 检查开关状态 Then 禁止直接开启并引导安装', () => {
    expect(cardSource).toContain('disabled={toggling || (!isCliReady && !isProfessional)}')
    expect(cardSource).toContain('未检测到专业模式核心模块，请先点击下方按钮下载安装')
  })

  const surfaceSource = readFileSync(join(__dirname, '../agent/AgentConversationSurface.tsx'), 'utf8')
  const welcomeComposerSource = readFileSync(join(__dirname, '../welcome/WelcomeComposer.tsx'), 'utf8')

  test('Given Composer 交互药丸 When 未检测到核心模块尝试开启 Then 友好拦截并提示前往设置页安装', () => {
    expect(pillSource).toContain('window.electronAPI?.checkCodexCli')
    expect(pillSource).toContain('!cliStatus?.canStartAppServer')
    expect(pillSource).toContain('未检测到专业模式核心模块，请前往「设置 - 模型管理」下载并安装')
  })

  test('Given Composer 交互药丸 When 新对话已开始或已有消息 Then 禁用模式切换药丸并锁定当前模式', () => {
    expect(pillSource).toContain('disabled: propDisabled')
    expect(pillSource).toContain('isConversationStarted')
    expect(pillSource).toContain('disabled || toggling')
    expect(pillSource).toContain('对话已开启，已锁定为')
    expect(pillSource).toContain('仅在新对话未开始时可切换')
  })

  test('Given 会话主视口与欢迎页 Composer When 渲染 Composer 模式切换药丸 Then 仅在新对话未开始时允许切换且对话开启后禁用', () => {
    expect(surfaceSource).toContain('disabled={!isNewConversation}')
    expect(surfaceSource).toContain('sessionId={sessionId}')
    expect(surfaceSource).toContain('isProfessional={isProfessional}')
    expect(welcomeComposerSource).toContain('disabled={hasStarted}')
    expect(welcomeComposerSource).toContain('sessionId={session?.id}')
    expect(welcomeComposerSource).toContain('isProfessional={isProfessional}')
  })

  test('Given Composer 交互药丸 When 切换模式时 Then 同步乐观更新会话 runtime，杜绝异步间隙导致首次切换失效', () => {
    expect(pillSource).toContain('sessionId?: string')
    expect(pillSource).toContain('isProfessional?: boolean')
    expect(pillSource).toContain('setSessions((prev) =>')
    expect(pillSource).toContain('updateSessionAgentRuntime')
    expect(surfaceSource).toContain('const isProfessional = sessionMeta')
    expect(surfaceSource).toContain("? sessionMeta.agentRuntime === 'codex'")
  })
})
