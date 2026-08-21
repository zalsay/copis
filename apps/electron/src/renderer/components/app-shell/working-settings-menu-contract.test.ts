import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const panelSource = readFileSync(join(import.meta.dir, 'CopisWorkingSettingsPanel.tsx'), 'utf8')
const panelStyles = readFileSync(join(import.meta.dir, 'CopisWorkingSettingsPanel.css'), 'utf8')
const ledgerSource = readFileSync(join(import.meta.dir, '..', '..', 'lib', 'working-ledger.ts'), 'utf8')
const globalStyles = readFileSync(join(import.meta.dir, '..', '..', 'styles', 'globals.css'), 'utf8')
const tabAtomsSource = readFileSync(join(import.meta.dir, '..', '..', 'atoms', 'tab-atoms.ts'), 'utf8')
const tabContentSource = readFileSync(join(import.meta.dir, '..', 'tabs', 'TabContent.tsx'), 'utf8')

describe('Working 设置菜单契约', () => {
  test('Given Working 设置 When 读取菜单定义 Then 保留旧菜单并包含四个迁移页面', () => {
    const requiredSections = [
      ['settings', '账户设置'],
      ['messages', '工作消息接收方式'],
      ['orders', '我的订单'],
      ['tutorial', '查看使用教程'],
      ['voice-input', '语音输入'],
      ['migration', '数据迁移'],
      ['storage', '磁盘管理'],
      ['appearance', '外观设置'],
      ['about', '关于/更新'],
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
    expect(panelSource).toContain('handleOpenTutorial')
    expect(panelSource).toContain('openTab')
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

  test('Given Working 查看使用教程 When 打开菜单 Then 通过现有教程 Tab 和 IPC 加载页面', () => {
    expect(tabAtomsSource).toContain("export type TabType = 'agent' | 'preview' | 'tutorial'")
    expect(tabAtomsSource).toContain('TUTORIAL_TAB_ID')
    expect(tabAtomsSource).toContain("if (item.type === 'tutorial')")
    expect(tabContentSource).toContain('TutorialTabContent')
    expect(tabContentSource).toContain('getTutorialContent')
  })
})
