import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

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
