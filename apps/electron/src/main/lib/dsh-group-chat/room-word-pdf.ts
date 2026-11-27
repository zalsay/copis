import type sharp from 'sharp'
import { pageLimit, WordProblem, wordImageType, wordLimit } from './room-word-limits'

/** 仅嵌入解码并重新编码的 RGB JPEG；文件名、Word XML 和用户文字都不写入 PDF 指令。 */
export async function renderWordPdf(
  images: Buffer[],
  decode: typeof sharp,
  assertActive: () => void,
): Promise<Buffer> {
  if (!images.length) throw new WordProblem('这份 Word 的正文里没有可排版的内嵌图片。')
  if (images.length > pageLimit) throw new WordProblem('图片太多，请拆分 Word 后再发送。')
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xff\xff\xff\xff\n', 'latin1')],
    offsets = [0]
  let total = chunks[0]!.length
  function add(value: Buffer | string) {
    const b = Buffer.isBuffer(value) ? value : Buffer.from(value)
    total += b.length
    if (total > wordLimit) throw new WordProblem('生成的 PDF 超过群附件限制，请拆分 Word。')
    chunks.push(b)
  }
  function obj(header: string, stream?: Buffer) {
    const id = offsets.length
    offsets.push(total)
    add(`${id} 0 obj\n<< ${header}${stream ? ` /Length ${stream.length}` : ''} >>\n`)
    if (stream) {
      add('stream\n')
      add(stream)
      add('\nendstream\n')
    }
    add('endobj\n')
  }
  obj('/Type /Catalog /Pages 2 0 R')
  obj(`/Type /Pages /Count ${images.length} /Kids [${images.map((_, i) => `${3 + 3 * i} 0 R`).join(' ')}]`)
  for (const image of images) {
    assertActive()
    wordImageType(image)
    let result
    try {
      result = await decode(image, { limitInputPixels: 32_000_000, failOn: 'error' })
        .rotate()
        .flatten({ background: 'white' })
        .resize({ width: 2400, height: 3300, fit: 'inside', withoutEnlargement: true })
        .toColourspace('srgb')
        .jpeg({ quality: 90 })
        .toBuffer({ resolveWithObject: true })
    } catch {
      throw new WordProblem('Word 中的图片损坏或像素过大，未生成不完整的 PDF。')
    }
    assertActive()
    const { width: w, height: h } = result.info
    const [W, H] = w > h ? ([841.89, 595.276] as const) : ([595.276, 841.89] as const)
    const margin = 28.347,
      scale = Math.min((W - 2 * margin) / w, (H - 2 * margin) / h)
    const a = w * scale,
      b = h * scale,
      id = offsets.length
    obj(
      `/Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im ${id + 1} 0 R >> >> /Contents ${id + 2} 0 R`,
    )
    obj(
      `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
      result.data,
    )
    obj(
      '',
      Buffer.from(
        `q ${a.toFixed(3)} 0 0 ${b.toFixed(3)} ${((W - a) / 2).toFixed(3)} ${((H - b) / 2).toFixed(3)} cm /Im Do Q`,
      ),
    )
  }
  const xref = total
  add(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`)
  for (const offset of offsets.slice(1)) add(`${String(offset).padStart(10, '0')} 00000 n \n`)
  add(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return Buffer.concat(chunks)
}
