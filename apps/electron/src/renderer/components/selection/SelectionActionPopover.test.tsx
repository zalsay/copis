import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { SelectionActionPopover } from './SelectionActionPopover'

describe('Agent 选区动作', () => {
  test('第二个动作调用 Agent 问答回调，不依赖 Chat conversation API', () => {
    let addToAgentCalls = 0
    let openQuestionCalls = 0
    const element = SelectionActionPopover({
      x: 10,
      y: 20,
      onAddToAgent: () => { addToAgentCalls += 1 },
      onOpenAgentQuestion: () => { openQuestionCalls += 1 },
    })

    const buttonGroup = element.props.children as React.ReactElement
    const buttons = buttonGroup.props.children as React.ReactElement[]
    buttons[0]?.props.onClick()
    buttons[1]?.props.onClick()

    expect(addToAgentCalls).toBe(1)
    expect(openQuestionCalls).toBe(1)
  })
})
