import type { WorkingLedgerEntry } from '@copis/shared'

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
