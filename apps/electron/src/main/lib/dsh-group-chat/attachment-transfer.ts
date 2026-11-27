import COS from 'cos-nodejs-sdk-v5'
import { DSH_ROOM_ATTACHMENT_MAX_COUNT, DSH_ROOM_ATTACHMENT_MAX_BYTES, type DshSharedRoomCommand } from '@copis/shared'
import { createHash } from 'node:crypto'

export type RoomImage = { bytes: Uint8Array; mimeType: string }
export type RoomSourceFile = RoomImage & {name?:string}
const wordType = (type:string) => ['application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(type)
export type AttachmentCommand =
  | { action: 'internalAttachmentUpload'; roomId: string; fileName: string; mimeType: string; sizeBytes: number; sha256: string }
  | { action: 'internalAttachmentFinalize'; roomId: string; attachmentId: string; sizeBytes: number; etag: string; sha256: string }
  | { action: 'internalAttachmentDownload'; roomId: string; attachmentId: string }
export type AttachmentPublicCommand = Extract<DshSharedRoomCommand, { action: 'uploadAttachment' | 'downloadAttachment' }>

type Grant = { attachmentId: string; bucket: string; region: string; objectKey: string; tmpSecretId: string; tmpSecretKey: string; sessionToken: string; startTime: number; expiredTime: number; maxSizeBytes?: number }
type Dependencies = { revision: () => number; command: (command: AttachmentCommand) => Promise<unknown>; upload?: (grant: Grant, bytes: Uint8Array, mimeType: string, sha256: string, name: string) => Promise<string>; download?: (grant: Grant) => Promise<Response> }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const idValid = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
const textValid = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
function validFilename(value: unknown): value is string {
  return textValid(value, 255) && Buffer.byteLength(value, 'utf8') <= 255 && !/[\\/]/.test(value) && value !== '.' && value !== '..'
}
function parseGrant(raw: unknown, action: 'upload' | 'download', roomId: string): Grant {
  const outer = record(raw); const v = record(outer.data ?? raw); const credentials = record(v.credentials ?? v)
  const now = Math.floor(Date.now() / 1000)
  const start = credentials.startTime ?? v.startTime; const end = credentials.expiredTime ?? v.expiredTime
  if (!idValid(v.attachmentId) || typeof v.bucket !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}-[0-9]{1,20}$/.test(v.bucket) || typeof v.region !== 'string' || !/^[a-z0-9-]{1,40}$/.test(v.region)
    || v.objectKey !== `private/chatroom-v2/${roomId}/${v.attachmentId}`
    || !textValid(credentials.tmpSecretId, 512) || !textValid(credentials.tmpSecretKey, 512) || !textValid(credentials.sessionToken, 8192)
    || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) > now + 60 || (end as number) <= now || (end as number) <= (start as number) || (end as number) - (start as number) > 3600
    || (v.action !== undefined && v.action !== action)) throw new Error('附件授权无效')
  const limit = v.maxSizeBytes
  if (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 1)) throw new Error('附件授权无效')
  return { attachmentId: v.attachmentId, bucket: v.bucket, region: v.region, objectKey: v.objectKey, tmpSecretId: credentials.tmpSecretId, tmpSecretKey: credentials.tmpSecretKey, sessionToken: credentials.sessionToken, startTime: start as number, expiredTime: end as number, ...(limit !== undefined ? { maxSizeBytes: limit as number } : {}) }
}
function sdk(grant: Grant): COS { return new COS({ SecretId: grant.tmpSecretId, SecretKey: grant.tmpSecretKey, SecurityToken: grant.sessionToken, Timeout: 60_000 }) }
async function uploadCos(g: Grant, bytes: Uint8Array, mimeType: string, sha256: string, name: string): Promise<string> {
  const result = await sdk(g).putObject({ Bucket: g.bucket, Region: g.region, Key: g.objectKey, Body: Buffer.from(bytes), ContentLength: bytes.byteLength, ContentType: mimeType, 'x-cos-meta-sha256': sha256, 'x-cos-meta-original-name': encodeURIComponent(name) })
  return result.ETag
}
async function downloadCos(g: Grant): Promise<Response> {
  const url = await new Promise<string>((resolve, reject) => sdk(g).getObjectUrl({ Bucket: g.bucket, Region: g.region, Key: g.objectKey, Sign: true, Protocol: 'https:', Expires: Math.min(300, g.expiredTime - Math.floor(Date.now() / 1000)) }, (error, result) => error ? reject(error) : resolve(result.Url)))
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.hostname !== `${g.bucket}.cos.${g.region}.myqcloud.com` || parsed.port || parsed.username || parsed.password) throw new Error('附件地址无效')
  return fetch(parsed, { redirect: 'error', signal: AbortSignal.timeout(60_000) })
}
export function createAttachmentTransfer(deps: Dependencies) {
  const check = (rev: number) => { if (rev !== deps.revision()) throw new Error('共享群账号已切换') }
  type DownloadInput = {roomId:string; attachmentId:string}
  async function readAttachment(input:DownloadInput, active:()=>void, byteBudget?:number) {
    active()
    if (!idValid(input.roomId) || !idValid(input.attachmentId)) throw new Error('附件参数无效')
    const grant = parseGrant(await deps.command({ action:'internalAttachmentDownload', roomId:input.roomId, attachmentId:input.attachmentId }), 'download', input.roomId)
    active()
    if (grant.attachmentId !== input.attachmentId) throw new Error('附件授权无效')
    const response = await (deps.download ?? downloadCos)(grant)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('附件没有内容')
    try {
      active()
      if (!response.ok) throw new Error('附件下载失败')
      const header = response.headers.get('content-type')
      const contentType = byteBudget === undefined ? header : header?.split(';', 1)[0]?.trim()
      const mimeType = contentType && /^[\w.+-]+\/[\w.+-]+$/.test(contentType) && contentType.length <= 255 ? contentType.toLowerCase() : undefined
      let name: string | undefined
      const encodedName = response.headers.get('x-cos-meta-original-name')
      if (encodedName && encodedName.length <= 2295) {
        try { const decoded = decodeURIComponent(encodedName); if (validFilename(decoded)) name = decoded } catch { /* 无效编码不得作为文件名 */ }
      }
      // 只取本次调用能处理的类型；不读取任意普通群附件的正文。
      if (byteBudget !== undefined && !mimeType?.startsWith('image/') && !wordType(mimeType ?? '') && !/\.docx?$/i.test(name ?? '')) { await reader.cancel(); return null }
      const limit = Math.min(DSH_ROOM_ATTACHMENT_MAX_BYTES, grant.maxSizeBytes ?? Infinity, byteBudget ?? Infinity)
      const length = response.headers.get('content-length')
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new Error('附件超过大小限制')
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const part = await reader.read()
        active()
        if (part.done) break
        size += part.value.byteLength
        if (size > limit) throw new Error('附件超过大小限制')
        chunks.push(part.value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      return { bytes, ...(mimeType ? { mimeType } : {}), ...(name ? { name } : {}) }
    } catch (err) {
      await reader.cancel().catch(() => {})
      throw err
    } finally { reader.releaseLock() }
  }
  return {
    async upload(input: Omit<Extract<AttachmentPublicCommand, {action:'uploadAttachment'}>, 'action'>, assertActive = () => {}): Promise<{id:string}> {
      try {
        const rev = deps.revision(); assertActive()
        if (!idValid(input.roomId) || !validFilename(input.name) || !textValid(input.mimeType, 255) || !/^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType) || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength > DSH_ROOM_ATTACHMENT_MAX_BYTES) throw new Error('附件参数无效')
        const bytes = Uint8Array.from(input.bytes); const sha256 = createHash('sha256').update(bytes).digest('hex')
        const grant = parseGrant(await deps.command({ action:'internalAttachmentUpload', roomId:input.roomId, fileName:input.name, mimeType:input.mimeType, sizeBytes:bytes.byteLength, sha256 }), 'upload', input.roomId); check(rev); assertActive()
        if (bytes.byteLength > Math.min(DSH_ROOM_ATTACHMENT_MAX_BYTES, grant.maxSizeBytes ?? DSH_ROOM_ATTACHMENT_MAX_BYTES)) throw new Error('附件超过大小限制')
        const etag = await (deps.upload ?? uploadCos)(grant, bytes, input.mimeType, sha256, input.name); check(rev); assertActive()
        if (!textValid(etag, 512)) throw new Error('附件上传失败')
        const raw = await deps.command({ action:'internalAttachmentFinalize', roomId:input.roomId, attachmentId:grant.attachmentId, sizeBytes:bytes.byteLength, etag, sha256 }); check(rev); assertActive()
        const outer = record(raw); const confirmed = record(outer.data ?? raw)
        if (confirmed.attachmentId !== grant.attachmentId || confirmed.roomId !== input.roomId || confirmed.sizeBytes !== bytes.byteLength || confirmed.sha256 !== sha256 || confirmed.status !== 'ready') throw new Error('附件确认失败')
        return { id:grant.attachmentId }
      } catch { throw new Error('附件上传失败或账号已切换') }
    },
    async download(input: DownloadInput) {
      const rev = deps.revision()
      try { return (await readAttachment(input, () => check(rev)))! }
      catch { throw new Error('附件下载失败或账号已切换') }
    },
    async downloadInvocationFiles(roomId: string, ids: string[], assertActive: () => void): Promise<RoomSourceFile[]> {
      const rev = deps.revision()
      const active = () => { assertActive(); check(rev) }
      if (ids.length > DSH_ROOM_ATTACHMENT_MAX_COUNT) throw new Error('群消息附件过多')
      const files: RoomSourceFile[] = []
      let remaining = DSH_ROOM_ATTACHMENT_MAX_BYTES
      for (const attachmentId of ids) {
        const file = await readAttachment({roomId,attachmentId}, active, remaining)
        if (!file) continue
        files.push({...file,mimeType:file.mimeType ?? 'application/octet-stream'})
        remaining -= file.bytes.byteLength
      }
      active()
      return files
    },
  }
}
