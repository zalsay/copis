import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dialogStyles = readFileSync(join(import.meta.dir, 'CopisWorkingConnectDialog.css'), 'utf8')
const dialogSource = readFileSync(join(import.meta.dir, 'CopisWorkingConnectDialog.tsx'), 'utf8')
const globalStyles = readFileSync(join(import.meta.dir, '../../styles/globals.css'), 'utf8')

function ruleBody(selector: string): string {
  return dialogStyles.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 's'))?.[1] ?? ''
}

describe('创建工作区弹窗视觉契约', () => {
  test('Given 创建工作区弹窗 When 查看本地目录 active 标签 Then 使用 primary 实色背景与 primary-foreground 前景', () => {
    const activeRule = ruleBody('\\.copis-working-connect-location \\.active')

    expect(globalStyles).toContain('--ui-primary: #f5c18e;')
    expect(globalStyles).toContain('--ui-primary-background: rgb(240 161 90 / 10%);')
    expect(globalStyles).toContain('--ui-primary-foreground: #2b2137;')
    expect(activeRule).toContain('background: var(--ui-primary)')
    expect(activeRule).toContain('color: var(--ui-primary-foreground)')
  })

  test('Given 创建工作区弹窗 When 查看目录选择器 Then 所有强调色使用 primary tokens', () => {
    const pickerRule = ruleBody('\\.copis-working-connect-picker')
    const pickerHoverRule = ruleBody('\\.copis-working-connect-picker:hover\\:not\\(:disabled\\)')
    const pickerIconRule = ruleBody('\\.copis-working-connect-picker svg')

    expect(pickerRule).toContain('var(--ui-primary)')
    expect(pickerRule).toContain('var(--ui-primary-background)')
    expect(pickerHoverRule).toContain('var(--ui-primary)')
    expect(pickerHoverRule).toContain('var(--ui-primary-background)')
    expect(pickerIconRule).toContain('var(--ui-primary-background)')
    expect(pickerIconRule).toContain('var(--ui-primary)')
  })

  test('Given 创建工作区弹窗 When 查看勾选态与焦点态 Then 不残留旧紫色强调值', () => {
    const checkedRule = ruleBody('\\.copis-working-connect-check input\\:checked \\+ \\.copis-working-connect-check-box')
    const focusRule = ruleBody('\\.copis-working-connect-check input\\:focus-visible \\+ \\.copis-working-connect-check-box')

    expect(checkedRule).toContain('var(--ui-primary)')
    expect(focusRule).toContain('var(--ui-primary)')
    expect(dialogStyles).not.toContain('#c8a7ff')
    expect(dialogStyles).not.toContain('rgba(200, 167, 255')
    expect(dialogStyles).not.toContain('linear-gradient(180deg, rgba(200, 167, 255')
  })

  test('Given 创建工作区弹窗 When 查看权限说明 note Then border/background/color 使用 primary tokens 且无橙色残留', () => {
    const noteRule = ruleBody('\\.copis-working-connect-note')

    expect(noteRule).toContain('var(--ui-primary)')
    expect(noteRule).toContain('var(--ui-primary-background)')
    expect(dialogStyles).not.toContain('rgba(245, 158, 11')
    expect(dialogStyles).not.toContain('#f7c46a')
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
    expect(dialogSource).toContain('onConfirm(selection, allowWorkspaceWrite)')
    expect(dialogSource).toContain('onClick={onClose}')
  })
})
