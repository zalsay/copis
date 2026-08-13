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

  test('Given 用户确认升级 VIP When 创建订单 Then 调用本地 Rust 的受控 VIP 支付路由', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const client = new PiWorkingPaymentToolClient({
      baseUrl: 'http://127.0.0.1:51740',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init })
        return jsonResponse({
          package: { id: 99, goods_name: 'pi-vip', amount: '49.90', currency: 'CNY', diamonds: 500 },
          payment: { payment_id: 'vip-payment-12', qrcode_image: 'data:image/png;base64,iVBORw0KGgo=' },
          vip: { days: 30 },
        })
      },
    })

    await expect(client.execute({ action: 'vip.create' })).resolves.toEqual({
      payment: { paymentId: 'vip-payment-12', qrCodeImage: 'data:image/png;base64,iVBORw0KGgo=' },
      package: { id: 99, goodsName: 'pi-vip', amount: '49.90', currency: 'CNY', diamonds: 500 },
    })
    expect(calls).toEqual([{
      url: 'http://127.0.0.1:51740/api/working/vip/upgrade',
      init: expect.objectContaining({ method: 'POST', body: '{}' }),
    }])
  })

  test('Given 存在待支付钻石订单 When 查询待支付订单 Then 只读取本机 Rust 已保存的支付摘要', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const client = new PiWorkingPaymentToolClient({
      baseUrl: 'http://127.0.0.1:51740',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init })
        return jsonResponse({
          payment: {
            payment_id: 'pending-12',
            status: 'pending_user_pay',
            qrcode_image: 'data:image/png;base64,iVBORw0KGgo=',
          },
          package: { id: 12, amount: '9.90', currency: 'CNY', diamonds: 100 },
        })
      },
    })

    await expect(client.execute({ action: 'orders.pending' })).resolves.toEqual({
      payment: {
        paymentId: 'pending-12',
        status: 'pending_user_pay',
        qrCodeImage: 'data:image/png;base64,iVBORw0KGgo=',
      },
      package: { id: 12, amount: '9.90', currency: 'CNY', diamonds: 100 },
    })
    expect(calls).toEqual([{
      url: 'http://127.0.0.1:51740/api/working/diamond-purchases/pending',
      init: expect.objectContaining({ method: 'GET' }),
    }])
  })

  test('Given Copis order creation When Rust has already started controlled payment Then the model only receives the pending payment summary', async () => {
    const client = new PiWorkingPaymentToolClient({
      baseUrl: 'http://127.0.0.1:51740',
      fetchImpl: async () => jsonResponse({
        out_trade_no: 'ORDER-12',
        package: { id: 12, amount: '9.90', currency: 'CNY', diamonds: 100 },
        payment: {
          payment_id: 'payment-12',
          status: 'pending_user_pay',
          amount: '9.90',
          currency: 'CNY',
          qrcode_image: 'data:image/png;base64,iVBORw0KGgo=',
          cashier_url: 'https://u.alipay.cn/example',
          out_trade_no: 'ORDER-12',
          out_shake_no: 'shake-12',
          trade_no: 'trade-12',
        },
      }),
    })

    await expect(client.execute({ action: 'order.create', packageId: 12 })).resolves.toEqual({
      payment: {
        paymentId: 'payment-12',
        status: 'pending_user_pay',
        amount: '9.90',
        currency: 'CNY',
        qrCodeImage: 'data:image/png;base64,iVBORw0KGgo=',
      },
      package: { id: 12, amount: '9.90', currency: 'CNY', diamonds: 100 },
    })
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
