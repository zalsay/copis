import { describe, expect, test } from 'bun:test'
import { resolveFunctionalModulePrefix } from './functional-module-prefix'

describe('功能模块对象前缀配置', () => {
  test('命令行前缀优先于 OBJECT_PREFIX_PATH 和兼容配置', () => {
    expect(resolveFunctionalModulePrefix({
      cliPrefix: 'cli/modules',
      objectPrefixPath: 'env/modules',
      legacyCosPrefix: 'legacy/modules',
    })).toBe('cli/modules')
  })

  test('未指定命令行前缀时使用 OBJECT_PREFIX_PATH', () => {
    expect(resolveFunctionalModulePrefix({
      objectPrefixPath: 'env/modules',
      legacyCosPrefix: 'legacy/modules',
    })).toBe('env/modules')
  })

  test('兼容 COS_PREFIX，并在没有配置时使用默认路径', () => {
    expect(resolveFunctionalModulePrefix({ legacyCosPrefix: 'legacy/modules' })).toBe('legacy/modules')
    expect(resolveFunctionalModulePrefix({})).toBe('copis/modules')
  })
})
