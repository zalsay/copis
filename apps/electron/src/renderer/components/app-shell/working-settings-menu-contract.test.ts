import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const panelSource = readFileSync(join(import.meta.dir, 'CopisWorkingSettingsPanel.tsx'), 'utf8')
const panelStyles = readFileSync(join(import.meta.dir, 'CopisWorkingSettingsPanel.css'), 'utf8')
const ledgerSource = readFileSync(join(import.meta.dir, '..', '..', 'lib', 'working-ledger.ts'), 'utf8')
const globalStyles = readFileSync(join(import.meta.dir, '..', '..', 'styles', 'globals.css'), 'utf8')
const tabAtomsSource = readFileSync(join(import.meta.dir, '..', '..', 'atoms', 'tab-atoms.ts'), 'utf8')
const tabContentSource = readFileSync(join(import.meta.dir, '..', 'tabs', 'TabContent.tsx'), 'utf8')
const ipcSource = readFileSync(join(import.meta.dir, '..', '..', '..', 'main', 'ipc', 'feishu.ipc.ts'), 'utf8')

const sidebarSource = readFileSync(join(import.meta.dir, 'CopisWorkingSidebar.tsx'), 'utf8')

describe('Working 设置菜单契约', () => {
  test('Given Working 设置 When 读取菜单定义 Then 保留旧菜单并包含四个迁移页面，且查看使用教程迁移至主区域侧边栏', () => {
    const requiredSections = [
      ['settings', '账户设置'],
      ['messages', 'App 连接器'],
      ['orders', '我的订单'],
      ['voice-input', '语音输入'],
      ['migration', '数据迁移'],
      ['storage', '磁盘管理'],
      ['appearance', '外观设置'],
      ['about', '关于/更新'],
      ['feedback', '意见反馈'],
    ] as const

    for (const [id, label] of requiredSections) {
      expect(panelSource).toContain(`id: '${id}'`)
      expect(panelSource).toContain(`label: '${label}'`)
    }

    const menuLabels = requiredSections.map(([, label]) => label)
    let previousIndex = -1
    for (const label of menuLabels) {
      const index = panelSource.indexOf(label, previousIndex + 1)
      expect(index).toBeGreaterThan(previousIndex)
      previousIndex = index
    }

    expect(panelSource).toContain('checkInWorking')
    expect(panelSource).toContain('getWorkingSettingsSnapshot')
    expect(panelSource).not.toContain("id: 'tutorial'")
    expect(panelSource).toContain('FeedbackSettings')
    expect(panelSource.lastIndexOf("id: 'feedback'")).toBeGreaterThan(panelSource.lastIndexOf("id: 'about'"))
    expect(sidebarSource).toContain('handleOpenTutorial')
    expect(sidebarSource).toContain('openTab')
    expect(sidebarSource).toContain('查看使用教程')
  })

  test('Given Working 原有页面 When 检查组件和样式 Then 保留真实数据交互链路', () => {
    const pageContracts = [
      ['CopisWorkingMessageSettingsPanel.tsx', ['@copis/shared', 'setWorkingReceiveChannel', 'WorkingReceiveChannelSettings']],
      ['CopisWorkingOrdersPanel.tsx', ['@copis/shared', 'listWorkingOrders', 'deleteWorkingOrder']],
    ] as const

    for (const [fileName, contracts] of pageContracts) {
      const filePath = join(import.meta.dir, fileName)
      expect(existsSync(filePath)).toBe(true)
      const source = readFileSync(filePath, 'utf8')
      for (const contract of contracts) expect(source).toContain(contract)
    }

    expect(existsSync(join(import.meta.dir, 'CopisWorkingMessageSettingsPanel.css'))).toBe(true)
    expect(existsSync(join(import.meta.dir, 'CopisWorkingOrdersPanel.css'))).toBe(true)
    expect(panelSource).toContain('CopisWorkingMessageSettingsPanel')
    expect(panelSource).toContain('CopisWorkingOrdersPanel')
  })

  test('Given App 连接器页面 When 渲染设置面板 Then 不重复包含外层标题与描述且使用微信和飞书 logo 并支持重新绑定功能', () => {
    const messagePanelSource = readFileSync(join(import.meta.dir, 'CopisWorkingMessageSettingsPanel.tsx'), 'utf8')
    expect(messagePanelSource).not.toContain('<h2>App 连接器</h2>')
    expect(messagePanelSource).not.toContain('<h2>工作消息接收方式</h2>')
    expect(messagePanelSource).not.toContain('选择 Working 工作消息的接收渠道，变更会同步到当前 Working 账户。')
    expect(messagePanelSource).toContain('assets/bots/wechat.png')
    expect(messagePanelSource).toContain('assets/bots/feishu.png')
    expect(messagePanelSource).toContain('assets/bots/dingding.png')
    expect(messagePanelSource).toContain('copis-working-message-channel-logo')
    expect(messagePanelSource).toContain('copis-working-message-channel-rebind-btn')
    expect(messagePanelSource).toContain('重新绑定')
    expect(messagePanelSource).toContain('getWorkingSettingsSnapshot')
    expect(messagePanelSource).toContain('Agent 邮箱 (QQ 邮箱)')
    expect(messagePanelSource).toContain('getAgentMailStatus')
    expect(messagePanelSource).toContain('startAgentMailLogin')
  })

  test('Given App 连接器页面 When 渲染当前渠道 Then 呈现胶囊外观并使用主题色与主题背景色', () => {
    const messagePanelSource = readFileSync(join(import.meta.dir, 'CopisWorkingMessageSettingsPanel.tsx'), 'utf8')
    const messageStyles = readFileSync(join(import.meta.dir, 'CopisWorkingMessageSettingsPanel.css'), 'utf8')

    expect(messagePanelSource).toContain('当前渠道')
    const selectedBadgeRule = messageStyles.match(/\.copis-working-message-channel-action\.selected[^{]*\{([^}]*)\}/s)?.[1]
    expect(selectedBadgeRule).toBeDefined()
    expect(selectedBadgeRule).toContain('border-radius: 9999px;')
    expect(selectedBadgeRule).toContain('background: var(--ui-primary-background);')
    expect(selectedBadgeRule).toContain('color: var(--ui-primary);')
    expect(selectedBadgeRule).toContain('border: 1px solid color-mix(in srgb, var(--ui-primary)')
    expect(selectedBadgeRule).toContain('opacity: 1 !important;')
  })


  test('Given 飞书授权成功 When 展示授权反馈 Then 提示用户确认绑定', () => {
    const messagePanelSource = readFileSync(join(import.meta.dir, 'CopisWorkingMessageSettingsPanel.tsx'), 'utf8')
    expect(messagePanelSource).toContain('飞书授权成功！请确认绑定')
    expect(messagePanelSource).toContain('bg-white/60')
    expect(messagePanelSource).toContain('feishuRegistrationResult')
    expect(messagePanelSource).toContain('我已在手机确认')
    expect(messagePanelSource).not.toContain('飞书授权成功！正在保存配置...')
  })

  test('Given 飞书已有智能体 When 绑定消息渠道 Then 提供 App ID 输入并将其传入扫码授权流程', () => {
    const messagePanelSource = readFileSync(join(import.meta.dir, 'CopisWorkingMessageSettingsPanel.tsx'), 'utf8')
    expect(messagePanelSource).toContain('feishuAppId')
    expect(messagePanelSource).toContain('已有飞书智能体 App ID')
    expect(messagePanelSource).toContain('registerFeishuApp(feishuAppId.trim() || undefined)')
    expect(messagePanelSource).toContain('打开飞书开放平台')
    expect(messagePanelSource).toContain("window.electronAPI.openExternal?.('https://open.feishu.cn/')")
    expect(ipcSource).toContain('appId: normalizedAppId')
  })

  test('Given 我的订单页面 When 渲染设置面板 Then 不重复包含多余 header 标题', () => {
    const ordersPanelSource = readFileSync(join(import.meta.dir, 'CopisWorkingOrdersPanel.tsx'), 'utf8')
    expect(ordersPanelSource).not.toContain('<h2>我的订单</h2>')
    expect(ordersPanelSource).not.toContain('copis-working-orders-header')
  })

  test('Given Working 设置顶栏 When 渲染操作区 Then 刷新按钮位于退出按钮左侧且不局限于账户设置，且退出按钮与刷新按钮保持同色', () => {
    const freshPanelSource = readFileSync(join(import.meta.dir, 'CopisWorkingSettingsPanel.tsx'), 'utf8')
    const freshPanelStyles = readFileSync(join(import.meta.dir, 'CopisWorkingSettingsPanel.css'), 'utf8')
    const actionsStart = freshPanelSource.indexOf('<div className="copis-working-settings-actions">')
    const actionsEnd = freshPanelSource.indexOf('</header>', actionsStart)
    expect(actionsStart).toBeGreaterThanOrEqual(0)
    expect(actionsEnd).toBeGreaterThan(actionsStart)

    const actionsSource = freshPanelSource.slice(actionsStart, actionsEnd)
    const refreshIndex = actionsSource.indexOf("<span>{loading ? '同步中...' : '刷新'}</span>")
    const logoutIndex = actionsSource.indexOf("<span>{loggingOut ? '退出中...' : '退出'}</span>")
    expect(refreshIndex).toBeGreaterThanOrEqual(0)
    expect(logoutIndex).toBeGreaterThan(refreshIndex)
    expect(actionsSource).not.toContain("{activeSection === 'settings' && (\n                <button type=\"button\" onClick=")
    expect(actionsSource).not.toContain('className="danger"')
    expect(freshPanelStyles).not.toContain('.copis-working-settings-actions button.danger')
  })

  test('Given 恢复账户总览 When 渲染钻石和流水卡片 Then JSX 使用的视觉类都有对应样式', () => {
    const accountVisualClasses = [
      'copis-working-settings-toast',
      'copis-working-settings-grid',
      'copis-working-settings-card',
      'copis-working-settings-balance',
      'copis-working-settings-invite-code',
      'copis-working-settings-ledger-card',
      'copis-working-settings-ledger-row',
      'copis-working-settings-empty',
    ] as const

    for (const className of accountVisualClasses) {
      expect(panelSource).toContain(className)
      expect(panelStyles).toContain(`.${className}`)
    }
  })

  test('Given 账户设置邀请卡片 When 展示邀请信息 Then 复制操作位于标题行右侧', () => {
    const inviteCardStart = panelSource.indexOf('<section className="copis-working-settings-card copis-working-settings-invite-card">')
    const ledgerCardStart = panelSource.indexOf('<section className="copis-working-settings-card copis-working-settings-ledger-card">')
    expect(inviteCardStart).toBeGreaterThanOrEqual(0)
    expect(ledgerCardStart).toBeGreaterThan(inviteCardStart)

    const inviteCardSource = panelSource.slice(inviteCardStart, ledgerCardStart)
    const inviteCodeStart = inviteCardSource.indexOf('<div className="copis-working-settings-invite-code">')
    expect(inviteCardSource).toContain('copis-working-settings-card-heading copis-working-settings-card-heading-with-action')
    expect(inviteCardSource).toContain('copis-working-settings-card-action copis-working-settings-invite-button')
    expect(inviteCardSource).toContain("'复制邀请码'")
    expect(inviteCardSource).toContain('copiedLabel ? <CircleCheck')
    expect(inviteCodeStart).toBeGreaterThan(0)
    expect(inviteCardSource.slice(inviteCodeStart)).not.toContain('<button')
  })

  test('Given 账户设置邀请卡片 When 点击复制 Then 只复制邀请码不复制链接', () => {
    const handlerStart = panelSource.indexOf('const handleCopyInvite')
    const handlerEnd = panelSource.indexOf('const handleReceiveChannelChange')
    expect(handlerStart).toBeGreaterThanOrEqual(0)
    expect(handlerEnd).toBeGreaterThan(handlerStart)

    const handlerSource = panelSource.slice(handlerStart, handlerEnd)
    expect(handlerSource).toContain('const inviteCode = settings?.inviteCode')
    expect(handlerSource).toContain('navigator.clipboard?.writeText(inviteCode)')
    expect(handlerSource).toContain("setCopiedLabel('已复制')")
    expect(handlerSource).not.toContain('inviteLink')
  })

  test('Given 账户设置页面 When 使用品牌强调色 Then 所有高亮读取 ui-primary 且不保留旧金色', () => {
    expect(globalStyles).toContain('--ui-primary:')
    expect(globalStyles).toContain('--ui-primary-background:')
    expect(panelStyles).toContain('var(--ui-primary)')
    expect(panelStyles).toContain('var(--ui-primary-background)')
    expect(panelStyles).toContain('color-mix(in srgb, var(--ui-primary)')
    expect(panelStyles).not.toContain('hsl(var(--primary)')
    expect(panelStyles).not.toContain('hsl(43')
  })

  test('Given 账户流水 When 显示模型扣费 Then 使用 alias 文案并将快速和专家映射为 Copis 名称，扣费支持展示折扣', () => {
    expect(panelSource).toContain('formatWorkingLedgerDescription(entry, payer)')
    expect(panelSource).toContain('formatWorkingDiscount')
    expect(panelSource).toContain('Copis 模型扣费（${discount}）')
    expect(ledgerSource).toContain('模型 · ${displayAlias} Token消耗')
    expect(ledgerSource).toContain("alias === 'fast' ? 'Copis 快速'")
    expect(ledgerSource).toContain("alias === 'export' ? 'Copis 专家'")
    expect(panelSource).toContain("'Copis 模型扣费'")
    expect(panelSource).toContain("'专家团扣费'")
    expect(panelStyles).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))')
    expect(panelStyles).toContain('color: var(--ui-primary);')
  })

  test('Given 检测到新版本 When 渲染设置菜单 Then 关于/更新菜单显示小红点提醒', () => {
    expect(panelSource).toContain("import { hasUpdateAtom } from '@/atoms/updater'")
    expect(panelSource).toContain('const hasUpdate = useAtomValue(hasUpdateAtom)')
    expect(panelSource).toContain("item.id === 'about' && hasUpdate")
    expect(panelSource).toContain('copis-working-settings-nav-update-dot')
    expect(panelStyles).toContain('.copis-working-settings-nav-update-dot')
  })

  test('Given 账户设置三个卡片 When 渲染右上角操作按钮 Then 按钮颜色与顶部刷新按钮保持一致', () => {
    const freshPanelStyles = readFileSync(join(import.meta.dir, 'CopisWorkingSettingsPanel.css'), 'utf8')
    // 顶部操作按钮（刷新）的颜色规范
    expect(freshPanelStyles).toContain('.copis-working-settings-actions button {')
    // 卡片操作按钮采用相同的 card 背景、border 边框与前景色
    expect(freshPanelStyles).toContain('.copis-working-settings-card-action {')
    expect(freshPanelStyles).toContain('.copis-working-settings-primary-button,\n.copis-working-settings-vip-button,\n.copis-working-settings-invite-button {')
    expect(freshPanelStyles).toContain('border: 1px solid hsl(var(--border) / 0.8);')
    expect(freshPanelStyles).toContain('background: hsl(var(--card) / 0.7);')
    expect(freshPanelStyles).toContain('color: hsl(var(--foreground));')
  })
})
