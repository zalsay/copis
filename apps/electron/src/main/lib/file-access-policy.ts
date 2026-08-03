import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export function realpathOrResolve(pathValue: string): string {
  try {
    return realpathSync(resolve(pathValue))
  } catch {
    return resolve(pathValue)
  }
}

export function isUnderRoot(resolvedPath: string, root: string): boolean {
  const resolvedRoot = realpathOrResolve(root)
  const relativePath = relative(resolvedRoot, resolvedPath)
  return relativePath === '' || (
    relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
  )
}

/**
 * Resolve both sides through symlinks before comparing. A lexical prefix check
 * is not sufficient because a workspace child may be a symlink to another tree.
 */
export function isPathWithinAuthorizedRoots(filePath: string, roots: readonly string[]): boolean {
  let resolvedPath: string
  try {
    resolvedPath = realpathSync(resolve(filePath))
  } catch {
    return false
  }
  return roots.some((root) => isUnderRoot(resolvedPath, root))
}

/**
 * 解析包含尚未创建目标文件的路径，同时保留已有父级目录的真实路径。
 * 这样 Write 新文件时也不会通过指向工作区外部的符号链接绕过目录边界。
 */
function resolvePathThroughExistingParents(filePath: string): string {
  const resolvedPath = resolve(filePath)
  let current = resolvedPath

  while (true) {
    try {
      const realCurrent = realpathSync(current)
      const tail = relative(current, resolvedPath)
      return tail ? resolve(realCurrent, tail) : realCurrent
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolvedPath
      current = parent
    }
  }
}

/** 允许校验目标文件尚不存在的写入路径。 */
export function isPathWithinRootsAllowMissing(filePath: string, roots: readonly string[]): boolean {
  const resolvedPath = resolvePathThroughExistingParents(filePath)
  return roots.some((root) => isUnderRoot(resolvedPath, root))
}
