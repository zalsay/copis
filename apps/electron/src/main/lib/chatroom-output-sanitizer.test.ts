import { expect, test } from 'bun:test'
import { parseAndSanitizeChatRoomAgentOutput, sanitizeChatRoomText, type ChatRoomOutputSanitizerContext } from './chatroom-output-sanitizer'

const context: ChatRoomOutputSanitizerContext = {
  executionRoots: ['/tmp/chatroom/runtime', '/tmp/chatroom/runtime/project'],
  sensitiveValues: ['secret-token', 'token'],
  allowedAgentIds: ['agent-b', 'agent-c'],
  allowedAttachmentIds: ['att-1'],
}

test('Given 合法 JSON 输出 When 解析 Then 保留结构化 mention 和附件 ID', () => {
  expect(parseAndSanitizeChatRoomAgentOutput(
    '{"text":"请 Agent B 继续","mentionedAgentIds":["agent-b"],"attachmentIds":["att-1"]}',
    context,
  )).toEqual({ text: '请 Agent B 继续', mentionedAgentIds: ['agent-b'], attachmentIds: ['att-1'] })
})

test('Given 普通文本包含 @Agent B When 解析 Then 不产生结构化 mention', () => {
  expect(parseAndSanitizeChatRoomAgentOutput('请 @Agent B 继续', context).mentionedAgentIds).toEqual([])
})

test('Given 输出含绝对路径、环境值和 token When 清理 Then 不把敏感内容发送到 Rust', () => {
  const result = parseAndSanitizeChatRoomAgentOutput(JSON.stringify({
    text: '文件在 /tmp/chatroom/runtime/project/secret.txt，TOKEN=secret-token',
    mentionedAgentIds: [],
    attachmentIds: [],
  }), context)
  expect(result.text).toBe('文件在 [本地路径已隐藏]/secret.txt，TOKEN=[敏感信息已隐藏]')
})

test('Given mention 不属于当前房间或 attachment 未显式允许 When 清理 Then 丢弃对应 ID 并去重', () => {
  const result = parseAndSanitizeChatRoomAgentOutput(JSON.stringify({
    text: 'done', mentionedAgentIds: ['agent-b', 'agent-b', 'agent-c'], attachmentIds: ['att-x', 'att-1', 'att-1'],
  }), context)
  expect(result.mentionedAgentIds).toEqual(['agent-b', 'agent-c'])
  expect(result.attachmentIds).toEqual(['att-1'])
})

test('Given JSON 后有尾随文本或多个 JSON When 解析 Then 使用 plain-text fallback 且不扫描 @', () => {
  for (const raw of [
    '{"text":"ok","mentionedAgentIds":["agent-b"],"attachmentIds":[]} tail',
    '{"text":"one","mentionedAgentIds":[],"attachmentIds":{}} {"text":"two","mentionedAgentIds":[],"attachmentIds":[]}',
    '[{"text":"ok","mentionedAgentIds":["agent-b"],"attachmentIds":[]}]',
    '{malformed @Agent B}',
  ]) {
    const result = parseAndSanitizeChatRoomAgentOutput(raw, context)
    expect(result.mentionedAgentIds).toEqual([])
    expect(result.attachmentIds).toEqual([])
    expect(result.text).toContain(raw.replaceAll('\r\n', '\n'))
  }
})

test('Given ANSI/C0/C1 和 CRLF When 清理 Then 仅保留换行制表符', () => {
  const result = parseAndSanitizeChatRoomAgentOutput('a\r\nb\u001b[31m red\u001b[0m\u0000\u0085\tend', context)
  expect(result.text).toBe('a\nb red\tend')
})

test('Given overlapping roots and secrets When 清理 Then 不泄漏任一子串', () => {
  const result = parseAndSanitizeChatRoomAgentOutput(
    '/tmp/chatroom/runtime/project/file secret-token token /tmp/chatroom/runtime',
    context,
  )
  expect(result.text).toBe('[本地路径已隐藏]/file [敏感信息已隐藏] [敏感信息已隐藏] [本地路径已隐藏]')
  expect(result.text).not.toContain('/tmp/chatroom')
  expect(result.text).not.toContain('secret-token')
})

