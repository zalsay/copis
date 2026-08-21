import type { WorkingLedgerEntry, WorkingOrder } from '@copis/shared'

export interface WorkingLedgerPage {
  items: WorkingLedgerEntry[]
  page: number
  totalPages: number
}

export function formatWorkingDiscount(value?: number): string {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return ''
  }
  if (value <= 0 || value === 1 || value >= 100) {
    return ''
  }
  let discountNum: number
  if (value > 0 && value < 1) {
    discountNum = Number((value * 10).toFixed(2))
  } else if (value >= 10 && value < 100) {
    discountNum = Number((value / 10).toFixed(2))
  } else if (value >= 2 && value <= 9.5) {
    discountNum = Number(value.toFixed(2))
  } else {
    return ''
  }
  if (discountNum <= 0 || discountNum >= 10) {
    return ''
  }
  return `${discountNum}折`
}

export function formatWorkingLedgerTitle(entry: WorkingLedgerEntry): string {
  if (entry.type === 'purchase') return '获取钻石'
  if (entry.type === 'transfer') return '成员转账'
  if (entry.type === 'reward' || entry.sourceType === 'daily_checkin') return '每日签到'
  // pi_office_model 保留为专家团模型专用分类；Copis 内置 Agent 模型使用 copis-agent-model。
  if (entry.sourceType === 'pi_office_model') return '专家团扣费'
  if (isWorkingModelDeduction(entry) && entry.modelAlias) {
    const discount = formatWorkingDiscount(entry.discount ?? entry.deductionMultiplier)
    return discount ? `Copis 模型扣费（${discount}）` : 'Copis 模型扣费'
  }
  return 'AI 扣费'
}

export function formatWorkingLedgerDescription(entry: WorkingLedgerEntry, payer: string): string {
  if (isWorkingModelDeduction(entry) && entry.modelAlias) {
    const alias = entry.modelAlias.trim()
    const displayAlias = alias === 'fast' ? 'Copis 快速' : alias === 'export' ? 'Copis 专家' : alias
    return `模型 · ${displayAlias} Token消耗`
  }
  return entry.memo ? `${payer} / ${entry.memo}` : payer
}

export function isWorkingModelDeduction(entry: WorkingLedgerEntry): boolean {
  if (!entry.modelAlias) return false
  if (entry.sourceType === 'copis-agent-model' || entry.sourceType === 'pi_office_model' || entry.sourceType === 'working_model' || entry.sourceType === 'owner_priority') return true
  return entry.memo === '工作 Pi 模型消耗' || entry.memo === '专家团 Pi 模型消耗' || entry.memo === 'Copis Agent 模型消耗'
}

export function selectWorkingConsumptionLedgerEntries(entries: WorkingLedgerEntry[]): WorkingLedgerEntry[] {
  return entries.filter((entry) => entry.type === 'charge')
}

export function createDiamondPurchaseLedgerEntries(orders: WorkingOrder[], payerUserId: number | string): WorkingLedgerEntry[] {
  return orders
    .filter((order) => order.orderType === 'diamond_recharge' && order.status === 'paid' && order.diamonds > 0)
    .map((order) => ({
      id: `order:${order.id}`,
      payerUserId,
      beneficiaryUserId: payerUserId,
      amountTokens: order.diamonds,
      type: 'purchase',
      sourceType: 'alipay_diamond',
      memo: order.outTradeNo ? `支付宝获取钻石 · ${order.outTradeNo}` : '支付宝获取钻石',
      createdAt: order.paidAt ?? order.createdAt,
    }))
    .sort((left, right) => ledgerCreatedAt(right) - ledgerCreatedAt(left))
}

export function paginateWorkingLedgerEntries(entries: WorkingLedgerEntry[], targetPage: number, pageSize: number): WorkingLedgerPage {
  const safePageSize = Math.max(1, Math.floor(pageSize))
  const totalPages = Math.max(1, Math.ceil(entries.length / safePageSize))
  const page = Math.min(Math.max(1, Math.floor(targetPage)), totalPages)
  const start = (page - 1) * safePageSize
  return { items: entries.slice(start, start + safePageSize), page, totalPages }
}

function ledgerCreatedAt(entry: WorkingLedgerEntry): number {
  if (!entry.createdAt) return 0
  const timestamp = Date.parse(entry.createdAt)
  return Number.isNaN(timestamp) ? 0 : timestamp
}
