/**
 * DSH 原生文件服务
 *
 * 为创造模式（DSH Web 界面）提供安全的文件读取与定位服务：
 * 1. 支持绝对路径、用户主目录缩写（~/）与基于 sessionCwd 的相对路径解析；
 * 2. 支持 UTF-8 文本安全读取与二进制文件快速检测；
 * 3. 支持常见图片格式转 Data URL 以便在内联面板中预览；
 * 4. 提供文件定位（在访达/文件资源管理器中打开）。
 */

import { isAbsolute, resolve, extname, join } from 'node:path'
import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import type { DshReadFileResult, DshFileEntry } from '@copis/shared'

export const DSH_IGNORED_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'node_modules'])

/** 创造模式文件树过滤规则：隐藏 node_modules、系统特殊文件及以点开头的隐藏目录 */
export function shouldShowDshFileTreeEntry(name: string, isDirectory: boolean): boolean {
  if (DSH_IGNORED_NAMES.has(name)) return false
  if (isDirectory && name.startsWith('.')) return false
  return true
}

export const MAX_DSH_TEXT_FILE_SIZE = 2 * 1024 * 1024 // 2MB
export const MAX_DSH_IMAGE_FILE_SIZE = 10 * 1024 * 1024 // 10MB

export const IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
}

/**
 * 解析并规格化目标路径。
 * 支持绝对路径、用户主目录缩写（~/）以及基于会话工作区的相对路径。
 */
export function resolveDshFilePath(filePath: string, cwd?: string): string {
  if (filePath.startsWith('~/') || filePath === '~') {
    return resolve(homedir(), filePath.slice(2))
  }
  if (!isAbsolute(filePath) && cwd) {
    return resolve(cwd, filePath)
  }
  return resolve(filePath)
}

/**
 * 检验文件前 1024 字节是否包含空字符（null byte），用以快速识别二进制文件
 */
export function isBinaryBuffer(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(1024, buf.length))
  return sample.includes(0)
}

/**
 * 读取待预览文件内容（支持 UTF-8 文本及图片 Data URL）
 */
export function readDshFile(filePath: string, cwd?: string): DshReadFileResult {
  if (!filePath || typeof filePath !== 'string' || !filePath.trim()) {
    return { success: false, error: '文件路径不能为空' }
  }

  try {
    const targetPath = resolveDshFilePath(filePath.trim(), cwd)
    if (!existsSync(targetPath)) {
      return { success: false, error: `文件不存在: ${filePath}`, path: targetPath }
    }

    const stat = statSync(targetPath)
    if (!stat.isFile()) {
      return { success: false, error: '目标路径不是普通文件', path: targetPath }
    }

    const ext = extname(targetPath).toLowerCase()
    const mimeType = IMAGE_EXTENSIONS[ext]

    // 图片格式特殊处理：转为 Base64 Data URL 供前端直接 <img> 呈现
    if (mimeType) {
      if (stat.size > MAX_DSH_IMAGE_FILE_SIZE) {
        return {
          success: false,
          error: `图片过大（${(stat.size / 1024 / 1024).toFixed(1)}MB），超过 10MB 限制，不支持预览`,
          path: targetPath,
          size: stat.size,
          isImage: true,
          tooLarge: true,
        }
      }
      const buf = readFileSync(targetPath)
      return {
        success: true,
        isImage: true,
        content: `data:${mimeType};base64,${buf.toString('base64')}`,
        path: targetPath,
        size: stat.size,
      }
    }

    // 文本文件超大尺寸保护
    if (stat.size > MAX_DSH_TEXT_FILE_SIZE) {
      return {
        success: false,
        error: `文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB），超过 2MB 限制，请在系统编辑器中查看`,
        path: targetPath,
        size: stat.size,
        tooLarge: true,
      }
    }

    const buf = readFileSync(targetPath)
    if (isBinaryBuffer(buf)) {
      return {
        success: false,
        error: '该文件为二进制文件，不支持文本预览',
        path: targetPath,
        size: stat.size,
        binary: true,
      }
    }

    return {
      success: true,
      isImage: false,
      content: buf.toString('utf8'),
      path: targetPath,
      size: stat.size,
    }
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || '读取文件时发生未知错误',
    }
  }
}

/**
 * 在系统文件管理器中显示文件
 */
export async function showDshItemInFolder(filePath: string, cwd?: string): Promise<boolean> {
  if (!filePath || typeof filePath !== 'string' || !filePath.trim()) return false
  try {
    const targetPath = resolveDshFilePath(filePath.trim(), cwd)
    if (!existsSync(targetPath)) {
      console.warn('[DSH] 路径不存在，无法在文件管理器中定位:', targetPath)
      return false
    }
    const { shell } = await import('electron')
    shell.showItemInFolder(targetPath)
    return true
  } catch (err) {
    console.warn('[DSH] showItemInFolder 失败:', err)
    return false
  }
}

/**
 * 列出指定目录（浅层）下的文件与子目录列表，按“目录在前、文件在后”排序。
 * 针对工作区树形展示自动过滤 node_modules、系统文件及隐藏目录。
 */
export function listDshDirectory(dirPath?: string, cwd?: string): DshFileEntry[] {
  try {
    const rawPath = dirPath && dirPath.trim() ? dirPath.trim() : (cwd || '.')
    const targetPath = resolveDshFilePath(rawPath, cwd)
    if (!existsSync(targetPath)) return []

    const stat = statSync(targetPath)
    if (!stat.isDirectory()) return []

    const items = readdirSync(targetPath, { withFileTypes: true })
    const entries: DshFileEntry[] = []

    for (const item of items) {
      const isDirectory = item.isDirectory()
      if (!shouldShowDshFileTreeEntry(item.name, isDirectory)) continue

      const fullPath = join(targetPath, item.name)
      let size: number | undefined
      if (!isDirectory) {
        try {
          size = statSync(fullPath).size
        } catch {
          // 忽略单个文件获取尺寸失败
        }
      }

      entries.push({
        name: item.name,
        path: fullPath,
        isDirectory,
        size,
      })
    }

    // 目录在前，文件在后；隐藏文件在各自分组中排在末尾；组内按文件名排序
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      const aHidden = a.name.startsWith('.')
      const bHidden = b.name.startsWith('.')
      if (aHidden !== bHidden) return aHidden ? 1 : -1
      return a.name.localeCompare(b.name)
    })

    return entries
  } catch (err) {
    console.warn('[DSH] listDshDirectory 失败:', err)
    return []
  }
}

