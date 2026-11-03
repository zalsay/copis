import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { patchDshDetailsPanelFilePreviewRuntime } from './dsh-details-panel-patch'

test('Given 新版官方 Chat 不再包含旧 DetailsPanel When 启动前处理 Then 不修改组件且安静跳过旧补丁', () => {
  const root = mkdtempSync(join(tmpdir(), 'copis-dsh-no-details-'))
  const path = join(root, 'node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js')
  const source = 'window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-client-ui-chat", factory() {} });'
  const original = console.warn
  const warnings: unknown[][] = []
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, source)
    console.warn = (...args) => { warnings.push(args) }
    expect(patchDshDetailsPanelFilePreviewRuntime(root)).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(source)
    expect(warnings).toHaveLength(0)
  } finally {
    console.warn = original
    rmSync(root, { recursive: true, force: true })
  }
})
