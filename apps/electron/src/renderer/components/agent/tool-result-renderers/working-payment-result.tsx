/** Copis Working 收银台订单结果：基于已校验的支付宝链接本地生成二维码。 */

import * as React from 'react'
import { DefaultResultRenderer } from './default-result'
import { AlipayBotQrCode, isSafeAlipayQrCodeImage } from './alipay-bot-result'

interface WorkingPaymentResultRendererProps {
  result: string
  isError: boolean
  showQrCodeImage?: boolean
}

interface ParsedWorkingPaymentResult {
  qrCodeImage?: string
  resultWithoutQrCode: string
}

export function parseWorkingPaymentResult(result: string): ParsedWorkingPaymentResult {
  try {
    const parsed: unknown = JSON.parse(result)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { resultWithoutQrCode: result }
    }
    const record = parsed as Record<string, unknown>
    const payment = record.payment && typeof record.payment === 'object' && !Array.isArray(record.payment)
      ? record.payment as Record<string, unknown>
      : undefined
    const qrCodeImage = [
      record.qrCodeImage,
      record.qrcode_image,
      record.qr_code_image,
      payment?.qrCodeImage,
      payment?.qrcode_image,
      payment?.qr_code_image,
    ].find(isSafeAlipayQrCodeImage)
    if (!qrCodeImage) return { resultWithoutQrCode: result }

    const { qrCodeImage: _qrCodeImage, qrcode_image: _qrcodeImage, qr_code_image: _qrCodeImageSnakeCase, ...withoutQrCode } = record
    const sanitizedPayment = payment
      ? (() => {
        const { qrCodeImage: _paymentQrCodeImage, qrcode_image: _paymentQrcodeImage, qr_code_image: _paymentQrCodeImageSnakeCase, ...withoutPaymentQrCode } = payment
        return withoutPaymentQrCode
      })()
      : undefined
    return {
      qrCodeImage,
      resultWithoutQrCode: JSON.stringify({
        ...withoutQrCode,
        ...(sanitizedPayment ? { payment: sanitizedPayment } : {}),
      }, null, 2),
    }
  } catch {
    return { resultWithoutQrCode: result }
  }
}

export function WorkingPaymentResultRenderer({ result, isError, showQrCodeImage = true }: WorkingPaymentResultRendererProps): React.ReactElement {
  const parsed = React.useMemo(() => parseWorkingPaymentResult(result), [result])

  if (isError) return <DefaultResultRenderer result={result} isError />

  return (
    <div className="space-y-1">
      {showQrCodeImage && parsed.qrCodeImage && <AlipayBotQrCode source={parsed.qrCodeImage} />}
      {parsed.resultWithoutQrCode !== '{}' && (
        <DefaultResultRenderer result={parsed.resultWithoutQrCode} isError={false} />
      )}
    </div>
  )
}
