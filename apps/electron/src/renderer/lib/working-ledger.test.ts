import { describe, expect, test } from 'bun:test'
import type { WorkingLedgerEntry } from '@copis/shared'
import { formatWorkingLedgerDescription } from './working-ledger'

function modelEntry(modelAlias?: string): WorkingLedgerEntry {
  return {
    id: 'ledger-1',
    payerUserId: 7,
    amountTokens: 1,
    type: 'charge',
    sourceType: 'owner_priority',
    modelAlias,
    memo: '旧模型扣费备注',
  }
}

describe('Working 钻石流水文案', () => {
  test('Given fast alias When 格式化模型扣费 Then 显示 Copis 快速 Token消耗', () => {
    expect(formatWorkingLedgerDescription(modelEntry('fast'), '官方')).toBe('模型 · Copis 快速 Token消耗')
  })

  test('Given export alias When 格式化模型扣费 Then 显示 Copis 专家 Token消耗', () => {
    expect(formatWorkingLedgerDescription(modelEntry('export'), '官方')).toBe('模型 · Copis 专家 Token消耗')
  })

  test('Given 其他 alias When 格式化模型扣费 Then 原样显示 alias', () => {
    expect(formatWorkingLedgerDescription(modelEntry('deepseek-v4-flash'), '官方')).toBe('模型 · deepseek-v4-flash Token消耗')
  })

  test('Given 缺少 alias 或非模型流水 When 格式化 Then 保留原付款方和备注', () => {
    expect(formatWorkingLedgerDescription(modelEntry(), '官方')).toBe('官方 / 旧模型扣费备注')
    expect(formatWorkingLedgerDescription({ ...modelEntry('fast'), sourceType: 'daily_checkin' }, '官方')).toBe('官方 / 旧模型扣费备注')
  })

  test('Given 家庭钱包 owner_priority 流水 When 格式化 Then 按模型 alias 展示', () => {
    expect(formatWorkingLedgerDescription(modelEntry('deepseek-v4-flash'), '官方')).toBe('模型 · deepseek-v4-flash Token消耗')
    expect(formatWorkingLedgerDescription(modelEntry('fast'), '官方')).toBe('模型 · Copis 快速 Token消耗')
  })

  test('Given working_model 流水 When 格式化 Then 按模型 alias 展示', () => {
    expect(formatWorkingLedgerDescription({ ...modelEntry('export'), sourceType: 'working_model' }, '官方')).toBe('模型 · Copis 专家 Token消耗')
  })

  test('Given pi_office_model 专家团流水 When 格式化描述 Then 仍按模型 alias 展示', () => {
    expect(formatWorkingLedgerDescription({ ...modelEntry('deepseek-v4-flash'), sourceType: 'pi_office_model', memo: '专家团 Pi 模型消耗' }, '官方')).toBe('模型 · deepseek-v4-flash Token消耗')
  })

  test('Given copis-agent-model 流水 When 格式化 Then 按模型 alias 展示', () => {
    expect(formatWorkingLedgerDescription({ ...modelEntry('fast'), sourceType: 'copis-agent-model', memo: 'Copis Agent 模型消耗' }, '官方')).toBe('模型 · Copis 快速 Token消耗')
  })
})
