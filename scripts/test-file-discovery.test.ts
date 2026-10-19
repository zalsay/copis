import { describe, expect, test } from 'bun:test'
import { shouldRunRepositoryTest } from './test-file-discovery'

describe('仓库隔离测试只运行源码测试，不重复扫描安装包产物', () => {
  for (const file of [
    'apps/electron/src/main/lib/chrome-desktop-component-client.test.ts',
    'packages/shared/src/types/chrome-desktop.test.ts',
    'scripts/chrome-cli-deploy.test.ts',
    'apps/electron/dsh-plugins/copis-creation-web/src/client.test.ts',
    'third_party/dashi-ppt-skill/skills/dashi-ppt/project/scripts/browser-pptx-export.test.mjs',
  ]) {
    test(`Given 源码测试${file} When 发现 Then 保留执行`, () => {
      expect(shouldRunRepositoryTest(file)).toBe(true)
    })
  }
  for (const file of [
    'node_modules/library/index.test.ts',
    'apps/electron/node_modules/library/index.test.ts',
    'apps/electron/dist/resources/copied.test.ts',
    'apps/electron/out/mac-arm64/Copis.app/Contents/Resources/dsh-plugins/copis-creation-web/src/client.test.ts',
    'apps/electron/out/release-0.0.98/Copis.app/Contents/Resources/dsh-plugins/copis-creation-web/src/client.test.ts',
    'apps\\electron\\out\\win-unpacked\\resources\\copied.test.ts',
  ]) {
    test(`Given 依赖或构建产物${file} When 发现 Then 不作为源码执行`, () => {
      expect(shouldRunRepositoryTest(file)).toBe(false)
    })
  }
})
