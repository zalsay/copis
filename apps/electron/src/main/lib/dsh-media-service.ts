import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { DshMediaPreviewResult } from '@copis/shared'
import { registerCopisFilePath } from './local-file-protocol'
import { localMediaType } from './local-media-response'

/** 官方 Resource 已提供 Host 绝对路径；只发放受当前 DSH WebContents 管理的媒体令牌。 */
export function prepareDshMediaPreview(path: string, ownerId: number): DshMediaPreviewResult {
  if (typeof path !== 'string' || !path.trim() || !isAbsolute(path)) {
    return { success: false, error: '媒体预览需要有效的本地绝对路径' }
  }
  try {
    const target = realpathSync(path)
    const mimeType = localMediaType(target)
    if (!mimeType) return { success: false, error: '仅支持 MP4 视频和 MP3 音频预览' }
    if (!statSync(target).isFile()) return { success: false, error: '目标路径不是普通文件' }
    return { success: true, url: registerCopisFilePath(target, ownerId), kind: mimeType === 'video/mp4' ? 'video' : 'audio', mimeType }
  } catch {
    return { success: false, error: '媒体文件不存在或无法读取' }
  }
}
