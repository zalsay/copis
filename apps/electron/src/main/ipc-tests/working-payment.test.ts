import { expect, mock, test } from 'bun:test'
import { WORKING_IPC_CHANNELS } from '@copis/shared'

const handle = mock(() => {})
const getOrderPayment = mock(async () => ({ status: 'pending' }))
const getWorkingApiClient = mock(() => ({ getOrderPayment }))

mock.module('electron', () => ({ ipcMain: { handle } }))
mock.module('../lib/working-api-service', () => ({ getWorkingApiClient }))

type IpcHandler = (...args: unknown[]) => unknown

test('Working 支付查询拒绝空订单并传递有效订单', async () => {
  const { registerWorkingPaymentIpcHandlers } = await import('../ipc/working-payment.ipc')
  registerWorkingPaymentIpcHandlers()
  const registrations = handle.mock.calls as unknown as Array<[unknown, unknown]>
  const handler = registrations.find(([channel]) => channel === WORKING_IPC_CHANNELS.GET_ORDER_PAYMENT)?.[1] as IpcHandler

  await expect(handler({}, 'order-1')).resolves.toEqual({ status: 'pending' })
  expect(getOrderPayment).toHaveBeenCalledWith('order-1')
  await expect(handler({}, '')).rejects.toThrow('订单 ID 不正确')
})
