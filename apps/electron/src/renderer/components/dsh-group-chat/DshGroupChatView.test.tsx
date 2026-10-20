import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('DshGroupChatView 契约与零交叉测试', () => {
  const dir = __dirname

  it('should have ZERO intersection with any chatroom modules or files', () => {
    const files = [
      'DshGroupChatView.tsx',
      'DshGroupChatSidebar.tsx',
      'DshGroupChatWorkspace.tsx',
      'DshGroupChatTasksPanel.tsx',
      'DshGroupChatInvocationDetail.tsx',
      'DshGroupChatCreateDialog.tsx',
    ]

    for (const file of files) {
      const content = readFileSync(join(dir, file), 'utf-8')
      // 严禁导入 chatroom 相关的任何模块或包含 chatroom 相关的变量
      expect(content).not.toContain('@/atoms/chatroom-atoms')
      expect(content).not.toContain('@/components/chatroom')
      expect(content).not.toContain('window.electronAPI.chatrooms')
      expect(content).not.toContain('CHATROOM_IPC_CHANNELS')
    }
  })

  it('should verify DshGroupChatView renders sidebar, workspace and drawers properly', () => {
    const content = readFileSync(join(dir, 'DshGroupChatView.tsx'), 'utf-8')
    expect(content).toContain('<DshGroupChatSidebar />')
    expect(content).toContain('<DshGroupChatWorkspace onClose={onClose} />')
    expect(content).toContain("<DshGroupChatTasksPanel />")
    expect(content).toContain("<DshGroupChatInvocationDetail />")
    expect(content).toContain("<DshGroupChatCreateDialog />")
  })

  it('should verify CopisCreationWebView integrates group-chat in subview routing', () => {
    const creationViewContent = readFileSync(
      join(dir, '../creation/CopisCreationWebView.tsx'),
      'utf-8'
    )
    expect(creationViewContent).toContain("| 'group-chat'")
    expect(creationViewContent).toContain("<DshGroupChatView onClose={closeSubView} />")
  })

  it('should verify DshGroupChatWorkspace implements @ mention suggestions and keyboard navigation', () => {
    const workspaceContent = readFileSync(join(dir, 'DshGroupChatWorkspace.tsx'), 'utf-8')
    expect(workspaceContent).toContain('mentionSuggestions')
    expect(workspaceContent).toContain('mentionMatch')
    expect(workspaceContent).toContain('selectMention')
    expect(workspaceContent).toContain('handleAtButtonClick')
    expect(workspaceContent).toContain('role="listbox"')
    expect(workspaceContent).toContain('role="option"')
    expect(workspaceContent).toContain('onCompositionStart')
    expect(workspaceContent).toContain('onCompositionEnd')
  })
})
