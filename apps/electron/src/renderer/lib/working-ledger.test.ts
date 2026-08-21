import { describe, expect, test } from 'bun:test'
import type { WorkingLedgerEntry, WorkingOrder } from '@copis/shared'
import {
  createDiamondPurchaseLedgerEntries,
  formatWorkingDiscount,
  formatWorkingLedgerDescription,
  formatWorkingLedgerTitle,
  paginateWorkingLedgerEntries,
  selectWorkingConsumptionLedgerEntries,
} from './working-ledger'

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
describe('Working 钻石流水分栏', () => {
  test('Given 混合流水 When 选择消耗 Then 仅保留扣费记录', () => {
    const entries: WorkingLedgerEntry[] = [
      { ...modelEntry(), id: 'charge-1', type: 'charge', createdAt: '2026-08-12T17:03:55Z' },
      { ...modelEntry(), id: 'purchase-1', type: 'purchase', createdAt: '2026-08-12T17:03:54Z' },
    ]

    expect(selectWorkingConsumptionLedgerEntries(entries)).toEqual([
      expect.objectContaining({ id: 'charge-1', type: 'charge' }),
    ])
  })

  test('Given 已支付钻石订单 When 创建获取流水 Then 使用到账时间和钻石数量', () => {
    const orders: WorkingOrder[] = [
      { id: 2, outTradeNo: 'PAID-2', orderType: 'diamond_recharge', title: '钻石充值', amount: '9.90', currency: 'CNY', diamonds: 100, vipDays: 0, method: 'alipay', status: 'paid', createdAt: '2026-08-12T16:04:00Z', paidAt: '2026-08-12T16:05:00Z' },
      { id: 1, outTradeNo: 'PENDING-1', orderType: 'diamond_recharge', title: '钻石充值', amount: '9.90', currency: 'CNY', diamonds: 100, vipDays: 0, method: 'alipay', status: 'pending', createdAt: '2026-08-12T16:06:00Z' },
      { id: 3, outTradeNo: 'VIP-3', orderType: 'vip_upgrade', title: 'VIP', amount: '49.90', currency: 'CNY', diamonds: 0, vipDays: 30, method: 'alipay', status: 'paid', createdAt: '2026-08-12T16:07:00Z' },
    ]

    expect(createDiamondPurchaseLedgerEntries(orders, 7)).toEqual([
      expect.objectContaining({ id: 'order:2', payerUserId: 7, type: 'purchase', amountTokens: 100, createdAt: '2026-08-12T16:05:00Z' }),
    ])
  })

  test('Given 九条流水 When 分页 Then 每页八条', () => {
    const entries = Array.from({ length: 9 }, (_, index) => ({ ...modelEntry(), id: `entry-${index}` }))

    expect(paginateWorkingLedgerEntries(entries, 2, 8)).toEqual({
      items: [expect.objectContaining({ id: 'entry-8' })],
      page: 2,
      totalPages: 2,
    })
  })
})

describe('Working 钻石扣费折扣与标题', () => {
  test('Given 各种扣费系数与百分比 When 格式化折扣 Then 返回对应中文折数', () => {
    // 后端返回整数百分比（如 80、60、85、20）
    expect(formatWorkingDiscount(80)).toBe('8折')
    expect(formatWorkingDiscount(60)).toBe('6折')
    expect(formatWorkingDiscount(85)).toBe('8.5折')
    expect(formatWorkingDiscount(50)).toBe('5折')
    expect(formatWorkingDiscount(20)).toBe('2折')
    expect(formatWorkingDiscount(75)).toBe('7.5折')
    expect(formatWorkingDiscount(100)).toBe('')

    // 浮点比例（如 0.8、0.6）
    expect(formatWorkingDiscount(0.8)).toBe('8折')
    expect(formatWorkingDiscount(0.6)).toBe('6折')
    expect(formatWorkingDiscount(0.85)).toBe('8.5折')
    expect(formatWorkingDiscount(0.5)).toBe('5折')
    expect(formatWorkingDiscount(0.2)).toBe('2折')
    expect(formatWorkingDiscount(0.75)).toBe('7.5折')
    expect(formatWorkingDiscount(1)).toBe('')
    expect(formatWorkingDiscount(1.2)).toBe('')
    expect(formatWorkingDiscount(0)).toBe('')
    expect(formatWorkingDiscount(-0.5)).toBe('')
    expect(formatWorkingDiscount(undefined)).toBe('')
    expect(formatWorkingDiscount(NaN)).toBe('')
  })

  test('Given 带有折扣的 Copis 模型扣费 When 格式化标题 Then 在 Copis 模型扣费 后面追加折扣', () => {
    // 后端返回 80 折扣
    const entryDiscount80 = { ...modelEntry('fast'), discount: 80 }
    expect(formatWorkingLedgerTitle(entryDiscount80)).toBe('Copis 模型扣费（8折）')

    // 后端返回 60 折扣
    const entryDiscount60 = { ...modelEntry('export'), discount: 60 }
    expect(formatWorkingLedgerTitle(entryDiscount60)).toBe('Copis 模型扣费（6折）')

    const entry80 = { ...modelEntry('fast'), deductionMultiplier: 0.8 }
    expect(formatWorkingLedgerTitle(entry80)).toBe('Copis 模型扣费（8折）')

    const entry85 = { ...modelEntry('export'), deductionMultiplier: 0.85 }
    expect(formatWorkingLedgerTitle(entry85)).toBe('Copis 模型扣费（8.5折）')

    const entry50 = { ...modelEntry('deepseek-v4-flash'), deductionMultiplier: 50 }
    expect(formatWorkingLedgerTitle(entry50)).toBe('Copis 模型扣费（5折）')
  })

  test('Given 无折扣或标准扣费 When 格式化标题 Then 显示 Copis 模型扣费', () => {
    const entryStandard100 = { ...modelEntry('fast'), discount: 100 }
    expect(formatWorkingLedgerTitle(entryStandard100)).toBe('Copis 模型扣费')

    const entryStandard = { ...modelEntry('fast'), deductionMultiplier: 1 }
    expect(formatWorkingLedgerTitle(entryStandard)).toBe('Copis 模型扣费')

    const entryNoMultiplier = modelEntry('fast')
    expect(formatWorkingLedgerTitle(entryNoMultiplier)).toBe('Copis 模型扣费')
  })

  test('Given 非 Copis 模型扣费类型 When 格式化标题 Then 保持对应标题不变', () => {
    expect(formatWorkingLedgerTitle({ ...modelEntry(), type: 'purchase' })).toBe('获取钻石')
    expect(formatWorkingLedgerTitle({ ...modelEntry(), type: 'transfer' })).toBe('成员转账')
    expect(formatWorkingLedgerTitle({ ...modelEntry(), type: 'reward' })).toBe('每日签到')
    expect(formatWorkingLedgerTitle({ ...modelEntry(), sourceType: 'daily_checkin' })).toBe('每日签到')
    expect(formatWorkingLedgerTitle({ ...modelEntry(), sourceType: 'pi_office_model' })).toBe('专家团扣费')
    expect(formatWorkingLedgerTitle({ ...modelEntry(), modelAlias: undefined })).toBe('AI 扣费')
  })
})
