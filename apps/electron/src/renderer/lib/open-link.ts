/**
 * 链接打开工具函数
 *
 * 优先在应用内 Chromium 页签（webTabs）中打开网页链接（http/https），
 * 若处于非 Electron 环境、页签不可用或打开失败，则回退到系统默认浏览器（openExternal）。
 */

export async function openLink(url: string | undefined | null): Promise<void> {
  if (!url) return

  const isHttp = url.startsWith('http://') || url.startsWith('https://')
  if (!isHttp) {
    if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
      try {
        await window.electronAPI.openExternal(url)
      } catch (error) {
        console.error('[openLink] 打开外部链接失败:', error)
      }
    }
    return
  }

  // 1. 优先在应用内 Chromium 页签中打开
  try {
    if (typeof window !== 'undefined' && window.electronAPI?.webTabs?.create) {
      await window.electronAPI.webTabs.create({ url, activate: true })
      return
    }
  } catch (error) {
    console.warn('[openLink] 在内嵌页签中打开失败，回退到系统浏览器:', error)
  }

  // 2. 回退到系统默认浏览器打开
  try {
    if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
      await window.electronAPI.openExternal(url)
    }
  } catch (fallbackError) {
    console.error('[openLink] 打开外部链接失败:', fallbackError)
  }
}
