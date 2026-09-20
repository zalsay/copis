import { isNetworkError } from './error-patterns'

export interface BootstrapErrorDialogOptions {
  title: string
  content: string
}

/**
 * 根据应用启动错误类型格式化弹窗信息。
 * 当由于电脑未联网或网络异常导致启动失败时，返回简洁友好的提示；
 * 当遇到其他未知或致命错误时，保留详细的排查指引和日志位置。
 */
export function formatBootstrapErrorDialog(
  err: unknown,
  logsDir: string,
): BootstrapErrorDialogOptions {
  if (isNetworkError(err)) {
    return {
      title: '网络连接异常',
      content: '未能连接到网络服务，部分功能可能暂不可用。\n\n请检查电脑网络连接后重试。',
    }
  }

  const message = err instanceof Error ? (err.stack ?? err.message) : String(err)
  return {
    title: 'Copis 启动遇到错误',
    content:
      `部分功能可能不可用：\n\n${message}\n\n` +
      `日志位置：${logsDir}\n\n` +
      `常见原因与排查：\n` +
      `1. 旧版 Copis 进程未退出（终端运行 killall Copis 后重试）\n` +
      `2. ~/.copis/ 配置损坏（重命名 ~/.copis 后重启）\n` +
      `3. 系统 Keychain 无法解密保存的凭证（删除 ~/.copis/feishu.json 等后重新登录）\n\n` +
      `如需协助请到 GitHub Issues 反馈。`,
  }
}
