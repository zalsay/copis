import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mentionSource = readFileSync(join(import.meta.dir, 'mention-suggestions.tsx'), 'utf8')
const skillsApiSource = readFileSync(join(import.meta.dir, '..', '..', 'lib', 'workspace-skills-api.ts'), 'utf8')

describe('Mention 建议数据源契约', () => {
  test('Given 输入 / When 展示可用 Skills Then 通过 Rust HTTP API 读取而非 Electron IPC', () => {
    expect(mentionSource).toContain("char: '/'")
    expect(mentionSource).toContain('listWorkspaceSkills(slug)')
    expect(mentionSource).not.toContain('getWorkspaceCapabilities')
    expect(skillsApiSource).toContain('/api/workspaces/')
    expect(skillsApiSource).toContain('/skills')
  })

  test('Given 输入 / When 展示 Skill 建议 Then 图标为 Puzzle 且颜色使用 ui-primary 与 ui-primary-background', () => {
    expect(mentionSource).toContain('<Puzzle')
    expect(mentionSource).toContain('bg-[var(--ui-primary-background)] text-[var(--ui-primary)]')
    expect(mentionSource).not.toContain('Sparkles')
    expect(mentionSource).not.toContain('text-violet-500')
    expect(mentionSource).not.toContain('text-blue-600')
  })

  test('Given 输入 # When 展示 MCP 服务 Then 继续通过 Rust HTTP API 读取', () => {
    expect(mentionSource).toContain("char: '#'")
    expect(mentionSource).toContain('getWorkspaceMcpConfig(slug)')
  })
})
