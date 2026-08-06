import { describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionMeta, AgentWorkspace, SDKMessage } from '@copis/shared'

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/copis-agent-rewind-test',
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  shell: { openExternal: async () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}))

const { AgentSessionRewindService } = await import('./agent-session-rewind-service')
type AgentSessionRewindDependencies = import('./agent-session-rewind-service').AgentSessionRewindDependencies

function createSession(id: string, workspaceId?: string): AgentSessionMeta {
  return {
    id,
    title: id,
    sdkSessionId: `${id}-sdk`,
    agentRuntime: 'pi',
    workspaceId,
    createdAt: 1,
    updatedAt: 1,
  }
}

function createWorkspace(id: string, projectRootPath: string): AgentWorkspace {
  return {
    id,
    name: id,
    slug: id,
    projectRootPath,
    createdAt: 1,
    updatedAt: 1,
  }
}

interface ServiceFixture {
  session: AgentSessionMeta
  sessions?: AgentSessionMeta[]
  workspaces?: AgentWorkspace[]
  rewindPiAgentSession?: (sessionId: string, assistantMessageUuid: string) => Promise<void>
  truncateSDKMessages?: (sessionId: string, assistantMessageUuid: string) => SDKMessage[]
}

function createService(fixture: ServiceFixture): InstanceType<typeof AgentSessionRewindService> {
  const workspaces = new Map((fixture.workspaces ?? []).map((workspace) => [workspace.id, workspace]))
  const dependencies: AgentSessionRewindDependencies = {
    getAgentSessionMeta: (sessionId) => sessionId === fixture.session.id ? fixture.session : undefined,
    listAgentSessions: () => fixture.sessions ?? [fixture.session],
    getAgentWorkspace: (workspaceId) => workspaces.get(workspaceId),
    getLocalProjectRootStatus: () => 'available',
    rewindPiAgentSession: fixture.rewindPiAgentSession ?? (async () => {}),
    truncateSDKMessages: fixture.truncateSDKMessages ?? (() => []),
  }
  return new AgentSessionRewindService(dependencies)
}

describe('Agent 会话回退服务', () => {
  test('Given 目标会话正在运行 When 回退 Then 拒绝且不修改 artifact 或 JSONL', async () => {
    let artifactRewound = false
    let jsonlTruncated = false
    const session = createSession('running-session')
    const service = createService({
      session,
      rewindPiAgentSession: async () => { artifactRewound = true },
      truncateSDKMessages: () => {
        jsonlTruncated = true
        return []
      },
    })

    await expect(service.rewind(session.id, 'assistant-1', {
      isSessionActive: (sessionId) => sessionId === session.id,
    })).rejects.toThrow('会话正在运行中，请停止后再回退')

    expect(artifactRewound).toBe(false)
    expect(jsonlTruncated).toBe(false)
  })

  test('Given 同一项目根的其他会话正在运行 When 回退 Then 拒绝且不修改持久化历史', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'copis-rewind-project-'))
    const target = createSession('target-session', 'workspace-a')
    const active = createSession('active-session', 'workspace-b')
    let artifactRewound = false
    let jsonlTruncated = false
    const service = createService({
      session: target,
      sessions: [target, active],
      workspaces: [
        createWorkspace('workspace-a', projectRoot),
        createWorkspace('workspace-b', projectRoot),
      ],
      rewindPiAgentSession: async () => { artifactRewound = true },
      truncateSDKMessages: () => {
        jsonlTruncated = true
        return []
      },
    })

    try {
      await expect(service.rewind(target.id, 'assistant-1', {
        isSessionActive: (sessionId) => sessionId === active.id,
      })).rejects.toThrow('同一项目的其他会话正在运行')

      expect(artifactRewound).toBe(false)
      expect(jsonlTruncated).toBe(false)
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('Given 空闲 Pi 会话 When artifact 回退成功 Then 再截断 JSONL 并返回既有结果结构', async () => {
    const session = createSession('idle-session')
    const calls: string[] = []
    const service = createService({
      session,
      rewindPiAgentSession: async (sessionId, messageUuid) => {
        calls.push(`artifact:${sessionId}:${messageUuid}`)
      },
      truncateSDKMessages: (sessionId, messageUuid) => {
        calls.push(`jsonl:${sessionId}:${messageUuid}`)
        return []
      },
    })

    const result = await service.rewind(session.id, 'assistant-1', {
      isSessionActive: () => false,
    })

    expect(calls).toEqual([
      'artifact:idle-session:assistant-1',
      'jsonl:idle-session:assistant-1',
    ])
    expect(result).toEqual({
      remainingMessages: 0,
      fileRewind: {
        canRewind: false,
        error: '已回退 Pi 对话；Pi 文件回退尚未启用，当前未修改任何文件。',
      },
    })
  })

  test('Given Pi artifact 回退失败 When 回退 Then 保留原 JSONL 历史', async () => {
    const session = createSession('artifact-failed-session')
    let jsonlTruncated = false
    const service = createService({
      session,
      rewindPiAgentSession: async () => {
        throw new Error('Pi artifact 写入失败')
      },
      truncateSDKMessages: () => {
        jsonlTruncated = true
        return []
      },
    })

    await expect(service.rewind(session.id, 'assistant-1', {
      isSessionActive: () => false,
    })).rejects.toThrow('Pi artifact 写入失败')

    expect(jsonlTruncated).toBe(false)
  })

  test('Given 本地项目根不可用 When 回退 Then 在 artifact 回退前返回现有根目录错误', async () => {
    const unavailableProjectRoot = join(tmpdir(), 'copis-rewind-missing-project')
    const session = createSession('unavailable-root-session', 'workspace-a')
    let artifactRewound = false
    const service = new AgentSessionRewindService({
      getAgentSessionMeta: () => session,
      listAgentSessions: () => [session],
      getAgentWorkspace: () => createWorkspace('workspace-a', unavailableProjectRoot),
      getLocalProjectRootStatus: () => 'missing',
      rewindPiAgentSession: async () => { artifactRewound = true },
      truncateSDKMessages: () => [],
    })

    await expect(service.rewind(session.id, 'assistant-1', {
      isSessionActive: () => false,
    })).rejects.toThrow('本地项目根目录不可用')
    expect(artifactRewound).toBe(false)
  })
})
