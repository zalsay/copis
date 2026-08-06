import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const panelSource = readFileSync(join(import.meta.dir, 'CopisWorkingSettingsPanel.tsx'), 'utf8')

describe('Working 设置菜单契约', () => {
  test('Given Working 设置 When 读取菜单定义 Then 只包含四个迁移页面', () => {
    const requiredSections = [
      ['voice-input', '语音输入'],
      ['migration', '数据迁移'],
      ['storage', '磁盘管理'],
      ['appearance', '外观设置'],
    ] as const

    for (const [id, label] of requiredSections) {
      expect(panelSource).toContain(`id: '${id}'`)
      expect(panelSource).toContain(`label: '${label}'`)
    }

    for (const legacySection of ['orders', 'messages', 'tutorial', 'check-in'] as const) {
      expect(panelSource).not.toContain(`id: '${legacySection}'`)
    }

    for (const legacyLabel of ['我的订单', '工作消息接收方式', '查看使用教程', '每日签到'] as const) {
      expect(panelSource).not.toContain(legacyLabel)
    }
  })
})
