/** 项目文件树展示过滤规则。 */
export function shouldShowProjectFileTreeEntry(name: string, isDirectory: boolean): boolean {
  return !(isDirectory && name.startsWith('.'))
}
