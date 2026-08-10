/**
 * Shared utility functions for copis
 */

// Placeholder - will be expanded as needed
export function noop(): void {
  // no-op
}

export { diffCapabilities } from './capabilities-diff'
export type { CapabilityChange } from './capabilities-diff'
export {
  DEFAULT_CONTEXT_WINDOW,
  ONE_MILLION_CONTEXT_WINDOW,
  CODEX_GPT_54_55_CONTEXT_WINDOW,
  CODEX_GPT_54_MINI_CONTEXT_WINDOW,
  CODEX_GPT_56_CONTEXT_WINDOW,
  inferCodexAlignedGPT5ContextWindow,
  supports1MContext,
  inferContextWindow,
  inferAgentContextWindow,
} from './context-window'
export { calculateContextUsageRatio } from './context-usage'
export {
  PI_AUTO_COMPACTION_THRESHOLD_RATIO,
  calculatePiAutoCompactionReserveTokens,
  calculatePiAutoCompactionThresholdTokens,
} from './pi-compaction'
export {
  inferMcpTransportType,
  normalizeMcpTransportType,
} from './mcp-transport'
export {
  THINKING_SIGNATURE_ERROR_CODE,
  THINKING_SIGNATURE_ERROR_TITLE,
  THINKING_SIGNATURE_ERROR_MESSAGE,
  isThinkingSignatureError,
  formatThinkingSignatureError,
  normalizeThinkingSignatureError,
} from './thinking-signature-error'
export { normalizePathForCompare } from './normalize-path'
export {
  AUTOMATION_OCCURRENCE_SAMPLES_PER_DAY,
  getAutomationOccurrencesByDay,
} from './automation-schedule'
export type {
  AutomationOccurrenceDay,
  AutomationScheduleFields,
} from './automation-schedule'
export {
  getSDKCompactStatus,
  isPersistableSDKSystemMessage,
  type SDKCompactStatus,
} from './agent-system-message'
export {
  adaptWorkingStreamComplete,
  adaptWorkingStreamError,
  adaptWorkingStreamEvent,
} from './working-event-adapter'
export {
  getWorkingPaymentCheckError,
  isWorkingPaymentCheckFailure,
  isWorkingVipDiamondPackage,
  normalizeWorkingDiamondPackage,
  normalizeWorkingDiamondPackages,
  normalizeWorkingDiamondPurchaseResult,
  normalizeWorkingOrderPayment,
  normalizeWorkingPaymentCancelResult,
  normalizeWorkingPaymentCheckResult,
  normalizeWorkingPendingDiamondPurchase,
  WorkingPaymentNormalizationError,
} from './working-payment'
