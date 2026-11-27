import { WordProblem, pageLimit, wordLimit, type WordContent } from './room-word-limits'

// Word 97–2003：只读取复合文件的正文、表和 Data 流，不调用 Office、不运行宏或打开链接。
function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new WordProblem('这份旧版 Word 的结构或图片布局暂不支持，请另存为 .docx 后发送。')
}
function streams(file: Buffer) {
  const size = 2 ** file.readUInt16LE(30),
    count = Math.floor(file.length / size) - 1
  requireValid([512, 4096].includes(size) && file.readUInt16LE(32) === 6 && count > 0)
  const sector = (i: number) => {
    requireValid(i >= 0 && i < count)
    return file.subarray((i + 1) * size, (i + 2) * size)
  }
  const ids = (b: Buffer) => Array.from({ length: b.length / 4 }, (_, i) => b.readInt32LE(i * 4))
  const fatIds = ids(file.subarray(76, 512)).filter((i) => i >= 0)
  let dif = file.readInt32LE(68)
  const difCount = file.readUInt32LE(72)
  requireValid(difCount <= Math.ceil(count / (size / 4 - 1)))
  for (let i = 0; i < difCount; i++) {
    const entries = ids(sector(dif))
    dif = entries.pop()!
    fatIds.push(...entries.filter((n) => n >= 0))
  }
  requireValid(fatIds.length === file.readUInt32LE(44) && fatIds.length <= Math.ceil(count / (size / 4)) + 1)
  const fat = fatIds.flatMap((n) => ids(sector(n)))
  function chain(start: number, table: number[], block: (id: number) => Buffer, max: number) {
    const seen = new Set<number>(),
      parts: Buffer[] = []
    let total = 0
    for (let i = start; i !== -2; i = table[i]!) {
      requireValid(Number.isInteger(i) && i >= 0 && i < table.length && !seen.has(i))
      seen.add(i)
      const b = block(i)
      total += b.length
      requireValid(b.length && total <= max)
      parts.push(b)
    }
    return Buffer.concat(parts)
  }
  const dir = chain(file.readInt32LE(48), fat, sector, 2 * 1024 * 1024)
  const entry = (i: number) => {
    requireValid(i >= 0 && 128 * (i + 1) <= dir.length)
    return dir.subarray(i * 128, (i + 1) * 128)
  }
  const root = entry(0)
  requireValid(root[66] === 5)
  const miniFat = ids(
    chain(file.readInt32LE(60), fat, sector, Math.ceil(((file.length / 64) * 4) / size) * size),
  )
  const mini = chain(root.readInt32LE(116), fat, sector, file.length)
  const found = new Map<string, Buffer>()
  const todo = [root.readInt32LE(76)],
    seen = new Set<number>()
  while (todo.length) {
    const i = todo.pop()!
    if (i === -1) continue
    requireValid(!seen.has(i))
    seen.add(i)
    const e = entry(i)
    todo.push(e.readInt32LE(68), e.readInt32LE(72))
    if (e[66] === 2) found.set(e.subarray(0, e.readUInt16LE(64) - 2).toString('utf16le'), e)
  }
  return (name: string) => {
    const e = found.get(name)
    requireValid(e)
    const len = e.readUInt32LE(120)
    requireValid(len <= wordLimit)
    if (!len) return Buffer.alloc(0)
    const small = len < 4096
    const b = chain(
      e.readInt32LE(116),
      small ? miniFat : fat,
      small ? (i) => mini.subarray(i * 64, i * 64 + 64) : sector,
      Math.ceil(len / (small ? 64 : size)) * (small ? 64 : size),
    )
    requireValid(b.length >= len)
    return b.subarray(0, len)
  }
}
/** PICF 内的 OfficeArt 记录只接受内嵌 PNG/JPEG Blip，不跟随延迟或外部图片地址。 */
function pictureRecord(records: Buffer): Buffer {
  for (let p = 0; p + 8 <= records.length; ) {
    const type = records.readUInt16LE(p + 2),
      end = p + 8 + records.readUInt32LE(p + 4)
    requireValid(end <= records.length)
    if (type === 0xf007) {
      const entry = records.subarray(p + 8, end)
      requireValid(entry.length >= 36)
      return pictureRecordBlip(entry.subarray(36 + entry[33]!))
    }
    if (type === 0xf01d || type === 0xf01e || type === 0xf02a)
      return pictureRecordBlip(records.subarray(p, end))
    p = end
  }
  throw new WordProblem('旧版 Word 中的图片不是内嵌 PNG/JPEG，请另存为 .docx 后发送。')
}
function pictureRecordBlip(blip: Buffer) {
  const type = blip.readUInt16LE(2),
    length = blip.readUInt32LE(4)
  requireValid((type === 0xf01d || type === 0xf01e || type === 0xf02a) && length + 8 <= blip.length)
  // Blip 实例的最低位决定是否多一个 16 字节 UID，之后是单字节 tag 和原始像素文件。
  const start = 8 + ((blip.readUInt16LE(0) >>> 4) & 1 ? 32 : 16) + 1
  const bytes = blip.subarray(start, length + 8)
  requireValid(
    type === 0xf01e
      ? bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
      : bytes.subarray(0, 3).toString('hex') === 'ffd8ff',
  )
  return bytes
}
export function readBinaryWord(bytes: Buffer): WordContent {
  const stream = streams(bytes),
    w = stream('WordDocument')
  requireValid(w.readUInt16LE(0) === 0xa5ec && !(w.readUInt16LE(10) & 0x8100))
  const t = stream(w.readUInt16LE(10) & 512 ? '1Table' : '0Table')
  const u = (b: Buffer, i: number) => b.readUInt32LE(i)
  const section = (field: number) => {
    const start = u(w, field),
      size = u(w, field + 4)
    requireValid(start + size <= t.length)
    return t.subarray(start, start + size)
  }
  const clx = section(0x1a2)
  let p = 0
  while (clx[p] === 1) p += 3 + clx.readUInt16LE(p + 1)
  requireValid(clx[p] === 2)
  const len = u(clx, p + 1)
  p += 5
  const pieces = (len - 4) / 12
  requireValid(Number.isInteger(pieces) && pieces > 0 && pieces <= 65536 && p + len <= clx.length)
  const anchors: number[] = [],
    text: string[] = []
  const body = u(w, 0x4c)
  requireValid(body <= 1_000_000)
  for (let i = 0; i < pieces; i++) {
    const cp = u(clx, p + 4 * i)
    if (cp >= body) break
    const chars = Math.min(body, u(clx, p + 4 * i + 4)) - cp,
      fc = u(clx, p + (pieces + 1) * 4 + i * 8 + 2),
      wide = !(fc & 0x40000000),
      stride = wide ? 2 : 1,
      start = (fc & 0x3fffffff) / (wide ? 1 : 2)
    requireValid(chars >= 0 && start + chars * stride <= w.length && Number.isInteger(start))
    const s = w.subarray(start, start + chars * stride).toString(wide ? 'utf16le' : 'latin1')
    requireValid(!s.includes('\x08'))
    for (let j = s.indexOf('\x01'); j !== -1; j = s.indexOf('\x01', j + 1)) {
      anchors.push(start + j * stride)
      requireValid(anchors.length <= pageLimit)
    }
    text.push(s.replace(/[\x00-\x08\x0e-\x1f]/g, '').replace(/\r/g, '\n'))
  }
  if (!anchors.length) return { text: text.join('').trim(), images: [] }
  const bte = section(0xfa),
    blocks = (bte.length - 4) / 8
  requireValid(Number.isInteger(blocks) && blocks > 0 && blocks <= w.length / 512)
  const data = stream('Data')
  let budget = wordLimit
  const images = anchors.map((fc) => {
    let lo = 0,
      hi = blocks
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (u(bte, (mid + 1) * 4) <= fc) lo = mid + 1
      else hi = mid
    }
    requireValid(lo < blocks)
    const off = 512 * u(bte, (blocks + 1 + lo) * 4)
    requireValid(off + 512 <= w.length)
    const page = w.subarray(off, off + 512),
      runs = page[511]!
    requireValid((runs + 1) * 4 + runs <= 511)
    for (let j = 0; j < runs; j++)
      if (u(page, j * 4) <= fc && fc < u(page, j * 4 + 4)) {
        const k = 2 * page[(runs + 1) * 4 + j]!
        requireValid(k > 0 && k + 1 + page[k]! <= 511)
        const props = page.subarray(k + 1, k + 1 + page[k]!)
        for (let n = 0; n + 2 <= props.length; ) {
          const op = props.readUInt16LE(n)
          n += 2
          if (op === 0x6a03) {
            const pos = u(props, n),
              size = u(data, pos)
            requireValid(
              size >= 68 && size <= budget && pos + size <= data.length && data.readUInt16LE(pos + 4) === 68,
            )
            budget -= size
            return pictureRecord(data.subarray(pos + 68, pos + size))
          }
          const kind = op >>> 13
          n += kind === 6 ? 1 + props.readUInt8(n) : [1, 1, 2, 4, 2, 2, 0, 3][kind]!
        }
      }
    throw new WordProblem('旧版 Word 中有无法读取的图片，请另存为 .docx 后发送。')
  })
  return { text: text.join('').trim(), images }
}
