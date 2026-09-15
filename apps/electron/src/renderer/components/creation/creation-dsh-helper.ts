/**
 * 判断启动错误是否由于缺少/未安装 dsh 功能模块引起。
 */
export function isDshModuleMissingError(error?: string | null): boolean {
  if (!error) return false
  return /未找到.*激活.*(dsh|创造模式)|(dsh|创造模式).*未安装|未安装.*(dsh|创造模式)|缺少.*(dsh|创造模式)/i.test(error)
}

/** 进入创造模式时，未安装或已有新版本都需要先准备最新 DSH。 */
export function shouldInstallDshModule(status: {
  installed: boolean
  updateAvailable: boolean
}): boolean {
  return !status.installed || status.updateAvailable
}

const CLIENT_VERSION_LOW_PATTERN = /Copis 版本过低[，,\s]+需要至少\s*v?([^\s'"]+)/i

export interface CreationClientUpdateRequired {
  minClientVersion: string
}

export function parseCreationClientUpdateRequired(error?: string | null): CreationClientUpdateRequired | null {
  if (!error) return null
  const match = error.match(CLIENT_VERSION_LOW_PATTERN)
  return match ? { minClientVersion: match[1]! } : null
}

export function isCreationClientUpdateRequired(error?: string | null): boolean {
  return parseCreationClientUpdateRequired(error) !== null
}

export function formatCreationErrorMessage(error?: string | null): string {
  if (!error) return '创造模式微内核服务未能成功启动，请点击下方重试。'
  const updateReq = parseCreationClientUpdateRequired(error)
  if (updateReq) {
    return `当前 Copis 版本过低，需要至少 v${updateReq.minClientVersion}，请打开官网下载最新版本。`
  }
  return error.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}
