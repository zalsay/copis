/**
 * COS 自动更新源配置。
 *
 * 地址在构建时写入正式包，发布时只需将 electron-builder 生成的
 * latest*.yml 与对应安装包上传到同一目录。
 */

export const DEFAULT_COPIS_UPDATER_URL = 'https://download.meetlife.com.cn/copis/updates/stable'

declare const __COPIS_UPDATER_URL__: string | undefined

export function getUpdaterFeedUrl(buildUrl = typeof __COPIS_UPDATER_URL__ === 'string' ? __COPIS_UPDATER_URL__ : ''): string {
  const configuredUrl = buildUrl.trim()
    || DEFAULT_COPIS_UPDATER_URL

  try {
    const url = new URL(configuredUrl)
    if (url.protocol !== 'https:') throw new Error('更新源必须使用 HTTPS')
    return configuredUrl.replace(/\/+$/, '')
  } catch (error) {
    console.warn('[更新] COS 更新源地址无效，改用默认地址:', error)
    return DEFAULT_COPIS_UPDATER_URL
  }
}
