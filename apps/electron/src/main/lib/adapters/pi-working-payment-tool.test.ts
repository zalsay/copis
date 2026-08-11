import { describe, expect, test } from 'bun:test'
import { PiWorkingPaymentToolClient } from './pi-working-payment-tool'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('Pi Copis 钻石支付工具', () => {
  test('Given 购买意图 When 查询套餐 Then 通过本地 Rust API 读取 edu-api 最新套餐', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const client = new PiWorkingPaymentToolClient({
      baseUrl: 'http://127.0.0.1:51740',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init })
        return jsonResponse([{ id: 12, amount: '9.90', diamonds: 100 }])
      },
    })

    await expect(client.execute({ action: 'packages.list' })).resolves.toEqual([
      { id: 12, amount: '9.90', diamonds: 100 },
    ])
    expect(calls).toEqual([{
      url: 'http://127.0.0.1:51740/api/working/diamond-packages',
      init: expect.objectContaining({ method: 'GET' }),
    }])
  })

  test('Given 已确认套餐 When 创建订单 Then 只提交对应套餐 ID', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const client = new PiWorkingPaymentToolClient({
      baseUrl: 'http://127.0.0.1:51740',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init })
        return jsonResponse({
          payment: { payment_id: 'payment-12', qrcode_image: 'data:image/png;base64,iVBORw0KGgo=' },
        })
      },
    })

    await client.execute({ action: 'order.create', packageId: 12 })
    expect(calls).toEqual([{
      url: 'http://127.0.0.1:51740/api/working/diamond-purchases',
      init: expect.objectContaining({ method: 'POST', body: '{"packageId":12}' }),
    }])
  })

  test('Given 已支付订单 When 查询状态 Then 仅将订单号交给本地 Rust 服务', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const client = new PiWorkingPaymentToolClient({
      baseUrl: 'http://127.0.0.1:51740',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init })
        return jsonResponse({ data: { status: 'resource_ready' } })
      },
    })

    await expect(client.execute({ action: 'order.check', paymentId: 'payment-12' })).resolves.toEqual({
      data: { status: 'resource_ready' },
    })
    expect(calls).toEqual([{
      url: 'http://127.0.0.1:51740/api/working/diamond-purchases/payment-12/check',
      init: expect.objectContaining({ method: 'POST', body: '{}' }),
    }])
  })
})
