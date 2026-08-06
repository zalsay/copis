import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const settingsSource = readFileSync(join(import.meta.dir, 'ToolSettings.tsx'), 'utf8')
const settingsTabSource = readFileSync(join(import.meta.dir, '../../atoms/settings-tab.ts'), 'utf8')
const agentSkillsSource = readFileSync(join(import.meta.dir, '../agent-skills/AgentSkillsView.tsx'), 'utf8')
const agentToolConfigSource = readFileSync(join(import.meta.dir, '../../../main/lib/agent-tool-config.ts'), 'utf8')
const agentToolTypesSource = readFileSync(join(import.meta.dir, '../../../../../../packages/shared/src/types/agent-tool.ts'), 'utf8')

describe('Nowledge Mem 设置移除', () => {
  test('Given 打开 Agent 工具设置 When 检查设置入口 Then 不再包含外部记忆向导或聚焦入口', () => {
    expect(settingsSource).not.toContain('MemorySettings')
    expect(settingsSource).not.toContain('nowledge')
    expect(settingsTabSource).not.toContain("'memory'")
    expect(agentSkillsSource).not.toContain("mem: 'memory'")
    expect(agentToolConfigSource).not.toContain('memory.json')
    expect(agentToolConfigSource).not.toContain('memory: { enabled: true }')
    expect(agentToolTypesSource).not.toContain('memory.json')
    expect(existsSync(join(import.meta.dir, 'MemorySettings.tsx'))).toBe(false)
    expect(existsSync(join(import.meta.dir, 'nowledge-mem-prompt.md'))).toBe(false)
  })
})
