import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { parseDocument } from 'yaml'

/** Copis 同步和群模型目录读取同一份原生 profile，不从过期的 settings.yaml 恢复已删除项。 */
export function readDshProfilePatch(file: string): any[] {
  if (!existsSync(file)) return []
  const doc = parseDocument(readFileSync(file, 'utf8'))
  if (!doc.errors.length) {
    const items = doc.toJS()
    if (Array.isArray(items)) return items
  }
  throw new Error('DSH 原生 Profile 格式无效，已停止同步以保护模型配置')
}

export const DSH_CUSTOM_KEY_PREFIX = 'COPIS_DSH_CUSTOM_'
export function dshAccountKeyRef(owner: string | undefined, id: string) {
  return DSH_CUSTOM_KEY_PREFIX + createHash('sha256').update(`${owner ?? 'default'}:${id}`).digest('hex').toUpperCase()
}
