import { ipcMain, BrowserWindow } from 'electron'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { IPC_CHANNELS, AGENT_IPC_CHANNELS } from '@copis/shared'
import type { DetachedPreviewWindowInput, FileAccessOptions, ResolvedFileUrl } from '@copis/shared'
import { registerCopisFilePath } from '../lib/local-file-protocol'
import { normalizeFileAccessOptions, getPreviewCandidateBasePaths, isPathAllowed, getAllowedCandidateBasePaths } from '../lib/ipc-file-access'

export function registerDetachedPreviewIpcHandlers(): void {
  // 打开独立预览窗口
  ipcMain.handle(
    IPC_CHANNELS.OPEN_DETACHED_PREVIEW,
    async (event, input: DetachedPreviewWindowInput): Promise<string | null> => {
      if (!input || typeof input.sessionId !== 'string' || typeof input.filePath !== 'string' || typeof input.dirPath !== 'string') {
        console.warn('[IPC] preview:open-detached 收到无效参数')
        return null
      }
      const { openDetachedPreviewWindow } = await import('../lib/detached-preview-window')
      const sourceWindow = BrowserWindow.fromWebContents(event.sender)
      return openDetachedPreviewWindow(input, sourceWindow)
    }
  )

  // 获取独立预览窗口数据
  ipcMain.handle(
    IPC_CHANNELS.GET_DETACHED_PREVIEW_DATA,
    async (_, previewId: string) => {
      if (!previewId || typeof previewId !== 'string') return null
      const { getDetachedPreviewWindowData } = await import('../lib/detached-preview-window')
      return getDetachedPreviewWindowData(previewId)
    }
  )

  // 截图导出
  ipcMain.handle(
    IPC_CHANNELS.SCREENSHOT_CAPTURE,
    async (_, input: { html: string; isDark: boolean; width?: number; mode: 'clipboard' | 'file'; css?: string; themeClass?: string }) => {
      const { captureScreenshot } = await import('../lib/screenshot-service')
      return captureScreenshot(input)
    }
  )
}

