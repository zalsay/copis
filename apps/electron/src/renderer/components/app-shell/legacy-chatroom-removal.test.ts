import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const rendererRoot = join(import.meta.dir, '../..')
const readRendererFile = (path: string): string => readFileSync(join(rendererRoot, path), 'utf8')

describe('旧聊天室 renderer 入口移除', () => {
  test('Given Copis Working 与标签栏初始化 When 加载 renderer Then 不再连接旧聊天室入口且创造模式群聊仍可用', () => {
    const sidebar = readRendererFile('components/app-shell/CopisWorkingSidebar.tsx')
    const tabAtoms = readRendererFile('atoms/tab-atoms.ts')
    const tabBarItem = readRendererFile('components/tabs/TabBarItem.tsx')
    const tabContent = readRendererFile('components/tabs/TabContent.tsx')
    const shortcuts = readRendererFile('components/shortcuts/GlobalShortcuts.tsx')
    const tabSideEffects = readRendererFile('hooks/useSyncActiveTabSideEffects.ts')
    const agentListeners = readRendererFile('hooks/useGlobalAgentListeners.ts')
    const initializer = readRendererFile('main.tsx')
    const creationWebView = readRendererFile('components/creation/CopisCreationWebView.tsx')

    expect(sidebar).not.toContain('chatroom-atoms')
    expect(sidebar).not.toContain('ChatroomCreateDialog')
    expect(sidebar).not.toContain('ChatroomJoinDialog')
    expect(sidebar).not.toContain('ChatroomSidebarRow')
    expect(tabAtoms).not.toContain("type: 'chatroom'")
    expect(tabAtoms).not.toContain('openChatRoomTab')
    expect(tabAtoms).not.toContain('closeChatRoomTab')
    expect(tabBarItem).not.toContain("| 'chatroom'")
    expect(tabContent).not.toContain('components/chatroom/')
    expect(shortcuts).not.toContain("type === 'chatroom'")
    expect(tabSideEffects).not.toContain("type === 'chatroom'")
    expect(agentListeners).not.toContain("type !== 'chatroom'")
    expect(initializer).not.toContain('ChatroomSseInitializer')
    expect(creationWebView).toContain("@/components/dsh-group-chat/DshGroupChatView")
    expect(existsSync(join(rendererRoot, 'components/chatroom'))).toBe(false)
    expect(existsSync(join(rendererRoot, 'atoms/chatroom-atoms.ts'))).toBe(false)
    expect(existsSync(join(rendererRoot, 'lib/chatroom-api.ts'))).toBe(false)
    expect(existsSync(join(rendererRoot, 'lib/chatroom-sse.ts'))).toBe(false)
    expect(existsSync(join(rendererRoot, 'lib/chatroom-delta-frames.ts'))).toBe(false)
  })
})
