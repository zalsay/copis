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
    toolLines.push(`- MCP 服务器: ${name}（请使用此 MCP 服务器的工具来完成任务）`)
  }

  return `<mentioned_tools>\n${toolLines.join('\n')}\n</mentioned_tools>`
}