export function registerClipboardPreviewIpcHandlers(): void {
  // 将剪贴板文本写入临时预览文件
  ipcMain.handle(
    AGENT_IPC_CHANNELS.WRITE_CLIPBOARD_PREVIEW,
    async (_, filename: string, content: string): Promise<string> => {
      if (typeof filename !== 'string' || !filename) {
        throw new Error('filename 必须是非空字符串')
      }
      if (typeof content !== 'string') {
        throw new Error('content 必须是字符串')
      }

      const { isAbsolute, join, relative, resolve } = await import('node:path')
      const { tmpdir } = await import('node:os')
      const { existsSync, mkdirSync } = await import('node:fs')
      const { writeFile } = await import('node:fs/promises')

      const tmpDir = join(tmpdir(), 'copis-preview')
      if (!existsSync(tmpDir)) {
        mkdirSync(tmpDir, { recursive: true })
      }

      // 安全文件名：替换路径分隔符和特殊字符，防止目录穿越
      const safeFilename = filename.replace(/[<>:"/\\|?*]/g, '_').replace(/^\.+/, '_')
      const tmpPath = resolve(tmpDir, safeFilename)

      // 确保 resolve 后的路径仍在 tmpDir 内，兼容 Windows 路径分隔符
      const relativePath = relative(tmpDir, tmpPath)
      if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
        throw new Error('文件名越界')
      }

      await writeFile(tmpPath, content, 'utf-8')
      console.log(`[IPC] clipboard 预览文件已写入: ${tmpPath}`)
      return tmpPath
    }
  )
}

export function registerFilePreviewIpcHandlers(): void {
  // 解析文件路径并读取内容（供内联预览使用）
  ipcMain.handle(
    'file:resolve-and-read',
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<{ resolvedPath: string; content: string } | null> => {
      const { resolveAndReadFile, resolveFilePath } = await import('../lib/file-preview-service')
      const options = normalizeFileAccessOptions(access)
      const resolved = resolveFilePath(filePath, getPreviewCandidateBasePaths(options))
      if (!resolved || !isPathAllowed(resolved, options)) {
        console.warn('[IPC] file:resolve-and-read 拒绝越界路径:', resolved ?? filePath)
        return null
      }
      const result = resolveAndReadFile(resolved)
      return result
    }
  )

  // 写入文本文件（供 Markdown 内联编辑使用）
  ipcMain.handle(
    'file:write-text',
    async (_, filePath: string, content: string, access?: FileAccessOptions | string[]): Promise<boolean> => {
      if (typeof content !== 'string') return false
      const { writeFileSync } = await import('node:fs')
      const { resolveFilePath } = await import('../lib/file-preview-service')
      const options = normalizeFileAccessOptions(access)
      const allowedBasePaths = getAllowedCandidateBasePaths(options)
      const resolved = resolveFilePath(filePath, allowedBasePaths)
      if (!resolved || !isPathAllowed(resolved, options)) {
        console.warn('[IPC] file:write-text 拒绝越界路径:', resolved ?? filePath)
        return false
      }
      writeFileSync(resolved, content, 'utf-8')
      return true
    }
  )

  // 仅解析文件路径（供 PDF/图片等用 file:// 加载）
  ipcMain.handle(
    'file:resolve-path',
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<ResolvedFileUrl | null> => {
      const { resolveFilePath } = await import('../lib/file-preview-service')
      const options = normalizeFileAccessOptions(access)
      const result = resolveFilePath(filePath, getPreviewCandidateBasePaths(options))
      if (!result || !isPathAllowed(result, options)) {
        console.warn('[IPC] file:resolve-path 拒绝越界路径:', result ?? filePath)
        return null
      }
      // 路径识别基于文本形态时，目录也可能被当作绝对文件路径传入。
      // 该接口只返回可预览文件的 URL，目录直接跳过，不进入文件注册流程。
      try {
        if (!statSync(result).isFile()) return null
        return { url: registerCopisFilePath(result) }
      } catch (err) {
        console.warn('[IPC] file:resolve-path 无法注册为文件，跳过:', result, err instanceof Error ? err.message : err)
        return null
      }
    }
  )

  // 为内联 PDF 预览生成临时 HTML 文件，返回文件路径
  ipcMain.handle(
    'file:prepare-pdf-preview',
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<{ tmpHtmlUrl: string } | null> => {
      const { preparePdfPreview, resolveFilePath } = await import('../lib/file-preview-service')
      const options = normalizeFileAccessOptions(access)
      const resolved = resolveFilePath(filePath, getPreviewCandidateBasePaths(options))
      if (!resolved || !isPathAllowed(resolved, options)) {
        console.warn('[IPC] file:prepare-pdf-preview 拒绝越界路径:', resolved ?? filePath)
        return null
      }
      const result = await preparePdfPreview(resolved)
      return result ? { tmpHtmlUrl: result.tmpHtmlUrl } : null
    }
  )

  // DOCX 转 HTML（内联预览使用 mammoth）
  ipcMain.handle(
    'file:docx-to-html',
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<{ resolvedPath: string; html: string } | null> => {
      const { convertDocxToHtml, resolveFilePath } = await import('../lib/file-preview-service')
      const options = normalizeFileAccessOptions(access)
      const resolved = resolveFilePath(filePath, getPreviewCandidateBasePaths(options))
      if (!resolved || !isPathAllowed(resolved, options)) {
        console.warn('[IPC] file:docx-to-html 拒绝越界路径:', resolved ?? filePath)
        return null
      }
      const result = await convertDocxToHtml(resolved)
      return result
    }
  )

  // XLSX/PPTX 转 HTML（内联预览使用 OOXML 解析）
  ipcMain.handle(
    'file:office-to-html',
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<import('@copis/shared').OfficePreviewResult | null> => {
      const { convertOfficeToHtml, resolveFilePath } = await import('../lib/file-preview-service')
      const options = normalizeFileAccessOptions(access)
      const resolved = resolveFilePath(filePath, getPreviewCandidateBasePaths(options))
      if (!resolved || !isPathAllowed(resolved, options)) {
        console.warn('[IPC] file:office-to-html 拒绝越界路径:', resolved ?? filePath)
        return null
      }
      return convertOfficeToHtml(resolved)
    }
  )

  // 读取文件为 base64（供内联图片预览等使用）
  ipcMain.handle(
    'file:read-binary-base64',
    async (_, filePath: string, access?: FileAccessOptions | string[], maxSize?: number): Promise<string | null> => {
      const { readFileSync, statSync } = await import('node:fs')
      const { resolveFilePath } = await import('../lib/file-preview-service')
      const options = normalizeFileAccessOptions(access)
      const resolved = resolveFilePath(filePath, getPreviewCandidateBasePaths(options))
      if (!resolved || !isPathAllowed(resolved, options)) {
        console.warn('[IPC] file:read-binary-base64 拒绝越界路径:', resolved ?? filePath)
        return null
      }
      const st = statSync(resolved)
      const maxAllowedSize = Math.min(maxSize ?? 50 * 1024 * 1024, 50 * 1024 * 1024)
      if (st.size > maxAllowedSize) return null
      return readFileSync(resolved).toString('base64')
    }
  )
}
