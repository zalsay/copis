/**
 * 工作区根目录下的特殊系统目录在 web 层的展示映射
 */

/**
 * 工作区根目录下的特殊系统目录在 web 层的中文映射名称
 */
export function getWorkspaceFolderDisplayName(name: string): string {
  if (name === 'browser') return 'browser(AI 浏览器)'
  if (name === 'project') return 'project(项目开发)'
  return name
}

/**
 * 获取文件条目在文件树中的展示名称。
 * 仅对工作区根目录下的顶层目录（depth === 0 且 scope 为 project/workspace）进行映射。
 */
export function getFileEntryDisplayName(
  entry: { name: string; isDirectory?: boolean; scope?: string },
  depth = 0,
): string {
  if (entry.isDirectory && depth === 0 && entry.scope !== 'session') {
    return getWorkspaceFolderDisplayName(entry.name)
  }
  return entry.name
}
