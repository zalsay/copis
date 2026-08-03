import { describe, expect, mock, test } from 'bun:test'

// Bun 测试环境没有 Electron 原生模块，健康检查测试不需要真实凭证存储。
mock.module('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}))

const { handleHttpApiRequest } = await import('./http-api-handler')

describe('Rust HTTP API 业务桥契约', () => {
  test('健康检查保持原有响应格式', async () => {
    const response = await handleHttpApiRequest({
      method: 'GET',
      path: '/api/health',
    })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      ok: true,
      service: 'copis-http-api',
      port: 51730,
    })
  })

  test('未知路径返回统一错误结构', async () => {
    const response = await handleHttpApiRequest({
      method: 'GET',
      path: '/api/unknown',
    })

    expect(response.status).toBe(404)
    expect(response.body).toEqual({
      error: 'HTTP API 路径不存在',
      code: 'not_found',
    })
  })

  test('非法 JSON 保持原有错误码', async () => {
    const response = await handleHttpApiRequest({
      method: 'PATCH',
      path: '/api/settings',
      body: '{',
    })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      error: '请求体不是有效的 JSON',
      code: 'invalid_json',
    })
  })
})
