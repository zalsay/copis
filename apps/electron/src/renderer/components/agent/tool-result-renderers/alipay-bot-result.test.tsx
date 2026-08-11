import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AlipayBotResultRenderer,
  isSafeAlipayQrCodeImage,
  parseAlipayBotResult,
} from './alipay-bot-result'

const QR_CODE = 'data:image/png;base64,iVBORw0KGgo='

describe('支付宝工具二维码结果', () => {
  test('Given a valid QR code data URL When parsed Then it keeps the QR code and removes it from textual details', () => {
    const parsed = parseAlipayBotResult(JSON.stringify({ code: 200, qrCodeImage: QR_CODE }))

    expect(parsed.qrCodeImage).toBe(QR_CODE)
    expect(parsed.resultWithoutQrCode).not.toContain('qrCodeImage')
    expect(parsed.resultWithoutQrCode).toContain('"code": 200')
  })

  test('Given an unsafe image source When rendered Then it does not create an image element', () => {
    expect(isSafeAlipayQrCodeImage('https://untrusted.example/qr.png')).toBe(false)
    expect(isSafeAlipayQrCodeImage('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false)

    const html = renderToStaticMarkup(
      <AlipayBotResultRenderer result={JSON.stringify({ qrCodeImage: 'https://untrusted.example/qr.png' })} isError={false} />,
    )

    expect(html).not.toContain('<img')
  })

  test('Given a valid QR code result When rendered Then it exposes a scannable payment image outside the JSON result table', () => {
    const html = renderToStaticMarkup(
      <AlipayBotResultRenderer result={JSON.stringify({ qrCodeImage: QR_CODE })} isError={false} />,
    )

    expect(html).toContain('alt="支付宝支付二维码"')
    expect(html).toContain('aria-label="放大支付宝支付二维码"')
    expect(html).not.toContain('qrCodeImage')
  })
})
