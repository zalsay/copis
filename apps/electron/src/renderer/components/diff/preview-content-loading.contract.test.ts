import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, 'DiffTabContent.tsx'), 'utf8')

describe('Markdown 预览读取接线', () => {
  test('HTTP 读取失败时使用旧 IPC 回退，并把双失败呈现为加载错误', () => {
    expect(source).toContain("import { loadPreviewText } from './preview-text-loader'")
    expect(source).toContain('readViaIpc: () => window.electronAPI.resolveAndReadFile(filePath, fileAccess)')
    expect(source).toContain("setLoadError('文件预览加载失败，请点击刷新重试')")
    expect(source).toContain(') : loadError ? (')
  })

  test('无 revision 缓存命中时清理旧 revision', () => {
    expect(source).toMatch(
      /if \(cached\.revision\) \{\s+fileRevisionsRef\.current\.set\(filePath, cached\.revision\)\s+\} else \{\s+fileRevisionsRef\.current\.delete\(filePath\)\s+\}/,
    )
  })
})
