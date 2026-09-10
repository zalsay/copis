import { expect, test } from 'bun:test'
import { getAppUpdateStatusText } from './app-update-status'

test('Given 本机 0.0.84 远端 0.0.85 但不可下载 When 展示 Then 不宣称本机已升级', () => {
  expect(getAppUpdateStatusText({ status: 'not-available', version: '0.0.85' }, { version: '0.0.84', packaged: true }))
    .toBe('当前运行 v0.0.84，当前平台暂无可用更新')
})

test('Given 本机与远端版本相同 When 展示 Then 确认已是最新版', () => {
  expect(getAppUpdateStatusText({ status: 'not-available', version: '0.0.85' }, { version: '0.0.85', packaged: true }))
    .toBe('当前已是最新版 v0.0.85，没有可用更新')
})

test('Given 旧接口返回其他平台最高版本 When 可下载 Then 文案使用下载目标版本', () => {
  expect(getAppUpdateStatusText({ status: 'available', version: '0.0.84', latestVersion: '0.0.85' }, null))
    .toBe('发现新版本 v0.0.84，点击下载更新')
})

test('Given 当前版本未读取 When 无更新 Then 不声称已安装远端版本', () => {
  expect(getAppUpdateStatusText({ status: 'not-available', version: '0.0.85' }, null)).toBe('当前平台暂无可用更新')
})
