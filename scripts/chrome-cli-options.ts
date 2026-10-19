/** 短部署参数与历史参数共用值解析，不能静默用另一个归档或版本覆盖显式输入。 */
export function getChromeCliOption(
  name: 'archive' | 'version',
  argv: readonly string[] = process.argv,
): string | undefined {
  const names = [`--chrome-cli-${name}`, `--chrome-desktop-cli-${name}`]
  const values = new Set<string>()
  for (let index = 0; index < argv.length; index++) {
    if (!names.includes(argv[index]!)) continue
    const value = argv[index + 1]?.trim()
    if (!value || value.startsWith('--')) throw new Error(`Chrome 参数 ${argv[index]} 缺少值`)
    values.add(value)
  }
  if (values.size > 1) throw new Error(`Chrome 参数 ${names.join(' / ')} 的值存在冲突`)
  return values.values().next().value
}
