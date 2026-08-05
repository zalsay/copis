import { describe, expect, test } from 'bun:test'
import { createFunctionalModuleCosClient, type FunctionalModuleCosSdkClient } from './functional-module-cos-client'

describe('功能模块 COS SDK client', () => {
  test('将 sha256 写入 COS 自定义 metadata，并读取 HEAD 响应', async () => {
    const calls: Array<{ operation: string; params: Record<string, unknown> }> = []
    let uploaded = false
    const sdk: FunctionalModuleCosSdkClient = {
      putObject(params, callback) {
        calls.push({ operation: 'put', params })
        uploaded = true
        callback(null, {})
      },
      headObject(params, callback) {
        calls.push({ operation: 'head', params })
        if (!uploaded) {
          callback({ statusCode: 404 }, undefined)
          return
        }
        callback(null, {
          ContentLength: '7',
          headers: { 'x-cos-meta-sha256': 'ABC123' },
        })
      },
    }

    const client = createFunctionalModuleCosClient(sdk, { bucket: 'copis-1250000000', region: 'ap-shanghai' })
    await client.putObject({
      key: 'copis/modules/stable/manifest.json',
      body: Buffer.from('manifest'),
      contentType: 'application/json',
      metadata: { sha256: 'abc123' },
    })
    const head = await client.headObject({ key: 'copis/modules/stable/manifest.json' })

    expect(calls.map((call) => call.operation)).toEqual(['head', 'put', 'head'])
    expect(calls[1]).toMatchObject({
      operation: 'put',
      params: {
        Bucket: 'copis-1250000000',
        Region: 'ap-shanghai',
        Key: 'copis/modules/stable/manifest.json',
        ContentLength: 8,
        ContentType: 'application/json',
        'x-cos-meta-sha256': 'abc123',
        'x-cos-forbid-overwrite': 'true',
      },
    })
    expect(calls[0]?.params.Metadata).toBeUndefined()
    expect(head).toEqual({ size: 7, sha256: 'ABC123' })
  })

  test('重复发布相同对象时不覆盖 COS 内容', async () => {
    let putCount = 0
    const sdk: FunctionalModuleCosSdkClient = {
      putObject(_params, callback) {
        putCount += 1
        callback(null, {})
      },
      headObject(_params, callback) {
        callback(null, {
          ContentLength: 8,
          headers: { 'x-cos-meta-sha256': 'abc123' },
        })
      },
    }

    const client = createFunctionalModuleCosClient(sdk, { bucket: 'copis-1250000000', region: 'ap-shanghai' })
    await client.putObject({
      key: 'copis/modules/stable/manifest.json',
      body: Buffer.from('manifest'),
      contentType: 'application/json',
      metadata: { sha256: 'abc123' },
    })

    expect(putCount).toBe(0)
  })
})
