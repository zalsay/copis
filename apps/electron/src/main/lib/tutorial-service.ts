/**
 * 教程服务
 *
 * 负责读取内置教程内容。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { getBundledResourcesDir } from './bundled-resources'

/**
 * 获取教程文件路径
 *
 * 开发模式：从 monorepo 根目录读取
 * 生产模式：从已安装的默认技能和素材模块读取
 */
function getTutorialFilePath(): string {
  return join(getBundledResourcesDir(), 'tutorial.md')
}

/**
 * 读取教程内容
 *
 * @returns 教程 markdown 文本，读取失败返回 null
 */
export function getTutorialContent(): string | null {
  const filePath = getTutorialFilePath()

  if (!existsSync(filePath)) {
    console.warn('[教程服务] 教程文件不存在:', filePath)
    return null
  }

  try {
    return readFileSync(filePath, 'utf-8')
  } catch (error) {
    console.error('[教程服务] 读取教程文件失败:', error)
    return null
  }
}
