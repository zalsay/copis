/** Chrome 文件选择只接受本地 Unix 绝对普通文件路径的安全语法子集。 */
export function isValidChromeDesktopFilePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= 4096
    && value.startsWith('/')
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    && !value.endsWith('/')
    && !value.split('/').some(segment => segment === '.' || segment === '..')
}
