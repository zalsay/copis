import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  FileApiContext,
  FileApiReadTextResponse,
  FileApiWriteTextRequest,
  FileApiWriteTextResponse,
  FileAccessOptions,
} from '@copis/shared'
import { getAgentSessionMeta } from './agent-session-manager'
import {
  getAgentWorkspace,
  getProjectFilesPath,
  getWorkspaceAttachedDirectories,
  getWorkspaceAttachedFiles,
} from './agent-workspace-manager'
import { getAgentWorkspacesDir } from './config-paths'
import { filterAttachedPaths } from './attached-paths'
import { isPathWithinAuthorizedRoots } from './file-access-policy'

const MAX_FILE_BYTES = 50 * 1024 * 1024

export class FileServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: 'invalid_request' | 'path_not_allowed' | 'path_not_found' | 'path_type_mismatch' | 'file_too_large' | 'write_conflict',
  ) {
    super(message)
    this.name = 'FileServiceError'
  }
}

export interface FileServiceRuntime {
  resolvePath: (filePath: string, basePaths?: string[]) => string | null
  isAllowed: (filePath: string, context?: FileAccessOptions) => boolean
  stat: (filePath: string) => { isFile: () => boolean; size: number; mtimeMs: number }
  read: (filePath: string) => string
  write: (filePath: string, content: string) => void
}

function normalizeContext(context: FileApiContext): FileAccessOptions {
  return {
    ...(typeof context.sessionId === 'string' ? { sessionId: context.sessionId } : {}),
    ...(typeof context.workspaceSlug === 'string' ? { workspaceSlug: context.workspaceSlug } : {}),
    ...(Array.isArray(context.candidateBasePaths)
      ? { candidateBasePaths: context.candidateBasePaths.filter((path): path is string => typeof path === 'string' && path.length > 0) }
      : {}),
  }
}

function requirePath(pathValue: string): string {
  if (typeof pathValue !== 'string' || !pathValue.trim()) {
    throw new FileServiceError('文件路径不正确', 400, 'invalid_request')
  }
  return pathValue
}

function getRevision(stat: { size: number; mtimeMs: number }): string {
  return `size:${stat.size};mtime:${Math.round(stat.mtimeMs * 1_000_000)}`
}

/** 文件 API 只在已授权候选根中解析相对路径，不复用预览模块的跨目录搜索。 */
function resolveFileApiPath(filePath: string, basePaths?: string[]): string | null {
  const candidates = isAbsolute(filePath)
    ? [resolve(filePath)]
    : [
      ...(basePaths?.map((basePath) => resolve(basePath, filePath)) ?? []),
      resolve(filePath),
    ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function resolveAuthorizedPath(
  inputPath: string,
  context: FileApiContext,
  runtime: FileServiceRuntime,
): { path: string; context: FileAccessOptions } {
  const filePath = requirePath(inputPath)
  const access = normalizeContext(context)
  const resolvedPath = runtime.resolvePath(filePath, access.candidateBasePaths)
  if (!resolvedPath) throw new FileServiceError('文件不存在', 404, 'path_not_found')
  if (!runtime.isAllowed(resolvedPath, access)) {
    throw new FileServiceError('访问路径超出当前会话授权范围', 403, 'path_not_allowed')
  }
  return { path: resolvedPath, context: access }
}

function readText(
  input: { path: string } & FileApiContext,
  runtime: FileServiceRuntime,
): FileApiReadTextResponse {
  const resolved = resolveAuthorizedPath(input.path, input, runtime)
  let metadata: ReturnType<FileServiceRuntime['stat']>
  try {
    metadata = runtime.stat(resolved.path)
  } catch {
    throw new FileServiceError('文件不存在', 404, 'path_not_found')
  }
  if (!metadata.isFile()) throw new FileServiceError('目标不是文件', 400, 'path_type_mismatch')
  if (metadata.size > MAX_FILE_BYTES) throw new FileServiceError('文件过大', 413, 'file_too_large')
  try {
    return {
      resolvedPath: resolved.path,
      content: runtime.read(resolved.path),
      revision: getRevision(metadata),
    }
  } catch {
    throw new FileServiceError('文件读取失败', 500, 'path_not_found')
  }
}

function writeText(input: FileApiWriteTextRequest, runtime: FileServiceRuntime): FileApiWriteTextResponse {
  if (typeof input.content !== 'string') throw new FileServiceError('文件内容不正确', 400, 'invalid_request')
  if (Buffer.byteLength(input.content, 'utf8') > MAX_FILE_BYTES) {
    throw new FileServiceError('文件内容过大', 413, 'file_too_large')
  }
  const resolved = resolveAuthorizedPath(input.path, input, runtime)
  let metadata: ReturnType<FileServiceRuntime['stat']>
  try {
    metadata = runtime.stat(resolved.path)
  } catch {
    throw new FileServiceError('文件不存在', 404, 'path_not_found')
  }
  if (!metadata.isFile()) throw new FileServiceError('目标不是文件', 400, 'path_type_mismatch')
  const currentRevision = getRevision(metadata)
  if (input.expectedRevision && input.expectedRevision !== currentRevision) {
    throw new FileServiceError('文件已被外部修改，请重新加载后再保存', 409, 'write_conflict')
  }
  try {
    runtime.write(resolved.path, input.content)
    const nextMetadata = runtime.stat(resolved.path)
    return { resolvedPath: resolved.path, revision: getRevision(nextMetadata) }
  } catch {
    throw new FileServiceError('文件写入失败', 500, 'path_not_found')
  }
}

export function createFileService(runtime: FileServiceRuntime): {
  readText: (input: { path: string } & FileApiContext) => FileApiReadTextResponse
  writeText: (input: FileApiWriteTextRequest) => FileApiWriteTextResponse
} {
  return {
    readText: (input) => readText(input, runtime),
    writeText: (input) => writeText(input, runtime),
  }
}

function getAuthorizedRoots(context?: FileAccessOptions): string[] {
  const roots = [getAgentWorkspacesDir(), join(tmpdir(), 'copis-preview')]
  const workspaceSlugs = new Set<string>()

  if (context?.sessionId) {
    const meta = getAgentSessionMeta(context.sessionId)
    if (meta?.attachedDirectories) roots.push(...filterAttachedPaths(meta.attachedDirectories))
    if (meta?.attachedFiles) roots.push(...filterAttachedPaths(meta.attachedFiles))
    if (meta?.workspaceId) {
      const workspace = getAgentWorkspace(meta.workspaceId)
      if (workspace?.slug) workspaceSlugs.add(workspace.slug)
    }
  }
  if (context?.workspaceSlug) workspaceSlugs.add(context.workspaceSlug)

  for (const slug of workspaceSlugs) {
    roots.push(getProjectFilesPath(slug))
    roots.push(...getWorkspaceAttachedDirectories(slug))
    roots.push(...getWorkspaceAttachedFiles(slug))
  }
  return roots
}

const defaultFileService = createFileService({
  resolvePath: resolveFileApiPath,
  isAllowed: (filePath, context) => isPathWithinAuthorizedRoots(filePath, getAuthorizedRoots(context)),
  stat: (filePath) => statSync(filePath),
  read: (filePath) => readFileSync(filePath, 'utf8'),
  write: (filePath, content) => writeFileSync(filePath, content, 'utf8'),
})

export const fileService = defaultFileService
