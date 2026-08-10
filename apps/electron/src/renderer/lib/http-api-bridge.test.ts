import { describe, expect, mock, test } from 'bun:test'
import type { MemoryExportFileInput } from '@copis/shared'
import { downloadMemoryExport, installHttpApiBridge } from './http-api-bridge'

describe('浏览器模式 Memory 导出', () => {
  test('没有 Electron 保存桥时创建浏览器下载', () => {
    const anchor = {
      click: mock(),
      download: '',
      href: '',
      remove: mock(),
    } as unknown as HTMLAnchorElement
    const appendChild = mock()
    const createElement = mock(() => anchor)
    const createObjectURL = mock((_blob: Blob) => 'blob:memory-export')
    const revokeObjectURL = mock()
    const input: MemoryExportFileInput = {
      fileName: 'copis-memory-project-a.md',
      mimeType: 'text/markdown',
      content: '# Memory',
    }

    const saved = downloadMemoryExport(input, {
      document: { body: { appendChild }, createElement } as unknown as Document,
      url: { createObjectURL, revokeObjectURL },
    })

    expect(saved).toBe(true)
    expect(createElement).toHaveBeenCalledWith('a')
    expect(anchor.download).toBe(input.fileName)
    expect(anchor.href).toBe('blob:memory-export')
    expect(appendChild).toHaveBeenCalledWith(anchor)
    expect(anchor.click).toHaveBeenCalledTimes(1)
    expect(anchor.remove).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:memory-export')
  })
})

describe('浏览器模式 Working 支付 bridge', () => {
  test('通过 Rust Working 路由读取并归一化支付响应', async () => {
    const runtime = globalThis as typeof globalThis & { window?: Window & typeof globalThis }
    const previousWindow = runtime.window
    const previousFetch = globalThis.fetch
    const calls: Array<{ path: string; authorization: string | null }> = []

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      const parsed = new URL(url, 'http://127.0.0.1:51730')
      calls.push({
        path: parsed.pathname,
        authorization: new Headers(init?.headers).get('Authorization'),
      })
      if (parsed.pathname === '/api/working/diamond-packages') {
        return new Response(JSON.stringify([
          { id: 1, service_id: 'diamond', amount: '9.90', amount_cents: 990, diamonds: 100 },
          { id: 2, service_id: 'pi-vip', amount: '49.90', amount_cents: 4990, diamonds: 500 },
        ]))
      }
      if (parsed.pathname === '/api/working/vip/upgrade') {
        return new Response(JSON.stringify({
          package: { id: 2, service_id: 'pi-vip', amount: '49.90', amount_cents: 4990, diamonds: 500 },
          is_vip: true,
          payment: { payment_id: 'vip-payment', status: 'pending_user_pay', qrcode_image: 'vip-qr' },
          vip: { service_id: 'pi-vip', days: 30, bonus_diamonds: 500 },
        }))
      }
      return new Response(JSON.stringify({
        skill: 'alipay.payment.check',
        ok: true,
        data: {
          status: 'resource_ready',
          payment: { payment_id: 'payment/1', status: 'resource_ready' },
        },
      }))
    }) as unknown as typeof fetch
    runtime.window = {} as Window & typeof globalThis

    try {
      installHttpApiBridge()
      const api = runtime.window.electronAPI
      await expect(api?.listWorkingDiamondPackages()).resolves.toEqual([
        expect.objectContaining({ id: 1, amount: '9.90', diamonds: 100 }),
      ])
      await expect(api?.createWorkingVipUpgrade()).resolves.toEqual(expect.objectContaining({
        isVip: true,
        payment: expect.objectContaining({ paymentId: 'vip-payment', qrCodeImage: 'data:image/png;base64,vip-qr' }),
      }))
      await expect(api?.checkWorkingPayment('payment/1')).resolves.toEqual({
        status: 'resource_ready',
        payment: expect.objectContaining({ paymentId: 'payment/1' }),
      })
      expect(calls).toEqual([
        { path: '/api/working/diamond-packages', authorization: null },
        { path: '/api/working/vip/upgrade', authorization: null },
        { path: '/api/working/diamond-purchases/payment%2F1/check', authorization: null },
      ])
    } finally {
      globalThis.fetch = previousFetch
      runtime.window = previousWindow
    }
  })
})
