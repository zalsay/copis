import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppSelect } from './select'

describe('AppSelect 全局统一下拉组件 BDD', () => {
  test('Given options 列表 When 渲染 AppSelect Then 正确展示默认选中项并包含 aria-label', () => {
    const options = [
      { value: 'all', label: '全部范围' },
      { value: 'user', label: '用户记忆' },
      { value: 'workspace', label: '工作区记忆' },
    ]

    const html = renderToStaticMarkup(
      <AppSelect
        value="user"
        options={options}
        aria-label="记忆范围"
        size="sm"
      />,
    )

    expect(html).toContain('aria-label="记忆范围"')
    expect(html).toContain('用户记忆')
  })

  test('Given 禁用状态 When 渲染 AppSelect Then 具有 disabled 属性', () => {
    const html = renderToStaticMarkup(
      <AppSelect
        value="0"
        options={[
          { value: '0', label: '禁用' },
          { value: '7', label: '7 天' },
        ]}
        disabled={true}
      />,
    )

    expect(html).toContain('disabled')
  })
})
