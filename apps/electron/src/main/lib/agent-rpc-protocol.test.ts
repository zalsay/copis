import { describe, expect, test } from 'bun:test'
import {
  parseBrowserAgentToolRequest,
  parseAgentSseData,
  parseWorkerCommand,
  parseWorkerFrame,
  serializeWorkerCommand,
  type AgentRpcWorkerCommand,
} from './agent-rpc-protocol'

describe('Agent RPC 协议', () => {
  test('Given run command When serialized Then remains one JSONL frame', () => {
    const command: AgentRpcWorkerCommand = {
      type: 'run',
      requestId: 'request-1',
      config: {
        sessionId: 'session-1',
        query: {
          sessionId: 'session-1',
          prompt: '你好',
          model: 'model-1',
          cwd: '/tmp/project',
          apiKey: 'secret',
          provider: 'openai',
          permissionMode: 'bypassPermissions',
          systemPrompt: 'Copis Agent',
          piAgentDir: '/tmp/.copis/sdk-config',
          piSessionDir: '/tmp/.copis/sdk-config/sessions',
          skillMentions: ['automation'],
        },
      },
    }

    const frame = serializeWorkerCommand(command)

    expect(frame.endsWith('\n')).toBe(true)
    expect(JSON.parse(frame)).toEqual(command)
    expect((JSON.parse(frame) as { config: { query: { skillMentions?: string[] } } }).config.query.skillMentions).toEqual(['automation'])
  })

  test('Given Browser capability When serialized in a run Then keeps only the opaque endpoint and token', () => {
    const command: AgentRpcWorkerCommand = {
      type: 'run',
      requestId: 'request-browser-1',
      config: {
        sessionId: 'session-1',
        query: {
          sessionId: 'session-1',
          prompt: '观察当前页面',
          apiKey: 'secret',
          provider: 'openai',
          permissionMode: 'bypassPermissions',
          systemPrompt: 'Browser Agent',
          piAgentDir: '/tmp/.copis/sdk-config',
          piSessionDir: '/tmp/.copis/sdk-config/sessions',
          browserPageControl: {
            endpoint: '/api/internal/agent/browser-tool',
            token: 'opaque-capability',
          },
        },
      },
    }

    expect(parseWorkerCommand(serializeWorkerCommand(command))).toEqual(command)
  })

  test('Given system prompt 含专家团队受管控协议 When serialized Then worker 帧只透传提示词文本，不携带原始上下文字段', () => {
    const command: AgentRpcWorkerCommand = {
      type: 'run',
      requestId: 'request-expert-team-1',
      config: {
        sessionId: 'session-1',
        query: {
          sessionId: 'session-1',
          prompt: '执行专家节点任务',
          apiKey: 'secret',
          provider: 'openai',
          permissionMode: 'bypassPermissions',
          systemPrompt: '# Copis Agent\n\n<copis_expert_team_agents_md>\n<!-- copis-expert-team:start -->\n## 专家团队协议\n<!-- copis-expert-team:end -->\n</copis_expert_team_agents_md>\n\n<copis_expert_team_schema>\n[{"id":"researcher"}]\n</copis_expert_team_schema>',
          piAgentDir: '/tmp/.copis/sdk-config',
          piSessionDir: '/tmp/.copis/sdk-config/sessions',
        },
      },
    }

    const parsed = parseWorkerCommand(serializeWorkerCommand(command))
    expect(parsed).toEqual(command)
    const rawQuery = (parsed as unknown as { config: { query: Record<string, unknown> } }).config.query
    expect(rawQuery.systemPrompt).toContain('<copis_expert_team_agents_md>')
    expect('expertTeamContext' in rawQuery).toBe(false)
  })

  test('Given run command with mismatched outer and query sessions When parsed Then rejects the command', () => {
    expect(parseWorkerCommand(JSON.stringify({
      type: 'run',
      requestId: 'request-session-mismatch',
      config: {
        sessionId: 'outer-session',
        query: {
          sessionId: 'query-session',
          prompt: '观察当前页面',
          apiKey: 'secret',
          provider: 'openai',
          permissionMode: 'bypassPermissions',
          systemPrompt: 'Browser Agent',
          piAgentDir: '/tmp/.copis/sdk-config',
          piSessionDir: '/tmp/.copis/sdk-config/sessions',
        },
      },
    }))).toBeUndefined()
  })

  test('Given Browser tool request When parsed Then accepts only the fixed high-level tool allowlist', () => {
    expect(parseBrowserAgentToolRequest({
      sessionId: 'session-1',
      capabilityToken: 'token-1',
      toolCallId: 'call-1',
      toolName: 'BrowserPageObserve',
      toolInput: {},
    })).toEqual({
      sessionId: 'session-1',
      capabilityToken: 'token-1',
      toolCallId: 'call-1',
      toolName: 'BrowserPageObserve',
      toolInput: {},
    })

    expect(parseBrowserAgentToolRequest({
      sessionId: 'session-1',
      capabilityToken: 'token-1',
      toolCallId: 'call-1',
      toolName: 'Runtime.evaluate',
      toolInput: { expression: 'document.cookie' },
    })).toBeUndefined()
  })

  test('Given malformed Browser tool request When parsed Then rejects non-plain inputs and malformed capability', () => {
    expect(parseBrowserAgentToolRequest({
      sessionId: 'session-1',
      capabilityToken: 'token-1',
      toolCallId: 'call-1',
      toolName: 'BrowserPageObserve',
      toolInput: [],
    })).toBeUndefined()
    expect(parseBrowserAgentToolRequest({
      sessionId: 'session-1',
      capabilityToken: 'token-1',
      toolCallId: 'call-1',
      toolName: 'BrowserPageObserve',
      toolInput: {},
      browserPageControl: { endpoint: '/api/internal/agent/browser-tool', token: 'leak' },
    })).toBeUndefined()
  })

  test('Given worker JSONL When parsed Then accepts event and complete frames only as objects', () => {
    const event = parseWorkerFrame('{"type":"event","sessionId":"s1","payload":{"kind":"sdk_message"}}')
    const complete = parseWorkerFrame('{"type":"complete","sessionId":"s1","sdkMessages":[]}')

    expect(event?.type).toBe('event')
    expect(complete?.type).toBe('complete')
    expect(parseWorkerFrame('[]')).toBeUndefined()
    expect(parseWorkerFrame('not-json')).toBeUndefined()
  })

  test('Given stop command JSONL When parsed Then keeps the session identifier', () => {
    expect(parseWorkerCommand('{"type":"stop","sessionId":"session-1"}')).toEqual({
      type: 'stop',
      sessionId: 'session-1',
    })
    expect(parseWorkerCommand('{"type":"stop"}')).toBeUndefined()
  })

  test('Given Rust permission control command When parsed Then only accepts supported modes', () => {
    expect(parseWorkerCommand('{"type":"set_permission_mode","sessionId":"session-1","mode":"plan"}')).toEqual({
      type: 'set_permission_mode',
      sessionId: 'session-1',
      mode: 'plan',
    })
    expect(parseWorkerCommand('{"type":"set_permission_mode","sessionId":"session-1","mode":"allow-all"}')).toBeUndefined()
  })

  test('Given queue command When parsed Then preserves the worker queue payload', () => {
    const command: AgentRpcWorkerCommand = {
      type: 'queue',
      requestId: 'queue-1',
      config: {
        sessionId: 'session-1',
        userMessage: '继续使用 automation',
        uuid: 'message-1',
        interrupt: true,
        skillMentions: ['automation'],
      },
    }

    expect(parseWorkerCommand(serializeWorkerCommand(command))).toEqual(command)
    expect(parseWorkerCommand('{"type":"queue","requestId":"queue-1","config":{"sessionId":"session-1","userMessage":"继续","uuid":42}}')).toBeUndefined()
  })

  test('Given one SSE data frame When parsed Then restores the worker frame JSON', () => {
    expect(parseAgentSseData('data: {"type":"error","sessionId":"s1","error":"失败"}\n\n')).toEqual({
      type: 'error',
      sessionId: 's1',
      error: '失败',
    })
  })
})
