/** 打包目录中的测试副本依赖源码相对路径，不能当作仓库测试重复执行。 */
export function shouldRunRepositoryTest(file: string): boolean {
  const normalized = file.replaceAll('\\', '/').replace(/^\.\//, '')
  const parts = normalized.split('/')
  return !parts.includes('node_modules')
    && !parts.includes('dist')
    && !normalized.startsWith('apps/electron/out/')
}
