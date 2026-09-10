import { ipcMain } from 'electron'
import { WORKING_IPC_CHANNELS, type WorkingPaymentIdentifier } from '@copis/shared'
import { getWorkingApiClient } from '../lib/working-api-service'

function isWorkingPaymentIdentifier(value: unknown): value is WorkingPaymentIdentifier {
  return (typeof value === 'string' && value.trim().length > 0)
    || (typeof value === 'number' && Number.isFinite(value))
}

export function registerWorkingPaymentIpcHandlers(): void {
  ipcMain.handle(WORKING_IPC_CHANNELS.LIST_ORDERS, async (_, page?: number, pageSize?: number) => {
    return getWorkingApiClient().listOrders(page, pageSize)
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.DELETE_ORDER, async (_, orderId: number | string) => {
    if ((typeof orderId !== 'number' && typeof orderId !== 'string') || !String(orderId).trim()) {
      throw new Error('订单 ID 不正确')
    }
    return getWorkingApiClient().deleteOrder(orderId)
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.LIST_DIAMOND_PACKAGES, async () => {
    return getWorkingApiClient().listDiamondPackages()
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.GET_PENDING_DIAMOND_PURCHASE, async () => {
    return getWorkingApiClient().getPendingDiamondPurchase()
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.CREATE_DIAMOND_PURCHASE, async (_, packageId: number) => {
    if (!Number.isSafeInteger(packageId) || packageId <= 0) throw new Error('套餐 ID 不正确')
    return getWorkingApiClient().createDiamondPurchase(packageId)
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.CREATE_VIP_UPGRADE, async () => {
    return getWorkingApiClient().createVipUpgrade()
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.GET_ORDER_PAYMENT, async (_, orderId: WorkingPaymentIdentifier) => {
    if (!isWorkingPaymentIdentifier(orderId)) throw new Error('订单 ID 不正确')
    return getWorkingApiClient().getOrderPayment(orderId)
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.CHECK_PAYMENT, async (_, paymentId: WorkingPaymentIdentifier) => {
    if (!isWorkingPaymentIdentifier(paymentId)) throw new Error('支付会话 ID 不正确')
    return getWorkingApiClient().checkPayment(paymentId)
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.CANCEL_DIAMOND_PAYMENT, async (_, paymentId: WorkingPaymentIdentifier) => {
    if (!isWorkingPaymentIdentifier(paymentId)) throw new Error('支付会话 ID 不正确')
    return getWorkingApiClient().cancelDiamondPayment(paymentId)
  })
}
