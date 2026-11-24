import { open, type FileHandle } from 'node:fs/promises'
import { extname } from 'node:path'
import { Readable } from 'node:stream'

const MEDIA_TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.mp3': 'audio/mpeg' }
export function localMediaType(path: string): string | undefined {
  return MEDIA_TYPES[extname(path).toLowerCase()]
}

/** 只支持单 Range；流由浏览器取消或读完时关闭，不把媒体整体读入内存。 */
export async function createLocalMediaResponse(request: Request, path: string): Promise<Response | undefined> {
  const mediaType = localMediaType(path)
  if (!mediaType) return undefined
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
  }
  let file: FileHandle | undefined
  try {
    file = await open(path, 'r')
    const stat = await file.stat()
    if (!stat.isFile()) { await file.close(); return new Response(null, { status: 404 }) }
    const size = stat.size
    const headers = new Headers({ 'Content-Type': mediaType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    let start = 0
    let end = size - 1
    // Range 只适用于 GET；没有提供校验器时，If-Range 请求安全退回完整响应。
    const range = request.method === 'GET' && !request.headers.has('If-Range') ? request.headers.get('Range') : null
    if (range !== null) {
      const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim())
      let valid = !!match && size > 0 && (match[1] !== '' || match[2] !== '')
      if (valid && match) {
        if (match[1] === '') {
          const suffix = Number(match[2])
          valid = Number.isSafeInteger(suffix) && suffix > 0
          start = Math.max(0, size - suffix)
        } else {
          start = Number(match[1])
          const requestedEnd = match[2] === '' ? end : Number(match[2])
          valid = Number.isSafeInteger(start) && Number.isSafeInteger(requestedEnd) && start < size && requestedEnd >= start
          end = Math.min(end, requestedEnd)
        }
      }
      if (!valid) {
        await file.close()
        headers.set('Content-Range', `bytes */${size}`)
        return new Response(null, { status: 416, headers })
      }
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
    }
    headers.set('Content-Length', String(Math.max(0, end - start + 1)))
    const status = range === null ? 200 : 206
    if (request.method === 'HEAD' || size === 0) {
      await file.close()
      return new Response(null, { status, headers })
    }
    const stream = file.createReadStream({ start, end, autoClose: true, signal: request.signal })
    // Node 与 DOM 的 WHATWG stream 类型定义不同；这里仍直接传递标准流，不缓冲内容。
    const body = Readable.toWeb(stream, { strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength } })
    return new Response(body as unknown as BodyInit, { status, headers })
  } catch (error) {
    await file?.close().catch(() => {})
    const code = (error as NodeJS.ErrnoException).code
    return new Response(null, { status: code === 'ENOENT' ? 404 : code === 'EACCES' || code === 'EPERM' ? 403 : 500 })
  }
}
