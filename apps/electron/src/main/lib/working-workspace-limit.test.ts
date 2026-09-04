import { describe, expect, test } from 'bun:test'
import {
  assertWorkingWorkspaceCreationAllowed,
  NON_VIP_WORKSPACE_LIMIT_ERROR,
} from './working-workspace-limit'

describe('Working 项目额度', () => {
  test('Given 非 VIP 仅有默认工作区 When 创建项目 Then 允许创建一个额外项目', () => {
    expect(() => assertWorkingWorkspaceCreationAllowed([{ slug: 'default' }], false)).not.toThrow()
  })

  test('Given 非 VIP 仅有默认工作区与「我的投资」固定工作区 When 创建项目 Then 允许创建一个额外项目', () => {
    expect(() => assertWorkingWorkspaceCreationAllowed([
      { slug: 'default' },
      { slug: 'investment' },
    ], false)).not.toThrow()
  })

  test('Given 非 VIP 已有默认工作区和一个额外项目 When 再创建项目 Then 拒绝创建', () => {
    expect(() => assertWorkingWorkspaceCreationAllowed([
      { slug: 'default' },
      { slug: 'investment' },
      { slug: 'my-project' },
    ], false)).toThrow(NON_VIP_WORKSPACE_LIMIT_ERROR)
  })

  test('Given VIP 或无法确认 VIP 状态 When 创建项目 Then VIP 不限额且未知状态按非 VIP 处理', () => {
    const workspaces = [{ slug: 'default' }, { slug: 'first-project' }]
    expect(() => assertWorkingWorkspaceCreationAllowed(workspaces, true)).not.toThrow()
    expect(() => assertWorkingWorkspaceCreationAllowed(workspaces, undefined)).toThrow(NON_VIP_WORKSPACE_LIMIT_ERROR)
  })
})
