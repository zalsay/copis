import { describe, expect, test } from 'bun:test'
import { parseWorkingPaymentResult } from './working-payment-result'

describe('Copis 收银台二维码结果', () => {
  test('Given a wallet payment QR code When parsed Then it is retained for display and removed from result details', () => {
    const parsed = parseWorkingPaymentResult(JSON.stringify({
      paymentId: 'payment-1',
      payment: { qrcode_image: 'data:image/png;base64,iVBORw0KGgo=' },
    }))

    expect(parsed.qrCodeImage).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(parsed.resultWithoutQrCode).toContain('payment-1')
    expect(parsed.resultWithoutQrCode).not.toContain('qrcode_image')
  })

  test('Given a page-payment cashier URL When parsed Then it is not used to create a QR code', () => {
    expect(parseWorkingPaymentResult('{"cashierUrl":"https://openapi.alipay.com/gateway.do"}').qrCodeImage).toBeUndefined()
  })
})
