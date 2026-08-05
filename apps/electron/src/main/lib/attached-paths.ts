/**
 * 附加路径来自 JSON 索引和 IPC 输入，不能只依赖 TypeScript 类型保证运行时值有效。
 */

import { dirname } from 'node:path'

export function isValidAttachedPath(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function filterAttachedPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter(isValidAttachedPath)
}

export function normalizeAttachedPaths(value: unknown): string[] | undefined {
  const paths = filterAttachedPaths(value)
  return paths.length > 0 ? paths : undefined
}

/** 只对经过校验的文件路径调用 dirname，避免历史脏数据触发 Node path 异常。 */
export function getAttachedFileDirectories(value: unknown): string[] {
  return filterAttachedPaths(value).map((filePath) => dirname(filePath))
}

export function requireAttachedPath(value: unknown, label: string): string {
  if (!isValidAttachedPath(value)) throw new Error(`${label}不正确`)
  return value
}
