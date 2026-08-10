import { atom } from 'jotai'
import type {
  WorkingAlipayPagePayOrder,
  WorkingDiamondPackage,
  WorkingPaymentSession,
  WorkingPendingDiamondPurchase,
  WorkingPaymentIdentifier,
  WorkingVipPaymentSummary,
} from '@copis/shared'

export type WorkingPaymentMode = 'diamonds' | 'vip'
export type WorkingDiamondPaymentMethod = 'agent' | 'alipay_page'

export type WorkingPaymentPhase =
  | 'idle'
  | 'loading'
  | 'pending'
  | 'selecting'
  | 'creating'
  | 'cancelling'
  | 'waiting_user_pay'
  | 'checking'
  | 'resource_pending'
  | 'success'
  | 'error'

export interface WorkingPaymentState {
  open: boolean
  mode: WorkingPaymentMode
  phase: WorkingPaymentPhase
  resumeOrderId?: WorkingPaymentIdentifier
  packages: WorkingDiamondPackage[]
  selectedPackageId?: number
  paymentMethod: WorkingDiamondPaymentMethod
  pendingPurchase?: WorkingPendingDiamondPurchase
  payment?: WorkingPaymentSession
  pageOrder?: WorkingAlipayPagePayOrder
  vip?: WorkingVipPaymentSummary
  error?: string
}

export interface WorkingPaymentOpenInput {
  mode: WorkingPaymentMode
  resumeOrderId?: WorkingPaymentIdentifier
}

export const EMPTY_WORKING_PAYMENT_STATE: WorkingPaymentState = {
  open: false,
  mode: 'diamonds',
  phase: 'idle',
  paymentMethod: 'agent',
  packages: [],
}

export const workingPaymentStateAtom = atom<WorkingPaymentState>(EMPTY_WORKING_PAYMENT_STATE)

/** 支付成功或订单状态变化后，设置页和订单页都通过这个版本号触发重新读取。 */
export const workingPaymentRefreshAtom = atom(0)

/** 支付流程结束后的短暂提示，只在内存中跨设置子页面传递。 */
export const workingPaymentNoticeAtom = atom<string | null>(null)

export const openWorkingPaymentAtom = atom(
  null,
  (_get, set, input: WorkingPaymentOpenInput): void => {
    set(workingPaymentStateAtom, {
      ...EMPTY_WORKING_PAYMENT_STATE,
      open: true,
      mode: input.mode,
      phase: input.resumeOrderId === undefined && input.mode === 'vip' ? 'selecting' : 'loading',
      ...(input.resumeOrderId === undefined ? {} : { resumeOrderId: input.resumeOrderId }),
    })
    set(workingPaymentNoticeAtom, null)
  },
)

export const closeWorkingPaymentAtom = atom(null, (_get, set): void => {
  set(workingPaymentStateAtom, EMPTY_WORKING_PAYMENT_STATE)
})

export const requestWorkingPaymentRefreshAtom = atom(
  null,
  (get, set, notice?: string): void => {
    set(workingPaymentRefreshAtom, get(workingPaymentRefreshAtom) + 1)
    if (notice) set(workingPaymentNoticeAtom, notice)
  },
)

export function isWorkingPaymentReady(status: string): boolean {
  return status === 'resource_ready'
}

export function phaseForWorkingPaymentStatus(status: string): WorkingPaymentPhase {
  switch (status) {
    case 'resource_ready':
      return 'success'
    case 'resource_pending':
      return 'resource_pending'
    case 'failed':
    case 'cancelled':
      return 'error'
    case 'pending_user_pay':
    case 'paid':
    case 'checking':
    case 'created':
    default:
      return 'waiting_user_pay'
  }
}
