import { describe, expect, mock, test } from 'bun:test'
import type { AddressInfo } from 'node:net'

// Bun 测试环境没有 Electron 原生模块，健康检查测试不需要真实凭证存储。
mock.module('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}))

const { createHttpApiServer } = await import('./http-api-server')

describe('本地 HTTP API 服务', () => {
  test('提供健康检查并允许 Vite 页面跨域访问', async () => {
    const server = createHttpApiServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })

    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('测试 HTTP 服务没有分配端口')
      const port = (address as AddressInfo).port
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: { Origin: 'http://127.0.0.1:5174' },
      })
      const payload = await response.json() as { ok: boolean; service: string; port: number }

      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5174')
      expect(payload).toEqual({ ok: true, service: 'copis-http-api', port: 51730 })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('拒绝未授权的浏览器来源', async () => {
    const server = createHttpApiServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })

    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('测试 HTTP 服务没有分配端口')
      const response = await fetch(`http://127.0.0.1:${(address as AddressInfo).port}/api/health`, {
        headers: { Origin: 'http://example.com' },
      })
      expect(response.status).toBe(403)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
