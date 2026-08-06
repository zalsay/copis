import type { BrowserWindowConstructorOptions } from 'electron'

interface CustomWindowChromeOptions {
  platform: NodeJS.Platform
  trafficLightPosition?: { x: number; y: number }
}

type WindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  'frame' | 'titleBarStyle' | 'trafficLightPosition' | 'vibrancy' | 'visualEffectState'
>

/**
 * 返回使用应用自定义标题栏时所需的窗口选项。
 * Windows 必须彻底移除原生非客户区，否则系统会先截获右上角按钮的点击。
 */
export function getCustomWindowChromeOptions({
  platform,
  trafficLightPosition,
}: CustomWindowChromeOptions): WindowChromeOptions {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition,
      vibrancy: 'under-window',
      visualEffectState: 'followWindow',
    }
  }

  if (platform === 'win32') {
    return { frame: false }
  }

  return {}
}
