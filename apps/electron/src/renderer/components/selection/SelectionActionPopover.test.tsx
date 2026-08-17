import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { SelectionActionPopover } from './SelectionActionPopover'

describe('Agent 选区动作', () => {
  test('默认只显示引用动作', () => {
    let addToAgentCalls = 0
    const element = SelectionActionPopover({
      x: 10,
      y: 20,
      onAddToAgent: () => { addToAgentCalls += 1 },
    })

    const buttonGroup = element.props.children as React.ReactElement
    const buttons = React.Children.toArray(buttonGroup.props.children) as React.ReactElement[]
    buttons[0]?.props.onClick()

    expect(addToAgentCalls).toBe(1)
    expect(buttons).toHaveLength(1)
  })

  test('提供回调时保留 Agent 问答动作', () => {
    let openQuestionCalls = 0
    const element = SelectionActionPopover({
      x: 10,
      y: 20,
      onAddToAgent: () => {},
      onOpenAgentQuestion: () => { openQuestionCalls += 1 },
    })

    const buttonGroup = element.props.children as React.ReactElement
    const buttons = React.Children.toArray(buttonGroup.props.children) as React.ReactElement[]
    buttons[1]?.props.onClick()

    expect(openQuestionCalls).toBe(1)
  })
})
