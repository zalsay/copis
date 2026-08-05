import { describe, expect, test } from 'bun:test'
import {
  resolveRendererHttpApiPort,
} from './http-api-base-url'

describe('Renderer HTTP API 端口环境判断', () => {
  test('开发环境使用 51740', () => {
    expect(resolveRendererHttpApiPort(true)).toBe(51740)
  })

  test('正式环境使用 51730', () => {
    expect(resolveRendererHttpApiPort(false)).toBe(51730)
  })
})
