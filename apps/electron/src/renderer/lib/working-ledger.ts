import type { WorkingLedgerEntry, WorkingOrder } from '@copis/shared'

export interface WorkingLedgerPage {
  items: WorkingLedgerEntry[]
  page: number
  totalPages: number
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
