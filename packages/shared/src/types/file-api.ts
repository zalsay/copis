import type { FileAccessOptions } from './runtime'
import type { FileEntry } from './agent'

/** 文件 API 的访问上下文；候选目录只用于兼容相对路径解析，不能扩大授权范围。 */
export interface FileApiContext {
  sessionId?: string
  workspaceSlug?: string
  candidateBasePaths?: string[]
}

export interface FileApiPathRequest extends FileApiContext {
  path: string
}

export interface FileApiListRequest extends FileApiContext {
  path: string
}

export interface FileApiListResponse {
  entries: FileEntry[]
  truncated: boolean
}

export interface FileApiReadTextResponse {
  resolvedPath: string
  content: string
  revision: string
}

export interface FileApiWriteTextRequest extends FileApiPathRequest {
  content: string
  expectedRevision?: string
}

export interface FileApiWriteTextResponse {
  resolvedPath: string
  revision: string
}

export type FileApiErrorCode =
  | 'invalid_request'
  | 'invalid_json'
  | 'path_not_allowed'
  | 'path_not_found'
  | 'path_type_mismatch'
  | 'file_name_invalid'
  | 'name_conflict'
  | 'write_conflict'
  | 'file_too_large'
  | 'directory_too_large'
  | 'server_unavailable'
  | 'file_api_unauthorized'
  | 'internal_error'

export interface FileApiErrorPayload {
  error: string
  code: FileApiErrorCode
}

/** 将既有 Electron 文件访问上下文转换成 HTTP DTO。 */
export function toFileApiContext(access?: FileAccessOptions): FileApiContext {
  if (!access) return {}
  return {
    ...(access.sessionId ? { sessionId: access.sessionId } : {}),
    ...(access.workspaceSlug ? { workspaceSlug: access.workspaceSlug } : {}),
    ...(access.candidateBasePaths?.length ? { candidateBasePaths: access.candidateBasePaths } : {}),
  }
}
