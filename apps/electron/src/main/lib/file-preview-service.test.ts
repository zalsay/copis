import { describe, expect, test, afterEach } from 'bun:test'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolveTargetPath } from './file-preview-service'

describe('文件预览服务路径解析与生图自愈 (file-preview-service)', () => {
  const sessionId = '11112222-3333-4444-5555-666677778888'
  const mockHome = homedir()
  const copisDevDir = join(mockHome, '.copis-dev')
  const attachmentDir = join(copisDevDir, 'attachments', sessionId)
  const sessionJsonlDir = join(copisDevDir, 'agent-sessions')
  const workspaceDir = join(copisDevDir, 'agent-workspaces', 'default', sessionId)

  afterEach(() => {
    if (existsSync(attachmentDir)) {
      rmSync(attachmentDir, { recursive: true, force: true })
    }
    const jsonlFile = join(sessionJsonlDir, `${sessionId}.jsonl`)
    if (existsSync(jsonlFile)) {
      rmSync(jsonlFile, { force: true })
    }
    if (existsSync(workspaceDir)) {
      rmSync(workspaceDir, { recursive: true, force: true })
    }
  })

  test('Given 工作区不存在生图但 jsonl 中有 generated_images 映射 When resolveTargetPath Then 自愈拷贝至工作区', () => {
    mkdirSync(attachmentDir, { recursive: true })
    mkdirSync(sessionJsonlDir, { recursive: true })
    mkdirSync(workspaceDir, { recursive: true })

    const targetFileName = 'copis-image-abcdef12.png'
    const actualAttachmentFile = 'uuid-image-1234.png'
    const attachFilePath = join(attachmentDir, actualAttachmentFile)
    writeFileSync(attachFilePath, 'fake-png-content', 'utf-8')

    const jsonlContent = JSON.stringify({
      role: 'assistant',
      content: `<generated_images>[{"filename":"${targetFileName}","path":"${sessionId}/${actualAttachmentFile}"}]</generated_images>`,
    }) + '\n'
    writeFileSync(join(sessionJsonlDir, `${sessionId}.jsonl`), jsonlContent, 'utf-8')

    const targetWorkspacePath = join(workspaceDir, targetFileName)
    expect(existsSync(targetWorkspacePath)).toBe(false)

    const resolved = resolveTargetPath(targetWorkspacePath, [workspaceDir])
    expect(resolved).toBe(targetWorkspacePath)
    // 验证自愈机制：文件是否已被拷贝到工作区
    expect(existsSync(targetWorkspacePath)).toBe(true)
    expect(readFileSync(targetWorkspacePath, 'utf-8')).toBe('fake-png-content')
  })

  test('Given attachments 目录下只有一个匹配扩展名的文件 When 目标名为 copis-image-*.png Then 成功回退命中并自愈', () => {
    mkdirSync(attachmentDir, { recursive: true })
    mkdirSync(workspaceDir, { recursive: true })

    const targetFileName = 'copis-image-fallback.png'
    const actualAttachmentFile = 'only-image.png'
    const attachFilePath = join(attachmentDir, actualAttachmentFile)
    writeFileSync(attachFilePath, 'fallback-png-data', 'utf-8')

    const targetWorkspacePath = join(workspaceDir, targetFileName)
    const resolved = resolveTargetPath(targetWorkspacePath, [workspaceDir])
    expect(resolved).toBe(targetWorkspacePath)
    expect(existsSync(targetWorkspacePath)).toBe(true)
    expect(readFileSync(targetWorkspacePath, 'utf-8')).toBe('fallback-png-data')
  })

  test('Given 相对路径直接为 attachments 格式 {sessionId}/{filename} When resolveTargetPath Then 成功解析', () => {
    mkdirSync(attachmentDir, { recursive: true })
    const filename = 'direct.png'
    const filePath = join(attachmentDir, filename)
    writeFileSync(filePath, 'direct-content', 'utf-8')

    const relativeAttach = `${sessionId}/${filename}`
    const resolved = resolveTargetPath(relativeAttach)
    expect(resolved).toBe(filePath)
  })
})
