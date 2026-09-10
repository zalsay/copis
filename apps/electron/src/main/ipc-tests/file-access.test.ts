import { afterAll, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'copis-ipc-access-'))
const allowed = join(root, 'allowed')
const outside = join(root, 'outside')
mkdirSync(allowed)
mkdirSync(outside)
const allowedFile = join(allowed, 'file.txt')
const outsideFile = join(outside, 'file.txt')
writeFileSync(allowedFile, 'allowed')
writeFileSync(outsideFile, 'outside')
symlinkSync(outside, join(allowed, 'escape'), 'dir')

mock.module('../lib/config-paths', () => ({
  getAgentWorkspacesDir: () => allowed,
  getAttachmentsDir: () => join(root, 'attachments'),
}))
mock.module('../lib/agent-session-manager', () => ({
  getAgentSessionMeta: (id: string) => id === 'attached'
    ? { attachedFiles: [outsideFile], attachedDirectories: [] }
    : undefined,
}))
mock.module('../lib/agent-workspace-manager', () => ({
  getAgentWorkspace: () => undefined,
  getAgentWorkspaceBySlug: () => undefined,
  getAgentWorkspaceReadableRoots: () => [],
  getProjectFilesPath: (slug: string) => join(root, slug),
  getWorkspaceAttachedDirectories: () => [],
  getWorkspaceAttachedFiles: () => [],
  getWorktreeRepos: async () => [],
}))

const access = await import('../lib/ipc-file-access')
afterAll(() => rmSync(root, { recursive: true, force: true }))

test('Given 授权目录 When 访问真实文件或越界符号链接 Then 仅真实授权文件可访问', () => {
  expect(access.ensurePathAllowed(allowedFile)).toBe(true)
  expect(access.ensurePathAllowed(outsideFile)).toBe(false)
  expect(access.ensurePathAllowed(join(allowed, 'escape', 'file.txt'))).toBe(false)
  expect(access.ensurePathAllowed(join(allowed, 'missing.txt'))).toBe(false)
})

test('Given 渲染进程提供候选目录 When 校验访问权限 Then 候选目录本身不构成授权', () => {
  const options = { candidateBasePaths: [allowed, outside] }
  expect(access.ensurePathAllowed(outsideFile, options)).toBe(false)
  expect(access.getAllowedCandidateBasePaths(options)).toEqual([allowed])
  expect(access.getPreviewCandidateBasePaths(options)).toEqual([allowed, outside])
  expect(access.normalizeFileAccessOptions([outside])).toBeUndefined()
})

test('Given 会话明确附加文件 When 访问该文件 Then 使用持久化会话授权', () => {
  expect(access.ensurePathAllowed(outsideFile, { sessionId: 'attached' })).toBe(true)
  expect(access.ensurePathAllowed(outside, { sessionId: 'attached' })).toBe(false)
})

test('Given 授权仓库的外部 worktree When 校验 Git 路径 Then 放行关联 worktree 并拒绝其他仓库', async () => {
  const repo = join(allowed, 'repo')
  const worktree = join(root, 'worktree')
  const unrelated = join(outside, 'repo')
  const git = (args: string[]) => execFileSync('git', args, { stdio: 'pipe' })
  git(['init', repo])
  git(['-C', repo, '-c', 'user.name=IPC Test', '-c', 'user.email=ipc@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'])
  git(['-C', repo, 'worktree', 'add', '--detach', worktree])
  git(['init', unrelated])
  expect(access.isPathAllowed(worktree)).toBe(false)
  expect(await access.ensurePathAllowedWithWorktree(worktree)).toBe(true)
  expect(await access.ensurePathAllowedWithWorktree(unrelated)).toBe(false)
})
