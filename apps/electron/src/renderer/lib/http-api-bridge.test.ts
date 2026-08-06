import { describe, expect, mock, test } from 'bun:test'
import type { MemoryExportFileInput } from '@copis/shared'
import { downloadMemoryExport } from './http-api-bridge'

describe('浏览器模式 Memory 导出', () => {
  test('没有 Electron 保存桥时创建浏览器下载', () => {
    const anchor = {
      click: mock(),
      download: '',
      href: '',
      remove: mock(),
    } as unknown as HTMLAnchorElement
    const appendChild = mock()
    const createElement = mock(() => anchor)
    const createObjectURL = mock((_blob: Blob) => 'blob:memory-export')
    const revokeObjectURL = mock()
    const input: MemoryExportFileInput = {
      fileName: 'copis-memory-project-a.md',
      mimeType: 'text/markdown',
      content: '# Memory',
    }

    const saved = downloadMemoryExport(input, {
      document: { body: { appendChild }, createElement } as unknown as Document,
      url: { createObjectURL, revokeObjectURL },
    })

    expect(saved).toBe(true)
    expect(createElement).toHaveBeenCalledWith('a')
    expect(anchor.download).toBe(input.fileName)
    expect(anchor.href).toBe('blob:memory-export')
    expect(appendChild).toHaveBeenCalledWith(anchor)
    expect(anchor.click).toHaveBeenCalledTimes(1)
    expect(anchor.remove).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:memory-export')
  })
})
