import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dialogStyles = readFileSync(join(import.meta.dir, 'CopisWorkingConnectDialog.css'), 'utf8')
const dialogSource = readFileSync(join(import.meta.dir, 'CopisWorkingConnectDialog.tsx'), 'utf8')

function ruleBody(selector: string): string {
  return dialogStyles.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 's'))?.[1] ?? ''
}

describe('创建工作区弹窗视觉契约', () => {
  test('Given 创建工作区弹窗 When 查看目录选择器 Then 静止态无边框无背景且强调色使用 primary tokens', () => {
    const pickerRule = ruleBody('\\.copis-working-connect-picker')
    const pickerHoverRule = ruleBody('\\.copis-working-connect-picker:hover\\:not\\(:disabled\\)')
    const pickerIconRule = ruleBody('\\.copis-working-connect-picker svg')

    expect(pickerRule).not.toContain('border: 1px')
    expect(pickerRule).not.toContain('background: var(--ui-primary-background)')
    expect(pickerRule).toContain('background: transparent')
    expect(pickerHoverRule).toContain('background: var(--ui-primary-background)')
    expect(pickerIconRule).toContain('var(--ui-primary-background)')
    expect(pickerIconRule).toContain('var(--ui-primary)')
  })

  test('Given 创建工作区弹窗 When 查看强调色 Then 不残留旧紫色强调值', () => {
    expect(dialogStyles).not.toContain('#c8a7ff')
    expect(dialogStyles).not.toContain('rgba(200, 167, 255')
    expect(dialogStyles).not.toContain('linear-gradient(180deg, rgba(200, 167, 255')
  })

  test('Given 创建工作区弹窗 When 查看底部创建按钮 Then 使用 primary 实色背景与 primary-foreground 前景且无白色背景', () => {
    const createRule = ruleBody('\\.copis-working-connect-actions button\\:last-child')
    const actionsHoverRule = ruleBody('\\.copis-working-connect-actions button\\:hover\\:not\\(:disabled\\)')

    expect(createRule).toContain('background: var(--ui-primary)')
    expect(createRule).toContain('color: var(--ui-primary-foreground)')
    expect(createRule).not.toContain('#f1f1f3')
    expect(createRule).not.toContain('#171717')
    expect(actionsHoverRule).toContain('brightness')
    expect(actionsHoverRule).not.toContain('#c8a7ff')
    expect(actionsHoverRule).not.toContain('rgba(245, 158, 11')
  })

  test('Given 创建工作区弹窗 When 检查交互入口 Then 保留目录选择与创建回调', () => {
    expect(dialogSource).toContain('window.electronAPI.openFolderDialog()')
    expect(dialogSource).toContain('onConfirm(selection)')
    expect(dialogSource).not.toContain('allowWorkspaceWrite')
    expect(dialogSource).not.toContain('Agent 可读取所选目录中的文件，并仅可写入同级 copis/ 与 project/ 目录。')
    expect(dialogSource).toContain('onClick={onClose}')
  })

  test('Given 创建工作区弹窗 When 查看弹窗表面与选择器结构 Then 使用主题卡片变量与新层级', () => {
    const modalRule = ruleBody('\\.copis-working-connect-modal')

    expect(modalRule).toContain('hsl(var(--card))')
    expect(modalRule).toContain('hsl(var(--card-foreground))')
    expect(dialogSource).toContain('copis-working-connect-heading-icon')
    expect(dialogSource).toContain('copis-working-connect-picker-copy')
    expect(dialogSource).toContain('copis-working-connect-picker-action')
  })
})
