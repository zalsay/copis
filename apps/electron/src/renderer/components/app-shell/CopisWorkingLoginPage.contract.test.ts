import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const showcasePath = join(import.meta.dir, 'CopisWorkingLoginShowcase.tsx')
const showcaseStylesPath = join(import.meta.dir, 'CopisWorkingLoginShowcase.css')
const dialogSource = readFileSync(join(import.meta.dir, 'CopisWorkingLoginDialog.tsx'), 'utf8')
const dialogStyles = readFileSync(join(import.meta.dir, 'CopisWorkingLoginDialog.css'), 'utf8')
const showcaseStyles = readIfPresent(showcaseStylesPath)

function ruleBody(styles: string, selector: string): string {
  return styles.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 's'))?.[1] ?? ''
}

function readIfPresent(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

describe('Working 登录页轮播行为契约', () => {
  test('Given 未登录入口 When 查看产品展示 Then 使用三张 Landing Page 主题的独立轮播', () => {
    const source = readIfPresent(showcasePath)

    expect(source).toContain('export const COPIS_WORKING_LOGIN_SHOWCASE_SLIDES')
    expect(source).toContain("id: 'hero'")
    expect(source).toContain("id: 'browser'")
    expect(source).toContain("id: 'workflow'")
    expect(source).toContain('CopisWorkingLoginShowcase')
    expect(source).toContain('copis-working-login-showcase')
    expect(source).toContain('aria-hidden')
  })

  test('Given 用户操作轮播 When 切换主题 Then 提供方向按钮、分页状态和自动轮播暂停边界', () => {
    const source = readIfPresent(showcasePath)
    const styles = readIfPresent(showcaseStylesPath)

    expect(source).toContain('prefers-reduced-motion')
    expect(source).toContain('setIsPaused')
    expect(source).toContain('aria-pressed')
    expect(source).toContain('上一张产品介绍')
    expect(source).toContain('下一张产品介绍')
    expect(styles).toContain('.copis-working-login-showcase')
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
  })

  test('Given 全屏登录页 When 左右展示认证与轮播 Then 两侧使用同一高度和背景 surface', () => {
    const pageRule = ruleBody(dialogStyles, '\\.copis-working-auth-page')
    const authPanelRule = ruleBody(dialogStyles, '\\.copis-working-auth-page \\.copis-working-auth-panel')
    const showcaseRule = ruleBody(showcaseStyles, '\\.copis-working-auth-page \\.copis-working-login-showcase')

    expect(pageRule).toContain('--copis-working-login-surface-height: min(760px, calc(100dvh - 56px))')
    expect(pageRule).toContain('background: hsl(var(--content-area))')
    expect(pageRule).toContain('place-items: center')
    expect(pageRule).toContain('grid-template-columns: minmax(0, 760px) minmax(390px, 482px)')
    expect(authPanelRule).toContain('height: var(--copis-working-login-surface-height)')
    expect(authPanelRule).toContain('background: hsl(var(--dialog))')
    expect(showcaseRule).toContain('height: var(--copis-working-login-surface-height)')
    expect(showcaseRule).toContain('background: hsl(var(--dialog))')
  })

  test('Given 未登录 When 点击登录 Then 使用 Pi 账号 OAuth 并通过本机回调完成认证', () => {
    expect(dialogSource).toContain('window.electronAPI.loginWorkingWithOAuth()')
    expect(dialogSource).toContain('使用 Pi 账号登录')
    expect(dialogSource).toContain('正在等待 Pi 授权...')
    expect(dialogSource).toContain('onAuthenticated(state)')
    expect(dialogSource).not.toContain('window.electronAPI.loginWorking(')
    expect(dialogSource).not.toContain('window.electronAPI.registerWorking')
    expect(dialogSource).not.toContain('window.electronAPI.sendWorkingVerificationCode')
    expect(dialogSource).not.toContain('window.electronAPI.verifyWorkingPasswordResetCode')
    expect(dialogSource).not.toContain('window.electronAPI.resetWorkingPassword')
    expect(dialogSource).toContain('<h1 id="copis-working-auth-title">欢迎回来</h1>')
    expect(dialogSource).toContain('登录后继续进入你的工作空间。')
  })

  test('Given OAuth 登录页 When 查看认证关系 Then 展示 Copis 与 Pi 账户的授权关系', () => {
    expect(dialogSource).toContain('copis-working-auth-partner')
    expect(dialogSource).toContain('Copis 账户与 Pi 账户')
    expect(dialogSource).toContain('copis-working-auth-partner-separator')
    expect(dialogSource).toContain('>×</span>')
    expect(dialogSource).toContain("import PiLogo from '@/assets/pi-logo.svg'")
    expect(dialogSource).toContain('copis-working-auth-pi-logo')
    expect(dialogSource).toContain('src={PiLogo}')
    expect(dialogSource).toContain('<span>Pi 账户</span>')
  })

  test('Given OAuth 登录页 When 查看认证内容 Then 标题说明与操作区域垂直居中', () => {
    const panelRule = ruleBody(dialogStyles, '\\.copis-working-auth-page \\.copis-working-auth-panel')
    const contentRule = ruleBody(dialogStyles, '\\.copis-working-auth-content')
    const partnerRule = ruleBody(dialogStyles, '\\.copis-working-auth-partner')
    const closeRule = ruleBody(dialogStyles, '\\.copis-working-auth-close')
    const headerRule = ruleBody(dialogStyles, '\\.copis-working-auth-header')
    const headerTitleRule = ruleBody(dialogStyles, '\\.copis-working-auth-header h1')
    const headerParagraphRule = ruleBody(dialogStyles, '\\.copis-working-auth-header p')
    const formRule = ruleBody(dialogStyles, '\\.copis-working-auth-form')

    expect(dialogSource).toContain('copis-working-auth-content')
    expect(panelRule).toContain('display: flex')
    expect(panelRule).toContain('flex-direction: column')
    expect(contentRule).toContain('flex: 1')
    expect(contentRule).toContain('flex-direction: column')
    expect(contentRule).toContain('justify-content: center')
    expect(contentRule).toContain('transform: translateY(-28px)')
    expect(partnerRule).toContain('margin-left: 0')
    expect(closeRule).toContain('margin-left: auto')
    expect(headerRule).toContain('margin: 34px 0')
    expect(headerTitleRule).toContain('margin: 0 0 14px')
    expect(headerParagraphRule).toContain('line-height: 1.8')
    expect(headerRule).not.toContain('text-align: center')
    expect(headerParagraphRule).toContain('margin: 0')
    expect(formRule).toContain('gap: 24px')
  })

  test('Given Copis 尚未登录 When 挂载认证入口 Then 默认显示登录表单并保留认证切换布局', () => {
    expect(dialogSource).toContain("from './CopisWorkingLoginShowcase'")
    expect(dialogSource).toContain('copis-working-auth-page')
    expect(dialogSource).toContain('dismissible ?')
    expect(dialogSource).toContain('className="copis-working-auth-form"')
    expect(dialogSource).not.toContain('copis-working-auth-switch')
    expect(dialogSource).not.toContain('copis-working-reset-modal')
    expect(dialogStyles).toContain('.copis-working-auth-submit')
  })
})
