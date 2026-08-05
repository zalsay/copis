import { describe, expect, test } from 'bun:test'
import {
  COPIS_HTTP_API_DEVELOPMENT_PORT,
  COPIS_HTTP_API_PRODUCTION_PORT,
  resolveCopisHttpApiPort,
} from './index'

describe('Copis HTTP API 端口解析', () => {
  test('正式 App 始终使用正式端口，不受开发环境变量影响', () => {
    expect(resolveCopisHttpApiPort({ configuredPort: '51740', isPackaged: true }))
      .toBe(COPIS_HTTP_API_PRODUCTION_PORT)
  })

  test('开发环境使用显式端口', () => {
    expect(resolveCopisHttpApiPort({ configuredPort: '51740', isPackaged: false }))
      .toBe(COPIS_HTTP_API_DEVELOPMENT_PORT)
  })

  test('开发环境缺少或非法端口时回退到开发端口', () => {
    expect(resolveCopisHttpApiPort({ isPackaged: false })).toBe(COPIS_HTTP_API_DEVELOPMENT_PORT)
    expect(resolveCopisHttpApiPort({ configuredPort: 'invalid', isPackaged: false }))
      .toBe(COPIS_HTTP_API_DEVELOPMENT_PORT)
  })
})
