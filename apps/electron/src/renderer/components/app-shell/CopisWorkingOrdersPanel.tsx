import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { ChevronLeft, ChevronRight, Loader2, QrCode, RefreshCw, Trash2 } from 'lucide-react'
import type { WorkingOrder, WorkingOrdersPagination } from '@copis/shared'
import { openWorkingPaymentAtom, workingPaymentRefreshAtom } from '@/atoms/working-payment-atoms'
import './CopisWorkingOrdersPanel.css'

const EMPTY_PAGINATION: WorkingOrdersPagination = {
  page: 1,
  pageSize: 20,
  total: 0,
  totalPages: 0,
}

const orderStatusLabels: Record<string, string> = {
  pending: '待支付',
  paid: '已完成',
  cancelled: '已取消',
  failed: '支付失败',
}

const paymentMethodLabels: Record<string, string> = {
  alipay: '支付宝',
  wechat_native: '微信支付',
}

export function CopisWorkingOrdersPanel(): React.ReactElement {
  const [orders, setOrders] = React.useState<WorkingOrder[]>([])
  const [pagination, setPagination] = React.useState<WorkingOrdersPagination>(EMPTY_PAGINATION)
  const [page, setPage] = React.useState(1)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [actionError, setActionError] = React.useState('')
  const [deletingOrderId, setDeletingOrderId] = React.useState<number | string | null>(null)
  const openPayment = useSetAtom(openWorkingPaymentAtom)
  const paymentRefresh = useAtomValue(workingPaymentRefreshAtom)
  const paymentRefreshRef = React.useRef(paymentRefresh)

  const loadOrders = React.useCallback(async (targetPage: number): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const result = await window.electronAPI.listWorkingOrders(targetPage, 20)
      setOrders(result.items)
      setPagination(result.pagination)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '读取订单失败，请稍后重试')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadOrders(page)
  }, [loadOrders, page])

  React.useEffect(() => {
    if (paymentRefresh <= paymentRefreshRef.current) return
    paymentRefreshRef.current = paymentRefresh
    void loadOrders(page)
  }, [loadOrders, page, paymentRefresh])

  const handleDeleteOrder = async (order: WorkingOrder): Promise<void> => {
    if (!window.confirm(`确认删除订单“${order.outTradeNo}”？`)) return
    setDeletingOrderId(order.id)
    setActionError('')
    try {
      await window.electronAPI.deleteWorkingOrder(order.id)
      if (orders.length === 1 && page > 1) setPage((current) => current - 1)
      else await loadOrders(page)
    } catch (deleteError) {
      setActionError(deleteError instanceof Error ? deleteError.message : '删除订单失败，请稍后重试')
    } finally {
      setDeletingOrderId(null)
    }
  }

  return (
    <section className="copis-working-orders-panel" aria-label="我的订单">
      {actionError && <div className="copis-working-orders-action-error" role="alert">{actionError}</div>}

      {loading ? (
        <div className="copis-working-orders-loading" aria-label="正在加载订单">
          {Array.from({ length: 4 }, (_, index) => <span key={index} />)}
        </div>
      ) : error ? (
        <div className="copis-working-orders-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void loadOrders(page)}>
            <RefreshCw aria-hidden="true" />
            重试
          </button>
        </div>
      ) : orders.length === 0 ? (
        <div className="copis-working-orders-empty">暂无充值或 VIP 升级订单</div>
      ) : (
        <div className="copis-working-orders-list">
          {orders.map((order) => (
            <article className="copis-working-order-row" key={String(order.id)}>
              <div className="copis-working-order-identity">
                <div className="copis-working-order-title-line">
                  <span className={`copis-working-order-type ${order.orderType}`}>
                    {order.orderType === 'vip_upgrade' ? 'VIP 升级' : '钻石充值'}
                  </span>
                  <strong>{order.title || 'Copis 订单'}</strong>
                </div>
                <small>订单号：{order.outTradeNo || '--'}</small>
                <time dateTime={order.createdAt}>{formatOrderTime(order.createdAt)}</time>
              </div>

              <div className="copis-working-order-payment">
                <strong>{order.currency === 'CNY' ? '¥ ' : `${order.currency} `}{order.amount}</strong>
                <small>{paymentMethodLabels[order.method] || order.method || '其他支付'}</small>
              </div>

              <div className="copis-working-order-benefit">
                <strong>{order.orderType === 'vip_upgrade' ? `VIP ${order.vipDays} 天` : `${formatDiamonds(order.diamonds)} 钻石`}</strong>
                {order.orderType === 'vip_upgrade' && order.diamonds > 0 && <small>赠送 {formatDiamonds(order.diamonds)} 钻石</small>}
              </div>

              <div className="copis-working-order-actions">
                <span className={`copis-working-order-status ${order.status}`}>{orderStatusLabels[order.status] || '支付失败'}</span>
                {order.status === 'pending' && (
                  <button
                    type="button"
                    className="copis-working-order-resume"
                    onClick={() => openPayment({
                      mode: order.orderType === 'vip_upgrade' ? 'vip' : 'diamonds',
                      resumeOrderId: order.id,
                    })}
                  >
                    <QrCode aria-hidden="true" />
                    继续支付
                  </button>
                )}
              </div>

              <button
                type="button"
                className="copis-working-order-delete"
                aria-label={`删除订单 ${order.outTradeNo}`}
                title="删除订单"
                disabled={deletingOrderId === order.id}
                onClick={() => void handleDeleteOrder(order)}
              >
                {deletingOrderId === order.id ? <Loader2 className="spinning" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
              </button>
            </article>
          ))}
        </div>
      )}

      {!loading && !error && pagination.totalPages > 1 && (
        <nav className="copis-working-orders-pagination" aria-label="订单分页">
          <button type="button" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
            <ChevronLeft aria-hidden="true" />
            上一页
          </button>
          <span>第 {pagination.page} / {pagination.totalPages} 页</span>
          <button type="button" disabled={page >= pagination.totalPages} onClick={() => setPage((current) => current + 1)}>
            下一页
            <ChevronRight aria-hidden="true" />
          </button>
        </nav>
      )}
    </section>
  )
}

function formatOrderTime(value?: string): string {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDiamonds(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.00$/, '')
}
