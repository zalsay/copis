/**
 * Copis 客户端稳定设备标识与聊天室本地路径。
 *
 * 设备标识是本机 WebSync 和聊天室共用的唯一来源；聊天室路径只接受
 * 受限组件，避免把用户输入直接交给 path.join 造成目录穿越。
 */

import { randomUUID } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { getClientDevicePath, getWebSyncStatePath } from './config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'

export {
  getClientDevicePath,
  getChatRoomsRootPath,
  getChatRoomPath,
  getChatRoomConfigPath,
  getChatRoomAgentPath,
  getChatRoomAgentSessionDir,
  getChatRoomAgentSessionMetaPath,
  getChatRoomAgentSessionMessagesPath,
  getChatRoomAgentProjectPath,
  getChatRoomAgentInboxPath,
  getChatRoomAgentSkillsSnapshotPath,
} from './config-paths'

interface ClientDeviceFile {
  version: 1
  deviceId: string
  createdAt: number
}

const DEVICE_ID_MAX_LENGTH = 128

function isValidDeviceId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= DEVICE_ID_MAX_LENGTH
    && value.trim() === value
    && !/[\s\u0000-\u001f\u007f]/.test(value)
    && !/[\\/]/.test(value)
}

/**
 * 读取或创建本机稳定设备 ID。
 *
 * 迁移优先级：client-device.json > web-sync-state.json.deviceId > UUID v4。
 * 设备 ID 不写入日志，文件权限固定为仅当前用户可读写。
 */
export function getOrCreateClientDeviceId(): string {
  const clientDevicePath = getClientDevicePath()
  const current = readJsonFileSafe<Partial<ClientDeviceFile>>(clientDevicePath)
  if (current?.version === 1 && isValidDeviceId(current.deviceId)) {
    try {
      chmodSync(clientDevicePath, 0o600)
    } catch {
      // 权限修复失败不影响读取稳定设备标识。
    }
    return current.deviceId
  }

  const legacy = readJsonFileSafe<{ deviceId?: unknown }>(getWebSyncStatePath())
  const deviceId = isValidDeviceId(legacy?.deviceId) ? legacy.deviceId : randomUUID()
  const file: ClientDeviceFile = {
    version: 1,
    deviceId,
    createdAt: Date.now(),
  }
  writeJsonFileAtomic(clientDevicePath, file, false, 0o600)
  return deviceId
}
