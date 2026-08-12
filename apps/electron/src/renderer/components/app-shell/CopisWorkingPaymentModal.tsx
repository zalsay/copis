import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Check, CircleAlert, Crown, ExternalLink, Gem, Loader2, X } from 'lucide-react'
import type {
  WorkingDiamondPackage,
  WorkingDiamondPurchaseResult,
  WorkingPaymentSession,
  WorkingPaymentCheckResult,
  WorkingPendingDiamondPurchase,
  WorkingVipPaymentSummary,
  WorkingVipStatus,
} from '@copis/shared'
import {
  closeWorkingPaymentAtom,
  isWorkingPaymentReady,
  isWorkingPendingPaymentReusable,
  phaseForWorkingPaymentStatus,
  requestWorkingPaymentRefreshAtom,
  type WorkingPaymentState,
  workingPaymentStateAtom,
} from '@/atoms/working-payment-atoms'
import './CopisWorkingPaymentModal.css'

interface CopisWorkingPaymentModalProps {
  vipStatus: WorkingVipStatus | null
  onStartDiamondPurchase: (packageValue: WorkingDiamondPackage) => Promise<void>
}

interface VipBenefitRow {
  label: string
  free: string
  vip: string
}

const VIP_BENEFITS: readonly VipBenefitRow[] = [
  { label: '钻石消耗', free: '标准消耗', vip: '节省 20%' },
  { label: '专家团队', free: '不可用', vip: '可使用' },
  { label: '定时任务', free: '不可用', vip: '可使用' },
]

