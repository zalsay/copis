import { describe, expect, test } from 'bun:test'
import { buildMentionedToolsPrompt } from './agent-mentioned-tools-prompt'

describe('mentioned_tools 提示', () => {
  test('Given workspace Skill slug When building the prompt Then keeps the Pi resource name unchanged', () => {
    const prompt = buildMentionedToolsPrompt(['automation'], ['planning'])

    expect(prompt).toContain('- Skill: automation（请立即调用此 Skill）')
    expect(prompt).not.toContain('copis-workspace-default:automation')
    expect(prompt).toContain('- MCP 服务器: planning（请使用此 MCP 服务器的工具来完成任务）')
  })

  test('没有引用工具时不注入提示', () => {
    expect(buildMentionedToolsPrompt()).toBe('')
  })

  test('Given 旧版图片工具名称（如 copis_image）When building the prompt Then 注入兼容的内置 Skill 指引', () => {
    const prompt = buildMentionedToolsPrompt(undefined, ['copis_image', 'automation'])

    expect(prompt).toContain('- Skill: copis-image-generation（请使用 Copis 内置图片生成能力完成用户的生图或插画需求）')
    expect(prompt).toContain('- MCP 工具: 定时任务（请使用定时任务相关工具如 create_automation/list_automations 来完成任务）')
  })
})
