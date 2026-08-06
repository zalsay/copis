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
})
