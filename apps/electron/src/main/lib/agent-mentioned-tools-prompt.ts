const BUILTIN_MCP_PROMPTS: Record<string, string> = {
  copis_image: '- MCP 工具: Copis 图片生成（请主动调用 generate_image 工具来完成用户的生图或插画需求）',
  'nano-banana': '- MCP 工具: Copis 图片生成（请主动调用 generate_image 工具来完成用户的生图或插画需求）',
  automation: '- MCP 工具: 定时任务（请使用定时任务相关工具如 create_automation/list_automations 来完成任务）',
  collaboration: '- MCP 工具: 协作子 Agent（请使用协作子 Agent 相关工具如 delegate_agent 来完成任务）',
}

/** 构造用户在消息中明确引用的 Skill 和 MCP 工具提示。 */
export function buildMentionedToolsPrompt(
  mentionedSkills?: readonly string[],
  mentionedMcpServers?: readonly string[],
): string {
  if (!mentionedSkills?.length && !mentionedMcpServers?.length) return ''

  const toolLines: string[] = ['用户在消息中明确引用了以下工具，请在本次回复中主动调用：']
  for (const skill of mentionedSkills ?? []) {
    toolLines.push(`- Skill: ${skill}（请立即调用此 Skill）`)
  }
  for (const name of mentionedMcpServers ?? []) {
    const builtinPrompt = BUILTIN_MCP_PROMPTS[name]
    if (builtinPrompt) {
      toolLines.push(builtinPrompt)
    } else {
      toolLines.push(`- MCP 服务器: ${name}（请使用此 MCP 服务器的工具来完成任务）`)
    }
  }

  return `<mentioned_tools>\n${toolLines.join('\n')}\n</mentioned_tools>`
}