export function CopisWorkingPaymentModal({ vipStatus, onStartDiamondPurchase }: CopisWorkingPaymentModalProps): React.ReactElement | null {
  const paymentState = useAtomValue(workingPaymentStateAtom)
  const setPaymentState = useSetAtom(workingPaymentStateAtom)
  const closePayment = useSetAtom(closeWorkingPaymentAtom)
  const requestPaymentRefresh = useSetAtom(requestWorkingPaymentRefreshAtom)
  const operationRef = React.useRef(0)

  const beginOperation = React.useCallback((): number => {
    operationRef.current += 1
    return operationRef.current
  }, [])

  const isCurrentOperation = React.useCallback((operationId: number): boolean => {
    return operationRef.current === operationId
  }, [])

  const updatePaymentState = React.useCallback((operationId: number, update: (current: WorkingPaymentState) => WorkingPaymentState): void => {
    if (!isCurrentOperation(operationId)) return
    setPaymentState((current) => isCurrentOperation(operationId) ? update(current) : current)
  }, [isCurrentOperation, setPaymentState])

  const handleClose = React.useCallback((): void => {
    operationRef.current += 1
    closePayment()
  }, [closePayment])

  const handleConflict = React.useCallback((): void => {
    requestPaymentRefresh('订单状态已变化，已刷新订单列表。')
    handleClose()
  }, [handleClose, requestPaymentRefresh])

  React.useEffect(() => {
    if (!paymentState.open) return undefined
    if (paymentState.mode === 'vip' && paymentState.resumeOrderId === undefined) return undefined

    const operationId = beginOperation()
    updatePaymentState(operationId, (current) => ({ ...current, phase: 'loading', error: undefined }))

    const loadPaymentView = async (): Promise<void> => {
      try {
        if (paymentState.resumeOrderId !== undefined) {
          const resumed = await window.electronAPI.getWorkingOrderPayment(paymentState.resumeOrderId)
          if (!isCurrentOperation(operationId)) return
          if (!hasPaymentPresentation(resumed.payment)) throw new Error('支付二维码读取失败，请关闭后重试')
          updatePaymentState(operationId, (current) => ({
            ...current,
            phase: phaseForWorkingPaymentStatus(resumed.payment.status),
            packages: [resumed.package],
            selectedPackageId: resumed.package.id,
            payment: resumed.payment,
            vip: resumed.vip,
            error: undefined,
          }))
          return
        }

        const pending = await window.electronAPI.getPendingWorkingDiamondPurchase()
        if (!isCurrentOperation(operationId)) return
        if (pending && isWorkingPendingPaymentReusable(pending.payment)) {
          updatePaymentState(operationId, (current) => ({
            ...current,
            phase: 'pending',
            pendingPurchase: pending,
            error: undefined,
          }))
          return
        }

        const packages = await window.electronAPI.listWorkingDiamondPackages()
        if (!isCurrentOperation(operationId)) return
        if (packages.length === 0) throw new Error('当前没有可购买的钻石套餐')
        updatePaymentState(operationId, (current) => ({
          ...current,
          phase: 'selecting',
          packages,
          selectedPackageId: packages[0]?.id,
          error: undefined,
        }))
      } catch (error: unknown) {
        if (!isCurrentOperation(operationId)) return
        if (getPaymentErrorStatus(error) === 409) {
          handleConflict()
          return
        }
        const fallback = paymentState.resumeOrderId === undefined ? '读取支付信息失败，请关闭后重试' : '订单已失效，请刷新订单列表。'
        updatePaymentState(operationId, (current) => ({
          ...current,
          phase: 'error',
          error: getWorkingPaymentError(error, fallback),
        }))
      }
    }

    void loadPaymentView()
    return () => {
      if (operationRef.current === operationId) operationRef.current += 1
    }
  }, [beginOperation, handleConflict, isCurrentOperation, paymentState.mode, paymentState.open, paymentState.resumeOrderId, updatePaymentState])

  const selectedPackage = paymentState.packages.find((item) => item.id === paymentState.selectedPackageId)
  const isBusy = paymentState.phase === 'creating'
    || paymentState.phase === 'cancelling'
    || paymentState.phase === 'checking'
  const vipUpgradeUnavailable = vipStatus?.upgradeAvailable === false

  const applyCreatedPayment = React.useCallback((operationId: number, result: WorkingDiamondPurchaseResult): void => {
    if (!isCurrentOperation(operationId)) return
    if (!hasPaymentPresentation(result.payment)) {
      updatePaymentState(operationId, (current) => ({
        ...current,
        phase: 'error',
        error: current.mode === 'vip' ? 'VIP 支付二维码生成失败，请关闭后重试' : '支付二维码生成失败，请关闭后重试',
      }))
      return
    }
    if (result.pendingExisting === true) {
      updatePaymentState(operationId, (current) => ({
        ...current,
        phase: 'pending',
        pendingPurchase: { payment: result.payment, package: result.package },
        payment: undefined,
        packages: [result.package],
        selectedPackageId: result.package.id,
        vip: result.vip,
        error: undefined,
      }))
      return
    }
    if (isWorkingPaymentReady(result.payment.status)) {
      finishPayment(operationId, result.payment, currentPaymentMode(paymentState), requestPaymentRefresh, handleClose, isCurrentOperation)
      return
    }
    updatePaymentState(operationId, (current) => ({
      ...current,
      phase: phaseForWorkingPaymentStatus(result.payment.status),
      pendingPurchase: undefined,
      payment: result.payment,
      packages: [result.package],
      selectedPackageId: result.package.id,
      vip: result.vip,
      error: result.payment.status === 'failed' || result.payment.status === 'cancelled'
        ? paymentStatusMessage(result.payment.status)
        : undefined,
    }))
  }, [handleClose, isCurrentOperation, paymentState, requestPaymentRefresh, updatePaymentState])

  const handleStartDiamondPurchase = async (): Promise<void> => {
    if (!selectedPackage || isBusy || paymentState.phase === 'loading') return
    const operationId = beginOperation()
    updatePaymentState(operationId, (current) => ({ ...current, phase: 'creating', error: undefined }))
    try {
      await onStartDiamondPurchase(selectedPackage)
    } catch (error: unknown) {
      if (!isCurrentOperation(operationId)) return
      updatePaymentState(operationId, (current) => ({
        ...current,
        phase: 'selecting',
        error: getWorkingPaymentError(error, '无法打开购买钻石对话，请稍后重试'),
      }))
    }
  }

  const handleCreateVipUpgrade = async (): Promise<void> => {
    if (vipUpgradeUnavailable || isBusy) return
    const operationId = beginOperation()
    updatePaymentState(operationId, (current) => ({ ...current, phase: 'creating', error: undefined }))
    try {
      const result = await window.electronAPI.createWorkingVipUpgrade()
      applyCreatedPayment(operationId, result)
    } catch (error: unknown) {
      if (!isCurrentOperation(operationId)) return
      if (getPaymentErrorStatus(error) === 409) {
        handleConflict()
        return
      }
      const fallback = getPaymentErrorStatus(error) === 404 ? 'VIP 暂未开放，请稍后再试' : '创建 VIP 支付订单失败，请稍后重试'
      updatePaymentState(operationId, (current) => ({
        ...current,
        phase: 'error',
        error: getWorkingPaymentError(error, fallback),
      }))
    }
  }

  const handleContinuePending = (): void => {
    const pending = paymentState.pendingPurchase
    if (!pending || isBusy) return
    if (!isWorkingPendingPaymentReusable(pending.payment)) {
      setPaymentState((current) => ({ ...current, phase: 'error', error: '待支付订单已失效，请重新选择套餐。' }))
      return
    }
    setPaymentState((current) => ({
      ...current,
      phase: phaseForWorkingPaymentStatus(pending.payment.status),
      pendingPurchase: undefined,
      payment: pending.payment,
      packages: [pending.package],
      selectedPackageId: pending.package.id,
      error: undefined,
    }))
  }

  const handleCancelPending = async (): Promise<void> => {
    const pending = paymentState.pendingPurchase
    if (!pending || paymentState.mode !== 'diamonds' || isBusy) return
    const operationId = beginOperation()
    updatePaymentState(operationId, (current) => ({ ...current, phase: 'cancelling', error: undefined }))
    try {
      const result = await window.electronAPI.cancelWorkingDiamondPayment(pending.payment.paymentId)
      if (!isCurrentOperation(operationId)) return
      if (!result.cancelled) {
        handleConflict()
        return
      }
      const packages = await window.electronAPI.listWorkingDiamondPackages()
      if (!isCurrentOperation(operationId)) return
      setPaymentState((current) => ({
        ...current,
        phase: 'selecting',
        pendingPurchase: undefined,
        payment: undefined,
        packages,
        selectedPackageId: packages[0]?.id,
        error: undefined,
      }))
      requestPaymentRefresh('待支付订单已取消。')
    } catch (error: unknown) {
      if (!isCurrentOperation(operationId)) return
      if (getPaymentErrorStatus(error) === 409) {
        handleConflict()
        return
      }
      updatePaymentState(operationId, (current) => ({
        ...current,
        phase: 'pending',
        error: getWorkingPaymentError(error, '取消订单失败，请稍后重试'),
      }))
    }
  }

  const handleCheckPayment = async (): Promise<void> => {
    const payment = paymentState.payment
    if (!payment || isBusy) return
    const operationId = beginOperation()
    updatePaymentState(operationId, (current) => ({ ...current, phase: 'checking', error: undefined }))
    try {
      const result = await window.electronAPI.checkWorkingPayment(payment.paymentId)
      if (!isCurrentOperation(operationId)) return
      applyPaymentCheckResult(operationId, result, paymentState.mode, updatePaymentState, requestPaymentRefresh, handleClose, isCurrentOperation)
    } catch (error: unknown) {
      if (!isCurrentOperation(operationId)) return
      if (getPaymentErrorStatus(error) === 409) {
        handleConflict()
        return
      }
      updatePaymentState(operationId, (current) => ({
        ...current,
        phase: 'error',
        error: getWorkingPaymentError(error, '检查支付状态失败，请稍后重试'),
      }))
    }
  }

  if (!paymentState.open) return null

  const pendingPackage = paymentState.pendingPurchase?.package
  const displayPackage = pendingPackage ?? selectedPackage
  const showPayment = paymentState.payment !== undefined
  const showPending = paymentState.pendingPurchase !== undefined
  const showVipBenefits = paymentState.mode === 'vip'
    && paymentState.resumeOrderId === undefined
    && !showPayment
    && !showPending
  const showDiamondSelection = paymentState.mode === 'diamonds'
    && !showPayment
    && !showPending
    && paymentState.packages.length > 0

  return (
    <div className="copis-working-payment-overlay" role="presentation" onClick={handleClose}>
      <section
        className="copis-working-payment-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="copis-working-payment-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="copis-working-payment-header">
          <div className="copis-working-payment-heading">
            <div className="copis-working-payment-mark" aria-hidden="true">
              {paymentState.mode === 'vip' ? <Crown /> : <Gem />}
            </div>
            <div>
              <span className="copis-working-payment-eyebrow">COPIS WORKING</span>
              <h2 id="copis-working-payment-title">{paymentState.mode === 'vip' ? '升级 VIP' : showPayment ? '支付宝支付' : '获取钻石'}</h2>
              <p>{paymentState.mode === 'vip' ? '提升钻石消耗效率，解锁专家团队和定时任务。' : '选择服务端提供的套餐。'}</p>
            </div>
          </div>
          <button type="button" className="copis-working-payment-close" onClick={handleClose} aria-label="关闭支付窗口" title="关闭">
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="copis-working-payment-body">
          {paymentState.error && (
            <div className="copis-working-payment-alert" role="alert">
              <CircleAlert aria-hidden="true" />
              <span>{paymentState.error}</span>
            </div>
          )}

          {paymentState.phase === 'loading' && (
            <div className="copis-working-payment-loading" role="status" aria-live="polite">
              <Loader2 aria-hidden="true" className="spinning" />
              <span>{paymentState.resumeOrderId === undefined ? '正在读取支付信息...' : '正在恢复待支付订单...'}</span>
            </div>
          )}

          {showVipBenefits && (
            <VipBenefitsView
              vipStatus={vipStatus}
            />
          )}

          {showDiamondSelection && (
            <DiamondPackageSelection
              packages={paymentState.packages}
              selectedPackageId={paymentState.selectedPackageId}
              disabled={isBusy || paymentState.phase === 'loading'}
              onSelect={(packageId) => setPaymentState((current) => ({ ...current, selectedPackageId: packageId, error: undefined }))}
            />
          )}

          {showPending && paymentState.pendingPurchase && (
            <PendingPaymentView pendingPurchase={paymentState.pendingPurchase} mode={paymentState.mode} />
          )}

          {showPayment && paymentState.payment && (
            <PaymentView
              payment={paymentState.payment}
              packageValue={displayPackage}
              vipSummary={paymentState.vip}
              mode={paymentState.mode}
              onOpenCashier={openCashier}
            />
          )}

          {paymentState.phase === 'resource_pending' && (
            <div className="copis-working-payment-status" role="status">
              <Check aria-hidden="true" />
              <span>支付已确认，资源正在到账处理中。请稍后再次检查。</span>
            </div>
          )}
        </div>

        <footer className="copis-working-payment-footer">
          <button type="button" className="copis-working-payment-secondary" onClick={handleClose}>关闭</button>
          {showPending && (
            <>
              {paymentState.mode === 'diamonds' && (
                <button type="button" className="copis-working-payment-secondary danger" onClick={() => void handleCancelPending()} disabled={isBusy}>
                  {paymentState.phase === 'cancelling' ? '取消中...' : '取消订单'}
                </button>
              )}
              <button type="button" className="copis-working-payment-primary" onClick={handleContinuePending} disabled={isBusy}>
                继续支付
              </button>
            </>
          )}
          {showPayment && (
            <button type="button" className="copis-working-payment-primary" onClick={() => void handleCheckPayment()} disabled={isBusy || paymentState.phase === 'success'}>
              {paymentState.phase === 'checking' ? '正在确认...' : paymentState.phase === 'resource_pending' ? '再次检查' : '我已支付'}
            </button>
          )}
          {showDiamondSelection && (
            <button type="button" className="copis-working-payment-primary" onClick={() => void handleStartDiamondPurchase()} disabled={!selectedPackage || isBusy || paymentState.phase === 'loading'}>
              {paymentState.phase === 'creating' ? '正在打开对话...' : '在对话中继续'}
            </button>
          )}
          {showVipBenefits && (
            <button type="button" className="copis-working-payment-primary" onClick={() => void handleCreateVipUpgrade()} disabled={vipUpgradeUnavailable || isBusy}>
              {paymentState.phase === 'creating' ? '创建中...' : vipUpgradeUnavailable ? 'VIP 暂未开放' : vipStatus?.isVip ? '确认续费 VIP' : '确认升级 VIP'}
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}

function DiamondPackageSelection({
  packages,
  selectedPackageId,
  disabled,
  onSelect,
}: {
  packages: readonly WorkingDiamondPackage[]
  selectedPackageId?: number
  disabled: boolean
  onSelect: (packageId: number) => void
}): React.ReactElement {
  return (
    <div className="copis-working-payment-selection" aria-label="钻石套餐">
      <div className="copis-working-payment-section-heading">
        <strong>选择钻石套餐</strong>
      </div>
      <div className="copis-working-payment-package-grid">
        {packages.map((item) => (
          <button
            type="button"
            key={item.id}
            className={`copis-working-payment-package ${selectedPackageId === item.id ? 'selected' : ''}`}
            onClick={() => onSelect(item.id)}
            disabled={disabled}
            aria-pressed={selectedPackageId === item.id}
          >
            <span className="copis-working-payment-package-amount">¥ {item.amount}</span>
            <span className="copis-working-payment-package-diamonds"><Gem aria-hidden="true" />{formatDiamonds(item.diamonds)} 钻石</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function VipBenefitsView({
  vipStatus,
}: {
  vipStatus: WorkingVipStatus | null
}): React.ReactElement {
  const amount = vipStatus?.upgradeAmount || '以服务端配置为准'
  const days = vipStatus?.upgradeDays || 30

  return (
    <div className="copis-working-payment-vip-benefits">
      <div className="copis-working-payment-vip-intro">
        <strong>Free 与 VIP 权益对比</strong>
        {vipStatus?.upgradeAvailable === false && <span>VIP 配置暂未开放。</span>}
      </div>
      <div className="copis-working-payment-benefit-table" role="table" aria-label="Free 与 VIP 权益对比">
        <div className="copis-working-payment-benefit-row header" role="row">
          <span role="columnheader">权益</span>
          <strong role="columnheader">Free</strong>
          <strong role="columnheader">VIP</strong>
        </div>
        {VIP_BENEFITS.map((benefit) => (
          <div className="copis-working-payment-benefit-row" role="row" key={benefit.label}>
            <span role="rowheader">{benefit.label}</span>
            <span role="cell">{benefit.free}</span>
            <strong role="cell">{benefit.vip}</strong>
          </div>
        ))}
      </div>
      <div className="copis-working-payment-vip-summary">
        <span>赠送钻石</span>
        <strong>{formatDiamonds(vipStatus?.upgradeBonusDiamonds ?? 0)}</strong>
        <span>开通天数</span>
        <strong>{days} 天</strong>
        <span>服务端价格</span>
        <strong>¥ {amount}</strong>
      </div>
    </div>
  )
}

function PendingPaymentView({
  pendingPurchase,
  mode,
}: {
  pendingPurchase: WorkingPendingDiamondPurchase
  mode: 'diamonds' | 'vip'
}): React.ReactElement {
  return (
    <div className="copis-working-payment-pending">
      <div className="copis-working-payment-pending-icon" aria-hidden="true">{mode === 'vip' ? <Crown /> : <Gem />}</div>
      <strong>{mode === 'vip' ? '发现待支付 VIP 订单' : '发现待支付钻石订单'}</strong>
      <span>¥ {pendingPurchase.payment.amount || pendingPurchase.package.amount}</span>
      <p>{mode === 'vip' ? '该 VIP 订单尚未完成，无需重复创建新的支付订单。' : `该订单包含 ${formatDiamonds(pendingPurchase.package.diamonds)} 钻石，可继续支付或取消后重新选择。`}</p>
      {pendingPurchase.payment.outTradeNo && <small>订单号：{pendingPurchase.payment.outTradeNo}</small>}
    </div>
  )
}

function PaymentView({
  payment,
  packageValue,
  vipSummary,
  mode,
  onOpenCashier,
}: {
  payment: WorkingPaymentSession
  packageValue?: WorkingDiamondPackage
  vipSummary?: WorkingVipPaymentSummary
  mode: 'diamonds' | 'vip'
  onOpenCashier: (url: string) => void
}): React.ReactElement {
  const cashierUrl = safeCashierUrl(payment.cashierUrl)
  const amount = payment.amount || vipSummary?.amount || packageValue?.amount || '--'
  const benefit = mode === 'vip'
    ? `VIP ${vipSummary?.days || 30} 天`
    : `${formatDiamonds(packageValue?.diamonds ?? 0)} 钻石`

  return (
    <div className="copis-working-payment-view">
      <div className="copis-working-payment-summary">
        <strong>¥ {amount}</strong>
        <span>{benefit}</span>
      </div>
      {payment.qrCodeImage ? (
        <PaymentQrImage source={payment.qrCodeImage} />
      ) : cashierUrl ? (
        <button type="button" className="copis-working-payment-cashier" onClick={() => onOpenCashier(cashierUrl)}>
          <ExternalLink aria-hidden="true" />
          <span>打开支付宝收银台</span>
        </button>
      ) : (
        <div className="copis-working-payment-no-qr" role="alert">支付二维码暂不可用，请关闭后重试。</div>
      )}
      <div className="copis-working-payment-meta">
        <span>请使用支付宝扫码完成支付</span>
        {payment.outTradeNo && <small>订单号：{payment.outTradeNo}</small>}
        <small>{paymentStatusMessage(payment.status)}</small>
      </div>
    </div>
  )
}

function PaymentQrImage({ source }: { source: string }): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false)

  React.useEffect(() => {
    if (!expanded) return undefined
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [expanded])

  return (
    <>
      <button type="button" className="copis-working-payment-qr-trigger" onClick={() => setExpanded(true)} aria-label="放大支付宝支付二维码" title="点击放大">
        <img src={source} alt="支付宝支付二维码" />
      </button>
      {expanded && (
        <div className="copis-working-payment-qr-preview" role="dialog" aria-modal="true" aria-label="支付宝支付二维码大图" onClick={() => setExpanded(false)}>
          <button type="button" className="copis-working-payment-qr-preview-close" onClick={() => setExpanded(false)} aria-label="关闭二维码大图" title="关闭">
            <X aria-hidden="true" />
          </button>
          <img src={source} alt="支付宝支付二维码大图" onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </>
  )
}

function applyPaymentCheckResult(
  operationId: number,
  result: WorkingPaymentCheckResult,
  mode: 'diamonds' | 'vip',
  updatePaymentState: (operationId: number, update: (current: WorkingPaymentState) => WorkingPaymentState) => void,
  requestPaymentRefresh: (notice?: string) => void,
  handleClose: () => void,
  isCurrentOperation: (operationId: number) => boolean,
): void {
  if (!isCurrentOperation(operationId)) return
  if (isWorkingPaymentReady(result.status)) {
    requestPaymentRefresh(mode === 'vip' ? '支付成功，VIP 已开通。' : '支付成功，钻石已到账。')
    updatePaymentState(operationId, (current) => ({ ...current, phase: 'success', payment: result.payment, error: undefined }))
    handleClose()
    return
  }
  const phase = phaseForWorkingPaymentStatus(result.status)
  updatePaymentState(operationId, (current) => ({
    ...current,
    phase,
    payment: result.payment,
    error: phase === 'error' ? paymentStatusMessage(result.status) : undefined,
  }))
}

function finishPayment(
  operationId: number,
  payment: WorkingPaymentSession,
  mode: 'diamonds' | 'vip',
  requestPaymentRefresh: (notice?: string) => void,
  handleClose: () => void,
  isCurrentOperation: (operationId: number) => boolean,
): void {
  if (!isCurrentOperation(operationId)) return
  requestPaymentRefresh(mode === 'vip' ? '支付成功，VIP 已开通。' : '支付成功，钻石已到账。')
  handleClose()
  void payment
}

function currentPaymentMode(state: WorkingPaymentState): 'diamonds' | 'vip' {
  return state.mode
}

function hasPaymentPresentation(payment: WorkingPaymentSession): boolean {
  return Boolean(payment.qrCodeImage || safeCashierUrl(payment.cashierUrl))
}

function safeCashierUrl(value?: string): string | undefined {
  if (!value?.trim()) return undefined
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function openCashier(url: string): void {
  const safeUrl = safeCashierUrl(url)
  if (!safeUrl) return
  void window.electronAPI.openExternal(safeUrl)
}

function getPaymentErrorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined
  return typeof error.status === 'number' ? error.status : undefined
}

function getWorkingPaymentError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : ''
  if (!message || /payment_needed|resource_response|payment\s+proof|authorization|bearer|jwt/i.test(message)) return fallback
  return message
}

function paymentStatusMessage(status: string): string {
  switch (status) {
    case 'pending_user_pay':
    case 'created':
      return '等待使用支付宝完成支付。'
    case 'paid':
    case 'checking':
      return '支付已确认，正在检查到账状态。'
    case 'resource_pending':
      return '支付已确认，资源正在到账处理中。'
    case 'resource_ready':
      return '支付已完成。'
    case 'cancelled':
      return '订单已取消。'
    case 'failed':
      return '支付处理失败，请关闭后重试。'
    default:
      return '支付状态尚未确认，请稍后再次检查。'
  }
}

function formatDiamonds(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.00$/, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
