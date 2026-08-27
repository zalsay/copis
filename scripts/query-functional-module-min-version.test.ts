import { describe, expect, test } from 'bun:test'
import {
  compareClientVersions,
  fetchPlatformMinClientVersion,
  getPlatformMinClientVersion,
} from './query-functional-module-min-version'

const manifest = {
  schema: 1,
  channel: 'stable',
  client: { minVersion: '0.0.70' },
  platforms: {
    'darwin-x64': {
      minClientVersion: '0.0.67',
      modules: {},
    },
    'win32-x64': {
      minClientVersion: '0.0.70',
      modules: {},
    },
    'linux-x64': {
      modules: {},
    },
  },
}

describe('按目标平台查询功能模块最低客户端版本', () => {
  test('Darwin 和 Windows 分别读取各自的平台门槛', () => {
    expect(getPlatformMinClientVersion(manifest, 'darwin', 'x64')).toBe('0.0.67')
    expect(getPlatformMinClientVersion(manifest, 'win32', 'x64')).toBe('0.0.70')
  })

  test('旧 manifest 没有平台门槛时回退全局门槛', () => {
    expect(getPlatformMinClientVersion(manifest, 'linux', 'x64')).toBe('0.0.70')
  })

  test('查询只发送当前目标并返回最低版本', async () => {
    let requestedUrl = ''
    const minVersion = await fetchPlatformMinClientVersion(
      'https://download.example.com/manifest.json',
      'darwin',
      'x64',
      async (url) => {
        requestedUrl = String(url)
        return new Response(JSON.stringify(manifest), { status: 200 })
      },
    )

    expect(requestedUrl).toBe('https://download.example.com/manifest.json')
    expect(minVersion).toBe('0.0.67')
  })

  test('目标平台不存在时拒绝继续构建', () => {
    expect(() => getPlatformMinClientVersion(manifest, 'darwin', 'arm64'))
      .toThrow('没有当前平台')
  })

  test('版本比较按数字段比较，不把 0.0.10 当成低于 0.0.9', () => {
    expect(compareClientVersions('0.0.10', '0.0.9')).toBeGreaterThan(0)
    expect(compareClientVersions('0.0.67', '0.0.70')).toBeLessThan(0)
  })
})
