import { expect, test } from 'bun:test'
import { getCustomWindowChromeOptions } from './window-chrome'

test('Given Windows 自定义窗口按钮 When 创建窗口 Then 不保留原生非客户区', () => {
  expect(getCustomWindowChromeOptions({ platform: 'win32' })).toEqual({ frame: false })
})

test('Given macOS When 创建窗口 Then 保留交通灯和原生视觉效果', () => {
  expect(getCustomWindowChromeOptions({
    platform: 'darwin',
    trafficLightPosition: { x: 18, y: 10 },
  })).toEqual({
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 10 },
    vibrancy: 'under-window',
    visualEffectState: 'followWindow',
  })
})
