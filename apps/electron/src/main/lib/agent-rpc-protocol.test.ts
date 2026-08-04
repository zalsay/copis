import { describe, expect, test } from 'bun:test'
import {
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
        },
      },
    }

    const frame = serializeWorkerCommand(command)

    expect(frame.endsWith('\n')).toBe(true)
    expect(JSON.parse(frame)).toEqual(command)
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

  test('Given one SSE data frame When parsed Then restores the worker frame JSON', () => {
    expect(parseAgentSseData('data: {"type":"error","sessionId":"s1","error":"失败"}\n\n')).toEqual({
      type: 'error',
      sessionId: 's1',
      error: '失败',
    })
  })
})
