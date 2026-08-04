import type { DefaultAppInfo } from '@copis/shared'

export function getDefaultAppOpenLabel(info: DefaultAppInfo | null): string {
  return info ? `用 ${info.name} 打开` : '用系统默认应用打开'
}
