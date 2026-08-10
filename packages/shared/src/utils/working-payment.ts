import type {
  WorkingDiamondPackage,
  WorkingDiamondPurchaseResult,
  WorkingOrder,
  WorkingOrderPayment,
  WorkingPaymentCancelResult,
  WorkingPaymentCheckResult,
  WorkingPaymentSession,
  WorkingPendingDiamondPurchase,
  WorkingVipPaymentSummary,
} from '../types/working'

export class WorkingPaymentNormalizationError extends Error {
  readonly code = 'invalid_payment_response'

  constructor(message: string) {
    super(message)
    this.name = 'WorkingPaymentNormalizationError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstDefined(item: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (item[key] !== undefined && item[key] !== null) return item[key]
  }
  return undefined
}

function normalizeNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function normalizeIdentifier(value: unknown): number | string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) return value.trim()
  return undefined
}

function optionalString(item: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const value = firstDefined(item, keys)
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

export function normalizeWorkingDiamondPackage(value: unknown): WorkingDiamondPackage | null {
  if (!isRecord(value)) return null
  const idValue = normalizeIdentifier(firstDefined(value, ['id', 'ID']))
  const id = typeof idValue === 'number' ? idValue : Number(idValue)
  const amountValue = firstDefined(value, ['amount', 'price'])
  const amount = typeof amountValue === 'string'
    ? amountValue.trim()
    : typeof amountValue === 'number' && Number.isFinite(amountValue) ? String(amountValue) : ''
  const diamonds = normalizeNumber(firstDefined(value, ['diamonds', 'tokens']), NaN)
  if (!Number.isSafeInteger(id) || id <= 0 || !amount || !Number.isFinite(diamonds)) return null

  const amountCents = normalizeNumber(firstDefined(value, ['amount_cents', 'amountCents']), 0)
  return {
    id,
    serviceId: optionalString(value, ['service_id', 'serviceId']),
    goodsName: optionalString(value, ['goods_name', 'goodsName']),
    amount,
    amountCents,
    currency: optionalString(value, ['currency']) ?? 'CNY',
    diamonds,
    enabled: typeof firstDefined(value, ['enabled']) === 'boolean' ? Boolean(firstDefined(value, ['enabled'])) : undefined,
    sortOrder: typeof firstDefined(value, ['sort_order', 'sortOrder']) === 'number'
      ? Number(firstDefined(value, ['sort_order', 'sortOrder']))
      : undefined,
  }
}

export function isWorkingVipDiamondPackage(value: WorkingDiamondPackage): boolean {
  return value.serviceId?.trim().toLowerCase() === 'pi-vip'
    || value.goodsName?.trim().toLowerCase() === 'pi-vip'
}

export function normalizeWorkingDiamondPackages(value: unknown): WorkingDiamondPackage[] {
  if (!Array.isArray(value)) throw new WorkingPaymentNormalizationError('钻石套餐响应格式不正确')
  return value
    .map(normalizeWorkingDiamondPackage)
    .filter((item): item is WorkingDiamondPackage => item !== null && !isWorkingVipDiamondPackage(item))
}

function normalizePaymentIdentifier(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function normalizeQrCodeImage(value: unknown, mimeType: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const image = value.trim()
  if (!image) return undefined
  if (image.startsWith('data:')) return image
  return `data:${mimeType || 'image/png'};base64,${image}`
}

function normalizePaymentSession(value: unknown): WorkingPaymentSession | null {
  if (!isRecord(value)) return null
  const paymentId = normalizePaymentIdentifier(firstDefined(value, ['payment_id', 'paymentId']))
  if (!paymentId) return null
  return {
    paymentId,
    resourceId: optionalString(value, ['resource_id', 'resourceId']),
    outTradeNo: optionalString(value, ['out_trade_no', 'outTradeNo']),
    tradeNo: optionalString(value, ['trade_no', 'tradeNo']),
    outShakeNo: optionalString(value, ['out_shake_no', 'outShakeNo']),
    status: optionalString(value, ['status']) ?? 'created',
    goodsName: optionalString(value, ['goods_name', 'goodsName']),
    amount: optionalString(value, ['amount']),
    currency: optionalString(value, ['currency']),
    cashierUrl: optionalString(value, ['cashier_url', 'cashierUrl']),
    qrCodeImage: normalizeQrCodeImage(
      firstDefined(value, ['qrcode_image', 'qr_code_image', 'qrCodeImage']),
      optionalString(value, ['qrcode_mime_type', 'qrCodeMimeType']),
    ),
    qrCodeMimeType: optionalString(value, ['qrcode_mime_type', 'qrCodeMimeType']),
    expiresAt: value.expires_at == null && value.expiresAt == null
      ? undefined
      : value.expires_at === null || value.expiresAt === null
        ? null
        : optionalString(value, ['expires_at', 'expiresAt']),
  }
}

function requirePaymentSession(value: unknown, message: string): WorkingPaymentSession {
  const payment = normalizePaymentSession(value)
  if (!payment) throw new WorkingPaymentNormalizationError(message)
  return payment
}

function normalizeVipPaymentSummary(value: unknown): WorkingVipPaymentSummary | undefined {
  if (!isRecord(value)) return undefined
  const days = normalizeNumber(firstDefined(value, ['days', 'vip_days', 'vipDays']), 30)
  const amountCentsValue = firstDefined(value, ['amount_cents', 'amountCents'])
  const amountCents = amountCentsValue === undefined ? undefined : normalizeNumber(amountCentsValue, NaN)
  const paymentPackageValue = firstDefined(value, ['payment_package', 'paymentPackage'])
  return {
    serviceId: optionalString(value, ['service_id', 'serviceId']) ?? 'pi-vip',
    days: Number.isFinite(days) && days > 0 ? days : 30,
    amount: optionalString(value, ['amount']),
    amountCents: amountCents !== undefined && Number.isFinite(amountCents) ? amountCents : undefined,
    bonusDiamonds: firstDefined(value, ['bonus_diamonds', 'bonusDiamonds']) === undefined
      ? undefined
      : normalizeNumber(firstDefined(value, ['bonus_diamonds', 'bonusDiamonds']), 0),
    paymentPackage: normalizeWorkingDiamondPackage(paymentPackageValue) ?? undefined,
  }
}

export function normalizeWorkingDiamondPurchaseResult(value: unknown): WorkingDiamondPurchaseResult {
  if (!isRecord(value)) throw new WorkingPaymentNormalizationError('支付订单响应格式不正确')
  const packageValue = normalizeWorkingDiamondPackage(value.package)
  if (!packageValue) throw new WorkingPaymentNormalizationError('支付订单缺少有效套餐')
  return {
    outTradeNo: optionalString(value, ['out_trade_no', 'outTradeNo']),
    package: packageValue,
    isVip: Boolean(value.is_vip ?? value.isVip),
    payment: requirePaymentSession(value.payment, '支付订单缺少有效支付会话'),
    vip: normalizeVipPaymentSummary(value.vip),
    pendingExisting: value.pending_existing === true || value.pendingExisting === true ? true : undefined,
  }
}

export function normalizeWorkingPendingDiamondPurchase(value: unknown): WorkingPendingDiamondPurchase | null {
  if (value === null || value === undefined) return null
  if (!isRecord(value)) throw new WorkingPaymentNormalizationError('待支付订单响应格式不正确')
  const packageValue = normalizeWorkingDiamondPackage(value.package)
  const payment = normalizePaymentSession(value.payment)
  if (!packageValue || !payment) throw new WorkingPaymentNormalizationError('待支付订单缺少有效支付信息')
  return { payment, package: packageValue }
}

function normalizeWorkingOrder(value: unknown): WorkingOrder {
  const item = isRecord(value) ? value : {}
  return {
    id: normalizeIdentifier(item.id) ?? '',
    outTradeNo: String(item.out_trade_no ?? item.outTradeNo ?? ''),
    orderType: String(item.order_type ?? item.orderType ?? 'diamond_recharge'),
    title: String(item.title ?? ''),
    amount: String(item.amount ?? '0'),
    currency: String(item.currency ?? 'CNY'),
    diamonds: normalizeNumber(item.diamonds),
    vipDays: normalizeNumber(item.vip_days ?? item.vipDays),
    method: String(item.method ?? ''),
    status: String(item.status ?? 'failed'),
    createdAt: item.created_at == null && item.createdAt == null ? undefined : String(item.created_at ?? item.createdAt),
  }
}

export function normalizeWorkingOrderPayment(value: unknown): WorkingOrderPayment {
  if (!isRecord(value)) throw new WorkingPaymentNormalizationError('订单支付响应格式不正确')
  const order = normalizeWorkingOrder(value.order)
  if (order.id === '' || order.id === undefined) throw new WorkingPaymentNormalizationError('订单支付响应缺少订单信息')
  const packageValue = normalizeWorkingDiamondPackage(value.package)
  if (!packageValue) throw new WorkingPaymentNormalizationError('订单支付响应缺少有效套餐')
  return {
    order,
    payment: requirePaymentSession(value.payment, '订单支付响应缺少有效支付会话'),
    package: packageValue,
    vip: normalizeVipPaymentSummary(value.vip),
  }
}

export function isWorkingPaymentCheckFailure(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.ok === false
}

export function getWorkingPaymentCheckError(value: unknown): { message: string; code?: string } {
  if (!isRecord(value)) return { message: '检查支付状态失败' }
  return {
    message: typeof value.message === 'string' ? value.message : '检查支付状态失败',
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
  }
}

export function normalizeWorkingPaymentCheckResult(value: unknown): WorkingPaymentCheckResult {
  if (isWorkingPaymentCheckFailure(value)) {
    throw new WorkingPaymentNormalizationError(getWorkingPaymentCheckError(value).message)
  }
  const data = isRecord(value) && value.data !== undefined ? value.data : value
  if (!isRecord(data)) throw new WorkingPaymentNormalizationError('支付检查响应格式不正确')
  const payment = requirePaymentSession(data.payment, '支付检查响应缺少有效支付会话')
  return {
    payment,
    status: optionalString(data, ['status']) ?? payment.status,
  }
}

export function normalizeWorkingPaymentCancelResult(value: unknown): WorkingPaymentCancelResult {
  if (!isRecord(value) || typeof value.cancelled !== 'boolean') {
    throw new WorkingPaymentNormalizationError('取消支付响应格式不正确')
  }
  return {
    cancelled: value.cancelled,
    payment: requirePaymentSession(value.payment, '取消支付响应缺少有效支付会话'),
  }
}
