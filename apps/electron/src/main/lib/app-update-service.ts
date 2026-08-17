/**
 * 通过本地 Rust HTTP API 检查主程序更新。
 *
 * Rust API 负责读取统一 client manifest，避免 Electron 直接访问可能缺失的
 * latest*.yml 更新源。
 */

import { app } from 'electron'
import { COPIS_HTTP_API_HOST, resolveCopisHttpApiPort } from '@copis/shared/config'
import type { AppUpdateInfo } from './updater/updater-types'
import { getHttpApiInternalToken } from './http-api-server'

export async function checkAppUpdateViaRustApi(): Promise<AppUpdateInfo> {
  const internalToken = getHttpApiInternalToken()
  if (!internalToken) {
    throw new Error('Rust HTTP API 尚未就绪，请稍后重试')
  }

  const port = resolveCopisHttpApiPort({
    configuredPort: process.env.COPIS_HTTP_API_PORT,
    isPackaged: app.isPackaged,
  })
  const url = `http://${COPIS_HTTP_API_HOST}:${port}/api/internal/app-update/check?client_version=${encodeURIComponent(app.getVersion())}`
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'X-Copis-Internal-Token': internalToken,
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    throw new Error(`Rust API 检查更新失败（HTTP ${response.status}）`)
  }

  return await response.json() as AppUpdateInfo
}
