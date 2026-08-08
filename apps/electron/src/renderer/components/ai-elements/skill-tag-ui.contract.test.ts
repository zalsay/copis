import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const messageSource = readFileSync(join(import.meta.dir, 'message.tsx'), 'utf8')
const queueSource = readFileSync(join(import.meta.dir, '..', 'agent', 'AgentMessageQueue.tsx'), 'utf8')
const richTextSource = readFileSync(join(import.meta.dir, 'rich-text-input.tsx'), 'utf8')
const filePathChipSource = readFileSync(join(import.meta.dir, 'file-path-chip.tsx'), 'utf8')

const UI_PRIMARY_TAG_CLASS = 'bg-[var(--ui-primary-background)] text-[var(--ui-primary)]'

describe('Skill/文件 tag UI 契约', () => {
  test('Given 对话气泡渲染 Skill 引用 When 展示 tag Then 图标为 Puzzle 且颜色使用 ui-primary', () => {
    expect(messageSource).toContain(`skill: { icon: Puzzle, className: '${UI_PRIMARY_TAG_CLASS}' }`)
    expect(messageSource).not.toContain('Sparkles')
    expect(messageSource).not.toContain('hsl(270')
  })

  test('Given 消息队列预览渲染 Skill 引用 When 展示 tag Then 图标为 Puzzle 且颜色使用 ui-primary', () => {
    expect(queueSource).toContain(`skill: { icon: Puzzle, className: '${UI_PRIMARY_TAG_CLASS}' }`)
    expect(queueSource).not.toContain('Sparkles')
    expect(queueSource).not.toContain('hsl(270')
  })

  test('Given composer 内嵌 Skill chip When 展示 Then 图标为 Puzzle 且颜色使用 ui-primary', () => {
    expect(richTextSource).toContain('background-color: var(--ui-primary-background)')
    expect(richTextSource).toContain('color: var(--ui-primary)')
    expect(richTextSource).toContain('M15.39 4.39a1 1 0 0 0 1.68-.474')
    expect(richTextSource).not.toContain('hsl(270 60%')
    expect(richTextSource).not.toContain('M9.937 15.5')
  })

  test('Given 对话气泡渲染文件引用 When 展示 tag Then 与 Skill tag 使用同一套 ui-primary UI', () => {
    expect(messageSource).toContain(`file: { icon: FileText, className: '${UI_PRIMARY_TAG_CLASS}' }`)
    expect(queueSource).toContain(`file: { icon: FileText, className: '${UI_PRIMARY_TAG_CLASS}' }`)
    expect(richTextSource).not.toContain('hsl(var(--primary) / 0.1)')
    expect(richTextSource).not.toContain('hsl(var(--primary) / 0.14)')
  })

  test('Given 消息中出现文件路径 When 渲染 FilePathChip Then 与 Skill tag 使用同一套 ui-primary UI', () => {
    expect(filePathChipSource).toContain(`'bg-[var(--ui-primary-background)] text-[var(--ui-primary)]`)
    expect(filePathChipSource).not.toContain("'bg-primary/10 text-primary")
  })
})