test('Given generic POSIX 和 Windows 绝对路径 When 清理 Then 均隐藏路径', () => {
  const result = parseAndSanitizeChatRoomAgentOutput('/home/user/private.txt 与 /Users/张三/秘密.txt 与 C:\\Program Files\\secret.txt', context)
  expect(result.text).toBe('[本地路径已隐藏] 与 [本地路径已隐藏] 与 [本地路径已隐藏]')
})

test('Given 路径被引号或成对分隔符包裹 When 清理 Then 仅替换完整路径并保留外围符号', () => {
  const result = parseAndSanitizeChatRoomAgentOutput(
    '"/home/user/file.txt" \'/Users/张三/秘密.txt\' [C:\\Users\\Alice\\secret.txt] (/Users/张三/秘密.txt) (C:\\Users\\Alice\\secret.txt) {C:\\Users\\Alice\\secret.txt}, /home/user/file.txt.',
    context,
  )
  expect(result.text).toBe(
    '"[本地路径已隐藏]" \'[本地路径已隐藏]\' [[本地路径已隐藏]] ([本地路径已隐藏]) ([本地路径已隐藏]) {[本地路径已隐藏]}, [本地路径已隐藏].',
  )
  expect(result.text).not.toContain('/home/user/file.txt')
  expect(result.text).not.toContain('/Users/张三/秘密.txt')
  expect(result.text).not.toContain('C:\\Users\\Alice\\secret.txt')
})

test('Given 网络 URL 或 file URI When 清理 Then 不误伤 URL 且不泄漏 file 本地路径', () => {
  expect(parseAndSanitizeChatRoomAgentOutput('https://example.com/path', context).text).toBe('https://example.com/path')
  const fileUri = parseAndSanitizeChatRoomAgentOutput('file:///home/user/a.txt', context).text
  expect(fileUri).toBe('file://[本地路径已隐藏]')
  expect(fileUri).not.toContain('/home/user/a.txt')
})

test('Given 清理后只剩换行和制表符 When 上报 Then 使用非空安全占位', () => {
  expect(parseAndSanitizeChatRoomAgentOutput('\n\t\n', context).text).toBe('[内容已清理]')
})

test('Given secret 完整包含 execution root When 清理 Then 不泄漏 secret 的任一子串', () => {
  const secretContext = { ...context, executionRoots: ['/tmp/chatroom/runtime'], sensitiveValues: ['/tmp/chatroom/runtime/credential.txt'] }
  const result = parseAndSanitizeChatRoomAgentOutput('/tmp/chatroom/runtime/credential.txt', secretContext)
  expect(result.text).toBe('[敏感信息已隐藏]')
  expect(result.text).not.toContain('/tmp/chatroom/runtime')
  expect(result.text).not.toContain('credential.txt')
})

test('Given text 含 unpaired surrogate When 清理 Then 拒绝无效 UTF-8', () => {
  const result = parseAndSanitizeChatRoomAgentOutput('\uD800', context)
  expect(result.text).toBe('[内容已清理]')
  expect(result.text).not.toContain('\uFFFD')
})

test('Given 输出超过 64 KiB UTF-8 边界 When 清理 Then 截断不破坏字符', () => {
  const result = parseAndSanitizeChatRoomAgentOutput(JSON.stringify({
    text: '界'.repeat(40_000), mentionedAgentIds: [], attachmentIds: [],
  }), context)
  expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(64 * 1024)
  expect(result.text).not.toContain('\uFFFD')
})

test('Given 清理后为空 When 清理 Then 返回固定安全占位', () => {
  expect(parseAndSanitizeChatRoomAgentOutput('\u0000\u001b[31m\u001b[0m', context).text).toBe('[内容已清理]')
  expect(parseAndSanitizeChatRoomAgentOutput('{"text":"","mentionedAgentIds":[],"attachmentIds":[]}', context).text).toBe('[内容已清理]')
})

test('Given 增量含路径、secret、surrogate 或超长 UTF-8 When sanitizeChatRoomText Then 固定清理并按字节截断', () => {
  const value = sanitizeChatRoomText(`/Users/private/project token-secret ${'界'.repeat(20_000)}`, {
    ...context,
    sensitiveValues: ['token-secret'],
  })
  expect(value).not.toContain('/Users/private/project')
  expect(value).not.toContain('token-secret')
  expect(new TextEncoder().encode(value).byteLength).toBeLessThanOrEqual(16 * 1024)
  expect(sanitizeChatRoomText('bad\uD800', context)).toBe('[内容已清理]')
})
