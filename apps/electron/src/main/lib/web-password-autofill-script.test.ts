import { describe, expect, test } from 'bun:test'
import {
  buildAutofillDetectionScript,
  buildAutofillExecutionScript,
  buildAutofillWatcherScript,
} from './web-password-autofill-script'

describe('WebPasswordAutofillScript 密码待选下拉脚本生成器', () => {
  test('buildAutofillDetectionScript 生成有效的表单提交拦截监听脚本', () => {
    const script = buildAutofillDetectionScript()
    expect(script).toContain('__copisAutofillDetectionInstalled')
    expect(script).toContain('captureAndSubmit')
    expect(script).toContain('login-submit')
    expect(script).toContain('findUsernameInput')
  })

  test('buildAutofillWatcherScript 不在页面初始化时默认自动填入输入框', () => {
    const script = buildAutofillWatcherScript({
      accounts: [
        { id: '1', username: 'alice@example.com', passwordPlain: 'pass1' },
      ],
    })

    // 严禁包含初始化无交互直接执行填充的函数调用
    expect(script).not.toContain('tryFill()')
    expect(script).not.toContain('if (tryFill()) return')
  })

  test('buildAutofillWatcherScript 包含点击与聚焦触发下拉浮层的事件委托机制', () => {
    const script = buildAutofillWatcherScript({
      accounts: [
        { id: '1', username: 'alice@example.com', passwordPlain: 'pass1' },
        { id: '2', username: 'bob@example.com', passwordPlain: 'pass2' },
      ],
    })

    // 验证事件监听：点击与聚焦
    expect(script).toContain("document.addEventListener('focusin'")
    expect(script).toContain("document.addEventListener('click'")
    expect(script).toContain('isRelevantInput')
    expect(script).toContain('showDropdown')

    // 验证 Shadow DOM 与下拉弹层类名
    expect(script).toContain('__copis_autofill_dropdown_host__')
    expect(script).toContain('attachShadow')
    expect(script).toContain('copis-dropdown')
    expect(script).toContain('copis-item')

    // 验证包含全部已保存账号
    expect(script).toContain('alice@example.com')
    expect(script).toContain('bob@example.com')

    // 验证钥匙图标与 ui-primary 配色
    expect(script).toContain('copis-icon')
    expect(script).toContain('--ui-primary')
    expect(script).toContain('--ui-primary-background')
    expect(script).toContain('copis-badge')

    // 验证关闭与键盘导航支持
    expect(script).toContain('hideDropdown')
    expect(script).toContain('Escape')
    expect(script).toContain('ArrowDown')
    expect(script).toContain('ArrowUp')
    expect(script).toContain('Enter')
  })

  test('buildAutofillWatcherScript 待选浮层正确注入与渲染传入的自定义主题色与主题背景色', () => {
    const script = buildAutofillWatcherScript({
      accounts: [
        { id: '1', username: 'custom@example.com', passwordPlain: 'pwd' },
      ],
      theme: {
        primaryColor: '#3b82f6',
        primaryBackground: 'rgba(59, 130, 246, 0.2)',
        isDark: false,
      },
    })

    // 验证 payload 包含 theme 配置
    expect(script).toContain('"primaryColor":"#3b82f6"')
    expect(script).toContain('"primaryBackground":"rgba(59, 130, 246, 0.2)"')
    expect(script).toContain('"isDark":false')

    // 验证 Shadow DOM 内部变量绑定
    expect(script).toContain('--ui-primary: ${primaryColor}')
    expect(script).toContain('--ui-primary-background: ${primaryBackground}')
    expect(script).toContain('background: var(--ui-primary-background)')
    expect(script).toContain('color: var(--ui-primary)')
    expect(script).toContain('.copis-item:hover, .copis-item.selected')
    expect(script).toContain('.copis-icon')
  })

  test('buildAutofillExecutionScript 生成主动单次填入脚本', () => {
    const script = buildAutofillExecutionScript({
      username: 'charlie',
      passwordPlain: 'pwd123',
    })

    expect(script).toContain('charlie')
    expect(script).toContain('pwd123')
    expect(script).toContain('setInputValue')
  })
})
