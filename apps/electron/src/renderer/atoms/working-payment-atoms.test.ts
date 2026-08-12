import { describe, expect, test } from 'bun:test'
import { isWorkingPendingPaymentReusable } from './working-payment-atoms'

describe('待支付订单复用', () => {
  test('Given 待支付订单包含二维码 When 判断是否可继续 Then 允许继续支付', () => {
    expect(isWorkingPendingPaymentReusable({
      paymentId: 'payment-1',
      status: 'pending_user_pay',
      qrCodeImage: 'data:image/png;base64,iVBORw0KGgo=',
    })).toBe(true)
  })

  test('Given 待支付订单没有二维码或状态异常 When 判断是否可继续 Then 要求重新创建订单', () => {
    expect(isWorkingPendingPaymentReusable({ paymentId: 'payment-1', status: 'pending_user_pay' })).toBe(false)
    expect(isWorkingPendingPaymentReusable({
      paymentId: 'payment-2',
      status: 'failed',
      qrCodeImage: 'data:image/png;base64,iVBORw0KGgo=',
    })).toBe(false)
  })
})
