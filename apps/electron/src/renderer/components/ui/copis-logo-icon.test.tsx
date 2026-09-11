import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CopisLogoIcon } from './copis-logo-icon'

describe('CopisLogoIcon', () => {
  test('Given CopisLogoIcon When 默认渲染 Then 输出包含 560x560 viewBox 与双环 path 的 SVG', () => {
    const html = renderToStaticMarkup(<CopisLogoIcon />)

    expect(html).toContain('viewBox="347 347 560 560"')
    expect(html).toContain('fill="currentColor"')
    expect(html).toContain('aria-hidden="true"')
    // 双环外环与内环特征点
    expect(html).toContain('M 725.5 791.5')
    expect(html).toContain('M 563.5 803.5')
  })

  test('Given 指定 className 与自定义尺寸 When 渲染 Then 正确应用属性', () => {
    const html = renderToStaticMarkup(
      <CopisLogoIcon size={20} className="w-5 h-5 text-[var(--ui-primary)]" />
    )

    expect(html).toContain('width="20"')
    expect(html).toContain('height="20"')
    expect(html).toContain('class="w-5 h-5 text-[var(--ui-primary)]"')
  })
})
